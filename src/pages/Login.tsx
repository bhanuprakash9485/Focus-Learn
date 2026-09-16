import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Logo } from '../components/Logo'
import { AuthError } from '../services/auth'
import { IconEye } from '../components/Icons'
import { useApp } from '../context/AppContext'

export default function Login() {
  const { login, authStage } = useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const loggedOut = searchParams.get('loggedOut') === '1'

  const from = (location.state as { from?: string } | null)?.from ?? '/dashboard'

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setError('')
    setBusy(true)
    try {
      await login(email.trim(), password)
      navigate(from, { replace: true })
    } catch (err) {
      setError(
        err instanceof AuthError
          ? err.message
          : 'Something went wrong. Please try again.',
      )
    } finally {
      setBusy(false)
    }
  }

  if (authStage === 'authed') return <Navigate to="/dashboard" replace />

  return (
    <div className="auth-page">
      <nav className="auth-nav">
        <Logo to="/" />
      </nav>
      <div className="auth-body">
        <div className="auth-card">
          <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
            <Logo to="/" compact />
          </div>
          <h1>Welcome back</h1>
          <p>Continue your personalized learning journey.</p>

          {loggedOut && (
            <div className="banner banner-success mb-1" role="status">
              Logged out successfully.
            </div>
          )}
          {error && (
            <div className="banner banner-danger mb-1" role="alert">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} noValidate>
            <div className="form-group">
              <label htmlFor="login-email">Email</label>
              <input
                id="login-email"
                type="email"
                autoComplete="email"
                placeholder="you@school.edu"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="login-password">Password</label>
              <div className="password-wrap">
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  <IconEye size={17} />
                </button>
              </div>
            </div>
            <button
              type="submit"
              className="btn btn-primary btn-block"
              disabled={busy}
              aria-busy={busy}
            >
              {busy ? 'Logging in…' : 'Log In'}
            </button>
          </form>

          <p className="auth-alt">
            Don't have an account? <Link to="/signup">Sign up</Link>
          </p>
        </div>
      </div>
    </div>
  )
}