/**
 * Adaptive study planner.
 *
 * Every number in here is derived from real stored data — roadmap lessons,
 * completed lessons, submitted quiz attempts, missed questions and logged
 * focus minutes. Nothing is invented: when there is no roadmap, no goal or no
 * unfinished work the plan is simply empty, and the UI shows an empty state.
 *
 * The planner never marks anything complete by itself. A task is `done` only
 * when the underlying real activity exists (a lesson in `completedLessonIds`, a
 * matching quiz attempt, or logged focus minutes for a review day), so a timer
 * or a button can never invent learning progress.
 */

import type {
  QuizAttempt,
  Roadmap,
  StudyPlanCandidate,
  StudyPlanDay,
  StudyPlanPreview,
  StudyPlanState,
  StudyPlanStats,
  StudyPriority,
  StudyTask,
  StudyTaskKind,
} from '../types'
import { apiUrl } from '../config/api'

/** Daily study targets the student can pick from. */
export const DAILY_TARGET_OPTIONS = [15, 25, 30, 45, 60] as const

/**
 * A single source of truth for Study Plan state transitions.
 *
 * Every change is applied to the LATEST plan (a pure function of `plan`), so
 * two updates in the same render batch compose cleanly instead of clobbering
 * each other. This is what keeps the selected daily target from being
 * overwritten back to an old value when a click also re-plans the week.
 */
export type StudyPlanUpdate =
  | { type: 'set-daily-target'; minutes: number }
  | {
      type: 'merge'
      patch: Partial<
        Pick<StudyPlanState, 'tasks' | 'updatedAt' | 'pendingPreview' | 'dailyTargetMinutes'>
      >
    }

export function reduceStudyPlan(plan: StudyPlanState, update: StudyPlanUpdate): StudyPlanState {
  switch (update.type) {
    case 'set-daily-target': {
      const minutes = (DAILY_TARGET_OPTIONS as readonly number[]).includes(update.minutes)
        ? update.minutes
        : DAILY_TARGET_OPTIONS[2] // 30 — the middle option is the safe default.
      return { ...plan, dailyTargetMinutes: minutes }
    }
    case 'merge':
      // Merge onto the incoming plan (the latest state), never a stale copy.
      return { ...plan, ...update.patch }
  }
}

/** Smallest useful block of study time. */
const MIN_BLOCK = 5
/** Default length of a review block. */
const REVIEW_MINUTES = 10
/** Default length of a quiz block. */
const QUIZ_MINUTES = 10
/** How many past days of "Missed" rows stay visible (keeps the week compact). */
const MISSED_VISIBLE_DAYS = 7
/** A quiz score under this marks the topic as needing attention. */
const WEAK_SCORE = 60

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Local calendar day key (YYYY-MM-DD). */
export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Today as YYYY-MM-DD. */
export function todayKey(): string {
  return dateKey(new Date())
}

/** Shift a YYYY-MM-DD key by *n* days. */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, (m ?? 1) - 1, d ?? 1)
  date.setDate(date.getDate() + n)
  return dateKey(date)
}

/** Whole days between two day keys (b - a). */
export function daysBetween(a: string, b: string): number {
  const pa = a.split('-').map(Number)
  const pb = b.split('-').map(Number)
  const da = new Date(pa[0], pa[1] - 1, pa[2]).getTime()
  const db = new Date(pb[0], pb[1] - 1, pb[2]).getTime()
  return Math.round((db - da) / 86_400_000)
}

/** Monday of the week containing *key*. */
export function weekStart(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const dow = (date.getDay() + 6) % 7 // Monday = 0
  return addDays(key, -dow)
}

/** The seven day keys of the current week, Monday first. */
export function weekDayKeys(today: string): string[] {
  const start = weekStart(today)
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

/** Mon / Tue / ... label for a day key. */
export function dayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(y, m - 1, d).getDay()]
}

/* ------------------------------------------------------------------ */
/* Real activity                                                       */
/* ------------------------------------------------------------------ */

