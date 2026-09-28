import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { useApp } from '../context/AppContext'
import {
  DAILY_TARGET_OPTIONS,
  addDays,
  buildCandidates,
  buildPlan,
  buildWeek,
  computeStats,
  dayLabel,
  daysBetween,
  reconcileWithActivity,
  requestAiPlan,
  taskRoute,
  todayKey,
  todaysFocus,
  upcomingTasks,
  weakTopicTitles,
} from '../services/studyPlan'
import type { StudyPlanDay, StudyPlanPreview, StudyTask, StudyTaskKind } from '../types'
import {
  IconBook,
  IconCalendar,
  IconCheck,
  IconClock,
  IconPause,
  IconPlay,
  IconQuiz,
  IconRefresh,
  IconSparkles,
  IconTarget,
  IconTrend,
  IconX,
} from '../components/Icons'

function kindIcon(kind: StudyTaskKind) {
  if (kind === 'quiz') return <IconQuiz size={14} />
  if (kind === 'review') return <IconBook size={14} />
  return <IconPlay size={13} />
}

const KIND_LABEL: Record<StudyTaskKind, string> = {
  lesson: 'Lesson',
  quiz: 'Quiz',
  review: 'Review',
}

function priorityLabel(priority: StudyTask['priority']): string {
  return priority === 'high' ? 'High' : priority === 'medium' ? 'Medium' : 'Low'
}

