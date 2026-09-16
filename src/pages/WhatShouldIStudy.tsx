import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { getStudyAdvice, type StudyAdvice } from '../services/aiService'
import {
  IconArrowRight,
  IconCheck,
  IconClock,
  IconMap,
  IconPlay,
  IconSparkles,
  IconTarget,
} from '../components/Icons'

type Level = 'Beginner' | 'Intermediate' | 'Advanced'
type Knowledge = 'I am starting from zero' | 'I know the basics' | 'I know intermediate concepts'

const levels: Level[] = ['Beginner', 'Intermediate', 'Advanced']
const times = ['15 minutes', '30 minutes', '1 hour', '2 hours']
const knowledgeOptions: Knowledge[] = [
  'I am starting from zero',
  'I know the basics',
  'I know intermediate concepts',
]

const goalCards = [
  { label: 'Placement', goal: 'Crack my campus placement interviews' },
  { label: 'DSA', goal: 'Master Data Structures and Algorithms' },
  { label: 'Programming', goal: 'Learn programming from scratch' },
  { label: 'AI', goal: 'Learn Artificial Intelligence' },
  { label: 'Projects', goal: 'Build strong projects for my portfolio' },
  { label: 'Exams', goal: 'Prepare for my college exams' },
]

export default function WhatShouldIStudy() {
  const navigate = useNavigate()

  const [goal, setGoal] = useState('')
  const [level, setLevel] = useState<Level>('Beginner')
  const [timePerDay, setTimePerDay] = useState('30 minutes')
  const [knowledge, setKnowledge] = useState<Knowledge>('I am starting from zero')
  const [loading, setLoading] = useState(false)
  const [advice, setAdvice] = useState<StudyAdvice | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleGenerate(goalOverride?: string) {
    const topic = (goalOverride ?? goal).trim()
    if (!topic) {
      setError('Enter a learning goal first.')
      return
    }
    setGoal(topic)
    setLoading(true)
    setAdvice(null)
    setError(null)
    const result = await getStudyAdvice({ goal: topic, level, timePerDay, knowledge })
    if (result.state === 'ready') {
      setAdvice(result.advice)
    } else {
      setError(result.message)
    }
    setLoading(false)
  }

  return (
    <AppLayout>
      <div className="page">
        <div className="page-header">
          <h1>What Should I Study?</h1>
          <p>Tell FocusLearn your goal, and we'll suggest what you should learn next.</p>
        </div>

        {/* Input form */}
        <div className="card">
          <div className="goal-card-grid" role="group" aria-label="Popular learning goals">
            {goalCards.map((c) => (
              <button
                key={c.label}
                type="button"
                className={`goal-card-chip${goal === c.goal ? ' active' : ''}`}
                onClick={() => {
                  if (!loading) void handleGenerate(c.goal)
                }}
              >
                <IconTarget size={15} />
                {c.label}
              </button>
            ))}
          </div>

          <div className="form-group">
            <label htmlFor="wsis-goal">Learning Goal</label>
            <input
              id="wsis-goal"
              type="text"
              placeholder='e.g. "I want to learn Data Structures and Algorithms."'
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !loading) void handleGenerate()
              }}
            />
          </div>

          <div className="grid grid-2">
            <div className="form-group">
              <label>Current Level</label>
              <div className="option-row">
                {levels.map((lv) => (
                  <button
                    key={lv}
                    type="button"
                    className={`option-pill${level === lv ? ' selected' : ''}`}
                    onClick={() => setLevel(lv)}
                  >
                    {lv}
                  </button>
                ))}
              </div>
            </div>

            <div className="form-group">
              <label>Available Study Time</label>
              <div className="option-row">
                {times.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`option-pill${timePerDay === t ? ' selected' : ''}`}
                    onClick={() => setTimePerDay(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Current Knowledge</label>
            <div className="option-row">
              {knowledgeOptions.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`option-pill${knowledge === k ? ' selected' : ''}`}
                  onClick={() => setKnowledge(k)}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>

          <div className="row wrap mt-2">
            <button className="btn btn-primary btn-lg" onClick={() => void handleGenerate()} disabled={loading}>
              <IconSparkles size={17} />
              {loading ? 'Analyzing…' : 'Generate Recommendation'}
            </button>
            <span className="form-hint">
              Live engine — topic is SafeSearch-validated before the plan is generated.
            </span>
          </div>
        </div>

        {/* Loading animation */}
        {loading && (
          <div className="card analyzing-card mt-2">
            <span className="spinner" aria-hidden />
            <div>
              <strong>Analyzing your goal and current level...</strong>
              <p className="small muted">
                Matching your inputs against our curated learning paths.
              </p>
            </div>
          </div>
        )}

        {/* Failure state */}
        {error && !loading && (
          <div className="card empty-state mt-2">
            <IconSparkles size={36} />
            <p>{error}</p>
            <button className="btn btn-primary mt-2" onClick={() => void handleGenerate()}>
              Try again
            </button>
          </div>
        )}

        {/* Result */}
        {advice && !loading && (
          <div className="col mt-2">
            {/* Learning path */}
            <div className="card">
              <div className="row-between mb-1 wrap">
                <h2 style={{ fontSize: '1.15rem' }}>Your Recommended Learning Path</h2>
                <span className="badge badge-focus">
                  <IconClock size={12} />
                  ~{advice.estimatedWeeks} weeks at {timePerDay.toLowerCase()} / day
                </span>
              </div>
              <p className="muted small mb-2">{advice.summary}</p>

              <div className="col" style={{ gap: '0.45rem' }}>
                {advice.path.map((step, i) => (
                  <div key={step} className="path-step">
                    <span className="path-num">{i + 1}</span>
                    <span className="path-title">{step}</span>
                    {i === 0 && <span className="badge badge-primary">Start here</span>}
                  </div>
                ))}
              </div>
            </div>

            {/* Next topic recommendation */}
            <div className="card ai-card">
              <div className="row mb-1" style={{ color: 'var(--accent)' }}>
                <IconSparkles size={18} />
                <h2 style={{ fontSize: '1.05rem' }}>Your next recommended topic</h2>
              </div>
              <h3 className="ai-topic">{advice.nextTopic}</h3>
              <p className="small muted">
                <strong>Why?</strong> “{advice.reason}”
              </p>
              <div className="row wrap mt-2">
                <button
                  className="btn btn-primary"
                  onClick={() =>
                    navigate(`/search?topic=${encodeURIComponent(advice.nextTopic)}`)
                  }
                >
                  <IconPlay size={15} />
                  Start Learning
                </button>
                <button className="btn btn-secondary" onClick={() => navigate('/ai-roadmap')}>
                  <IconMap size={15} />
                  View Full Roadmap
                </button>
              </div>
            </div>

            {/* What you told us — echo inputs as chips */}
            <div className="card">
              <h2 style={{ fontSize: '1.05rem' }} className="mb-1">
                <span className="row" style={{ color: 'var(--primary)' }}>
                  <IconTarget size={17} />
                  How we personalized this
                </span>
              </h2>
              <div className="tag-wrap">
                <span className="badge badge-muted tag-lg">{level}</span>
                <span className="badge badge-muted tag-lg">{timePerDay} / day</span>
                <span className="badge badge-muted tag-lg">{knowledge}</span>
                {goal.trim() && (
                  <span className="badge badge-primary tag-lg">
                    <IconCheck size={12} />“{goal.trim()}”
                  </span>
                )}
              </div>
              <button
                className="btn btn-ghost mt-1"
                style={{ paddingLeft: 0 }}
                onClick={() => void handleGenerate()}
              >
                Regenerate
                <IconArrowRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  )
}
