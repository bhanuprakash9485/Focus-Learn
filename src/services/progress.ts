import type { Roadmap, RoadmapStep, StepStatus } from '../types'
import type { QuizAttempt } from '../types'
import { quizzes } from '../data/student'

/** Compute the status of a roadmap step from completed lesson ids. */
export function getStepStatus(step: RoadmapStep, completedLessonIds: string[]): StepStatus {
  const total = step.lessons.length
  const done = step.lessons.filter((l) => completedLessonIds.includes(l.id)).length
  if (done === total) return 'done'
  if (done > 0) return 'current'
  return 'locked'
}

/** Overall completion percentage across a roadmap (0-100). */
export function getRoadmapProgress(roadmap: Roadmap, completedLessonIds: string[]): number {
  const all = roadmap.steps.flatMap((s) => s.lessons)
  if (all.length === 0) return 0
  const done = all.filter((l) => completedLessonIds.includes(l.id)).length
  return Math.round((done / all.length) * 100)
}

/** The next uncompleted lesson, or null when the roadmap is finished. */
export function getNextLesson(roadmap: Roadmap, completedLessonIds: string[]) {
  for (const step of roadmap.steps) {
    for (const lesson of step.lessons) {
      if (!completedLessonIds.includes(lesson.id)) {
        return { step, lesson }
      }
    }
  }
  return null
}

/** True when a lesson has a quiz available in the bank. */
export function quizExistsForLesson(lessonId: string): boolean {
  return lessonId in quizzes
}

/** Average score across attempts (0-100), or null with no attempts. */
export function getAverageScore(attempts: QuizAttempt[]): number | null {
  if (attempts.length === 0) return null
  const sum = attempts.reduce((acc, a) => acc + a.percentage, 0)
  return Math.round(sum / attempts.length)
}

/**
 * Weak-area analysis: finds quiz questions the student missed most,
 * mapped back to their lesson titles. This is the seam where the AI
 * "identify weak areas" feature will plug in later.
 */
export function getWeakAreas(attempts: QuizAttempt[]) {
  const missCount = new Map<string, number>()
  attempts.forEach((a) => a.missedQuestionIds.forEach((qid) => {
    missCount.set(qid, (missCount.get(qid) ?? 0) + 1)
  }))

  const topics: { topic: string; lessonId: string; missed: number }[] = []
  for (const quiz of Object.values(quizzes)) {
    for (const q of quiz.questions) {
      const missed = missCount.get(q.id)
      if (missed) {
        topics.push({ topic: quiz.title.replace(' — Check', ''), lessonId: quiz.lessonId, missed })
      }
    }
  }
  return topics.sort((a, b) => b.missed - a.missed).slice(0, 4)
}

/**
 * Recommendations for what to learn next. Deterministic for now;
 * the AI version will personalize this with reasoning.
 */
export function getRecommendations(
  weakAreas: { topic: string; lessonId: string }[],
  nextLesson: { step: RoadmapStep; lesson: { id: string; title: string } } | null,
): { title: string; reason: string; cta: 'review' | 'continue' }[] {
  const recs: { title: string; reason: string; cta: 'review' | 'continue' }[] = []

  weakAreas.slice(0, 2).forEach((w) => {
    recs.push({
      title: `Review: ${w.topic}`,
      reason: `You missed questions here recently — a quick review will strengthen this weak area.`,
      cta: 'review',
    })
  })

  if (nextLesson) {
    recs.push({
      title: nextLesson.lesson.title,
      reason: `Next step in "${nextLesson.step.title}" — keeps your streak going.`,
      cta: 'continue',
    })
  }

  return recs.slice(0, 3)
}
