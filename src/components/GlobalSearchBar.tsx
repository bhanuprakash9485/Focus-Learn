import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconSearch } from './Icons'

/**
 * Reusable global topic/goal search field.
 *
 * Single implementation shared by the top navigation bar and the AI Roadmap
 * page header — identical search state, handler, navigation and behaviour
 * everywhere. Submits to `/goals?q=<query>` (or `/goals` when empty).
 */
export function GlobalSearchBar() {
  const navigate = useNavigate()
  const [searchQuery, setSearchQuery] = useState('')

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault()
    const q = searchQuery.trim()
    navigate(q ? `/goals?q=${encodeURIComponent(q)}` : '/goals')
  }

  return (
    <form className="topbar-search" onSubmit={handleSearchSubmit} role="search">
      <IconSearch size={16} className="search-icon" />
      <input
        type="search"
        placeholder="Search topics, goals…"
        aria-label="Search"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
      />
    </form>
  )
}