/**
 * Mock data for the professional student dashboard.
 * Everything here is static demo content — no external AI or backend calls.
 */

export interface CurrentLearning {
  subject: string
  currentTopic: string
  progress: number
  lessonMinutes: number
}

export interface Recommendation {
  label: string
  topic: string
  reason: string
  cta: string
  to: string
}

export interface StatCard {
  id: 'overall' | 'quiz' | 'streak' | 'topics'
  label: string
  value: string
  hint: string
}

export interface TodayPlanItem {
  id: string
  title: string
  minutes: number
  kind: 'lesson' | 'quiz' | 'review'
  to: string
}

export interface WeekPlanDay {
  day: string
  topic: string
  minutes: number
  status: 'done' | 'today' | 'upcoming'
}

export interface KnowledgeMapData {
  mastered: string[]
  inProgress: { topic: string; progress: number }[]
  recommended: string
  upcoming: string[]
}

export const greeting = 'Good evening'
export const studentName = 'Student'
export const welcomeMessage = "Let's continue your learning journey."
export const focusStreakDays = 6

export const currentLearning: CurrentLearning = {
  subject: 'Data Structures',
  currentTopic: 'Arrays',
  progress: 65,
  lessonMinutes: 25,
}

export const recommendation: Recommendation = {
  label: 'Recommended Next Topic',
  topic: 'Binary Search',
  reason:
    'Your performance in searching concepts is improving. Binary Search is the next recommended concept in your roadmap.',
  cta: 'Start Topic',
  to: '/focus',
}

export const statCards: StatCard[] = [
  { id: 'overall', label: 'Overall Progress', value: '65%', hint: 'Data Structures roadmap' },
  { id: 'quiz', label: 'Quiz Average', value: '82%', hint: 'Last 5 quizzes' },
  { id: 'streak', label: 'Learning Streak', value: '6 days', hint: 'Keep it alive today' },
  { id: 'topics', label: 'Topics Completed', value: '12', hint: '+2 this week' },
]

export const strongAreas: string[] = ['Arrays', 'Strings', 'Basic Searching']

export const improveAreas: string[] = ['Recursion', 'Binary Search', 'Time Complexity']

export const todayPlan: TodayPlanItem[] = [
  { id: 'plan-1', title: 'Arrays revision', minutes: 20, kind: 'review', to: '/focus' },
  { id: 'plan-2', title: 'Binary Search', minutes: 30, kind: 'lesson', to: '/focus' },
  { id: 'plan-3', title: 'Practice Quiz', minutes: 10, kind: 'quiz', to: '/quiz' },
]

export const roadmapTopics: string[] = [
  'Programming Basics',
  'Arrays',
  'Strings',
  'Linked Lists',
  'Stacks',
  'Recursion',
  'Searching',
  'Sorting',
  'Trees',
  'Graphs',
]

export const currentTopic = 'Arrays'

export const weekPlan: WeekPlanDay[] = [
  { day: 'Mon', topic: 'Arrays revision', minutes: 20, status: 'done' },
  { day: 'Tue', topic: 'Basic Searching', minutes: 15, status: 'done' },
  { day: 'Wed', topic: 'Binary Search', minutes: 30, status: 'today' },
  { day: 'Thu', topic: 'Linked Lists intro', minutes: 25, status: 'upcoming' },
  { day: 'Fri', topic: 'Strings practice', minutes: 20, status: 'upcoming' },
  { day: 'Sat', topic: 'Practice Quiz', minutes: 10, status: 'upcoming' },
  { day: 'Sun', topic: 'Weekly review', minutes: 15, status: 'upcoming' },
]

export const knowledgeMap: KnowledgeMapData = {
  mastered: ['Programming Basics', 'Basic Searching', 'Strings'],
  inProgress: [{ topic: 'Arrays', progress: 65 }],
  recommended: 'Binary Search',
  upcoming: ['Linked Lists', 'Stacks', 'Recursion', 'Sorting', 'Trees', 'Graphs'],
}
