import { useEffect, useMemo, useState } from 'react'
import type { Quiz, QuizQuestion } from '../types'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { useApp } from '../context/AppContext'
import { quizzes } from '../data/student'
import {
  generateQuiz as generateQuizMock,
  getTopicQuiz,
  normalizeTopic,
  analyzeQuizPerformance,
  type AnalyzePerformanceInput,
} from '../services/aiService'
import {
  IconArrowRight,
  IconCheck,
  IconQuiz,
  IconSparkles,
  IconTarget,
  IconTrend,
  IconX,
} from '../components/Icons'

type Phase = 'intro' | 'question' | 'result' | 'analyzing'

export default function Quiz() {
  const { lessonId, topic } = useParams()
  const navigate = useNavigate()
  const { roadmap, recordAttempt, attempts } = useApp()

  // Topic quiz (from Focus Mode) — generated for ANY searched topic via
  // generateQuiz(currentTopic). Falls back to the sync mock on failure so
  // the quiz never breaks.
  const topicName = topic ? normalizeTopic(topic) : null
  const [topicQuiz, setTopicQuiz] = useState<Quiz | undefined>(
    topicName ? getTopicQuiz(topicName) : undefined,
  )
  useEffect(() => {
    if (!topicName) return
    let cancelled = false
    generateQuizMock(topicName)
      .then((q) => {
        if (!cancelled) setTopicQuiz(q)
      })
      .catch(() => {
        if (!cancelled) setTopicQuiz(getTopicQuiz(topicName))
      })
    return () => {
      cancelled = true
    }
  }, [topicName])

  const quiz = lessonId ? quizzes[lessonId] : topicQuiz

  // Quiz hub when no lesson id is given.
  const availableQuizzes = useMemo(() => {
    if (!roadmap) return []
    const out: { lessonId: string; title: string; stepTitle: string; done: boolean }[] = []
    for (const step of roadmap.steps) {
      for (const lesson of step.lessons) {
        if (lesson.id in quizzes) {
          out.push({
            lessonId: lesson.id,
            title: lesson.title,
            stepTitle: step.title,
            done: attempts.some((a) => a.lessonId === lesson.id),
          })
        }
      }
    }
    return out
  }, [roadmap, attempts])

  const [phase, setPhase] = useState<Phase>('intro')
  const [qIndex, setQIndex] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  const [answered, setAnswered] = useState(false)
  const [score, setScore] = useState(0)
  const [missed, setMissed] = useState<string[]>([])
  // Track every answer (selected index) and the correct answer for AI analysis
  const [allAnswers, setAllAnswers] = useState<number[]>([])
  const [allCorrectAnswers, setAllCorrectAnswers] = useState<number[]>([])
  const [analysisError, setAnalysisError] = useState<string | null>(null)

  if ((!lessonId && !topicQuiz) || !quiz) {
    return (
      <AppLayout>
        <div className="page">
          <div className="page-header">
            <h1>Understanding Checks</h1>
            <p>Short quizzes that test real understanding after each lesson.</p>
          </div>
          {availableQuizzes.length > 0 ? (
            <div className="grid-auto">
              {availableQuizzes.map((q) => (
                <div
                  key={q.lessonId}
                  className="card card-hover"
                  onClick={() => navigate(`/quiz/${q.lessonId}`)}
                >
                  <div className="row-between mb-1">
                    <span className="badge badge-primary">{q.stepTitle}</span>
                    {q.done && <span className="badge badge-success">Attempted</span>}
                  </div>
                  <h3 className="card-title">{q.title}</h3>
                  <p className="card-desc">2 questions · quick understanding check</p>
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

  const question = quiz.questions[qIndex]
  const total = quiz.questions.length

  function start() {
    setPhase('question')
    setQIndex(0)
    setSelected(null)
    setAnswered(false)
    setScore(0)
    setMissed([])
    setAllAnswers([])
    setAllCorrectAnswers([])
    setAnalysisError(null)
  }

  function choose(i: number) {
    if (answered) return
    setSelected(i)
    setAnswered(true)
    if (i === question.correctIndex) {
      setScore((s) => s + 1)
    } else {
      setMissed((m) => [...m, question.id])
    }
  }

  function nextQuestion() {
    // Record this answer
    const newAnswers = [...allAnswers, selected ?? -1]
    const newCorrect = [...allCorrectAnswers, question.correctIndex]
    setAllAnswers(newAnswers)
    setAllCorrectAnswers(newCorrect)

    if (qIndex + 1 < total) {
      setQIndex((i) => i + 1)
      setSelected(null)
      setAnswered(false)
    } else {
      // Quiz complete — record attempt and start AI analysis
      const finalScore = selected === question.correctIndex ? score + 1 : score
      const finalMissed = selected === question.correctIndex ? missed : [...missed, question.id]
      const pct = Math.round((finalScore / total) * 100)

      recordAttempt({
        lessonId: quiz!.lessonId,
        score: finalScore,
        total,
        percentage: pct,
        missedQuestionIds: finalMissed,
      })

      // If this is a topic quiz (from AI roadmap), run AI analysis
      if (topicName && quiz!.lessonId.startsWith('topic-')) {
        setPhase('analyzing')
        runAiAnalysis(newAnswers, newCorrect, finalScore, total)
      } else {
        setPhase('result')
      }
    }
  }

  async function runAiAnalysis(
    answers: number[],
    correctAnswers: number[],
    finalScore: number,
    totalQ: number,
  ) {
    const conceptQuestions: AnalyzePerformanceInput['questions'] = quiz!.questions.map(
      (q: QuizQuestion) => ({
        prompt: q.prompt,
        options: q.options,
        correctIndex: q.correctIndex,
        concept: q.concept || q.prompt.slice(0, 30),
      }),
    )

    const result = await analyzeQuizPerformance({
      roadmap_topic: topicName!,
      quiz_score: finalScore,
      total_questions: totalQ,
      questions: conceptQuestions,
      answers,
      correct_answers: correctAnswers,
    })

    if (result.state === 'ready') {
      // Navigate back to AI roadmap with analysis results
      navigate('/ai-roadmap', {
        state: {
          analysis: result.analysis,
          topicName: topicName,
          quizScore: finalScore,
          quizTotal: totalQ,
        },
      })
    } else {
      // AI analysis failed — fall back to basic result display
      setAnalysisError(result.message)
      setPhase('result')
    }
  }

  if (phase === 'intro') {
    return (
      <AppLayout>
        <div className="page page-narrow">
          <div className="card text-center" style={{ padding: '2.2rem 1.5rem' }}>
            <span className="badge badge-primary" style={{ marginBottom: '0.8rem' }}>
              <IconQuiz size={13} />
              Understanding check
            </span>
            <h1 style={{ fontSize: '1.5rem' }}>{quiz.title}</h1>
            <p className="muted mt-1">
              {total} questions · quick check on "{quiz.title.replace(' — Check', '')}"
            </p>
            {topicName && (
              <span className="badge badge-focus" style={{ marginTop: '0.6rem' }}>
                Generated for your Focus Mode topic: {topicName}
              </span>
            )}
            <button className="btn btn-primary btn-lg mt-2" onClick={start}>
              Start Quiz
              <IconArrowRight size={17} />
            </button>
            <div className="mt-2">
              <Link to="/quiz" className="btn btn-ghost">
                All quizzes
              </Link>
            </div>
          </div>
        </div>
      </AppLayout>
    )
  }

  if (phase === 'analyzing') {
    return (
      <AppLayout>
        <div className="page page-narrow">
          <div className="card text-center" style={{ padding: '3rem 1.5rem' }}>
            <span className="spinner" style={{ width: 32, height: 32, margin: '0 auto 1rem' }} />
            <h2 style={{ fontSize: '1.2rem' }}>AI is analyzing your performance...</h2>
            <p className="muted mt-1">
              Identifying your strong and weak concepts to create a personalized study plan.
            </p>
          </div>
        </div>
      </AppLayout>
    )
  }

  if (phase === 'result') {
    const pct = Math.round((score / total) * 100)
    return (
      <AppLayout>
        <div className="page page-narrow">
          <div className="card text-center" style={{ padding: '2.2rem 1.5rem' }}>
            <div
              style={{
                width: 72,
                height: 72,
                borderRadius: '50%',
                margin: '0 auto 1rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: pct >= 80 ? 'var(--success-soft)' : 'var(--warning-soft)',
                color: pct >= 80 ? 'var(--success)' : 'var(--warning)',
              }}
            >
              <IconTrend size={30} />
            </div>
            <h1 style={{ fontSize: '1.5rem' }}>
              {score} / {total} correct
            </h1>
            <p className="muted mt-1">
              {pct >= 80
                ? 'Strong understanding — you can move forward confidently.'
                : 'Good effort — review the explanations below and try again.'}
            </p>
            {analysisError && (
              <div className="banner banner-warning mt-2" style={{ textAlign: 'left' }}>
                <IconSparkles size={16} />
                <span>AI analysis unavailable: {analysisError}. Showing basic results.</span>
              </div>
            )}
            <div className="row wrap" style={{ justifyContent: 'center', marginTop: '1.2rem' }}>
              <button className="btn btn-secondary" onClick={start}>
                Retake
              </button>
              <Link to="/performance" className="btn btn-primary">
                <IconTrend size={16} />
                View Performance
              </Link>
              <Link to="/ai-roadmap" className="btn btn-ghost">
                Back to Roadmap
              </Link>
            </div>
          </div>

          {missed.length > 0 && (
            <div className="card mt-2">
              <div className="row mb-1" style={{ color: 'var(--warning)' }}>
                <IconSparkles size={18} />
                <h2 style={{ fontSize: '1.05rem' }}>What to review</h2>
              </div>
              {quiz.questions
                .filter((q) => missed.includes(q.id))
                .map((q) => (
                  <div key={q.id} className="list-row">
                    <div style={{ minWidth: 0 }}>
                      <div className="small" style={{ fontWeight: 600 }}>
                        {q.prompt}
                      </div>
                      <div className="faint" style={{ fontSize: '0.82rem' }}>
                        Correct answer: {q.options[q.correctIndex]}
                      </div>
                      {q.concept && (
                        <div className="small" style={{ color: 'var(--primary)', marginTop: '0.2rem' }}>
                          Concept: {q.concept}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      </AppLayout>
    )
  }

  // Question phase
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
                  Quick Quiz
                </span>
                <span className="small muted">
                  Question {qIndex + 1} of {total}
                </span>
              </div>
              <Link to="/quiz" className="btn btn-ghost">
                Quit
              </Link>
            </div>

            <div className="quiz-progress-track">
              <div
                className="quiz-progress-fill"
                style={{ width: `${((qIndex + (answered ? 1 : 0)) / total) * 100}%` }}
              />
            </div>

            <div className="card" style={{ padding: '1.6rem 1.6rem 1.3rem' }}>
              <p className="quiz-question" style={{ fontSize: '1.15rem', fontWeight: 600 }}>
                {question.prompt}
              </p>
              {question.concept && (
                <span className="badge badge-muted" style={{ marginBottom: '0.8rem', alignSelf: 'flex-start' }}>
                  {question.concept}
                </span>
              )}

              <div className="col" style={{ gap: '0.7rem' }}>
                {question.options.map((opt, i) => {
                  let cls = 'quiz-option'
                  let inner = <span className="quiz-radio">{String.fromCharCode(65 + i)}</span>
                  if (answered) {
                    if (i === question.correctIndex) {
                      cls += ' correct'
                      inner = (
                        <span className="quiz-radio">
                          <IconCheck size={11} />
                        </span>
                      )
                    } else if (i === selected) {
                      cls += ' wrong'
                      inner = (
                        <span className="quiz-radio">
                          <IconX size={11} />
                        </span>
                      )
                    } else {
                      cls += ' dim'
                    }
                  } else if (i === selected) {
                    cls += ' selected'
                  }
                  return (
                    <button key={i} className={cls} onClick={() => choose(i)} disabled={answered}>
                      {inner}
                      <span>{opt}</span>
                    </button>
                  )
                })}
              </div>

              {answered && (
                <div
                  className={`banner ${selected === question.correctIndex ? 'banner-success' : 'banner-warning'} mt-1`}
                >
                  <IconCheck size={17} />
                  <span>
                    {selected === question.correctIndex ? 'Correct! ' : 'Not quite. '}
                    {question.explanation}
                  </span>
                </div>
              )}

              <div className="row-between mt-2">
                <Link to="/ai-roadmap" className="btn btn-ghost">
                  Quit
                </Link>
                <button className="btn btn-primary" onClick={nextQuestion} disabled={!answered}>
                  {qIndex + 1 < total ? 'Next Question' : 'See Results'}
                  <IconArrowRight size={15} />
                </button>
              </div>
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
                <div
                  className="quiz-progress-fill"
                  style={{ width: `${((qIndex + (answered ? 1 : 0)) / total) * 100}%` }}
                />
              </div>
              <ul className="keypoint-list mt-2" style={{ margin: '0.9rem 0 0' }}>
                <li>
                  <IconCheck size={14} />
                  <span>Instant feedback on every answer</span>
                </li>
                <li>
                  <IconSparkles size={14} />
                  <span>AI pinpoints your strong &amp; weak areas</span>
                </li>
                <li>
                  <IconTrend size={14} />
                  <span>Personalized next-topic recommendation</span>
                </li>
              </ul>
            </div>
            <div className="card" style={{ marginTop: '1rem', padding: '1rem 1.1rem' }}>
              <div className="row" style={{ gap: '0.6rem' }}>
                <IconTarget size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                <span className="small muted">Pro tip: read each explanation before moving on — it locks the concept in faster.</span>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </AppLayout>
  )
}