/** Normalize a topic for matching ("Java-Script Fundamentals" === "java script"). */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/topic-/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Every real quiz attempt, newest first, for a task reference. */
function attemptsFor(attempts: QuizAttempt[], ref: string, title: string): QuizAttempt[] {
  const wanted = normalize(ref)
  const wantedTitle = normalize(title)
  return attempts.filter((a) => {
    const byRef = normalize(a.lessonId) === wanted
    const byTopic = normalize(a.topicName ?? '') === wantedTitle
    return byRef || byTopic
  })
}

/** Best real score (0-100) for a task, or null when never attempted. */
export function bestScoreFor(attempts: QuizAttempt[], ref: string, title: string): number | null {
  const mine = attemptsFor(attempts, ref, title)
  if (mine.length === 0) return null
  return Math.max(...mine.map((a) => a.percentage))
}

/** Weak topics from real missed questions (never a hardcoded list). */
export function weakTopicTitles(attempts: QuizAttempt[], limit = 3): string[] {
  const counts = new Map<string, number>()
  for (const attempt of attempts) {
    const missed = attempt.missedQuestionIds?.length ?? 0
    if (missed === 0) continue
    const title = attempt.topicName ?? attempt.lessonId
    counts.set(title, (counts.get(title) ?? 0) + missed)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([title]) => title)
}

/* ------------------------------------------------------------------ */
/* Candidates                                                          */
/* ------------------------------------------------------------------ */

/**
 * Build the schedulable candidates from the real roadmap.
 *
 * Roadmap order is dependency order: a lesson cannot be scheduled while any
 * lesson of the previous step is unfinished, so each lesson inherits the
 * previous step's lessons as prerequisites. A topic quiz is only schedulable
 * after its own lesson, and a review block is always available.
 */
export function buildCandidates(
  roadmap: Roadmap | null,
  weakTopics: string[],
): StudyPlanCandidate[] {
  if (!roadmap) return []
  const out: StudyPlanCandidate[] = []
  let previousStepLessons: string[] = []

  for (const step of roadmap.steps) {
    for (const lesson of step.lessons) {
      out.push({
        ref: lesson.id,
        title: lesson.title,
        kind: 'lesson',
        minutes: Math.max(MIN_BLOCK, lesson.minutes || 15),
        prerequisites: [...previousStepLessons],
        stepTitle: step.title,
      })
    }
    previousStepLessons = step.lessons.map((l) => l.id)
  }

  // A topic quiz exists for every lesson, but it may only be scheduled after
  // the lesson itself is finished.
  for (const lesson of out.filter((c) => c.kind === 'lesson')) {
    out.push({
      ref: `quiz:${lesson.ref}`,
      title: `${lesson.title} quiz`,
      kind: 'quiz',
      minutes: QUIZ_MINUTES,
      prerequisites: [lesson.ref],
      stepTitle: lesson.stepTitle,
    })
  }

  for (const topic of weakTopics) {
    out.push({
      ref: `review:${normalize(topic) || 'weak-topic'}`,
      title: `Review: ${topic}`,
      kind: 'review',
      minutes: REVIEW_MINUTES,
      prerequisites: [],
      stepTitle: 'Weak areas',
    })
  }

  return out
}

/** Is a candidate already satisfied by real activity? */
function isDoneReal(
  candidate: StudyPlanCandidate,
  completedLessonIds: string[],
  attempts: QuizAttempt[],
  reviewDoneDates: Set<string>,
  date: string,
): boolean {
  if (candidate.kind === 'lesson') return completedLessonIds.includes(candidate.ref)
  if (candidate.kind === 'quiz') {
    const lessonRef = candidate.ref.replace(/^quiz:/, '')
    if (!completedLessonIds.includes(lessonRef)) return false
    return attemptsFor(attempts, lessonRef, candidate.title.replace(/ quiz$/, '')).length > 0
  }
  return reviewDoneDates.has(date)
}

/** Where a task actually takes the student. Every ref maps to a real page. */
export function taskRoute(task: StudyTask, lessonTitle?: string): string {
  if (task.kind === 'quiz') {
    const title = lessonTitle ?? task.title.replace(/ quiz$/, '')
    return `/quiz/topic/${encodeURIComponent(title)}`
  }
  if (task.kind === 'review') return '/performance'
  return `/focus/${task.ref}`
}

/* ------------------------------------------------------------------ */
/* Priority                                                            */
/* ------------------------------------------------------------------ */

