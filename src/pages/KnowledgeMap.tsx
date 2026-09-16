import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { useApp } from '../context/AppContext'
import { getNextLesson, getRoadmapProgress } from '../services/progress'
import { IconCheck, IconSparkles, IconTarget } from '../components/Icons'

export default function KnowledgeMap() {
  const { roadmap, completedLessonIds, attempts, aiRoadmapTopics } = useApp()

  // ── AI Roadmap path (adaptive topic statuses are the source of truth) ──
  const fromAiTopics = useMemo(() => {
    if (aiRoadmapTopics.length === 0) return null
    const mastered = aiRoadmapTopics
      .filter((t) => t.status === 'completed')
      .map((t) => t.name)
    const inProgress = aiRoadmapTopics
      .filter((t) => t.status === 'current' || t.status === 'needs-practice' || t.status === 'review-required')
      .map((t) => ({ topic: t.name, progress: t.progress ?? 0 }))
    const recommended = aiRoadmapTopics.find((t) => t.status === 'recommended')?.name ??
      inProgress[0]?.topic ??
      null
    const upcoming = aiRoadmapTopics.filter((t) => t.status === 'locked').map((t) => t.name)
    return { mastered, inProgress, recommended, upcoming }
  }, [aiRoadmapTopics])

  // ── Static roadmap path (derived from real completion) ────────────────
  const fromRoadmap = useMemo(() => {
    if (!roadmap) return null
    const nextUp = getNextLesson(roadmap, completedLessonIds)
    const mastered: string[] = []
    const inProgress: { topic: string; progress: number }[] = []
    const upcoming: string[] = []
    roadmap.steps.forEach((step) => {
      const total = step.lessons.length
      const done = step.lessons.filter((l) => completedLessonIds.includes(l.id)).length
      if (done === total) {
        mastered.push(step.title)
      } else if (done > 0) {
        inProgress.push({ topic: step.title, progress: Math.round((done / total) * 100) })
      } else {
        upcoming.push(step.title)
      }
    })
    return { mastered, inProgress, recommended: nextUp?.lesson.title ?? null, upcoming }
  }, [roadmap, completedLessonIds])

  const map = fromAiTopics ?? fromRoadmap

  if (!map) {
    return (
      <AppLayout>
        <div className="page page-narrow">
          <div className="page-header">
            <h1>Knowledge Map</h1>
            <p>What you have mastered, what you are learning, and what comes next.</p>
          </div>
          <div className="card empty-state">
            <IconTarget size={36} />
            <h2 style={{ fontSize: '1.2rem', marginBottom: '0.4rem' }}>No learning path yet</h2>
            <p className="muted small mb-2">
              Pick a goal or generate an AI roadmap to build your knowledge map.
            </p>
            <Link to="/goals" className="btn btn-primary">
              Choose a Goal
            </Link>
          </div>
        </div>
      </AppLayout>
    )
  }

  return (
    <AppLayout>
      <div className="page page-narrow">
        <div className="page-header">
          <h1>Knowledge Map</h1>
          <p>
            A visual map of what you have mastered, what you are learning right now, and what
            comes next.
          </p>
        </div>

        <div className="card">
          <div className="kmap-group">
            <span className="kmap-label">Mastered</span>
            <div className="tag-wrap">
              {map.mastered.length > 0 ? (
                map.mastered.map((topic) => (
                  <span key={topic} className="badge badge-success tag-lg">
                    <IconCheck size={12} />
                    {topic}
                  </span>
                ))
              ) : (
                <span className="small faint">Nothing mastered yet — keep going.</span>
              )}
            </div>
          </div>

          <div className="kmap-group">
            <span className="kmap-label">In Progress</span>
            <div className="tag-wrap">
              {map.inProgress.length > 0 ? (
                map.inProgress.map(({ topic, progress }) => (
                  <span key={topic} className="chip chip-current">
                    {topic} · {progress}%
                  </span>
                ))
              ) : (
                <span className="small faint">You haven't started a topic yet.</span>
              )}
            </div>
          </div>

          <div className="kmap-group">
            <span className="kmap-label">Recommended Next</span>
            <div className="tag-wrap">
              {map.recommended ? (
                <span className="badge badge-primary tag-lg">
                  <IconSparkles size={12} />
                  {map.recommended}
                </span>
              ) : (
                <span className="small faint">Complete the current topic to unlock the next.</span>
              )}
            </div>
          </div>

          <div className="kmap-group">
            <span className="kmap-label">Upcoming</span>
            <div className="tag-wrap">
              {map.upcoming.length > 0 ? (
                map.upcoming.map((topic) => (
                  <span key={topic} className="chip">
                    {topic}
                  </span>
                ))
              ) : (
                <span className="small faint">
                  {roadmap ? 'Roadmap complete — great work!' : 'Generate an AI roadmap to see the path.'}
                </span>
              )}
            </div>
          </div>

          <p className="small faint mt-2">
            Based on {attempts.length} quiz attempt{attempts.length === 1 ? '' : 's'} and your lesson
            progress {roadmap ? `(${getRoadmapProgress(roadmap, completedLessonIds)}%).` : '.'}
          </p>
        </div>
      </div>
    </AppLayout>
  )
}