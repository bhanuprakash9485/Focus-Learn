import type { Roadmap, RoadmapStep, StepStatus } from '../types'
import type { QuizAttempt } from '../types'

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

/**
 * True when a lesson has a quiz. Every roadmap lesson now maps to an
 * on-demand 30-question topic quiz (10 basic / 10 moderate / 10 advanced),
 * generated in the background by the backend. Nothing is pre-seeded.
 */
export function quizExistsForLesson(_lessonId: string): boolean {
  return true
}

/** Average score across attempts (0-100), or null with no attempts. */
export function getAverageScore(attempts: QuizAttempt[]): number | null {
  if (attempts.length === 0) return null
  const sum = attempts.reduce((acc, a) => acc + a.percentage, 0)
  return Math.round(sum / attempts.length)
}

/** Reader-friendly label for a quiz attempt's lesson id. */
function friendlyLessonTitle(lessonId: string): string {
  const name = lessonId.startsWith('topic-') ? lessonId.slice('topic-'.length) : lessonId
  const words = name
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  if (words.length === 0) return 'Topic quiz'
  return words.map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w.toUpperCase())).join(' ')
}

/**
 * Weak-area analysis: groups real quiz attempts by lesson and counts the
 * questions each student missed. Works for both server-driven topic quizzes
 * (they carry a topicName + server question ids) and legacy lesson attempts.
 */
export function getWeakAreas(attempts: QuizAttempt[]) {
  const topics: { topic: string; lessonId: string; missed: number }[] = []
  for (const attempt of attempts) {
    const missed = attempt.missedQuestionIds?.length ?? 0
    if (missed === 0) continue
    const title = attempt.topicName ?? friendlyLessonTitle(attempt.lessonId)
    const existing = topics.find(
      (t) => t.lessonId === attempt.lessonId || t.topic.toLowerCase() === title.toLowerCase(),
    )
    if (existing) {
      existing.missed += missed
    } else {
      topics.push({ topic: title, lessonId: attempt.lessonId, missed })
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
