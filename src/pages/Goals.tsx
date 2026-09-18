import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { useApp } from '../context/AppContext'
import { goals as goalCatalog } from '../data/goals'
import { getRoadmapForGoal } from '../data/roadmaps'
import type {
  AiGeneratedRoadmap,
  Difficulty,
  Goal,
  GoalAction,
  GoalExperienceLevel,
  GoalPriority,
  GoalStatus,
  GoalType,
  RoadmapCandidate,
  UserGoal,
} from '../types'
import {
  CATEGORY_LABELS,
  GROUP_LABELS,
  ROADMAP_FILTERS,
  fetchRoadmapCatalog,
  filterCatalog,
  matchesQuery,
  refreshRoadmapCatalog,
} from '../services/roadmapCatalog'
import { createRoadmap } from '../services/aiService'
import {
  computeGoalProgress,
  estimateCompletionDate,
  goalScheduleStatus,
  priorityRank,
  type GoalProgress,
  type GoalScheduleStatus,
} from '../services/goalProgress'
import { GoalError } from '../services/goals'
import {
  IconArchive,
  IconArrowRight,
  IconBook,
  IconBranch,
  IconCalendar,
  IconChart,
  IconCheck,
  IconClock,
  IconCode,
  IconMap,
  IconPalette,
  IconPause,
  IconPen,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconShield,
  IconSparkles,
  IconStar,
  IconTarget,
  IconTrash,
  IconTrend,
  IconUser,
  IconX,
  IconZap,
} from '../components/Icons'

const GROUPS = ['all', 'role-based', 'skill-based', 'ai-ml', 'web-dev', 'languages', 'devops', 'databases', 'computer-science', 'mobile', 'design', 'security', 'other'] as const
type FilterId = (typeof GROUPS)[number]

const levels: ('All' | Difficulty)[] = ['All', 'Beginner', 'Intermediate', 'Advanced']

type IconComponent = ComponentType<{ size?: number }>

const iconMap: Record<string, IconComponent> = {
  'ai-ml': IconSparkles,
  'web-dev': IconCode,
  languages: IconCode,
  devops: IconSettings,
  databases: IconChart,
  'computer-science': IconBranch,
  mobile: IconZap,
  design: IconPalette,
  security: IconShield,
  other: IconBook,
  'role-based': IconUser,
  'skill-based': IconCode,
}

/* ------------------------------------------------------------------ */
/* Goal display metadata                                               */
/* ------------------------------------------------------------------ */

const GOAL_TYPES: { id: GoalType; label: string; hint: string; icon: IconComponent }[] = [
  { id: 'learn-skill', label: 'Learn a new skill', hint: 'Pick up something new, end to end', icon: IconSparkles },
  { id: 'placement', label: 'Placement preparation', hint: 'Aptitude + core subjects for campus drives', icon: IconTarget },
  { id: 'coding-interviews', label: 'Coding interviews', hint: 'DSA and problem-solving practice', icon: IconCode },
  { id: 'university-exams', label: 'University exams', hint: 'Syllabus-focused revision', icon: IconBook },
  { id: 'build-project', label: 'Build a project', hint: 'Learn by shipping something real', icon: IconBranch },
  { id: 'career-prep', label: 'Career preparation', hint: 'Grow toward a target role', icon: IconTrend },
  { id: 'custom', label: 'Custom goal', hint: 'Describe it your own way', icon: IconSettings },
]

const GOAL_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  GOAL_TYPES.map((t) => [t.id, t.label]),
)

const GOAL_TYPE_ICON: Record<string, IconComponent> = Object.fromEntries(
  GOAL_TYPES.map((t) => [t.id, t.icon]),
)

const STATUS_META: Record<GoalStatus, { label: string; badge: string }> = {
  active: { label: 'Active', badge: 'badge-success' },
  paused: { label: 'Paused', badge: 'badge-warning' },
  completed: { label: 'Completed', badge: 'badge-primary' },
  archived: { label: 'Archived', badge: 'badge-muted' },
}

const PRIORITY_META: Record<GoalPriority, { label: string; badge: string }> = {
  high: { label: 'High priority', badge: 'badge-danger' },
  medium: { label: 'Medium priority', badge: 'badge-warning' },
  low: { label: 'Low priority', badge: 'badge-muted' },
}

const SCHEDULE_META: Record<GoalScheduleStatus, { label: string; className: string }> = {
  'on-track': { label: 'On track', className: 'goal-schedule-ok' },
  approaching: { label: 'Approaching deadline', className: 'goal-schedule-warn' },
  behind: { label: 'Behind schedule', className: 'goal-schedule-bad' },
  passed: { label: 'Target date passed', className: 'goal-schedule-bad' },
}