function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function StudyPlan() {
  const navigate = useNavigate()
  const {
    primaryGoal,
    roadmap,
    completedLessonIds,
    attempts,
    focusMinutesByDay,
    logFocusSession,
    studyPlan,
    patchStudyPlan,
    setDailyTargetMinutes,
    applyStudyPlanPreview,
    discardStudyPlanPreview,
  } = useApp()

  const today = todayKey()
  const weakTopics = useMemo(() => weakTopicTitles(attempts), [attempts])
  const candidates = useMemo(() => buildCandidates(roadmap, weakTopics), [roadmap, weakTopics])

  // Real goal inputs: the goal's own target date drives deadline pressure.
  const goalTitle = primaryGoal?.title ?? 'Improve my technical skills'
  const targetDate = primaryGoal?.targetDate ?? null
  const daysToTarget = targetDate ? daysBetween(today, targetDate) : null

  /* ------------------------------------------------------------------ */
  /* Plan: persisted, reconciled with real activity                     */
  /* ------------------------------------------------------------------ */

  // The stored plan is refreshed whenever the real inputs change (roadmap
  // advanced, target edited, new quiz attempt, new day) so the week never
  // shows work that is already finished or work whose prerequisites changed.
  // `today` is a real input, not an output: the persisted task count must NOT
  // feed back into this key, or writing the plan would re-trigger the rebuild
  // forever and the missed list would grow unbounded on every pass.
  const planKey = [
    roadmap?.id ?? 'none',
    studyPlan.dailyTargetMinutes,
    completedLessonIds.length,
    attempts.length,
    weakTopics.join('|'),
    today,
  ].join('~')

  useEffect(() => {
    if (!roadmap) return
    const next = buildPlan({
      candidates,
      completedLessonIds,
      attempts,
      focusMinutesByDay,
      dailyTargetMinutes: studyPlan.dailyTargetMinutes,
      today,
      daysUntilTarget: daysToTarget,
      previousTasks: studyPlan.tasks,
    })
    if (JSON.stringify(next) === JSON.stringify(studyPlan.tasks)) return
    // Merge onto the latest state, never replace it: building from the captured
    // closure here could wipe a daily target that changed in the same batch.
    patchStudyPlan({ tasks: next, updatedAt: new Date().toISOString() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey])

  // Real completion is derived from real activity on every render, so a lesson
  // finished in Focus Mode shows as Done here without any extra bookkeeping.
  const tasks = useMemo(
    () =>
      reconcileWithActivity(studyPlan.tasks, {
        completedLessonIds,
        attempts,
        focusMinutesByDay,
        today,
      }),
    [studyPlan.tasks, completedLessonIds, attempts, focusMinutesByDay, today],
  )

  const week = useMemo(() => buildWeek(tasks, today), [tasks, today])
  const stats = useMemo(() => computeStats(week), [week])
  const focusTask = useMemo(() => todaysFocus(week), [week])
  const todayDay = week.find((d) => d.isToday)
  const upcoming = useMemo(() => upcomingTasks(week, 3), [week])
  const missed = useMemo(
    () => week.flatMap((d) => d.tasks.filter((t) => t.status === 'missed')),
    [week],
  )

  /* ------------------------------------------------------------------ */
  /* Actions                                                             */
  /* ------------------------------------------------------------------ */

  const replaceTasks = useCallback(
    (next: StudyTask[]) => {
      // Merge, don't replace: a daily target that changed in the same batch
      // must survive. Reading the whole plan from `studyPlan` here would
      // re-save the stale target (the exact bug that froze the selector at 25).
      patchStudyPlan({ tasks: next, updatedAt: new Date().toISOString() })
    },
    [patchStudyPlan],
  )

  /** Move a task to a specific day, respecting the daily target. */
  const rescheduleTo = useCallback(
    (task: StudyTask, targetDate: string) => {
      const moved: StudyTask = {
        ...task,
        date: targetDate,
        rescheduledFrom: task.rescheduledFrom ?? task.date,
        reason: task.reason ?? 'Rescheduled by you',
        status: 'planned',
        actualMinutes: 0,
        completedAt: undefined,
      }
      replaceTasks(
        tasks.map((t) => (t.id === task.id ? moved : t)).filter((t) => t.status !== 'missed'),
      )
    },
    [replaceTasks, tasks],
  )

  /**
   * Rebuild the week from real data right now. Pass `targetMinutes` when the
   * target itself changed — the state update has not landed yet at that point,
   * so reading it from context here would replan against the old value.
   */
  const replanWeek = useCallback(
    (targetMinutes?: number) => {
      const target = targetMinutes ?? studyPlan.dailyTargetMinutes
      replaceTasks(
        buildPlan({
          candidates,
          completedLessonIds,
          attempts,
          focusMinutesByDay,
          dailyTargetMinutes: target,
          today,
          daysUntilTarget: daysToTarget,
          previousTasks: tasks,
        }),
      )
    },
    [
      candidates,
      completedLessonIds,
      attempts,
      focusMinutesByDay,
      studyPlan.dailyTargetMinutes,
      today,
      daysToTarget,
      replaceTasks,
      tasks,
    ],
  )

  /* ------------------------------------------------------------------ */
  /* AI study assistant                                                  */
  /* ------------------------------------------------------------------ */

  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  const runAssistant = useCallback(
    async (mode: 'today' | 'week') => {
      setAiLoading(true)
      setAiError(null)
      try {
        const preview: StudyPlanPreview = await requestAiPlan({
          goalTitle,
          targetDate,
          dailyTargetMinutes: studyPlan.dailyTargetMinutes,
          today,
          completedLessonIds,
          attempts: attempts.map((a) => ({
            topic: a.topicName ?? a.lessonId,
            percentage: a.percentage,
          })),
          weakTopics,
          candidates,
          missedCount: missed.length,
          mode,
        })
        if (preview.tasks.length === 0) {
          setAiError('Nothing left to plan — you are all caught up.')
          return
        }
        // The AI returns an ordering; it is a PREVIEW until the student applies it.
        patchStudyPlan({ pendingPreview: preview })
      } catch (err) {
        // The AI is a helper, never a dependency: the rules plan is already live.
        setAiError(err instanceof Error ? err.message : 'The study assistant is unavailable.')
      } finally {
        setAiLoading(false)
      }
    },
    [
      goalTitle,
      targetDate,
      studyPlan,
      today,
      completedLessonIds,
      attempts,
      weakTopics,
      candidates,
      missed.length,
    ],
  )

  /* ------------------------------------------------------------------ */
  /* Focus timer (real minutes only)                                     */
  /* ------------------------------------------------------------------ */

  const [timerTaskId, setTimerTaskId] = useState<string | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(25 * 60)
  const [timerRunning, setTimerRunning] = useState(false)
  const timerRef = useRef<number | null>(null)

  const timerTask = useMemo(
    () => tasks.find((t) => t.id === timerTaskId) ?? null,
    [tasks, timerTaskId],
  )

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    setTimerRunning(false)
  }, [])

  const closeTimer = useCallback(() => {
    stopTimer()
    setTimerTaskId(null)
  }, [stopTimer])

  /** Timer finished: log the real minutes so the plan reflects reality. */
  const completeTimer = useCallback(() => {
    const task = tasks.find((t) => t.id === timerTaskId)
    stopTimer()
    if (task) {
      const spent = Math.max(1, Math.round(task.estimatedMinutes))
      logFocusSession(spent)
      replaceTasks(
        tasks.map((t) =>
          t.id === task.id
            ? { ...t, status: 'planned', actualMinutes: t.actualMinutes + spent }
            : t,
        ),
      )
    }
    setTimerTaskId(null)
  }, [tasks, timerTaskId, stopTimer, logFocusSession, replaceTasks])

  // Real countdown. Ticks only while running; pauses cleanly.
  useEffect(() => {
    if (!timerRunning) return
    timerRef.current = window.setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          window.clearInterval(timerRef.current!)
          timerRef.current = null
          setTimerRunning(false)
          completeTimer()
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [timerRunning, completeTimer])

  const startTimer = (task: StudyTask) => {
    setTimerTaskId(task.id)
    setSecondsLeft(Math.max(5, task.estimatedMinutes) * 60)
    setTimerRunning(false)
  }

  // Navigating into a lesson/quiz page is the real "start" for those kinds.
  const startTask = (task: StudyTask) => {
    if (task.kind === 'review') {
      startTimer(task)
      return
    }
    const lessonTitle =
      roadmap?.steps.flatMap((s) => s.lessons).find((l) => l.id === task.ref)?.title
    navigate(taskRoute(task, lessonTitle))
  }

  /* ------------------------------------------------------------------ */
  /* Render: no roadmap yet                                              */
  /* ------------------------------------------------------------------ */

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

  const preview = studyPlan.pendingPreview

  return (
    <AppLayout>
      <div className="page">
        <div className="page-header">
          <h1>Study Plan</h1>
          <p>
            Paced to your {studyPlan.dailyTargetMinutes}-minute daily goal, built from your real
            roadmap, quizzes and focus time.
          </p>
        </div>

        {/* ── Daily target ─────────────────────────────────────── */}
        <div className="card mb-2">
          <div className="row-between wrap mb-1">
            <h2 style={{ fontSize: '1.05rem' }}>
              <IconTarget size={15} /> Daily Study Target
            </h2>
            <span className="badge badge-muted">
              <IconClock size={12} />
              {stats.actualMinutes}/{stats.plannedMinutes} min this week
            </span>
          </div>
          <p className="small muted mb-1">
            Pick how much time you can genuinely give. Your whole week re-plans to match.
          </p>
          <div className="target-picker" role="group" aria-label="Daily study target">
            {DAILY_TARGET_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                className={`target-chip${
                  studyPlan.dailyTargetMinutes === option ? ' active' : ''
                }`}
                aria-pressed={studyPlan.dailyTargetMinutes === option}
                onClick={() => {
                  setDailyTargetMinutes(option)
                  replanWeek(option)
                }}
              >
                {option}
                <span className="target-chip-unit">min</span>
              </button>
            ))}
          </div>
        </div>

        {/* ── Today's focus ───────────────────────────────────── */}
        <div className="card focus-card mb-2">
          <div className="row-between wrap mb-1">
            <h2 style={{ fontSize: '1.05rem' }}>
              <IconSparkles size={15} /> Today&rsquo;s Focus
            </h2>
            {todayDay && todayDay.actualMinutes > 0 && (
              <span className="badge badge-success">
                <IconCheck size={12} />
                {todayDay.actualMinutes} min done today
              </span>
            )}
          </div>

          {focusTask ? (
            <>
              <div className="focus-task">
                <span className="focus-kind">{KIND_LABEL[focusTask.kind]}</span>
                <h3 className="focus-title">{focusTask.title}</h3>
                {focusTask.reason && <p className="focus-reason">{focusTask.reason}</p>}
                <div className="focus-meta">
                  <span className="badge badge-primary">
                    <IconClock size={12} />
                    {focusTask.estimatedMinutes} min
                  </span>
                  <span
                    className={`badge ${
                      focusTask.priority === 'high'
                        ? 'badge-danger'
                        : focusTask.priority === 'medium'
                          ? 'badge-primary'
                          : 'badge-muted'
                    }`}
                  >
                    {priorityLabel(focusTask.priority)} priority
                  </span>
                  {focusTask.rescheduledFrom && (
                    <span className="badge badge-muted">
                      <IconRefresh size={12} /> Rescheduled
                    </span>
                  )}
                </div>
                <div className="row wrap gap-1 mt-1">
                  <button className="btn btn-primary" onClick={() => startTask(focusTask)}>
                    <IconPlay size={13} /> Start now
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      replanWeek()
                    }}
                  >
                    <IconRefresh size={13} /> Replan My Week
                  </button>
                  <button
                    className="btn btn-ghost"
                    disabled={aiLoading}
                    onClick={() => runAssistant('today')}
                  >
                    <IconSparkles size={13} /> {aiLoading ? 'Planning…' : 'Plan My Day with AI'}
                  </button>
                </div>
              </div>

              {todayDay && todayDay.tasks.length > 1 && (
                <div className="col" style={{ gap: '0.4rem', marginTop: '0.8rem' }}>
                  {todayDay.tasks
                    .filter((t) => t.id !== focusTask.id)
                    .map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        onStart={() => startTask(task)}
                        onReschedule={(date) => rescheduleTo(task, date)}
                      />
                    ))}
                </div>
              )}
            </>
          ) : (
            <div className="empty-inline">
              <IconCheck size={20} />
              <p className="small muted mb-1">
                {todayDay && todayDay.tasks.length > 0
                  ? 'Everything planned for today is finished. Nice work.'
                  : 'Nothing scheduled today. Try Replan My Week to fill the week from your roadmap.'}
              </p>
              <button className="btn btn-ghost" onClick={() => replanWeek()}>
                <IconRefresh size={13} /> Replan My Week
              </button>
            </div>
          )}

          {aiError && (
            <p className="small plan-error mt-1">
              <IconX size={12} /> {aiError} Your existing plan is unaffected.
            </p>
          )}
        </div>

        {/* ── AI preview ──────────────────────────────────────── */}
        {preview && (
          <div className="card preview-card mb-2">
            <div className="row-between wrap mb-1">
              <h2 style={{ fontSize: '1.05rem' }}>
                <IconSparkles size={15} /> Suggested Plan
              </h2>
              <span className="badge badge-focus">AI · not applied yet</span>
            </div>
            {preview.summary && <p className="small muted mb-1">{preview.summary}</p>}
            <div className="col" style={{ gap: '0.35rem' }}>
              {preview.tasks.map((task) => (
                <div key={task.id} className="plan-row is-preview">
                  <span className="plan-check">{kindIcon(task.kind)}</span>
                  <span className="plan-title">{task.title}</span>
                  <span className="badge badge-muted">
                    <IconClock size={12} />
                    {task.estimatedMinutes} min
                  </span>
                  <span className="badge badge-muted">{dayLabel(task.date)}</span>
                </div>
              ))}
            </div>
            <div className="row gap-1 mt-1">
              <button
                className="btn btn-primary"
                onClick={() => {
                  applyStudyPlanPreview(preview)
                  navigate('/study-plan')
                }}
              >
                <IconCheck size={13} /> Apply this plan
              </button>
              <button className="btn btn-ghost" onClick={discardStudyPlanPreview}>
                Discard
              </button>
            </div>
          </div>
        )}

        {/* ── Study statistics ─────────────────────────────────── */}
        <div className="card mb-2">
          <div className="row-between wrap mb-1">
            <h2 style={{ fontSize: '1.05rem' }}>
              <IconTrend size={15} /> Study Statistics
            </h2>
            <span className="badge badge-primary">{stats.completionPercent}% complete</span>
          </div>
          <div className="stat-grid">
            <StatTile
              label="Planned"
              value={`${stats.plannedMinutes}m`}
              hint="this week"
            />
            <StatTile
              label="Completed"
              value={`${stats.actualMinutes}m`}
              hint={`of ${stats.plannedMinutes}m planned`}
              tone="good"
            />
            <StatTile
              label="Lessons"
              value={`${stats.lessonsDone}/${stats.lessonsTotal}`}
              hint="finished"
            />
            <StatTile
              label="Quizzes"
              value={`${stats.quizzesDone}/${stats.quizzesTotal}`}
              hint="attempted"
            />
            <StatTile
              label="Missed"
              value={String(missed.length)}
              hint={missed.length > 0 ? 'rescheduled for you' : 'nothing missed'}
              tone={missed.length > 0 ? 'warn' : 'good'}
            />
          </div>
        </div>

        {/* ── This week ───────────────────────────────────────── */}
        <div className="card mb-2">
          <div className="row-between wrap mb-1">
            <h2 style={{ fontSize: '1.05rem' }}>
              <IconCalendar size={15} /> This Week
            </h2>
            <button className="btn btn-ghost" onClick={() => replanWeek()}>
              <IconRefresh size={13} /> Replan
            </button>
          </div>
          <div className="progress-track mb-2">
            <div
              className="progress-fill"
              style={{ width: `${stats.completionPercent}%` }}
            />
          </div>
          <div className="week-grid">
            {week.map((day) => (
              <WeekCell
                key={day.date}
                day={day}
                onReschedule={(task, date) => rescheduleTo(task, date)}
              />
            ))}
          </div>
        </div>

        {/* ── Missed sessions ─────────────────────────────────── */}
        {missed.length > 0 && (
          <div className="card mb-2">
            <div className="row-between wrap mb-1">
              <h2 style={{ fontSize: '1.05rem' }}>Missed Sessions</h2>
              <span className="badge badge-danger">{missed.length} missed</span>
            </div>
            <p className="small muted mb-1">
              Nothing is lost — pick a new day, or reschedule everything and keep the reason.
            </p>
            <div className="col" style={{ gap: '0.4rem' }}>
              {missed.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  onStart={() => startTask(task)}
                  onReschedule={(date) => rescheduleTo(task, date)}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── Coming up ───────────────────────────────────────── */}
        {upcoming.length > 0 && (
          <div className="card">
            <div className="row-between wrap mb-1">
              <h2 style={{ fontSize: '1.05rem' }}>Coming Up</h2>
              <span className="badge badge-muted">Next {upcoming.length}</span>
            </div>
            <div className="col" style={{ gap: '0.4rem' }}>
              {upcoming.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  onStart={() => startTask(task)}
                  onReschedule={(date) => rescheduleTo(task, date)}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── Focus timer ─────────────────────────────────────── */}
        {timerTask && (
          <div className="card timer-card mt-2">
            <div className="row-between wrap mb-1">
              <h2 style={{ fontSize: '1.05rem' }}>Focus Session</h2>
              <button className="icon-btn" onClick={closeTimer} aria-label="Close timer">
                <IconX size={15} />
              </button>
            </div>
            <p className="small muted mb-1">{timerTask.title}</p>
            <div className="timer-readout" role="timer" aria-live="off">
              {mmss(secondsLeft)}
            </div>
            <div className="row gap-1">
              <button
                className="btn btn-primary"
                onClick={() => setTimerRunning((r) => !r)}
              >
                {timerRunning ? <IconPause size={13} /> : <IconPlay size={13} />}
                {timerRunning ? 'Pause' : 'Start timer'}
              </button>
              <button className="btn btn-ghost" onClick={completeTimer}>
                <IconCheck size={13} /> Log {timerTask.estimatedMinutes} min &amp; finish
              </button>
            </div>
            <p className="small faint mt-1">
              Only real logged minutes count toward your statistics. This timer never marks a lesson
              complete on its own.
            </p>
          </div>
        )}
      </div>
    </AppLayout>
  )
}

/* ------------------------------------------------------------------ */
/* Small presentational pieces                                         */
/* ------------------------------------------------------------------ */

function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint: string
  tone?: 'good' | 'warn'
}) {
  return (
    <div className={`stat-tile${tone ? ` is-${tone}` : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      <span className="stat-hint">{hint}</span>
    </div>
  )
}

function WeekCell({
  day,
  onReschedule,
}: {
  day: StudyPlanDay
  onReschedule: (task: StudyTask, date: string) => void
}) {
  const nextFree = addDays(day.date, 1)
  const allDone = day.tasks.length > 0 && day.tasks.every((t) => t.status === 'done')
  const hasMissed = day.tasks.some((t) => t.status === 'missed')

  return (
    <div
      className={`week-day${day.isToday ? ' today' : ''}${allDone ? ' done' : ''}${
        hasMissed ? ' missed' : ''
      }`}
    >
      <div className="row-between">
        <span className="d">{day.label}</span>
        {day.isToday && <span className="badge badge-primary">Today</span>}
        {allDone && (
          <span className="badge badge-success">
            <IconCheck size={11} />
            Done
          </span>
        )}
      </div>
      <div className="week-minutes">
        <span className="m">
          {day.actualMinutes > 0 ? `${day.actualMinutes}m done` : `${day.plannedMinutes}m planned`}
        </span>
        {day.plannedMinutes > 0 && (
          <div className="progress-track is-thin">
            <div
              className="progress-fill"
              style={{
                width: `${Math.min(100, (day.actualMinutes / day.plannedMinutes) * 100)}%`,
              }}
            />
          </div>
        )}
      </div>
      {day.tasks.length === 0 ? (
        <span className="t faint">Rest day</span>
      ) : (
        <div className="col" style={{ gap: '0.25rem' }}>
          {day.tasks.slice(0, 3).map((task) => (
            <div key={task.id} className={`week-task is-${task.status}`}>
              <span className="week-task-icon">{kindIcon(task.kind)}</span>
              <span className="week-task-title">{task.title}</span>
              {task.status !== 'done' && !day.isPast && (
                <button
                  className="week-task-skip"
                  onClick={() => onReschedule(task, nextFree)}
                  aria-label={`Move ${task.title} to the next day`}
                  title="Push to the next day"
                >
                  <IconRefresh size={11} />
                </button>
              )}
            </div>
          ))}
          {day.tasks.length > 3 && (
            <span className="small faint">+{day.tasks.length - 3} more</span>
          )}
        </div>
      )}
    </div>
  )
}

function TaskRow({
  task,
  onStart,
  onReschedule,
}: {
  task: StudyTask
  onStart: () => void
  onReschedule: (date: string) => void
}) {
  const [showDates, setShowDates] = useState(false)
  const today = todayKey()
  const nextDays = useMemo(() => [1, 2, 3].map((n) => addDays(today, n)), [today])

  return (
    <div className={`plan-row is-${task.status}`}>
      <span className="plan-check">{kindIcon(task.kind)}</span>
      <span className="plan-title">
        {task.title}
        {task.reason && <span className="plan-reason">{task.reason}</span>}
        {task.rescheduledFrom && (
          <span className="plan-rescheduled">
            moved from {dayLabel(task.rescheduledFrom)}
          </span>
        )}
      </span>
      <span className="badge badge-muted">
        <IconClock size={12} />
        {task.status === 'done' && task.actualMinutes > 0
          ? `${task.actualMinutes} min`
          : `${task.estimatedMinutes} min`}
      </span>
      {task.status === 'done' && (
        <span className="badge badge-success">
          <IconCheck size={11} />
          Done
        </span>
      )}
      {task.status === 'missed' && <span className="badge badge-danger">Missed</span>}
      {task.status === 'planned' && (
        <span className="row gap-1">
          <button className="btn btn-ghost btn-sm" onClick={onStart}>
            <IconPlay size={11} /> Start
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setShowDates((s) => !s)}
            aria-expanded={showDates}
          >
            <IconRefresh size={11} /> Move
          </button>
        </span>
      )}
      {showDates && task.status === 'planned' && (
        <span className="row gap-1 plan-dates">
          {nextDays.map((date) => (
            <button
              key={date}
              className="date-chip"
              onClick={() => {
                onReschedule(date)
                setShowDates(false)
              }}
            >
              {dayLabel(date)}
            </button>
          ))}
        </span>
      )}
    </div>
  )
}
