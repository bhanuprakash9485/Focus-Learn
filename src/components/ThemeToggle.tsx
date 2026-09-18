import { useTheme } from '../context/ThemeContext'
import { IconMonitor, IconMoon, IconSun } from './Icons'

/**
 * Theme switcher for the app header.
 *
 * A compact segmented control that cycles through Light, Dark and System.
 * Native buttons keep it keyboard accessible; the active mode is shown both
 * visually (active segment) and semantically (aria-pressed).
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  const options = [
    { value: 'light' as const, label: 'Light mode', icon: IconSun },
    { value: 'dark' as const, label: 'Dark mode', icon: IconMoon },
    { value: 'system' as const, label: 'System theme', icon: IconMonitor },
  ]

  return (
    <div className="theme-toggle" role="group" aria-label="Color theme">
      {options.map((option) => {
        const Icon = option.icon
        const active = theme === option.value
        return (
          <button
            key={option.value}
            type="button"
            className={`theme-toggle-option${active ? ' active' : ''}`}
            aria-label={option.label}
            aria-pressed={active}
            title={option.label}
            onClick={() => setTheme(option.value)}
          >
            <Icon size={17} />
          </button>
        )
      })}
    </div>
  )
}