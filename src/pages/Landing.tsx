import { Link } from 'react-router-dom'
import { Logo } from '../components/Logo'
import {
  IconArrowRight,
  IconCheck,
  IconClock,
  IconEye,
  IconQuiz,
  IconShield,
  IconSparkles,
  IconTrend,
} from '../components/Icons'

/** The mock roadmap nodes shown in the hero preview card. */
const previewNodes = [
  {
    icon: IconCheck,
    title: 'HTML Foundations',
    sub: '3 lessons · done',
    pill: '100%',
    tone: 'done' as const,
  },
  {
    icon: IconClock,
    title: 'CSS & Responsive Layout',
    sub: 'in progress · 34 min today',
    pill: '62%',
    tone: 'current' as const,
  },
  {
    icon: IconSparkles,
    title: 'JavaScript Fundamentals',
    sub: 'unlocks next',
    pill: '0%',
    tone: 'next' as const,
  },
]

const features = [
  {
    icon: IconSparkles,
    title: 'AI Roadmaps',
    desc: 'Tell us your goal — get a clear step-by-step path built for your level and schedule.',
  },
  {
    icon: IconEye,
    title: 'Distraction-Free Focus',
    desc: 'A calm reader mode with a session timer that keeps distracting sites out of sight.',
  },
  {
    icon: IconQuiz,
    title: 'Understanding Checks',
    desc: 'Short quizzes after each lesson test real understanding, not memorization.',
  },
  {
    icon: IconTrend,
    title: 'Weak-Area Detection',
    desc: 'See exactly which topics need review, with recommendations for what to learn next.',
  },
]

const steps = [
  {
    n: '1',
    title: 'Choose your goal',
    desc: 'Pick from a goal catalog or describe what you want to learn.',
  },
  {
    n: '2',
    title: 'Follow your roadmap',
    desc: 'The AI breaks your goal into small lessons with time estimates.',
  },
  {
    n: '3',
    title: 'Stay focused',
    desc: 'Learn in a distraction-free reader with a built-in session timer.',
  },
  {
    n: '4',
    title: 'Prove & improve',
    desc: 'Quizzes find weak areas; recommendations guide your next step.',
  },
]

function toneClass(tone: 'done' | 'current' | 'next') {
  if (tone === 'done') return 'badge-success'
  if (tone === 'current') return 'badge-focus'
  return 'badge-muted'
}

export default function Landing() {
  return (
    <div className="landing">
      <nav className="landing-nav">
        <Logo to="/" />
        <div className="landing-links">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <Link to="/login">Log in</Link>
        </div>
        <Link to="/signup" className="btn btn-primary">
          Get Started
        </Link>
      </nav>

      <header className="landing-hero">
        <span className="hero-badge">
          <IconSparkles size={15} />
          AI-powered personalized learning
        </span>
        <h1>Learn What Matters. Stay Focused.</h1>
        <p className="hero-subtitle">
          An AI-powered learning platform that creates your roadmap, removes distractions, checks
          your understanding, and guides your next step.
        </p>
        <div className="hero-ctas">
          <Link to="/dashboard" className="btn btn-primary btn-lg">
            Start Learning
            <IconArrowRight size={18} />
          </Link>
          <Link to="/goals" className="btn btn-secondary btn-lg">
            Explore Demo
          </Link>
        </div>
        <p className="hero-tagline">
          Choose Your Goal. Follow Your Roadmap. Stay Focused. Learn Smarter.
        </p>
      </header>

      {/* Visual preview of an AI-generated roadmap */}
      <section className="hero-preview" aria-label="Roadmap preview">
        <div className="roadmap-mock">
          <div className="roadmap-mock-header">
            <span className="dot" style={{ background: '#f87171' }} />
            <span className="dot" style={{ background: '#fbbf24' }} />
            <span className="dot" style={{ background: '#34d399' }} />
            <span className="small muted" style={{ marginLeft: '0.5rem' }}>
              focuslearn.app/roadmap
            </span>
            <span className="badge badge-primary" style={{ marginLeft: 'auto' }}>
              <IconSparkles size={12} />
              AI-generated
            </span>
          </div>
          <div className="roadmap-mock-body">
            <div className="roadmap-mock-nodes">
              {previewNodes.map((n) => (
                <div key={n.title} className="mock-node">
                  <span className="icon" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                    <n.icon size={17} />
                  </span>
                  <span>
                    <span className="t">{n.title}</span>
                    <br />
                    <span className="s">{n.sub}</span>
                  </span>
                  <span className={`badge pill ${toneClass(n.tone)}`}>{n.pill}</span>
                </div>
              ))}
            </div>
            <aside className="roadmap-mock-side">
              <span className="badge badge-warning">This week</span>
              <div className="row-between">
                <span className="small muted">Roadmap progress</span>
                <strong>47%</strong>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: '47%' }} />
              </div>
              <div className="row-between">
                <span className="small muted">Focus streak</span>
                <strong>6 days 🔥</strong>
              </div>
              <div className="row-between">
                <span className="small muted">Avg. quiz score</span>
                <strong>70%</strong>
              </div>
              <div className="banner banner-info" style={{ padding: '0.7rem 0.9rem' }}>
                <IconSparkles size={16} />
                <span className="small">
                  <strong>Next:</strong> Flexbox &amp; Grid — 18 min
                </span>
              </div>
            </aside>
          </div>
        </div>
      </section>

      <section className="landing-section" id="features">
        <div className="landing-section-head">
          <h2>Everything a focused learner needs</h2>
          <p>Five tools that work together — from deciding what to learn to mastering it.</p>
        </div>
        <div className="grid grid-4">
          {features.map((f) => (
            <div key={f.title} className="card">
              <span
                className="icon"
                style={{
                  display: 'inline-flex',
                  width: 40,
                  height: 40,
                  borderRadius: 12,
                  background: 'var(--primary-soft)',
                  color: 'var(--primary)',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: '0.8rem',
                }}
              >
                <f.icon size={20} />
              </span>
              <h3 className="card-title">{f.title}</h3>
              <p className="card-desc">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section" id="how">
        <div className="landing-section-head">
          <h2>How FocusLearn works</h2>
          <p>A simple loop: choose, learn, check, improve.</p>
        </div>
        <div className="grid grid-4">
          {steps.map((s) => (
            <div key={s.n} className="card">
              <span
                className="badge badge-primary"
                style={{ width: 30, height: 30, justifyContent: 'center', fontSize: '0.9rem' }}
              >
                {s.n}
              </span>
              <h3 className="card-title mt-2">{s.title}</h3>
              <p className="card-desc">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section">
        <div className="card text-center" style={{ padding: '2.5rem 1.5rem' }}>
          <h2>Ready to learn smarter?</h2>
          <p className="muted mt-1" style={{ maxWidth: 480, margin: '0.5rem auto 1.4rem' }}>
            Join students who stopped guessing what to learn next.
          </p>
          <div className="hero-ctas">
            <Link to="/signup" className="btn btn-primary btn-lg">
              Create free account
            </Link>
            <Link to="/dashboard" className="btn btn-secondary btn-lg">
              <IconShield size={18} />
              Try the demo
            </Link>
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        © 2026 FocusLearn · Choose Your Goal. Follow Your Roadmap. Stay Focused. Learn Smarter.
      </footer>
    </div>
  )
}