/**
 * Priority from real information only: what blocks the rest of the roadmap is
 * High, what is coming up next is Medium, the rest is Low. It never changes the
 * difficulty of any question.
 */
function derivePriority(args: {
  candidate: StudyPlanCandidate
  isBlocking: boolean
  score: number | null
  daysUntilTarget: number | null
  rank: number
}): StudyPriority {
  const { candidate, isBlocking, score, daysUntilTarget, rank } = args
  if (candidate.kind === 'review') return 'high'
  if (isBlocking) return 'high'
  if (score !== null && score < WEAK_SCORE) return 'high'
  if (daysUntilTarget !== null && daysUntilTarget <= 3 && rank === 0) return 'high'
  if (rank <= 2) return 'medium'
  return 'low'
}

/* ------------------------------------------------------------------ */
/* Plan builder (rules engine)                                         */
/* ------------------------------------------------------------------ */

export interface BuildPlanInput {
  candidates: StudyPlanCandidate[]
  completedLessonIds: string[]
  attempts: QuizAttempt[]
  /** Real focus minutes per day (YYYY-MM-DD). */
  focusMinutesByDay: Record<string, number>
  dailyTargetMinutes: number
  today: string
  /** Days left until the goal target date, or null. */
  daysUntilTarget?: number | null
  /** Previously stored tasks, used to carry missed work forward. */
  previousTasks?: StudyTask[]
  source?: 'auto' | 'ai'
}

