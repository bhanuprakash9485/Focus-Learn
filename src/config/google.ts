/**
 * Google sign-in configuration.
 *
 * The Google Client ID is a PUBLIC identifier intended to be shipped to the
 * browser (Google documents this) — never a Client Secret. The backend reads
 * the matching GOOGLE_CLIENT_ID from backend/.env to verify token audiences.
 */
export const GOOGLE_CLIENT_ID = (
  (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? ''
).trim()

export const GOOGLE_AUTH_CONFIGURED = GOOGLE_CLIENT_ID.length > 0

/** Official Google Identity Services client script. */
export const GOOGLE_GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client'