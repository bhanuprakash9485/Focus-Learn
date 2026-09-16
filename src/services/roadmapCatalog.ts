import type { RoadmapCatalogResponse, RoadmapCandidate } from '../types'
import { apiUrl } from '../config/api'

const CATALOG_API = apiUrl('/api/roadmaps/catalog')
const REFRESH_API = apiUrl('/api/roadmaps/refresh')
const FETCH_TIMEOUT_MS = 45000

/** UI filter chips — mirror the backend's category/group facets. */
export const ROADMAP_FILTERS: { id: string; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'role-based', label: 'Role Based' },
  { id: 'skill-based', label: 'Skill Based' },
  { id: 'ai-ml', label: 'AI & Machine Learning' },
  { id: 'web-dev', label: 'Web Development' },
  { id: 'languages', label: 'Languages' },
  { id: 'devops', label: 'DevOps' },
  { id: 'databases', label: 'Databases' },
  { id: 'computer-science', label: 'Computer Science' },
  { id: 'mobile', label: 'Mobile' },
  { id: 'design', label: 'Design' },
  { id: 'security', label: 'Security' },
  { id: 'other', label: 'Other' },
]

export const GROUP_LABELS: Record<string, string> = {
  'ai-ml': 'AI & Machine Learning',
  'web-dev': 'Web Development',
  languages: 'Languages',
  devops: 'DevOps',
  databases: 'Databases',
  'computer-science': 'Computer Science',
  mobile: 'Mobile',
  design: 'Design',
  security: 'Security',
  other: 'Other',
}

export const CATEGORY_LABELS: Record<string, string> = {
  'role-based': 'Role Based',
  'skill-based': 'Skill Based',
  other: 'Other',
}

const ROADMAP_SH_PREFIX = 'https://roadmap.sh/'

/**
 * Keep only entries the backend actually produced from roadmap.sh slugs.
 * External content is untrusted: anything that does not look like a valid
 * roadmap.sh url is dropped before it can ever be rendered.
 */
function sanitizeCatalog(raw: unknown[]): RoadmapCandidate[] {
  const safe: RoadmapCandidate[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    if (typeof e.id !== 'string' || typeof e.title !== 'string') continue
    if (typeof e.sourceUrl !== 'string' || !e.sourceUrl.startsWith(ROADMAP_SH_PREFIX)) continue
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(e.id)) continue
    const entry: RoadmapCandidate = {
      id: e.id,
      title: e.title,
      category: e.category === 'role-based' || e.category === 'skill-based' || e.category === 'other' ? e.category : 'other',
      group: typeof e.group === 'string' ? e.group : 'other',
      source: e.source === 'roadmap.sh' ? 'roadmap.sh' : 'roadmap.sh',
      sourceUrl: e.sourceUrl,
      description: typeof e.description === 'string' ? e.description : '',
      icon: typeof e.icon === 'string' ? e.icon : 'other',
      keywords: Array.isArray(e.keywords) ? (e.keywords as unknown[]).filter((k): k is string => typeof k === 'string') : [],
      isNew: e.isNew === true,
      lastChecked: typeof e.lastChecked === 'string' ? e.lastChecked : '',
    }
    safe.push(entry)
  }
  return safe
}

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function parseResponse(data: unknown): RoadmapCatalogResponse {
  const d = (data ?? {}) as Record<string, unknown>
  return {
    ok: d.ok === true,
    error: typeof d.error === 'string' ? d.error : undefined,
    source: typeof d.source === 'string' ? d.source : 'roadmap.sh',
    generatedAt: typeof d.generatedAt === 'string' ? d.generatedAt : null,
    stale: d.stale === true,
    sync: {
      status:
        d.sync &&
        typeof d.sync === 'object' &&
        ('status' in (d.sync as object))
          ? ((d.sync as { status?: unknown }).status as RoadmapCatalogResponse['sync']['status'])
          : ('ok' as const),
      lastAttempt: (d.sync as { lastAttempt?: string } | null)?.lastAttempt ?? '',
      lastSuccess: (d.sync as { lastSuccess?: string | null } | null)?.lastSuccess ?? null,
      nextRefresh: (d.sync as { nextRefresh?: string | null } | null)?.nextRefresh ?? null,
      notice: (d.sync as { notice?: string } | null)?.notice,
    },
    catalog: Array.isArray(d.catalog) ? sanitizeCatalog(d.catalog as unknown[]) : [],
  }
}

export async function fetchRoadmapCatalog(): Promise<RoadmapCatalogResponse> {
  let res: Response
  try {
    res = await fetchWithTimeout(CATALOG_API, FETCH_TIMEOUT_MS)
  } catch (err) {
    return {
      ok: false,
      error: 'Could not reach the roadmap catalog service.',
      source: 'roadmap.sh',
      generatedAt: null,
      stale: false,
      sync: { status: 'error', lastAttempt: '', lastSuccess: null, nextRefresh: null },
      catalog: [],
    }
  }
  let data: unknown
  try {
    data = await res.json()
  } catch {
    data = null
  }
  const parsed = parseResponse(data)
  // On error status we do not want to render blanks without context.
  if (!parsed.ok && !parsed.error) parsed.error = 'The roadmap catalog is unavailable right now.'
  return parsed
}

export async function refreshRoadmapCatalog(): Promise<RoadmapCatalogResponse> {
  let res: Response
  try {
    res = await fetchWithTimeout(REFRESH_API, FETCH_TIMEOUT_MS, { method: 'POST' })
  } catch (err) {
    return {
      ok: false,
      error: 'Could not reach the roadmap catalog service to refresh.',
      source: 'roadmap.sh',
      generatedAt: null,
      stale: true,
      sync: { status: 'error', lastAttempt: '', lastSuccess: null, nextRefresh: null },
      catalog: [],
    }
  }
  let data: unknown
  try {
    data = await res.json()
  } catch {
    data = null
  }
  return parseResponse(data)
}

/** Case-insensitive, partial-match search over id/title/category/group/keywords. */
export function matchesQuery(entry: RoadmapCandidate, query: string): boolean {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const haystack = [
    entry.title,
    entry.id,
    entry.category,
    entry.group,
    GROUP_LABELS[entry.group] ?? '',
    CATEGORY_LABELS[entry.category] ?? '',
    ...entry.keywords,
  ]
    .join(' ')
    .toLowerCase()
  return tokens.every((t) => haystack.includes(t))
}

/** Apply the active filter id (chip) to the catalog. */
export function filterCatalog(catalog: RoadmapCandidate[], filter: string): RoadmapCandidate[] {
  if (filter === 'all') return catalog
  if (filter === 'role-based' || filter === 'skill-based') {
    return catalog.filter((e) => e.category === filter)
  }
  // 'other' is both a category fallback and a group facet — treat as group.
  return catalog.filter((e) => e.group === filter)
}