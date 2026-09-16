/** Shared domain types for FocusLearn. */

export type Difficulty = 'Beginner' | 'Intermediate' | 'Advanced'

/* ------------------------------------------------------------------ */
/* Authentication                                                     */
/* ------------------------------------------------------------------ */

/** The authenticated account as returned by the backend (never the hash). */
export interface AuthUser {
  id: string
  name: string
  email: string
  createdAt?: string
}

/** Boot/guard state of the application regarding authentication. */
export type AuthStage = 'loading' | 'authed' | 'anon'

export interface User {
  id: string
  name: string
  email: string
  /** Selected area of study, e.g. "Web Development". */
  field: string
  /** Self-reported experience level. */
  level: Difficulty
  dailyGoalMinutes: number
  joinedAt: string
  focusStreakDays: number
}

export interface Goal {
  id: string
  title: string
  category: string
  description: string
  difficulty: Difficulty
  estimatedWeeks: number
  icon: string
  skills: string[]
}

export interface RoadmapStep {
  id: string
  title: string
  description: string
  estimatedHours: number
  /** Step is complete when every lesson in it is completed. */
  lessons: Lesson[]
}

export interface Lesson {
  id: string
  title: string
  minutes: number
  /** Markdown-lite content rendered by the focus reader. */
  content: string
}

export interface Roadmap {
  id: string
  goalId: string
  title: string
  description: string
  createdAt: string
  steps: RoadmapStep[]
}

export interface QuizQuestion {
  id: string
  prompt: string
  options: string[]
  correctIndex: number
  explanation: string
  /** Concept this question tests — used by AI performance analysis. */
  concept?: string
}

export interface Quiz {
  id: string
  lessonId: string
  title: string
  questions: QuizQuestion[]
}

export interface QuizAttempt {
  id: string
  lessonId: string
  score: number
  total: number
  percentage: number
  completedAt: string
  /** Indices of questions answered incorrectly, for weak-area analysis. */
  missedQuestionIds: string[]
}

/** UI-facing status of a roadmap step, derived from progress. */
export type StepStatus = 'done' | 'current' | 'locked'

/* ------------------------------------------------------------------ */
/* AI-generated roadmap (adaptive learning)                            */
/* ------------------------------------------------------------------ */

/** Status of a topic on the AI-generated roadmap. */
export type AiTopicStatus =
  | 'completed'
  | 'current'
  | 'recommended'
  | 'needs-practice'
  | 'review-required'
  | 'locked'

export interface AiRoadmapTopic {
  id: string
  name: string
  /** One-line summary shown on the node. */
  description: string
  /** Longer overview shown in the detail view. */
  overview: string
  status: AiTopicStatus
  /** Completion percentage 0-100. */
  progress: number
  difficulty: Difficulty
  /** Human-friendly estimated learning time, e.g. "1 week". */
  estimatedTime: string
  /** Numeric estimate used for roadmap totals, in hours. */
  estimatedHours: number
  prerequisites: string[]
  skillsGained: string[]
  /** Present when adaptive learning flagged this topic for review/practice. */
  reviewNote?: string
  /** Weak concepts identified by AI analysis. */
  weakConcepts?: string[]
  /** Strong concepts identified by AI analysis. */
  strongConcepts?: string[]
  /** Last quiz score percentage for this topic. */
  lastScore?: number
  /** Number of times this topic has been retried. */
  retryCount?: number
  /** Learning objectives from the dynamic roadmap generator. */
  learningObjectives?: string[]
  /** Source phase id when this topic came from a dynamic roadmap. */
  phaseId?: string
}

export interface AiRoadmap {
  id: string
  goal: string
  tagline: string
  topics: AiRoadmapTopic[]
}

/* ------------------------------------------------------------------ */
/* Dynamic AI-generated roadmap (any topic)                            */
/* ------------------------------------------------------------------ */

/** A topic within a dynamically generated roadmap phase. */
export interface AiRoadmapTopicInput {
  id: string
  title: string
  description: string
  learning_objectives: string[]
  estimated_minutes: number
  difficulty: Difficulty
  skills_gained: string[]
}

/** A phase within a dynamically generated roadmap. */
export interface AiRoadmapPhase {
  id: string
  title: string
  description: string
  topics: AiRoadmapTopicInput[]
}

/** The complete AI-generated roadmap for any topic. */
export interface AiGeneratedRoadmap {
  title: string
  topic: string
  overview: string
  prerequisites: string[]
  phases: AiRoadmapPhase[]
  final_goal: string
  total_estimated_minutes: number
}

/** User preferences for roadmap generation. */
export interface AiRoadmapPreferences {
  level: 'beginner' | 'intermediate' | 'advanced'
  study_time: string
  goal: string
}

