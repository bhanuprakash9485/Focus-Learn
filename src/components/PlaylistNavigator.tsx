import { useEffect, useState } from 'react'
import type { PlaylistInfo, PlaylistVideoRef } from '../types'
import { IconArrowLeft, IconArrowRight, IconBook } from './Icons'

/** Videos rendered at once inside the list — the rest load in pages. */
const LIST_PAGE_SIZE = 50

/**
 * Structured learning-sequence navigator for a detected playlist.
 *
 * Renders the playlist title + video count, ← Previous / Next → controls,
 * and an ORDERED, paginated list of every SafeSearch-approved playlist
 * video. Because playlists can grow to 1000 videos, the list is windowed:
 * the first batch renders immediately and a "Load more" button reveals the
 * rest in pages, so the page never renders one huge list. The current video
 * is always kept visible (load enough to include it), highlighted, and
 * selecting any visible item loads that video.
 */
export function PlaylistNavigator({
  playlist,
  currentVideoId,
  onSelect,
  className,
}: {
  playlist: PlaylistInfo
  currentVideoId: string
  onSelect: (ref: PlaylistVideoRef) => void
  className?: string
}) {
  const [revealed, setRevealed] = useState(LIST_PAGE_SIZE)

  // Reset the window whenever a different playlist is opened.
  useEffect(() => {
    setRevealed(LIST_PAGE_SIZE)
  }, [playlist.id])

  const currentIndex = playlist.videos.findIndex((v) => v.id === currentVideoId)
  const atStart = currentIndex <= 0
  const atEnd = currentIndex === -1 || currentIndex >= playlist.videos.length - 1

  // Always keep the active video inside the rendered window, so stepping
  // through the playlist with Prev/Next never leaves it out of the list.
  const shownCount = Math.min(playlist.videos.length, Math.max(revealed, currentIndex + 1))
  const shown = playlist.videos.slice(0, shownCount)
  const remaining = playlist.videos.length - shownCount
  const hasMore = remaining > 0

  const loadMore = () => {
    setRevealed((r) => Math.min(r + LIST_PAGE_SIZE, playlist.videos.length))
  }

  const goPrev = () => {
    if (!atStart && playlist.videos[currentIndex - 1]) onSelect(playlist.videos[currentIndex - 1])
  }
  const goNext = () => {
    if (!atEnd && playlist.videos[currentIndex + 1]) onSelect(playlist.videos[currentIndex + 1])
  }

  return (
    <div className={`playlist-nav card ${className ?? ''}`}>
      <div className="playlist-nav-head">
        <span className="head-icon">
          <IconBook size={15} />
        </span>
        <div className="playlist-nav-title">
          <strong>{playlist.title}</strong>
          <span className="small muted">{playlist.videoCount} videos</span>
        </div>
      </div>

      <div className="playlist-arrows">
        <button
          type="button"
          className="playlist-arrow"
          onClick={goPrev}
          disabled={atStart}
          aria-label="Previous playlist video"
        >
          <IconArrowLeft size={16} />
          <span>Prev</span>
        </button>
        <span className="small muted">
          {currentIndex >= 0 ? `Video ${currentIndex + 1} of ${playlist.videos.length}` : 'Course'}
        </span>
        <button
          type="button"
          className="playlist-arrow"
          onClick={goNext}
          disabled={atEnd}
          aria-label="Next playlist video"
        >
          <span>Next</span>
          <IconArrowRight size={16} />
        </button>
      </div>

      <ol className="playlist-list">
        {shown.map((item, i) => (
          <li key={item.id}>
            <button
              type="button"
              className={`playlist-item ${item.id === currentVideoId ? 'current' : ''}`}
              onClick={() => onSelect(item)}
              aria-current={item.id === currentVideoId ? 'true' : undefined}
            >
              <span className="playlist-index">{i + 1}</span>
              <span className="playlist-item-title">{item.title}</span>
              <span className="playlist-item-state">
                {item.id === currentVideoId ? (
                  <span className="badge badge-focus">Now Learning</span>
                ) : (
                  <IconArrowRight size={14} className="playlist-go" aria-hidden="true" />
                )}
              </span>
            </button>
          </li>
        ))}
      </ol>

      {hasMore && (
        <button type="button" className="playlist-more" onClick={loadMore}>
          <IconArrowRight size={14} aria-hidden="true" />
          Load more videos ({remaining} remaining)
        </button>
      )}
    </div>
  )
}