import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type {
  ActivityEvent,
  AiGeneratedRoadmap,
  AiRoadmapTopic,
  AuthStage,
  AuthUser,
  Difficulty,
  Goal,
  GoalAction,
  GoalInput,
  QuizAttempt,
  Roadmap,
  StudyPlanPreview,
  StudyPlanState,
  StudyTask,
  User,
  UserGoal,
  YouTubeVideo,
} from '../types'
import { sampleStudent } from '../data/student'
import { goals as goalCatalog } from '../data/goals'
import { getRoadmapForGoal } from '../data/roadmaps'
import { authApi } from '../services/auth'
import { goalsApi, GoalError } from '../services/goals'
import { reduceStudyPlan } from '../services/studyPlan'

/** Legacy single-writer key ("guest" / pre-auth state). */
const GUEST_STORAGE_KEY = 'focuslearn-state-v1'
/** Per-user key suffix: focuslearn-state:<userId>. */
const USER_KEY_PREFIX = 'focuslearn-state:'

function userStorageKey(userId: string) {
  return `${USER_KEY_PREFIX}${userId}`
}

interface StoredState {
  user: User
  activeGoalId: string | null
  completedLessonIds: string[]
  attempts: QuizAttempt[]
  blockedSites: string[]
  totalFocusMinutes: number
  focusSessionsToday: number
  theme: 'light' | 'dark'
  /** Persisted AI roadmap topic statuses (adaptive learning). */
  aiRoadmapTopics: AiRoadmapTopic[]
  /** The currently generated AI roadmap for the student's chosen topic. */
  aiRoadmap: AiGeneratedRoadmap | null
  /** Focus minutes tracked per calendar day (YYYY-MM-DD) — drives the daily target. */
  focusMinutesByDay: Record<string, number>
  /** Recent learning events (lessons, quizzes, focus sessions). */
  activity: ActivityEvent[]
  /** Persisted adaptive study plan (daily target + scheduled tasks). */
  studyPlan: StudyPlanState
}
interface AppContextValue extends StoredState {
  goals: Goal[]
  activeGoal: Goal | null
  roadmap: Roadmap | null
  /** Lesson ids the student has finished reading. */
  completedLessonIds: string[]
  /** Central Focus Mode state — every AI feature reads these. */
  currentTopic: string | null
  currentVideo: FocusVideo | null
  currentVideoTitle: string | null
  /* ── Authentication ─────────────────────────────────────── */
  authStage: AuthStage
  isAuthenticated: boolean
  currentUser: AuthUser | null
  login: (email: string, password: string) => Promise<AuthUser>
  signup: (name: string, email: string, password: string) => Promise<AuthUser>
  /** Complete Google sign-in with a verified ID token from the backend. */
  loginWithGoogle: (credential: string) => Promise<AuthUser>
  /**
   * Complete Firebase Google sign-in: the backend verifies the Firebase ID
   * token and establishes the same FocusLearn session.
   */
  loginWithFirebase: (idToken: string) => Promise<AuthUser>
  logout: () => Promise<void>
  refreshUser: () => Promise<AuthUser | null>
  /** Sync name/email changes to the backend account. */
  updateAccountInfo: (patch: { name?: string; email?: string }) => Promise<AuthUser>
  /* ── User goals (backend-backed, per account) ────────────── */
  /** Personal goals created by the user (distinct from the curated catalog). */
  userGoals: UserGoal[]
  /** True while the goal list is loading from the backend. */
  goalsLoading: boolean
  /** Last goal-loading error, or null. */
  goalsError: string | null
  /** The user's primary goal (falls back to the first active goal). */
  primaryGoal: UserGoal | null
  /** Reload the goal list from the backend. */
  refreshGoals: () => Promise<void>
  createGoal: (input: GoalInput) => Promise<UserGoal>
  updateGoal: (id: string, patch: Partial<GoalInput>) => Promise<UserGoal>
  deleteGoal: (id: string) => Promise<void>
  /** Run a status transition or mark a goal primary. */
  runGoalAction: (id: string, action: GoalAction) => Promise<UserGoal>
  /* ───────────────────────────────────────────────────────── */
  selectGoal: (goalId: string) => void
  markLessonComplete: (lessonId: string) => void
  recordAttempt: (attempt: Omit<QuizAttempt, 'id' | 'completedAt'>) => void
  setBlockedSites: (sites: string[]) => void
  logFocusSession: (minutes: number) => void
  updateUser: (patch: Partial<User>) => void
  toggleTheme: () => void
  resetAllProgress: () => void
  /** Set/change the searched topic; invalidates the selected video. */
  setCurrentTopic: (topic: string | null) => void
  /** Set/clear the video being studied in Focus Mode. */
  setCurrentVideo: (video: FocusVideo | null) => void
  /** Update a single AI roadmap topic (immutable). */
  updateAiTopic: (topicId: string, patch: Partial<AiRoadmapTopic>) => void
  /** Replace all AI roadmap topics at once. */
  setAiRoadmapTopics: (topics: AiRoadmapTopic[]) => void
  /** Store a freshly generated AI roadmap for the current topic. */
  setAiRoadmap: (roadmap: AiGeneratedRoadmap | null) => void
  /* ── Study plan (adaptive, persisted with the rest of the profile) ── */
  /** Persisted plan: daily target + scheduled tasks. */
  studyPlan: StudyPlanState
  /** Replace the stored plan (used when applying a preview). */
  setStudyPlan: (next: StudyPlanState) => void
  /** Merge a patch into the stored plan. */
  patchStudyPlan: (patch: Partial<StudyPlanState>) => void
  /** Change the daily study target (persisted, re-plans the week). */
  setDailyTargetMinutes: (minutes: number) => void
  /** Apply a previewed plan (AI assistant or Replan My Week). */
  applyStudyPlanPreview: (preview: StudyPlanPreview) => void
  /** Discard a preview without touching the live plan. */
  discardStudyPlanPreview: () => void
}

