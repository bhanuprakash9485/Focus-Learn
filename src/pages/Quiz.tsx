import { useEffect, useMemo, useRef, useState } from 'react'
import type { QuizDifficulty, QuizQuestion, Roadmap } from '../types'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { useApp } from '../context/AppContext'
import { goalQuizLessonId, topicQuizLessonId } from '../services/goalProgress'
import {
  catalogGoalToQuizInput,
  getGoalQuizStatus,
  getGoalQuizStatuses,
  prepareGoalQuiz,
  userGoalToQuizInput,
  type GoalQuizGoalInput,
} from '../services/goalQuiz'
import {
  analyzeQuizPerformance,
  normalizeTopic,
  type AnalyzePerformanceInput,
  type PerformanceAnalysisResult,
} from '../services/aiService'
import {
  answerQuiz,
  getQuiz,
  getQuizStatus,
  prepareQuiz,
  submitQuiz,
  QUIZ_TIER_ORDER,
  TopicQuizError,
} from '../services/topicQuiz'
import type {
  AnswerFeedback,
  GoalQuizStatus,
  Quiz,
  QuizGenerationStage,
  TopicQuizStatus,
  TopicQuizSubmission,
} from '../types'
import { QUIZ_DIFFICULTY_LABEL as DIFFICULTY_LABEL } from '../types'
import {
  IconArrowRight,
  IconCheck,
  IconLock,
  IconQuiz,
  IconSparkles,
  IconTarget,
  IconTrend,
  IconX,
} from '../components/Icons'

type Phase = 'intro' | 'question' | 'result'

type TopicStatus = 'preparing' | 'error' | 'intro' | 'question' | 'result'

interface AnalysisState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  analysis?: PerformanceAnalysisResult['analysis']
  message?: string
}

/** One server-recorded answer, keyed by question index. */
interface AnsweredQuestion {
  selected: number
  correct: boolean
  /** False while the save is still pending the server (kept on-device). */
  synced?: boolean
}

/** Which tier a reported generation stage belongs to, if any. */
const GOAL_STAGE_TIER: Record<QuizGenerationStage, QuizDifficulty | undefined> = {
  preparing: undefined,
  basic_ready: 'basic',
  moderate_ready: 'moderate',
  difficult_ready: 'advanced',
  complete: undefined,
  failed: undefined,
}

function statusMessage(pct: number): string {
  if (pct >= 80) return 'Strong understanding — you can move forward confidently.'
  if (pct >= 60) return 'Good effort — review the explanations below and try a focused retest.'
  return 'Keep going — work through the review below, then retest your weak concepts.'
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms))
}

/** Poll a quiz id until the validated quiz is READY (or it fails/timeouts). */
async function awaitQuiz(quizId: string, timeoutMs = 300000): Promise<import('../types').Quiz> {
  const end = Date.now() + timeoutMs
  for (;;) {
    if (Date.now() > end) {
      throw new TopicQuizError('Your quiz took too long to prepare. Please try again.', 0)
    }
    try {
      return await getQuiz(quizId)
    } catch (err) {
      if (err instanceof TopicQuizError && err.status === 409 && Date.now() + 2500 <= end) {
        await sleep(2500)
        continue
      }
      throw err
    }
  }
}

function lockedTierFor(difficulty: QuizDifficulty | undefined, unlocked: Record<QuizDifficulty, boolean>): QuizDifficulty | null {
  if (!difficulty) return null
  if (unlocked[difficulty]) return null
  return difficulty
}

/** A targeted retest has no tier gating — every question is in play. */
function makeRetestStatus(quiz: Quiz, quizId: string, topic: string): TopicQuizStatus {
  const difficulty_counts: Record<QuizDifficulty, number> = { basic: 0, moderate: 0, advanced: 0 }
  for (const q of quiz.questions) {
    if (q.difficulty) difficulty_counts[q.difficulty] += 1
  }
  return {
    quiz_id: quizId,
    topic,
    // A retest is always topic scoped, so the topic's own lesson id is the
    // right fallback when the payload has none.
    lesson_id: quiz.lesson_id || quiz.lessonId || topicQuizLessonId(topic),
    state: 'ready',
    error: null,
    total: quiz.questions.length,
    question_count: quiz.questions.length,
    retest_of: quiz.retest_of || null,
    focus_concepts: quiz.focus_concepts || [],
    completed: false,
    attempts: { basic: 0, moderate: 0, advanced: 0 },
    unlocked: { basic: true, moderate: true, advanced: true },
    difficulty_counts,
    answers: [],
    retest_ready: false,
  }
}

/**
 * Adapt the goal quiz status onto the runner's status shape.
 *
 * A goal's 10/10/10 quiz and a topic's 10/10/10 quiz are the same
 * server-authoritative runner with the same tier gating, so the UI reads one
 * shape. The only difference is identity: a goal quiz is tracked under its own
 * goal lesson id so its score never collides with a single roadmap lesson.
 */
function goalStatusToRunner(status: GoalQuizStatus, goalId: string): TopicQuizStatus {
  return {
    quiz_id: status.quiz_id || '',
    topic: status.topic || '',
    lesson_id: status.lesson_id || goalQuizLessonId(goalId),
    state: status.state,
    error: status.error,
    total: status.total,
    question_count: status.question_count,
    retest_of: null,
    focus_concepts: [],
    completed: status.completed,
    attempts: status.attempts,
    unlocked: status.unlocked,
    difficulty_counts: status.difficulty_counts,
    answers: status.answers,
    retest_ready: status.retest_ready,
    stage: status.stage,
    expected_total: status.expected_total,
    goal_id: status.goal_id,
    tiers: status.tiers,
  }
}

/**
 * Poll a goal's quiz until its validated 30 questions are ready.
 *
 * The status endpoint is polled (not the quiz) because it carries the
 * generation stage, so the student can see Basic/Moderate/Difficult land as
 * they are written instead of staring at one spinner.
 */
async function awaitGoalQuiz(
  goalId: string,
  quizId: string,
  onStage: (stage: QuizGenerationStage) => void,
  timeoutMs = 420000,
): Promise<{ quiz: Quiz; status: GoalQuizStatus }> {
  const end = Date.now() + timeoutMs
  for (;;) {
    if (Date.now() > end) {
      throw new TopicQuizError('Your quiz took too long to prepare. Please try again.', 0)
    }
    const status = await getGoalQuizStatus(goalId)
    if (status.stage) onStage(status.stage)
    if (status.state === 'failed') {
      throw new TopicQuizError(
        status.error || 'We could not prepare every question for this quiz yet. Please try again.',
        422,
      )
    }
    if (status.state === 'ready' && status.quiz_id) {
      return { quiz: await getQuiz(status.quiz_id || quizId), status }
    }
    await sleep(2000)
  }
}

/**
 * Resolve a lesson id to the topic its 30-question quiz is keyed by.
 * - `topic-<slug>` ids (server-driven quizzes) map straight back.
 * - Catalog lesson ids (e.g. `web-dev-1-1`) resolve through the current
 *   roadmap's lesson titles, so the roadmap "Take Quiz" flow always opens
 *   the new server-driven 10/10/10 quiz for that lesson's topic.
 * Returns null when the lesson is unknown.
 */
