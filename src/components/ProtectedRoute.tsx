import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { Logo } from './Logo'
import { useApp } from '../context/AppContext'

/**
 * Blocks every app route until a server-side session is restored.
 *  - while the session is being restored → branded splash
 *  - anonymous → redirect to /login (remembers the originating page)
 *  - authenticated → render the requested page
 */
export function ProtectedRoute() {
  const { authStage } = useApp()
  const location = useLocation()

  if (authStage === 'loading') {
    return (
      <div className="boot-splash">
        <div className="boot-splash-inner">
          <Logo />
          <div className="spinner" aria-hidden />
          <p className="boot-splash-note">Restoring your session…</p>
        </div>
      </div>
    )
  }

  if (authStage !== 'authed') {
    const from = location.pathname + location.search
    return <Navigate to="/login" replace state={{ from }} />
  }

  return <Outlet />
}