/** Stable id so a task keeps its identity across re-plans. */
function taskId(candidate: StudyPlanCandidate, date: string): string {
  return `sp-${date}-${candidate.kind}-${candidate.ref.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
}

/**
 * Stable id for a rescheduled copy of a missed session.
 *
 * Appends the session's origin (the date it was originally scheduled for) so
 * that two missed sessions of the SAME lesson carried into the SAME day still
 * get distinct, deterministic ids. The origin is part of the session identity,
 * so the same session always maps to the same id across every rebuild.
 */
function carriedTaskId(session: StudyTask, slot: string): string {
  const origin = session.rescheduledFrom ?? session.date
  const base = taskId(
    {
      ref: session.ref,
      title: session.title,
      kind: session.kind,
      minutes: session.estimatedMinutes,
      prerequisites: [],
      stepTitle: '',
    },
    slot,
  )
  return origin && origin !== slot ? `${base}-from-${origin}` : base
}

/**
 * Build a balanced plan for the current week.
 *
 * - missed work is carried forward, never dropped
 * - a day never exceeds the student's daily target
 * - a topic is only scheduled once its prerequisites are finished
 */
export function buildPlan(input: BuildPlanInput): StudyTask[] {
  const {
    candidates,
    completedLessonIds,
    attempts,
    focusMinutesByDay,
    dailyTargetMinutes,
    today,
    daysUntilTarget = null,
    previousTasks = [],
    source = 'auto',
  } = input

  const target = Math.max(MIN_BLOCK, dailyTargetMinutes)
  const days = weekDayKeys(today)
  const reviewDoneDates = new Set(
    Object.entries(focusMinutesByDay)
      .filter(([, minutes]) => minutes > 0)
      .map(([date]) => date),
  )
  const isDone = (c: StudyPlanCandidate, date: string) =>
    isDoneReal(c, completedLessonIds, attempts, reviewDoneDates, date)

  // 1. Work that was scheduled in the past and never really done. A session
  //    becomes `missed` exactly once — anything already `missed` is kept for
  //    visibility but is never turned into another missed row.
  const missed = previousTasks.filter(
    (t) =>
      t.status !== 'done' &&
      daysBetween(t.date, today) > 0 &&
      daysBetween(t.date, today) <= MISSED_VISIBLE_DAYS,
  )

  // 2. Days still open for new work: today and the rest of the week. The
  //    polarity matters: `daysBetween(today, d) >= 0` keeps today..Sunday, NOT
  //    Monday..today — a regression here would reschedule missed work onto
  //    already-past days, which re-misses it on every rebuild (the runaway).
  const upcoming = days.filter((d) => daysBetween(today, d) >= 0)
  const budget = new Map<string, number>(upcoming.map((d) => [d, target]))

  // Reschedule protection: a missed session is carried forward ONCE. If a live
  // (non-past) replacement for the same original session already exists, reuse
  // it instead of creating a second one — never reschedule the same session
  // twice, and never let a missed row spawn a chain of missed copies.
  const lineageOf = (t: StudyTask): string =>
    `${t.kind}:${t.ref}:${t.rescheduledFrom ?? t.date}`
  const reuseByLineage = new Map<string, StudyTask>()
  for (const t of previousTasks) {
    if (t.status !== 'planned') continue
    if (daysBetween(today, t.date) < 0) continue // already in the past itself
    const key = lineageOf(t)
    if (!reuseByLineage.has(key)) reuseByLineage.set(key, t)
  }

  // Carry a missed task into the earliest future day, once.
  const carried: StudyTask[] = []
  const carriedIds = new Set<string>()
  for (const task of missed) {
    const key = lineageOf(task)
    const existing = reuseByLineage.get(key)
    if (existing) {
      if (!carriedIds.has(existing.id)) {
        carried.push(existing)
        carriedIds.add(existing.id)
        const remaining = budget.get(existing.date)
        if (remaining !== undefined) {
          budget.set(existing.date, remaining - Math.min(existing.estimatedMinutes, remaining))
        }
      }
      continue
    }
    const slot = upcoming.find((d) => (budget.get(d) ?? 0) >= task.estimatedMinutes)
    if (!slot) continue
    budget.set(slot, (budget.get(slot) ?? 0) - task.estimatedMinutes)
    const copy: StudyTask = {
      ...task,
      id: carriedTaskId(task, slot),
      date: slot,
      status: 'planned',
      source,
      rescheduledFrom: task.rescheduledFrom ?? task.date,
      reason: task.reason ?? 'Carried over from a missed session',
    }
    carried.push(copy)
    carriedIds.add(copy.id)
  }

  // 3. Fill the remaining budget in roadmap (dependency) order.
  const scheduled = new Set<string>([
    ...carried.map((t) => `${t.kind}:${t.ref}`),
    ...missed.map((t) => `${t.kind}:${t.ref}`),
  ])
  // Day each ref lands on, so a dependent topic can never be placed before the
  // day its prerequisite is actually done.
  const scheduledDay = new Map<string, string>()
  for (const t of carried) scheduledDay.set(t.ref, t.date)
  const filled: StudyTask[] = []
  const blocked = new Set<string>()

  // Anything the roadmap already finished is not schedulable again.
  // Reviews of weak topics come first: they depend on nothing, and real quiz
  // results must be allowed to change the plan, not just the label on it.
  const pending = candidates
    .filter((c) => !isDone(c, today))
    .sort((a, b) => (a.kind === 'review' ? 0 : 1) - (b.kind === 'review' ? 0 : 1))

  for (let rank = 0; rank < pending.length; rank += 1) {
    const candidate = pending[rank]
    if (scheduled.has(`${candidate.kind}:${candidate.ref}`)) continue

    const slot = upcoming.find((d) => (budget.get(d) ?? 0) >= Math.min(candidate.minutes, target))
    if (!slot) continue

    // Dependency gate: a prerequisite must either already be finished, or be
    // placed on a strictly earlier day in this same plan. A topic that is
    // merely "somewhere on the plan" is not enough — order must be respected.
    const unmet = candidate.prerequisites.filter((p) => {
      if (completedLessonIds.includes(p)) return false
      const prereqDay = scheduledDay.get(p)
      return !(prereqDay !== undefined && prereqDay < slot)
    })
    if (unmet.length > 0) {
      blocked.add(candidate.ref)
      continue
    }

    const minutes = Math.min(candidate.minutes, budget.get(slot) ?? target)
    if (minutes < MIN_BLOCK) continue
    budget.set(slot, (budget.get(slot) ?? 0) - minutes)
    scheduled.add(`${candidate.kind}:${candidate.ref}`)
    scheduledDay.set(candidate.ref, slot)

    const score = candidate.kind === 'quiz'
      ? bestScoreFor(attempts, candidate.ref.replace(/^quiz:/, ''), candidate.title.replace(/ quiz$/, ''))
      : null

    filled.push({
      id: taskId(candidate, slot),
      kind: candidate.kind,
      ref: candidate.ref,
      title: candidate.title,
      date: slot,
      estimatedMinutes: minutes,
      actualMinutes: 0,
      priority: derivePriority({
        candidate,
        // The next unfinished topic is what everything else waits on.
        isBlocking: candidate.prerequisites.length === 0 && rank === 0,
        score,
        daysUntilTarget,
        rank,
      }),
      status: 'planned',
      source,
      reason: reasonFor(candidate, score),
    })
  }

  // 4. Mark the still-unfinished past rows as Missed (kept for visibility).
  const missedRows: StudyTask[] = missed.map((t) => ({ ...t, status: 'missed' }))

  // 5. Collapse to one row per stable id. Identical ids can only appear from
  //    corrupted/migrated localStorage; keeping the first wins, and the sort
  //    order below stays deterministic.
  const seen = new Set<string>()
  const unique: StudyTask[] = []
  for (const t of [...missedRows, ...carried, ...filled]) {
    if (seen.has(t.id)) continue
    seen.add(t.id)
    unique.push(t)
  }

  return unique.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    return rankOf(a) - rankOf(b)
  })
}

/** Display order inside a single day: High first, then kind. */
function rankOf(task: StudyTask): number {
  const order: Record<StudyPriority, number> = { high: 0, medium: 1, low: 2 }
  const kind: Record<StudyTaskKind, number> = { lesson: 0, review: 1, quiz: 2 }
  return order[task.priority] * 10 + kind[task.kind]
}

/** A real-data reason string for the planner's choice. */
function reasonFor(candidate: StudyPlanCandidate, score: number | null): string {
  if (candidate.kind === 'review') return 'You missed questions on this topic recently'
  if (candidate.kind === 'quiz') {
    if (score !== null) {
      return score < WEAK_SCORE
        ? `Last score ${score}% — retake to improve it`
        : `Last score ${score}% — keep it fresh`
    }
    return 'Finish the lesson, then test yourself'
  }
  return candidate.prerequisites.length > 0
    ? 'Next topic whose prerequisites are already done'
    : 'Next unfinished topic in your roadmap'
}

/* ------------------------------------------------------------------ */
/* Real completion + actual minutes                                    */
/* ------------------------------------------------------------------ */

/**
 * Reconcile stored tasks with real activity.
 *
 * `status` becomes `done` only when the real event exists, and `actualMinutes`
 * is filled from the focus minutes the student actually logged that day. Real
 * minutes are never double-counted: each day's minutes are consumed across that
 * day's tasks in order.
 */
export function reconcileWithActivity(
  tasks: StudyTask[],
  input: {
    completedLessonIds: string[]
    attempts: QuizAttempt[]
    focusMinutesByDay: Record<string, number>
    today: string
  },
): StudyTask[] {
  const { completedLessonIds, attempts, focusMinutesByDay, today } = input
  const remaining = new Map<string, number>(
    Object.entries(focusMinutesByDay).map(([date, minutes]) => [date, minutes]),
  )
  const byDate = new Map<string, StudyTask[]>()
  for (const task of tasks) {
    const list = byDate.get(task.date) ?? []
    list.push(task)
    byDate.set(task.date, list)
  }

  const out: StudyTask[] = []
  for (const [date, dayTasks] of byDate) {
    let available = remaining.get(date) ?? 0
    for (const task of dayTasks) {
      const real = taskIsReallyDone(task, completedLessonIds, attempts, focusMinutesByDay, date)
      const spent = Math.min(available, task.estimatedMinutes)
      available -= spent
      if (real.done && spent > 0) {
        out.push({ ...task, status: 'done', actualMinutes: spent, completedAt: real.at })
      } else if (real.done) {
        // Really done but no focus minutes were logged for it (e.g. a quiz).
        out.push({ ...task, status: 'done', actualMinutes: 0, completedAt: real.at })
      } else {
        const missed = daysBetween(date, today) > 0
        out.push({
          ...task,
          status: missed ? 'missed' : 'planned',
          actualMinutes: 0,
          completedAt: undefined,
        })
      }
    }
  }
  return out.sort((a, b) => (a.date === b.date ? rankOf(a) - rankOf(b) : a.date < b.date ? -1 : 1))
}

/** Real completion check for one task. */
function taskIsReallyDone(
  task: StudyTask,
  completedLessonIds: string[],
  attempts: QuizAttempt[],
  focusMinutesByDay: Record<string, number>,
  date: string,
): { done: boolean; at?: string } {
  if (task.kind === 'lesson') {
    if (!completedLessonIds.includes(task.ref)) return { done: false }
    return { done: true, at: date }
  }
  if (task.kind === 'quiz') {
    const lessonRef = task.ref.replace(/^quiz:/, '')
    const mine = attemptsFor(attempts, lessonRef, task.title.replace(/ quiz$/, ''))
    if (mine.length === 0) return { done: false }
    const latest = mine.map((a) => a.completedAt).sort().pop()
    return { done: true, at: latest }
  }
  return (focusMinutesByDay[date] ?? 0) > 0 ? { done: true, at: date } : { done: false }
}

/* ------------------------------------------------------------------ */
/* Week view + statistics                                              */
/* ------------------------------------------------------------------ */

/** Group tasks into the seven days of the current week. */
export function buildWeek(tasks: StudyTask[], today: string): StudyPlanDay[] {
  const keys = weekDayKeys(today)
  return keys.map((date) => {
    const dayTasks = tasks.filter((t) => t.date === date)
    return {
      date,
      label: dayLabel(date),
      tasks: dayTasks,
      // A missed row is history, not a promise, so it never inflates the plan.
      plannedMinutes: dayTasks
        .filter((t) => t.status !== 'missed')
        .reduce((sum, t) => sum + t.estimatedMinutes, 0),
      actualMinutes: dayTasks.reduce((sum, t) => sum + t.actualMinutes, 0),
      isToday: date === today,
      isPast: daysBetween(date, today) > 0,
    }
  })
}

/**
 * Real weekly statistics.
 *
 * `plannedMinutes` only counts live tasks (planned + done), never missed rows,
 * so completed minutes can never be shown as more than planned.
 */
export function computeStats(week: StudyPlanDay[]): StudyPlanStats {
  const live = week.flatMap((d) => d.tasks).filter((t) => t.status !== 'missed')
  const plannedMinutes = live.reduce((sum, t) => sum + t.estimatedMinutes, 0)
  const actualMinutes = live.reduce((sum, t) => sum + t.actualMinutes, 0)
  const tasksDone = live.filter((t) => t.status === 'done').length
  const lessons = live.filter((t) => t.kind === 'lesson')
  const quizzes = live.filter((t) => t.kind === 'quiz')
  return {
    plannedMinutes,
    actualMinutes,
    completionPercent:
      plannedMinutes > 0 ? Math.min(100, Math.round((actualMinutes / plannedMinutes) * 100)) : 0,
    tasksDone,
    tasksTotal: live.length,
    lessonsDone: lessons.filter((t) => t.status === 'done').length,
    lessonsTotal: lessons.length,
    quizzesDone: quizzes.filter((t) => t.status === 'done').length,
    quizzesTotal: quizzes.length,
  }
}

/** The highest-priority unfinished task for today, or null. */
export function todaysFocus(week: StudyPlanDay[]): StudyTask | null {
  const today = week.find((d) => d.isToday)
  if (!today) return null
  return today.tasks.find((t) => t.status === 'planned') ?? null
}

/** Compact list of things that need attention. */
export function needsAttention(
  week: StudyPlanDay[],
  today: string,
  limit = 3,
): { label: string; detail: string }[] {
  const out: { label: string; detail: string }[] = []
  for (const day of week) {
    if (daysBetween(day.date, today) > MISSED_VISIBLE_DAYS) continue
    for (const task of day.tasks) {
      if (out.length >= limit) return out
      if (task.status === 'missed') {
        out.push({ label: task.title, detail: `Missed on ${day.label}` })
      } else if (day.isToday && task.status === 'planned') {
        out.push({ label: task.title, detail: 'Due today' })
      }
    }
  }
  return out
}

/** Next upcoming tasks after today. */
export function upcomingTasks(week: StudyPlanDay[], limit = 4): StudyTask[] {
  return week
    .filter((d) => !d.isPast)
    .flatMap((d) => d.tasks)
    .filter((t) => t.status === 'planned')
    .slice(0, limit)
}

/* ------------------------------------------------------------------ */
/* AI assistant                                                        */
/* ------------------------------------------------------------------ */

export interface AiPlanResult extends StudyPlanPreview {
  /** True when the backend used Groq; false for the rules fallback. */
  fromAi: boolean
  /** Set when the AI could not be reached and the rules engine answered. */
  notice?: string
}

/** One task as the backend returns it (no date, no id — those are ours). */
interface AiTask {
  kind: StudyTaskKind
  ref: string
  title: string
  estimatedMinutes: number
  priority: StudyPriority
  reason: string
}

/**
 * Turn the AI's ordered list into real scheduled tasks.
 *
 * The AI decides the *order* and the *why*; the dates, ids and daily budget are
 * still computed here from the same rules the automatic planner uses, so an AI
 * plan can never exceed the student's daily target or double-book a day.
 */
function materializeAiTasks(
  rawTasks: AiTask[],
  today: string,
  dailyTargetMinutes: number,
  source: 'ai' | 'auto',
): StudyTask[] {
  const target = Math.max(MIN_BLOCK, dailyTargetMinutes)
  const days = weekDayKeys(today).filter((d) => daysBetween(d, today) >= 0)
  const budget = new Map<string, number>(days.map((d) => [d, target]))
  const out: StudyTask[] = []

  for (const task of rawTasks) {
    const want = Math.max(MIN_BLOCK, Math.min(task.estimatedMinutes || target, target))
    const slot = days.find((d) => (budget.get(d) ?? 0) >= want)
    if (!slot) continue
    budget.set(slot, (budget.get(slot) ?? 0) - want)
    out.push({
      id: `sp-${slot}-ai-${task.kind}-${task.ref.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
      kind: task.kind,
      ref: task.ref,
      title: task.title,
      date: slot,
      estimatedMinutes: want,
      actualMinutes: 0,
      priority: task.priority,
      status: 'planned',
      source,
      reason: task.reason,
    })
  }
  return out
}

