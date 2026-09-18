import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { Logo } from '../components/Logo'
import { YouTubePlayer } from '../components/YouTubePlayer'
import { useApp, type FocusVideo } from '../context/AppContext'
import {
  askTopicQuestion,
  getLearningGuide,
  recommendNextTopic,
  normalizeTopic,
  TUTOR_PRESETS,
  type AssistantMessage,
  type LearningGuide,
} from '../services/aiService'
import { getWeakAreas } from '../services/progress'
import { searchYouTubeVideos } from '../services/youtubeService'
import { PlaylistNavigator } from '../components/PlaylistNavigator'
import TopicQuizCard from '../components/TopicQuizCard'
import type { PlaylistInfo, PlaylistVideoRef, YouTubeVideo } from '../types'
import {
  IconArrowLeft,
  IconArrowRight,
  IconBook,
  IconCheck,
  IconFocus,
  IconPen,
  IconQuiz,
  IconSearch,
  IconShield,
  IconSparkles,
  IconTrend,
  IconX,
} from '../components/Icons'

const NOTES_KEY = 'focuslearn-focus-notes'

type SummaryPhase = 'loading' | 'ready' | 'error'
type SearchPhase = 'idle' | 'searching' | 'results' | 'selected' | 'empty' | 'blocked' | 'error'

const ASSISTANT_INTRO =
  'Hi! I\'m your FocusLearn AI tutor. Ask something about this topic, or tap a suggestion below.'

/** Shared header for the assistant panel sections. */
function AssistantCard({
  icon,
  title,
  badge,
  children,
}: {
  icon: ReactNode
  title: string
  badge?: string
  children: ReactNode
}) {
  return (
    <section className="assistant-card">
      <div className="assistant-card-head">
        <span className="head-icon">{icon}</span>
        <h2>{title}</h2>
        {badge && (
          <span className="badge badge-primary" style={{ marginLeft: 'auto' }}>
            {badge}
          </span>
        )}
      </div>
      {children}
    </section>
  )
}

/**
 * Focus Mode for a searched topic: distraction-free two-pane layout —
 * video on the left, AI Learning Assistant on the right. The central
 * currentTopic/currentVideo state (AppContext) drives every AI feature,
 * and the topic can be changed inline without leaving Focus Mode.
 */
