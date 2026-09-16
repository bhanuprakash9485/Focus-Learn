import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { useApp } from '../context/AppContext'
import {
  getAverageScore,
  getNextLesson,
  getRecommendations,
  getRoadmapProgress,
  getWeakAreas,
} from '../services/progress'
import { normalizeTopic } from '../services/aiService'
import {
  IconAward,
  IconClock,
  IconQuiz,
  IconSparkles,
  IconTrend,
} from '../components/Icons'

/** Simple inline bar chart of attempt scores (no chart lib needed). */
function ScoreChart({ attempts }: { attempts: { percentage: number; completedAt: string }[] }) {
  if (attempts.length === 0) return null
  return (
    <div className="row" style={{ alignItems: 'flex-end', gap: '0.5rem', height: 140, padding: '0.5rem 0' }}>
      {attempts.map((a, i) => (
        <div key={i} style={{ flex: 1, textAlign: 'center', minWidth: 0 }}>
          <div
            style={{
              height: `${Math.max(a.percentage, 4)}%`,
              minHeight: 6,
              background:
                a.percentage >= 80
                  ? 'linear-gradient(180deg, var(--success), #86efac)'
                  : 'linear-gradient(180deg, var(--warning), #fcd34d)',
              borderRadius: '6px 6px 0 0',
              margin: '0 auto',
              width: '70%',
              transition: 'height 0.3s ease',
            }}
            title={`${a.percentage}% on ${a.completedAt}`}
          />
          <div className="faint" style={{ fontSize: '0.68rem', marginTop: '0.3rem' }}>
            {a.completedAt.slice(5)}
          </div>
        </div>
      ))}
    </div>
  )
}

