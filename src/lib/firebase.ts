/**
 * Firebase Web SDK initialization for Google sign-in.
 *
 * Configuration is read exclusively from Vite environment variables
 * (VITE_FIREBASE_*) so nothing is hardcoded in source. The Firebase Web
 * config (api key / app id / sender id) is a PUBLIC browser identifier —
 * it is not a secret and grants no server-side access on its own. The
 * Firebase ID token returned by sign-in is always verified by the Python
 * backend (see backend/firebase_auth.py) before a session is created.
 *
 * The app is initialized at most once, and only when the configuration is
 * present. When it is missing, `isFirebaseConfigured` is false and email/
 * password sign-in keeps working — the React app never crashes.
 */

import { initializeApp, type FirebaseApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider, type Auth } from 'firebase/auth'

const firebaseConfig = {
  apiKey: (import.meta.env.VITE_FIREBASE_API_KEY ?? '').trim(),
  authDomain: (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '').trim(),
  projectId: (import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '').trim(),
  storageBucket: (import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? '').trim(),
  messagingSenderId: (import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '').trim(),
  appId: (import.meta.env.VITE_FIREBASE_APP_ID ?? '').trim(),
}

/** All values the Firebase Web SDK needs to run Google sign-in. */
export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
    firebaseConfig.authDomain &&
    firebaseConfig.projectId &&
    firebaseConfig.appId,
)

let app: FirebaseApp | null = null
let auth: Auth | null = null

/**
 * Lazily initialize Firebase exactly once. Returns null when the
 * configuration is absent so callers can disable the Google button instead
 * of crashing the app.
 */
export function getFirebaseAuth(): Auth | null {
  if (!isFirebaseConfigured) return null
  if (!app) app = initializeApp(firebaseConfig)
  if (!auth) auth = getAuth(app)
  return auth
}

/**
 * A fresh GoogleAuthProvider. `prompt: select_account` makes Google show the
 * account chooser instead of silently reusing the last account.
 */
export function getGoogleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  return provider
}
