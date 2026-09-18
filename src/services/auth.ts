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

/**
 * Map Firebase Authentication (Google popup) errors to safe, user-friendly
 * messages, then fall back to the backend message mapping. Raw SDK/backend
 * error text is never shown.
 */
export function firebaseErrorMessage(err: unknown): string {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code)
      : ''
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
    case 'auth/user-cancelled':
      return 'Google sign-in was cancelled.'
    case 'auth/popup-blocked':
      return 'Your browser blocked the Google sign-in popup. Allow popups and try again.'
    case 'auth/unauthorized-domain':
      return 'Google sign-in is not allowed from this domain. Add it to Firebase Authentication → Settings → Authorized domains.'
    case 'auth/operation-not-allowed':
      return 'Google sign-in is not enabled for this project. Enable it in the Firebase console.'
    case 'auth/configuration-not-found':
    case 'auth/invalid-api-key':
    case 'auth/api-key-not-valid.-please-pass-a-valid-api-key.':
      return 'Google sign-in is not configured correctly.'
    case 'auth/account-exists-with-different-credential':
      return 'An account with this email already exists. Log in with email and password instead.'
    case 'auth/network-request-failed':
      return 'Could not reach Google. Check your connection and try again.'
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a moment and try again.'
    case 'auth/web-storage-unsupported':
      return 'Your browser has cookies/storage disabled. Enable them and try again.'
    case 'auth/user-disabled':
      return 'This account has been disabled.'
    case 'auth/operation-not-supported-in-this-environment':
      return 'Google sign-in is not supported in this browser or environment.'
    case 'auth/invalid-app-credential':
    case 'auth/internal-error':
    case 'auth/invalid-credential':
    case 'auth/argument-error':
      return 'Google sign-in could not be completed. Please try again.'
    default:
      return googleErrorMessage(err)
  }
}

/**
 * Map Google sign-in errors to safe, user-friendly messages. Raw backend or
 * Google error text (which can contain sensitive details) is never shown.
 */
export function googleErrorMessage(err: unknown): string {
  if (err instanceof AuthError) {
    switch (err.status) {
      case 0:
        return 'Could not connect to the server. Please check your connection and try again.'
      case 500:
      case 502:
      case 504:
        return 'Could not reach the FocusLearn server. Make sure the backend is running, then try again.'
      case 401:
        return 'Google could not verify this sign-in. Please try again.'
      case 403:
        return 'Google sign-in is not allowed for this account.'
      case 404:
        return 'Google sign-in is not available on this server. The backend may need a restart.'
      case 409:
        return 'An account with this email already exists. Please log in with email and password instead.'
      case 503:
        return 'Google sign-in is not set up yet. Use email and password for now.'
      case 400:
        return 'Google sign-in could not be completed. Please try again.'
      default:
        return 'Google sign-in did not complete. Please try again.'
    }
  }
  return 'Google sign-in did not complete. Please try again.'
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

  /**
   * Complete Google sign-in. Sends the Google ID token (obtained from
   * Google Identity Services) to the backend, which verifies it against
   * Google before logging in / creating / linking the FocusLearn account.
   */
  googleLogin(credential: string): Promise<AuthUser> {
    return authFetch<AuthResponse>('/api/auth/google', 'POST', { credential }).then(
      (r) => r.user as AuthUser,
    )
  },

  /**
   * Complete Firebase Google sign-in. Sends the Firebase ID token obtained
   * from signInWithPopup to the backend, which verifies it with the official
   * Firebase server verifier before logging in / creating / linking the
   * FocusLearn account.
   */
  firebaseLogin(idToken: string): Promise<AuthUser> {
    return authFetch<AuthResponse>('/api/auth/firebase', 'POST', { idToken }).then(
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