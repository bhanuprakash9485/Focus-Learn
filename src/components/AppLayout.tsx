import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { GlobalSearchBar } from './GlobalSearchBar'
import { Logo } from './Logo'
import {
  IconBell,
  IconBranch,
  IconCalendar,
  IconFocus,
  IconHome,
  IconLogout,
  IconMap,
  IconMenu,
  IconQuiz,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconTarget,
  IconTrend,
  IconUser,
} from './Icons'

interface NavItem {
  to: string
  label: string
  icon: (p: { size?: number }) => ReactNode
}

const primaryNav: NavItem[] = [
  { to: '/dashboard', label: 'Home', icon: IconHome },
  { to: '/goals', label: 'My Goals', icon: IconTarget },
  { to: '/ai-roadmap', label: 'Learning Path', icon: IconSparkles },
  { to: '/quiz', label: 'Quizzes', icon: IconQuiz },
  { to: '/performance', label: 'Progress', icon: IconTrend },
  { to: '/settings', label: 'Settings', icon: IconSettings },
]

const exploreNav: NavItem[] = [
  { to: '/search', label: 'Learn Any Topic', icon: IconSearch },
  { to: '/focus', label: 'Focus Mode', icon: IconFocus },
  { to: '/roadmap', label: 'My Roadmap', icon: IconMap },
  { to: '/what-should-i-study', label: 'What Should I Study?', icon: IconBranch },
  { to: '/knowledge-map', label: 'Knowledge Map', icon: IconBranch },
  { to: '/study-plan', label: 'Study Plan', icon: IconCalendar },
  { to: '/profile', label: 'Profile', icon: IconUser },
]

export function AppLayout({
  children,
  hideTopbarSearch = false,
}: {
  children: ReactNode
  /** Hide the global topbar search (used when a page header owns the search). */
  hideTopbarSearch?: boolean
}) {
  const { user, logout } = useApp()
  const navigate = useNavigate()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  // Close the mobile sidebar whenever the route changes.
  useEffect(() => {
    setSidebarOpen(false)
  }, [navigate])

  const initials = user.name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  async function handleLogout() {
    if (loggingOut) return
    setLoggingOut(true)
    await logout()
    navigate('/login?loggedOut=1', { replace: true })
  }

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="sidebar-header">
          <Logo to="/dashboard" />
        </div>

        <nav className="sidebar-nav">
          <span className="sidebar-label">Main</span>
          {primaryNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <item.icon size={19} />
              {item.label}
            </NavLink>
          ))}
          <span className="sidebar-label">Explore</span>
          {exploreNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <item.icon size={19} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="avatar" aria-hidden>
            {initials}
          </div>
          <div className="sidebar-user">
            <div className="name">{user.name}</div>
            <div className="email">{user.email}</div>
          </div>
          <button
            className="sidebar-logout"
            title="Log out"
            aria-label="Log out"
            onClick={handleLogout}
            disabled={loggingOut}
          >
            <IconLogout size={18} />
          </button>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <button
            className="icon-btn menu-btn"
            aria-label="Open navigation"
            onClick={() => setSidebarOpen(true)}
          >
            <IconMenu size={20} />
          </button>
          <Logo to="/dashboard" />

          {!hideTopbarSearch && <GlobalSearchBar />}

          <div className="topbar-spacer" />

          <div className="row">
            <button
              className="icon-btn bell-btn"
              title="Notifications"
              aria-label="Notifications"
              onClick={() => navigate('/study-plan')}
            >
              <IconBell size={19} />
              <span className="bell-dot" aria-hidden />
            </button>
            <button
              className="avatar"
              title="Profile"
              onClick={() => navigate('/profile')}
            >
              {initials}
            </button>
          </div>
        </header>

        <main style={{ flex: 1 }}>{children}</main>
      </div>
    </div>
  )
}