export default function Performance() {
  const navigate = useNavigate()
  const { roadmap, activeGoal, attempts, aiRoadmapTopics, completedLessonIds, totalFocusMinutes } =
    useApp()

  // Live data only — no seeded demo history.
  const avg = getAverageScore(attempts)
  const weakAreas = getWeakAreas(attempts)
  const nextUp = roadmap ? getNextLesson(roadmap, attempts.map((a) => a.lessonId)) : null
  const recs = getRecommendations(weakAreas, nextUp)

  const roadmapProgress = roadmap ? getRoadmapProgress(roadmap, completedLessonIds) : null
  const aiProgress =
    aiRoadmapTopics.length > 0
      ? Math.round(
          aiRoadmapTopics.reduce((acc, t) => acc + (t.progress ?? 0), 0) / aiRoadmapTopics.length,
        )
      : null
  const overallProgress = roadmapProgress ?? aiProgress ?? 0

  // Completed topics: AI roadmap completion when present, else roadmap lessons.
  const aiCompleted = aiRoadmapTopics.filter((t) => t.status === 'completed').length
  const completedTopics =
    aiRoadmapTopics.length > 0 ? aiCompleted : completedLessonIds.length

  const roadmapTotalLessons = roadmap
    ? roadmap.steps.reduce((acc, s) => acc + s.lessons.length, 0)
    : 0
  const progressLabel = aiRoadmapTopics.length
    ? `${aiCompleted} topic${aiCompleted === 1 ? '' : 's'} mastered`
    : roadmap
      ? `${Math.min(completedLessonIds.length, roadmapTotalLessons)} of ${roadmapTotalLessons} lessons completed`
      : 'Start learning to build your progress'

  const focusHours = Math.floor(totalFocusMinutes / 60)
  const focusMins = totalFocusMinutes % 60
  const studyTime =
    totalFocusMinutes === 0
      ? '—'
      : focusHours > 0
        ? `${focusHours}h ${focusMins}m`
        : `${focusMins}m`

  const bestPct = attempts.length ? Math.max(...attempts.map((a) => a.percentage)) : 0

  // Honest insight text derived from the student's real attempt data.
  const insight =
    attempts.length === 0
      ? 'Take your first quiz and this card will summarize your progress.'
      : avg === null
        ? ''
        : avg < 60
          ? `Your average is ${avg}% — below the 80% mastery bar. Reviewing the flagged weak areas below before moving on will help most.`
          : avg < 80
            ? `Your average is ${avg}%. Push the flagged weak areas past 80% to have them counted as mastered.`
            : `Your average is ${avg}% (mastery threshold is 80%). Strong understanding — keep the streak going with the next lesson.`

  // Subject performance bars: average score per lesson across attempts.
  const subjectBars = useMemo(() => {
    const perLesson = new Map<string, { sum: number; n: number }>()
    attempts.forEach((a) => {
      const cur = perLesson.get(a.lessonId) ?? { sum: 0, n: 0 }
      perLesson.set(a.lessonId, { sum: cur.sum + a.percentage, n: cur.n + 1 })
    })
    return Array.from(perLesson.entries())
      .map(([lessonId, v]) => ({
        lessonId,
        name: lessonTitle(lessonId),
        pct: Math.round(v.sum / v.n),
      }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 6)
  }, [attempts, roadmap]) // eslint-disable-line react-hooks/exhaustive-deps

  function lessonTitle(lessonId: string): string {
    if (roadmap) {
      for (const step of roadmap.steps) {
        const lesson = step.lessons.find((l) => l.id === lessonId)
        if (lesson) return lesson.title
      }
    }
    return lessonId
  }

  /** Retake route for both static quizzes and Focus Mode topic quizzes. */
  function retakeRoute(lessonId: string): string {
    if (lessonId.startsWith('topic-')) {
      const name = normalizeTopic(lessonId.slice('topic-'.length).replace(/-+/g, ' '))
      return `/quiz/topic/${encodeURIComponent(name)}`
    }
    return `/quiz/${lessonId}`
  }

  const stats = [
    { label: 'Completed topics', value: `${completedTopics}`, icon: <IconAward size={20} /> },
    { label: 'Quizzes taken', value: `${attempts.length}`, icon: <IconQuiz size={20} /> },
    { label: 'Average score', value: avg !== null ? `${avg}%` : '—', icon: <IconTrend size={20} /> },
    { label: 'Study time', value: studyTime, icon: <IconClock size={20} /> },
  ]

  return (
    <AppLayout>
      <div className="page">
        <div className="page-header">
          <div>
            <span className="kicker">
              <IconTrend size={12} />
              Analytics
            </span>
            <h1>Your Progress</h1>
            <p>
              Understanding trend, weak areas, and what to learn next
              {activeGoal ? ` for ${activeGoal.title}` : ''}.
            </p>
          </div>
          <div className="page-header-actions">
            <button className="btn btn-primary" onClick={() => navigate('/quiz')}>
              <IconQuiz size={16} />
              Take a Quiz
            </button>
          </div>
        </div>

        {/* Summary: circular progress + stats */}
        <div className="card mt-1" style={{ padding: '1.5rem 1.6rem' }}>
          <div className="perf-summary">
            <div className="row" style={{ gap: '1.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="perf-ring" style={{ ['--p' as string]: `${overallProgress}` }}>
                <div className="perf-ring-track" />
                <div className="perf-ring-center">
                  <div className="perf-ring-value">{overallProgress}%</div>
                  <div className="perf-ring-label">overall progress</div>
                </div>
              </div>
              <div>
                <div className="dash-stat-value">{activeGoal?.title ?? 'Your goal'}</div>
                <div className="dash-stat-label" style={{ marginTop: '0.2rem' }}>
                  {progressLabel}
                </div>
                {bestPct > 0 && (
                  <div className="dash-stat-sub">Best score {bestPct}%</div>
                )}
              </div>
            </div>
            <div className="dash-stats" style={{ flex: 1, minWidth: 0, marginTop: 0 }}>
              {stats.map((s) => (
                <div key={s.label} className="card dash-stat">
                  <span className="dash-stat-icon">{s.icon}</span>
                  <div>
                    <div className="dash-stat-value">{s.value}</div>
                    <div className="dash-stat-label">{s.label}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {attempts.length === 0 && overallProgress === 0 ? (
          <div className="card empty-state" style={{ marginTop: '1.2rem' }}>
            <IconSparkles size={36} />
            <h2 style={{ fontSize: '1.15rem' }}>No learning activity yet</h2>
            <p className="small muted">Take a short quiz or start a lesson and your analytics will appear here.</p>
            <div className="row wrap" style={{ justifyContent: 'center', marginTop: '0.8rem' }}>
              <button className="btn btn-primary" onClick={() => navigate('/quiz')}>
                Take a Quiz
              </button>
              <button className="btn btn-secondary" onClick={() => navigate('/goals')}>
                Choose a Goal
              </button>
            </div>
          </div>
        ) : (
          <div className="perf-split mt-2">
            <div className="col">
              {/* Score trend */}
              <div className="card">
                <div className="row-between mb-1">
                  <h2 style={{ fontSize: '1.15rem' }}>Quiz performance</h2>
                  <span className="badge badge-muted">Last {Math.min(attempts.length, 8)} quizzes</span>
                </div>
                {attempts.length > 0 ? (
                  <>
                    <ScoreChart attempts={attempts.slice(-8)} />
                    <p className="faint small">Bars show quiz percentage by date. Green means 80% or above.</p>
                  </>
                ) : (
                  <p className="muted small">Take a quiz to start building your trend.</p>
                )}
              </div>

              {/* Subject performance bars */}
              <div className="card">
                <div className="row-between mb-1">
                  <h2 style={{ fontSize: '1.15rem' }}>Subject performance</h2>
                  <span className="badge badge-muted">By average score</span>
                </div>
                {subjectBars.length > 0 ? (
                  <div className="col" style={{ gap: '0.15rem' }}>
                    {subjectBars.map((s) => (
                      <div key={s.lessonId} className="perf-subject-row">
                        <span className="perf-subject-name" title={s.name}>
                          {s.name}
                        </span>
                        <div className="perf-subject-track">
                          <div
                            className="perf-subject-fill"
                            style={{
                              width: `${s.pct}%`,
                              background:
                                s.pct >= 80
                                  ? 'linear-gradient(90deg, #0f9d6e, #34c48d)'
                                  : 'linear-gradient(90deg, #f0a030, #fbbf24)',
                            }}
                          />
                        </div>
                        <span className="perf-subject-pct">{s.pct}%</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted small">No subject scores yet.</p>
                )}
              </div>

              {/* Weak areas */}
              <div className="card">
                <h2 style={{ fontSize: '1.05rem' }} className="mb-1">
                  Weak areas
                </h2>
                {weakAreas.length > 0 ? (
                  weakAreas.map((w) => (
                    <div key={w.topic} className="mb-1">
                      <div className="bar-label-row">
                        <span className="small" style={{ fontWeight: 600 }}>
                          {w.topic}
                        </span>
                        <span className="badge badge-warning">{w.missed} missed</span>
                      </div>
                      <div className="progress-track" style={{ height: 6 }}>
                        <div
                          className="progress-fill"
                          style={{
                            width: `${Math.min(100, w.missed * 50)}%`,
                            background: 'linear-gradient(90deg, var(--warning), #fbbf24)',
                          }}
                        />
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="muted small">Nothing flagged — keep it up!</p>
                )}
              </div>
            </div>

            {/* Side column */}
            <div className="col">
              {/* Insight — derived from real attempt data */}
              <div className="card">
                <div className="row mb-1" style={{ color: 'var(--primary)' }}>
                  <IconSparkles size={18} />
                  <h2 style={{ fontSize: '1.05rem' }}>Progress insight</h2>
                </div>
                <p className="muted small">{insight}</p>
              </div>

              {/* Recent activity timeline */}
              <div className="card">
                <h2 style={{ fontSize: '1.05rem' }} className="mb-1">
                  Recent activity
                </h2>
                {attempts.length > 0 ? (
                  <div className="perf-timeline">
                    {attempts
                      .slice()
                      .reverse()
                      .map((a) => (
                        <div key={a.id} className="perf-tl-item quiz">
                          <div className="perf-tl-title">{lessonTitle(a.lessonId)}</div>
                          <div className="perf-tl-meta">
                            {a.completedAt} · {a.score}/{a.total} correct
                          </div>
                          <div className="row" style={{ marginTop: '0.25rem' }}>
                            <span className={`badge ${a.percentage >= 80 ? 'badge-success' : 'badge-warning'}`}>
                              {a.percentage}%
                            </span>
                            <Link to={retakeRoute(a.lessonId)} className="btn btn-ghost" style={{ padding: '0.2rem 0.55rem' }}>
                              Retake
                            </Link>
                          </div>
                        </div>
                      ))}
                  </div>
                ) : (
                  <p className="muted small">No attempts yet.</p>
                )}
              </div>

              {/* Recommendations */}
              <div className="card">
                <div className="row mb-1" style={{ color: 'var(--primary)' }}>
                  <IconSparkles size={18} />
                  <h2 style={{ fontSize: '1.05rem' }}>Learn next</h2>
                </div>
                {recs.length > 0 ? (
                  <div className="col" style={{ gap: '0.7rem' }}>
                    {recs.map((r) => (
                      <div
                        key={r.title}
                        className="card card-hover"
                        style={{ padding: '0.8rem' }}
                        onClick={() => {
                          if (r.cta === 'review') return navigate('/performance')
                          if (nextUp) navigate(`/focus/${nextUp.lesson.id}`)
                          else navigate('/quiz')
                        }}
                      >
                        <div className="row-between">
                          <strong className="small">{r.title}</strong>
                          <span className={`badge ${r.cta === 'review' ? 'badge-warning' : 'badge-primary'}`}>
                            {r.cta === 'review' ? 'Review' : 'Next'}
                          </span>
                        </div>
                        <p className="faint" style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>
                          {r.reason}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted small">Recommendations will appear after your first quiz.</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  )
}
