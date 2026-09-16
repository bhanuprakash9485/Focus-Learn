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
import {
  IconArrowRight,
  IconBook,
  IconCheck,
  IconClock,
  IconFlame,
  IconPlay,
  IconQuiz,
  IconSparkles,
  IconTarget,
  IconTrend,
} from '../components/Icons'
import type { QuizAttempt, Roadmap } from '../types'

function greeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

/** Strong topics = lesson topics averaged ≥80% across attempts. */
function getStrongAreas(attempts: QuizAttempt[], roadmap: Roadmap | null) {
  if (attempts.length === 0) return []
  const titleById = new Map<string, string>()
  roadmap?.steps.forEach((step) => step.lessons.forEach((l) => titleById.set(l.id, l.title)))
  const perLesson = new Map<string, { sum: number; n: number }>()
  attempts.forEach((a) => {
    const cur = perLesson.get(a.lessonId) ?? { sum: 0, n: 0 }
    perLesson.set(a.lessonId, { sum: cur.sum + a.percentage, n: cur.n + 1 })
  })
  return Array.from(perLesson.entries())
    .filter(([, v]) => v.sum / v.n >= 80)
    .map(([lessonId]) => titleById.get(lessonId) ?? lessonId)
}

export default function Dashboard() {
  const navigate = useNavigate()
  const {
    user,
    activeGoal,
    roadmap,
    completedLessonIds,
    attempts,
    aiRoadmapTopics,
    totalFocusMinutes,
    focusSessionsToday,
  } = useApp()

  const nextUp = useMemo(
    () => (roadmap ? getNextLesson(roadmap, completedLessonIds) : null),
    [roadmap, completedLessonIds],
  )

  const weakAreas = useMemo(() => getWeakAreas(attempts), [attempts])
  const recs = useMemo(() => getRecommendations(weakAreas, nextUp), [weakAreas, nextUp])

  const roadmapProgress = useMemo(
    () => (roadmap ? getRoadmapProgress(roadmap, completedLessonIds) : null),
    [roadmap, completedLessonIds],
  )
  const aiProgress =
    aiRoadmapTopics.length > 0
      ? Math.round(
          aiRoadmapTopics.reduce((acc, t) => acc + (t.progress ?? 0), 0) / aiRoadmapTopics.length,
        )
      : null

  const overallProgress = roadmapProgress ?? aiProgress ?? 0
  const avgScore = getAverageScore(attempts)
  const strongAreas = getStrongAreas(attempts, roadmap)

  const currentLessonId = nextUp?.lesson.id ?? null
  const currentChip =
    nextUp?.step.title ?? aiRoadmapTopics.find((t) => t.status === 'current')?.name ?? null

  const roadmapChips = useMemo(
    () => (roadmap ? roadmap.steps.map((s) => s.title) : aiRoadmapTopics.map((t) => t.name)),
    [roadmap, aiRoadmapTopics],
  )

  // Today's plan: pace the next lesson + its quiz + a review into dailyGoalMinutes.
  const todayPlan = useMemo(() => {
    let remaining = user.dailyGoalMinutes
    const items: { id: string; title: string; minutes: number; kind: 'lesson' | 'quiz' | 'review'; to: string }[] = []
    if (nextUp) {
      const lessonMin = Math.min(Math.max(10, nextUp.lesson.minutes), remaining)
      if (lessonMin > 0) {
        items.push({
          id: `plan-${nextUp.lesson.id}`,
          title: nextUp.lesson.title,
          minutes: lessonMin,
          kind: 'lesson',
          to: `/focus/${nextUp.lesson.id}`,
        })
        remaining -= lessonMin
      }
      if (remaining >= 5) {
        items.push({
          id: `plan-quiz-${nextUp.lesson.id}`,
          title: 'Understanding check',
          minutes: Math.min(10, remaining),
          kind: 'quiz',
          to: `/quiz/${nextUp.lesson.id}`,
        })
        remaining -= Math.min(10, remaining)
      }
    }
    if (weakAreas.length > 0 && remaining >= 5) {
      items.push({
        id: `plan-review-${weakAreas[0].lessonId}`,
        title: `Review: ${weakAreas[0].topic}`,
        minutes: Math.min(15, remaining),
        kind: 'review',
        to: '/performance',
      })
      remaining -= Math.min(15, remaining)
    }
    if (items.length === 0) {
      items.push({
        id: 'plan-next',
        title: 'Practice a quiz to keep the streak alive',
        minutes: Math.max(5, remaining),
        kind: 'quiz',
        to: '/quiz',
      })
    }
    return items
  }, [nextUp, weakAreas, user.dailyGoalMinutes])
  const totalPlanMinutes = todayPlan.reduce((acc, item) => acc + item.minutes, 0)

  const recoCards = useMemo(() => {
    const cards: {
      key: string
      title: string
      desc: string
      label: string
      to: string
      badge?: string
    }[] = recs.map((r) => ({
      key: `rec-${r.title}`,
      title: r.title,
      desc: r.reason,
      label: r.cta === 'review' ? 'Review Now' : 'Start Learning',
      to:
        r.cta === 'review'
          ? '/performance'
          : currentLessonId
            ? `/focus/${currentLessonId}`
            : '/goals',
    }))
    if (cards.length < 3) {
      cards.push({
        key: 'rec-quiz',
        title: 'Take a Quiz',
        desc:
          attempts.length > 0
            ? `${attempts.length} quiz${attempts.length === 1 ? '' : 'zes'} behind you — keep testing your understanding.`
            : 'Short checks after each lesson make real understanding stick.',
        label: 'Open Quizzes',
        to: '/quiz',
      })
    }
    if (cards.length < 3) {
      cards.push({
        key: 'rec-path',
        title: 'Build a Learning Path',
        desc: 'Let the AI chart a personalized roadmap with videos, quizzes and guides.',
        label: 'Open Learning Path',
        to: activeGoal ? '/ai-roadmap' : '/goals',
      })
    }
    return cards.slice(0, 3)
  }, [recs, currentLessonId, attempts.length, activeGoal])

  const pathSteps = roadmapChips.slice(0, 3)
  const currentStepIndex =
    currentChip && pathSteps.length > 0 ? pathSteps.indexOf(currentChip) : roadmapChips.length - 1

  return (
    <AppLayout>
      <div className="page">
        {/* 1. Hero */}
        <section className="card dash-hero">
          <span className="kicker">
            <IconSparkles size={12} />
            Your Dashboard
          </span>
          <h1>
            {greeting()}, {user.name.split(' ')[0]} 👋
          </h1>
          <p className="dash-hero-sub">
            {activeGoal
              ? `You're learning ${activeGoal.title} · ${user.level} · ${user.dailyGoalMinutes} min/day`
              : "Let's pick a goal and start your learning journey."}
          </p>
          <div className="dash-hero-actions">
            <button
              className="btn btn-primary btn-lg"
              disabled={!currentLessonId && !activeGoal}
              onClick={() => navigate(currentLessonId ? `/focus/${currentLessonId}` : '/goals')}
            >
              <IconPlay size={16} />
              {currentLessonId ? 'Continue Learning' : 'Choose a Goal'}
            </button>
            {activeGoal && (
              <button
                className="btn btn-ghost"
                onClick={() => navigate('/ai-roadmap')}
                style={{ borderColor: 'rgba(255,255,255,0.3)' }}
              >
                My Learning Path
                <IconArrowRight size={15} />
              </button>
            )}
          </div>
        </section>

        {/* 2. Stat cards */}
        <div className="dash-stats">
          <div className="card dash-stat">
            <span className="dash-stat-icon">
              <IconClock size={20} />
            </span>
            <div>
              <div className="dash-stat-value">{totalFocusMinutes} min</div>
              <div className="dash-stat-label">Total Focus Time</div>
              <div className="dash-stat-sub">
                {focusSessionsToday} session{focusSessionsToday === 1 ? '' : 's'} today
              </div>
            </div>
          </div>
          <div className="card dash-stat">
            <span className="dash-stat-icon">
              <IconFlame size={20} />
            </span>
            <div>
              <div className="dash-stat-value">{user.focusStreakDays} day{user.focusStreakDays === 1 ? '' : 's'}</div>
              <div className="dash-stat-label">Learning Streak</div>
              <div className="dash-stat-sub">Keep it alive today</div>
            </div>
          </div>
          <div className="card dash-stat">
            <span className="dash-stat-icon">
              <IconTrend size={20} />
            </span>
            <div>
              <div className="dash-stat-value">{overallProgress}%</div>
              <div className="dash-stat-label">Total Progress</div>
              <div className="dash-stat-sub">
                {avgScore !== null ? `Quiz average ${avgScore}%` : 'Take a quiz to track scores'}
              </div>
            </div>
          </div>
        </div>

        {/* 3. Learning path */}
        <div className="section-head">
          <div>
            <h2>Your Learning Path</h2>
            <span className="section-sub">The next three steps in your journey</span>
          </div>
          <Link to="/roadmap" className="btn btn-ghost">
            View full roadmap <IconArrowRight size={14} />
          </Link>
        </div>
        {pathSteps.length > 0 ? (
          <div className="dash-path">
            {pathSteps.map((topic, i) => {
              const state =
                i < currentStepIndex
                  ? 'done'
                  : i === currentStepIndex
                    ? 'current'
                    : i === currentStepIndex + 1
                      ? 'up-next'
                      : 'later'
              return (
                <div key={topic} className={`card dash-path-step ${state}`}>
                  <span className="dash-path-pos">
                    {state === 'done' ? <IconCheck size={14} /> : String(i + 1).padStart(2, '0')}
                  </span>
                  <div className="dash-path-title">{topic}</div>
                  <div className="dash-path-sub">
                    {state === 'done'
                      ? 'Completed'
                      : state === 'current'
                        ? 'In progress'
                        : state === 'up-next'
                          ? 'Up next'
                          : 'Coming later'}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="card empty-state">
            <IconTarget size={36} />
            <h2 style={{ fontSize: '1.1rem' }}>No learning path yet</h2>
            <p className="small muted">Create an AI roadmap or pick a goal to see your path here.</p>
            <div className="row wrap" style={{ justifyContent: 'center', marginTop: '0.8rem' }}>
              <button className="btn btn-primary" onClick={() => navigate('/ai-roadmap')}>
                Create AI Roadmap
              </button>
              <Link to="/goals" className="btn btn-ghost">
                Choose a Goal
              </Link>
            </div>
          </div>
        )}

        {/* 4. Recommended for you */}
        <div className="section-head">
          <div>
            <h2>Recommended for You</h2>
            <span className="section-sub">Based on your progress and quiz scores</span>
          </div>
          <Link to="/what-should-i-study" className="btn btn-ghost">
            What should I study? <IconArrowRight size={14} />
          </Link>
        </div>
        <div className="dash-reco-grid">
          {recoCards.map((card) => (
            <button key={card.key} className="card dash-reco-card" onClick={() => navigate(card.to)}>
              <span className="dash-reco-title">{card.title}</span>
              <span className="dash-reco-desc">{card.desc}</span>
              <span className="row dash-reco-go">
                {card.label}
                <IconArrowRight size={14} />
              </span>
            </button>
          ))}
        </div>

        {/* 5. Strong areas + areas to improve */}
        <div className="grid grid-2 mt-2">
          <div className="card">
            <div className="row-between mb-1">
              <h2 style={{ fontSize: '1.1rem' }}>Strong Areas</h2>
              <span className="badge badge-success">
                <IconCheck size={12} />
                On track
              </span>
            </div>
            <div className="tag-wrap">
              {strongAreas.length > 0 ? (
                strongAreas.map((area) => (
                  <span key={area} className="badge badge-success tag-lg">
                    {area}
                  </span>
                ))
              ) : (
                <span className="small faint">
                  {attempts.length > 0
                    ? 'Keep quizzing — no topic at 80%+ yet.'
                    : 'Take a quiz to see your strong areas.'}
                </span>
              )}
            </div>
          </div>

          <div className="card">
            <div className="row-between mb-1">
              <h2 style={{ fontSize: '1.1rem' }}>Areas to Improve</h2>
              <Link to="/performance" className="btn btn-ghost">
                Details <IconArrowRight size={14} />
              </Link>
            </div>
            <div className="tag-wrap">
              {weakAreas.length > 0 ? (
                weakAreas.map((area) => (
                  <span key={area.lessonId} className="badge badge-warning tag-lg">
                    {area.topic}
                  </span>
                ))
              ) : (
                <span className="small faint">No weak areas flagged yet. Nice work!</span>
              )}
            </div>
          </div>
        </div>

        {/* 6. Today's plan */}
        <div className="section-head">
          <div>
            <h2>Today's Study Plan</h2>
            <span className="section-sub">Paced around your {user.dailyGoalMinutes}-minute goal</span>
          </div>
          <span className="badge badge-focus">
            <IconClock size={12} />
            {totalPlanMinutes} min total
          </span>
        </div>
        <div className="card" style={{ padding: '0.6rem 1rem' }}>
          <div className="col" style={{ gap: '0.35rem' }}>
            {todayPlan.map((item) => (
              <button key={item.id} className="plan-row" onClick={() => navigate(item.to)}>
                <span className="plan-check">
                  {item.kind === 'quiz' ? (
                    <IconQuiz size={14} />
                  ) : item.kind === 'review' ? (
                    <IconBook size={14} />
                  ) : (
                    <IconPlay size={13} />
                  )}
                </span>
                <span className="plan-title">{item.title}</span>
                <span className="badge badge-muted">{item.minutes} min</span>
              </button>
            ))}
          </div>
        </div>

        {/* 7. How FocusLearn works */}
        <div className="section-head">
          <div>
            <h2>How FocusLearn Works</h2>
            <span className="section-sub">Three simple steps to real understanding</span>
          </div>
        </div>
        <div className="dash-how">
          <div className="card dash-how-step">
            <span className="dash-how-num">01</span>
            <div className="dash-how-title">Pick a goal</div>
            <div className="dash-how-body">
              Choose from curated roadmaps or ask the AI to build a personalized path around any topic.
            </div>
          </div>
          <div className="card dash-how-step">
            <span className="dash-how-num">02</span>
            <div className="dash-how-title">Learn in Focus Mode</div>
            <div className="dash-how-body">
              Distraction-free videos with AI summaries, key points, notes and answers to your own questions.
            </div>
          </div>
          <div className="card dash-how-step">
            <span className="dash-how-num">03</span>
            <div className="dash-how-title">Prove it with quizzes</div>
            <div className="dash-how-body">
              Short understanding checks reveal your strong and weak areas, so the AI can guide what's next.
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  )
}