const AppContext = createContext<AppContextValue | null>(null)

const DIFFICULTIES: Difficulty[] = ['Beginner', 'Intermediate', 'Advanced']

/** Coerce an arbitrary persisted user object into a valid profile. */
function sanitizeUser(raw: unknown): User {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v.length > 0 ? v : fallback
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  const level = DIFFICULTIES.includes(p.level as Difficulty)
    ? (p.level as Difficulty)
    : sampleStudent.level
  return {
    id: str(p.id, sampleStudent.id),
    name: str(p.name, sampleStudent.name),
    email: str(p.email, sampleStudent.email),
    field: str(p.field, sampleStudent.field),
    level,
    dailyGoalMinutes: num(p.dailyGoalMinutes, sampleStudent.dailyGoalMinutes),
    joinedAt: str(p.joinedAt, sampleStudent.joinedAt),
    focusStreakDays: num(p.focusStreakDays, sampleStudent.focusStreakDays),
  }
}

/**
 * Coerce an arbitrary parsed localStorage record into the StoredState
 * contract, filling a safe default for every missing or malformed field.
 * A stale / partially-written record (e.g. written by an earlier app
 * iteration before the current schema) must never crash the UI. Returns
 * null when the record is unusable (no object / no user block) so the
 * caller falls back to a fresh state.
 */
