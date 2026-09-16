import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { useApp, type FocusVideo } from '../context/AppContext'
import { searchYouTubeVideos } from '../services/youtubeService'
import { AiLearningGuide } from '../components/AiLearningGuide'
import { YouTubePlayer } from '../components/YouTubePlayer'
import { PlaylistNavigator } from '../components/PlaylistNavigator'
import type { PlaylistInfo, PlaylistVideoRef, RecommendedPlaylist, YouTubeVideo } from '../types'
import {
  IconArrowLeft,
  IconArrowRight,
  IconBook,
  IconClock,
  IconFocus,
  IconSearch,
  IconShield,
  IconX,
} from '../components/Icons'

type Phase = 'idle' | 'loading' | 'done' | 'empty' | 'blocked' | 'error'

const EXAMPLE_TOPICS = [
  'Java Inheritance',
  'Python Loops',
  'Binary Search',
  'OS Scheduling',
  'DBMS Normalization',
  'Computer Networks',
  'Machine Learning',
  'Quantum Computing',
  'HTML Forms',
]

export default function VideoSearch() {
  const navigate = useNavigate()
  const { setCurrentTopic, setCurrentVideo, user } = useApp()

  const [query, setQuery] = useState('')
  const [searchedTopic, setSearchedTopic] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [videos, setVideos] = useState<YouTubeVideo[]>([])
  const [selected, setSelected] = useState<FocusVideo | null>(null)
  const [learning, setLearning] = useState<FocusVideo | null>(null)
  const [playlist, setPlaylist] = useState<PlaylistInfo | null>(null)
  const [recommended, setRecommended] = useState<RecommendedPlaylist | null>(null)

  const studentLevel = (user?.level ?? 'Beginner').toLowerCase()

  // Playlist info derived from the recommended playlist (API-confirmed only).
  const recommendedPlaylistInfo = useMemo<PlaylistInfo | null>(() => {
    if (!recommended) return null
    return {
      id: recommended.id,
      title: recommended.title,
      videoCount: recommended.totalVideos ?? recommended.videos.length,
      firstVideo: recommended.firstVideo
        ? { id: recommended.firstVideo.id, title: recommended.firstVideo.title }
        : { id: '', title: '' },
      videos: recommended.videos.map((v) => ({ id: v.id, title: v.title })),
    }
  }, [recommended])

  /** True when this video is a member of the API-confirmed recommended playlist. */
  function isRecommendedMember(video: YouTubeVideo): boolean {
    if (!recommended) return false
    return recommended.videos.some((v) => v.id === video.id)
  }

  const runSearch = useCallback(
    async (topic: string) => {
      const t = topic.trim()
      if (!t) return
      setCurrentTopic(t)
      setSearchedTopic(t)
      setSelected(null)
      setLearning(null)
      setPlaylist(null)
      setRecommended(null)
      setPhase('loading')
      try {
        const result = await searchYouTubeVideos(t)
        setVideos(result.videos)
        setRecommended(result.recommendedPlaylist ?? null)
        if (result.source === 'error') setPhase('error')
        else if (result.source === 'blocked') setPhase('blocked')
        else setPhase(result.videos.length === 0 ? 'empty' : 'done')
      } catch {
        setPhase('error')
      }
    },
    [],
  )

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const t = params.get('topic')
    if (t) {
      setQuery(t)
      void runSearch(t)
    }
  }, [runSearch])

  /**
   * When the video belongs to the recommended playlist, learning starts at
   * the playlist's first video; otherwise at the selected video itself.
   */
  function buildLearningVideo(video: YouTubeVideo): FocusVideo {
    const withTopic: FocusVideo = { ...video, topic: searchedTopic || video.title }
    if (!isRecommendedMember(video)) return withTopic
    const first = recommendedPlaylistInfo?.firstVideo
    if (!first?.id) return withTopic
    return {
      ...withTopic,
      id: first.id,
      title: first.title,
      description: '',
      url: `https://www.youtube.com/watch?v=${first.id}`,
    }
  }

  function openLearning(video: YouTubeVideo) {
    const source: FocusVideo = { ...video, topic: searchedTopic || video.title }
    const start = buildLearningVideo(video)
    setSelected(source)
    setLearning(start)
    setPlaylist(recommendedPlaylistInfo)
  }

  function handleLearnNow(video: YouTubeVideo) {
    const start = buildLearningVideo(video)
    setCurrentVideo(start)
    navigate(`/focus/topic/${encodeURIComponent(start.id)}`, {
      state: { video: start },
    })
  }

  function loadPlaylistRef(ref: PlaylistVideoRef) {
    if (!selected) return
    const next: FocusVideo = {
      ...selected,
      id: ref.id,
      title: ref.title,
      description: '',
      url: `https://www.youtube.com/watch?v=${ref.id}`,
      topic: searchedTopic || selected.title,
      playlist: selected.playlist ?? recommendedPlaylistInfo ?? undefined,
    }
    setLearning(next)
  }

  function handleSelectVideo(video: YouTubeVideo) {
    openLearning(video)
  }

  function openRecommended() {
    if (!recommended?.firstVideo) return
    const first = recommended.firstVideo
    const thumb =
      recommended.thumbnail || `https://i.ytimg.com/vi/${first.id}/hqdefault.jpg`
    const playlistInfo: PlaylistInfo = {
      id: recommended.id,
      title: recommended.title,
      videoCount: recommended.totalVideos ?? recommended.videos.length,
      firstVideo: { id: first.id, title: first.title },
      videos: recommended.videos.map((v) => ({ id: v.id, title: v.title })),
    }
    const focusVideo: FocusVideo = {
      id: first.id,
      title: first.title,
      channel: recommended.channel ?? '',
      thumbnail: thumb,
      description: '',
      url: `https://www.youtube.com/watch?v=${first.id}`,
      topic: searchedTopic || first.title,
      playlist: playlistInfo,
    }
    setSelected(focusVideo)
    setLearning(focusVideo)
    setPlaylist(playlistInfo)
  }

  return (
    <AppLayout>
      <div className="page">
        <div className="page-header">
          <span className="eyebrow">Learn Any Topic</span>
          <div className="row-between" style={{ width: '100%' }}>
            <h1>What do you want to learn?</h1>
            <span className="safesearch-badge" title="FocusLearn filters results for safe study">
              <IconShield size={14} aria-hidden="true" />
              SafeSearch ON
            </span>
          </div>
          <p>
            Search any educational topic — FocusLearn finds the best learning videos and turns them
            into a focused lesson with an AI tutor and quiz.
          </p>
        </div>

        <form
          className="video-search-bar card"
          onSubmit={(e) => {
            e.preventDefault()
            void runSearch(query)
          }}
        >
          <div className="video-search-field">
            <IconSearch size={18} className="search-icon" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="What do you want to learn?"
              aria-label="Search for a learning topic"
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={!query.trim()}>
            <IconSearch size={16} />
            Search
          </button>
        </form>

        <div className="row wrap" style={{ gap: '0.4rem' }}>
          {EXAMPLE_TOPICS.map((topic) => (
            <button
              key={topic}
              type="button"
              className="ask-chip"
              onClick={() => {
                setQuery(topic)
                void runSearch(topic)
              }}
            >
              {topic}
            </button>
          ))}
        </div>

        {phase === 'loading' && (
          <div className="video-loading-wrap" role="status" aria-live="polite">
            <div className="loading-state card">
              <span className="spinner" aria-hidden="true" />
              <span>Finding the best learning videos...</span>
            </div>
            {[0, 1, 2].map((i) => (
              <div key={i} className="video-result card skeleton-result" aria-hidden="true">
                <div className="skeleton skeleton-thumb shimmer" />
                <div className="video-result-body">
                  <div className="skeleton skeleton-line short shimmer" />
                  <div className="skeleton skeleton-line tiny shimmer" />
                  <div className="skeleton skeleton-line shimmer" />
                  <div className="skeleton snippet-line shimmer" />
                </div>
              </div>
            ))}
          </div>
        )}

        {phase === 'error' && (
          <div className="card empty-state" role="alert">
            <IconX size={32} />
            <p>Unable to search YouTube right now. Please try again.</p>
            <button className="btn btn-primary mt-2" onClick={() => void runSearch(query)}>
              Try Again
            </button>
          </div>
        )}

        {phase === 'empty' && (
          <div className="card empty-state" role="status">
            <IconShield size={32} />
            <p>No suitable learning videos were found for this search.</p>
            <p className="card-desc">Try searching for an educational topic related to your goal.</p>
            <button className="btn btn-primary mt-2" onClick={() => void runSearch(searchedTopic)}>
              Try Again
            </button>
          </div>
        )}

        {phase === 'blocked' && (
          <div className="card empty-state safesearch-blocked" role="status">
            <span className="safesearch-emblem" aria-hidden="true">🛡</span>
            <h3 className="card-title">SafeSearch</h3>
            <p>This search isn't suitable for FocusLearn.</p>
            <p className="card-desc">Try searching for an educational topic.</p>
            <button
              className="btn btn-primary mt-2"
              onClick={() => {
                setQuery('')
                setPhase('idle')
              }}
            >
              Search a Safe Topic
            </button>
          </div>
        )}

        {phase === 'done' && learning && selected && (
          <div className="ai-guide-split">
            <section className="focus-video-pane" aria-label="Selected video">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setSelected(null)
                  setLearning(null)
                  setPlaylist(null)
                }}
                aria-label="Back to all results"
              >
                <IconArrowLeft size={16} />
                Back to all results
              </button>
              <div className="video-frame mt-2">
                <div className="topic-embed">
                  <YouTubePlayer videoId={learning.id} title={learning.title} />
                </div>
              </div>
              <div className="video-meta">
                <span className="badge badge-focus">Topic: {searchedTopic}</span>
                <h1>{learning.title}</h1>
                <p>
                  {learning.channel}
                  {learning.duration ? ` · ${learning.duration}` : ''}
                </p>
                {selected.id !== learning.id && (
                  <div className="course-source-note" role="note">
                    Found via search: "{selected.title}" — starting you from the playlist's
                    first video for structured learning.
                  </div>
                )}
                {playlist && (
                  <PlaylistNavigator
                    playlist={playlist}
                    currentVideoId={learning.id}
                    onSelect={(ref) => loadPlaylistRef(ref)}
                    className="mt-2"
                  />
                )}
                <div className="row wrap mt-2" style={{ gap: '0.5rem' }}>
                  <button className="btn btn-primary" onClick={() => handleLearnNow(selected)}>
                    <IconFocus size={15} />
                    Continue in Focus Mode
                    <IconArrowRight size={15} />
                  </button>
                </div>
              </div>
            </section>

            <AiLearningGuide
              key={`${searchedTopic}::${learning.id}`}
              query={searchedTopic}
              video={learning}
              studentLevel={studentLevel}
            />
          </div>
        )}

        {phase === 'done' && !selected && (
          <>
            <div className="row-between wrap mt-2 mb-1">
              <h2 style={{ fontSize: '1.15rem' }}>
                {videos.length} video{videos.length === 1 ? '' : 's'} for "{searchedTopic}"
              </h2>
            </div>

            {!recommended && (
              <p className="small muted mb-2" role="note">
                No closely matching playlist was found.
              </p>
            )}

            {recommended && (
              <div className="rec-playlist-banner card">
                <div className="rec-playlist-thumb">
                  {recommended.thumbnail ? (
                    <img src={recommended.thumbnail} alt="" loading="lazy" />
                  ) : (
                    <span className="rec-playlist-icon" aria-hidden="true">
                      &#128218;
                    </span>
                  )}
                </div>
                <div className="rec-playlist-body">
                  <span className="rec-playlist-label small muted">
                    &#128218; Recommended Playlist
                  </span>
                  <h3 className="card-title">{recommended.title}</h3>
                  {recommended.channel && (
                    <div className="video-channel">{recommended.channel}</div>
                  )}
                  <div className="small muted" style={{ marginTop: '0.15rem' }}>
                    {(recommended.totalVideos ?? recommended.videos.length)} video
                    {(recommended.totalVideos ?? recommended.videos.length) === 1 ? '' : 's'}
                    {recommended.firstVideo && (
                      <>
                        {' · starts with "'}
                        <strong>{recommended.firstVideo.title}</strong>"
                      </>
                    )}
                  </div>
                </div>
                <button
                  className="btn btn-primary"
                  onClick={openRecommended}
                  disabled={!recommended.firstVideo}
                >
                  <IconFocus size={15} />
                  Start Learning
                </button>
              </div>
            )}

            <div className="video-results">
              {videos.map((video) => {
                const member = isRecommendedMember(video)
                return (
                  <article key={video.id} className="video-result card card-hover">
                    <div className="video-thumb">
                      <img src={video.thumbnail} alt="" loading="lazy" />
                      {video.duration && <span className="video-duration">{video.duration}</span>}
                    </div>
                    <div className="video-result-body">
                      <h3 className="card-title">{video.title}</h3>
                      <div className="video-channel">{video.channel}</div>
                      <p className="card-desc">{video.description}</p>
                      {member && recommendedPlaylistInfo && (
                        <div className="playlist-note">
                          <IconBook size={15} aria-hidden="true" />
                          <div>
                            <div className="playlist-note-title">
                              Part of: <strong>{recommendedPlaylistInfo.title}</strong>
                            </div>
                            <div className="small muted">
                              {recommendedPlaylistInfo.videoCount} videos · course sequence
                            </div>
                          </div>
                        </div>
                      )}
                      <div className="row-between mt-2">
                        <span className="row small muted">
                          <IconClock size={14} />
                          Educational · Safe for study
                        </span>
                        <button
                          className="btn btn-primary"
                          onClick={() => handleSelectVideo(video)}
                        >
                          <IconArrowRight size={15} />
                          {member ? 'Start Course' : 'Select Video'}
                        </button>
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          </>
        )}

        {phase === 'idle' && (
          <div className="card mt-2" style={{ display: 'flex', gap: '0.9rem', alignItems: 'center' }}>
            <span className="head-icon" style={{ width: 40, height: 40 }}>
              <IconShield size={20} />
            </span>
            <div>
              <h3 className="card-title">Distraction-free by design</h3>
              <p className="card-desc">
                Videos play inside FocusLearn — no YouTube homepage, Shorts, trending or comments.
                You get an AI summary, an AI tutor and a topic quiz instead.
              </p>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  )
}
