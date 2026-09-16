import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  askTopicQuestion,
  getLearningGuide,
  type AssistantMessage,
  type LearningGuide,
} from '../services/aiService'
import {
  IconArrowRight,
  IconBook,
  IconCheck,
  IconCode,
  IconLock,
  IconQuiz,
  IconSend,
  IconSparkles,
  IconTarget,
  IconX,
  IconZap,
} from './Icons'

type GuidePhase = 'loading' | 'ready' | 'error'

/** Card shell shared by every section of the AI Learning Guide. */
function GuideSection({
  icon,
  title,
  children,
}: {
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <section className="guide-section">
      <div className="guide-section-head">
        <span className="head-icon">{icon}</span>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  )
}

function ListItems({ items }: { items: string[] }) {
  if (!items.length) return null
  return (
    <ul className="keypoint-list">
      {items.map((item) => (
        <li key={item}>
          <IconCheck size={14} />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * AI Learning Guide panel for the Learn Any Topic page.
 *
 * Calls the Groq-powered backend (POST /api/ai/learning-guide) for the
 * selected video + the student's exact search query, then renders the
 * structured guide beside the player. Loads and errors are self-contained
 * so the video and rest of the page keep working regardless of the outcome.
 */
export function AiLearningGuide({
  query,
  video,
  studentLevel,
}: {
  query: string
  video: { id: string; title: string; description?: string }
  studentLevel: string
}) {
  const [phase, setPhase] = useState<GuidePhase>('loading')
  const [guide, setGuide] = useState<LearningGuide | null>(null)
  const [error, setError] = useState('')
  const requestKey = `${query}::${video.id}`
  const mounted = useRef(false)

  // Topic-scoped Q&A — only questions about this topic get answered.
  const [messages, setMessages] = useState<AssistantMessage[]>([
    { role: 'assistant', text: 'Ask me anything about this topic. I only answer questions about it.' },
  ])
  const [question, setQuestion] = useState('')
  const [thinking, setThinking] = useState(false)
  const messagesRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    setPhase('loading')
    setGuide(null)
    setError('')
    // A new topic/video resets the Q&A conversation too.
    setMessages([
      { role: 'assistant', text: 'Ask me anything about this topic. I only answer questions about it.' },
    ])
    setQuestion('')
    setThinking(false)
    getLearningGuide({
      query,
      video_title: video.title,
      video_description: video.description || '',
      student_level: studentLevel,
    }).then((result) => {
      if (cancelled || !mounted.current) return
      if (result.state === 'ready') {
        setGuide(result.guide)
        setPhase('ready')
      } else {
        setError(result.message)
        setPhase('error')
      }
    })
    return () => {
      cancelled = true
    }
    // Re-run only when a different video/topic pair is selected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey])

  // Keep the Q&A thread scrolled to the latest message.
  useEffect(() => {
    const el = messagesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, thinking])

  async function sendQuestion(text: string, heading = '') {
    const q = text.trim()
    if (!q || thinking) return
    const topic = guide?.topic || query
    setMessages((m) => [...m, { role: 'user', text: heading ? `${heading}: ${q}` : q }])
    setQuestion('')
    setThinking(true)
    const result = await askTopicQuestion({
      query: topic,
      question: q,
      video_title: video.title,
      video_description: video.description || '',
      student_level: studentLevel,
      history: messages,
    })
    setMessages((m) => [
      ...m,
      result.state === 'ready'
        ? { role: 'assistant', text: result.answer }
        : { role: 'assistant', text: result.message },
    ])
    setThinking(false)
  }

  const ASK_SUGGESTIONS = [
    'Explain the most important idea once more',
    'Give me a step-by-step example',
    'What is the most common mistake?',
  ]

  if (phase === 'loading') {
    return (
      <div className="guide-card side-loading" role="status">
        <span className="spinner" aria-hidden="true" />
        <div>
          <strong>AI is preparing your learning guide...</strong>
          <div className="small muted mt-1">Personalizing this topic for you.</div>
        </div>
      </div>
    )
  }

  if (phase === 'error' || !guide) {
    return (
      <div className="guide-card guide-error" role="alert">
        <IconX size={18} />
        <div>
          <strong>The AI learning guide is unavailable right now.</strong>
          <div className="small muted mt-1">{error}</div>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ marginLeft: 'auto' }}
          onClick={() => {
            setPhase('loading')
            setGuide(null)
            setError('')
            void getLearningGuide({
              query,
              video_title: video.title,
              video_description: video.description || '',
              student_level: studentLevel,
            }).then((result) => {
              if (result.state === 'ready') {
                setGuide(result.guide)
                setPhase('ready')
              } else {
                setError(result.message)
                setPhase('error')
              }
            })
          }}
        >
          Try Again
        </button>
      </div>
    )
  }

  return (
    <div className="guide-panel" aria-label="AI learning guide">
      <div className="guide-header">
        <span className="head-icon guide-spark">
          <IconSparkles size={15} />
        </span>
        <div>
          <h2>AI Learning Guide</h2>
          <div className="small muted">{guide.topic || query}</div>
        </div>
        <span className="badge badge-focus" style={{ marginLeft: 'auto' }}>
          {studentLevel || 'beginner'}
        </span>
      </div>

      <GuideSection icon={<IconBook size={14} />} title="Overview">
        <p className="guide-prose">{guide.overview}</p>
      </GuideSection>

      {guide.what_to_learn.length > 0 && (
        <GuideSection icon={<IconTarget size={14} />} title="What to Learn">
          <ListItems items={guide.what_to_learn} />
        </GuideSection>
      )}

      {guide.key_concepts.length > 0 && (
        <GuideSection icon={<IconZap size={14} />} title="Key Concepts">
          <div className="concept-chips">
            {guide.key_concepts.map((concept) => (
              <span key={concept} className="concept-chip">
                {concept}
              </span>
            ))}
          </div>
        </GuideSection>
      )}

      {guide.simple_explanation && (
        <GuideSection icon={<IconSparkles size={14} />} title="Simple Explanation">
          <p className="guide-prose">{guide.simple_explanation}</p>
        </GuideSection>
      )}

      {guide.example && (
        <GuideSection icon={<IconCode size={14} />} title="Example">
          <pre className="guide-code">{guide.example}</pre>
        </GuideSection>
      )}

      {guide.common_mistakes.length > 0 && (
        <GuideSection icon={<IconX size={14} />} title="Common Mistakes">
          <ListItems items={guide.common_mistakes} />
        </GuideSection>
      )}

      {guide.prerequisites.length > 0 && (
        <GuideSection icon={<IconLock size={14} />} title="Prerequisites">
          <ListItems items={guide.prerequisites} />
        </GuideSection>
      )}

      {guide.quick_check.length > 0 && (
        <GuideSection icon={<IconQuiz size={14} />} title="Quick Check">
          <ol className="guide-quickcheck">
            {guide.quick_check.map((qc, i) => (
              <li key={`${qc.question}-${i}`}>
                <strong>{qc.question}</strong>
                <div className="small muted mt-1">Answer: {qc.answer}</div>
              </li>
            ))}
          </ol>
        </GuideSection>
      )}

      {guide.what_to_learn_next.length > 0 && (
        <GuideSection icon={<IconArrowRight size={14} />} title="Learn Next">
          <ListItems items={guide.what_to_learn_next} />
        </GuideSection>
      )}

      {/* Topic-scoped Q&A — the backend only answers on-topic questions */}
      <GuideSection icon={<IconSend size={14} />} title="Ask About This Topic">
        <div className="small muted mb-1">
          I only answer questions about “{guide.topic || query}” — anything else I
          can’t help with.
        </div>
        <div className="ask-messages" ref={messagesRef}>
          {messages.map((msg, i) => (
            <div key={i} className={`ask-msg ${msg.role}`}>
              <div className="ask-bubble">{msg.text}</div>
            </div>
          ))}
          {thinking && (
            <div className="ask-msg assistant">
              <div className="ask-bubble">
                <span className="small muted">AI tutor is thinking...</span>
                <span className="thinking" role="status" aria-label="AI tutor is thinking">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="ask-chips">
          {ASK_SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className="ask-chip"
              disabled={thinking}
              onClick={() => void sendQuestion(s)}
            >
              {s}
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
            placeholder={`Ask about ${guide.topic || query}...`}
            aria-label="Ask a question about this topic"
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
      </GuideSection>
    </div>
  )
}