function sanitizeStored(parsed: unknown): StoredState | null {
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  if (!p.user || typeof p.user !== 'object') return null
  return {
    user: sanitizeUser(p.user),
    activeGoalId:
      typeof p.activeGoalId === 'string' || p.activeGoalId === null ? p.activeGoalId : 'web-dev',
    completedLessonIds: (Array.isArray(p.completedLessonIds) ? p.completedLessonIds : []).filter(
      (x): x is string => typeof x === 'string',
    ),
    attempts: (Array.isArray(p.attempts) ? p.attempts : []).filter(
      (a): a is QuizAttempt =>
        !!a && typeof a === 'object' && Array.isArray((a as QuizAttempt).missedQuestionIds),
    ),
    blockedSites: (Array.isArray(p.blockedSites) ? p.blockedSites : []).filter(
      (x): x is string => typeof x === 'string',
    ),
    totalFocusMinutes: typeof p.totalFocusMinutes === 'number' ? p.totalFocusMinutes : 0,
    focusSessionsToday: typeof p.focusSessionsToday === 'number' ? p.focusSessionsToday : 0,
    theme: p.theme === 'dark' ? 'dark' : 'light',
    aiRoadmapTopics: (Array.isArray(p.aiRoadmapTopics) ? p.aiRoadmapTopics : []).filter(
      (t): t is AiRoadmapTopic => {
        if (!t || typeof t !== 'object') return false
        const topic = t as AiRoadmapTopic
        return typeof topic.id === 'string' && typeof topic.name === 'string'
      },
    ),
    aiRoadmap:
      p.aiRoadmap && typeof p.aiRoadmap === 'object'
        ? (p.aiRoadmap as AiGeneratedRoadmap)
        : null,
    focusMinutesByDay: sanitizeFocusMinutes(p.focusMinutesByDay),
    activity: (Array.isArray(p.activity) ? p.activity : []).filter(
      (a): a is ActivityEvent => {
        if (!a || typeof a !== 'object') return false
        const ev = a as ActivityEvent
        return (
          typeof ev.id === 'string' &&
          (ev.kind === 'lesson' || ev.kind === 'quiz' || ev.kind === 'focus') &&
          typeof ev.label === 'string' &&
          typeof ev.at === 'string'
        )
      },
    ),
    studyPlan: sanitizeStudyPlan(p.studyPlan, sanitizeUser(p.user).dailyGoalMinutes),
  }
}

/** Coerce an arbitrary parsed value into a day → minutes map. */
function sanitizeFocusMinutes(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, number> = {}
  Object.entries(raw as Record<string, unknown>).forEach(([day, mins]) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof mins === 'number' && Number.isFinite(mins)) {
      out[day] = mins
    }
  })
  return out
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/
const TASK_KINDS = ['lesson', 'quiz', 'review'] as const
const TASK_PRIORITIES = ['high', 'medium', 'low'] as const

/**
 * Coerce a persisted study plan. Every field is validated because the record
 * comes from localStorage and may be stale, hand-edited or from an older build:
 * the Study Plan must degrade to an empty plan rather than crash the app.
 */
function sanitizeStudyPlan(raw: unknown, fallbackMinutes: number): StudyPlanState {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  // Accept a number OR a numeric string ("45" from an older build) so the
  // selected target can never be compared against the numeric options with a
  // mismatched type. Anything else falls back to the user's saved goal.
  const rawMinutes = p.dailyTargetMinutes
  const parsedMinutes =
    typeof rawMinutes === 'number' && Number.isFinite(rawMinutes)
      ? rawMinutes
      : typeof rawMinutes === 'string' && rawMinutes.trim() !== '' && Number.isFinite(Number(rawMinutes))
        ? Number(rawMinutes)
        : NaN
  const minutes = Number.isFinite(parsedMinutes) ? parsedMinutes : fallbackMinutes
  const tasks: StudyTask[] = (Array.isArray(p.tasks) ? p.tasks : [])
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t): StudyTask => {
      const kind = TASK_KINDS.includes(t.kind as (typeof TASK_KINDS)[number])
        ? (t.kind as StudyTask['kind'])
        : 'lesson'
      const priority = TASK_PRIORITIES.includes(t.priority as (typeof TASK_PRIORITIES)[number])
        ? (t.priority as StudyTask['priority'])
        : 'medium'
      return {
        id: typeof t.id === 'string' && t.id ? t.id : `sp-${String(t.date ?? '')}-${kind}`,
        kind,
        ref: typeof t.ref === 'string' ? t.ref : '',
        title: typeof t.title === 'string' && t.title ? t.title : 'Study task',
        date: typeof t.date === 'string' && DAY_KEY.test(t.date) ? t.date : '',
        estimatedMinutes:
          typeof t.estimatedMinutes === 'number' && Number.isFinite(t.estimatedMinutes)
            ? Math.max(1, Math.round(t.estimatedMinutes))
            : 10,
        actualMinutes:
          typeof t.actualMinutes === 'number' && Number.isFinite(t.actualMinutes)
            ? Math.max(0, Math.round(t.actualMinutes))
            : 0,
        priority,
        status: t.status === 'done' || t.status === 'missed' ? t.status : 'planned',
        source: t.source === 'ai' ? 'ai' : 'auto',
        rescheduledFrom:
          typeof t.rescheduledFrom === 'string' && DAY_KEY.test(t.rescheduledFrom)
            ? t.rescheduledFrom
            : undefined,
        reason: typeof t.reason === 'string' ? t.reason : undefined,
        completedAt: typeof t.completedAt === 'string' ? t.completedAt : undefined,
      }
    })
    // A task with no valid date cannot be placed on the calendar.
    .filter((t) => DAY_KEY.test(t.date))
    // Collapse duplicate ids: corrupted plans carried a task into the same
    // slot more than once. Keeping the first wins; legitimate sessions on
    // different dates have different ids and are untouched.
    .filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i)
  return {
    dailyTargetMinutes: minutes,
    tasks,
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : null,
    pendingPreview: null,
  }
}