/* ------------------------------------------------------------------ */
/* Adaptive performance analysis (AI-powered)                          */
/* ------------------------------------------------------------------ */

/** A quiz question with its concept tag for analysis. */
export interface QuizQuestionWithConcept {
  prompt: string
  options: string[]
  correctIndex: number
  concept: string
}

/** Backend analysis of quiz performance. */
export interface PerformanceAnalysis {
  score: number
  status: 'pass' | 'needs_practice' | 'review_required'
  strong_topics: string[]
  weak_topics: string[]
  revision_plan: { topic: string; reason: string; priority: 'high' | 'medium' | 'low' }[]
  practice_recommendation: string
  retest_required: boolean
  recommended_next_topic: string
  message: string
}

/** Backend recommendation for next learning activity. */
export interface NextTopicRecommendation {
  action: 'continue' | 'review' | 'practice'
  next_topic: string
  reason: string
}

/* ------------------------------------------------------------------ */
/* Focus Mode — YouTube-powered topic learning                         */
/* ------------------------------------------------------------------ */

/** A single educational YouTube video returned by the search service. */
export interface YouTubeVideo {
  id: string
  title: string
  channel: string
  thumbnail: string
  /** Human-friendly duration, e.g. "14:32". Absent when unknown. */
  duration?: string
  description: string
  /** Canonical YouTube watch page URL. */
  url?: string
  /** Backend approval marker — set only on SafeSearch-approved results. */
  safeApproved?: boolean
  /**
   * A real YouTube playlist (detected by the backend) this video belongs
   * to. Present only when the backend verified the video appears inside a
   * relevant learning playlist; absent/null otherwise.
   */
  playlist?: PlaylistInfo
}

/** Lightweight reference to one video inside a playlist (navigation only). */
export interface PlaylistVideoRef {
  id: string
  title: string
}

/** A backend-detected playlist attached to a video search result. */
export interface PlaylistInfo {
  id: string
  title: string
  /** Number of entries in the playlist as captured by the backend. */
  videoCount: number
  /** The uploader's YouTube channel id. */
  channelId?: string
  /** FIRST SafeSearch-approved video of the playlist. */
  firstVideo: PlaylistVideoRef | null
  /** SafeSearch-approved playlist entries in order, for navigation. */
  videos: PlaylistVideoRef[]
}

/**
 * Where the search results came from:
 *  - 'youtube' — real results from the Python (yt-dlp) backend
 *  - 'error'   — the backend was unreachable or the search itself failed
 */
export type YouTubeSearchSource = 'youtube' | 'error' | 'blocked'

/* ------------------------------------------------------------------ */
/* Roadmap.sh catalog (external metadata only)                         */
/* ------------------------------------------------------------------ */

/** One roadmap.sh catalog entry — discovery metadata only (never content). */
export interface RoadmapCandidate {
  id: string
  title: string
  /** role-based | skill-based | other */
  category: 'role-based' | 'skill-based' | 'other'
  /** UI filter facet derived from the title/slug (e.g. "web-dev"). */
  group: string
  source: string
  /** Always https://roadmap.sh/<slug> — validated by the backend. */
  sourceUrl: string
  description: string
  /** Facet key used to pick a FocusLearn icon (never roadmap.sh images). */
  icon: string
  /** Derived search aliases (original wording). */
  keywords: string[]
  isNew: boolean
  lastChecked: string
}

/** Catalog sync state as reported by the backend. */
export interface RoadmapSyncState {
  status: 'ok' | 'stale' | 'error'
  lastAttempt: string
  lastSuccess: string | null
  nextRefresh: string | null
  notice?: string
}

/** Response of GET /api/roadmaps/catalog and POST /api/roadmaps/refresh. */
export interface RoadmapCatalogResponse {
  ok: boolean
  error?: string
  source: string
  generatedAt: string | null
  stale: boolean
  sync: RoadmapSyncState
  catalog: RoadmapCandidate[]
}

/* ------------------------------------------------------------------ */
/* Recommended playlist (YouTube Data API v3 — search-based)           */
/* ------------------------------------------------------------------ */

/** A single video inside the recommended playlist. */
export interface RecommendedPlaylistVideo {
  /** Backend compat: same value as `videoId`. */
  id: string
  videoId?: string
  title: string
  position: number
  thumbnail?: string
}

/** Backend-recommended playlist (YouTube Data API, topic search). */
export interface RecommendedPlaylist {
  id: string
  playlistId?: string
  title: string
  description?: string
  channel?: string
  thumbnail?: string
  /** Number of safe/usable videos actually returned by the backend. */
  totalVideos?: number
  videos: RecommendedPlaylistVideo[]
  /** The first safe, available video — where "Start Learning" begins. */
  firstVideo: { id: string; title: string } | null
}