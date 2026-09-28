/**
 * Reproduction harness for the "Missed Sessions" runaway.
 * Mirrors exactly what src/pages/StudyPlan.tsx does:
 *   planKey -> buildPlan(previousTasks: studyPlan.tasks) -> patchStudyPlan({tasks})
 * and prints task counts / duplicate ids on every iteration.
 */
import { buildCandidates, buildPlan, reconcileWithActivity, addDays, daysBetween } from '../src/services/studyPlan'
import { getRoadmapForGoal } from '../src/data/roadmaps'

const roadmap = getRoadmapForGoal('web-dev')
// Sample student: 4 lessons already completed + 30 min/day.
const completedLessonIds = ['web-dev-1-1', 'web-dev-1-2', 'web-dev-2-1', 'web-dev-2-2']
const attempts = []
const weakTopics = []
const candidates = buildCandidates(roadmap, weakTopics)
const focusMinutesByDay = {}

let today = '2026-09-28' // Monday
const dailyTargetMinutes = 30
let tasks = []

function iteration(tasks, label) {
  const next = buildPlan({
    candidates,
    completedLessonIds,
    attempts,
    focusMinutesByDay,
    dailyTargetMinutes,
    today,
    previousTasks: tasks,
  })
  const reconciled = reconcileWithActivity(next, {
    completedLessonIds,
    attempts,
    focusMinutesByDay,
    today,
  })
  const missed = reconciled.filter((t) => t.status === 'missed').length
  const ids = new Set(next.map((t) => t.id))
  const dupIds = next.length - ids.size
  console.log(
    `${label}: tasks=${next.length} reconciled=${reconciled.length} missed=${missed} dupIds=${dupIds}`,
  )
  return next
}

let i
for (i = 0; i < 40; i++) {
  const before = tasks.length
  tasks = iteration(tasks, `iter ${i}`)
  if (tasks.length === before) {
    console.log(`stable at iter ${i}`)
    break
  }
}

// Now try "replan week" every day for 10 days (like opening the app each day).
console.log('\n--- daily replan simulation (a new day, missed rows accumulate) ---')
tasks = []
for (i = 0; i < 14; i++) {
  today = addDays('2026-09-28', i)
  tasks = iteration(tasks, `day ${i} (${today})`)
}