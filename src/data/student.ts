import type { QuizAttempt, User } from '../types'

/** The sample student used across the app while there is no backend. */
export const sampleStudent: User = {
  id: 'student-001',
  name: 'Asha Verma',
  email: 'asha.verma@focuslearn.app',
  field: 'Web Development',
  level: 'Beginner',
  dailyGoalMinutes: 30,
  joinedAt: '2026-09-01',
  focusStreakDays: 6,
}

/** Mock quiz attempt history for the Performance page. */
export const mockAttempts: QuizAttempt[] = [
  {
    id: 'att-1',
    lessonId: 'web-dev-1-1',
    score: 2,
    total: 2,
    percentage: 100,
    completedAt: '2026-09-08',
    missedQuestionIds: [],
  },
  {
    id: 'att-2',
    lessonId: 'web-dev-1-2',
    score: 1,
    total: 2,
    percentage: 50,
    completedAt: '2026-09-09',
    missedQuestionIds: ['q2'],
  },
  {
    id: 'att-3',
    lessonId: 'web-dev-2-2',
    score: 2,
    total: 2,
    percentage: 100,
    completedAt: '2026-09-11',
    missedQuestionIds: [],
  },
  {
    id: 'att-4',
    lessonId: 'web-dev-3-2',
    score: 1,
    total: 2,
    percentage: 50,
    completedAt: '2026-09-12',
    missedQuestionIds: ['q1'],
  },
  {
    id: 'att-5',
    lessonId: 'web-dev-4-2',
    score: 1,
    total: 2,
    percentage: 50,
    completedAt: '2026-09-13',
    missedQuestionIds: ['q2'],
  },
]
