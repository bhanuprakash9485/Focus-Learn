import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getQuizStatus, prepareQuiz, TopicQuizError } from '../services/topicQuiz'
import type { TopicQuizStatus } from '../types'
import { IconCheck, IconLock, IconQuiz, IconSparkles } from './Icons'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms))
}

/**
 * Compact quiz status card that lives inside TopicFocus's sidebar.
 * It always fires background preparation on mount/topic change and
 * polls until the quiz is READY or FAILED — never blocking the
 * learning page.
 */
export default function TopicQuizCard({ topic }: { topic: string }) {
  const navigate = useNavigate()
  const [status, setStatus] = useState<TopicQuizStatus | null>(null)
  const [error, setError] = useState('')
  const [preparing, setPreparing] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    if (!topic) return
    mountedRef.current = true
    setPreparing(true)
    setError('')
    setStatus(null)

    ;(async () => {
      const quiet = (err: unknown) =>
        err instanceof TopicQuizError && (err.status === 401 || err.status === 0)
      try {
        await prepareQuiz({ topic, level: 'beginner' })
        if (!mountedRef.current) return

        // Poll until ready/failed.
        for (let i = 0; i < 150; i++) {
          if (!mountedRef.current) return
          try {
            const st = await getQuizStatus(topic)
            if (!mountedRef.current) return
            setStatus(st)
            if (st.state === 'ready' || st.state === 'failed') {
              setPreparing(false)
              return
            }
          } catch (err) {
            if (!mountedRef.current) return
            if (quiet(err)) {
              setPreparing(false)
              return
            }
            if (err instanceof TopicQuizError && err.blocked) {
              setError(err.message)
              setPreparing(false)
              return
            }
          }
          await sleep(2500)
        }
        setPreparing(false)
      } catch (err) {
        if (!mountedRef.current) return
        if (quiet(err)) {
          setPreparing(false)
          return
        }
        setError(err instanceof TopicQuizError ? err.message : 'Could not prepare quiz.')
        setPreparing(false)
      }
    })()

    return () => {
      mountedRef.current = false
    }
  }, [topic])

  function openQuiz(retest = false) {
    navigate(`/quiz/topic/${encodeURIComponent(topic)}`, {
      state: { topic, ...(retest ? { retest: true } : {}) },
    })
  }

  /* ── Rendering ──────────────────────────────────────────────────── */

  if (preparing && (!status || status.state === 'generating' || status.state === 'none')) {
    return (
      <div className="topic-quiz-card topic-quiz-card--preparing">
        <div className="row" style={{ gap: '0.6rem', alignItems: 'center' }}>
          <span className="spinner" style={{ width: 16, height: 16 }} />
          <span className="small muted">Preparing your quiz…</span>
        </div>
        <p className="faint" style={{ fontSize: '0.78rem', marginTop: '0.3rem' }}>
          30 Questions · 10 Basic · 10 Moderate · 10 Advanced
        </p>
      </div>
    )
  }

  if (status && status.state === 'failed') {
    return (
      <div className="topic-quiz-card topic-quiz-card--error">
        <span className="small" style={{ fontWeight: 600, color: 'var(--error)' }}>
          Quiz temporarily unavailable
        </span>
        <p className="faint" style={{ fontSize: '0.78rem' }}>
          {status.error || 'The AI quiz service could not prepare this quiz yet. Please try again shortly.'}
        </p>
        <button
          className="btn btn-secondary btn-sm mt-1"
          onClick={() => openQuiz(false)}
        >
          Try Again
        </button>
      </div>
    )
  }

  if (error) {
    return (
      <div className="topic-quiz-card topic-quiz-card--error">
        <span className="small" style={{ fontWeight: 600, color: 'var(--error)' }}>
          {error}
        </span>
      </div>
    )
  }

  // Status is READY or we have enough data to show buttons.
  if (status) {
    const completed = status.completed
    const totalAnswered = Object.keys(status.answers).length
    const correctCount = status.answers.filter((a) => a.is_correct).length
    const percent = status.total > 0 ? Math.round((correctCount / status.total) * 100) : 0
    const hasAttempts = totalAnswered > 0
    const retestReady = status.retest_ready

    return (
      <div className="topic-quiz-card">
        {completed && hasAttempts && (
          <div className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
            <span className="badge badge-success" style={{ fontSize: '0.78rem' }}>
              Last score: {percent}%
            </span>
            {percent < 80 && (
              <span className="badge badge-warning" style={{ fontSize: '0.78rem' }}>Needs practice</span>
            )}
          </div>
        )}
        <div className="quiz-unlock-progress" style={{ marginTop: completed ? '0.4rem' : 0 }}>
          {(['basic', 'moderate', 'advanced'] as const).map((d) => (
            <span key={d} className={`quiz-tier-pill ${status.unlocked[d] ? 'unlocked' : 'locked'}`}>
              {status.unlocked[d] ? <IconCheck size={12} /> : <IconLock size={12} />}
              {d === 'basic' && 'Basic'}
              {d === 'moderate' && 'Moderate'}
              {d === 'advanced' && 'Advanced'}
            </span>
          ))}
        </div>
        <div className="row" style={{ gap: '0.4rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm" onClick={() => openQuiz(false)}>
            <IconQuiz size={15} />
            {hasAttempts ? 'Resume Quiz' : 'Take Quiz'}
          </button>
          {completed && (
            <button className="btn btn-ghost btn-sm" onClick={() => openQuiz(false)}>
              Review Results
            </button>
          )}
          {retestReady && (
            <button className="btn btn-secondary btn-sm" onClick={() => openQuiz(true)}>
              <IconSparkles size={14} />
              Take Retest
            </button>
          )}
        </div>
        <p className="faint" style={{ fontSize: '0.78rem', marginTop: '0.4rem' }}>
          Answer 3 Basic → Moderate, 3 Moderate → Advanced.
        </p>
      </div>
    )
  }

  return null
}