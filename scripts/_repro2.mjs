import { buildCandidates, buildPlan, addDays, todayKey } from '../src/services/studyPlan'
import { getRoadmapForGoal } from '../src/data/roadmaps'

const roadmap = getRoadmapForGoal('web-dev')
const completedLessonIds = ['web-dev-1-1', 'web-dev-1-2', 'web-dev-2-1', 'web-dev-2-2']
const candidates = buildCandidates(roadmap, [])
const focusMinutesByDay = {}

let today = addDays(todayKey(), -12)
let tasks = []
for (let i = 0; i < 8; i++) {
  tasks = buildPlan({ candidates, completedLessonIds, attempts: [], focusMinutesByDay, dailyTargetMinutes: 30, today, previousTasks: tasks })
  today = addDays(today, 1)
  console.log('build day', i, tasks.length)
}

console.log('now same-day rerun ...')
let cur = tasks
for (let i = 0; i < 6; i++) {
  const next = buildPlan({ candidates, completedLessonIds, attempts: [], focusMinutesByDay, dailyTargetMinutes: 30, today: todayKey(), previousTasks: cur })
  console.log('rerun', i, next.length, 'equal?', JSON.stringify(next) === JSON.stringify(cur))
  cur = next
}
console.log('done', cur.length)