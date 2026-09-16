import { Link, useNavigate } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { useApp } from '../context/AppContext'
import { getNextLesson, getRoadmapProgress, getStepStatus, quizExistsForLesson } from '../services/progress'
import {
  IconArrowRight,
  IconCheck,
  IconClock,
  IconLock,
  IconMap,
  IconPlay,
  IconQuiz,
  IconSparkles,
  IconTarget,
} from '../components/Icons'

export default function RoadmapPage() {
  const navigate = useNavigate()
  const { activeGoal, roadmap, completedLessonIds, selectGoal } = useApp()

  if (!activeGoal || !roadmap) {
    return (
      <AppLayout>
        <div className="page">
          <div className="card empty-state">
            <IconTarget size={36} />
            <h2 style={{ fontSize: '1.2rem', marginBottom: '0.4rem' }}>No roadmap yet</h2>
            <p className="muted small mb-2">
              Choose a goal — FocusLearn will generate your personalized learning path.
            </p>
            <div className="row wrap" style={{ justifyContent: 'center' }}>
              <Link to="/ai-roadmap" className="btn btn-primary">
                <IconSparkles size={15} />
                Create AI Roadmap
              </Link>
              <Link to="/goals" className="btn btn-secondary">
                Choose a Goal
              </Link>
            </div>
          </div>
        </div>
      </AppLayout>
    )
  }

  const progress = getRoadmapProgress(roadmap, completedLessonIds)
  const next = getNextLesson(roadmap, completedLessonIds)

  return (
    <AppLayout>
      <div className="page">
        <div className="page-header row-between wrap">
          <div>
            <h1>{roadmap.title}</h1>
            <p>
              {roadmap.description} · Goal:{' '}
              <Link to="/goals" style={{ color: 'var(--primary)', fontWeight: 600 }}>
                {activeGoal.title}
              </Link>
            </p>
          </div>
          <button
            className="btn btn-secondary"
            onClick={() => {
              selectGoal(activeGoal.id)
              navigate('/dashboard')
            }}
          >
            <IconSparkles size={16} />
            Regenerate (demo)
          </button>
        </div>

                {/* Summary strip */}
        <div className="card mb-2">
          <div className="row-between mb-1 wrap">
            <div className="row">
              <span className="badge badge-primary">
                <IconMap size={13} />
                {roadmap.steps.length} steps
              </span>
              <span className="badge badge-focus">
                <IconClock size={13} />
                {roadmap.steps.reduce((a, s) => a + s.estimatedHours, 0)} hours total
              </span>
              <span className="badge badge-success">
                {completedLessonIds.length} lessons done
              </span>
            </div>
            <strong>{progress}%</strong>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
        </div>

        {next && (
          <div className="row mb-2" style={{ justifyContent: 'flex-start' }}>
            <button
              className="btn btn-primary continue-btn"
              onClick={() => navigate(`/focus/${next.lesson.id}`)}
            >
              <IconPlay size={15} />
              <span className="continue-btn-label">Continue Learning: {next.lesson.title}</span>
              <IconArrowRight size={15} />
            </button>
          </div>
        )}

        {/* Vertical roadmap path */}
        <div className="roadmap-path">
          {roadmap.steps.map((step, i) => {
            const status = getStepStatus(step, completedLessonIds)
            return (
              <div key={step.id} className={`roadmap-node ${status}`} style={{ paddingBottom: '0.35rem' }}>
                <div className="roadmap-node-dot">
                  {status === 'done' ? <IconCheck size={16} /> : status === 'locked' ? <IconLock size={14} /> : i + 1}
                </div>
                <div className="card">
                  <div className="row-between wrap mb-1">
                    <div className="row">
                      <h3 style={{ fontSize: '1.08rem' }}>{step.title}</h3>
                      {status === 'current' && <span className="badge badge-primary">Up next</span>}
                      {status === 'done' && <span className="badge badge-success">Completed</span>}
                      {status === 'locked' && <span className="badge badge-muted">Locked</span>}
                    </div>
                    <span className="row small muted">
                      <IconClock size={14} />
                      ~{step.estimatedHours}h · {step.lessons.length} lessons
                    </span>
                  </div>
                  <p className="muted small mb-1">{step.description}</p>

                  {(() => {
                    const stepDone = step.lessons.filter((l) => completedLessonIds.includes(l.id)).length
                    const stepTotal = step.lessons.length
                    const stepProgress = stepTotal > 0 ? Math.round((stepDone / stepTotal) * 100) : 0
                    return (
                      <div className="step-progress" style={{ marginTop: '0.55rem' }}>
                        <div className="bar-label-row">
                          <span className="small muted">
                            {stepDone} of {stepTotal} lessons · {stepProgress}%
                          </span>
                          <span className="small" style={{ fontWeight: 700 }}>
                            {stepProgress}%
                          </span>
                        </div>
                        <div className="progress-track" style={{ height: 5 }}>
                          <div className="progress-fill" style={{ width: `${stepProgress}%` }} />
                        </div>
                      </div>
                    )
                  })()}

                  <div className="col" style={{ gap: '0.45rem', marginTop: '0.6rem' }}>
                    {step.lessons.map((lesson) => {
                      const done = completedLessonIds.includes(lesson.id)
                      const isNext = next?.lesson.id === lesson.id
                      return (
                        <div
                          key={lesson.id}
                          className="row-between"
                          style={{
                            padding: '0.55rem 0.75rem',
                            borderRadius: 'var(--radius-md)',
                            border: `1px solid ${isNext ? 'var(--primary)' : 'var(--border)'}`,
                            background: isNext ? 'var(--primary-soft)' : 'var(--surface)',
                          }}
                        >
                          <div className="row" style={{ minWidth: 0 }}>
                            <span
                              className={`badge ${done ? 'badge-success' : 'badge-muted'}`}
                              style={{ width: 24, height: 24, justifyContent: 'center', flexShrink: 0 }}
                            >
                              {done ? '✓' : ''}
                            </span>
                            <div style={{ minWidth: 0 }}>
                              <div className="small" style={{ fontWeight: 600 }}>
                                {lesson.title}
                              </div>
                              <div className="faint" style={{ fontSize: '0.78rem' }}>
                                {lesson.minutes} min read
                                {quizExistsForLesson(lesson.id) ? ' · quiz available' : ''}
                              </div>
                            </div>
                          </div>
                          <div className="row" style={{ flexShrink: 0 }}>
                            {quizExistsForLesson(lesson.id) && done && (
                              <button
                                className="btn btn-ghost"
                                onClick={() => navigate(`/quiz/${lesson.id}`)}
                                title="Retake the understanding check"
                              >
                                <IconQuiz size={15} />
                                Quiz
                              </button>
                            )}
                            <button
                              className={`btn ${isNext ? 'btn-primary' : 'btn-secondary'}`}
                              onClick={() => navigate(`/focus/${lesson.id}`)}
                            >
                              <IconPlay size={14} />
                              {done ? 'Revisit' : isNext ? 'Start' : 'Preview'}
                            </button>
                            {!done && !isNext && (
                              <span className="row faint" title="Finish earlier lessons first">
                                <IconArrowRight size={14} />
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </AppLayout>
  )
}
