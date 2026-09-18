import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { useApp } from '../context/AppContext'
import { getNextLesson, getWeakAreas } from '../services/progress'
import { IconBook, IconCheck, IconClock, IconPlay, IconQuiz, IconTarget } from '../components/Icons'

type PlanKind = 'lesson' | 'quiz' | 'review'

function planIcon(kind: PlanKind) {
  if (kind === 'quiz') return <IconQuiz size={14} />
  if (kind === 'review') return <IconBook size={14} />
  return <IconPlay size={13} />
}

export default function StudyPlan() {
  const navigate = useNavigate()
  const { user, roadmap, completedLessonIds, attempts } = useApp()
  const weakAreas = useMemo(() => getWeakAreas(attempts), [attempts])

  const todayPlan = useMemo(() => {
    if (!roadmap) return []
    const nextUp = getNextLesson(roadmap, completedLessonIds)
    if (!nextUp) {
      return [{ id: 'plan-done', title: 'Roadmap complete — practice a quiz', minutes: Math.max(10, user.dailyGoalMinutes), kind: 'quiz' as PlanKind, to: '/quiz' }]
    }
    let remaining = Math.max(10, user.dailyGoalMinutes)
    const items: { id: string; title: string; minutes: number; kind: PlanKind; to: string }[] = []
    const lessonMin = Math.min(Math.max(10, nextUp.lesson.minutes), remaining)
    items.push({ id: `plan-${nextUp.lesson.id}`, title: nextUp.lesson.title, minutes: lessonMin, kind: 'lesson', to: `/focus/${nextUp.lesson.id}` })
    remaining -= lessonMin
    if (remaining >= 5) {
      items.push({ id: `plan-quiz-${nextUp.lesson.id}`, title: 'Topic quiz', minutes: Math.min(10, remaining), kind: 'quiz', to: `/quiz/topic/${encodeURIComponent(nextUp.lesson.title)}` })
      remaining -= Math.min(10, remaining)
    }
    if (weakAreas.length > 0 && remaining >= 5) {
      items.push({ id: `plan-review-${weakAreas[0]?.lessonId ?? 'wa'}`, title: `Review: ${weakAreas[0]?.topic ?? 'weak area'}`, minutes: Math.min(15, remaining), kind: 'review', to: '/performance' })
    }
    return items
  }, [roadmap, completedLessonIds, user.dailyGoalMinutes, weakAreas])
  const totalPlanMinutes = todayPlan.reduce((acc, item) => acc + item.minutes, 0)

  // Weekly plan: one row per weekday, paced to dailyGoalMinutes, built from
  // the real upcoming lessons. A day is "done" only when its lesson is
  // actually completed; otherwise it is today/upcoming.
  const weekPlan = useMemo(() => {
    if (!roadmap) return []
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    const allLessons = roadmap.steps.flatMap((s) => s.lessons)
    const plan = days.map((day, i): { day: string; topic: string; minutes: number; status: 'done' | 'today' | 'upcoming' } | null => {
      const target = Math.max(10, user.dailyGoalMinutes)
      const completedCount = completedLessonIds.length
      const scheduledLesson = allLessons[Math.min(completedCount + i, allLessons.length - 1)] ?? allLessons[0]
      if (!scheduledLesson) return null
      const isDone = completedLessonIds.includes(scheduledLesson.id)
      return {
        day,
        topic: scheduledLesson.title,
        minutes: Math.min(Math.max(10, scheduledLesson.minutes), target),
        status: isDone ? 'done' : i === 0 ? 'today' : 'upcoming',
      }
    }).filter((d): d is NonNullable<typeof d> => d !== null)
    return plan
  }, [roadmap, completedLessonIds, user.dailyGoalMinutes])
  const week = weekPlan
  const totalMinutes = week.reduce((acc, d) => acc + d.minutes, 0)
  const doneMinutes = week.filter((d) => d.status === 'done').reduce((acc, d) => acc + d.minutes, 0)

  if (!roadmap) {
    return (
      <AppLayout>
        <div className="page">
          <div className="page-header">
            <h1>Study Plan</h1>
            <p>Your weekly learning schedule — balanced, realistic and streak-friendly.</p>
          </div>
          <div className="card empty-state">
            <IconTarget size={36} />
            <h2 style={{ fontSize: '1.2rem', marginBottom: '0.4rem' }}>Pick a goal first</h2>
            <p className="muted small mb-2">Your study plan is built from your learning roadmap.</p>
            <button className="btn btn-primary" onClick={() => navigate('/goals')}>
              Choose Your Goal
            </button>
          </div>
        </div>
      </AppLayout>
    )
  }

  return (
    <AppLayout>
      <div className="page">
        <div className="page-header">
          <h1>Study Plan</h1>
          <p>Your weekly learning schedule — paced to your {user.dailyGoalMinutes}-minute daily goal.</p>
        </div>

        <div className="card mb-2">
          <div className="row-between mb-1 wrap">
            <h2 style={{ fontSize: '1.1rem' }}>This Week</h2>
            <span className="badge badge-primary">
              <IconClock size={12} />
              {doneMinutes}/{totalMinutes} min completed
            </span>
          </div>
          <div className="progress-track mb-2">
            <div
              className="progress-fill"
              style={{ width: `${totalMinutes > 0 ? (doneMinutes / totalMinutes) * 100 : 0}%` }}
            />
          </div>

          <div className="week-grid">
            {week.map((d) => (
              <div
                key={d.day}
                className={`week-day${d.status === 'today' ? ' today' : ''}${
                  d.status === 'done' ? ' done' : ''
                }`}
              >
                <span className="d">{d.day}</span>
                <span className="m">{d.minutes}m</span>
                <span className="t">{d.topic}</span>
                {d.status === 'done' && (
                  <span className="badge badge-success">
                    <IconCheck size={11} />
                    Done
                  </span>
                )}
                {d.status === 'today' && <span className="badge badge-primary">Today</span>}
              </div>
            ))}
          </div>
          <p className="small faint mt-1">
            {user.name}, this plan fills automatically as your roadmap advances — complete lessons
            to see them marked done.
          </p>
        </div>

        <div className="card">
          <div className="row-between mb-1">
            <h2 style={{ fontSize: '1.1rem' }}>Today</h2>
            <span className="badge badge-focus">
              <IconClock size={12} />
              {totalPlanMinutes} min total
            </span>
          </div>
          <div className="col" style={{ gap: '0.55rem' }}>
            {todayPlan.map((item) => (
              <button key={item.id} className="plan-row" onClick={() => navigate(item.to)}>
                <span className="plan-check">{planIcon(item.kind)}</span>
                <span className="plan-title">{item.title}</span>
                <span className="badge badge-muted">
                  <IconClock size={12} />
                  {item.minutes} min
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </AppLayout>
  )
}