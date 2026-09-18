import { apiUrl } from '../config/api'
import type {
  AnswerFeedback,
  DifficultyBreakdown,
  Quiz,
  QuizDifficulty,
  QuizGenerationState,
  TopicQuizStatus,
  TopicQuizSubmission,
} from '../types'

/**
 * Topic quiz API client (backend/server.py + backend/quiz_service.py).
 *
 * The backend is the authority for generation, answers, attempt counts,
 * difficulty unlocking, scoring and persistence. It never ships its Groq
 * credentials to the frontend. Requests go through the same-origin vite
 * proxy (like goals.ts), so the session cookie authenticates every call.
 */

export class TopicQuizError extends Error {
  readonly status: number
  readonly blocked: boolean

  constructor(message: string, status: number, blocked = false) {
    super(message)
    this.name = 'TopicQuizError'
    this.status = status
    this.blocked = blocked
  }
}

function fallbackMessage(status: number): string {
  switch (status) {
    case 400:
      return 'Please check the quiz details and try again.'
    case 401:
      return 'Your session has expired. Please log in again.'
    case 409:
      return 'This quiz is still being prepared. Please wait a moment.'
    case 503:
      return 'Quiz preparation is temporarily unavailable. Please try again.'
    default:
      return 'Something went wrong. Please try again.'
  }
}

function meaningfulError(error: string | undefined, status: number): string {
  const raw = (error ?? '').trim()
  if (raw && !(status === 404 && raw.toLowerCase() === 'not found')) return raw
  return fallbackMessage(status)
}

async function topicQuizFetch<T>(path: string, method: string, body?: unknown): Promise<T> {
  let res: Response
  let data: { error?: string } | null = null
  try {
    res = await fetch(apiUrl(path), {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new TopicQuizError('Could not reach the server. Check your connection and try again.', 0)
  }
  try {
    data = (await res.json()) as { error?: string } | null
  } catch {
    data = null
  }
  if (!res.ok) {
    throw new TopicQuizError(meaningfulError(data?.error, res.status), res.status)
  }
  return data as T
}

/** Difficulty tier order, easiest first. */
export const QUIZ_TIER_ORDER: QuizDifficulty[] = ['basic', 'moderate', 'advanced']

export interface PrepareQuizInput {
  topic: string
  level?: string
  goal?: string
  roadmap?: string
  /** Current quiz id -> requests a targeted weak-concept retest. */
  quizId?: string
  concepts?: string[]
}

interface PrepareResult {
  quiz_id: string
  status: QuizGenerationState
}

function emptyBreakdown(): DifficultyBreakdown {
  return {
    basic: { correct: 0, total: 0 },
    moderate: { correct: 0, total: 0 },
    advanced: { correct: 0, total: 0 },
  }
}

/**
 * Start (or fetch a ready/cached) quiz for a topic. Never blocks: the
 * backend generates in a background thread and returns immediately.
 */
export async function prepareQuiz(input: PrepareQuizInput): Promise<PrepareResult> {
  const topic = (input.topic || '').trim().slice(0, 200)
  if (!topic) throw new TopicQuizError('Enter a topic to prepare a quiz.', 400)
  return topicQuizFetch<PrepareResult>('/api/quiz/prepare', 'POST', {
    topic,
    level: (input.level || 'beginner').slice(0, 20),
    goal: input.goal,
    roadmap: input.roadmap,
    quiz_id: input.quizId,
    concepts: (input.concepts || [])
      .map((c) => String(c).trim())
      .filter(Boolean)
      .slice(0, 12),
  })
}

/** Server-authoritative quiz state for a topic. */
export async function getQuizStatus(topic: string): Promise<TopicQuizStatus> {
  const t = (topic || '').trim().slice(0, 200)
  if (!t) throw new TopicQuizError('Enter a topic to check quiz status.', 400)
  return topicQuizFetch<TopicQuizStatus>(
    `/api/quiz/status?topic=${encodeURIComponent(t)}`,
    'GET',
  )
}

/** The validated quiz (only available once READY). */
export async function getQuiz(quizId: string): Promise<Quiz> {
  if (!quizId) throw new TopicQuizError('Quiz not found.', 404)
  const data = await topicQuizFetch<{ quiz: Quiz }>(
    `/api/quiz/${encodeURIComponent(quizId)}`,
    'GET',
  )
  return data.quiz
}

/** Record one submitted answer — the server counts attempts + unlocks tiers. */
export async function answerQuiz(
  quizId: string,
  index: number,
  selectedIndex: number,
): Promise<AnswerFeedback> {
  if (!quizId) throw new TopicQuizError('Quiz not found.', 404)
  return topicQuizFetch<AnswerFeedback>(
    `/api/quiz/${encodeURIComponent(quizId)}/answer`,
    'POST',
    { index, selected_index: selectedIndex },
  )
}

/** Submit — the server scores authoritatively and returns the breakdown. */
export async function submitQuiz(quizId: string): Promise<TopicQuizSubmission> {
  if (!quizId) throw new TopicQuizError('Quiz not found.', 404)
  const data = await topicQuizFetch<{ submission: TopicQuizSubmission }>(
    `/api/quiz/${encodeURIComponent(quizId)}/submit`,
    'POST',
  )
  return data.submission
}

export { emptyBreakdown }