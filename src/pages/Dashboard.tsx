import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { useApp } from '../context/AppContext'
import {
  getAverageScore,
  getNextLesson,
  getRecommendations,
  getRoadmapProgress,
  getStepStatus,
  getWeakAreas,
} from '../services/progress'
import { computeGoalProgress } from '../services/goalProgress'
import {
  recommendNextTopic,
  type RecommendNextInput,
  type RecommendNextOutput,
} from '../services/aiService'
import {
  IconArrowRight,
  IconBook,
  IconCheck,
  IconClock,
  IconFlame,
  IconPlay,
  IconQuiz,
  IconSearch,
  IconSparkles,
  IconTarget,
  IconTrend,
  IconZap,
} from '../components/Icons'
import type { ActivityEvent, QuizAttempt, Roadmap } from '../types'

function greeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

/** Local calendar day key (YYYY-MM-DD) — must match AppContext.todayKey(). */
function todayKey(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Humanize a generated topic-quiz lesson id (e.g. "topic-what-is-html"). */
function humanizeLessonId(lessonId: string): string {
  if (lessonId.startsWith('topic-')) return lessonId.slice(6).replace(/-/g, ' ')
  return lessonId
}

/** Resolve a lesson id to its roadmap title, falling back to the id. */
function lessonTitleOf(roadmap: Roadmap | null, lessonId: string): string {
  if (roadmap) {
    for (const step of roadmap.steps) {
      const lesson = step.lessons.find((l) => l.id === lessonId)
      if (lesson) return lesson.title
    }
  }
  return humanizeLessonId(lessonId)
}

/** Human label for an AI roadmap topic status. */
function aiPhaseLabel(status: string): string {
  switch (status) {
    case 'completed':
      return 'Completed'
    case 'current':
      return 'In progress'
    case 'recommended':
      return 'Up next'
    case 'needs-practice':
      return 'Needs practice'
    case 'review-required':
      return 'Review required'
    default:
      return 'Locked'
  }
}

/** Short, dated copy for recent activity rows. */
function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function dailyTargetMessage(today: number, goal: number): string {
  if (goal <= 0) return 'Set a daily learning goal to stay on track.'
  if (today === 0) return 'Start your learning session today.'
  if (today < goal) {
    const left = goal - today
    return left === 1 ? '1 minute remaining.' : `${left} minutes remaining.`
  }
  if (today === goal) return 'Daily goal completed! Keep the streak alive.'
  return `Goal completed — ${today - goal} extra minute${today - goal === 1 ? '' : 's'} today.`
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

interface RecentItem {
  id: string
  kind: ActivityEvent['kind']
  title: string
  detail?: string
  at: string | null
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
    aiRoadmap,
    totalFocusMinutes,
    focusSessionsToday,
    focusMinutesByDay,
    activity,
    primaryGoal,
  } = useApp()

  /* ── Primary personal goal (feeds the hero when no AI/curated focus) ── */
  const primaryGoalProgress = useMemo(
    () => (primaryGoal ? computeGoalProgress(primaryGoal, attempts) : null),
    [primaryGoal, attempts],
  )
  const primaryGoalTopic =
    primaryGoal && primaryGoal.status === 'active'
      ? primaryGoalProgress?.currentTopic ?? null
      : null

  const aiUsed = aiRoadmapTopics.length > 0
  const goalLabel = aiRoadmap?.title ?? aiRoadmap?.topic ?? activeGoal?.title ?? null

  /* ── Adaptive focus: review → practice → current → next ─────────────── */
  const aiAttention = useMemo(
    () =>
      aiRoadmapTopics.find((t) => t.status === 'review-required') ??
      aiRoadmapTopics.find((t) => t.status === 'needs-practice') ??
      null,
    [aiRoadmapTopics],
  )
  const focusTopic =
    aiAttention ??
    aiRoadmapTopics.find((t) => t.status === 'current') ??
    aiRoadmapTopics.find((t) => t.status === 'recommended') ??
    null

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

  const currentTopicName =
    focusTopic?.name ?? nextUp?.lesson.title ?? primaryGoalTopic?.name ?? null
  const currentProgress =
    focusTopic?.progress ??
    (nextUp ? roadmapProgress : null) ??
    (aiUsed ? aiProgress : null) ??
    0

  /* ── Navigation targets derived from real state ─────────────────────── */
  const continueTo = useMemo(() => {
    if (focusTopic) return `/search?topic=${encodeURIComponent(focusTopic.name)}`
    if (nextUp) return `/focus/${nextUp.lesson.id}`
    if (primaryGoalTopic) return `/search?topic=${encodeURIComponent(primaryGoalTopic.name)}`
    return '/goals'
  }, [focusTopic, nextUp, primaryGoalTopic])

  const quizTo = useMemo(() => {
    if (focusTopic) return `/quiz/topic/${encodeURIComponent(focusTopic.name)}`
    if (nextUp) return `/quiz/topic/${encodeURIComponent(nextUp.lesson.title)}`
    if (primaryGoalTopic) return `/quiz/topic/${encodeURIComponent(primaryGoalTopic.name)}`
    return '/quiz'
  }, [focusTopic, nextUp, primaryGoalTopic])

  const askAiTo = useMemo(() => {
    const target = goalLabel ?? focusTopic?.name
    return target ? `/search?topic=${encodeURIComponent(target)}` : '/search'
  }, [goalLabel, focusTopic])

  /* ── AI recommendation (single call per context change, cached) ─────── */
  const [aiRec, setAiRec] = useState<RecommendNextOutput | null>(null)
  const [aiLoading, setAiLoading] = useState(true)

  const aiTopicsPayload = useMemo(
    () =>
      aiUsed
        ? aiRoadmapTopics.map((t) => ({ name: t.name, status: t.status, lastScore: t.lastScore }))
        : roadmap
          ? roadmap.steps.map((s) => ({
              name: s.title,
              status: getStepStatus(s, completedLessonIds),
              lastScore: undefined,
            }))
          : [],
    [aiUsed, aiRoadmapTopics, roadmap, completedLessonIds],
  )

  const completedTopics = useMemo(
    () =>
      aiUsed
        ? aiRoadmapTopics.filter((t) => t.status === 'completed').map((t) => t.name)
        : roadmap
          ? roadmap.steps
              .filter((s) => getStepStatus(s, completedLessonIds) === 'done')
              .map((s) => s.title)
          : [],
    [aiUsed, aiRoadmapTopics, roadmap, completedLessonIds],
  )

  const recInput = useMemo<RecommendNextInput>(
    () => ({
      roadmap_goal: goalLabel ?? 'my learning roadmap',
      roadmap_topics: aiTopicsPayload,
      completed_topics: completedTopics,
      quiz_history: attempts.map((a) => ({ topic: a.lessonId, score: a.percentage })),
      weak_topics: weakAreas.map((w) => w.topic),
      current_topic: currentTopicName ?? '',
    }),
    [goalLabel, aiTopicsPayload, completedTopics, attempts, weakAreas, currentTopicName],
  )
  const recKey = JSON.stringify(recInput)

  useEffect(() => {
    if (!recInput.roadmap_goal || !recInput.current_topic) {
      setAiLoading(false)
      return
    }
    let cancelled = false
    setAiLoading(true)
    recommendNextTopic(recInput)
      .then((result) => {
        if (!cancelled) setAiRec(result)
      })
      .finally(() => {
        if (!cancelled) setAiLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recKey])

  const showAiSkeleton = aiLoading && !aiRec

  /* Deterministic fallback used when the AI is unavailable / no quizzes. */
  const aiFallback = useMemo(() => {
    if (attempts.length === 0) {
      return {
        title: 'Unlock AI recommendations',
        desc: 'Start your first quiz to unlock personalized AI recommendations tailored to your progress.',
        label: 'Take a Quiz',
        to: quizTo,
      }
    }
    if (focusTopic) {
      const review = focusTopic.status === 'review-required'
      return {
        title: review ? `Review ${focusTopic.name}` : `Practice ${focusTopic.name}`,
        desc: review
          ? 'Weak areas were detected here — review the concepts, then retake the quiz.'
          : 'Partial understanding was detected — targeted practice on this topic is recommended.',
        label: review ? 'Review Topic' : 'Practice Topic',
        to: `/search?topic=${encodeURIComponent(focusTopic.name)}`,
      }
    }
    if (nextUp) {
      return {
        title: `Next up: ${nextUp.lesson.title}`,
        desc: `The next step in "${nextUp.step.title}" — complete the lesson and its understanding check.`,
        label: 'Continue Learning',
        to: `/focus/${nextUp.lesson.id}`,
      }
    }
    if (primaryGoalTopic) {
      return {
        title: `Next up: ${primaryGoalTopic.name}`,
        desc: `The next topic in "${primaryGoal?.title ?? 'your goal'}" — study it, then take the understanding check.`,
        label: 'Continue Learning',
        to: `/search?topic=${encodeURIComponent(primaryGoalTopic.name)}`,
      }
    }
    return {
      title: 'Build your learning plan',
      desc: 'Pick a goal or let the AI chart a personalized roadmap around any topic.',
      label: 'Get Started',
      to: '/what-should-i-study',
    }
  }, [attempts.length, focusTopic, nextUp, quizTo, primaryGoalTopic, primaryGoal])

  const primaryLabel = focusTopic
    ? focusTopic.status === 'review-required'
      ? 'Review Topic'
      : focusTopic.status === 'needs-practice'
        ? 'Practice Topic'
        : 'Continue Learning'
    : nextUp
      ? 'Continue Learning'
      : primaryGoalTopic
        ? 'Continue Learning'
        : 'Choose a Goal'

  const heroSub = focusTopic
    ? focusTopic.status === 'review-required'
      ? `FocusLearn flagged ${focusTopic.name} for review — revisit the weak areas before moving on.`
      : focusTopic.status === 'needs-practice'
        ? `Targeted practice on ${focusTopic.name} is recommended to strengthen your understanding.`
        : `You're learning ${goalLabel ?? 'your goal'} · current focus: ${focusTopic.name}.`
    : primaryGoal
      ? primaryGoalTopic
        ? `You're working on ${primaryGoal.title} · current focus: ${primaryGoalTopic.name}.`
        : `You're working on ${primaryGoal.title} · ${primaryGoalProgress?.percent ?? 0}% complete.`
      : activeGoal
        ? `You're learning ${activeGoal.title} · ${user.level} · ${user.dailyGoalMinutes} min/day`
        : "Let's pick a goal and start your learning journey."

  /* ── Daily learning target ──────────────────────────────────────────── */
  const todayMinutes = focusMinutesByDay[todayKey()] ?? 0
  const dailyGoal = user.dailyGoalMinutes
  const dailyPct = dailyGoal > 0 ? Math.min(Math.round((todayMinutes / dailyGoal) * 100), 100) : 0

  /* ── Recent learning activity (real data only) ──────────────────────── */
  const recentActivity = useMemo<RecentItem[]>(() => {
    const items: RecentItem[] = []
    if (activity.length > 0) {
      activity.forEach((a) =>
        items.push({ id: a.id, kind: a.kind, title: a.label, detail: a.detail, at: a.at }),
      )
    } else {
      attempts.forEach((a) =>
        items.push({
          id: a.id,
          kind: 'quiz',
          title: lessonTitleOf(roadmap, a.lessonId),
          detail: `${a.percentage}%`,
          at: a.completedAt,
        }),
      )
      if (roadmap) {
        roadmap.steps.forEach((step) =>
          step.lessons.forEach((l) => {
            if (completedLessonIds.includes(l.id)) {
              items.push({ id: l.id, kind: 'lesson', title: l.title, at: null })
            }
          }),
        )
      }
    }
    const dated = items.filter((i): i is RecentItem & { at: string } => !!i.at).sort((a, b) =>
      a.at > b.at ? -1 : 1,
    )
    const undated = items.filter((i) => !i.at)
    return [...dated, ...undated].slice(0, 6)
  }, [activity, attempts, roadmap, completedLessonIds])

  /* ── Your Next Step (from AI result, falling back to deterministic) ─── */
  const nextSteps = useMemo(() => {
    if (aiRec?.state === 'ready') {
      const r = aiRec.recommendation
      if (r.action === 'review') {
        return [`Review: ${r.next_topic}`, 'Take a short practice quiz', 'Move to the next topic']
      }
      if (r.action === 'practice') {
        return [`Practice: ${r.next_topic}`, 'Take a short practice quiz', 'Retest to confirm understanding']
      }
      return [`Learn: ${r.next_topic}`, 'Take the understanding check', 'Keep your streak alive']
    }
    if (focusTopic?.status === 'review-required') {
      return [`Review: ${focusTopic.name}`, 'Take a short practice quiz', 'Advance when you score 80%+']
    }
    if (focusTopic?.status === 'needs-practice') {
      return [`Practice: ${focusTopic.name}`, 'Take a short practice quiz', 'Retake the topic quiz']
    }
    if (nextUp) {
      return [`Learn: ${nextUp.lesson.title}`, 'Take its understanding check', 'Review weak areas in Performance']
    }
    if (primaryGoalTopic) {
      const verb =
        primaryGoalTopic.status === 'review-required'
          ? 'Review'
          : primaryGoalTopic.status === 'needs-practice'
            ? 'Practice'
            : 'Learn'
      return [`${verb}: ${primaryGoalTopic.name}`, 'Take a short practice quiz', 'Advance when you score 80%+']
    }
    return ['Pick a learning goal', 'Set your daily target', 'Take your first quiz']
  }, [aiRec, focusTopic, nextUp, primaryGoalTopic])

  /* ── Existing dashboard sections ────────────────────────────────────── */
  const currentLessonId = nextUp?.lesson.id ?? null
  const currentChip = focusTopic?.name ?? nextUp?.step.title ?? null

  const roadmapChips = useMemo(
    () => (roadmap ? roadmap.steps.map((s) => s.title) : aiRoadmapTopics.map((t) => t.name)),
    [roadmap, aiRoadmapTopics],
  )

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
          title: 'Topic quiz',
          minutes: Math.min(10, remaining),
          kind: 'quiz',
          to: `/quiz/topic/${encodeURIComponent(nextUp.lesson.title)}`,
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
      if (primaryGoalTopic) {
        items.push({
          id: `plan-goal-${primaryGoalTopic.lessonId}`,
          title: primaryGoalTopic.name,
          minutes: Math.max(5, remaining),
          kind: 'lesson',
          to: `/search?topic=${encodeURIComponent(primaryGoalTopic.name)}`,
        })
      } else {
        items.push({
          id: 'plan-next',
          title: 'Practice a quiz to keep the streak alive',
          minutes: Math.max(5, remaining),
          kind: 'quiz',
          to: '/quiz',
        })
      }
    }
    return items
  }, [nextUp, weakAreas, user.dailyGoalMinutes, primaryGoalTopic])
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

  const quickActions = [
    {
      id: 'continue',
      icon: IconPlay,
      label: 'Continue Learning',
      sub: currentTopicName ? `Back to ${currentTopicName}` : 'Pick where to begin',
      to: continueTo,
      aria: 'Continue your current learning activity',
    },
    {
      id: 'quiz',
      icon: IconQuiz,
      label: 'Take Quiz',
      sub: focusTopic
        ? `Check understanding of ${focusTopic.name}`
        : primaryGoalTopic
          ? `Check understanding of ${primaryGoalTopic.name}`
          : 'Test an available lesson',
      to: quizTo,
      aria: 'Open the quiz for the current topic',
    },
    {
      id: 'ai',
      icon: IconZap,
      label: 'Ask AI',
      sub: 'Get a guide or ask questions',
      to: askAiTo,
      aria: 'Ask the AI about a topic',
    },
    {
      id: 'explore',
      icon: IconSearch,
      label: 'Explore Topic',
      sub: 'Learn any topic anytime',
      to: '/search',
      aria: 'Explore a new topic',
    },
  ]

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
          <p className="dash-hero-sub">{heroSub}</p>
          <div className="dash-hero-actions">
            <button className="btn btn-primary btn-lg" onClick={() => navigate(continueTo)}>
              <IconPlay size={16} />
              {primaryLabel}
            </button>
            {currentTopicName && (
              <button
                className="btn btn-ghost"
                onClick={() => navigate(quizTo)}
                style={{ borderColor: 'rgba(255,255,255,0.3)' }}
              >
                <IconQuiz size={15} />
                Take Quiz
              </button>
            )}
            {activeGoal && (
              <button
                className="btn btn-ghost"
                onClick={() => navigate(aiUsed ? '/ai-roadmap' : '/roadmap')}
                style={{ borderColor: 'rgba(255,255,255,0.3)' }}
              >
                My Learning Path
                <IconArrowRight size={15} />
              </button>
            )}
          </div>
        </section>

        {/* 2. Intelligence grid */}
        <div className="dash-intel-grid">
          {/* Today's Learning */}
          <section className="card dash-intel-card" aria-labelledby="today-learning-title">
            <div className="row-between">
              <span className="kicker">
                <IconTarget size={12} />
                Today's Learning
              </span>
              {currentTopicName ? (
                <span className="badge badge-focus">{aiPhaseLabel(focusTopic?.status ?? 'current')}</span>
              ) : null}
            </div>
            {currentTopicName ? (
              <>
                <div className="dash-topic-line">
                  <span className="dash-topic-icon">
                    <IconBook size={18} />
                  </span>
                  <div>
                    <h3 id="today-learning-title" className="dash-topic-name">
                      {currentTopicName}
                    </h3>
                    <div className="dash-topic-context">
                      {focusTopic
                        ? `From your AI roadmap${goalLabel ? ` · ${goalLabel}` : ''}`
                        : nextUp
                          ? `Part of "${nextUp.step.title}"${goalLabel ? ` · ${goalLabel}` : ''}`
                          : ''}
                    </div>
                  </div>
                </div>
                <div className="dash-intel-meta">
                  <span className="badge badge-muted">{currentProgress}% complete</span>
                  {avgScore !== null && <span className="badge badge-muted">Quiz avg {avgScore}%</span>}
                </div>
                <div className="dash-intel-foot">
                  <div className="row small muted">
                    {focusTopic ? 'Aim for steady progress on this topic.' : 'Start the lesson to begin a focus session.'}
                  </div>
                  <button
                    className="btn btn-primary"
                    onClick={() =>
                      navigate(
                        focusTopic || Boolean(nextUp)
                          ? quizTo
                          : continueTo,
                      )
                    }
                  >
                    {nextUp || focusTopic ? 'Continue Learning' : 'Choose a Goal'}
                    <IconArrowRight size={15} />
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 id="today-learning-title" className="dash-topic-name">
                  Getting started
                </h3>
                <div style={{ textAlign: 'center', padding: '0.4rem 0' }}>
                  <IconTarget size={36} style={{ margin: '0 auto 0.6rem' }} />
                  <p className="small muted">
                    {attempts.length === 0
                      ? 'No topic in progress yet. Pick a goal and start learning.'
                      : 'No active topic right now — next step is ready whenever you are.'}
                  </p>
                <button
                  className="btn btn-primary mt-2"
                  onClick={() => navigate(nextUp ? `/focus/${nextUp.lesson.id}` : '/goals')}
                >
                  {nextUp ? 'Start Next Lesson' : 'Choose a Goal'}
                  <IconArrowRight size={15} />
                </button>
              </div>
              </>
            )}
          </section>

          {/* AI Recommendation */}
          <section className="card dash-intel-card" aria-labelledby="ai-reco-title">
            <div className="row-between">
              <span className="kicker">
                <IconSparkles size={12} />
                AI Recommendation
              </span>
              {aiRec?.state === 'ready' && (
                <span
                  className={`badge ${
                    aiRec.recommendation.action === 'review'
                      ? 'badge-danger'
                      : aiRec.recommendation.action === 'practice'
                        ? 'badge-warning'
                        : 'badge-primary'
                  }`}
                >
                  {aiRec.recommendation.action === 'review'
                    ? 'Review'
                    : aiRec.recommendation.action === 'practice'
                      ? 'Practice'
                      : 'Continue'}
                </span>
              )}
            </div>
            {showAiSkeleton ? (
              <h3 id="ai-reco-title" className="dash-topic-name">
                Loading your recommendation…
              </h3>
            ) : aiRec?.state === 'ready' ? (
              <h3 id="ai-reco-title" className="dash-topic-name">
                Next: {aiRec.recommendation.next_topic}
              </h3>
            ) : (
              <h3 id="ai-reco-title" className="dash-topic-name">
                {aiFallback.title}
              </h3>
            )}
            {showAiSkeleton ? (
              <div aria-label="Loading AI recommendation" role="status">
                <div className="skeleton-line" />
                <div className="skeleton-line short" />
                <div className="skeleton-line tiny" />
              </div>
            ) : aiRec?.state === 'ready' ? (
              <>
                <p className="small muted">{aiRec.recommendation.reason}</p>
                <div className="dash-intel-foot">
                  <button
                    className="btn btn-primary"
                    onClick={() =>
                      navigate(`/search?topic=${encodeURIComponent(aiRec.recommendation.next_topic)}`)
                    }
                  >
                    <IconZap size={15} />
                    Start {aiRec.recommendation.action}
                  </button>
                  <Link to={aiUsed ? '/ai-roadmap' : '/roadmap'} className="btn btn-ghost">
                    View Roadmap <IconArrowRight size={14} />
                  </Link>
                </div>
              </>
            ) : (
              <>
                <p className="small muted">{aiFallback.desc}</p>
                <div className="dash-intel-foot">
                  <button className="btn btn-primary" onClick={() => navigate(aiFallback.to)}>
                    {aiFallback.label}
                    <IconArrowRight size={15} />
                  </button>
                </div>
              </>
            )}
          </section>
        </div>

        {/* 3. Daily Learning Target */}
        <section className="card" aria-labelledby="daily-target-title">
          <div className="daily-target-head">
            <div>
              <span className="kicker">
                <IconClock size={12} />
                Daily Learning Target
              </span>
              <h2 id="daily-target-title" style={{ fontSize: '1.05rem', marginTop: '0.35rem' }}>
                {todayMinutes} / {dailyGoal} minutes today
              </h2>
            </div>
            <div className="daily-target-value">
              {dailyPct}
              <small>%</small>
            </div>
          </div>
          <div
            className="progress-track"
            style={{ marginTop: '0.7rem' }}
            role="progressbar"
            aria-valuenow={dailyPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Daily learning goal progress"
          >
            <div className="progress-fill" style={{ width: `${dailyPct}%` }} />
          </div>
          <p className="daily-target-msg">{dailyTargetMessage(todayMinutes, dailyGoal)}</p>
          <div className="dash-intel-foot" style={{ marginTop: '0.7rem' }}>
            <span className="small muted">Tracked from real focus sessions.</span>
            {dailyGoal <= 0 ? (
              <button
                className="btn btn-primary"
                onClick={() => navigate('/profile')}
                aria-label="Set your daily learning goal"
              >
                Set a daily goal
                <IconArrowRight size={15} />
              </button>
            ) : (
              <button className="btn btn-ghost" onClick={() => navigate(continueTo)}>
                {todayMinutes === 0 ? 'Start Learning' : 'Keep Learning'}
                <IconArrowRight size={15} />
              </button>
            )}
          </div>
        </section>

        {/* 4. Quick Actions */}
        <div className="section-head">
          <div>
            <h2>Quick Actions</h2>
            <span className="section-sub">Jump straight into a learning activity</span>
          </div>
        </div>
        <div className="quick-grid">
          {quickActions.map((qa) => (
            <button
              key={qa.id}
              className="card quick-action"
              onClick={() => navigate(qa.to)}
              aria-label={qa.aria}
            >
              <span className="quick-icon">
                <qa.icon size={18} />
              </span>
              <strong>{qa.label}</strong>
              <span>
                <small>{qa.sub}</small>
              </span>
            </button>
          ))}
        </div>

        {/* 5. Recent Learning Activity */}
        <div className="section-head">
          <div>
            <h2>Recent Learning Activity</h2>
            <span className="section-sub">What you've been up to</span>
          </div>
        </div>
        <div className="card" style={{ padding: '0.6rem 1rem' }}>
          {recentActivity.length > 0 ? (
            <div className="activity-list">
              {recentActivity.map((item) => (
                <div key={item.id} className="activity-row">
                  <span className="activity-ico">
                    {item.kind === 'lesson' ? (
                      <IconBook size={16} />
                    ) : item.kind === 'quiz' ? (
                      <IconQuiz size={16} />
                    ) : (
                      <IconClock size={16} />
                    )}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="activity-title">
                      {item.kind === 'lesson'
                        ? `Completed: ${item.title}`
                        : item.kind === 'quiz'
                          ? `Quiz: ${item.title}`
                          : item.title}
                    </div>
                    <div className="activity-sub">
                      {item.kind === 'focus'
                        ? 'Focus session'
                        : item.at
                          ? formatWhen(item.at)
                          : 'Part of your path'}
                    </div>
                  </div>
                  {item.detail && <span className="activity-detail">{item.detail}</span>}
                </div>
              ))}
            </div>
          ) : (
            <div className="row wrap" style={{ justifyContent: 'space-between', padding: '0.6rem 0' }}>
              <span className="small muted">No learning activity yet.</span>
              <button className="btn btn-primary" onClick={() => navigate('/search')}>
                Start Learning <IconArrowRight size={14} />
              </button>
            </div>
          )}
        </div>

        {/* 6. Your Next Step */}
        <div className="section-head">
          <div>
            <h2>Your Next Step</h2>
            <span className="section-sub">A short plan to keep moving</span>
          </div>
        </div>
        <div className="card" style={{ padding: '0.6rem 1rem' }}>
          <div className="next-steps">
            {nextSteps.map((step, i) => (
              <div key={step} className="next-step">
                <span className="next-num">{i + 1}</span>
                <span className="next-txt">{step}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 7. Stat cards */}
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

        {/* 8. Learning path */}
        <div className="section-head">
          <div>
            <h2>Your Learning Path</h2>
            <span className="section-sub">The next three steps in your journey</span>
          </div>
          <Link to={aiUsed ? '/ai-roadmap' : '/roadmap'} className="btn btn-ghost">
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

        {/* 9. Recommended for you */}
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

        {/* 10. Strong areas + areas to improve */}
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

        {/* 11. Today's plan */}
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

        {/* 12. How FocusLearn works */}
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