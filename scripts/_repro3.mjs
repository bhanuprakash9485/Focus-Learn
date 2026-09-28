import { buildCandidates, buildPlan, daysBetween } from '../src/services/studyPlan'
import { getRoadmapForGoal } from '../src/data/roadmaps'

const roadmap = getRoadmapForGoal('web-dev')
const completedLessonIds = ['web-dev-1-1', 'web-dev-1-2', 'web-dev-2-1', 'web-dev-2-2']
const candidates = buildCandidates(roadmap, [])
const focusMinutesByDay = {}
const today = '2026-09-29'

function describe(tasks, label) {
  const missed = tasks.filter(t => t.status === 'missed')
  const planned = tasks.filter(t => t.status === 'planned')
  const byStatus = {}
  for (const t of tasks) {
    const key = `${t.status}:${t.title.slice(0, 18)}`
    byStatus[key] = (byStatus[key] ?? 0) + 1
  }
  console.log(`${label} total=${tasks.length} missed=${missed.length} planned=${planned.length}`)
  console.log('  ', JSON.stringify(byStatus))
  for (const t of tasks.slice(0, 8)) console.log(`    ${t.id.slice(0, 44)} | ${t.date} | ${t.status} | from=${t.rescheduledFrom ?? '-'}`)
}

// Start from a realistic dirty plan: a few missed rows for the SAME lesson on different days.
let prev = [
  { id: 'sp-2026-09-24-lesson-web-dev-4-2', kind: 'lesson', ref: 'web-dev-4-2', title: 'State & useEffect', date: '2026-09-24', estimatedMinutes: 20, actualMinutes: 0, priority: 'medium', status: 'missed', source: 'auto' },
  { id: 'sp-2026-09-25-lesson-web-dev-4-2', kind: 'lesson', ref: 'web-dev-4-2', title: 'State & useEffect', date: '2026-09-25', estimatedMinutes: 20, actualMinutes: 0, priority: 'medium', status: 'missed', source: 'auto' },
  { id: 'sp-2026-09-26-lesson-web-dev-4-2', kind: 'lesson', ref: 'web-dev-4-2', title: 'State & useEffect', date: '2026-09-26', estimatedMinutes: 20, actualMinutes: 0, priority: 'medium', status: 'missed', source: 'auto' },
]
for (let i = 0; i < 8; i++) {
  const next = buildPlan({ candidates, completedLessonIds, attempts: [], focusMinutesByDay, dailyTargetMinutes: 30, today, previousTasks: prev })
  describe(next, `run ${i}`)
  const missedOld = prev.filter(t => t.status === 'missed').length
  const missedNew = next.filter(t => t.status === 'missed').length
  console.log(`   MISSED: ${missedOld} -> ${missedNew}`)
  if (next.length === prev.length) { console.log('STABLE'); break }
  prev = next
}