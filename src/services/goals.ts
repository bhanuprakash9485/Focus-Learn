import type { GoalAction, GoalInput, UserGoal } from '../types'
import { apiUrl } from '../config/api'

/**
 * Goals API client (backend/server.py + backend/goals.py).
 *
 * Every call is credentialed (session cookie) and scoped server-side to
 * the authenticated user. The API already speaks camelCase for goals, so
 * responses map straight onto the `UserGoal` type.
 */

export class GoalError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'GoalError'
    this.status = status
  }
}

interface GoalResponse {
  ok: boolean
  goal?: UserGoal
  goals?: UserGoal[]
  error?: string
}

function fallbackMessage(status: number): string {
  switch (status) {
    case 400:
      return 'Please check your goal details and try again.'
    case 401:
      return 'Your session has expired. Please log in again.'
    case 403:
      return 'You do not have permission to do that.'
    case 404:
      return 'The FocusLearn goal service is unavailable. Please make sure the backend is running the latest version.'
    case 503:
      return 'The FocusLearn goal service is temporarily unavailable. Please try again.'
    default:
      return 'Something went wrong. Please try again.'
  }
}

/**
 * A bare "Not found" is the backend's route-level 404 sentinel (the catch-all
 * for an unregistered `/api/*` path) — not a meaningful domain message, e.g.
 * when the running server predates the goals routes. Real domain 404s say
 * "Goal not found." and pass through untouched.
 */
function meaningfulError(error: string | undefined, status: number): string {
  const raw = (error ?? '').trim()
  if (raw && !(status === 404 && raw.toLowerCase() === 'not found')) return raw
  return fallbackMessage(status)
}

async function goalFetch<T>(path: string, method: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(apiUrl(path), {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new GoalError('Could not reach the server. Check your connection and try again.', 0)
  }

  let data: GoalResponse | null = null
  try {
    data = (await res.json()) as GoalResponse
  } catch {
    data = null
  }

  if (!res.ok) {
    throw new GoalError(meaningfulError(data?.error, res.status), res.status)
  }
  return data as T
}

export const goalsApi = {
  /** All goals for the signed-in user (primary goal first). */
  list(): Promise<UserGoal[]> {
    return goalFetch<GoalResponse>('/api/goals', 'GET').then((r) => r.goals ?? [])
  },

  /** Create a goal, optionally attaching its AI-generated roadmap. */
  create(input: GoalInput): Promise<UserGoal> {
    return goalFetch<GoalResponse>('/api/goals', 'POST', input).then(
      (r) => r.goal as UserGoal,
    )
  },

  /** Edit a goal's fields and/or replace its roadmap. */
  update(id: string, patch: Partial<GoalInput>): Promise<UserGoal> {
    return goalFetch<GoalResponse>(`/api/goals/${encodeURIComponent(id)}`, 'PUT', patch).then(
      (r) => r.goal as UserGoal,
    )
  },

  /** Permanently delete a goal. */
  async remove(id: string): Promise<void> {
    await goalFetch<GoalResponse>(`/api/goals/${encodeURIComponent(id)}`, 'DELETE')
  },

  /** Run a status transition (pause/resume/archive/restore/complete/set-primary). */
  action(id: string, action: GoalAction): Promise<UserGoal> {
    return goalFetch<GoalResponse>(
      `/api/goals/${encodeURIComponent(id)}/${action}`,
      'POST',
    ).then((r) => r.goal as UserGoal)
  },
}
