import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { GlobalSearchBar } from '../components/GlobalSearchBar'
import { useApp } from '../context/AppContext'
import {
  createRoadmap,
  recommendNextTopic,
  type PerformanceAnalysisResult,
  type RecommendNextOutput,
} from '../services/aiService'
import type {
  AiRoadmapPhase,
  AiRoadmapTopic,
  AiTopicStatus,
} from '../types'
import {
  IconArrowRight,
  IconBook,
  IconBranch,
  IconChart,
  IconCheck,
  IconClock,
  IconEye,
  IconFlame,
  IconFocus,
  IconLock,
  IconMap,
  IconPen,
  IconPlay,
  IconQuiz,
  IconSparkles,
  IconTarget,
  IconTrend,
  IconX,
  IconZap,
  IconSearch,
} from '../components/Icons'

type StatusTone = 'success' | 'primary' | 'accent' | 'warning' | 'danger' | 'muted'

const statusMeta: Record<AiTopicStatus, { label: string; icon: (p: { size?: number }) => React.ReactNode; tone: StatusTone }> = {
  completed: { label: 'Completed', icon: IconCheck, tone: 'success' },
  current: { label: 'Learning', icon: IconPlay, tone: 'primary' },
  recommended: { label: 'Recommended', icon: IconSparkles, tone: 'accent' },
  'needs-practice': { label: 'Needs Practice', icon: IconTrend, tone: 'warning' },
  'review-required': { label: 'Review Required', icon: IconBook, tone: 'danger' },
  locked: { label: 'Locked', icon: IconLock, tone: 'muted' },
}

const difficultyTone: Record<AiRoadmapTopic['difficulty'], string> = {
  Beginner: 'badge-success',
  Intermediate: 'badge-warning',
  Advanced: 'badge-danger',
}

const EXAMPLE_TOPICS = [
  'Machine Learning',
  'Java Recursion',
  'Quantum Computing',
  'DBMS Normalization',
  'Computer Networks',
  'Web Development',
]
const LEVELS = [
  { value: 'beginner', label: 'Beginner' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'advanced', label: 'Advanced' },
]
const STUDY_TIMES = ['30 min/day', '1 hour/day', '2 hours/day']
const GOALS = [
  'Understand fundamentals',
  'Exam preparation',
  'Interview preparation',
  'Project development',
  'Competitive programming',
  'General learning',
]

/** Lesson id used by topic quizzes — matches getTopicQuiz() in aiService. */
function topicQuizLessonId(name: string): string {
  const hay = name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  return `topic-${hay.replace(/\s/g, '-')}`
}