export default function TopicFocus() {
  const navigate = useNavigate()
  const location = useLocation()
  const { videoId: _videoId } = useParams()
  const {
    blockedSites,
    currentTopic,
    currentVideo,
    currentVideoTitle,
    setCurrentTopic,
    setCurrentVideo,
    attempts,
    user,
    aiRoadmapTopics,
    activeGoal,
    totalFocusMinutes,
  } = useApp()

  // Central state is the source of truth; router state is a fallback
  // for a direct navigation carrying a freshly selected video.
  const video: FocusVideo | null =
    currentVideo ?? (location.state as { video?: FocusVideo } | null)?.video ?? null
  const topic = normalizeTopic(currentTopic ?? video?.topic ?? video?.title ?? '')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // The detected playlist attached to the current lesson (carried on the
  // video itself by the search page). Drives the learning sequence.
  const playlist: PlaylistInfo | null = video?.playlist ?? null

  // Inline topic search (Change Topic without leaving Focus Mode).
  const [query, setQuery] = useState('')
  const [searchPhase, setSearchPhase] = useState<SearchPhase>('idle')
  const [results, setResults] = useState<YouTubeVideo[]>([])
  // The exact query last sent to YouTube — kept separate from the selected
  // video so results are always tied back to what the student searched for.
  const [searchedQuery, setSearchedQuery] = useState('')

  // AI lesson lifecycle for the current topic/video.
  const [lesson, setLesson] = useState<LearningGuide | null>(null)
  const [summaryPhase, setSummaryPhase] = useState<SummaryPhase>('loading')

  // AI recommendation for the current topic (performance-aware).
  const [recommendation, setRecommendation] = useState<string | null>(null)

  // Ask the tutor state.
  const [messages, setMessages] = useState<AssistantMessage[]>([
    { role: 'assistant', text: ASSISTANT_INTRO },
  ])
  const [question, setQuestion] = useState('')
  const [thinking, setThinking] = useState(false)
  const messagesRef = useRef<HTMLDivElement>(null)

  // Notes, persisted locally on this device.
  const [notes, setNotes] = useState(() => {
    try {
      return localStorage.getItem(NOTES_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [notesSaved, setNotesSaved] = useState(false)

  // Assistant tabs (Summary / Key Points / Notes) + Ask AI affordance.
  const [tab, setTab] = useState<'summary' | 'keypoints' | 'notes'>('summary')
  const tutorRef = useRef<HTMLDivElement>(null)

  function askAi() {
    tutorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    window.setTimeout(() => {
      tutorRef.current?.querySelector('input')?.focus()
    }, 350)
  }

  /** Inline search: new topic → fresh results, previous video cleared. */
  async function runSearch(raw: string) {
    const t = raw.trim()
    if (!t) return
    setSearchPhase('searching')
    setResults([])
    setSearchedQuery(t)
    // A genuinely new topic resets the whole Focus Mode (video included);
    // re-searching the same topic only refreshes the result list.
    if (normalizeTopic(t) !== topic) {
      setCurrentTopic(t)
      setLesson(null)
    }
    try {
      const res = await searchYouTubeVideos(t)
      setResults(res.videos)
      // SafeSearch may block the query before it reaches YouTube, or filter
      // every result — handle those cases distinctly from a real failure.
      if (res.source === 'error') setSearchPhase('error')
      else if (res.source === 'blocked') setSearchPhase('blocked')
      else setSearchPhase(res.videos.length === 0 ? 'empty' : 'results')
    } catch {
      setSearchPhase('error')
    }
  }

  /** Selecting a result swaps the video and regenerates the lesson. */
  function handlePick(picked: YouTubeVideo) {
    const withTopic: FocusVideo = { ...picked, topic }
    setCurrentVideo(withTopic)
    // Keep the result list around — it powers "More videos about this
    // topic" below the selected video.
    setSearchPhase('selected')
    setQuery('')
  }

  /** Jump to another video of the detected playlist (prev/next or list). */
  function loadPlaylistVideo(ref: PlaylistVideoRef) {
    if (!video) return
    const next: FocusVideo = {
      ...video,
      id: ref.id,
      title: ref.title,
      description: '',
      url: `https://www.youtube.com/watch?v=${ref.id}`,
    }
    setCurrentVideo(next)
  }

  // Regenerate the AI summary whenever the topic or video changes.
  useEffect(() => {
    if (!video) return
    let cancelled = false
    setSummaryPhase('loading')
    setLesson(null)
    getLearningGuide({
      query: video.topic ?? topic ?? video.title,
      video_title: video.title,
      video_description: video.description ?? '',
      student_level: user.level.toLowerCase(),
    })
      .then((result) => {
        if (cancelled) return
        if (result.state === 'ready') {
          setLesson(result.guide)
          setSummaryPhase('ready')
        } else {
          setSummaryPhase('error')
        }
      })
      .catch(() => {
        if (!cancelled) setSummaryPhase('error')
      })
    return () => {
      cancelled = true
    }
  }, [video, topic, user.level])

  // AI recommendation: reset on topic change, then generate from real context.
  useEffect(() => {
    if (!topic) return
    let cancelled = false
    setRecommendation(null)
    const weakTopics = getWeakAreas(attempts).map((w) => w.topic)
    recommendNextTopic({
      roadmap_goal: activeGoal?.title ?? topic,
      roadmap_topics: aiRoadmapTopics.map((t) => ({
        name: t.name,
        status: t.status,
        lastScore: t.lastScore,
      })),
      completed_topics: aiRoadmapTopics
        .filter((t) => t.status === 'completed')
        .map((t) => t.name),
      quiz_history: attempts.map((a) => ({ topic: a.lessonId, score: a.percentage })),
      weak_topics: weakTopics,
      current_topic: topic,
    })
      .then((result) => {
        if (cancelled) return
        if (result.state === 'ready') {
          const { action, next_topic, reason } = result.recommendation
          setRecommendation(
            `${action.charAt(0).toUpperCase()}${action.slice(1)} next: ${next_topic} — ${reason}`,
          )
        }
      })
      .catch(() => {
        if (!cancelled) setRecommendation(null)
      })
    return () => {
      cancelled = true
    }
  }, [topic, attempts, activeGoal?.title, aiRoadmapTopics])

  // A topic or video change resets the tutor conversation — answers for a
  // previous topic/video must never survive into the new lesson.
  useEffect(() => {
    setMessages([{ role: 'assistant', text: ASSISTANT_INTRO }])
    setQuestion('')
  }, [topic, video?.id])

  // Keep the tutor thread scrolled to the latest message.
  useEffect(() => {
    const el = messagesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, thinking])

  async function sendQuestion(text: string) {
    const q = text.trim()
    if (!q || thinking) return
    setMessages((m) => [...m, { role: 'user', text: q }])
    setQuestion('')
    setThinking(true)
    try {
      const result = await askTopicQuestion({
        query: topic,
        question: q,
        video_title: video?.title,
        video_description: video?.description,
        student_level: user.level.toLowerCase(),
        history: messages,
      })
      if (result.state === 'ready') {
        setMessages((m) => [...m, { role: 'assistant', text: result.answer }])
      } else {
        setMessages((m) => [...m, { role: 'assistant', text: result.message }])
      }
    } catch {
      setMessages((m) => [
        ...m,
        { role: 'assistant', text: 'The AI tutor is unavailable right now — please try again.' },
      ])
    } finally {
      setThinking(false)
    }
  }

  function saveNotes() {
    try {
      localStorage.setItem(NOTES_KEY, notes)
    } catch {
      // Storage unavailable — notes still live for this session.
    }
    setNotesSaved(true)
    window.setTimeout(() => setNotesSaved(false), 1800)
  }

  const searching = searchPhase === 'searching'
  // Every returned result is displayed: the whole list is the primary grid
  // while the selected video is playing, and the same list (minus the
  // selected video) powers "More videos about this topic".
  const moreVideos = video ? results.filter((r) => r.id !== video.id) : []

  // Previous / next topic in the active AI roadmap (real learner position).
  const roadmapTopics = aiRoadmapTopics ?? []
  const topicIndex = roadmapTopics.findIndex((t) => normalizeTopic(t.name) === topic)
  const prevTopic = topicIndex > 0 ? roadmapTopics[topicIndex - 1] : null
  const nextTopic =
    topicIndex >= 0 && topicIndex < roadmapTopics.length - 1 ? roadmapTopics[topicIndex + 1] : null

  return (
    <div className="focus-shell">
      <header className="focus-header">
        <button className="btn btn-ghost" onClick={() => navigate('/search')}>
          <IconArrowLeft size={16} />
          Exit Focus
        </button>
        <Logo to="/dashboard" compact />
        <div style={{ minWidth: 0 }}>
          <div className="nowrap" style={{ fontWeight: 700, fontSize: '0.92rem' }}>
            {topic || 'Focus Mode'}
          </div>
          <div className="faint nowrap" style={{ fontSize: '0.75rem' }}>
            Focus Mode · single-topic session
          </div>
        </div>
        {topic && <UnderstandingBadge topic={topic} />}
        {topicIndex >= 0 && (
          <span className="focus-pos-chip">
            <IconBook size={13} />
            Topic {topicIndex + 1} of {roadmapTopics.length}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {video && (
          <button className="btn btn-secondary btn-sm" onClick={askAi}>
            <IconSparkles size={14} />
            Ask AI
          </button>
        )}
        <span className="focus-on-badge">
          <span className="focus-dot" aria-hidden="true" />
          Focus Mode ON
        </span>
        <span
          className="safesearch-badge"
          style={{ marginLeft: '0.5rem' }}
          title="FocusLearn filters results for safe study"
        >
          <IconShield size={14} aria-hidden="true" />
          SafeSearch ON
        </span>
      </header>

      {/* Inline topic search — change topic without leaving Focus Mode */}
      <div className="focus-topbar">
        <form
          className="focus-topic-search"
          onSubmit={(e) => {
            e.preventDefault()
            void runSearch(query)
          }}
        >
          <IconSearch size={16} className="focus-search-icon" />
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="What do you want to learn?"
            aria-label="What do you want to learn"
          />
          <button type="submit" className="btn btn-primary" disabled={!query.trim() || searching}>
            <IconSearch size={15} />
            Search
          </button>
        </form>
      </div>

      {searching && (
        <div className="focus-banner" role="status">
          <span className="spinner" aria-hidden="true" />
          Searching YouTube...
        </div>
      )}
      {searchPhase === 'error' && (
        <div className="focus-banner" role="alert">
          <IconX size={16} />
          Unable to search YouTube right now. Please try again.
          <button className="btn btn-secondary" onClick={() => void runSearch(query)}>
            Try Again
          </button>
        </div>
      )}
      {searchPhase === 'empty' && (
        <div className="focus-banner" role="status">
          <IconShield size={16} />
          🔒 No suitable learning videos were found for this search. Try an educational topic related to your goal.
          <button className="btn btn-secondary" onClick={() => void runSearch(searchedQuery)}>
            Try Again
          </button>
        </div>
      )}
      {searchPhase === 'blocked' && (
        <div className="focus-banner" role="status">
          <span aria-hidden="true">🛡</span>
          <div>
            <strong>SafeSearch</strong>
            <div>This search isn't suitable for FocusLearn. Try searching for an educational topic.</div>
          </div>
          <button className="btn btn-secondary" onClick={() => void runSearch(query)}>
            Try Again
          </button>
        </div>
      )}

      {/* Fresh search results — pick one to (re)load the whole lesson */}
      {searchPhase === 'results' && results.length > 0 && (
        <div className="focus-results-strip">
          <div className="focus-results-head">
            <strong>
              {results.length} learning videos for “{searchedQuery || query || topic}”
            </strong>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ marginLeft: 'auto', padding: '0.3rem 0.6rem' }}
              onClick={() => setSearchPhase('idle')}
              aria-label="Hide results"
            >
              <IconX size={15} />
            </button>
          </div>
          <div className="focus-results-grid">
            {results.map((r) => (
              <article key={r.id} className="focus-result-mini">
                <div className="focus-mini-thumb">
                  <img src={r.thumbnail} alt="" loading="lazy" />
                  {r.duration && <span className="video-duration">{r.duration}</span>}
                </div>
                <div className="focus-mini-body">
                  <div className="focus-mini-title">{r.title}</div>
                  <div className="faint" style={{ fontSize: '0.75rem' }}>
                    {r.channel}
                  </div>
                  {r.description && <div className="focus-mini-desc">{r.description}</div>}
                  <button className="btn btn-primary focus-mini-btn" onClick={() => handlePick(r)}>
                    <IconFocus size={14} />
                    Start Learning
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}

      {/* No video yet — prompt to search */}
      {!video ? (
        <div className="focus-split">
          <div className="card empty-state" style={{ gridColumn: '1 / -1' }}>
            <IconFocus size={36} />
            <h2 style={{ fontSize: '1.2rem', marginBottom: '0.4rem' }}>
              {topic ? `Ready to learn ${topic}` : 'No lesson selected'}
            </h2>
            <p className="muted small mb-2">
              {topic
                ? 'Search above to find learning videos for this topic.'
                : 'Search a topic above to start a focused lesson.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="focus-split">
          {/* LEFT — selected video */}
          <section className="focus-video-pane" aria-label="Video lesson">
            <div className="video-frame">
              <div className="topic-embed">
                <YouTubePlayer videoId={video.id} title={video.title} />
              </div>
            </div>
            <div className="video-meta">
              <span className="badge badge-focus">Topic: {topic}</span>
              <h1>{video.title}</h1>
              <p>
                {video.channel}
                {video.duration ? ` · ${video.duration}` : ''}
              </p>
              <div className="no-distractions">
                <IconShield size={15} />
                No homepage · no Shorts · no comments · no recommendations
              </div>
              {playlist && (
                <PlaylistNavigator
                  playlist={playlist}
                  currentVideoId={video.id}
                  onSelect={(ref) => loadPlaylistVideo(ref)}
                  className="mt-2"
                />
              )}
            </div>
          </section>

          {/* RIGHT — AI Learning Assistant, always bound to currentTopic */}
          <aside className="focus-side" aria-label="AI learning assistant">
            {/* Focus Mode panel — communicates the distraction-free USP */}
            <section className="focus-panel">
              <div className="focus-panel-head">
                <span className="focus-panel-icon">
                  <IconShield size={17} />
                </span>
                <div>
                  <h2>Focus Mode</h2>
                  <p className="small muted">Distraction-free learning</p>
                </div>
              </div>
              <ul className="focus-panel-list">
                <li><IconCheck size={14} /> Only relevant content</li>
                <li><IconCheck size={14} /> No unnecessary recommendations</li>
                <li><IconCheck size={14} /> No distracting content</li>
                <li><IconCheck size={14} /> Just focused learning</li>
              </ul>
            </section>

            {summaryPhase === 'loading' && (
              <div className="assistant-card side-loading" role="status">
                <span className="spinner" aria-hidden="true" />
                <div>
                  <strong>Preparing your personalized lesson...</strong>
                  <div className="small muted mt-1">AI is preparing your summary...</div>
                </div>
              </div>
            )}

            {summaryPhase === 'error' && (
              <div className="assistant-card side-loading" role="alert">
                <IconX size={18} />
                <div>
                  <strong>Summary temporarily unavailable.</strong>
                  <div className="small muted mt-1">
                    Search the topic again or pick another video.
                  </div>
                </div>
              </div>
            )}

            {summaryPhase === 'ready' && lesson && (
              <div className="focus-tabs-wrap">
                <div className="focus-tabs" role="tablist" aria-label="Lesson sections">
                  {([
                    ['summary', 'Summary'],
                    ['keypoints', 'Key Points'],
                    ['notes', 'Notes'],
                  ] as const).map(([id, label]) => (
                    <button
                      key={id}
                      role="tab"
                      aria-selected={tab === id}
                      className={`focus-tab${tab === id ? ' active' : ''}`}
                      onClick={() => setTab(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {tab === 'summary' && (
                  <div className="focus-tab-panel" role="tabpanel">
                    {/* 1. AI Summary */}
                    <AssistantCard
                      icon={<IconSparkles size={14} />}
                      title="AI Summary"
                      badge={currentVideoTitle ? 'For this video' : 'Auto-generated'}
                    >
                      <p>{lesson.overview}</p>
                    </AssistantCard>

                    {/* 2. Important Concepts */}
                    <AssistantCard icon={<IconSparkles size={14} />} title="Important Concepts">
                      <div className="concept-chips">
                        {lesson.key_concepts.map((concept) => (
                          <span key={concept} className="concept-chip">
                            {concept}
                          </span>
                        ))}
                      </div>
                    </AssistantCard>

                    {/* 3. Learning Guide — what you'll learn (real guide data) */}
                    <AssistantCard
                      icon={<IconBook size={14} />}
                      title="Learning Guide"
                      badge="What you'll learn"
                    >
                      {lesson.simple_explanation && (
                        <div className="guide-block">
                          <span className="guide-label">Simple explanation</span>
                          <p className="small">{lesson.simple_explanation}</p>
                        </div>
                      )}
                      {lesson.prerequisites.length > 0 && (
                        <div className="guide-block">
                          <span className="guide-label">Prerequisites</span>
                          <div className="tag-wrap">
                            {lesson.prerequisites.map((p) => (
                              <span key={p} className="badge badge-muted">{p}</span>
                            ))}
                          </div>
                        </div>
                      )}
                      {lesson.example && (
                        <div className="guide-block">
                          <span className="guide-label">Example</span>
                          <p className="small">{lesson.example}</p>
                        </div>
                      )}
                      {lesson.common_mistakes.length > 0 && (
                        <div className="guide-block">
                          <span className="guide-label">Common mistakes</span>
                          <ul className="keypoint-list mistake-list">
                            {lesson.common_mistakes.map((m) => (
                              <li key={m}>
                                <IconX size={14} />
                                <span>{m}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </AssistantCard>
                  </div>
                )}

                {tab === 'keypoints' && (
                  <div className="focus-tab-panel" role="tabpanel">
                    {/* Key Points */}
                    <AssistantCard icon={<IconCheck size={14} />} title="Key Points">
                      <ul className="keypoint-list">
                        {lesson.what_to_learn.map((point) => (
                          <li key={point}>
                            <IconCheck size={14} />
                            <span>{point}</span>
                          </li>
                        ))}
                      </ul>
                    </AssistantCard>

                    {/* What to learn next */}
                    <AssistantCard icon={<IconTrend size={14} />} title="What to learn next">
                      <ul className="keypoint-list terms-list">
                        {lesson.what_to_learn_next.map((term) => (
                          <li key={term}>
                            <IconTrend size={14} />
                            <span>{term}</span>
                          </li>
                        ))}
                      </ul>
                    </AssistantCard>

                    {/* Quick check — real guide data */}
                    {lesson.quick_check.length > 0 && (
                      <AssistantCard icon={<IconQuiz size={14} />} title="Quick Check">
                        <ul className="keypoint-list quick-check-list">
                          {lesson.quick_check.map((q) => (
                            <li key={q.question}>
                              <IconQuiz size={14} />
                              <span>
                                <strong>{q.question}</strong>
                                <span className="small muted" style={{ display: 'block' }}>
                                  {q.answer}
                                </span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </AssistantCard>
                    )}
                  </div>
                )}

                {tab === 'notes' && (
                  <div className="focus-tab-panel" role="tabpanel">
                    <AssistantCard
                      icon={<IconPen size={14} />}
                      title="Notes"
                      badge={notesSaved ? 'Saved ✓' : undefined}
                    >
                      <textarea
                        className="notes-textarea"
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder={`Write your own notes about ${topic}...`}
                        aria-label="Personal notes"
                      />
                      <div className="row-between mt-1">
                        <span className="small faint">Notes stay on this device.</span>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={saveNotes}>
                          Save Notes
                        </button>
                      </div>
                    </AssistantCard>
                  </div>
                )}
              </div>
            )}

            {/* 5. FocusLearn AI Tutor — context is always currentTopic */}
            <div ref={tutorRef} className="focus-tutor-anchor">
            <AssistantCard icon={<IconSparkles size={14} />} title="FocusLearn AI Tutor" badge={topic}>
              <div className="ask-messages" ref={messagesRef}>
                {messages.map((msg, i) => (
                  <div key={i} className={`ask-msg ${msg.role}`}>
                    <div className="ask-bubble">{msg.text}</div>
                  </div>
                ))}
                {thinking && (
                  <div className="ask-msg assistant">
                    <div className="ask-bubble">
                      <span className="small muted">AI Tutor is thinking...</span>
                      <span className="thinking" role="status" aria-label="AI Tutor is thinking">
                        <span />
                        <span />
                        <span />
                      </span>
                    </div>
                  </div>
                )}
              </div>
              <div className="ask-chips">
                {TUTOR_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className="ask-chip"
                    disabled={thinking}
                    onClick={() => void sendQuestion(preset.label)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <form
                className="ask-input-row"
                onSubmit={(e) => {
                  e.preventDefault()
                  void sendQuestion(question)
                }}
              >
                <input
                  type="text"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Ask something about this topic..."
                  aria-label="Ask something about this topic"
                />
                <button
                  type="submit"
                  className="ask-send"
                  disabled={thinking || question.trim() === ''}
                  aria-label="Send question"
                >
                  →
                </button>
              </form>
            </AssistantCard>
            </div>

            {/* 7. Recommendation + Quiz — always for currentTopic */}
            {recommendation && (
              <div className="recommendation-card" role="note">
                <IconSparkles size={15} />
                <span>{recommendation}</span>
              </div>
            )}
            <AssistantCard icon={<IconQuiz size={14} />} title="Topic Progress">
              <div className="progress-row">
                <div className="row-label">
                  <span className="muted">Understanding</span>
                  <UnderstandingBadge topic={topic} />
                </div>
              </div>
              <div className="progress-row">
                <div className="row-label">
                  <span className="muted">Focus minutes</span>
                  <strong>{totalFocusMinutes}</strong>
                </div>
              </div>
              <TopicQuizCard topic={topic} />
            </AssistantCard>
          </aside>

          {/* More videos about this topic — swap videos without reloading */}
          {moreVideos.length > 0 && (
            <section className="more-videos-section" aria-label="More videos about this topic">
              <div className="more-videos-head">
                <h3>More videos about this topic</h3>
              </div>
              <div className="more-videos-grid">
                {moreVideos.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="more-video-card"
                    onClick={() => handlePick(r)}
                    aria-label={`Start learning from ${r.title}`}
                  >
                    <div className="more-video-thumb">
                      <img src={r.thumbnail} alt="" loading="lazy" />
                      {r.duration && <span className="video-duration">{r.duration}</span>}
                    </div>
                    <div className="more-video-body">
                      <div className="more-video-title">{r.title}</div>
                      <div className="faint" style={{ fontSize: '0.75rem' }}>
                        {r.channel}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {video && (prevTopic || nextTopic) && (
        <nav className="focus-topic-nav" aria-label="Topic navigation">
          <button
            className="btn btn-secondary"
            disabled={!prevTopic}
            onClick={() => prevTopic && void runSearch(prevTopic.name)}
          >
            <IconArrowLeft size={15} />
            Previous
          </button>
          <button
            className="btn btn-primary"
            disabled={!nextTopic}
            onClick={() => nextTopic && void runSearch(nextTopic.name)}
          >
            Next Topic
            <IconArrowRight size={15} />
          </button>
        </nav>
      )}

      <footer className="focus-footer">
        <div className="row wrap" style={{ gap: '0.4rem' }}>
          <IconShield size={17} style={{ color: 'var(--focus)' }} />
          <span className="small muted">Distraction shield active:</span>
          {blockedSites.slice(0, 4).map((site) => (
            <span key={site} className="badge badge-focus">
              <span className="strike">{site}</span>
            </span>
          ))}
          {blockedSites.length > 4 && (
            <span className="small faint">+{blockedSites.length - 4} more</span>
          )}
        </div>
        <span className="small faint">
          The student stays inside FocusLearn — YouTube plays here, nothing else loads.
        </span>
      </footer>
    </div>
  )
}

/** Badge showing quiz understanding for the current topic, if attempted. */
function UnderstandingBadge({ topic }: { topic: string }) {
  const { attempts } = useApp()
  const lessonId = generateQuizSyncLessonId(topic)
  const attempt = [...attempts].reverse().find((a) => a.lessonId === lessonId)
  if (!attempt) return <span className="badge badge-warning">Not tested</span>
  return (
    <span className={`badge ${attempt.percentage >= 80 ? 'badge-success' : 'badge-warning'}`}>
      Last score: {attempt.percentage}%
    </span>
  )
}

/**
 * The quiz lessonId for a topic — must mirror getTopicQuiz()'s id scheme
 * (topic-<slug>) so attempts can be matched back to the topic.
 */
function generateQuizSyncLessonId(topic: string): string {
  return `topic-${topic.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\s/g, '-')}`
}