const DAILY_OPTIONS = [15, 30, 45, 60, 120]
const DURATION_OPTIONS = [30, 60, 90]
const EXPERIENCE_OPTIONS: { id: GoalExperienceLevel; label: string; hint: string }[] = [
  { id: 'beginner', label: 'Beginner', hint: 'New to this subject' },
  { id: 'intermediate', label: 'Intermediate', hint: 'I know the basics' },
  { id: 'advanced', label: 'Advanced', hint: 'I want to go deep' },
]
const PRIORITY_OPTIONS: GoalPriority[] = ['low', 'medium', 'high']

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function minutesLabel(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} hr/day`
  return `${minutes} min/day`
}

function topicProgressTone(status: string): string {
  switch (status) {
    case 'completed':
      return 'goal-topic-done'
    case 'needs-practice':
      return 'goal-topic-practice'
    case 'review-required':
      return 'goal-topic-review'
    default:
      return 'goal-topic-todo'
  }
}

function CardIcon({ entry }: { entry: RoadmapCandidate }) {
  const Icon = iconMap[entry.group] ?? iconMap[entry.category] ?? IconTarget
  return (
    <div className="catalog-hero-icon">
      <Icon size={22} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Goal card                                                           */
/* ------------------------------------------------------------------ */

function GoalCard({
  goal,
  progress,
  onContinue,
  onViewRoadmap,
  onManage,
}: {
  goal: UserGoal
  progress: GoalProgress | null
  onContinue: () => void
  onViewRoadmap: () => void
  onManage: () => void
}) {
  const StatusIcon = GOAL_TYPE_ICON[goal.goalType] ?? IconTarget
  const percent = progress?.percent ?? 0
  const schedule = goalScheduleStatus(goal, percent)
  const estimate = estimateCompletionDate(goal, progress)
  const statusMeta = STATUS_META[goal.status]
  const done = progress?.completedTopics ?? 0
  const total = progress?.totalTopics ?? 0

  return (
    <article className={`goal-item goal-item-${goal.status}`}>
      <div className="goal-item-head">
        <div className="goal-item-icon">
          <StatusIcon size={20} />
        </div>
        <div className="goal-item-heading">
          <h3 className="goal-item-title">
            {goal.title}
            {goal.isPrimary && (
              <span className="goal-primary-pill" title="Primary goal">
                <IconStar size={12} /> Primary
              </span>
            )}
          </h3>
          <div className="goal-item-badges">
            <span className="badge badge-primary">
              {GOAL_TYPE_LABELS[goal.goalType] ?? 'Custom goal'}
            </span>
            <span className={`badge ${PRIORITY_META[goal.priority].badge}`}>
              {PRIORITY_META[goal.priority].label}
            </span>
            <span className={`badge ${statusMeta.badge}`}>{statusMeta.label}</span>
          </div>
        </div>
        <button className="btn btn-ghost goal-manage-btn" onClick={onManage} aria-label={`Manage ${goal.title}`}>
          Manage
        </button>
      </div>

      {goal.description && <p className="goal-item-desc">{goal.description}</p>}

      {goal.roadmap ? (
        <>
          <div className="goal-progress-row">
            <div
              className="goal-progress"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${goal.title} progress`}
            >
              <div className="goal-progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <span className="goal-progress-label">
              {done}/{total} topics · {percent}%
            </span>
          </div>

          <div className="goal-item-meta">
            <span className="goal-meta-item">
              <IconBook size={14} />
              {progress?.currentTopic ? (
                <>Next: {progress.currentTopic.name}</>
              ) : (
                <>All topics mastered</>
              )}
            </span>
            <span className="goal-meta-item">
              <IconClock size={14} />
              {minutesLabel(goal.dailyMinutes)}
            </span>
            {goal.targetDate && (
              <span className={`goal-meta-item goal-schedule ${schedule ? SCHEDULE_META[schedule].className : ''}`}>
                <IconCalendar size={14} />
                {formatDate(goal.targetDate)}
                {schedule ? ` · ${SCHEDULE_META[schedule].label}` : ''}
              </span>
            )}
            <span className="goal-meta-item">
              <IconTrend size={14} />
              {estimate
                ? `Est. finish ${formatDate(estimate)}`
                : 'Build more learning history to estimate completion.'}
            </span>
          </div>
        </>
      ) : (
        <div className="goal-no-roadmap">
          <IconRefresh size={15} />
          Roadmap pending — open Manage to generate your personalized plan.
        </div>
      )}

      <div className="goal-item-actions">
        <button
          className="btn btn-primary"
          onClick={onContinue}
          disabled={!goal.roadmap || !progress?.currentTopic}
        >
          Continue Learning
          <IconArrowRight size={15} />
        </button>
        <button className="btn btn-ghost" onClick={onViewRoadmap} disabled={!goal.roadmap}>
          View Roadmap
        </button>
      </div>
    </article>
  )
}

/* ------------------------------------------------------------------ */
/* Goal creation wizard                                                */
/* ------------------------------------------------------------------ */

interface WizardProps {
  onClose: () => void
  onCreated: () => void
  onToast: (message: string) => void
}

