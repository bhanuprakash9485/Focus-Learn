import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Logo } from '../components/Logo'
import { GoogleButton } from '../components/GoogleButton'
import { ThemeToggle } from '../components/ThemeToggle'
import { AuthError } from '../services/auth'
import { IconEye } from '../components/Icons'
import { useApp } from '../context/AppContext'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const MIN_PASSWORD_LENGTH = 6

export default function Signup() {
  const { signup, authStage } = useApp()
  const navigate = useNavigate()
  const location = useLocation()

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [googleBusy, setGoogleBusy] = useState(false)
  const [errors, setErrors] = useState<{ field?: string; form?: string }>({})

  const from = (location.state as { from?: string } | null)?.from ?? '/dashboard'

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setErrors({})

    // Client-side validation with friendly messages before hitting the API.
    if (!name.trim()) {
      setErrors({ form: 'Please enter your name.' })
      return
    }
    if (!EMAIL_RE.test(email.trim())) {
      setErrors({ form: 'Please enter a valid email.' })
      return
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setErrors({
        form: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      })
      return
    }
    if (password !== confirm) {
      setErrors({ form: 'Passwords do not match.' })
      return
    }

    setBusy(true)
    try {
      await signup(name.trim(), email.trim(), password)
      navigate(from, { replace: true })
    } catch (err) {
      if (err instanceof AuthError && err.status === 409) {
        setErrors({ form: 'An account with this email already exists.' })
      } else {
        setErrors({
          form: err instanceof AuthError ? err.message : 'Something went wrong. Please try again.',
        })
      }
    } finally {
      setBusy(false)
    }
  }

  if (authStage === 'authed') return <Navigate to="/dashboard" replace />

  return (
    <div className="auth-page">
      <nav className="auth-nav">
        <Logo to="/" />
        <ThemeToggle />
      </nav>
      <div className="auth-body">
        <div className="auth-card">
          <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
            <Logo to="/" compact />
          </div>
          <h1>Create your FocusLearn account</h1>
          <p>Sign up and your AI roadmap is just one step away.</p>

          {errors.form && (
            <div className="banner banner-danger mb-1" role="alert">
              {errors.form}
            </div>
          )}

          <GoogleButton
            onSuccess={() => navigate(from, { replace: true })}
            onError={(m) => setErrors({ form: m })}
            disabled={busy}
            onLoadingChange={setGoogleBusy}
          />
          <div className="auth-divider" aria-hidden="true">
            <span>OR</span>
          </div>

          <form onSubmit={handleSubmit} noValidate>
            <div className="form-group">
              <label htmlFor="su-name">Full name</label>
              <input
                id="su-name"
                type="text"
                autoComplete="name"
                placeholder="Asha Verma"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="su-email">Email</label>
              <input
                id="su-email"
                type="email"
                autoComplete="email"
                placeholder="you@school.edu"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="su-password">Password</label>
              <div className="password-wrap">
                <input
                  id="su-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
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
            <div className="form-group">
              <label htmlFor="su-confirm">Confirm password</label>
              <input
                id="su-confirm"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder="Re-enter your password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary btn-block"
              disabled={busy || googleBusy}
              aria-busy={busy}
            >
              {busy ? 'Creating account…' : 'Sign Up'}
            </button>
          </form>

          <p className="auth-alt">
            Already have an account? <Link to="/login">Log in</Link>
          </p>
        </div>
      </div>
    </div>
  )
}