/** Local calendar day key (YYYY-MM-DD) used for the daily learning target. */
function todayKey(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function loadStored(key: string): StoredState | null {
  try {
    const raw = localStorage.getItem(key)
    if (raw) return sanitizeStored(JSON.parse(raw))
  } catch {
    // Corrupt storage — caller falls back to fresh state.
  }
  return null
}

function saveStored(key: string, value: StoredState) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage unavailable (private mode) — app still works in memory.
  }
}

function removeStored(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

/** Default state used for guests and as the base for every account. */
function loadGuestState(): StoredState {
  return loadStored(GUEST_STORAGE_KEY) ?? freshStoredState(sampleStudent)
}

/**
 * Fresh state for a newly created account. Identity comes from the backend
 * user while learning preferences keep the demo defaults.
 */
function freshStoredState(user: User): StoredState {
  const base = loadStored(GUEST_STORAGE_KEY)
  const from = base?.user ?? sampleStudent
  return {
    user: {
      ...from,
      id: user.id,
      name: user.name,
      email: user.email,
      joinedAt: from.joinedAt ?? new Date().toISOString().slice(0, 10),
    },
    activeGoalId: base?.activeGoalId ?? 'web-dev',
    completedLessonIds: base?.completedLessonIds ?? [
      'web-dev-1-1',
      'web-dev-1-2',
      'web-dev-2-1',
      'web-dev-2-2',
    ],
    attempts: base?.attempts ?? [],
    blockedSites: base?.blockedSites ?? [
      'youtube.com',
      'instagram.com',
      'x.com',
      'netflix.com',
      'reddit.com',
    ],
    totalFocusMinutes: base?.totalFocusMinutes ?? 0,
    focusSessionsToday: base?.focusSessionsToday ?? 0,
    theme: base?.theme ?? 'light',
    aiRoadmapTopics: base?.aiRoadmapTopics ?? [],
    aiRoadmap: base?.aiRoadmap ?? null,
    focusMinutesByDay: base?.focusMinutesByDay ?? {},
    activity: base?.activity ?? [],
    studyPlan: sanitizeStudyPlan(
      base?.studyPlan,
      typeof from.dailyGoalMinutes === 'number' ? from.dailyGoalMinutes : 30,
    ),
  }
}

function freshStoredStateFor(user: AuthUser): StoredState {
  return freshStoredState({
    id: user.id,
    name: user.name,
    email: user.email,
    field: 'Web Development',
    level: 'Beginner',
    dailyGoalMinutes: 30,
    joinedAt: new Date().toISOString().slice(0, 10),
    focusStreakDays: 0,
  })
}

/** Stamp the live backend identity onto persisted profile fields. */
function mergeIdentity(state: StoredState, user: AuthUser): StoredState {
  return { ...state, user: { ...state.user, id: user.id, name: user.name, email: user.email } }
}

/**
 * Resolve the persisted state for an authenticated user.
 *
 * Backward-compatible migration: the first account on this browser adopts
 * the legacy single-writer state (identity fields replaced by the account).
 * Nothing is ever deleted from the legacy key.
 */
function resolveUserState(user: AuthUser): { key: string; state: StoredState } {
  const key = userStorageKey(user.id)
  const existing = loadStored(key)
  if (existing) return { key, state: mergeIdentity(existing, user) }

  const legacy = loadStored(GUEST_STORAGE_KEY)
  const state = legacy ? mergeIdentity(legacy, user) : freshStoredStateFor(user)
  saveStored(key, state)
  return { key, state }
}

function defaultStoredFor(user: AuthUser | null): StoredState {
  if (!user) return loadGuestState()
  return freshStoredStateFor(user)
}

/** The YouTube video the student is studying, with its search topic. */
export type FocusVideo = YouTubeVideo & { topic?: string }

export function AppProvider({ children }: { children: ReactNode }) {
  const [storageKey, setStorageKey] = useState<string>(GUEST_STORAGE_KEY)
  const [state, setState] = useState<StoredState>(loadGuestState)

  /* ── Authentication state ───────────────────────────────────────────── */
  const [authStage, setAuthStage] = useState<AuthStage>('loading')
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)

  /* ── User goals (server-side, loaded once authenticated) ──────────── */
  const [userGoals, setUserGoals] = useState<UserGoal[]>([])
  const [goalsLoading, setGoalsLoading] = useState(false)
  const [goalsError, setGoalsError] = useState<string | null>(null)

  /** Central Focus Mode state — the current topic drives every AI feature. */
  const [currentTopic, setCurrentTopicState] = useState<string | null>(null)
  const [currentVideo, setCurrentVideoState] = useState<FocusVideo | null>(null)
  const currentVideoTitle = currentVideo?.title ?? null

  /** Searching a new topic clears the previously selected video. */
  const setCurrentTopic = useCallback((topic: string | null) => {
    setCurrentTopicState(topic)
    setCurrentVideoState(null)
  }, [])

  /** Selecting a video keeps topic and video in sync. */
  const setCurrentVideo = useCallback((video: FocusVideo | null) => {
    setCurrentVideoState(video)
    if (video?.topic) setCurrentTopicState(video.topic)
  }, [])

  /**
   * Boot: restore a persistent server-side session via the HttpOnly cookie.
   *  - authenticated  → load that user's isolated state (migrate once)
   *  - anonymous      → guest/sample state, authentication screens shown
   */
  useEffect(() => {
    let cancelled = false
    authApi
      .refreshUser()
      .then((user) => {
        if (cancelled) return
        if (user) {
          const resolved = resolveUserState(user)
          setCurrentUser(user)
          setStorageKey(resolved.key)
          setState(resolved.state)
          setAuthStage('authed')
        } else {
          setAuthStage('anon')
        }
      })
      .catch(() => {
        if (!cancelled) setAuthStage('anon')
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    saveStored(storageKey, state)
  }, [storageKey, state])

  /** Adopt an authenticated user: swap in their isolated state. */
  const adoptUser = useCallback((user: AuthUser) => {
    const resolved = resolveUserState(user)
    setCurrentUser(user)
    setStorageKey(resolved.key)
    setState(resolved.state)
    setAuthStage('authed')
    return user
  }, [])

  const login = useCallback(
    async (email: string, password: string) => {
      const user = await authApi.login(email, password)
      adoptUser(user)
      return user
    },
    [adoptUser],
  )

  const signup = useCallback(
    async (name: string, email: string, password: string) => {
      const user = await authApi.signup(name, email, password)
      adoptUser(user)
      return user
    },
    [adoptUser],
  )

  const loginWithGoogle = useCallback(
    async (credential: string) => {
      const user = await authApi.googleLogin(credential)
      adoptUser(user)
      return user
    },
    [adoptUser],
  )

  const loginWithFirebase = useCallback(
    async (idToken: string) => {
      const user = await authApi.firebaseLogin(idToken)
      adoptUser(user)
      return user
    },
    [adoptUser],
  )

  const logout = useCallback(async () => {
    await authApi.logout()
    setCurrentUser(null)
    setAuthStage('anon')
    // Clear in-memory user state; per-user data stays in localStorage for
    // the next sign-in — guests never see the previous account's data.
    setStorageKey(GUEST_STORAGE_KEY)
    setState(loadGuestState())
  }, [])

  const refreshUser = useCallback(async () => {
    const user = await authApi.refreshUser()
    if (user) adoptUser(user)
    return user
  }, [adoptUser])

  const updateAccountInfo = useCallback(async (patch: { name?: string; email?: string }) => {
    const updated = await authApi.updateProfile(patch)
    setCurrentUser(updated)
    setState((s) => ({ ...s, user: { ...s.user, name: updated.name, email: updated.email } }))
    return updated
  }, [])

  /* ── User goals (backend-backed) ────────────────────────────────────── */

  const goalErrorMessage = useCallback(
    (err: unknown): string =>
      err instanceof GoalError
        ? err.message
        : 'Something went wrong with your goals. Please try again.',
    [],
  )

  const refreshGoals = useCallback(async () => {
    if (!currentUser) {
      setUserGoals([])
      return
    }
    setGoalsLoading(true)
    setGoalsError(null)
    try {
      setUserGoals(await goalsApi.list())
    } catch (err) {
      setGoalsError(goalErrorMessage(err))
    } finally {
      setGoalsLoading(false)
    }
  }, [currentUser, goalErrorMessage])

  // Load goals whenever an account becomes active; clear on sign-out so a
  // guest never sees the previous account's goals.
  useEffect(() => {
    if (authStage !== 'authed' || !currentUser) {
      setUserGoals([])
      setGoalsError(null)
      return
    }
    void refreshGoals()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStage, currentUser?.id])

  /** Insert or replace a goal, keeping "primary" unique in local state. */
  const applyGoal = useCallback((goal: UserGoal) => {
    setUserGoals((prev) => {
      const exists = prev.some((g) => g.id === goal.id)
      const next = exists
        ? prev.map((g) => (g.id === goal.id ? goal : g))
        : [goal, ...prev]
      return goal.isPrimary ? next.map((g) => (g.id === goal.id ? g : { ...g, isPrimary: false })) : next
    })
  }, [])

  const createGoal = useCallback(
    async (input: GoalInput) => {
      const goal = await goalsApi.create(input)
      applyGoal(goal)
      return goal
    },
    [applyGoal],
  )

  const updateGoal = useCallback(
    async (id: string, patch: Partial<GoalInput>) => {
      const goal = await goalsApi.update(id, patch)
      applyGoal(goal)
      return goal
    },
    [applyGoal],
  )

  const deleteGoal = useCallback(async (id: string) => {
    await goalsApi.remove(id)
    setUserGoals((prev) => prev.filter((g) => g.id !== id))
  }, [])

  const runGoalAction = useCallback(
    async (id: string, action: GoalAction) => {
      const goal = await goalsApi.action(id, action)
      applyGoal(goal)
      return goal
    },
    [applyGoal],
  )

  /** Primary goal: explicit flag first, then the first active goal. */
  const primaryGoal = useMemo(
    () =>
      userGoals.find((g) => g.isPrimary) ??
      userGoals.find((g) => g.status === 'active') ??
      null,
    [userGoals],
  )

  /* ── Core state mutations ───────────────────────────────────────────── */

  /** Roadmap derived from the active goal — resolved before mutators append activity. */
  const activeGoal = useMemo(
    () => goalCatalog.find((g) => g.id === state.activeGoalId) ?? null,
    [state.activeGoalId],
  )
  const roadmap = useMemo(
    () => (activeGoal ? getRoadmapForGoal(activeGoal.id) ?? null : null),
    [activeGoal],
  )

  /** Resolve the human title of a lesson id (roadmap lessons only). */
  const lessonTitleOf = useCallback(
    (lessonId: string): string => {
      if (!roadmap) return lessonId
      for (const step of roadmap.steps) {
        const lesson = step.lessons.find((l) => l.id === lessonId)
        if (lesson) return lesson.title
      }
      return lessonId
    },
    [roadmap],
  )

  const pushActivity = useCallback(
    (kind: ActivityEvent['kind'], label: string, detail?: string): ActivityEvent => ({
      id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind,
      label,
      detail,
      at: new Date().toISOString(),
    }),
    [],
  )

  const selectGoal = useCallback((goalId: string) => {
    setState((s) => ({ ...s, activeGoalId: goalId }))
  }, [])

  const markLessonComplete = useCallback(
    (lessonId: string) => {
      const title = lessonTitleOf(lessonId)
      setState((s) => {
        if (s.completedLessonIds.includes(lessonId)) return s
        const event = pushActivity('lesson', title)
        return {
          ...s,
          completedLessonIds: [...s.completedLessonIds, lessonId],
          activity: [event, ...s.activity].slice(0, 30),
        }
      })
    },
    [lessonTitleOf, pushActivity],
  )

  const recordAttempt = useCallback(
    (attempt: Omit<QuizAttempt, 'id' | 'completedAt'>) => {
      const title = lessonTitleOf(attempt.lessonId)
      const event = pushActivity('quiz', title, `${attempt.percentage}%`)
      setState((s) => ({
        ...s,
        attempts: [
          ...s.attempts,
          {
            ...attempt,
            id: `att-${Date.now()}`,
            completedAt: new Date().toISOString().slice(0, 10),
          },
        ],
        activity: [event, ...s.activity].slice(0, 30),
      }))
    },
    [lessonTitleOf, pushActivity],
  )

  const setBlockedSites = useCallback((sites: string[]) => {
    setState((s) => ({ ...s, blockedSites: sites }))
  }, [])

  const logFocusSession = useCallback(
    (minutes: number) => {
      const event = pushActivity('focus', 'Focus session', `${minutes} min`)
      setState((s) => {
        const day = todayKey()
        return {
          ...s,
          totalFocusMinutes: s.totalFocusMinutes + minutes,
          focusSessionsToday: s.focusSessionsToday + 1,
          focusMinutesByDay: {
            ...s.focusMinutesByDay,
            [day]: (s.focusMinutesByDay[day] ?? 0) + minutes,
          },
          activity: [event, ...s.activity].slice(0, 30),
        }
      })
    },
    [pushActivity],
  )

  const updateUser = useCallback((patch: Partial<User>) => {
    setState((s) => ({ ...s, user: { ...s.user, ...patch } }))
  }, [])

  const toggleTheme = useCallback(() => {
    setState((s) => ({ ...s, theme: s.theme === 'light' ? 'dark' : 'light' }))
  }, [])

  const resetAllProgress = useCallback(() => {
    removeStored(storageKey)
    if (!currentUser) return setState(loadGuestState())
    setState((s) => {
      const fresh = defaultStoredFor(currentUser)
      return { ...fresh, user: { ...fresh.user, field: s.user.field, level: s.user.level, dailyGoalMinutes: s.user.dailyGoalMinutes, joinedAt: s.user.joinedAt } }
    })
  }, [storageKey, currentUser])

  const updateAiTopic = useCallback((topicId: string, patch: Partial<AiRoadmapTopic>) => {
    setState((s) => ({
      ...s,
      aiRoadmapTopics: s.aiRoadmapTopics.map((t) =>
        t.id === topicId ? { ...t, ...patch } : t,
      ),
    }))
  }, [])

  const setAiRoadmapTopics = useCallback((topics: AiRoadmapTopic[]) => {
    setState((s) => ({ ...s, aiRoadmapTopics: topics }))
  }, [])

  const setAiRoadmap = useCallback((roadmap: AiGeneratedRoadmap | null) => {    if (!roadmap) {
      setState((s) => ({ ...s, aiRoadmap: null, aiRoadmapTopics: [] }))
      return
    }
    // Flatten phases → topics into the adaptive topic list.
    const flattened: AiRoadmapTopic[] = []
    const previousTopics: string[] = []
    roadmap.phases.forEach((phase) => {
      phase.topics.forEach((t) => {
        const status: AiRoadmapTopic['status'] =
          flattened.length === 0 ? 'current' : 'locked'
        flattened.push({
          id: t.id,
          name: t.title,
          description: t.description,
          overview: t.description,
          status,
          progress: 0,
          difficulty: t.difficulty,
          estimatedTime: `${Math.max(1, Math.round(t.estimated_minutes / 60))} hour${Math.round(t.estimated_minutes / 60) === 1 ? '' : 's'}`,
          estimatedHours: Math.max(1, Math.round(t.estimated_minutes / 60)),
          prerequisites: [...previousTopics].slice(-6),
          skillsGained: t.skills_gained,
          learningObjectives: t.learning_objectives,
          phaseId: phase.id,
        })
        previousTopics.push(t.title)
      })
    })
    setState((s) => ({ ...s, aiRoadmap: roadmap, aiRoadmapTopics: flattened }))
  }, [])

  /* ── Study plan ────────────────────────────────────────────────────── */

  const setStudyPlan = useCallback((next: StudyPlanState) => {
    setState((s) => ({
      ...s,
      studyPlan: {
        ...sanitizeStudyPlan(next, next.dailyTargetMinutes),
        pendingPreview: null,
      },
    }))
  }, [])

  const patchStudyPlan = useCallback((patch: Partial<StudyPlanState>) => {
    setState((s) => ({ ...s, studyPlan: reduceStudyPlan(s.studyPlan, { type: 'merge', patch }) }))
  }, [])

  /**
   * The student's daily target is a real preference, so it is stored with the
   * plan and mirrored onto the profile field the rest of the app already reads.
   */
  const setDailyTargetMinutes = useCallback((minutes: number) => {
    setState((s) => {
      const nextPlan = reduceStudyPlan(s.studyPlan, { type: 'set-daily-target', minutes })
      return {
        ...s,
        user: { ...s.user, dailyGoalMinutes: nextPlan.dailyTargetMinutes },
        studyPlan: nextPlan,
      }
    })
  }, [])

  const applyStudyPlanPreview = useCallback((preview: StudyPlanPreview) => {
    setState((s) => ({
      ...s,
      studyPlan: {
        ...s.studyPlan,
        tasks: preview.tasks.map((task) => ({ ...task, status: 'planned' as const, actualMinutes: 0 })),
        updatedAt: new Date().toISOString(),
        pendingPreview: null,
      },
    }))
  }, [])

  const discardStudyPlanPreview = useCallback(() => {
    setState((s) => ({ ...s, studyPlan: { ...s.studyPlan, pendingPreview: null } }))
  }, [])

  const value: AppContextValue = {
    ...state,
    goals: goalCatalog,
    activeGoal,
    roadmap,
    completedLessonIds: state.completedLessonIds,
    currentTopic,
    currentVideo,
    currentVideoTitle,
    authStage,
    isAuthenticated: authStage === 'authed',
    currentUser,
    login,
    signup,
    loginWithGoogle,
    loginWithFirebase,
    logout,
    refreshUser,
    updateAccountInfo,
    userGoals,
    goalsLoading,
    goalsError,
    primaryGoal,
    refreshGoals,
    createGoal,
    updateGoal,
    deleteGoal,
    runGoalAction,
    selectGoal,
    markLessonComplete,
    recordAttempt,
    setBlockedSites,
    logFocusSession,
    updateUser,
    toggleTheme,
    resetAllProgress,
    setCurrentTopic,
    setCurrentVideo,
    updateAiTopic,
    setAiRoadmapTopics,
    setAiRoadmap,
    studyPlan: state.studyPlan,
    setStudyPlan,
    patchStudyPlan,
    setDailyTargetMinutes,
    applyStudyPlanPreview,
    discardStudyPlanPreview,
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>')
  return ctx
}