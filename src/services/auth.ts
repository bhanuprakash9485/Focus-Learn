import type { AuthUser } from '../types'
import { apiUrl } from '../config/api'

/**
 * API error carrying an HTTP status so callers can tailor messages,
 * e.g. 401 → "incorrect credentials", 409 → "email already in use".
 */
export class AuthError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'AuthError'
    this.status = status
  }
}

interface AuthResponse {
  ok: boolean
  user?: AuthUser
  error?: string
  message?: string
}

function fallbackMessage(status: number): string {
  switch (status) {
    case 400:
      return 'Please check your information and try again.'
    case 401:
      return 'Incorrect email or password.'
    case 403:
      return 'You do not have permission to do that.'
    case 409:
      return 'An account with this email already exists.'
    case 500:
      return 'Something went wrong. Please try again.'
    default:
      return 'Something went wrong. Please try again.'
  }
}

/** Single fetch helper for all auth endpoints (session cookie = same-origin). */
async function authFetch<T>(path: string, method: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(apiUrl(path), {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new AuthError('Could not connect to the server. Please try again.', 0)
  }

  let data: AuthResponse | null = null
  try {
    data = (await res.json()) as AuthResponse
  } catch {
    data = null
  }

  if (!res.ok) {
    const message = data?.error || fallbackMessage(res.status)
    throw new AuthError(message, res.status)
  }
  return data as T
}

export const authApi = {
  /** Create an account. Resolves with the new user on success. */
  signup(name: string, email: string, password: string): Promise<AuthUser> {
    return authFetch<AuthResponse>('/api/auth/signup', 'POST', { name, email, password }).then(
      (r) => r.user as AuthUser,
    )
  },

  /** Start a session. Resolves with the authenticated user on success. */
  login(email: string, password: string): Promise<AuthUser> {
    return authFetch<AuthResponse>('/api/auth/login', 'POST', { email, password }).then(
      (r) => r.user as AuthUser,
    )
  },

  /** End the current session. Best-effort — never rejects. */
  async logout(): Promise<void> {
    try {
      await authFetch<AuthResponse>('/api/auth/logout', 'POST')
    } catch {
      // The user is leaving regardless; the cookie may already be expired.
    }
  },

  /** Current-user lookup. Returns null when not authenticated. */
  async refreshUser(): Promise<AuthUser | null> {
    try {
      const data = await authFetch<AuthResponse>('/api/auth/me', 'GET')
      return data.user ?? null
    } catch (err) {
      if (err instanceof AuthError && err.status === 401) return null
      throw err
    }
  },

  /** Update the authenticated user's account info (name/email). */
  updateProfile(patch: { name?: string; email?: string }): Promise<AuthUser> {
    return authFetch<AuthResponse>('/api/auth/profile', 'PUT', patch).then(
      (r) => r.user as AuthUser,
    )
  },

  /** Change the authenticated user's password. */
  changePassword(currentPassword: string, newPassword: string): Promise<void> {
    return authFetch<AuthResponse>('/api/auth/change-password', 'POST', {
      current_password: currentPassword,
      new_password: newPassword,
    }).then(() => undefined)
  },
}