/**
 * Ask the backend planner to order today's work using the student's real data.
 *
 * The browser only ever talks to the FocusLearn backend — the Groq key stays
 * server-side. When the AI is unavailable the caller falls back to the same
 * rules engine used above, so this never leaves the plan empty.
 */
export async function requestAiPlan(
  context: Parameters<typeof buildAiPayload>[0],
  signal?: AbortSignal,
): Promise<AiPlanResult> {
  const res = await fetch(apiUrl('/api/study-plan/plan'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'include',
    body: JSON.stringify(buildAiPayload(context)),
    signal,
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : 'The study assistant is unavailable.')
  }
  const rawTasks = (Array.isArray(body.tasks) ? body.tasks : []) as AiTask[]
  return {
    tasks: materializeAiTasks(rawTasks, context.today, context.dailyTargetMinutes, 'ai'),
    summary: typeof body.summary === 'string' ? body.summary : '',
    fromAi: body.ai === true,
  }
}

/** Shape sent to POST /api/study-plan/plan (real data only). */
export function buildAiPayload(context: {
  goalTitle: string
  targetDate: string | null
  dailyTargetMinutes: number
  today: string
  completedLessonIds: string[]
  attempts: { topic: string; percentage: number }[]
  weakTopics: string[]
  candidates: StudyPlanCandidate[]
  missedCount: number
  mode?: 'today' | 'week'
}) {
  return {
    mode: context.mode ?? 'today',
    goal: context.goalTitle.slice(0, 200),
    targetDate: context.targetDate,
    dailyTargetMinutes: context.dailyTargetMinutes,
    today: context.today,
    completedLessonIds: context.completedLessonIds.slice(0, 80),
    quizAttempts: context.attempts.slice(0, 20),
    weakTopics: context.weakTopics.slice(0, 20),
    candidates: context.candidates.slice(0, 60).map((c) => ({
      ref: c.ref,
      title: c.title,
      kind: c.kind,
      minutes: c.minutes,
      prerequisites: c.prerequisites,
      step: c.stepTitle,
    })),
    missedCount: context.missedCount,
  }
}
