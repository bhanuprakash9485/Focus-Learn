import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { Logo } from '../components/Logo'
import { useApp } from '../context/AppContext'
import { getNextLesson, quizExistsForLesson } from '../services/progress'
import {
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconClock,
  IconEye,
  IconPlay,
  IconQuiz,
  IconShield,
  IconTarget,
} from '../components/Icons'

/**
 * Renders lesson content. Supports a small subset of markdown:
 * ## headings, > quotes, - lists, `code`, **bold**, *italic*.
 * Kept simple intentionally; rich rendering can be swapped later.
 */
function LessonReader({ content }: { content: string }) {
  const lines = content.split('\n')

  function renderInline(text: string, keyPrefix: string) {
    const tokens = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g)
    return tokens.map((tok, i) => {
      if (tok.startsWith('**') && tok.endsWith('**')) {
        return <strong key={`${keyPrefix}-${i}`}>{tok.slice(2, -2)}</strong>
      }
      if (tok.startsWith('`') && tok.endsWith('`')) {
        return (
          <code
            key={`${keyPrefix}-${i}`}
            style={{
              background: 'var(--surface-2)',
              borderRadius: 5,
              padding: '0.1rem 0.35rem',
              fontSize: '0.9em',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            {tok.slice(1, -1)}
          </code>
        )
      }
      if (tok.startsWith('*') && tok.endsWith('*') && tok.length > 2) {
        return <em key={`${keyPrefix}-${i}`}>{tok.slice(1, -1)}</em>
      }
      return tok
    })
  }

  const blocks: React.ReactNode[] = []
  let listItems: React.ReactNode[] = []

  function flushList() {
    if (listItems.length > 0) {
      blocks.push(<ul key={`ul-${blocks.length}`}>{listItems}</ul>)
      listItems = []
    }
  }

  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('- ')) {
      listItems.push(<li key={`li-${i}`}>{renderInline(trimmed.slice(2), `li-${i}`)}</li>)
      return
    }
    flushList()
    if (trimmed.startsWith('## ')) {
      blocks.push(<h2 key={i}>{renderInline(trimmed.slice(3), `h2-${i}`)}</h2>)
    } else if (trimmed.startsWith('> ')) {
      blocks.push(
        <blockquote
          key={i}
          style={{
            borderLeft: '3px solid var(--primary)',
            margin: '0.8rem 0',
            padding: '0.4rem 0 0.4rem 1rem',
            color: 'var(--muted)',
          }}
        >
          {renderInline(trimmed.slice(2), `bq-${i}`)}
        </blockquote>,
      )
    } else if (trimmed === '') {
      // paragraph separator
    } else {
      blocks.push(<p key={i}>{renderInline(trimmed, `p-${i}`)}</p>)
    }
  })
  flushList()

  return <>{blocks}</>
}

/**
 * Original roadmap Focus Mode: a calm, distraction-free reader for the
 * curriculum lessons with a session timer and completion tracking.
 */
