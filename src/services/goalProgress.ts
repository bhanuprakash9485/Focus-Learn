import type { GoalPriority, QuizAttempt, UserGoal } from '../types'

/**
 * Per-goal progress, derived from real quiz attempts.
 *
 * Goal roadmaps are AI-generated (phases → topics). Each topic maps to the
 * topic-quiz lesson id convention used across Focus Mode, so a goal's
 * progress always reflects the latest genuine performance — nothing is
 * stored or faked on the goal row itself.
 */

/** Score at/above which a topic is considered mastered (80%). */
export const GOAL_MASTERY_THRESHOLD = 80
/** Score at/above which a topic needs a little practice (60–79%). */
export const GOAL_PRACTICE_THRESHOLD = 60

/** The quiz lesson id for a topic — mirrors getTopicQuiz() in aiService. */
export function topicQuizLessonId(name: string): string {
  const hay = name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  return `topic-${hay.replace(/\s/g, '-')}`
}

/**
 * The attempt lesson id for a goal's own 10/10/10 quiz. A goal quiz is its own
 * record, distinct from the per-topic quizzes inside the goal roadmap, so
 * progress for a goal is never confused with a single lesson's score.
 */
export function goalQuizLessonId(goalId: string): string {
  const hay = (goalId || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  return `goal-quiz-${hay.replace(/\s/g, '-') || 'goal'}`
}

export type GoalTopicStatus =
  | 'completed'
  | 'needs-practice'
  | 'review-required'
  | 'not-started'

export interface GoalTopicProgress {
  id: string
  name: string
  description: string
  phaseTitle: string
  lessonId: string
  status: GoalTopicStatus
  score: number | null
  estimatedMinutes: number
}

export interface GoalProgress {
  topics: GoalTopicProgress[]
  completedTopics: number
  totalTopics: number
  /** Completion percentage 0-100. */
  percent: number
  /** First topic that is not yet mastered, or null when finished. */
  currentTopic: GoalTopicProgress | null
  needsPractice: number
  reviewRequired: number
  /** True once at least one topic has a quiz attempt. */
  hasActivity: boolean
}

/** Latest score per topic-quiz lesson id (attempts are appended in order). */
function latestScores(attempts: QuizAttempt[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const attempt of attempts) {
    if (attempt && typeof attempt.lessonId === 'string') {
      map.set(attempt.lessonId, attempt.percentage)
    }
  }
  return map
}

function statusForScore(score: number | null): GoalTopicStatus {
  if (score === null) return 'not-started'
  if (score >= GOAL_MASTERY_THRESHOLD) return 'completed'
  if (score >= GOAL_PRACTICE_THRESHOLD) return 'needs-practice'
  return 'review-required'
}

export function computeGoalProgress(
  goal: UserGoal,
  attempts: QuizAttempt[],
): GoalProgress | null {
  const roadmap = goal.roadmap
  if (!roadmap || !Array.isArray(roadmap.phases)) return null

  const scores = latestScores(attempts)
  const topics: GoalTopicProgress[] = []
  roadmap.phases.forEach((phase) => {
    phase.topics.forEach((topic) => {
      const lessonId = topicQuizLessonId(topic.title)
      const score = scores.has(lessonId) ? (scores.get(lessonId) as number) : null
      topics.push({
        id: topic.id,
        name: topic.title,
        description: topic.description,
        phaseTitle: phase.title,
        lessonId,
        status: statusForScore(score),
        score,
        estimatedMinutes: topic.estimated_minutes ?? 0,
      })
    })
  })

  if (topics.length === 0) return null

  const completedTopics = topics.filter((t) => t.status === 'completed').length
  const needsPractice = topics.filter((t) => t.status === 'needs-practice').length
  const reviewRequired = topics.filter((t) => t.status === 'review-required').length
  const currentTopic = topics.find((t) => t.status !== 'completed') ?? null

  return {
    topics,
    completedTopics,
    totalTopics: topics.length,
    percent: Math.round((completedTopics / topics.length) * 100),
    currentTopic,
    needsPractice,
    reviewRequired,
    hasActivity: completedTopics + needsPractice + reviewRequired > 0,
  }
}

/** How a goal is tracking against its target date, from real progress. */
export type GoalScheduleStatus = 'on-track' | 'approaching' | 'behind' | 'passed'

/**
 * Compare real completion with the pace needed to hit the target date.
 * Returns null when the goal has no target date or is already completed.
 */
export function goalScheduleStatus(
  goal: UserGoal,
  percent: number,
): GoalScheduleStatus | null {
  if (goal.status === 'completed' || !goal.targetDate) return null
  const target = Date.parse(`${goal.targetDate}T23:59:59`)
  if (Number.isNaN(target)) return null
  const now = Date.now()
  if (now > target) return 'passed'

  const start = Date.parse(goal.createdAt)
  const duration = Number.isNaN(start) ? 0 : target - start
  const expected =
    duration > 0 ? Math.min(100, Math.max(0, ((now - start) / duration) * 100)) : 100
  if (percent >= expected) return 'on-track'

  const daysLeft = (target - now) / 86_400_000
  return daysLeft <= 7 ? 'approaching' : 'behind'
}

/**
 * Estimated completion date from remaining roadmap work at the goal's daily
 * pace. Requires some real history (at least one mastered topic) — otherwise
 * there is not enough signal and the caller shows a hint instead.
 */
export function estimateCompletionDate(
  goal: UserGoal,
  progress: GoalProgress | null,
): string | null {
  if (!progress || progress.completedTopics === 0) return null
  const remaining = progress.topics
    .filter((t) => t.status !== 'completed')
    .reduce((sum, t) => sum + t.estimatedMinutes, 0)
  const daily = goal.dailyMinutes > 0 ? goal.dailyMinutes : 30
  const days = Math.max(1, Math.ceil(remaining / daily))
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

const PRIORITY_RANK: Record<GoalPriority, number> = { high: 0, medium: 1, low: 2 }

/** Sort helper: high priority first. */
export function priorityRank(priority: GoalPriority): number {
  return PRIORITY_RANK[priority] ?? 3
}
