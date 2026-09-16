import type { RecommendedPlaylist, YouTubeSearchSource, YouTubeVideo } from '../types'
import { apiUrl } from '../config/api'

/**
 * YouTube service boundary for FocusLearn.
 *
 * Architecture:
 *  - The YouTube search is done by the Python backend (yt-dlp) at
 *    `GET /api/youtube/search?q=<topic>`. yt-dlp never runs in the
 *    browser — only metadata is extracted, no videos are downloaded,
 *    and no YouTube Data API / Google Cloud API key is required.
 *  - All results are real YouTube videos; there is no fake/mock fallback.
 *    If the backend is unreachable or the search fails, an error source
 *    is returned so the UI can show a friendly message.
 */

/** Backend route served by backend/server.py. */
const API_BASE = apiUrl('/api/youtube/search')

export interface YouTubeSearchResult {
  videos: YouTubeVideo[]
  source: YouTubeSearchSource
  /** Backend SafeSearch verdict for this query (true = allowed). */
  safe?: boolean
  /** True when the backend blocked the query before it reached YouTube. */
  blocked?: boolean
  /** Friendly message from the backend (blocked query / empty after filter). */
  message?: string
  /** YouTube Data API recommended playlist (null when none is relevant/safe). */
  recommendedPlaylist?: RecommendedPlaylist | null
}

/** A single video as returned by the Python backend. */
interface BackendVideo {
  id: string
  title: string
  channel: string
  thumbnail: string
  /** Duration in seconds, or null when unknown. */
  duration: number | null
  description?: string
  url?: string
  /** Set true by the backend only for results that passed SafeSearch. */
  safe_approved?: boolean
  /** Present only when the backend verified the video belongs to a playlist. */
  playlist?: {
    id: string
    title: string
    video_count: number
    channel_id?: string
    first_video: { id: string; title: string } | null
    videos: { id: string; title: string }[]
  } | null
}

/** Raw shape of the `recommended_playlist` field from the Python backend. */
interface BackendRecommendedPlaylist {
  id: string
  playlist_id?: string
  title: string
  description?: string
  channel?: string
  thumbnail?: string
  total_videos?: number
  videos?: { id: string; video_id?: string; title: string; position: number; thumbnail?: string }[]
  first_video?: { id: string; title: string } | null
}

/** Convert a backend video into the frontend YouTubeVideo shape. */
function normalizeBackendVideo(v: BackendVideo): YouTubeVideo {
  return {
    id: v.id,
    title: v.title,
    channel: v.channel,
    thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    duration: v.duration != null ? formatDuration(v.duration) : undefined,
    description: v.description || '',
    url: v.url || `https://www.youtube.com/watch?v=${v.id}`,
    safeApproved: v.safe_approved === true,
    playlist: normalizeBackendPlaylist(v.playlist),
  }
}

/** Convert the backend playlist association (or null) into PlaylistInfo. */
function normalizeBackendPlaylist(p: BackendVideo['playlist']): YouTubeVideo['playlist'] {
  if (!p || !p.first_video) return undefined
  return {
    id: p.id,
    title: p.title,
    videoCount: p.video_count,
    channelId: p.channel_id,
    firstVideo: { id: p.first_video.id, title: p.first_video.title },
    videos: p.videos ?? [],
  }
}

/** Convert the backend recommended playlist (or null) into the frontend shape. */
function normalizeRecommendedPlaylist(
  p: BackendRecommendedPlaylist | null | undefined,
): RecommendedPlaylist | null {
  if (!p || !p.first_video) return null
  return {
    id: p.id,
    playlistId: p.playlist_id,
    title: p.title,
    description: p.description,
    channel: p.channel,
    thumbnail: p.thumbnail,
    totalVideos: p.total_videos,
    videos: (p.videos ?? []).map((v) => ({
      id: v.id,
      videoId: v.video_id,
      title: v.title,
      position: v.position,
      thumbnail: v.thumbnail,
    })),
    firstVideo: { id: p.first_video.id, title: p.first_video.title },
  }
}

/** Format seconds (e.g. 620) as a human duration ("10:20" / "1:02:30"). */
export function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Fetch with a hard timeout so an unreachable backend never hangs the UI. */
async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    window.clearTimeout(timer)
  }
}

/**
 * Search YouTube using the exact `topic` query.
 *
 * Calls the Python (yt-dlp) backend. Never returns mock data — on any
 * failure (unreachable backend or failed search) it returns an error
 * source that the UI renders gracefully. Never throws.
 */
export async function searchYouTubeVideos(topic: string): Promise<YouTubeSearchResult> {
  const t = topic.trim()
  if (!t) return { videos: [], source: 'error' }

  try {
    const res = await fetchWithTimeout(`${API_BASE}?q=${encodeURIComponent(t)}`, 45000)
    if (!res.ok) {
      // Backend answered with an error — the search itself failed.
      return { videos: [], source: 'error' }
    }
    const data = (await res.json()) as {
      videos?: BackendVideo[]
      results?: BackendVideo[]
      safe?: boolean
      blocked?: boolean
      message?: string | null
      query?: string
      recommended_playlist?: BackendRecommendedPlaylist | null
    }
    if (data.blocked) {
      // SafeSearch blocked this query on the backend — no results exist.
      return {
        videos: [],
        source: 'blocked',
        safe: false,
        blocked: true,
        message: data.message ?? undefined,
      }
    }
    const recommendedPlaylist = normalizeRecommendedPlaylist(data.recommended_playlist)
    const list = data.videos ?? data.results
    if (list && list.length > 0) {
      return {
        videos: list.map(normalizeBackendVideo),
        source: 'youtube',
        safe: data.safe ?? true,
        recommendedPlaylist,
      }
    }
    // Backend responded with no matches for this exact query — that is a
    // valid search result, just an empty one.
    return {
      videos: [],
      source: 'youtube',
      safe: data.safe ?? true,
      message: data.message ?? undefined,
      recommendedPlaylist,
    }
  } catch {
    // Backend unreachable (timeout / connection refused).
    return { videos: [], source: 'error' }
  }
}