function GoalWizard({ onClose, onCreated, onToast }: WizardProps) {
  const { createGoal, userGoals } = useApp()
  const [step, setStep] = useState(1)
  const [phase, setPhase] = useState<'form' | 'generating' | 'error'>('form')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [goalType, setGoalType] = useState<GoalType>('learn-skill')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [experience, setExperience] = useState<GoalExperienceLevel>('beginner')
  const [existingKnowledge, setExistingKnowledge] = useState('')
  const [dailyMinutes, setDailyMinutes] = useState(30)
  const [customMinutes, setCustomMinutes] = useState('')
  const [duration, setDuration] = useState<'30' | '60' | '90' | 'custom'>('90')
  const [customDate, setCustomDate] = useState('')
  const [priority, setPriority] = useState<GoalPriority>('medium')
  const [goalContext, setGoalContext] = useState('')

  const minutes = customMinutes ? Math.min(1440, Math.max(1, Number(customMinutes) || 0)) : dailyMinutes
  const targetDate = duration === 'custom' ? customDate || null : addDays(Number(duration))

  const canContinue =
    step === 1
      ? title.trim().length >= 3
      : step === 2
        ? !!experience
        : step === 3
          ? minutes > 0 && (duration !== 'custom' || (!!customDate && customDate > todayIso()))
          : true

  async function create(withRoadmap: boolean) {
    setSaving(true)
    setError(null)
    setPhase('generating')

    let roadmap: AiGeneratedRoadmap | null = null
    if (withRoadmap) {
      const result = await createRoadmap({
        topic: title.trim(),
        level: experience,
        study_time: minutesLabel(minutes),
        goal: goalContext.trim() || GOAL_TYPE_LABELS[goalType] || 'general learning',
      })
      if (result.state === 'error') {
        setError(
          result.blocked
            ? result.message
            : 'AI roadmap generation is temporarily unavailable. Please try again.',
        )
        setPhase('error')
        setSaving(false)
        return
      }
      roadmap = result.roadmap
    }

    try {
      const created = await createGoal({
        title: title.trim(),
        description: description.trim(),
        goalType,
        priority,
        experienceLevel: experience,
        dailyMinutes: minutes,
        targetDate,
        goalContext: goalContext.trim(),
        existingKnowledge: existingKnowledge.trim(),
        roadmap,
        isPrimary: userGoals.length === 0,
      })
      onToast(
        roadmap
          ? `Your goal is ready! ${created.title} now has a personalized roadmap.`
          : `${created.title} was created.`,
      )
      onCreated()
    } catch (err) {
      setError(err instanceof GoalError ? err.message : 'Could not create your goal. Please try again.')
      setPhase('error')
      setSaving(false)
    }
  }

  const headers = ['What do you want to achieve?', 'What is your experience level?', 'Set your time and target', 'Anything else? (optional)']

  return (
    <div className="ai-modal-backdrop" onClick={saving ? undefined : onClose}>
      <div
        className="ai-modal goal-wizard"
        role="dialog"
        aria-modal="true"
        aria-label="Create a new goal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ai-modal-header">
          <div>
            <span className="kicker">
              <IconSparkles size={12} />
              New goal
            </span>
            <h2 style={{ margin: '0.3rem 0 0', fontSize: '1.4rem' }}>
              {phase === 'generating' ? 'Building your plan' : headers[step - 1]}
            </h2>
          </div>
          <button className="btn btn-ghost" onClick={onClose} disabled={saving} aria-label="Close">
            <IconX size={18} />
          </button>
        </div>

        {phase === 'generating' ? (
          <div className="ai-modal-body goal-generating">
            <div className="goal-spinner" aria-hidden="true" />
            <p className="goal-gen-title">Generating personalized roadmap…</p>
            <p className="small muted" style={{ margin: 0 }}>
              Creating your goal and mapping the topics you need. This can take up to a minute.
            </p>
          </div>
        ) : (
          <>
            <div className="goal-steps" aria-hidden="true">
              {[1, 2, 3, 4].map((n) => (
                <span
                  key={n}
                  className={`goal-step-dot${n === step ? ' active' : ''}${n < step ? ' done' : ''}`}
                >
                  {n < step ? <IconCheck size={12} /> : n}
                </span>
              ))}
            </div>

            <div className="ai-modal-body">
              {error && (
                <div className="banner banner-danger" role="alert">
                  {error}
                </div>
              )}

              {step === 1 && (
                <>
                  <div className="goal-type-grid">
                    {GOAL_TYPES.map((t) => {
                      const Icon = t.icon
                      return (
                        <button
                          key={t.id}
                          type="button"
                          className={`goal-type-option${goalType === t.id ? ' selected' : ''}`}
                          onClick={() => setGoalType(t.id)}
                        >
                          <Icon size={18} />
                          <span className="goal-type-label">{t.label}</span>
                          <span className="goal-type-hint">{t.hint}</span>
                        </button>
                      )
                    })}
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label htmlFor="goal-title">Goal title</label>
                    <input
                      id="goal-title"
                      type="text"
                      placeholder="e.g. Master Java for interviews"
                      value={title}
                      maxLength={200}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label htmlFor="goal-desc">Short description (optional)</label>
                    <textarea
                      id="goal-desc"
                      rows={2}
                      placeholder="What does success look like?"
                      value={description}
                      maxLength={500}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </div>
                </>
              )}

              {step === 2 && (
                <>
                  <p className="small muted" style={{ margin: 0 }}>
                    This sets the depth and pace of your roadmap.
                  </p>
                  <div className="goal-choice-col">
                    {EXPERIENCE_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`goal-choice${experience === opt.id ? ' selected' : ''}`}
                        onClick={() => setExperience(opt.id)}
                      >
                        <span className="goal-choice-label">{opt.label}</span>
                        <span className="goal-choice-hint">{opt.hint}</span>
                      </button>
                    ))}
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label htmlFor="goal-known">
                      Anything you already know? (optional)
                    </label>
                    <textarea
                      id="goal-known"
                      rows={2}
                      placeholder="e.g. I know basic OOP but not collections"
                      value={existingKnowledge}
                      maxLength={500}
                      onChange={(e) => setExistingKnowledge(e.target.value)}
                    />
                  </div>
                </>
              )}

              {step === 3 && (
                <>
                  <div className="form-group">
                    <label>How much time can you study each day?</label>
                    <div className="goal-pill-row">
                      {DAILY_OPTIONS.map((m) => (
                        <button
                          key={m}
                          type="button"
                          className={`pill${!customMinutes && dailyMinutes === m ? ' active' : ''}`}
                          onClick={() => {
                            setDailyMinutes(m)
                            setCustomMinutes('')
                          }}
                        >
                          {m < 60 ? `${m} min` : `${m / 60} hr`}
                        </button>
                      ))}
                      <button
                        type="button"
                        className={`pill${customMinutes ? ' active' : ''}`}
                        onClick={() => setCustomMinutes(String(dailyMinutes))}
                      >
                        Custom
                      </button>
                    </div>
                    {customMinutes !== '' && (
                      <div className="row" style={{ gap: '0.5rem', marginTop: '0.6rem', alignItems: 'center' }}>
                        <input
                          type="number"
                          min={1}
                          max={1440}
                          value={customMinutes}
                          onChange={(e) => setCustomMinutes(e.target.value)}
                          style={{ maxWidth: 120 }}
                          aria-label="Custom minutes per day"
                        />
                        <span className="small muted">minutes per day</span>
                      </div>
                    )}
                  </div>

                  <div className="form-group">
                    <label>Target duration</label>
                    <div className="goal-pill-row">
                      {DURATION_OPTIONS.map((d) => (
                        <button
                          key={d}
                          type="button"
                          className={`pill${duration === String(d) ? ' active' : ''}`}
                          onClick={() => setDuration(String(d) as '30' | '60' | '90')}
                        >
                          {d} days
                        </button>
                      ))}
                      <button
                        type="button"
                        className={`pill${duration === 'custom' ? ' active' : ''}`}
                        onClick={() => setDuration('custom')}
                      >
                        Custom date
                      </button>
                    </div>
                    {duration === 'custom' && (
                      <input
                        type="date"
                        min={todayIso()}
                        value={customDate}
                        onChange={(e) => setCustomDate(e.target.value)}
                        style={{ marginTop: '0.6rem', maxWidth: 220 }}
                        aria-label="Custom target date"
                      />
                    )}
                  </div>

                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label>Priority</label>
                    <div className="goal-pill-row">
                      {PRIORITY_OPTIONS.map((p) => (
                        <button
                          key={p}
                          type="button"
                          className={`pill${priority === p ? ' active' : ''}`}
                          onClick={() => setPriority(p)}
                        >
                          {p[0].toUpperCase() + p.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {step === 4 && (
                <>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label htmlFor="goal-why">Why is this goal important to you? (optional)</label>
                    <textarea
                      id="goal-why"
                      rows={3}
                      placeholder="e.g. I want to clear my placement interviews"
                      value={goalContext}
                      maxLength={500}
                      onChange={(e) => setGoalContext(e.target.value)}
                    />
                  </div>
                  <div className="goal-summary">
                    <div className="goal-summary-row">
                      <span className="muted">Goal</span>
                      <span>{title.trim() || '—'}</span>
                    </div>
                    <div className="goal-summary-row">
                      <span className="muted">Type</span>
                      <span>{GOAL_TYPE_LABELS[goalType]}</span>
                    </div>
                    <div className="goal-summary-row">
                      <span className="muted">Level</span>
                      <span>{experience[0].toUpperCase() + experience.slice(1)}</span>
                    </div>
                    <div className="goal-summary-row">
                      <span className="muted">Daily time</span>
                      <span>{minutesLabel(minutes)}</span>
                    </div>
                    <div className="goal-summary-row">
                      <span className="muted">Target date</span>
                      <span>{targetDate ? formatDate(targetDate) : '—'}</span>
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="ai-modal-footer">
              {step > 1 ? (
                <button className="btn btn-ghost" onClick={() => setStep((s) => s - 1)} disabled={saving}>
                  Back
                </button>
              ) : (
                <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
                  Cancel
                </button>
              )}

              {phase === 'error' ? (
                <>
                  <button className="btn btn-ghost" onClick={() => create(false)} disabled={saving}>
                    Save without roadmap
                  </button>
                  <button className="btn btn-primary" onClick={() => create(true)} disabled={saving}>
                    <IconRefresh size={15} />
                    Try Again
                  </button>
                </>
              ) : step < 4 ? (
                <button
                  className="btn btn-primary"
                  onClick={() => setStep((s) => s + 1)}
                  disabled={!canContinue}
                >
                  Continue
                  <IconArrowRight size={15} />
                </button>
              ) : (
                <button className="btn btn-primary" onClick={() => create(true)} disabled={saving}>
                  <IconSparkles size={15} />
                  Create Goal
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Edit / manage dialogs                                               */
/* ------------------------------------------------------------------ */

function EditGoalModal({
  goal,
  onClose,
  onSaved,
  onToast,
}: {
  goal: UserGoal
  onClose: () => void
  onSaved: () => void
  onToast: (message: string) => void
}) {
  const { updateGoal } = useApp()
  const [title, setTitle] = useState(goal.title)
  const [description, setDescription] = useState(goal.description)
  const [priority, setPriority] = useState<GoalPriority>(goal.priority)
  const [experience, setExperience] = useState<GoalExperienceLevel>(goal.experienceLevel)
  const [dailyMinutes, setDailyMinutes] = useState(goal.dailyMinutes)
  const [targetDate, setTargetDate] = useState(goal.targetDate ?? '')
  const [saving, setSaving] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (title.trim().length < 3) {
      setError('Please enter a goal title with at least 3 characters.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await updateGoal(goal.id, {
        title: title.trim(),
        description: description.trim(),
        priority,
        experienceLevel: experience,
        dailyMinutes: Math.min(1440, Math.max(1, Number(dailyMinutes) || 30)),
        targetDate: targetDate || null,
      })
      onToast('Goal updated.')
      onSaved()
    } catch (err) {
      setError(err instanceof GoalError ? err.message : 'Could not update your goal. Please try again.')
      setSaving(false)
    }
  }

  async function regenerate() {
    setRegenerating(true)
    setError(null)
    const result = await createRoadmap({
      topic: title.trim() || goal.title,
      level: experience,
      study_time: minutesLabel(Math.min(1440, Math.max(1, Number(dailyMinutes) || 30))),
      goal: goal.goalContext || GOAL_TYPE_LABELS[goal.goalType] || 'general learning',
    })
    if (result.state === 'error') {
      setError(
        result.blocked
          ? result.message
          : 'AI roadmap generation is temporarily unavailable. Please try again.',
      )
      setRegenerating(false)
      return
    }
    try {
      await updateGoal(goal.id, { roadmap: result.roadmap })
      onToast('Your roadmap was regenerated.')
      onSaved()
    } catch (err) {
      setError(err instanceof GoalError ? err.message : 'Could not save the new roadmap.')
      setRegenerating(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${goal.title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row-between" style={{ padding: '1.25rem 1.25rem 0' }}>
          <h2 style={{ fontSize: '1.2rem', margin: 0 }}>Edit goal</h2>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close" style={{ padding: '0.4rem' }}>
            <IconX size={18} />
          </button>
        </div>
        <div style={{ padding: '1rem 1.25rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
          {error && (
            <div className="banner banner-danger" role="alert">
              {error}
            </div>
          )}
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor="edit-title">Title</label>
            <input id="edit-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor="edit-desc">Description</label>
            <textarea id="edit-desc" rows={2} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid-2" style={{ gap: '0.8rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="edit-priority">Priority</label>
              <select
                id="edit-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as GoalPriority)}
              >
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {p[0].toUpperCase() + p.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="edit-experience">Level</label>
              <select
                id="edit-experience"
                value={experience}
                onChange={(e) => setExperience(e.target.value as GoalExperienceLevel)}
              >
                {EXPERIENCE_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="edit-minutes">Daily minutes</label>
              <input
                id="edit-minutes"
                type="number"
                min={1}
                max={1440}
                value={dailyMinutes}
                onChange={(e) => setDailyMinutes(Number(e.target.value))}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="edit-target">Target date</label>
              <input
                id="edit-target"
                type="date"
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
              />
            </div>
          </div>
          <div className="row wrap" style={{ gap: '0.6rem', justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={regenerate} disabled={saving || regenerating}>
              <IconRefresh size={15} />
              {regenerating ? 'Regenerating…' : 'Regenerate roadmap'}
            </button>
            <button className="btn btn-primary" onClick={save} disabled={saving || regenerating}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ManageGoalModal({
  goal,
  onClose,
  onEdit,
  onViewRoadmap,
  onAction,
  onDelete,
}: {
  goal: UserGoal
  onClose: () => void
  onEdit: () => void
  onViewRoadmap: () => void
  onAction: (action: GoalAction, message: string) => void
  onDelete: () => void
}) {
  const actions: { key: string; label: string; icon: ReactNode; onClick: () => void; danger?: boolean }[] = []

  if (!goal.isPrimary && goal.status !== 'archived') {
    actions.push({
      key: 'primary',
      label: 'Set as primary goal',
      icon: <IconStar size={16} />,
      onClick: () => onAction('set-primary', 'Primary goal updated.'),
    })
  }
  if (goal.status === 'active') {
    actions.push({
      key: 'pause',
      label: 'Pause goal',
      icon: <IconPause size={16} />,
      onClick: () => onAction('pause', 'Goal paused.'),
    })
    actions.push({
      key: 'complete',
      label: 'Mark as completed',
      icon: <IconCheck size={16} />,
      onClick: () => onAction('complete', 'Congratulations — goal completed!'),
    })
  }
  if (goal.status === 'paused') {
    actions.push({
      key: 'resume',
      label: 'Resume goal',
      icon: <IconPlay size={16} />,
      onClick: () => onAction('resume', 'Goal resumed.'),
    })
  }
  if (goal.status === 'archived') {
    actions.push({
      key: 'restore',
      label: 'Restore goal',
      icon: <IconRefresh size={16} />,
      onClick: () => onAction('restore', 'Goal restored.'),
    })
  } else {
    actions.push({
      key: 'archive',
      label: 'Archive goal',
      icon: <IconArchive size={16} />,
      onClick: () => onAction('archive', 'Goal archived.'),
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card goal-manage-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Manage ${goal.title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row-between" style={{ padding: '1.25rem 1.25rem 0.5rem' }}>
          <div>
            <span className="small muted">Manage goal</span>
            <h2 style={{ fontSize: '1.15rem', margin: '0.15rem 0 0' }}>{goal.title}</h2>
          </div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close" style={{ padding: '0.4rem' }}>
            <IconX size={18} />
          </button>
        </div>
        <div className="goal-action-list">
          <button className="goal-action-item" onClick={onEdit}>
            <IconPen size={16} />
            Edit goal details
          </button>
          <button className="goal-action-item" onClick={onViewRoadmap} disabled={!goal.roadmap}>
            <IconMap size={16} />
            View roadmap
          </button>
          {actions.map((a) => (
            <button key={a.key} className="goal-action-item" onClick={a.onClick}>
              {a.icon}
              {a.label}
            </button>
          ))}
          <button className="goal-action-item goal-action-danger" onClick={onDelete}>
            <IconTrash size={16} />
            Delete goal
          </button>
        </div>
      </div>
    </div>
  )
}

function ConfirmDeleteModal({
  goal,
  onClose,
  onConfirm,
}: {
  goal: UserGoal
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label="Delete goal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 460 }}
      >
        <div style={{ padding: '1.4rem' }}>
          <h2 style={{ fontSize: '1.15rem', margin: '0 0 0.5rem' }}>Delete this goal?</h2>
          <p className="small muted" style={{ margin: 0 }}>
            “{goal.title}” and its roadmap will be permanently removed. Your quiz results
            and learning history stay intact.
          </p>
          <div className="row" style={{ gap: '0.6rem', justifyContent: 'flex-end', marginTop: '1.2rem' }}>
            <button className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-danger" onClick={onConfirm}>
              Delete goal
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function RoadmapViewModal({
  goal,
  progress,
  onClose,
  onTakeQuiz,
}: {
  goal: UserGoal
  progress: GoalProgress | null
  onClose: () => void
  onTakeQuiz: (topic: string) => void
}) {
  return (
    <div className="ai-modal-backdrop" onClick={onClose}>
      <div
        className="ai-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${goal.title} roadmap`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ai-modal-header">
          <div>
            <span className="kicker">
              <IconMap size={12} />
              Roadmap
            </span>
            <h2 style={{ margin: '0.3rem 0 0', fontSize: '1.3rem' }}>{goal.title}</h2>
            {goal.roadmap?.overview && (
              <p className="small muted" style={{ margin: '0.4rem 0 0' }}>
                {goal.roadmap.overview}
              </p>
            )}
          </div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            <IconX size={18} />
          </button>
        </div>
        <div className="ai-modal-body">
          {progress ? (
            <>
              <div className="goal-progress-row">
                <div className="goal-progress" role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100}>
                  <div className="goal-progress-fill" style={{ width: `${progress.percent}%` }} />
                </div>
                <span className="goal-progress-label">
                  {progress.completedTopics}/{progress.totalTopics} mastered
                </span>
              </div>
              {goal.roadmap?.phases.map((phase) => (
                <div key={phase.id} className="goal-roadmap-phase">
                  <h3 className="goal-roadmap-phase-title">{phase.title}</h3>
                  <ul className="goal-roadmap-list">
                    {phase.topics.map((topic) => {
                      const tp = progress.topics.find((t) => t.id === topic.id)
                      return (
                        <li key={topic.id} className={`goal-roadmap-topic ${topicProgressTone(tp?.status ?? 'not-started')}`}>
                          <div className="goal-roadmap-topic-main">
                            <span className="goal-roadmap-dot" aria-hidden="true" />
                            <div>
                              <div className="goal-roadmap-topic-name">{topic.title}</div>
                              {tp?.score !== null && tp?.score !== undefined && (
                                <div className="small muted">Latest score: {tp.score}%</div>
                              )}
                            </div>
                          </div>
                          <button className="btn btn-ghost btn-sm" onClick={() => onTakeQuiz(topic.title)}>
                            Take Quiz
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </>
          ) : (
            <p className="small muted">No roadmap attached to this goal yet.</p>
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Goals() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { activeGoal, selectGoal, attempts, userGoals, goalsLoading, goalsError, deleteGoal, runGoalAction } = useApp()

  /* ── Personal goals state ─────────────────────────────────────────── */
  const [wizardOpen, setWizardOpen] = useState(false)
  const [manageGoal, setManageGoal] = useState<UserGoal | null>(null)
  const [editGoal, setEditGoal] = useState<UserGoal | null>(null)
  const [viewGoal, setViewGoal] = useState<UserGoal | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<UserGoal | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)

  const [goalQuery, setGoalQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | GoalStatus>('all')
  const [priorityFilter, setPriorityFilter] = useState<'all' | GoalPriority>('all')
  const [sort, setSort] = useState<'recent' | 'priority' | 'progress' | 'target'>('recent')

  function showToast(message: string) {
    setToast(message)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 4500)
  }

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
  }, [])

  const progressByGoal = useMemo(() => {
    const map = new Map<string, GoalProgress | null>()
    for (const goal of userGoals) map.set(goal.id, computeGoalProgress(goal, attempts))
    return map
  }, [userGoals, attempts])

  const filteredGoals = useMemo(() => {
    let list = userGoals.filter((g) => statusFilter === 'all' || g.status === statusFilter)
    if (priorityFilter !== 'all') list = list.filter((g) => g.priority === priorityFilter)
    const q = goalQuery.trim().toLowerCase()
    if (q) {
      list = list.filter((g) =>
        [g.title, g.description, g.goalContext].join(' ').toLowerCase().includes(q),
      )
    }
    const sorted = [...list]
    sorted.sort((a, b) => {
      switch (sort) {
        case 'priority':
          return priorityRank(a.priority) - priorityRank(b.priority)
        case 'progress':
          return (progressByGoal.get(b.id)?.percent ?? 0) - (progressByGoal.get(a.id)?.percent ?? 0)
        case 'target': {
          if (!a.targetDate && !b.targetDate) return 0
          if (!a.targetDate) return 1
          if (!b.targetDate) return -1
          return a.targetDate.localeCompare(b.targetDate)
        }
        default:
          return b.createdAt.localeCompare(a.createdAt)
      }
    })
    return sorted
  }, [userGoals, statusFilter, priorityFilter, goalQuery, sort, progressByGoal])

  const stats = useMemo(() => {
    const active = userGoals.filter((g) => g.status === 'active').length
    const completed = userGoals.filter((g) => g.status === 'completed').length
    const paused = userGoals.filter((g) => g.status === 'paused').length
    const withRoadmaps = userGoals.filter((g) => g.roadmap)
    const avg =
      withRoadmaps.length > 0
        ? Math.round(
            withRoadmaps.reduce((sum, g) => sum + (progressByGoal.get(g.id)?.percent ?? 0), 0) /
              withRoadmaps.length,
          )
        : 0
    return { active, completed, paused, total: userGoals.length, avg }
  }, [userGoals, progressByGoal])

  const sections: { status: GoalStatus; title: string; goals: UserGoal[] }[] =
    statusFilter === 'all'
      ? (['active', 'paused', 'completed', 'archived'] as GoalStatus[])
          .map((status) => ({
            status,
            title: STATUS_META[status].label,
            goals: filteredGoals.filter((g) => g.status === status),
          }))
          .filter((s) => s.goals.length > 0)
      : [{ status: statusFilter, title: STATUS_META[statusFilter].label, goals: filteredGoals }]

  function handleContinue(goal: UserGoal) {
    const progress = progressByGoal.get(goal.id)
    const topic = progress?.currentTopic
    if (!topic) {
      showToast('Every topic in this goal is mastered — well done!')
      return
    }
    navigate(`/search?topic=${encodeURIComponent(topic.name)}`)
  }

  function handleTakeGoalQuiz(topic: string) {
    navigate(`/quiz/topic/${encodeURIComponent(topic)}`)
  }

  async function handleAction(goal: UserGoal, action: GoalAction, message: string) {
    try {
      await runGoalAction(goal.id, action)
      showToast(message)
      setManageGoal(null)
    } catch (err) {
      showToast(err instanceof GoalError ? err.message : 'That action failed. Please try again.')
    }
  }

  async function confirmDelete(goal: UserGoal) {
    try {
      await deleteGoal(goal.id)
      showToast('Goal deleted.')
      setDeleteTarget(null)
      setManageGoal(null)
      if (viewGoal?.id === goal.id) setViewGoal(null)
    } catch (err) {
      showToast(err instanceof GoalError ? err.message : 'Could not delete the goal. Please try again.')
    }
  }

  /* ── Existing roadmap.sh catalog state (unchanged) ────────────────── */
  const [catalog, setCatalog] = useState<RoadmapCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [staleNotice, setStaleNotice] = useState<string | null>(null)

  const [query, setQuery] = useState(searchParams.get('q') ?? '')
  const [filter, setFilter] = useState<FilterId>('all')
  const [level, setLevel] = useState<'All' | Difficulty>('All')
  const [detail, setDetail] = useState<RoadmapCandidate | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const resp = await fetchRoadmapCatalog()
      if (cancelled) return
      if (resp.ok) {
        setCatalog(resp.catalog)
        setStale(resp.stale)
        setStaleNotice(resp.sync.notice ?? null)
        setCatalogError(null)
      } else {
        setCatalogError(resp.error ?? 'The roadmap catalog is unavailable right now.')
        setStale(false)
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!detail) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setDetail(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail])

  useEffect(() => {
    const q = searchParams.get('q')
    if (query === (q ?? '')) return
    if (query) setSearchParams({ q: query }, { replace: true })
    else setSearchParams({}, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const filteredRoadmaps = useMemo(() => {
    if (!catalog.length) return catalog
    return filterCatalog(catalog, filter).filter((e) => matchesQuery(e, query))
  }, [catalog, filter, query])

  const curatedShown = useMemo(() => {
    const byLevel = goalCatalog.filter((g) => level === 'All' || g.difficulty === level)
    const q = query.trim().toLowerCase()
    if (!q) return byLevel
    return byLevel.filter((g) =>
      [g.title, g.category, g.description, ...g.skills]
        .join(' ')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .some((t) => t.includes(q) || q.includes(t)),
    )
  }, [level, query])

  async function handleRefresh() {
    setRefreshing(true)
    const resp = await refreshRoadmapCatalog()
    if (resp.ok) {
      setCatalog(resp.catalog)
      setStale(resp.stale)
      setStaleNotice(resp.sync.notice ?? null)
      setCatalogError(null)
    } else {
      setStaleNotice(resp.error ?? 'Could not refresh the catalog right now.')
      setStale(true)
    }
    setRefreshing(false)
  }

  function useAsLearningGoal(entry: RoadmapCandidate) {
    navigate(
      `/ai-roadmap?topic=${encodeURIComponent(entry.title)}` +
        `&source=${encodeURIComponent(entry.source)}` +
        `&sourceUrl=${encodeURIComponent(entry.sourceUrl)}`,
    )
  }

  function handlePick(goal: Goal) {
    selectGoal(goal.id)
    if (getRoadmapForGoal(goal.id)) {
      navigate('/roadmap')
    } else {
      navigate(`/ai-roadmap?topic=${encodeURIComponent(goal.title)}`)
    }
  }

  return (
    <AppLayout>
      <div className="page">
        <div className="page-header">
          <div>
            <span className="kicker">
              <IconTarget size={12} />
              My Goals
            </span>
            <h1>My Goals</h1>
            <p>Create goals, get a personalized roadmap, and track real progress.</p>
          </div>
          <div className="page-header-actions">
            <button type="button" className="btn btn-primary" onClick={() => setWizardOpen(true)}>
              <IconPlus size={15} />
              Create New Goal
            </button>
          </div>
        </div>

        {/* Personal goals */}
        {goalsLoading && userGoals.length === 0 ? (
          <div className="goal-grid-cards">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="card goal-item">
                <div className="skeleton skeleton-line" style={{ width: '45%' }} />
                <div className="skeleton skeleton-line mt-2" />
                <div className="skeleton skeleton-line" style={{ width: '80%' }} />
              </div>
            ))}
          </div>
        ) : goalsError && userGoals.length === 0 ? (
          <div className="card empty-state">
            <IconTarget size={32} />
            <h3 style={{ margin: '0.2rem 0 0.4rem' }}>Could not load your goals</h3>
            <p>{goalsError}</p>
          </div>
        ) : userGoals.length === 0 ? (
          <div className="card empty-state goal-empty">
            <IconSparkles size={34} />
            <h2 style={{ margin: '0.2rem 0 0.4rem', fontSize: '1.25rem' }}>Create your first goal</h2>
            <p>
              Tell us what you want to learn and we will generate a personalized roadmap,
              then track your progress as you take quizzes.
            </p>
            <button className="btn btn-primary mt-1" onClick={() => setWizardOpen(true)}>
              <IconPlus size={15} />
              Create Your First Goal
            </button>
          </div>
        ) : (
          <>
            <div className="goal-hero-stats">
              <div className="goal-stat">
                <span className="goal-stat-value">{stats.active}</span>
                <span className="goal-stat-label">Active</span>
              </div>
              <div className="goal-stat">
                <span className="goal-stat-value">{stats.paused}</span>
                <span className="goal-stat-label">Paused</span>
              </div>
              <div className="goal-stat">
                <span className="goal-stat-value">{stats.completed}</span>
                <span className="goal-stat-label">Completed</span>
              </div>
              <div className="goal-stat">
                <span className="goal-stat-value">{stats.avg}%</span>
                <span className="goal-stat-label">Avg. progress</span>
              </div>
            </div>

            <div className="goal-toolbar card">
              <div className="goal-toolbar-search">
                <IconSearch size={17} />
                <input
                  type="text"
                  placeholder="Search my goals…"
                  value={goalQuery}
                  onChange={(e) => setGoalQuery(e.target.value)}
                  aria-label="Search my goals"
                />
              </div>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'all' | GoalStatus)}
                aria-label="Filter by status"
              >
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="completed">Completed</option>
                <option value="archived">Archived</option>
              </select>
              <select
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value as 'all' | GoalPriority)}
                aria-label="Filter by priority"
              >
                <option value="all">All priorities</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as 'recent' | 'priority' | 'progress' | 'target')}
                aria-label="Sort goals"
              >
                <option value="recent">Newest first</option>
                <option value="priority">Priority</option>
                <option value="progress">Progress</option>
                <option value="target">Target date</option>
              </select>
            </div>

            {sections.length === 0 ? (
              <div className="card empty-state">
                <IconSearch size={30} />
                <p>
                  No goals matched your filters. Try a different search or clear the filters.
                </p>
              </div>
            ) : (
              sections.map((section) => (
                <section key={section.status} className="goal-section">
                  <div className="goal-section-head">
                    <h2>
                      {section.title}
                      <span className="goal-section-count">{section.goals.length}</span>
                    </h2>
                  </div>
                  <div className="goal-grid-cards">
                    {section.goals.map((goal) => (
                      <GoalCard
                        key={goal.id}
                        goal={goal}
                        progress={progressByGoal.get(goal.id) ?? null}
                        onContinue={() => handleContinue(goal)}
                        onViewRoadmap={() => setViewGoal(goal)}
                        onManage={() => setManageGoal(goal)}
                      />
                    ))}
                  </div>
                </section>
              ))
            )}
          </>
        )}

        {/* Divider before the discovery catalog */}
        <div className="mt-3" style={{ borderTop: '1px solid var(--border)', paddingTop: '1.5rem' }}>
          <h2 style={{ fontSize: '1.2rem', margin: '0 0 0.25rem' }}>Discover a proven path</h2>
          <p className="small muted mb-2">
            Browse curated roadmaps and roadmap.sh topics — turn any of them into an AI goal.
          </p>
        </div>

        {/* Stale/fallback banner */}
        {stale && (
          <div className="banner banner-warning mb-2">
            <span>{staleNotice ?? 'Roadmap catalog temporarily unavailable. Showing the last available catalog.'}</span>
          </div>
        )}

        {/* Search + count */}
        <div
          className="card mb-2"
          style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem', padding: '0.7rem 1rem', alignItems: 'center' }}
        >
          <div className="form-group" style={{ flex: 1, minWidth: 240, marginBottom: 0, position: 'relative' }}>
            <div style={{ position: 'absolute', left: '0.85rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--faint)', display: 'flex' }}>
              <IconSearch size={18} />
            </div>
            <input
              type="text"
              placeholder="Search roadmaps…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ paddingLeft: '2.4rem' }}
            />
          </div>
          {!loading && !catalogError && (
            <span className="small muted" style={{ alignSelf: 'center' }}>
              {filteredRoadmaps.length} roadmap{filteredRoadmaps.length === 1 ? '' : 's'}
              {stale ? ' (cached)' : ''}
            </span>
          )}
        </div>

        {/* Category filter pills */}
        <div className="goal-filter-pills">
          {ROADMAP_FILTERS.map((f) => (
            <button
              key={f.id}
              className={`pill${filter === f.id ? ' active' : ''}`}
              onClick={() => setFilter(f.id as FilterId)}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Catalog cards */}
        {loading ? (
          <div className="goal-grid">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="card goal-card">
                <div className="row" style={{ gap: '0.7rem' }}>
                  <div className="skeleton" style={{ width: 44, height: 44, borderRadius: 12 }} />
                  <div style={{ flex: 1 }}>
                    <div className="skeleton skeleton-line" style={{ width: '70%' }} />
                    <div className="skeleton skeleton-line short" />
                  </div>
                </div>
                <div className="skeleton skeleton-line mt-2" />
                <div className="skeleton skeleton-line" style={{ width: '85%' }} />
                <div className="skeleton skeleton-line short" />
              </div>
            ))}
          </div>
        ) : catalogError ? (
          <div className="card empty-state">
            <IconMap size={34} />
            <h3 style={{ margin: '0.2rem 0 0.4rem' }}>Catalog unavailable</h3>
            <p>{catalogError}</p>
            <button className="btn btn-primary mt-1" onClick={handleRefresh} disabled={refreshing}>
              {refreshing ? 'Retrying…' : 'Try again'}
            </button>
          </div>
        ) : filteredRoadmaps.length === 0 ? (
          <div className="card empty-state">
            <IconSearch size={30} />
            <p>No roadmaps matched "{query}" in this category. Try another search.</p>
          </div>
        ) : (
          <div className="goal-grid">
            {filteredRoadmaps.map((entry) => (
              <div
                key={entry.id}
                className="card card-hover goal-card"
                onClick={() => setDetail(entry)}
              >
                <div className="goal-card-body">
                  <div className="row" style={{ gap: '0.7rem', marginBottom: '0.6rem' }}>
                    <CardIcon entry={entry} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <h3 className="card-title" style={{ marginBottom: '0.25rem' }}>
                        {entry.title}
                      </h3>
                      <div className="row wrap" style={{ gap: '0.3rem' }}>
                        <span className="badge badge-primary">{CATEGORY_LABELS[entry.category] ?? entry.category}</span>
                        {GROUP_LABELS[entry.group] && (
                          <span className="badge badge-muted">{GROUP_LABELS[entry.group]}</span>
                        )}
                        {entry.isNew && <span className="badge badge-success">New</span>}
                      </div>
                    </div>
                  </div>
                  <p className="goal-card-desc">{entry.description}</p>
                </div>
                <div className="goal-card-actions">
                  <button
                    className="btn btn-ghost"
                    onClick={(e) => {
                      e.stopPropagation()
                      setDetail(entry)
                    }}
                  >
                    Preview
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={(e) => {
                      e.stopPropagation()
                      useAsLearningGoal(entry)
                    }}
                  >
                    Use as Learning Goal
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Divider + refresh */}
        {!loading && !catalogError && catalog.length > 0 && (
          <div className="row-between mt-3 mb-1 wrap" style={{ gap: '0.6rem' }}>
            <p className="small muted" style={{ margin: 0 }}>
              The catalog refreshes automatically. You can also refresh it manually anytime.
            </p>
            <button className="btn btn-ghost" onClick={handleRefresh} disabled={refreshing}>
              {refreshing ? 'Refreshing…' : 'Refresh catalog'}
            </button>
          </div>
        )}

        {/* FocusLearn curated paths */}
        <div className="mt-3" style={{ borderTop: '1px solid var(--border)', paddingTop: '1.5rem' }}>
          <h2 style={{ fontSize: '1.2rem', margin: '0 0 0.25rem' }}>FocusLearn curated paths</h2>
          <p className="small muted mb-2">Pre-built roadmaps reviewed by the FocusLearn team — no external source required.</p>

          <div className="goal-filter-pills" style={{ marginTop: '0', marginBottom: '1.2rem' }}>
            {levels.map((lv) => (
              <button
                key={lv}
                className={`pill${level === lv ? ' active' : ''}`}
                onClick={() => setLevel(lv)}
              >
                {lv}
              </button>
            ))}
          </div>

          {curatedShown.length > 0 ? (
            <div className="goal-grid">
              {curatedShown.map((goal) => {
                const isActive = activeGoal?.id === goal.id
                const hasRoadmap = !!getRoadmapForGoal(goal.id)
                return (
                  <div
                    key={goal.id}
                    className={`card card-hover goal-card${isActive ? ' active' : ''}`}
                    style={isActive ? { borderColor: 'var(--primary)', boxShadow: '0 0 0 3px var(--primary-soft)' } : undefined}
                    onClick={() => handlePick(goal)}
                  >
                    <div className="goal-card-body">
                      <div className="row-between mb-1">
                        <span className="badge badge-primary">{goal.category}</span>
                        {isActive && <span className="badge badge-success">Active</span>}
                      </div>
                      <h3 className="card-title">{goal.title}</h3>
                      <p className="card-desc" style={{ minHeight: 40, marginBottom: '0.4rem' }}>
                        {goal.description}
                      </p>
                      <div className="row wrap" style={{ gap: '0.35rem' }}>
                        {goal.skills.slice(0, 3).map((s) => (
                          <span key={s} className="badge badge-muted">
                            {s}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="goal-card-level" style={{ marginTop: '0.8rem' }}>
                      <IconClock size={14} />
                      ~{goal.estimatedWeeks} weeks
                      <span className="badge badge-primary">{goal.difficulty}</span>
                    </div>
                    <div className="goal-card-actions">
                      <span className="row dash-reco-go" style={{ alignSelf: 'center' }}>
                        {hasRoadmap ? 'Start' : 'Build with AI'}
                        <IconArrowRight size={15} />
                      </span>
                      <button
                        className="btn btn-primary"
                        onClick={(e) => {
                          e.stopPropagation()
                          handlePick(goal)
                        }}
                      >
                        Use as Learning Goal
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="card empty-state">
              <IconTarget size={32} />
              <p>No curated goals matched "{query}".</p>
            </div>
          )}
        </div>
      </div>

      {/* Roadmap detail modal (catalog) */}
      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={detail.title}>
            <div className="row-between" style={{ alignItems: 'flex-start', padding: '1.25rem 1.25rem 0' }}>
              <div className="row" style={{ gap: '0.8rem', alignItems: 'flex-start' }}>
                <CardIcon entry={detail} />
                <div>
                  <h2 style={{ fontSize: '1.3rem', margin: 0 }}>{detail.title}</h2>
                  <div className="row wrap mt-1" style={{ gap: '0.3rem' }}>
                    <span className="badge badge-primary">{CATEGORY_LABELS[detail.category] ?? detail.category}</span>
                    {GROUP_LABELS[detail.group] && <span className="badge badge-muted">{GROUP_LABELS[detail.group]}</span>}
                    {detail.isNew && <span className="badge badge-success">New</span>}
                  </div>
                </div>
              </div>
              <button className="btn btn-ghost" onClick={() => setDetail(null)} aria-label="Close" style={{ padding: '0.4rem' }}>
                <IconX size={18} />
              </button>
            </div>

            <div style={{ padding: '0.5rem 1.25rem 1.25rem' }}>
              <p className="card-desc">{detail.description}</p>

              <div className="grid-2 mt-2" style={{ gap: '0.5rem' }}>
                <div className="small">
                  <div className="muted">Source</div>
                  <div>{detail.source}</div>
                </div>
                <div className="small">
                  <div className="muted">Category</div>
                  <div>{CATEGORY_LABELS[detail.category] ?? detail.category}</div>
                </div>
                {detail.lastChecked && (
                  <div className="small">
                    <div className="muted">Last checked</div>
                    <div>{new Date(detail.lastChecked).toLocaleDateString()}</div>
                  </div>
                )}
                <div className="small">
                  <div className="muted">Set as</div>
                  <div>AI-generated FocusLearn roadmap</div>
                </div>
              </div>

              <div className="row wrap mt-3" style={{ gap: '0.6rem' }}>
                <button className="btn btn-primary" onClick={() => useAsLearningGoal(detail)}>
                  Use this as my learning goal
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Personal goal dialogs */}
      {wizardOpen && (
        <GoalWizard
          onClose={() => setWizardOpen(false)}
          onCreated={() => setWizardOpen(false)}
          onToast={showToast}
        />
      )}
      {manageGoal && !editGoal && !deleteTarget && !viewGoal && (
        <ManageGoalModal
          goal={manageGoal}
          onClose={() => setManageGoal(null)}
          onEdit={() => setEditGoal(manageGoal)}
          onViewRoadmap={() => setViewGoal(manageGoal)}
          onAction={(action, message) => handleAction(manageGoal, action, message)}
          onDelete={() => setDeleteTarget(manageGoal)}
        />
      )}
      {editGoal && (
        <EditGoalModal
          goal={editGoal}
          onClose={() => setEditGoal(null)}
          onSaved={() => setEditGoal(null)}
          onToast={showToast}
        />
      )}
      {viewGoal && (
        <RoadmapViewModal
          goal={viewGoal}
          progress={progressByGoal.get(viewGoal.id) ?? null}
          onClose={() => setViewGoal(null)}
          onTakeQuiz={handleTakeGoalQuiz}
        />
      )}
      {deleteTarget && (
        <ConfirmDeleteModal
          goal={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => confirmDelete(deleteTarget)}
        />
      )}

      {toast && (
        <div className="ai-toast" role="status">
          <IconCheck size={16} />
          {toast}
        </div>
      )}
    </AppLayout>
  )
}
