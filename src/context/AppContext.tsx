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
  AiGeneratedRoadmap,
  AiRoadmapTopic,
  AuthStage,
  AuthUser,
  Goal,
  QuizAttempt,
  Roadmap,
  User,
  YouTubeVideo,
} from '../types'
import { sampleStudent } from '../data/student'
import { goals as goalCatalog } from '../data/goals'
import { getRoadmapForGoal } from '../data/roadmaps'
import { authApi } from '../services/auth'

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
  logout: () => Promise<void>
  refreshUser: () => Promise<AuthUser | null>
  /** Sync name/email changes to the backend account. */
  updateAccountInfo: (patch: { name?: string; email?: string }) => Promise<AuthUser>
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
}

const AppContext = createContext<AppContextValue | null>(null)

function loadStored(key: string): StoredState | null {
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const parsed = JSON.parse(raw) as StoredState
      if (parsed && typeof parsed === 'object' && parsed.user) return parsed
    }
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

  /* ── Core state mutations ───────────────────────────────────────────── */

  const selectGoal = useCallback((goalId: string) => {
    setState((s) => ({ ...s, activeGoalId: goalId }))
  }, [])

  const markLessonComplete = useCallback((lessonId: string) => {
    setState((s) =>
      s.completedLessonIds.includes(lessonId)
        ? s
        : { ...s, completedLessonIds: [...s.completedLessonIds, lessonId] },
    )
  }, [])

  const recordAttempt = useCallback((attempt: Omit<QuizAttempt, 'id' | 'completedAt'>) => {
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
    }))
  }, [])

  const setBlockedSites = useCallback((sites: string[]) => {
    setState((s) => ({ ...s, blockedSites: sites }))
  }, [])

  const logFocusSession = useCallback((minutes: number) => {
    setState((s) => ({
      ...s,
      totalFocusMinutes: s.totalFocusMinutes + minutes,
      focusSessionsToday: s.focusSessionsToday + 1,
    }))
  }, [])

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

  const setAiRoadmap = useCallback((roadmap: AiGeneratedRoadmap | null) => {
    if (!roadmap) {
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

  const activeGoal = useMemo(
    () => goalCatalog.find((g) => g.id === state.activeGoalId) ?? null,
    [state.activeGoalId],
  )
  const roadmap = useMemo(
    () => (activeGoal ? getRoadmapForGoal(activeGoal.id) ?? null : null),
    [activeGoal],
  )

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
    logout,
    refreshUser,
    updateAccountInfo,
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
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>')
  return ctx
}