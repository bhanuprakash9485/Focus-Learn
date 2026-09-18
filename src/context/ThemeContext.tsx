import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

/**
 * Centralized theme system for FocusLearn.
 *
 * Single source of truth for Light / Dark / System mode. The active theme is
 * applied to the root <html> element via the `data-theme` attribute, which the
 * stylesheet uses to switch the CSS custom properties (see styles/theme.css).
 *
 * The user's choice is persisted to localStorage under `focuslearn-theme`, and
 * an inline script in index.html applies it before React mounts so there is no
 * flash of the wrong theme (FOUC).
 */

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const THEME_STORAGE_KEY = 'focuslearn-theme'
const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)'

interface ThemeContextValue {
  /** The user's stored preference ("system" = follow the OS). */
  theme: ThemePreference
  /** The concrete theme currently rendered (never "system"). */
  resolvedTheme: ResolvedTheme
  setTheme: (theme: ThemePreference) => void
  /** Cycle light → dark → system → light (used by the header toggle). */
  cycleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function readStoredTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // Storage unavailable — fall back to the default.
  }
  return 'light'
}

function writeStoredTheme(theme: ThemePreference) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Storage unavailable — theme just won't persist.
  }
}

function applyResolvedTheme(theme: ResolvedTheme) {
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.style.colorScheme = theme
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(readStoredTheme)
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(DARK_MEDIA_QUERY).matches
      : false,
  )

  // Keep track of the OS preference so "system" always reflects the live value.
  useEffect(() => {
    const mq = window.matchMedia(DARK_MEDIA_QUERY)
    const handleChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    setSystemDark(mq.matches)
    mq.addEventListener('change', handleChange)
    return () => mq.removeEventListener('change', handleChange)
  }, [])

  const resolvedTheme: ResolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  // Apply on mount and whenever the resolved theme changes.
  useEffect(() => {
    applyResolvedTheme(resolvedTheme)
  }, [resolvedTheme])

  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState(next)
    writeStoredTheme(next)
  }, [])

  const cycleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: ThemePreference = prev === 'light' ? 'dark' : prev === 'dark' ? 'system' : 'light'
      writeStoredTheme(next)
      return next
    })
  }, [])

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme, cycleTheme }),
    [theme, resolvedTheme, setTheme, cycleTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>')
  return ctx
}