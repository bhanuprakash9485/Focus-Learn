import { Link } from 'react-router-dom'
import { IconFocus } from './Icons'

export function Logo({
  to = '/',
  compact = false,
}: {
  to?: string
  compact?: boolean
}) {
  return (
    <Link to={to} className="logo">
      <span className="logo-mark">
        <IconFocus size={18} />
      </span>
      {!compact && <span>FocusLearn</span>}
    </Link>
  )
}
