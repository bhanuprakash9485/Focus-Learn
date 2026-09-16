import { useNavigate } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { useApp } from '../context/AppContext'
import { getAverageScore } from '../services/progress'
import {
  IconBell,
  IconBook,
  IconLogout,
  IconShield,
  IconSparkles,
  IconTarget,
  IconUser,
} from '../components/Icons'

export default function Settings() {
  const { user, attempts, activeGoal, blockedSites, totalFocusMinutes, logout } = useApp()
  const navigate = useNavigate()

  const avg = getAverageScore(attempts)
  const focusHours = Math.floor(totalFocusMinutes / 60)
  const studyTime =
    totalFocusMinutes === 0
      ? '—'
      : focusHours > 0
        ? `${focusHours}h ${totalFocusMinutes % 60}m`
        : `${totalFocusMinutes}m`

  async function handleLogout() {
    await logout()
    navigate('/login?loggedOut=1', { replace: true })
  }

  return (
    <AppLayout>
      <div className="page page-narrow">
        <div className="page-header">
          <div>
            <span className="kicker">
              <IconSparkles size={12} />
              Settings
            </span>
            <h1>Account Settings</h1>
            <p>Your FocusLearn account at a glance.</p>
          </div>
          <div className="page-header-actions">
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/profile')}>
              Edit Profile
            </button>
            <button type="button" className="btn btn-secondary" onClick={handleLogout}>
              <IconLogout size={16} />
              Log Out
            </button>
          </div>
        </div>

        <div className="settings-grid">
          <section className="card settings-card">
            <h3>
              <IconUser size={16} />
              Account
            </h3>
            <dl>
              <div className="settings-row">
                <dt>Name</dt>
                <dd>{user.name}</dd>
              </div>
              <div className="settings-row">
                <dt>Email</dt>
                <dd>{user.email}</dd>
              </div>
              <div className="settings-row">
                <dt>Member since</dt>
                <dd>{user.joinedAt}</dd>
              </div>
              <div className="settings-row">
                <dt>Role</dt>
                <dd>Student</dd>
              </div>
            </dl>
          </section>

          <section className="card settings-card">
            <h3>
              <IconTarget size={16} />
              Learning
            </h3>
            <dl>
              <div className="settings-row">
                <dt>Field of study</dt>
                <dd>{user.field}</dd>
              </div>
              <div className="settings-row">
                <dt>Experience level</dt>
                <dd>{user.level}</dd>
              </div>
              <div className="settings-row">
                <dt>Daily goal</dt>
                <dd>{user.dailyGoalMinutes} min</dd>
              </div>
              <div className="settings-row">
                <dt>Focus streak</dt>
                <dd>🔥 {user.focusStreakDays} day{user.focusStreakDays === 1 ? '' : 's'}</dd>
              </div>
              {activeGoal && (
                <div className="settings-row">
                  <dt>Active goal</dt>
                  <dd>{activeGoal.title}</dd>
                </div>
              )}
            </dl>
          </section>

          <section className="card settings-card">
            <h3>
              <IconBook size={16} />
              Progress
            </h3>
            <dl>
              <div className="settings-row">
                <dt>Quizzes taken</dt>
                <dd>{attempts.length}</dd>
              </div>
              <div className="settings-row">
                <dt>Average score</dt>
                <dd>{avg !== null ? `${avg}%` : '—'}</dd>
              </div>
              <div className="settings-row">
                <dt>Focus minutes</dt>
                <dd>{studyTime}</dd>
              </div>
              <div className="settings-row">
                <dt>Blocked sites</dt>
                <dd>{blockedSites.length}</dd>
              </div>
            </dl>
          </section>

          <section className="card settings-card">
            <h3>
              <IconShield size={16} />
              Distraction Shield
            </h3>
            <p className="small muted mb-1" style={{ marginBottom: '0.8rem' }}>
              These sites stay blocked during every focus session.
            </p>
            <div className="row wrap" style={{ gap: '0.35rem' }}>
              {blockedSites.length > 0 ? (
                blockedSites.map((s) => (
                  <span key={s} className="badge badge-focus">
                    <span className="strike">{s}</span>
                  </span>
                ))
              ) : (
                <span className="small faint">No blocked sites added yet.</span>
              )}
            </div>
          </section>
        </div>

        <div className="card" style={{ marginTop: '1rem', padding: '1.2rem 1.3rem' }}>
          <div className="row wrap" style={{ gap: '1rem' }}>
            <div className="row" style={{ gap: '0.6rem' }}>
              <IconBell size={18} style={{ color: 'var(--primary)' }} />
              <div>
                <div className="small" style={{ fontWeight: 600 }}>
                  Notifications
                </div>
                <div className="faint" style={{ fontSize: '0.8rem' }}>
                  Reminders surface in your Study Plan.
                </div>
              </div>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginLeft: 'auto' }}
              onClick={() => navigate('/study-plan')}
            >
              View Study Plan
            </button>
          </div>
        </div>
      </div>
    </AppLayout>
  )
}