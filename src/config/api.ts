/**
 * API base URL for the Python backend (backend/server.py).
 *
 * Empty string (default) means same-origin:
 *   - dev: the Vite dev server proxies `/api` to the backend (5173),
 *   - prod: the backend serves the built frontend from `dist/` and the
 *     `/api` calls hit it directly.
 *
 * Set VITE_API_BASE_URL when the built frontend is hosted on a different
 * origin than the backend, e.g. in a `.env.production` file:
 *
 *     VITE_API_BASE_URL=https://api.example.com
 */
export const API_BASE_URL = (
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''
).replace(/\/+$/, '')

/** Prefix a backend route (`/api/...`) with the configured API base URL. */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`
}