export function FocusLessonMode() {
  const { lessonId } = useParams()
  const navigate = useNavigate()
  const {
    roadmap,
    activeGoal,
    completedLessonIds,
    markLessonComplete,
    logFocusSession,
    blockedSites,
  } = useApp()

  const [secondsLeft, setSecondsLeft] = useState(0)
  const [running, setRunning] = useState(false)
  const [justCompleted, setJustCompleted] = useState(false)

  // Locate the lesson across the roadmap.
  const located = useMemo(() => {
    if (!roadmap) return null
    for (const step of roadmap.steps) {
      const lesson = step.lessons.find((l) => l.id === lessonId)
      if (lesson) return { step, lesson }
    }
    return null
  }, [roadmap, lessonId])

  const lessonKey = located?.lesson.id

  useEffect(() => {
    if (located) {
      setSecondsLeft(located.lesson.minutes * 60)
      setRunning(false)
      setJustCompleted(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonKey])

  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1))
    }, 1000)
    return () => window.clearInterval(id)
  }, [running])

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0')
  const ss = String(secondsLeft % 60).padStart(2, '0')

  if (!activeGoal || !roadmap) {
    return (
      <AppLayout>
        <div className="page">
          <div className="card empty-state">
            <IconTarget size={36} />
            <h2 style={{ fontSize: '1.2rem', marginBottom: '0.4rem' }}>Pick a lesson first</h2>
            <p className="muted small mb-2">Choose a goal to unlock your focus sessions.</p>
            <Link to="/goals" className="btn btn-primary">Choose Your Goal</Link>
          </div>
        </div>
      </AppLayout>
    )
  }

  if (!located) {
    // No (or unknown) lesson id: fall back to the next lesson in the roadmap.
    const fallback = getNextLesson(roadmap, completedLessonIds)
    if (fallback) {
      return (
        <AppLayout>
          <div className="page">
            <div className="card empty-state">
              <IconTarget size={36} />
              <h2 style={{ fontSize: '1.2rem', marginBottom: '0.4rem' }}>Lesson not found</h2>
              <p className="muted small mb-2">Jump into your next lesson instead:</p>
              <button
                className="btn btn-primary"
                onClick={() => navigate(`/focus/${fallback.lesson.id}`)}
              >
                Start: {fallback.lesson.title}
              </button>
            </div>
          </div>
        </AppLayout>
      )
    }
  }

  if (!located) return null

  const hasQuiz = quizExistsForLesson(located.lesson.id)
  const alreadyDone = completedLessonIds.includes(located.lesson.id)
  const allLessons = roadmap.steps.flatMap((s) => s.lessons)
  const doneCount = allLessons.filter((l) => completedLessonIds.includes(l.id)).length
  const nextUp = getNextLesson(roadmap, completedLessonIds)
  const showCompletedCard = justCompleted || alreadyDone

  function handleDone() {
    if (!located) return
    const minutesStudied = Math.max(
      1,
      Math.round((located.lesson.minutes * 60 - secondsLeft) / 60),
    )
    markLessonComplete(located.lesson.id)
    logFocusSession(minutesStudied)
    setJustCompleted(true)
  }

  function handleNext() {
    if (!roadmap || !located) return
    const upcoming = getNextLesson(roadmap, completedLessonIds)
    if (upcoming && upcoming.lesson.id !== located.lesson.id) {
      navigate(`/focus/${upcoming.lesson.id}`)
    } else {
      navigate('/quiz')
    }
  }

  return (
    <div className="focus-shell">
      <header className="focus-header">
        <button className="btn btn-ghost" onClick={() => navigate('/roadmap')}>
          <IconArrowLeft size={16} />
          Exit Focus
        </button>
        <Logo to="/dashboard" compact />
        <div style={{ minWidth: 0 }}>
          <div className="nowrap" style={{ fontWeight: 700, fontSize: '0.92rem' }}>
            {located.lesson.title}
          </div>
          <div className="faint nowrap" style={{ fontSize: '0.75rem' }}>
            {activeGoal.title} · {located.step.title}
          </div>
        </div>
        <div style={{ flex: 1 }} />

        <span className={`focus-timer${running ? '' : ' paused'}`}>
          <IconClock size={16} />
          {mm}:{ss}
        </span>
        {running ? (
          <button className="btn btn-secondary" onClick={() => setRunning(false)}>
            Pause
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => setRunning(true)}>
            <IconPlay size={14} />
            Start
          </button>
        )}
      </header>

      <div className="focus-content">
        <div className="focus-card">
          <article className="focus-reader">
            <span className="badge badge-focus mb-1" style={{ display: 'inline-flex' }}>
              <IconEye size={13} />
              Focus mode · {doneCount}/{allLessons.length} lessons complete
            </span>
            <h1>{located.lesson.title}</h1>
            <LessonReader content={located.lesson.content} />
          </article>

          {showCompletedCard && (
            <div className="card mt-2" style={{ borderColor: 'var(--success)' }}>
              <div className="row-between wrap">
                <div className="row" style={{ color: 'var(--success)' }}>
                  <IconCheck size={20} />
                  <strong>Lesson complete — nice focus!</strong>
                </div>
                <div className="row wrap">
                  {hasQuiz && (
                    <button
                      className="btn btn-primary"
                      onClick={() => navigate(`/quiz/topic/${encodeURIComponent(located.lesson.title)}`)}
                    >
                      <IconQuiz size={16} />
                      Take the Quiz
                    </button>
                  )}
                  <button className="btn btn-secondary" onClick={handleNext}>
                    Next Lesson
                    <IconArrowRight size={15} />
                  </button>
                </div>
              </div>
              {nextUp && (
                <span className="badge badge-primary mt-1">
                  Up next: {nextUp.lesson.title}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <footer className="focus-footer">
        <div className="row wrap" style={{ gap: '0.4rem' }}>
          <IconShield size={17} style={{ color: 'var(--focus)' }} />
          <span className="small muted">Distraction shield active:</span>
          {blockedSites.slice(0, 4).map((s) => (
            <span key={s} className="badge badge-focus">
              <span className="strike">{s}</span>
            </span>
          ))}
          {blockedSites.length > 4 && (
            <span className="small faint">+{blockedSites.length - 4} more</span>
          )}
        </div>
        {!alreadyDone && !justCompleted && (
          <button className="btn btn-primary" onClick={handleDone}>
            <IconCheck size={16} />
            Mark Lesson Complete
          </button>
        )}
        {alreadyDone && !justCompleted && (
          <span className="badge badge-success">
            <IconCheck size={13} />
            Already completed
          </span>
        )}
      </footer>
    </div>
  )
}