/* ------------------------------------------------------------------ */
/* Progress bar (animated)                                            */
/* ------------------------------------------------------------------ */
function AnimatedBar({ value, tone = 'primary' }: { value: number; tone?: StatusTone }) {
  return (
    <div className={`progress-track ai-bar-track bar-${tone}`}>
      <div className="progress-fill ai-bar-fill" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Adaptive loop strip                                                */
/* ------------------------------------------------------------------ */
function AdaptiveLoopStrip() {
  const steps = [
    { icon: IconPlay, label: 'LEARN' },
    { icon: IconQuiz, label: 'QUIZ' },
    { icon: IconEye, label: 'ANALYZE' },
    { icon: IconBranch, label: 'ADAPT' },
    { icon: IconSparkles, label: 'RECOMMEND' },
  ]
  return (
    <div className="ai-loop">
      <span className="ai-loop-title">
        <IconZap size={13} /> Your roadmap adapts automatically
      </span>
      <div className="ai-loop-steps">
        {steps.map((s, i) => {
          const SIcon = s.icon
          return (
            <div key={s.label} className="ai-loop-step">
              <span className="ai-loop-icon">
                <SIcon size={14} />
              </span>
              <span className="ai-loop-label">{s.label}</span>
              {i < steps.length - 1 && <span className="ai-loop-arrow">→</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Roadmap topic node — connected path with adaptive branch           */
/* ------------------------------------------------------------------ */
type NodeAction = 'learn' | 'review' | 'practice' | 'retest'

function TopicNode({
  topic,
  index,
  onSelect,
  onAction,
}: {
  topic: AiRoadmapTopic
  index: number
  onSelect: () => void
  onAction: (topic: AiRoadmapTopic, action: NodeAction) => void
}) {
  const meta = statusMeta[topic.status]
  const StatusIcon = meta.icon
  const isReview = topic.status === 'review-required'
  const isPractice = topic.status === 'needs-practice'
  const isCurrent = topic.status === 'current'
  const isLocked = topic.status === 'locked'
  const isDone = topic.status === 'completed'
  const isActionable = isCurrent || isReview || isPractice || topic.status === 'recommended'

  return (
    <div className={`ai-node st-${topic.status}`}>
      <div className="ai-node-rail" aria-hidden>
        <div className={`ai-node-dot dot-${meta.tone}${isCurrent ? ' pulse' : ''}`}>
          <StatusIcon size={16} />
        </div>
      </div>

      <div className="ai-node-main">
        <article
          className={`ai-node-card${isCurrent ? ' current' : ''}${isReview ? ' review' : ''}${isPractice ? ' practice' : ''}${isLocked ? ' locked' : ''}`}
          onClick={onSelect}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && onSelect()}
        >
          <div className="ai-node-head">
            <span className="ai-node-index">{index + 1}</span>
            <div className="ai-node-title">
              <h3>{topic.name}</h3>
              <span className={`badge ai-badge-${topic.status}`}>
                <StatusIcon size={11} />
                {meta.label}
              </span>
            </div>
            {topic.lastScore != null && (
              <span className={`ai-score-pill sc-${topic.lastScore >= 80 ? 'good' : topic.lastScore >= 60 ? 'mid' : 'low'}`}>
                <IconTrend size={13} />
                {topic.lastScore}%
              </span>
            )}
            <IconArrowRight size={16} className="ai-open-arrow" />
          </div>

          <p className="muted small ai-node-desc">{topic.description}</p>

          {/* Adaptive branch — why the path changed */}
          {(isReview || isPractice) && (
            <div className={`ai-adapt adapt-${isReview ? 'danger' : 'warning'}`}>
              <div className="ai-adapt-head">
                <IconBranch size={15} />
                <strong>AI detected competency gaps</strong>
              </div>
              {topic.weakConcepts && topic.weakConcepts.length > 0 && (
                <div className="ai-adapt-weak">
                  <span className="ai-adapt-sub">Weak concepts</span>
                  <div className="tag-wrap">
                    {topic.weakConcepts.map((c) => (
                      <span key={c} className="badge tag-lg ai-weak-tag">
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {topic.reviewNote && <p className="ai-adapt-note">{topic.reviewNote}</p>}
              <ol className="ai-adapt-steps">
                <li><IconBook size={13} /> Review {topic.weakConcepts?.slice(0, 2).join(' and ') || 'the concepts'}</li>
                <li><IconPen size={13} /> Practice targeted questions</li>
                <li><IconQuiz size={13} /> Retake the quiz</li>
              </ol>
            </div>
          )}

          <div className="ai-meta-row row-between wrap">
            <span className={`badge ${difficultyTone[topic.difficulty]}`}>{topic.difficulty}</span>
            <span className="row small muted nowrap">
              <IconClock size={13} />~{topic.estimatedTime}
            </span>
            <div className="ai-progress">
              <AnimatedBar value={topic.progress} tone={isReview ? 'danger' : isPractice ? 'warning' : isDone ? 'success' : isCurrent ? 'primary' : 'muted'} />
              <span className="small" style={{ fontWeight: 700, minWidth: 36, textAlign: 'right' }}>
                {topic.progress}%
              </span>
            </div>
          </div>

          {/* Contextual action */}
          {isActionable && (
            <div className="ai-node-actions">
              {isCurrent && (
                <button className="btn btn-primary btn-sm" onClick={(e) => { e.stopPropagation(); onAction(topic, 'learn') }}>
                  <IconPlay size={14} /> Continue Learning
                </button>
              )}
              {topic.status === 'recommended' && (
                <button className="btn btn-accent btn-sm" onClick={(e) => { e.stopPropagation(); onAction(topic, 'learn') }}>
                  <IconSparkles size={14} /> Start Next Topic
                </button>
              )}
              {isReview && (
                <>
                  <button className="btn btn-danger btn-sm" onClick={(e) => { e.stopPropagation(); onAction(topic, 'review') }}>
                    <IconBook size={14} /> Start Review
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); onAction(topic, 'retest') }}>
                    <IconQuiz size={14} /> Take Retest
                  </button>
                </>
              )}
              {isPractice && (
                <>
                  <button className="btn btn-warning btn-sm" onClick={(e) => { e.stopPropagation(); onAction(topic, 'practice') }}>
                    <IconPen size={14} /> Practice Weak Areas
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); onAction(topic, 'retest') }}>
                    <IconQuiz size={14} /> Take Retest
                  </button>
                </>
              )}
            </div>
          )}

          {isLocked && (
            <div className="ai-locked-note">
              <IconLock size={12} /> Unlocks after the previous topic
            </div>
          )}
        </article>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Phase card (collapsible)                                           */
/* ------------------------------------------------------------------ */
function PhaseCard({
  phase,
  topics,
  phaseIndex,
  expanded,
  onToggle,
  onSelectTopic,
  onAction,
}: {
  phase: AiRoadmapPhase
  topics: AiRoadmapTopic[]
  phaseIndex: number
  expanded: boolean
  onToggle: () => void
  onSelectTopic: (id: string) => void
  onAction: (topic: AiRoadmapTopic, action: NodeAction) => void
}) {
  const done = topics.filter((t) => t.status === 'completed').length
  const total = topics.length
  const pct = total ? Math.round((done / total) * 100) : 0

  return (
    <section className={`ai-phase-card${expanded ? ' open' : ''}`}>
      <button className="ai-phase-head" onClick={onToggle}>
        <span className="ai-phase-number">{phaseIndex + 1}</span>
        <div className="ai-phase-info">
          <h2>{phase.title}</h2>
          {phase.description && <p className="muted small">{phase.description}</p>}
          <div className="ai-phase-progress">
            <span className="small muted">
              <IconCheck size={13} /> {done}/{total} topics completed
            </span>
            <AnimatedBar value={pct} tone={pct === 100 ? 'success' : 'primary'} />
          </div>
        </div>
        <span className={`ai-phase-chevron${expanded ? ' flip' : ''}`}>
          <IconArrowRight size={17} />
        </span>
      </button>

      {expanded && (
        <div className="ai-phase-body">
          <div className="ai-timeline">
            {topics.map((topic, i) => (
              <TopicNode
                key={topic.id}
                topic={topic}
                index={i}
                onSelect={() => onSelectTopic(topic.id)}
                onAction={onAction}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Sidebar cards                                                       */
/* ------------------------------------------------------------------ */
function CurrentlyLearningCard({ topic, phaseName, onContinue }: { topic: AiRoadmapTopic; phaseName: string; onContinue: () => void }) {
  return (
    <div className="ai-side-card ai-current-card">
      <span className="ai-side-eyebrow">
        <IconPlay size={12} /> Currently learning
      </span>
      <h3>{topic.name}</h3>
      {phaseName && <p className="muted small">{phaseName}</p>}
      <AnimatedBar value={topic.progress} tone="primary" />
      <div className="row-between small muted" style={{ marginTop: '0.2rem' }}>
        <span>{topic.progress}% complete</span>
        <span>~{topic.estimatedTime}</span>
      </div>
      <button className="btn btn-primary btn-full mt-1" onClick={onContinue}>
        <IconFocus size={15} /> Continue Learning
      </button>
    </div>
  )
}

function AiInsightCard({ insight, hasData }: { insight: string | null; hasData: boolean }) {
  return (
    <div className="ai-side-card ai-insight-card">
      <span className="ai-side-eyebrow">
        <IconSparkles size={12} /> AI Learning Insight
      </span>
      {hasData ? (
        <p className="ai-insight-text">{insight}</p>
      ) : (
        <p className="small muted">
          Complete your first topic quiz and FocusLearn will analyze your strengths and
          weaknesses to adapt this roadmap.
        </p>
      )}
    </div>
  )
}

function WhyNextCard({ target, reason, onStart, busy }: { target: AiRoadmapTopic; reason: string; onStart: () => void; busy: boolean }) {
  const isRetest = target.status === 'review-required' || target.status === 'needs-practice'
  return (
    <div className="ai-side-card ai-why-card">
      <span className="ai-side-eyebrow">
        <IconBranch size={12} /> Why this next?
      </span>
      <h3>{target.name}</h3>
      <p className="small ai-why-reason">{reason}</p>
      <button className="btn btn-ghost btn-full mt-1" onClick={onStart} disabled={busy}>
        <IconArrowRight size={15} />
        {isRetest ? 'Review & Retest' : 'Start Learning'}
      </button>
    </div>
  )
}

function SummaryCard({
  progress,
  completed,
  total,
  avgScore,
  review,
  practice,
  weakCount,
  streak,
}: {
  progress: number
  completed: number
  total: number
  avgScore: number | null
  review: number
  practice: number
  weakCount: number
  streak: number
}) {
  return (
    <div className="ai-side-card ai-summary-card">
      <span className="ai-side-eyebrow">
        <IconChart size={12} /> Learning summary
      </span>
      <div className="ai-summary-rows">
        <div className="ai-summary-row"><span>Progress</span><strong>{progress}%</strong></div>
        <div className="ai-summary-row"><span>Quiz average</span><strong>{avgScore != null ? `${avgScore}%` : '—'}</strong></div>
        <div className="ai-summary-row"><span>Completed</span><strong>{completed}/{total}</strong></div>
        {review > 0 && <div className="ai-summary-row"><span>In review</span><strong className="t-danger">{review}</strong></div>}
        {practice > 0 && <div className="ai-summary-row"><span>Needs practice</span><strong>{practice}</strong></div>}
        <div className="ai-summary-row"><span>Weak concepts</span><strong className="t-warning">{weakCount}</strong></div>
      </div>
      <div className="ai-streak">
        <IconFlame size={15} />
        <span>
          <strong>{streak}</strong> day streak
        </span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Quiz result banner                                                  */
/* ------------------------------------------------------------------ */
function QuizResultBanner({ result, onDismiss, onNext }: { result: NonNullable<ReturnType<typeof useQuizResult>>; onDismiss: () => void; onNext: () => void }) {
  const pct = result.quizTotal ? Math.round((result.quizScore! / result.quizTotal) * 100) : 0
  const status = result.analysis?.status
  const passed = status === 'pass'
  const isReview = status === 'review_required'
  const weak = result.analysis?.weak_topics ?? []
  const kind = passed ? 'success' : isReview ? 'danger' : 'warning'

  return (
    <div className={`ai-result-card rs-${kind}`}>
      <button className="icon-btn ai-result-close" aria-label="Dismiss" onClick={onDismiss}>
        <IconX size={16} />
      </button>
      <div className="ai-result-head">
        <span className="ai-result-emoji">{passed ? '🎉' : '🔎'}</span>
        <div>
          <h2>{passed ? 'Topic Mastered' : isReview ? "Let's strengthen this" : 'Improvement Needed'}</h2>
          <p className="small muted">{result.topicName}</p>
        </div>
      </div>

      <div className="ai-result-score-wrap">
        <div className={`ai-result-score sc-${passed ? 'good' : isReview ? 'low' : 'mid'}`}>
          <span className="ai-result-pct">{pct}%</span>
          <span className="ai-result-label">Quiz score</span>
        </div>
        {result.analysis?.message && <p className="ai-result-msg">{result.analysis.message}</p>}
      </div>

      {!passed && weak.length > 0 && (
        <div className="ai-result-weak">
          <span className="ai-adapt-sub">Weak concepts identified</span>
          <div className="tag-wrap">
            {weak.map((c) => (
              <span key={c} className="badge tag-lg">⚠ {c}</span>
            ))}
          </div>
          <p className="small muted" style={{ marginTop: '0.35rem' }}>
            Your roadmap has been adapted automatically.
          </p>
        </div>
      )}

      {passed && result.analysis?.strong_topics && result.analysis.strong_topics.length > 0 && (
        <div className="ai-result-weak">
          <span className="ai-adapt-sub">Strong understanding</span>
          <div className="tag-wrap">
            {result.analysis.strong_topics.map((c) => (
              <span key={c} className="badge tag-lg">✓ {c}</span>
            ))}
          </div>
        </div>
      )}

      <button className={`btn ${passed ? 'btn-primary' : 'btn-warning'} btn-full mt-1`} onClick={onNext}>
        {passed ? <IconArrowRight size={15} /> : <IconFocus size={15} />}
        {passed ? (result.nextTopic ? `Continue to ${result.nextTopic}` : 'Continue') : 'Start Review'}
      </button>
    </div>
  )
}

/** Extract a quiz result from router state. */
function useQuizResult(): { analysis?: PerformanceAnalysisResult['analysis']; topicName?: string; quizScore?: number; quizTotal?: number; nextTopic?: string } | null {
  const location = useLocation()
  const state = location.state as {
    analysis?: PerformanceAnalysisResult['analysis']
    topicName?: string
    quizScore?: number
    quizTotal?: number
  } | null
  if (!state?.analysis || !state.topicName) return null
  return state
}

/* ------------------------------------------------------------------ */
/* Empty / input state                                                */
/* ------------------------------------------------------------------ */
function RoadmapForm({
  topic, level, studyTime, goal, generating, sourceInfo, onTopic, onLevel, onStudyTime, onGoal, onSubmit,
}: {
  topic: string; level: string; studyTime: string; goal: string; generating: boolean
  sourceInfo?: { source: string; sourceUrl: string } | null
  onTopic: (v: string) => void; onLevel: (v: string) => void; onStudyTime: (v: string) => void; onGoal: (v: string) => void; onSubmit: () => void
}) {
  return (
    <div className="ai-empty-page">
      <header className="ai-empty-header">
        <div className="ai-empty-emblem">
          <IconSparkles size={30} />
        </div>
        <span className="badge ai-hero-badge">
          <IconZap size={12} /> ADAPTIVE LEARNING
        </span>
        <h1>AI Learning Roadmap</h1>
        <p className="ai-hero-tagline">
          Your personalized learning path adapts to what you actually know.
        </p>
      </header>

      <section className="ai-empty-hero">
        <h2>Build Your AI Roadmap</h2>
        <p className="muted">
          Tell FocusLearn what you want to learn. The AI will research your topic and build a path that changes with your performance.
        </p>
        <ul className="ai-empty-benefits">
          <li><IconCheck size={14} /> Understand your topic</li>
          <li><IconMap size={14} /> Build a personalized learning path</li>
          <li><IconTrend size={14} /> Track your performance</li>
          <li><IconBranch size={14} /> Detect weak concepts</li>
          <li><IconZap size={14} /> Adapt your roadmap automatically</li>
        </ul>
      </section>

      <section className="card ai-topic-card">
        {sourceInfo && sourceInfo.source === 'roadmap.sh' && (
          <div className="banner banner-info mb-2" style={{ marginBottom: '1rem' }}>
            <IconMap size={16} />
            <span>
              Discovered from the roadmap.sh catalog — FocusLearn generates an <strong>original adaptive path</strong> for this topic.
            </span>
          </div>
        )}
        <div className="ai-topic-form">
          <label className="ai-form-label" htmlFor="ai-topic">What do you want to learn?</label>
          <div className="ai-topic-input-wrap">
            <IconSearch size={18} className="ai-topic-input-icon" />
            <input
              id="ai-topic"
              className="ai-topic-input"
              value={topic}
              onChange={(e) => onTopic(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !generating && onSubmit()}
              placeholder="e.g. Machine Learning, Java Recursion, Quantum Computing"
              disabled={generating}
            />
          </div>
          <div className="tag-wrap" style={{ marginTop: '0.5rem' }}>
            {EXAMPLE_TOPICS.map((t) => (
              <button key={t} type="button" className="badge badge-muted chip-btn" disabled={generating} onClick={() => onTopic(t)}>
                {t}
              </button>
            ))}
          </div>

          <div className="ai-form-grid">
            <div>
              <label className="ai-form-label" htmlFor="ai-level">Learning level</label>
              <select id="ai-level" className="ai-option-input" value={level} disabled={generating} onChange={(e) => onLevel(e.target.value)}>
                {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            <div>
              <label className="ai-form-label" htmlFor="ai-time">Study time</label>
              <select id="ai-time" className="ai-option-input" value={studyTime} disabled={generating} onChange={(e) => onStudyTime(e.target.value)}>
                {STUDY_TIMES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="ai-form-label" htmlFor="ai-goal">Goal</label>
              <select id="ai-goal" className="ai-option-input" value={goal} disabled={generating} onChange={(e) => onGoal(e.target.value)}>
                {GOALS.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          </div>

          <button className="btn btn-primary btn-lg ai-generate-btn" onClick={onSubmit} disabled={generating || !topic.trim()}>
            {generating ? <span className="spinner" style={{ width: 16, height: 16 }} /> : <IconSparkles size={17} />}
            {generating ? 'Generating...' : 'Generate AI Roadmap'}
          </button>
        </div>
      </section>
    </div>
  )
}

const LOAD_STEPS = [
  'Understanding your topic',
  'Finding relevant learning information',
  'Building your personalized roadmap',
  'Organizing learning phases',
  'Preparing assessments',
]

function RoadmapLoading({ step }: { step: number }) {
  return (
    <section className="card ai-loading-card">
      <div className="row" style={{ gap: '0.8rem', alignItems: 'center' }}>
        <span className="spinner" style={{ width: 28, height: 28 }} />
        <h2 style={{ fontSize: '1.2rem' }}>Creating Your AI Roadmap</h2>
      </div>
      <p className="small muted" style={{ marginBottom: '0.6rem' }}>Building your learning path...</p>
      <div className="col ai-loading-steps" style={{ gap: '0.65rem' }}>
        {LOAD_STEPS.map((label, i) => {
          const done = i < step
          const active = i === step
          return (
            <div key={label} className={`ai-loading-step${done ? ' done' : ''}${active ? ' active' : ''}`}>
              {done ? <IconCheck size={16} /> : active ? <span className="spinner" style={{ width: 15, height: 15 }} /> : <span className="ai-loading-dot" />}
              <span>{label}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Topic detail modal                                                 */
/* ------------------------------------------------------------------ */
function TopicDetail({
  topic,
  onClose,
  onAction,
}: {
  topic: AiRoadmapTopic
  onClose: () => void
  onAction: (topic: AiRoadmapTopic, action: NodeAction) => void
}) {
  const meta = statusMeta[topic.status]
  const StatusIcon = meta.icon
  const isReview = topic.status === 'review-required'
  const isPractice = topic.status === 'needs-practice'
  const isLocked = topic.status === 'locked'

  return (
    <div className="ai-modal-backdrop" onClick={onClose}>
      <div
        className="ai-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${topic.name} details`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ai-modal-header">
          <div>
            <span className={`badge ai-badge-${topic.status}`}>
              <StatusIcon size={12} />
              {meta.label}
            </span>
            <h2 style={{ fontSize: '1.4rem', marginTop: '0.5rem' }}>{topic.name}</h2>
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <IconX size={18} />
          </button>
        </div>

        <div className="ai-modal-body">
          {(isReview || isPractice) && (
            <div className={`banner ${isReview ? 'banner-warning' : 'banner-info'}`}>
              {isReview ? <IconBook size={16} /> : <IconTrend size={16} />}
              <span>
                <strong>{isReview ? 'Review recommended before continuing.' : 'Additional practice recommended.'}</strong>
                {topic.reviewNote ? ` ${topic.reviewNote}` : ''}
              </span>
            </div>
          )}

          {topic.weakConcepts && topic.weakConcepts.length > 0 && (
            <div className="card mt-1" style={{ background: 'var(--danger-soft)', borderColor: 'rgba(220,38,38,0.2)' }}>
              <div className="small" style={{ fontWeight: 700, color: 'var(--danger)', marginBottom: '0.3rem' }}>Weak Concepts</div>
              <div className="tag-wrap">
                {topic.weakConcepts.map((c) => <span key={c} className="badge badge-danger tag-lg">{c}</span>)}
              </div>
            </div>
          )}

          {topic.strongConcepts && topic.strongConcepts.length > 0 && (
            <div className="card mt-1" style={{ background: 'var(--success-soft)', borderColor: 'rgba(22,163,74,0.2)' }}>
              <div className="small" style={{ fontWeight: 700, color: 'var(--success)', marginBottom: '0.3rem' }}>Strong Concepts</div>
              <div className="tag-wrap">
                {topic.strongConcepts.map((c) => <span key={c} className="badge badge-success tag-lg">{c}</span>)}
              </div>
            </div>
          )}

          {topic.learningObjectives && topic.learningObjectives.length > 0 && (
            <div className="card mt-1">
              <div className="small" style={{ fontWeight: 700, color: 'var(--primary)', marginBottom: '0.3rem' }}>Learning objectives</div>
              <ul className="ai-objective-list">
                {topic.learningObjectives.map((o) => <li key={o}>{o}</li>)}
              </ul>
            </div>
          )}

          <div className="ai-detail-grid">
            <div>
              <h4 className="ai-detail-label">Topic overview</h4>
              <p className="small muted">{topic.overview}</p>
            </div>
            <div>
              <h4 className="ai-detail-label">Prerequisites</h4>
              {topic.prerequisites.length > 0 ? (
                <div className="tag-wrap">
                  {topic.prerequisites.map((p) => <span key={p} className="badge badge-muted tag-lg">{p}</span>)}
                </div>
              ) : (
                <p className="small muted">None — start here.</p>
              )}
            </div>
            <div>
              <h4 className="ai-detail-label">Estimated time</h4>
              <p className="row small" style={{ fontWeight: 600 }}>
                <IconClock size={15} />~{topic.estimatedTime}
              </p>
            </div>
            <div>
              <h4 className="ai-detail-label">Skills gained</h4>
              <div className="tag-wrap">
                {topic.skillsGained.map((s) => <span key={s} className="badge badge-primary tag-lg">{s}</span>)}
              </div>
            </div>
          </div>
        </div>

        <div className="ai-modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          {isLocked ? (
            <button className="btn btn-primary" disabled><IconLock size={15} /> Complete earlier topics to unlock</button>
          ) : isReview ? (
            <>
              <button className="btn btn-danger" onClick={() => onAction(topic, 'review')}><IconBook size={15} /> Start Review</button>
              <button className="btn btn-primary" onClick={() => onAction(topic, 'retest')}><IconQuiz size={15} /> Take Retest</button>
            </>
          ) : isPractice ? (
            <>
              <button className="btn btn-warning" onClick={() => onAction(topic, 'practice')}><IconPen size={15} /> Practice Weak Areas</button>
              <button className="btn btn-primary" onClick={() => onAction(topic, 'retest')}><IconQuiz size={15} /> Take Retest</button>
            </>
          ) : topic.status === 'recommended' ? (
            <button className="btn btn-primary" onClick={() => onAction(topic, 'learn')}><IconSparkles size={15} /> Start Next Topic</button>
          ) : (
            <button className="btn btn-primary" onClick={() => onAction(topic, 'learn')}><IconPlay size={15} /> Start Learning</button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Main page                                                          */
/* ------------------------------------------------------------------ */
export default function AiRoadmapPage() {
  const navigate = useNavigate()
  const { aiRoadmap, aiRoadmapTopics, attempts, user, setAiRoadmap, updateAiTopic } = useApp()
  const quizResult = useQuizResult()
  const location = useLocation()

  const [sourceInfo] = useState<{ source: string; sourceUrl: string } | null>(() => {
    // Optional source attribution passed when arriving from the Goal Catalog
    // (roadmap.sh discovery). Only roadmap.sh URLs are ever surfaced.
    const params = new URLSearchParams(location.search)
    const source = params.get('source')
    const url = params.get('sourceUrl')
    if (source === 'roadmap.sh' && url && url.startsWith('https://roadmap.sh/')) {
      return { source, sourceUrl: url }
    }
    return null
  })

  const [topicInput, setTopicInput] = useState(() => {
    // Support arriving with a pre-chosen topic (?topic=…), e.g. from
    // Goals for catalog goals that have no static roadmap.
    return new URLSearchParams(location.search).get('topic')?.trim() ?? ''
  })
  const [level, setLevel] = useState('beginner')
  const [studyTime, setStudyTime] = useState('1 hour/day')
  const [goal, setGoal] = useState('general learning')
  const [generating, setGenerating] = useState(false)
  const [loadStep, setLoadStep] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState(false)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [recommendation, setRecommendation] = useState<RecommendNextOutput | null>(null)
  const [recommending, setRecommending] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const topics = useMemo<AiRoadmapTopic[]>(() => aiRoadmapTopics ?? [], [aiRoadmapTopics])

  const phaseGroups = useMemo(() => {
    if (!aiRoadmap) return []
    const byPhase = new Map<string, AiRoadmapTopic[]>()
    topics.forEach((t) => {
      const key = t.phaseId ?? '_'
      if (!byPhase.has(key)) byPhase.set(key, [])
      byPhase.get(key)!.push(t)
    })
    return aiRoadmap.phases.map((phase: AiRoadmapPhase) => ({
      phase,
      topics: byPhase.get(phase.id) ?? [],
    }))
  }, [aiRoadmap, topics])

  /* ── Real progress metrics ─────────────────────────────────── */
  const totals = useMemo(() => {
    const completed = topics.filter((t) => t.status === 'completed').length
    const review = topics.filter((t) => t.status === 'review-required').length
    const practice = topics.filter((t) => t.status === 'needs-practice').length
    const progress = topics.length ? Math.round(topics.reduce((a, t) => a + t.progress, 0) / topics.length) : 0
    const hours = topics.reduce((a, t) => a + t.estimatedHours, 0)
    return { completed, review, practice, progress, hours, total: topics.length }
  }, [topics])

  // Real quiz scores limited to attempts on THIS roadmap's topics.
  const topicAttempts = useMemo(() => {
    const ids = new Set(topics.map((t) => topicQuizLessonId(t.name)))
    return attempts
      .filter((a) => ids.has(a.lessonId))
      .sort((a, b) => a.completedAt.localeCompare(b.completedAt))
  }, [topics, attempts])

  const avgScore = useMemo(
    () => topicAttempts.length ? Math.round(topicAttempts.reduce((a, t) => a + t.percentage, 0) / topicAttempts.length) : null,
    [topicAttempts],
  )

  const weakConceptCount = useMemo(
    () => new Set(topics.flatMap((t) => t.weakConcepts ?? [])).size,
    [topics],
  )

  const levelRange = useMemo(() => {
    const levels = new Set(topics.map((t) => t.difficulty))
    const order: AiRoadmapTopic['difficulty'][] = ['Beginner', 'Intermediate', 'Advanced']
    const present = order.filter((l) => levels.has(l))
    if (present.length === 0) return 'Beginner'
    return `${present[0]} → ${present[present.length - 1]}`
  }, [topics])

  const weeksEstimate = useMemo(() => Math.max(1, Math.round(totals.hours / 6)), [totals.hours])

  /* ── Adaptive focus / next target ───────────────────────────── */
  const current = useMemo(() => topics.find((t) => t.status === 'current'), [topics])
  const reviewTarget = useMemo(() => topics.find((t) => t.status === 'review-required'), [topics])
  const practiceTarget = useMemo(() => topics.find((t) => t.status === 'needs-practice'), [topics])
  const recommendedTopic = useMemo(() => topics.find((t) => t.status === 'recommended'), [topics])
  const focus = reviewTarget || practiceTarget || current || recommendedTopic || null
  const focusPhaseName = useMemo(() => {
    if (!focus || !aiRoadmap) return ''
    return phaseGroups.find((g) => g.phase.id === focus.phaseId)?.phase.title ?? ''
  }, [focus, phaseGroups, aiRoadmap])

  /* ── Quiz result processing + persistence for display ───────── */
  useEffect(() => {
    if (!quizResult?.analysis || !quizResult.topicName) return

    const analysis = quizResult.analysis
    const topicName = quizResult.topicName

    const topicIdx = topics.findIndex(
      (t) => t.name.toLowerCase() === topicName.toLowerCase() || topicName.toLowerCase().includes(t.name.toLowerCase()),
    )
    if (topicIdx !== -1) {
      const topic = topics[topicIdx]
      const newStatus: AiTopicStatus =
        analysis.status === 'pass' ? 'completed'
          : analysis.status === 'needs_practice' ? 'needs-practice'
            : 'review-required'

      const pct = quizResult.quizScore != null && quizResult.quizTotal
        ? Math.round((quizResult.quizScore / Math.max(quizResult.quizTotal, 1)) * 100)
        : undefined

      const progress = newStatus === 'completed' ? 100 : Math.max(topic.progress, pct ?? 0)

      updateAiTopic(topic.id, {
        status: newStatus,
        progress,
        reviewNote: analysis.message,
        weakConcepts: analysis.weak_topics,
        strongConcepts: analysis.strong_topics,
        lastScore: pct,
        retryCount: (topic.retryCount || 0) + (newStatus !== 'completed' ? 1 : 0),
      })

      if (analysis.status === 'pass' && topicIdx + 1 < topics.length) {
        const next = topics[topicIdx + 1]
        if (next.status === 'locked' || next.status === 'recommended') {
          updateAiTopic(next.id, { status: 'current', progress: 0 })
        }
      }
      if (analysis.status === 'review_required' && topicIdx + 1 < topics.length) {
        const next = topics[topicIdx + 1]
        if (next.status === 'current') updateAiTopic(next.id, { status: 'locked' })
      }
    }

    window.history.replaceState({}, '')
    showToast(`${topicName}: ${quizResult.quizScore}/${quizResult.quizTotal} — ${analysis?.message ?? 'Analysis complete'}`)
  }, [quizResult]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Loading step animation ─────────────────────────────────── */
  useEffect(() => {
    if (!generating) return
    setLoadStep(0)
    const interval = window.setInterval(() => setLoadStep((s) => (s < LOAD_STEPS.length - 1 ? s + 1 : s)), 600)
    return () => window.clearInterval(interval)
  }, [generating])

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(null), 5000)
  }

  const handleGenerate = useCallback(async () => {
    const topic = topicInput.trim()
    if (!topic || generating) return
    setGenerating(true); setError(null); setBlocked(false); setLoadStep(0)
    const result = await createRoadmap({ topic, level, study_time: studyTime, goal })
    setGenerating(false)
    if (result.state === 'ready') {
      setAiRoadmap(result.roadmap)
      setRecommendation(null)
      showToast(`Roadmap for "${topic}" is ready!`)
    } else {
      setBlocked(!!result.blocked)
      setError(result.message)
    }
  }, [topicInput, level, studyTime, goal, generating, setAiRoadmap]) // eslint-disable-line react-hooks/exhaustive-deps

  // When the user arrives from the Goal Catalog with a pre-chosen topic
  // (?topic=…&source=roadmap.sh), start generation right away so the
  // "Use this as my learning goal" flow is seamless. Runs at most once —
  // a manual refresh still leaves the user in control.
  const autoStartedRef = useRef(false)
  useEffect(() => {
    const t = topicInput.trim()
    if (autoStartedRef.current || !t || aiRoadmap || generating) return
    autoStartedRef.current = true
    handleGenerate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleReset = useCallback(() => {
    setAiRoadmap(null)
    setRecommendation(null); setError(null); setBlocked(false); setSelectedId(null); setCollapsed({})
  }, [setAiRoadmap])

  /** Connect to existing YouTube + SafeSearch + Focus Mode pipeline. */
  const handleAction = useCallback((topic: AiRoadmapTopic, action: NodeAction) => {
    setSelectedId(null)
    if (action === 'retest') {
      navigate(`/quiz/topic/${encodeURIComponent(topic.name)}`)
      return
    }
    showToast(`Opening "${topic.name}" learning content...`)
    navigate(`/search?topic=${encodeURIComponent(topic.name)}`)
  }, [navigate]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleFetchRecommendation = useCallback(async () => {
    if (!focus) return
    setRecommending(true)
    try {
      const result = await recommendNextTopic({
        roadmap_goal: aiRoadmap?.title ?? aiRoadmap?.topic ?? 'learning roadmap',
        roadmap_topics: topics.map((t) => ({ name: t.name, status: t.status, lastScore: t.lastScore })),
        completed_topics: topics.filter((t) => t.status === 'completed').map((t) => t.name),
        quiz_history: topics.filter((t) => t.lastScore != null).map((t) => ({ topic: t.name, score: t.lastScore! })),
        weak_topics: topics.filter((t) => t.weakConcepts?.length).flatMap((t) => t.weakConcepts!),
        current_topic: focus.name,
      })
      setRecommendation(result)
    } finally {
      setRecommending(false)
    }
  }, [topics, aiRoadmap, focus, recommendNextTopic]) // eslint-disable-line react-hooks/exhaustive-deps

  const selected = topics.find((t) => t.id === selectedId) ?? null
  const togglePhase = useCallback((id: string) => {
    setCollapsed((c) => ({ ...c, [id]: !c[id] }))
  }, [])

  /* ── "Why this next" reason — derived from real state ────────── */
  const nextReason = useMemo(() => {
    if (recommendation && recommendation.state === 'ready') {
      return recommendation.recommendation.reason
    }
    if (!focus) return ''
    if (focus.status === 'review-required') {
      const weak = focus.weakConcepts?.slice(0, 2).join(' and ') || 'key concepts here'
      return `FocusLearn detected repeated incorrect answers related to ${weak}. Review before continuing.`
    }
    if (focus.status === 'needs-practice') {
      const weak = focus.weakConcepts?.slice(0, 2).join(' and ') || 'key concepts here'
      return `Partial understanding detected. Targeted practice on ${weak} is recommended.`
    }
    if (focus.status === 'current' && focus.lastScore != null && focus.retryCount) {
      return `Retest score improved to ${focus.lastScore}% with no critical weaknesses remaining.`
    }
    return 'This topic builds naturally on your current knowledge and is the next logical step.'
  }, [recommendation, focus])

  /* ── AI insight — from real analysis data ────────────────────── */
  const aiInsight = useMemo(() => {
    const analyzed = topics.filter((t) => t.lastScore != null)
    if (analyzed.length === 0) return null
    const strong = new Set(analyzed.flatMap((t) => t.strongConcepts ?? []))
    const weak = new Set(analyzed.flatMap((t) => t.weakConcepts ?? []))
    if (strong.size === 0 && weak.size === 0) return null
    const parts: string[] = []
    if (strong.size) parts.push(`You understand ${Array.from(strong).slice(0, 3).join(', ')} well.`)
    if (weak.size) parts.push(`You need additional practice with ${Array.from(weak).slice(0, 3).join(' and ')}.`)
    parts.push('Your next activity is targeted practice before continuing.')
    return parts.join(' ')
  }, [topics])

  /* ── Empty state ─────────────────────────────────────────────── */
  if (!aiRoadmap) {
    return (
      <AppLayout>
        <div className="page ai-page-narrow">
          <RoadmapForm
            topic={topicInput} level={level} studyTime={studyTime} goal={goal} generating={generating}
            sourceInfo={sourceInfo}
            onTopic={setTopicInput} onLevel={setLevel} onStudyTime={setStudyTime} onGoal={setGoal}
            onSubmit={handleGenerate}
          />
          {generating && <RoadmapLoading step={loadStep} />}
          {error && (
            <div className={`banner mt-2 ${blocked ? 'banner-warning' : 'banner-danger'}`} style={{ marginTop: '1rem' }}>
              {blocked ? <IconLock size={16} /> : <IconX size={16} />}
              <span>{error}</span>
              {(blocked || error) && (
                <button className="btn btn-ghost btn-sm" onClick={() => { setError(null); setBlocked(false) }}>
                  Try Again
                </button>
              )}
            </div>
          )}
        </div>
      </AppLayout>
    )
  }

  /* ── Roadmap view ────────────────────────────────────────────── */
  return (
    <AppLayout hideTopbarSearch>
      <div className="page ai-page">
        {/* Header */}
        <header className="ai-page-header">
          <div className="ai-header-title">
            <span className="ai-header-icon">
              <IconSparkles size={22} />
            </span>
            <div>
              <h1>AI Learning Roadmap</h1>
              <p>Your personalized learning path adapts to what you actually know.</p>
            </div>
          </div>
          <div className="ai-header-actions">
            <GlobalSearchBar />
            <span className="badge ai-adaptive-badge">
              <IconZap size={12} /> ADAPTIVE LEARNING
            </span>
            <button className="btn btn-secondary btn-sm" onClick={handleReset} disabled={generating}>
              New Topic
            </button>
          </div>
        </header>

        {/* Goal summary */}
        <section className="ai-goal-card">
          <div className="ai-goal-grid">
            <div className="ai-goal-main">
              <span className="ai-side-eyebrow"><IconTarget size={12} /> Learning goal</span>
              <h2>{aiRoadmap.topic}</h2>
              <p className="small muted">{aiRoadmap.overview}</p>
              <div className="ai-goal-chips">
                <span className="badge ai-goal-chip">{levelRange}</span>
                <span className="badge ai-goal-chip"><IconClock size={11} /> {studyTime}</span>
                <span className="badge ai-goal-chip">📅 ~{weeksEstimate} weeks</span>
                <span className="badge ai-goal-chip">📚 {phaseGroups.length} phases · {totals.total} topics</span>
              </div>
            </div>
            <div className="ai-goal-final">
              <span className="ai-side-eyebrow">Final goal</span>
              <p className="small ai-goal-final-text">{aiRoadmap.final_goal}</p>
            </div>
          </div>
        </section>

        {/* Overall progress */}
        <section className="ai-progress-panel">
          <div className="ai-progress-head">
            <div>
              <span className="ai-side-eyebrow">Your Progress</span>
              <h2 style={{ fontSize: '1.1rem' }}>{totals.progress}% complete</h2>
            </div>
            <div className="ai-progress-stats">
              <div className="ai-ps"><span className="ai-ps-n">{totals.completed}/{totals.total}</span><span className="ai-ps-l">topics completed</span></div>
              <div className="ai-ps"><span className="ai-ps-n">{avgScore != null ? `${avgScore}%` : '—'}</span><span className="ai-ps-l">avg quiz score</span></div>
              <div className="ai-ps"><span className="ai-ps-n">{weakConceptCount}</span><span className="ai-ps-l">weak concepts</span></div>
              <div className="ai-ps"><span className="ai-ps-n">{user.focusStreakDays}</span><span className="ai-ps-l">day streak</span></div>
            </div>
          </div>
          <AnimatedBar value={totals.progress} tone="primary" />
          {topicAttempts.length === 0 && (
            <p className="small faint" style={{ marginTop: '0.5rem' }}>
              No quiz attempts yet — start learning to build your progress.
            </p>
          )}
        </section>

        <AdaptiveLoopStrip />

        {/* Quiz result banner (fresh from quiz completion) */}
        {quizResult && (
          <QuizResultBanner result={quizResult} onDismiss={() => window.history.replaceState({}, '')} onNext={() => focus && handleAction(focus, focus.status === 'review-required' || focus.status === 'needs-practice' ? 'review' : 'learn')} />
        )}

        {/* Prerequisites */}
        {aiRoadmap.prerequisites.length > 0 && (
          <div className="card ai-pre-card">
            <div className="row mb-1"><IconBook size={17} /><h2 style={{ fontSize: '1.05rem' }}>Before you start</h2></div>
            <div className="tag-wrap">
              {aiRoadmap.prerequisites.map((p) => <span key={p} className="badge badge-muted tag-lg">{p}</span>)}
            </div>
          </div>
        )}

        {/* Main layout: roadmap + sidebar */}
        <div className="ai-layout">
          <main className="ai-main">
            {/* Legend */}
            <div className="row wrap ai-legend">
              {(['completed', 'current', 'recommended', 'needs-practice', 'review-required', 'locked'] as AiTopicStatus[]).map((s) => {
                const m = statusMeta[s]
                const SIcon = m.icon
                return (
                  <span key={s} className="ai-legend-item">
                    <span className={`ai-legend-dot dot-${m.tone}`} />
                    {m.label}
                    <SIcon size={11} />
                  </span>
                )
              })}
            </div>

            {/* Phases */}
            {phaseGroups.map(({ phase, topics: phaseTopics }, pi) => (
              <PhaseCard
                key={phase.id}
                phase={phase}
                topics={phaseTopics}
                phaseIndex={pi}
                expanded={!collapsed[phase.id]}
                onToggle={() => togglePhase(phase.id)}
                onSelectTopic={setSelectedId}
                onAction={handleAction}
              />
            ))}

            {/* Adaptive assistant */}
            <section className="card ai-adaptive-card">
              <div className="row mb-1" style={{ color: 'var(--accent)' }}>
                <IconZap size={18} />
                <h2 style={{ fontSize: '1.05rem' }}>AI Learning Assistant</h2>
              </div>
              <p className="small muted mb-1">
                Complete each topic quiz to get AI-powered analysis of your strengths and weaknesses.
                The roadmap below adapts instantly to your scores.
              </p>
              {focus ? (
                <div className="row wrap">
                  <button className="btn btn-primary" onClick={() => handleAction(focus, focus.status === 'review-required' ? 'review' : focus.status === 'needs-practice' ? 'practice' : 'learn')}>
                    <IconFocus size={15} />
                    {focus.status === 'review-required' ? '📖 Start Review' : focus.status === 'needs-practice' ? '📝 Practice Weak Areas' : '▶ Continue Learning'}
                  </button>
                  {(focus.status === 'review-required' || focus.status === 'needs-practice') && (
                    <button className="btn btn-secondary" onClick={() => handleAction(focus, 'retest')}>
                      <IconQuiz size={15} /> 🔁 Take Retest
                    </button>
                  )}
                  <button className="btn btn-ghost" onClick={handleFetchRecommendation} disabled={recommending}>
                    {recommending ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <IconSparkles size={15} />}
                    Get AI Recommendation
                  </button>
                </div>
              ) : (
                <p className="small faint">All topics completed — great work!</p>
              )}
            </section>
          </main>

          <aside className="ai-side">
            {current && (
              <CurrentlyLearningCard
                topic={current}
                phaseName={focusPhaseName}
                onContinue={() => handleAction(current, 'learn')}
              />
            )}

            <AiInsightCard insight={aiInsight} hasData={aiInsight != null} />

            {focus && (
              <WhyNextCard target={focus} reason={nextReason} busy={recommending} onStart={() => handleAction(focus, focus.status === 'review-required' ? 'review' : focus.status === 'needs-practice' ? 'practice' : 'learn')} />
            )}

            <SummaryCard
              progress={totals.progress}
              completed={totals.completed}
              total={totals.total}
              avgScore={avgScore}
              review={totals.review}
              practice={totals.practice}
              weakCount={weakConceptCount}
              streak={user.focusStreakDays}
            />
          </aside>
        </div>

        {/* Topic detail dialog */}
        {selected && (
          <TopicDetail topic={selected} onClose={() => setSelectedId(null)} onAction={handleAction} />
        )}

        {/* Toast */}
        {toast && (
          <div className="ai-toast" role="status">
            <IconSparkles size={16} />
            {toast}
          </div>
        )}
      </div>
    </AppLayout>
  )
}