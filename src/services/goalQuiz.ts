import { quizFetch, TopicQuizError } from './topicQuiz'
import type {
  AiGeneratedRoadmap,
  Goal,
  GoalExperienceLevel,
  GoalQuizPrepareResult,
  GoalQuizStatus,
  UserGoal,
} from '../types'

/**
 * Goal quiz API client (backend/server.py + backend/quiz_service.py).
 *
 * Every goal a student can pick — the public catalogue, their saved goal, or a
 * goal they wrote themselves — has its own quiz of exactly 10 Basic + 10
 * Moderate + 10 Difficult questions. Generation runs in the background on the
 * server, is persisted in SQLite, and is reused (never regenerated) once it is
 * complete. The same fetch helper, session cookie and error shapes as the topic
 * quiz client are used, so the UI handles both identically.
 */

/** The parts of a goal the server needs to build an on-goal quiz. */
export interface GoalQuizGoalInput {
  id: string
  title: string
  description?: string
  goalContext?: string
  existingKnowledge?: string
  experienceLevel?: string
  roadmap?: AiGeneratedRoadmap | null
}

function goalId(value: string): string {
  const id = (value || '').trim().slice(0, 80)
  if (!id) throw new TopicQuizError('This goal has no id, so its quiz cannot be found.', 400)
  return id
}

/** Ask the server to prepare (or reuse) the 10/10/10 quiz for a goal. */
export async function prepareGoalQuiz(goal: GoalQuizGoalInput): Promise<GoalQuizPrepareResult> {
  const id = goalId(goal.id)
  const title = (goal.title || '').trim().slice(0, 200)
  if (!title) throw new TopicQuizError('This goal has no title to build a quiz from.', 400)
  return quizFetch<GoalQuizPrepareResult>(
    `/api/quiz/goal/${encodeURIComponent(id)}/prepare`,
    'POST',
    {
      title,
      description: goal.description,
      goalContext: goal.goalContext,
      existingKnowledge: goal.existingKnowledge,
      experienceLevel: goal.experienceLevel,
      roadmap: goal.roadmap,
    },
  )
}

/** Server-authoritative state of a goal's quiz. */
export async function getGoalQuizStatus(goalIdValue: string): Promise<GoalQuizStatus> {
  const id = goalId(goalIdValue)
  return quizFetch<GoalQuizStatus>(`/api/quiz/goal/${encodeURIComponent(id)}`, 'GET')
}

/** Every stored goal quiz in one request (used by the quiz hub). */
export async function getGoalQuizStatuses(): Promise<Record<string, GoalQuizStatus>> {
  const data = await quizFetch<{ goals: Record<string, GoalQuizStatus> }>(
    '/api/quiz/goals',
    'GET',
  )
  return data.goals || {}
}

/** Build the prepare payload from a catalogue goal (src/data/goals.ts). */
export function catalogGoalToQuizInput(goal: Goal): GoalQuizGoalInput {
  const level: GoalExperienceLevel =
    goal.difficulty === 'Advanced'
      ? 'advanced'
      : goal.difficulty === 'Intermediate'
        ? 'intermediate'
        : 'beginner'
  return {
    id: goal.id,
    title: goal.title,
    description: goal.description,
    experienceLevel: level,
  }
}

/** Build the prepare payload from a saved goal as returned by /api/goals. */
export function userGoalToQuizInput(goal: UserGoal): GoalQuizGoalInput {
  return {
    id: goal.id,
    title: goal.title,
    description: goal.description ?? undefined,
    goalContext: goal.goalContext ?? undefined,
    existingKnowledge: goal.existingKnowledge ?? undefined,
    experienceLevel: goal.experienceLevel ?? undefined,
    roadmap: goal.roadmap ?? null,
  }
}
