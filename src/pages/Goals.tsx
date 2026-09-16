import { useEffect, useMemo, useState } from 'react'
import type { ComponentType } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { useApp } from '../context/AppContext'
import { goals as goalCatalog } from '../data/goals'
import { getRoadmapForGoal } from '../data/roadmaps'
import type { Difficulty, Goal, RoadmapCandidate } from '../types'
import {
  CATEGORY_LABELS,
  GROUP_LABELS,
  ROADMAP_FILTERS,
  fetchRoadmapCatalog,
  filterCatalog,
  matchesQuery,
  refreshRoadmapCatalog,
} from '../services/roadmapCatalog'
import {
  IconArrowRight,
  IconBook,
  IconBranch,
  IconChart,
  IconClock,
  IconCode,
  IconMap,
  IconPalette,
  IconSearch,
  IconSettings,
  IconShield,
  IconSparkles,
  IconTarget,
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

function CardIcon({ entry }: { entry: RoadmapCandidate }) {
  const Icon = iconMap[entry.group] ?? iconMap[entry.category] ?? IconTarget
  return (
    <div className="catalog-hero-icon">
      <Icon size={22} />
    </div>
  )
}

export default function Goals() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { activeGoal, selectGoal } = useApp()

  // — roadmap.sh catalog state (external metadata) —
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

  // Close the detail modal with Escape.
  useEffect(() => {
    if (!detail) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setDetail(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail])

  // Keep the topbar-search prefill (?q=) in sync with what the user types.
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

  // Curated static goals — still filtered by the shared search box + level.
  const curatedShown = useMemo(() => {
    const byLevel = goalCatalog.filter(
      (g) => level === 'All' || g.difficulty === level,
    )
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
    // Send ONLY metadata (topic + source attribution) to the FocusLearn AI
    // roadmap system. No roadmap.sh content is ever copied — the AI
    // generates a fully original roadmap from the topic name alone.
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
              <IconSparkles size={12} />
              Goal Catalog
            </span>
            <h1>My Goals</h1>
            <p>Choose a proven learning path or create your own adaptive path with AI.</p>
          </div>
          <div className="page-header-actions">
            <button type="button" className="btn btn-primary" onClick={() => navigate('/ai-roadmap')}>
              Create Roadmap with AI
              <IconArrowRight size={15} />
            </button>
          </div>
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
                      <span
                        className="row dash-reco-go"
                        style={{ alignSelf: 'center' }}
                      >
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

      {/* Roadmap detail modal */}
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
    </AppLayout>
  )
}