function lessonTopicName(lessonId: string | undefined, roadmap: Roadmap | null): string | null {
  if (!lessonId) return null
  if (lessonId.startsWith('topic-')) {
    const name = lessonId.slice('topic-'.length).replace(/-+/g, ' ').trim()
    return name || null
  }
  if (roadmap) {
    for (const step of roadmap.steps) {
      for (const lesson of step.lessons) {
        if (lesson.id === lessonId) return lesson.title
      }
    }
  }
  return null
}

export default function Quiz() {
  const { lessonId, topic, goalId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { roadmap, recordAttempt, attempts, goals, userGoals } = useApp()

  // A topic quiz (from Focus Mode / AI roadmap / roadmap lesson "Take Quiz")
  // is server-driven with progressive difficulty unlocking. Lesson routes
  // resolve to their roadmap topic so they open the same 30-question quiz.
  const resolvedLessonTopic = topic ? null : lessonTopicName(lessonId, roadmap)
  const topicName = topic ? normalizeTopic(topic) : resolvedLessonTopic ? normalizeTopic(resolvedLessonTopic) : null
  const isTopicQuiz = Boolean(topicName)

  // A goal quiz (/quiz/goal/<goalId>) is the goal's own 10/10/10 assessment:
  // one record per goal, independent of the goal's individual topic quizzes.
  const isGoalQuiz = Boolean(goalId)
  const savedGoal = useMemo(
    () => (goalId ? userGoals.find((g) => g.id === goalId) || null : null),
    [userGoals, goalId],
  )
  const catalogGoal = useMemo(
    () => (goalId ? goals.find((g) => g.id === goalId) || null : null),
    [goals, goalId],
  )
  const goalInput: GoalQuizGoalInput | null = useMemo(() => {
    if (!goalId) return null
    if (savedGoal) return userGoalToQuizInput(savedGoal)
    if (catalogGoal) return catalogGoalToQuizInput(catalogGoal)
    return null
  }, [goalId, savedGoal, catalogGoal])
  const goalTitle = savedGoal?.title || catalogGoal?.title || goalId || null
  /** What the page is actually about — the topic, or the goal. */
  const displayTitle = isGoalQuiz ? goalTitle : topicName
  /** The label attempts/analysis are filed under. */
  const attemptTopicName = isGoalQuiz ? goalTitle : topicName

  const [phase, setPhase] = useState<Phase>('intro')
  const [qIndex, setQIndex] = useState(0)
  const [result, setResult] = useState<{ submission: TopicQuizSubmission } | null>(null)
  const [analysis, setAnalysis] = useState<AnalysisState>({ status: 'idle' })

  // Topic quiz state (server-authoritative).
  const [topicStatus, setTopicStatus] = useState<TopicStatus>('intro')
  const [topicError, setTopicError] = useState('')
  const [topicBlocked, setTopicBlocked] = useState(false)
  const [serverStatus, setServerStatus] = useState<TopicQuizStatus | null>(null)
  const [topicQuiz, setTopicQuiz] = useState<import('../types').Quiz | null>(null)
  const [quizId, setQuizId] = useState<string | null>(null)
  const [answered, setAnswered] = useState<Record<number, AnsweredQuestion>>({})
  const [selected, setSelected] = useState<(number | null)[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [retesting, setRetesting] = useState(false)
  const [activeTier, setActiveTier] = useState<QuizDifficulty | null>(null)
  const [goalStage, setGoalStage] = useState<QuizGenerationStage | null>(null)
  const [goalStatuses, setGoalStatuses] = useState<Record<string, GoalQuizStatus>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const currentQuizIdRef = useRef<string | null>(null)
  const syncQueueRef = useRef<{ index: number; selected: number; attempts: number }[]>([])
  const syncRunningRef = useRef(false)

  useEffect(() => {
    currentQuizIdRef.current = quizId
  }, [quizId])

  /** Re-send answers that failed to save, without ever blocking the UI. */
  function enqueueSync(index: number, selected: number) {
    const existing = syncQueueRef.current.find((e) => e.index === index)
    if (existing) {
      existing.selected = selected
      existing.attempts = 0
    } else {
      syncQueueRef.current.push({ index, selected, attempts: 0 })
    }
    setNotice(
      'Your answer is saved on this device. We will keep trying to sync it to your progress.',
    )
    void drainSyncQueue()
  }

  async function drainSyncQueue() {
    if (syncRunningRef.current) return
    syncRunningRef.current = true
    try {
      while (syncQueueRef.current.length > 0 && mountedRef.current) {
        const entry = syncQueueRef.current[0]
        const targetQuizId = currentQuizIdRef.current
        if (!targetQuizId) {
          syncQueueRef.current.shift()
          continue
        }
        await sleep(1500)
        if (!mountedRef.current) return
        try {
          const fb: AnswerFeedback = await answerQuiz(targetQuizId, entry.index, entry.selected)
          setAnswered((prev) => {
            const current = prev[entry.index]
            if (!current || current.synced !== false) return prev
            return {
              ...prev,
              [entry.index]: { selected: fb.selected_index, correct: fb.is_correct, synced: true },
            }
          })
          setServerStatus((prev) =>
            prev
              ? { ...prev, attempts: fb.attempts, unlocked: fb.unlocked, completed: fb.completed }
              : prev,
          )
          setNotice(null)
          syncQueueRef.current.shift()
        } catch {
          entry.attempts += 1
          if (entry.attempts >= 5) {
            syncQueueRef.current.shift()
            setNotice(
              'One answer could not be synced to your progress yet. Keep going — the rest are unaffected.',
            )
          }
        }
      }
    } finally {
      syncRunningRef.current = false
    }
  }

  function clearSyncPending() {
    syncQueueRef.current = []
    setNotice(null)
  }

  // Load / regenerate the AI topic quiz for the current topic. The backend
  // generates in the background; we poll the one quiz row until READY.
  useEffect(() => {
    if (!topicName) return
    mountedRef.current = true
    setTopicStatus('preparing')
    setTopicError('')
    setTopicBlocked(false)
    setServerStatus(null)
    setTopicQuiz(null)
    setQuizId(null)
    setAnswered({})
    setSelected([])
    setResult(null)
    setAnalysis({ status: 'idle' })
    setPhase('intro')
    setQIndex(0)
    setActiveTier(null)
    clearSyncPending()

    const retestRequested = Boolean(location.state && (location.state as { retest?: boolean }).retest)

    ;(async () => {
      try {
        // Retests are keyed by their parent quiz id; the weak concepts are
        // already stored on the retest row, so we only need to know the
        // primary quiz id (if any) to start the targeted retest.
        let parentId: string | undefined
        if (retestRequested) {
          const initial = await getQuizStatus(topicName)
          if (initial.quiz_id) parentId = initial.quiz_id
        }
        const prep = await prepareQuiz({
          topic: topicName,
          level: 'beginner',
          quizId: parentId,
        })
        if (!mountedRef.current) return
        const quiz = await awaitQuiz(prep.quiz_id)
        if (!mountedRef.current) return
        setQuizId(prep.quiz_id)
        setTopicQuiz(quiz)
        setSelected(Array(quiz.questions.length).fill(null))

        if (!retestRequested) {
          const status = await getQuizStatus(topicName)
          if (!mountedRef.current) return
          setServerStatus(status)
          const restored: Record<number, AnsweredQuestion> = {}
          for (const a of status.answers) {
            restored[a.index] = { selected: a.selected_index, correct: a.is_correct, synced: true }
          }
          setAnswered(restored)
          if (status.completed) {
            const sub = await submitQuiz(prep.quiz_id)
            if (!mountedRef.current) return
            setResult({ submission: sub })
            setTopicStatus('result')
            recordAttempt({
              lessonId: status.lesson_id,
              score: sub.score,
              total: sub.total,
              percentage: sub.percentage,
              missedQuestionIds: quiz.questions
                .filter((_, i) => restored[i] && !restored[i].correct)
                .map((q) => q.id),
              difficultyBreakdown: sub.breakdown,
              weakConcepts: sub.weak_concepts.length > 0 ? sub.weak_concepts : undefined,
              topicName: topicName ?? undefined,
            })
            void runAnalysis(quiz, restored, sub.score)
          } else {
            setTopicStatus('intro')
          }
        } else {
          // Targeted retest: every question is in play, no gating.
          setServerStatus(makeRetestStatus(quiz, prep.quiz_id, topicName))
          setTopicStatus('intro')
        }
      } catch (err) {
        if (!mountedRef.current) return
        if (err instanceof TopicQuizError && err.blocked) {
          setTopicBlocked(true)
          setTopicError(err.message)
        } else {
          setTopicError(err instanceof TopicQuizError ? err.message : 'Something went wrong. Please try again.')
        }
        setTopicStatus('error')
      }
    })()

    return () => {
      mountedRef.current = false
    }
  }, [topicName])

  // Load (or resume) the goal's own 10/10/10 quiz. The background run prepares
  // one tier at a time, so we poll the goal status for its stage and adopt the
  // stored quiz the moment it validates — a finished quiz always resumes
  // exactly where the student left off, on any device.
  useEffect(() => {
    if (!goalId || !goalInput) return
    mountedRef.current = true
    setTopicStatus('preparing')
    setTopicError('')
    setTopicBlocked(false)
    setServerStatus(null)
    setTopicQuiz(null)
    setQuizId(null)
    setAnswered({})
    setSelected([])
    setResult(null)
    setAnalysis({ status: 'idle' })
    setPhase('intro')
    setQIndex(0)
    setActiveTier(null)
    setGoalStage('preparing')
    clearSyncPending()

    ;(async () => {
      try {
        const prep = await prepareGoalQuiz(goalInput)
        if (!mountedRef.current) return
        const { quiz, status } = await awaitGoalQuiz(goalId, prep.quiz_id, (stage) => {
          if (mountedRef.current) setGoalStage(stage)
        })
        if (!mountedRef.current) return
        setQuizId(prep.quiz_id)
        setTopicQuiz(quiz)
        setSelected(Array(quiz.questions.length).fill(null))
        setServerStatus(goalStatusToRunner(status, goalId))

        const restored: Record<number, AnsweredQuestion> = {}
        for (const a of status.answers) {
          restored[a.index] = { selected: a.selected_index, correct: a.is_correct, synced: true }
        }
        setAnswered(restored)
        if (status.completed) {
          const sub = await submitQuiz(prep.quiz_id)
          if (!mountedRef.current) return
          setResult({ submission: sub })
          setTopicStatus('result')
          recordAttempt({
            lessonId: status.lesson_id || goalQuizLessonId(goalId),
            score: sub.score,
            total: sub.total,
            percentage: sub.percentage,
            missedQuestionIds: quiz.questions
              .filter((_, i) => restored[i] && restored[i].synced !== false && !restored[i].correct)
              .map((q) => q.id),
            difficultyBreakdown: sub.breakdown,
            weakConcepts: sub.weak_concepts.length > 0 ? sub.weak_concepts : undefined,
            topicName: goalTitle ?? undefined,
          })
          void runAnalysis(quiz, restored, sub.score)
        } else {
          setTopicStatus('intro')
        }
      } catch (err) {
        if (!mountedRef.current) return
        setTopicBlocked(Boolean(err instanceof TopicQuizError && err.blocked))
        setTopicError(
          err instanceof TopicQuizError
            ? err.message
            : 'Something went wrong. Please try again.',
        )
        setTopicStatus('error')
      }
    })()

    return () => {
      mountedRef.current = false
    }
  }, [goalId, goalInput, goalTitle])

  async function runAnalysis(
    quiz: import('../types').Quiz,
    answers: Record<number, AnsweredQuestion>,
    finalScore: number,
  ) {
    setAnalysis({ status: 'loading' })
    const conceptQuestions: AnalyzePerformanceInput['questions'] = quiz.questions.map(
      (q: QuizQuestion) => ({
        prompt: q.prompt,
        options: q.options,
        correctIndex: q.correctIndex,
        concept: q.concept || q.prompt.slice(0, 30),
        difficulty: q.difficulty,
      }),
    )
    const answersList = quiz.questions.map((_, i) => {
      const a = answers[i]
      return a ? a.selected : -1
    })
    const res = await analyzeQuizPerformance({
      roadmap_topic: quiz.topic || quiz.title || displayTitle || '',
      quiz_score: finalScore,
      total_questions: quiz.questions.length,
      questions: conceptQuestions,
      answers: answersList,
      correct_answers: quiz.questions.map((q) => q.correctIndex),
    })
    if (!mountedRef.current) return
    if (res.state === 'ready') {
      setAnalysis({ status: 'ready', analysis: res.analysis })
    } else {
      setAnalysis({ status: 'error', message: res.message })
    }
  }

  function resetRun() {
    if (!topicQuiz || !quizId) return
    setPhase('intro')
    setQIndex(0)
    setAnswered({})
    setSelected(Array(topicQuiz.questions.length).fill(null))
    setResult(null)
    setAnalysis({ status: 'idle' })
    setActiveTier(null)
    clearSyncPending()
  }

  async function submitAnswer(savedSelected: number) {
    if (!quizId || submitting) return
    if (answered[qIndex] && answered[qIndex].synced !== false) return
    setSubmitting(true)
    try {
      const fb: AnswerFeedback = await answerQuiz(quizId, qIndex, savedSelected)
      setAnswered((prev) => ({
        ...prev,
        [qIndex]: { selected: fb.selected_index, correct: fb.is_correct, synced: true },
      }))
      setServerStatus((prev) =>
        prev
          ? { ...prev, attempts: fb.attempts, unlocked: fb.unlocked, completed: fb.completed }
          : prev,
      )
      setNotice(null)
    } catch (err) {
      // A failed or hanging save must never freeze the quiz: keep the answer
      // on this device, show a visible inline note, and retry in the background
      // while the student keeps moving through the questions.
      setAnswered((prev) => ({
        ...prev,
        [qIndex]: { selected: savedSelected, correct: false, synced: false },
      }))
      setNotice(
        err instanceof TopicQuizError && err.status === 0
          ? 'The server is not reachable. Your answer is saved on this device and will sync when the connection is back.'
          : 'Your answer could not be saved yet. It is kept on this device and we will keep retrying.',
      )
      enqueueSync(qIndex, savedSelected)
    } finally {
      setSubmitting(false)
    }
  }

  async function finishQuiz() {
    if (!quizId || !topicQuiz || !serverStatus) return
    setSubmitting(true)
    try {
      const sub = await submitQuiz(quizId)
      const liveAnswered = answered
      setResult({ submission: sub })
      setTopicStatus('result')
      recordAttempt({
        lessonId: serverStatus.lesson_id,
        score: sub.score,
        total: sub.total,
        percentage: sub.percentage,
        missedQuestionIds: topicQuiz.questions
          .filter((_, i) => liveAnswered[i] && liveAnswered[i].synced !== false && !liveAnswered[i].correct)
          .map((q) => q.id),
        difficultyBreakdown: sub.breakdown,
        weakConcepts: sub.weak_concepts.length > 0 ? sub.weak_concepts : undefined,
        topicName: attemptTopicName ?? undefined,
      })
      void runAnalysis(topicQuiz, liveAnswered, sub.score)
    } catch (err) {
      const msg = err instanceof TopicQuizError ? err.message : 'Could not submit your quiz.'
      setNotice(`${msg} Your answers on this device are safe — press Finish again.`)
      setTopicError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  async function retest() {
    // Retests are a topic-quiz feature: a goal's own 10/10/10 record is its
    // single authoritative assessment, so the results screen does not offer one.
    if (!topicName || isGoalQuiz || !topicQuiz || !result || !quizId) return
    setRetesting(true)
    setTopicStatus('preparing')
    setTopicError('')
    clearSyncPending()
    try {
      const weak = result.submission.weak_concepts
      const prep = await prepareQuiz({
        topic: topicName,
        level: 'beginner',
        quizId,
        concepts: weak,
      })
      const quiz = await awaitQuiz(prep.quiz_id)
      if (!mountedRef.current) return
      setQuizId(prep.quiz_id)
      setTopicQuiz(quiz)
      setServerStatus(makeRetestStatus(quiz, prep.quiz_id, topicName))
      setAnswered({})
      setSelected(Array(quiz.questions.length).fill(null))
      setResult(null)
      setAnalysis({ status: 'idle' })
      setPhase('intro')
      setQIndex(0)
      setTopicStatus('intro')
      setActiveTier(null)
    } catch (err) {
      if (!mountedRef.current) return
      setTopicError(err instanceof TopicQuizError ? err.message : 'Could not prepare your retest.')
      setTopicStatus('error')
    } finally {
      setRetesting(false)
    }
  }

  function retryGenerate() {
    // A failed goal run keeps the tiers that already validated, so retrying
    // tops the quiz up instead of writing it again — and the answers the
    // student already gave are restored from the server.
    if (isGoalQuiz) {
      if (!goalId || !goalInput) return
      setTopicStatus('preparing')
      setTopicError('')
      setTopicBlocked(false)
      setGoalStage('preparing')
      clearSyncPending()
      ;(async () => {
        try {
          const prep = await prepareGoalQuiz(goalInput)
          const { quiz, status } = await awaitGoalQuiz(goalId, prep.quiz_id, (stage) => {
            if (mountedRef.current) setGoalStage(stage)
          })
          if (!mountedRef.current) return
          setQuizId(prep.quiz_id)
          setTopicQuiz(quiz)
          setServerStatus(goalStatusToRunner(status, goalId))
          setSelected(Array(quiz.questions.length).fill(null))
          const restored: Record<number, AnsweredQuestion> = {}
          for (const a of status.answers) {
            restored[a.index] = { selected: a.selected_index, correct: a.is_correct, synced: true }
          }
          setAnswered(restored)
          setTopicStatus('intro')
        } catch (err) {
          if (!mountedRef.current) return
          setTopicError(
            err instanceof TopicQuizError ? err.message : 'Something went wrong. Please try again.',
          )
          setTopicBlocked(err instanceof TopicQuizError && err.blocked)
          setTopicStatus('error')
        }
      })()
      return
    }
    if (!topicName) return
    setTopicStatus('preparing')
    setTopicError('')
    setTopicBlocked(false)
    clearSyncPending()
    ;(async () => {
      try {
        const prep = await prepareQuiz({ topic: topicName, level: 'beginner' })
        const quiz = await awaitQuiz(prep.quiz_id)
        if (!mountedRef.current) return
        setQuizId(prep.quiz_id)
        setTopicQuiz(quiz)
        const status = await getQuizStatus(topicName)
        if (!mountedRef.current) return
        setServerStatus(status)
        setSelected(Array(quiz.questions.length).fill(null))
        setAnswered({})
        setTopicStatus('intro')
      } catch (err) {
        if (!mountedRef.current) return
        setTopicError(err instanceof TopicQuizError ? err.message : 'Something went wrong. Please try again.')
        setTopicBlocked(err instanceof TopicQuizError && err.blocked)
        setTopicStatus('error')
      }
    })()
  }

  // Quiz hub when no lesson id or topic is given: every roadmap lesson has
  // an on-demand 30-question topic quiz (10 basic / 10 moderate / 10 advanced).
  const availableQuizzes = useMemo(() => {
    if (!roadmap) return []
    const out: { lessonId: string; title: string; stepTitle: string; done: boolean }[] = []
    for (const step of roadmap.steps) {
      for (const lesson of step.lessons) {
        const attemptLessonId = topicQuizLessonId(lesson.title)
        out.push({
          lessonId: lesson.id,
          title: lesson.title,
          stepTitle: step.title,
          done: attempts.some((a) => a.lessonId === attemptLessonId),
        })
      }
    }
    return out
  }, [roadmap, attempts])

  // The hub shows every goal the student can be quizzed on: their own goals
  // first, then the rest of the catalog. One request covers all progress.
  useEffect(() => {
    if (topicName || goalId) return
    let alive = true
    ;(async () => {
      try {
        const statuses = await getGoalQuizStatuses()
        if (alive) setGoalStatuses(statuses)
      } catch {
        // The hub still lists every goal without progress; opening one shows
        // the real state, so a failure here is not worth an error screen.
      }
    })()
    return () => {
      alive = false
    }
  }, [topicName, goalId])

  const goalCards = useMemo(() => {
    const list: { id: string; title: string; subtitle: string }[] = []
    const seen = new Set<string>()
    for (const g of userGoals) {
      if (seen.has(g.id)) continue
      seen.add(g.id)
      list.push({
        id: g.id,
        title: g.title,
        subtitle: g.goalContext ? g.goalContext.slice(0, 90) : 'Your saved goal',
      })
    }
    for (const g of goals) {
      if (seen.has(g.id)) continue
      seen.add(g.id)
      list.push({ id: g.id, title: g.title, subtitle: g.category })
    }
    return list
  }, [userGoals, goals])

  /** "Not started" / "10 of 30 answered" / "Completed 80%". */
  function goalProgressNote(status: GoalQuizStatus | undefined): string {
    if (!status) return 'Not started'
    if (status.state === 'failed') return 'Needs a retry'
    if (status.completed) return 'Completed'
    const answered = status.answers.length
    if (answered === 0) {
      if (status.state === 'generating') return 'Preparing…'
      return 'Not started'
    }
    return `${answered} of ${status.total} answered`
  }

  /* ── Loading / error while preparing a quiz ─────────────────────── */
  if ((isTopicQuiz || isGoalQuiz) && !topicQuiz) {
    if (topicStatus === 'error') {
      return (
        <AppLayout>
          <div className="page page-narrow">
            <div className="card text-center" style={{ padding: '2.2rem 1.5rem' }}>
              <span className="badge badge-muted" style={{ marginBottom: '0.8rem' }}>
                <IconQuiz size={13} />
                {displayTitle}
              </span>
              <h1 style={{ fontSize: '1.35rem' }}>Quiz unavailable</h1>
              <p className="muted mt-1">{topicError}</p>
              <div className="row wrap" style={{ justifyContent: 'center', marginTop: '1.2rem' }}>
                <button className="btn btn-primary" onClick={retryGenerate}>
                  Try Again
                  <IconArrowRight size={16} />
                </button>
                {isGoalQuiz ? (
                  <Link to="/quiz" className="btn btn-ghost">
                    All quizzes
                  </Link>
                ) : (
                  <Link to="/search" className="btn btn-ghost">
                    Back to search
                  </Link>
                )}
              </div>
              {topicBlocked && (
                <p className="faint small mt-2">
                  This topic was flagged by content safety. Try a different topic.
                </p>
              )}
            </div>
          </div>
        </AppLayout>
      )
    }
    const stageTier = isGoalQuiz && goalStage ? GOAL_STAGE_TIER[goalStage] : undefined
    const stageNote = stageTier ? ` ${DIFFICULTY_LABEL[stageTier]} is ready and saved.` : ''
    return (
      <AppLayout>
        <div className="page page-narrow">
          <div className="card text-center" style={{ padding: '3rem 1.5rem' }}>
            <span className="spinner" style={{ width: 32, height: 32, margin: '0 auto 1rem' }} />
            <h2 style={{ fontSize: '1.2rem' }}>
              {retesting ? 'Preparing your retest…' : 'Preparing your quiz…'}
            </h2>
            <p className="muted mt-1">
              Writing 30 questions{isGoalQuiz ? '' : ` on "${topicName}"`} across basic,
              moderate and difficult.{stageNote}
            </p>
            {isGoalQuiz && (
              <p className="faint small mt-1">
                Each tier is saved as soon as it is written — you can leave and come back.
              </p>
            )}
          </div>
        </div>
      </AppLayout>
    )
  }

  if (isGoalQuiz && !goalInput) {
    return (
      <AppLayout>
        <div className="page page-narrow">
          <div className="card text-center" style={{ padding: '3rem 1.5rem' }}>
            <h1 style={{ fontSize: '1.35rem' }}>Goal not found</h1>
            <p className="muted mt-1">This goal is not in the catalog or your saved goals.</p>
            <Link to="/goals" className="btn btn-primary mt-2">Back to Goals</Link>
          </div>
        </div>
      </AppLayout>
    )
  }

  if (!topicQuiz && !lessonId && !isGoalQuiz) {
    return (
      <AppLayout>
        <div className="page">
          <div className="page-header">
            <h1>Goal Quizzes</h1>
            <p>
              Every goal has its own 30-question assessment — 10 basic, 10 moderate and 10
              difficult, each tier saved as you pass it.
            </p>
          </div>
          <div className="grid-auto">
            {goalCards.map((g) => {
              const status = goalStatuses[g.id]
              const done = Boolean(status?.completed)
              return (
                <div
                  key={g.id}
                  className="card card-hover"
                  onClick={() => navigate(`/quiz/goal/${encodeURIComponent(g.id)}`)}
                >
                  <div className="row-between mb-1">
                    <span className="badge badge-primary">Goal quiz</span>
                    {done ? <span className="badge badge-success">Completed</span> : null}
                  </div>
                  <h3 className="card-title">{g.title}</h3>
                  <p className="card-desc">30 questions · Basic · Moderate · Difficult</p>
                  {g.subtitle && <p className="faint small mt-1">{g.subtitle}</p>}
                  <div className="row-between mt-2">
                    <span className="row small muted">
                      <IconQuiz size={15} />
                      {goalProgressNote(status)}
                    </span>
                    <span className="row small" style={{ color: 'var(--primary)', fontWeight: 600 }}>
                      {done ? 'Review' : status ? 'Resume' : 'Start'}
                      <IconArrowRight size={15} />
                    </span>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="page-header mt-3">
            <h2>Lesson Quizzes</h2>
            <p>30-question assessments after each lesson — basic, moderate and difficult.</p>
          </div>
          {availableQuizzes.length > 0 ? (
            <div className="grid-auto">
              {availableQuizzes.map((q) => (
                <div
                  key={q.lessonId}
                  className="card card-hover"
                  onClick={() => navigate(`/quiz/topic/${encodeURIComponent(q.title)}`)}
                >
                  <div className="row-between mb-1">
                    <span className="badge badge-primary">{q.stepTitle}</span>
                    {q.done && <span className="badge badge-success">Attempted</span>}
                  </div>
                  <h3 className="card-title">{q.title}</h3>
                  <p className="card-desc">30 questions · Basic · Moderate · Difficult</p>
                  <div className="row-between mt-2">
                    <span className="row small muted">
                      <IconQuiz size={15} />
                      Multiple choice
                    </span>
                    <span className="row small" style={{ color: 'var(--primary)', fontWeight: 600 }}>
                      Start
                      <IconArrowRight size={15} />
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="card empty-state">
              <IconTarget size={36} />
              <p>No quizzes available yet — choose a goal with quiz content first.</p>
              <Link to="/goals" className="btn btn-primary mt-2">Choose a Goal</Link>
              <Link to="/search" className="btn btn-ghost mt-2">
                Or learn any topic with a video
              </Link>
            </div>
          )}
        </div>
      </AppLayout>
    )
  }

  // Legacy lesson routes that do not resolve to a roadmap topic. The old
  // 2-question "understanding check" catalog was removed — the new system
  // always serves the server-generated 30-question topic quiz instead.
  if (!isTopicQuiz && lessonId) {
    return (
      <AppLayout>
        <div className="page page-narrow">
          <div className="card text-center" style={{ padding: '3rem 1.5rem' }}>
            <h1>Quiz not found</h1>
            <p className="muted mt-1">This lesson isn't part of the current roadmap.</p>
            <Link to="/quiz" className="btn btn-primary mt-2">Back to all quizzes</Link>
          </div>
        </div>
      </AppLayout>
    )
  }

  /* ── Topic quiz (server-driven progressive unlock) ─────────────── */
  if (!topicQuiz || !serverStatus) {
    return null
  }
  const questions = topicQuiz.questions
  const total = questions.length
  const unlocked = serverStatus.unlocked
  const attemptsCount = serverStatus.attempts
  const answeredCount = Object.keys(answered).length
  const question = questions[qIndex] as (QuizQuestion & { difficulty?: QuizDifficulty }) | undefined

  // Tier boundaries — questions are stored ordered Basic → Moderate → Advanced.
  const tierBounds: Record<QuizDifficulty, { start: number; end: number }> = {
    basic: { start: 0, end: 0 },
    moderate: { start: 0, end: 0 },
    advanced: { start: 0, end: 0 },
  }
  {
    let start = 0
    for (const d of QUIZ_TIER_ORDER) {
      let count = 0
      for (let i = start; i < questions.length; i += 1) {
        if (questions[i].difficulty !== d) break
        count += 1
      }
      tierBounds[d] = { start, end: start + count }
      start += count
    }
  }
  const tierCount = (d: QuizDifficulty) => tierBounds[d].end - tierBounds[d].start
  const tierProgress = (d: QuizDifficulty) => {
    const { start, end } = tierBounds[d]
    let n = 0
    for (let i = start; i < end; i += 1) {
      if (answered[i]) n += 1
    }
    return n
  }

  function startTier(d: QuizDifficulty) {
    if (!unlocked[d]) return
    const { start, end } = tierBounds[d]
    let target = start
    for (let i = start; i < end; i += 1) {
      if (!answered[i]) {
        target = i
        break
      }
    }
    setActiveTier(d)
    setQIndex(Math.min(target, Math.max(start, end - 1)))
    setPhase('question')
  }

  const renderLockedTier = () => {
    if (!question) return null
    const tier = lockedTierFor(question.difficulty, unlocked)
    if (!tier) return null
    const message =
      tier === 'moderate'
        ? `Attempt 3 Basic questions to unlock (${Math.min(3, attemptsCount.basic)}/3 answered)`
        : `Attempt 3 Moderate questions to unlock (${Math.min(3, attemptsCount.moderate)}/3 answered)`
    return (
      <div className="quiz-lock-card">
        <IconLock size={20} />
        <div>
          <strong>{DIFFICULTY_LABEL[tier]} locked</strong>
          <p className="small muted">{message}</p>
        </div>
      </div>
    )
  }

  /* Result phase (topic quiz) */
  if (phase === 'result' && result) {
    const pct = result.submission.percentage
    const statusTone = pct >= 80 ? 'pass' : pct >= 60 ? 'practice' : 'review'
    const review = questions.map((q, i) => {
      const a = answered[i]
      const unsynced = Boolean(a && a.synced === false)
      const wasAnswered = Boolean(a && a.synced !== false)
      const correct = Boolean(a && a.synced !== false && a.correct)
      return { q, i, wasAnswered, correct, unsynced }
    })
    const incorrectCount = review.filter((r) => r.wasAnswered && !r.correct).length
    const skippedCount = review.filter((r) => !r.wasAnswered).length

    const goToTier = (d: QuizDifficulty) => {
      startTier(d)
    }

    return (
      <AppLayout>
        <div className="page page-narrow">
          <div className={`card text-center quiz-result-card ${statusTone}`} style={{ padding: '2.2rem 1.5rem' }}>
            <div className={`quiz-result-medal ${statusTone}`}>
              <IconTrend size={30} />
            </div>
            <h1 style={{ fontSize: '1.5rem' }}>
              {result.submission.score} / {result.submission.total} correct
            </h1>
            <p className="quiz-result-percent">{pct}%</p>
            <p className="muted mt-1">{statusMessage(pct)}</p>

            <div className="quiz-result-counts mt-2">
              <span className="quiz-count-pill success">
                <IconCheck size={13} /> {result.submission.score} correct
              </span>
              {incorrectCount > 0 && (
                <span className="quiz-count-pill danger">
                  <IconX size={13} /> {incorrectCount} incorrect
                </span>
              )}
              {skippedCount > 0 && (
                <span className="quiz-count-pill muted">{skippedCount} skipped</span>
              )}
            </div>

            <div className="quiz-breakdown mt-2">
              {QUIZ_TIER_ORDER.map((d) => {
                const tier = result.submission.breakdown[d]
                if (tier.total === 0) return null
                const tierPct = Math.round((tier.correct / tier.total) * 100)
                return (
                  <div key={d} className="quiz-breakdown-row">
                    <span className={`quiz-difficulty-badge ${d}`}>{DIFFICULTY_LABEL[d]}</span>
                    <div className="quiz-breakdown-track">
                      <div className={`quiz-breakdown-fill ${d}`} style={{ width: `${tierPct}%` }} />
                    </div>
                    <span className="small muted" style={{ whiteSpace: 'nowrap' }}>
                      {tier.correct}/{tier.total}
                    </span>
                  </div>
                )
              })}
            </div>

            <div className="quiz-unlock-progress mt-2">
              {QUIZ_TIER_ORDER.map((d) => (
                <button
                  key={d}
                  type="button"
                  className="quiz-tier-pill"
                  onClick={() => goToTier(d)}
                >
                  {unlocked[d] ? <IconCheck size={12} /> : <IconLock size={12} />}
                  {DIFFICULTY_LABEL[d]}
                </button>
              ))}
            </div>

            {analysis.status !== 'idle' && (
              <div className="quiz-analysis-inline mt-2">
                {analysis.status === 'loading' && (
                  <span className="row small muted" style={{ justifyContent: 'center', gap: '0.5rem' }}>
                    <span className="spinner" style={{ width: 14, height: 14 }} />
                    AI is analyzing your strengths and weak concepts…
                  </span>
                )}
                {analysis.status === 'error' && (
                  <span className="small muted">AI analysis unavailable: {analysis.message}</span>
                )}
                {analysis.status === 'ready' && analysis.analysis && (
                  <button
                    className="btn btn-secondary"
                    onClick={() =>
                      navigate('/ai-roadmap', {
                        state: {
                          analysis: analysis.analysis,
                          topicName: displayTitle,
                          quizScore: result.submission.score,
                          quizTotal: result.submission.total,
                        },
                      })
                    }
                  >
                    <IconSparkles size={16} />
                    View AI Analysis &amp; Next Steps
                  </button>
                )}
              </div>
            )}

            {result.submission.weak_concepts.length > 0 && (
              <div className="mt-2">
                <p className="small muted" style={{ marginBottom: '0.4rem' }}>
                  Concepts to retest:
                </p>
                <div className="quiz-concept-chips">
                  {result.submission.weak_concepts.map((c) => (
                    <span key={c} className="quiz-chip">{c}</span>
                  ))}
                </div>
                {isGoalQuiz ? (
                  <p className="faint small mt-1">
                    These are carried into your AI study plan and adaptive roadmap.
                  </p>
                ) : (
                  <button className="btn btn-primary mt-2" onClick={retest} disabled={retesting}>
                    {retesting ? 'Preparing retest…' : 'Retest Weak Concepts'}
                    {!retesting && <IconArrowRight size={16} />}
                  </button>
                )}
              </div>
            )}

            <div className="row wrap" style={{ justifyContent: 'center', marginTop: '1.2rem' }}>
              {isGoalQuiz ? (
                <Link to="/quiz" className="btn btn-secondary">
                  All goal quizzes
                </Link>
              ) : (
                <button className="btn btn-secondary" onClick={resetRun}>
                  Retake
                </button>
              )}
              <Link to="/performance" className="btn btn-primary">
                <IconTrend size={16} />
                View Performance
              </Link>
              <Link to="/ai-roadmap" className="btn btn-ghost">
                Back to Roadmap
              </Link>
            </div>
          </div>

          <div className="card mt-2">
            <div className="row mb-1" style={{ color: 'var(--primary)' }}>
              <IconSparkles size={18} />
              <h2 style={{ fontSize: '1.05rem' }}>Review every question</h2>
            </div>
            {review.map(({ q, i, wasAnswered, correct, unsynced }) => (
              <div key={q.id} className="quiz-review-item">
                <div className="row-between wrap" style={{ gap: '0.4rem' }}>
                  <div className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                    <span className="small" style={{ fontWeight: 600 }}>
                      {i + 1}. {q.prompt}
                    </span>
                  </div>
                  <div className="row" style={{ gap: '0.4rem' }}>
                    {q.difficulty && (
                      <span className={`quiz-difficulty-badge ${q.difficulty}`}>
                        {DIFFICULTY_LABEL[q.difficulty]}
                      </span>
                    )}
                    <span
                      className={`quiz-count-pill ${unsynced ? 'muted' : correct ? 'success' : wasAnswered ? 'danger' : 'muted'}`}
                    >
                      {unsynced ? <IconSparkles size={12} /> : correct ? <IconCheck size={12} /> : <IconX size={12} />}
                      {unsynced ? 'Syncing' : correct ? 'Correct' : wasAnswered ? 'Incorrect' : 'Skipped'}
                    </span>
                  </div>
                </div>
                <div className="quiz-review-answer">
                  <span className="faint small">
                    Your answer:{' '}
                    {wasAnswered || unsynced ? q.options[answered[i].selected] ?? '—' : 'Not answered'}
                    {unsynced ? ' (not synced to your progress yet — will keep retrying)' : ''}
                  </span>
                  <span className="small" style={{ color: 'var(--success)', fontWeight: 600 }}>
                    Correct: {q.options[q.correctIndex]}
                  </span>
                </div>
                {q.explanation && <p className="small muted">{q.explanation}</p>}
                {q.concept && <span className="quiz-review-tag">Concept: {q.concept}</span>}
              </div>
            ))}
          </div>
        </div>
      </AppLayout>
    )
  }

  /* Intro phase (topic quiz) — tier overview: 30 Questions, one session per tier */
  if (phase === 'intro') {
    const answeredHere = Object.keys(answered).length
    return (
      <AppLayout>
        <div className="page page-narrow">
          <div className="card text-center" style={{ padding: '2.2rem 1.5rem' }}>
            <span className="badge badge-primary" style={{ marginBottom: '0.8rem' }}>
              <IconQuiz size={13} />
              {isGoalQuiz ? `Goal quiz · ${total} questions` : `Topic quiz · ${total} questions`}
            </span>
            <h1 style={{ fontSize: '1.5rem' }}>{displayTitle}</h1>
            <p className="muted mt-1">{total} Questions</p>
            {answeredHere > 0 && (
              <p className="faint small mt-1">
                {answeredHere}/{total} answered · {Math.round((answeredHere / total) * 100)}%
              </p>
            )}
            {topicQuiz.retest_of && (
              <span className="badge badge-focus" style={{ marginTop: '0.6rem' }}>
                <IconSparkles size={12} />
                Targeted retest of your weak concepts
              </span>
            )}
            <div
              className="col"
              style={{
                gap: '0.8rem',
                marginTop: '1.2rem',
                maxWidth: 520,
                marginLeft: 'auto',
                marginRight: 'auto',
              }}
            >
              {QUIZ_TIER_ORDER.map((d) => {
                const wins = unlocked[d]
                const tierDone = tierProgress(d) >= tierCount(d)
                const tierDoneCount = tierProgress(d)
                return (
                  <div key={d} className="topic-quiz-tier-row">
                    <div className="quiz-tier-gate">
                      <span className={`quiz-difficulty-badge ${d}`}>{DIFFICULTY_LABEL[d]}</span>
                      <span className="quiz-tier-count-label">
                        <strong>{tierCount(d)}</strong> Questions
                        {tierDone && (
                          <span className="quiz-tier-done">
                            <IconCheck size={12} />
                            Completed
                          </span>
                        )}
                        {!tierDone && tierDoneCount > 0 && (
                          <span className="faint small">
                            {tierDoneCount}/{tierCount(d)} answered
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="quiz-tier-action">
                      {wins ? (
                        <button
                          className="btn btn-primary"
                          onClick={() => startTier(d)}
                          disabled={submitting}
                        >
                          {tierDoneCount > 0 ? 'Resume' : `Start ${DIFFICULTY_LABEL[d]} Quiz`}
                          <IconArrowRight size={15} />
                        </button>
                      ) : (
                        <div className="quiz-tier-locknote">
                          <IconLock size={15} />
                          <span>
                            {d === 'moderate'
                              ? 'Attempt 3 Basic questions to unlock'
                              : 'Attempt 3 Moderate questions to unlock'}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
            <p className="faint small mt-2">
              Answer any 3 Basic questions to unlock Moderate, then any 3 Moderate to unlock
              Difficult. Correct and incorrect answers both count.
            </p>
            {answeredHere > 0 && (
              <div className="mt-2">
                <button className="btn btn-secondary" onClick={finishQuiz} disabled={submitting}>
                  Finish &amp; See Results
                  <IconTrend size={16} />
                </button>
              </div>
            )}
            <div className="mt-1">
              <Link to="/quiz" className="btn btn-ghost">
                All quizzes
              </Link>
            </div>
          </div>
        </div>
      </AppLayout>
    )
  }

  /* Question phase (topic quiz) — one difficulty session at a time */
  const questionIndex = qIndex
  const currentQ = question
  if (!currentQ) {
    return null
  }
  const active = (activeTier ?? currentQ.difficulty ?? 'basic') as QuizDifficulty
  const { start: tierStart, end: tierEnd } = tierBounds[active]
  const tierTotal = tierCount(active)
  const questionInTier = questionIndex - tierStart
  const answeredNow = answered[questionIndex]
  const currentlySelected = selected[questionIndex]
  const isLocked = !unlocked[active]
  const atTierEnd = questionIndex >= tierEnd - 1
  const tierDone = tierProgress(active)
  const progress = tierTotal > 0 ? ((questionInTier + (answeredNow ? 1 : 0)) / tierTotal) * 100 : 0
  const activeLabel = DIFFICULTY_LABEL[active]
  const nextTier = QUIZ_TIER_ORDER[QUIZ_TIER_ORDER.indexOf(active) + 1] as QuizDifficulty | undefined
  const nextUnlocked = Boolean(nextTier && unlocked[nextTier])

  const goNext = () => {
    const next = questionIndex + 1
    if (next >= tierEnd || next >= total) return
    setQIndex(next)
  }

  const goPrev = () => {
    if (questionIndex > tierStart) setQIndex(questionIndex - 1)
  }

  const continueNext = () => {
    if (nextTier && unlocked[nextTier]) startTier(nextTier)
    else void finishQuiz()
  }

  const backToOverview = () => {
    setActiveTier(null)
    setPhase('intro')
  }

  const tierCommand = (d: QuizDifficulty) => {
    if (unlocked[d]) startTier(d)
  }

  return (
    <AppLayout>
      <div className="page">
        <div className="quiz-split">
          {/* LEFT — the quiz itself */}
          <div className="col" style={{ gap: '1rem', minWidth: 0 }}>
            <div className="row-between wrap" style={{ gap: '0.6rem' }}>
              <div className="row" style={{ gap: '0.7rem', alignItems: 'center' }}>
                <span className="quiz-step-pill">
                  <IconQuiz size={13} />
                  {activeLabel} Quiz
                </span>
                <span className="small muted">
                  Question {questionInTier + 1} of {tierTotal}
                </span>
              </div>
              <div className="row" style={{ gap: '0.5rem' }}>
                <button className="btn btn-ghost" onClick={backToOverview}>
                  Overview
                </button>
                <Link to="/quiz" className="btn btn-ghost">Quit</Link>
              </div>
            </div>

            <div className="quiz-progress-track">
              <div className="quiz-progress-fill" style={{ width: `${progress}%` }} />
            </div>

            {notice && (
              <div className="banner banner-warning mt-2" role="status">
                <IconSparkles size={17} />
                <span>{notice}</span>
              </div>
            )}

            <div className="quiz-tier-nav">
              {QUIZ_TIER_ORDER.map((d) => {
                const isCurrent = d === active
                const wins = unlocked[d]
                return (
                  <button
                    key={d}
                    type="button"
                    className={`quiz-tier-pill ${wins ? 'unlocked' : 'locked'} ${isCurrent ? 'quiz-tier-pill-active' : ''}`}
                    onClick={() => tierCommand(d)}
                  >
                    {wins ? <IconCheck size={12} /> : <IconLock size={12} />}
                    {DIFFICULTY_LABEL[d]}
                    <span className="faint small">
                      {wins
                        ? `${tierProgress(d)}/${tierCount(d)}`
                        : d === 'moderate'
                          ? `${Math.min(3, attemptsCount.basic)}/3 Basic`
                          : `${Math.min(3, attemptsCount.moderate)}/3 Moderate`}
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="card" style={{ padding: '1.6rem 1.6rem 1.3rem' }}>
              <div className="row wrap" style={{ gap: '0.5rem', marginBottom: '0.6rem' }}>
                <span className={`quiz-difficulty-badge ${active}`}>{activeLabel}</span>
                {currentQ.concept && <span className="badge badge-muted">{currentQ.concept}</span>}
              </div>

              {isLocked ? (
                renderLockedTier()
              ) : (
                <>
                  <p className="quiz-question" style={{ fontSize: '1.15rem', fontWeight: 600 }}>
                    {currentQ.prompt}
                  </p>

                  <div className="col" style={{ gap: '0.7rem' }}>
                    {currentQ.options.map((opt, i) => {
                      let cls = 'quiz-option'
                      let inner = <span className="quiz-radio">{String.fromCharCode(65 + i)}</span>
                      if (answeredNow) {
                        if (i === currentQ.correctIndex) {
                          cls += ' correct'
                          inner = <span className="quiz-radio"><IconCheck size={11} /></span>
                        } else if (i === answeredNow.selected) {
                          cls += ' wrong'
                          inner = <span className="quiz-radio"><IconX size={11} /></span>
                        } else {
                          cls += ' dim'
                        }
                      } else if (i === currentlySelected) {
                        cls += ' selected'
                      }
                      return (
                        <button
                          key={i}
                          className={cls}
                          onClick={() =>
                            setSelected((prev) => {
                              const nextArr = [...prev]
                              nextArr[questionIndex] = i
                              return nextArr
                            })
                          }
                          disabled={Boolean(answeredNow)}
                        >
                          {inner}
                          <span>{opt}</span>
                        </button>
                      )
                    })}
                  </div>

                  {answeredNow && answeredNow.synced === false && (
                    <div className="banner banner-warning mt-1" style={{ opacity: 0.85 }}>
                      <IconSparkles size={17} />
                      <span>
                        Answer kept on this device — syncing to your progress, you can keep going.
                      </span>
                    </div>
                  )}
                  {answeredNow && answeredNow.synced !== false && (
                    <div
                      className={`banner ${answeredNow.correct ? 'banner-success' : 'banner-warning'} mt-1`}
                    >
                      <IconCheck size={17} />
                      <span>
                        {answeredNow.correct ? 'Correct! ' : 'Not quite. '}
                        {currentQ.explanation}
                      </span>
                    </div>
                  )}
                  {!answeredNow && currentlySelected !== null && currentlySelected !== undefined && (
                    <button
                      className="btn btn-primary btn-block mt-2"
                      onClick={() => submitAnswer(currentlySelected)}
                      disabled={submitting}
                    >
                      {submitting ? 'Saving…' : 'Submit Answer'}
                      <IconCheck size={15} />
                    </button>
                  )}

                  <div className="row-between mt-2">
                    <button className="btn btn-ghost" onClick={goPrev} disabled={questionIndex <= tierStart}>
                      Previous
                    </button>
                    <div
                      className="row"
                      style={{ gap: '0.6rem', flexWrap: 'wrap', justifyContent: 'center' }}
                    >
                      <span className="faint small">
                        {tierDone}/{tierTotal} {activeLabel} answered
                      </span>
                      {answeredNow ? (
                        atTierEnd ? (
                          <button className="btn btn-primary" onClick={continueNext} disabled={submitting}>
                            {nextUnlocked ? `Next: ${DIFFICULTY_LABEL[nextTier!]} Quiz` : 'Finish &amp; See Results'}
                            {nextUnlocked ? <IconArrowRight size={15} /> : <IconTrend size={15} />}
                          </button>
                        ) : (
                          <button
                            className="btn btn-primary"
                            onClick={goNext}
                            disabled={submitting}
                          >
                            Next Question
                            <IconArrowRight size={15} />
                          </button>
                        )
                      ) : (
                        <button
                          className="btn btn-ghost"
                          onClick={finishQuiz}
                          disabled={answeredCount === 0 || submitting}
                        >
                          Finish &amp; See Results
                          <IconTrend size={15} />
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* RIGHT — AI study panel */}
          <aside className="quiz-side" aria-label="AI study panel">
            <div className="card quiz-side-panel">
              <h3>Think. Learn. Grow.</h3>
              <p className="small muted" style={{ marginTop: '0.3rem' }}>
                Every answer shapes your personalized study plan.
              </p>
              <div className="quiz-progress-track mt-2" style={{ height: 6 }}>
                <div className="quiz-progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <ul className="keypoint-list mt-2" style={{ margin: '0.9rem 0 0' }}>
                <li>
                  <IconCheck size={14} />
                  <span>Instant feedback on every answer</span>
                </li>
                <li>
                  <IconSparkles size={14} />
                  <span>Answer 3 Basic to unlock Moderate, 3 Moderate to unlock Difficult</span>
                </li>
                <li>
                  <IconTrend size={14} />
                  <span>AI pinpoints your strong &amp; weak areas</span>
                </li>
              </ul>
            </div>
            <div className="card" style={{ marginTop: '1rem', padding: '1rem 1.1rem' }}>
              <div className="row" style={{ gap: '0.6rem' }}>
                <IconLock size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                <span className="small muted">
                  Locked questions unlock as you submit answers — your choices unlock the next
                  tier in real time.
                </span>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </AppLayout>
  )
}