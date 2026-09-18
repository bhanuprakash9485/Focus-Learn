import { useEffect, useRef, useState } from 'react'
import { signInWithPopup } from 'firebase/auth'
import { useApp } from '../context/AppContext'
import { getFirebaseAuth, getGoogleProvider, isFirebaseConfigured } from '../lib/firebase'
import { firebaseErrorMessage } from '../services/auth'

/**
 * Google sign-in button ("Continue with Google").
 *
 * Uses the Firebase Web SDK: clicking the button opens the Google account
 * chooser via `signInWithPopup(GoogleAuthProvider)`. Firebase then returns an
 * authenticated user; the client obtains a Firebase ID token and posts it to
 * the backend (POST /api/auth/firebase), which verifies the token's signature
 * and claims server-side before creating the FocusLearn session. Name/email
 * sent from the browser are never trusted on their own, and no Client Secret
 * or Admin key ever reaches the browser.
 *
 * When the Firebase config is missing the button stays visible but reports
 * "Google sign-in is not configured." — email/password login keeps working.
 */

/** Official Google "G" logo (fast-loading inline SVG, from Google's assets). */
function GoogleGLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  )
}

/**
 * Development-only diagnostic for Google sign-in failures.
 *
 * Logs WHERE the flow failed (popup / id-token / backend) plus the error's
 * code and message so the exact Firebase/backend error is visible in the
 * browser console. It never logs ID tokens, access tokens, credentials or
 * any secret — only the error metadata. No-op in production builds.
 */
function debugLogFirebaseError(
  stage: 'popup' | 'id-token' | 'backend',
  err: unknown,
): void {
  if (!import.meta.env.DEV) return
  const info: Record<string, unknown> = { stage }
  if (err && typeof err === 'object') {
    const e = err as {
      name?: string
      code?: string
      message?: string
      status?: number
    }
    if (e.name) info.name = e.name
    if (e.code) info.code = e.code
    if (e.message) info.message = e.message
    if (typeof e.status === 'number') info.status = e.status
  } else {
    info.value = String(err)
  }
  // Intentionally excludes any token/credential value.
  console.error('[FocusLearn] Google sign-in failed:', info)
}

interface GoogleButtonProps {
  /** Called after a verified Google sign-in and FocusLearn session are established. */
  onSuccess: () => void
  /** Called with a safe, user-friendly message on any failure/cancellation. */
  onError: (message: string) => void
  /** Disables the button (e.g. while the email/password form is submitting). */
  disabled?: boolean
  /** Reports this button's own loading state so the page can lock other controls. */
  onLoadingChange?: (busy: boolean) => void
}

export function GoogleButton({
  onSuccess,
  onError,
  disabled = false,
  onLoadingChange,
}: GoogleButtonProps) {
  const { loginWithFirebase } = useApp()
  const [loading, setLoading] = useState(false)
  const loadingRef = useRef(false)
  const loginRef = useRef(loginWithFirebase)
  const onSuccessRef = useRef(onSuccess)
  const onErrorRef = useRef(onError)
  const onLoadingChangeRef = useRef(onLoadingChange)

  useEffect(() => {
    loginRef.current = loginWithFirebase
    onSuccessRef.current = onSuccess
    onErrorRef.current = onError
    onLoadingChangeRef.current = onLoadingChange
  })

  async function handleStart() {
    if (loadingRef.current || disabled) return
    if (!isFirebaseConfigured) {
      onErrorRef.current(
        'Google sign-in is not configured. Use email and password for now.',
      )
      return
    }

    loadingRef.current = true
    setLoading(true)
    onLoadingChangeRef.current?.(true)
    // Track which stage fails: A/B (popup + ID token) or C (backend).
    let stage: 'popup' | 'id-token' | 'backend' = 'popup'
    try {
      const auth = getFirebaseAuth()
      if (!auth) {
        onErrorRef.current(
          'Google sign-in is not configured. Use email and password for now.',
        )
        return
      }
      const credential = await signInWithPopup(auth, getGoogleProvider())
      stage = 'id-token'
      const idToken = await credential.user.getIdToken()
      stage = 'backend'
      await loginRef.current(idToken)
      onSuccessRef.current()
    } catch (err) {
      debugLogFirebaseError(stage, err)
      onErrorRef.current(firebaseErrorMessage(err))
    } finally {
      loadingRef.current = false
      setLoading(false)
      onLoadingChangeRef.current?.(false)
    }
  }

  return (
    <button
      type="button"
      className="google-btn"
      onClick={handleStart}
      disabled={disabled || loading}
      aria-busy={loading}
    >
      {loading ? <span className="spinner spinner-sm" aria-hidden /> : <GoogleGLogo size={18} />}
      {loading ? 'Signing in with Google…' : 'Continue with Google'}
    </button>
  )
}
