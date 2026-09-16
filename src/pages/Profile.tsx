import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { useApp } from '../context/AppContext'
import { getAverageScore } from '../services/progress'
import { AuthError, authApi } from '../services/auth'
import {
  IconCheck,
  IconKey,
  IconLogout,
  IconQuiz,
  IconSettings,
  IconShield,
  IconSparkles,
  IconTarget,
  IconTrend,
  IconUser,
} from '../components/Icons'
import type { Difficulty } from '../types'

export default function Profile() {
  const {
    user,
    updateUser,
    updateAccountInfo,
    logout,
    blockedSites,
    setBlockedSites,
    attempts,
    resetAllProgress,
    theme,
    toggleTheme,
    activeGoal,
    aiRoadmapTopics,
    completedLessonIds,
    totalFocusMinutes,
  } = useApp()
  const navigate = useNavigate()
  const [name, setName] = useState(user.name)
  const [email, setEmail] = useState(user.email)
  const [field, setField] = useState(user.field)
  const [level, setLevel] = useState<Difficulty>(user.level)
  const [daily, setDaily] = useState(user.dailyGoalMinutes)
  const [newSite, setNewSite] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [siteInput, setSiteInput] = useState('')
  const [pwCurrent, setPwCurrent] = useState('')
  const [pwNew, setPwNew] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwMsg, setPwMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const avg = getAverageScore(attempts)

  const completedTopics =
    aiRoadmapTopics.length > 0
      ? aiRoadmapTopics.filter((t) => t.status === 'completed').length
      : completedLessonIds.length
  const focusHours = Math.floor(totalFocusMinutes / 60)
  const studyTime = totalFocusMinutes === 0 ? '—' : focusHours > 0 ? `${focusHours}h ${totalFocusMinutes % 60}m` : `${totalFocusMinutes}m`

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    if (saving) return
    setSaveError('')
    setSaving(true)
    // Learning preferences are stored locally; account identity (name/email)
    // is also persisted on the backend account so it survives re-login.
    updateUser({ name, email, field, level, dailyGoalMinutes: daily })
    try {
      await updateAccountInfo({ name: name.trim(), email: email.trim() })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (err) {
      setSaveError(
        err instanceof AuthError
          ? err.message
          : 'Could not update your account. Please try again.',
      )
    } finally {
      setSaving(false)
    }
  }

  async function handlePasswordChange(e: FormEvent) {
    e.preventDefault()
    if (pwBusy) return
    if (pwNew.length < 6) {
      setPwMsg({ kind: 'error', text: 'New password must be at least 6 characters.' })
      return
    }
    setPwBusy(true)
    setPwMsg(null)
    try {
      await authApi.changePassword(pwCurrent, pwNew)
      setPwCurrent('')
      setPwNew('')
      setPwMsg({ kind: 'success', text: 'Password updated successfully.' })
    } catch (err) {
      setPwMsg({
        kind: 'error',
        text: err instanceof AuthError ? err.message : 'Could not change password.',
      })
    } finally {
      setPwBusy(false)
    }
  }

  async function handleLogout() {
    await logout()
    navigate('/login?loggedOut=1', { replace: true })
  }

  function addSite() {
    const site = (newSite || siteInput).trim().toLowerCase()
    if (site && !blockedSites.includes(site)) {
      setBlockedSites([...blockedSites, site])
    }
    setNewSite('')
    setSiteInput('')
  }

  function removeSite(site: string) {
    setBlockedSites(blockedSites.filter((s) => s !== site))
  }

  const initials = user.name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <AppLayout>
      <div className="page page-narrow">
        <div className="page-header">
          <h1>Profile &amp; Settings</h1>
          <p>Manage your account, learning preferences and focus shield.</p>
        </div>

        {saved && (
          <div className="banner banner-success mb-2">
            <IconCheck size={17} />
            <span>Profile saved successfully.</span>
          </div>
        )}
        {saveError && (
          <div className="banner banner-danger mb-2" role="alert">
            <span>{saveError}</span>
          </div>
        )}

        {/* Profile card */}
        <div className="card mb-2">
          <div className="row gap-lg wrap">
            <div className="profile-avatar">{initials}</div>
            <div className="flex-1">
              <h2 style={{ fontSize: '1.2rem' }}>{user.name}</h2>
              <p className="muted small">{user.email}</p>
              <div className="row wrap mt-1" style={{ gap: '0.35rem' }}>
                <span className="badge badge-primary">{user.field}</span>
                <span className="badge badge-muted">{user.level}</span>
                <span className="badge badge-warning">🔥 {user.focusStreakDays}-day streak</span>
                <span className="badge badge-focus">Member since {user.joinedAt}</span>
              </div>
            </div>
            <button type="button" className="btn btn-secondary" onClick={handleLogout}>
              <IconLogout size={16} />
              Log Out
            </button>
          </div>
        </div>

        {/* Edit profile */}
        <form onSubmit={handleSave}>
          <div className="card mb-2">
            <div className="row mb-1" style={{ color: 'var(--primary)' }}>
              <IconUser size={18} />
              <h2 className="section-title" style={{ marginBottom: 0 }}>Personal Information</h2>
            </div>
            <div className="grid grid-2">
              <div className="form-group">
                <label htmlFor="pf-name">Full name</label>
                <input id="pf-name" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div className="form-group">
                <label htmlFor="pf-email">Email</label>
                <input id="pf-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="form-group">
                <label htmlFor="pf-field">Field of study</label>
                <select id="pf-field" value={field} onChange={(e) => setField(e.target.value)}>
                  <option>Web Development</option>
                  <option>Python &amp; Data Basics</option>
                  <option>AI &amp; Machine Learning</option>
                  <option>Data Structures &amp; Algorithms</option>
                  <option>UI/UX Design Fundamentals</option>
                  <option>Math for Competitive Exams</option>
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="pf-level">Experience level</label>
                <select id="pf-level" value={level} onChange={(e) => setLevel(e.target.value as Difficulty)}>
                  <option>Beginner</option>
                  <option>Intermediate</option>
                  <option>Advanced</option>
                </select>
              </div>
            </div>
          </div>

          {/* Learning preferences */}
          <div className="card mb-2">
            <div className="row mb-1" style={{ color: 'var(--primary)' }}>
              <IconSettings size={18} />
              <h2 className="section-title" style={{ marginBottom: 0 }}>Learning Preferences</h2>
            </div>
            <div className="form-group">
              <label htmlFor="pf-daily">Daily learning goal: {daily} minutes</label>
              <input
                id="pf-daily"
                type="range"
                min={10}
                max={120}
                step={5}
                value={daily}
                onChange={(e) => setDaily(Number(e.target.value))}
                style={{ accentColor: 'var(--primary)' }}
              />
              <span className="form-hint">FocusLearn paces your roadmap around this target.</span>
            </div>
            <div className="list-row">
              <div>
                <div className="small" style={{ fontWeight: 600 }}>Dark mode</div>
                <div className="faint" style={{ fontSize: '0.8rem' }}>
                  Coming soon — currently light theme only.
                </div>
              </div>
              <button type="button" className="btn btn-secondary" onClick={toggleTheme} disabled>
                {theme === 'light' ? 'Light' : 'Dark'}
              </button>
            </div>
          </div>

          {/* Focus shield */}
          <div className="card mb-2">
            <div className="row mb-1" style={{ color: 'var(--primary)' }}>
              <IconShield size={18} />
              <h2 className="section-title" style={{ marginBottom: 0 }}>Distraction Shield</h2>
            </div>
            <p className="muted small mb-1">
              These sites are hidden during focus sessions. In the full product this list syncs to a
              browser extension.
            </p>
            <div className="row wrap mb-1">
              {blockedSites.map((s) => (
                <span key={s} className="badge badge-focus" style={{ gap: '0.45rem' }}>
                  <span className="strike">{s}</span>
                  <button
                    type="button"
                    onClick={() => removeSite(s)}
                    style={{
                      border: 'none',
                      background: 'none',
                      cursor: 'pointer',
                      color: 'inherit',
                      fontWeight: 700,
                      padding: 0,
                    }}
                    aria-label={`Remove ${s}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="row wrap">
              <div className="form-group" style={{ flex: 1, minWidth: 200, marginBottom: 0 }}>
                <input
                  type="text"
                  placeholder="Add a site, e.g. tiktok.com"
                  value={siteInput}
                  onChange={(e) => setSiteInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addSite()
                    }
                  }}
                />
              </div>
              <button type="button" className="btn btn-secondary" onClick={addSite}>
                Add Site
              </button>
            </div>
          </div>

          <button type="submit" className="btn btn-primary btn-lg" disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </form>

        {/* Security: change password */}
        <form onSubmit={handlePasswordChange}>
          <div className="card mt-3">
            <div className="row mb-1" style={{ color: 'var(--primary)' }}>
              <IconKey size={18} />
              <h2 className="section-title" style={{ marginBottom: 0 }}>Account Security</h2>
            </div>
            {pwMsg && (
              <div
                className={`banner ${pwMsg.kind === 'success' ? 'banner-success' : 'banner-danger'} mb-1`}
                role={pwMsg.kind === 'success' ? 'status' : 'alert'}
              >
                {pwMsg.text}
              </div>
            )}
            <div className="grid grid-2">
              <div className="form-group">
                <label htmlFor="pf-pw-current">Current password</label>
                <input
                  id="pf-pw-current"
                  type="password"
                  autoComplete="current-password"
                  value={pwCurrent}
                  onChange={(e) => setPwCurrent(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="pf-pw-new">New password</label>
                <input
                  id="pf-pw-new"
                  type="password"
                  autoComplete="new-password"
                  placeholder="At least 6 characters"
                  value={pwNew}
                  onChange={(e) => setPwNew(e.target.value)}
                  required
                />
              </div>
            </div>
            <button type="submit" className="btn btn-secondary" disabled={pwBusy}>
              {pwBusy ? 'Updating…' : 'Update Password'}
            </button>
          </div>
        </form>

        {/* Study stats snapshot */}
        <div className="card mt-3">
          <div className="row-between wrap mb-1">
            <div className="row" style={{ color: 'var(--primary)' }}>
              <IconTrend size={18} />
              <h2 className="section-title" style={{ marginBottom: 0 }}>Learning Snapshot</h2>
            </div>
            {activeGoal && (
              <span className="badge badge-primary">
                <IconTarget size={12} />
                {activeGoal.title}
              </span>
            )}
          </div>
          <div className="grid grid-4 mt-1">
            <div>
              <div className="stat-value">{attempts.length}</div>
              <div className="stat-label">Quizzes taken</div>
            </div>
            <div>
              <div className="stat-value">{completedTopics}</div>
              <div className="stat-label">Topics completed</div>
            </div>
            <div>
              <div className="stat-value">{avg !== null ? `${avg}%` : '—'}</div>
              <div className="stat-label">Average score</div>
            </div>
            <div>
              <div className="stat-value">{studyTime}</div>
              <div className="stat-label">Study time</div>
            </div>
          </div>
        </div>

        {/* Danger zone */}
        <div className="card mt-2" style={{ borderColor: 'var(--danger)' }}>
          <div className="row mb-1" style={{ color: 'var(--danger)' }}>
            <IconSparkles size={18} />
            <h2 className="section-title" style={{ marginBottom: 0 }}>Reset</h2>
          </div>
          <p className="muted small mb-1">
            Clears all saved progress for this account and restores default demo data.
            Useful for demos.
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
            onClick={() => {
              if (window.confirm('Reset all progress back to the default demo data?')) {
                resetAllProgress()
              }
            }}
          >
            <IconQuiz size={15} />
            Reset Demo Data
          </button>
        </div>
      </div>
    </AppLayout>
  )
}
