/**
 * Deterministic tests for the Study Plan rules engine (no AI, no network).
 *
 * These assert the behaviours the user actually cares about:
 *   - a day never exceeds the daily target
 *   - real quiz weakness changes the plan
 *   - a topic is never scheduled before its prerequisites
 *   - missed work is rescheduled, never silently dropped
 *   - only REAL activity marks a task done
 *   - planned minutes can never be inflated by missed rows
 */

import assert from 'node:assert/strict'
import {
  buildCandidates,
  buildPlan,
  buildWeek,
  computeStats,
  daysBetween,
  reduceStudyPlan,
  reconcileWithActivity,
  todayKey,
  todaysFocus,
  upcomingTasks,
  weakTopicTitles,
  DAILY_TARGET_OPTIONS,
} from '../services/studyPlan'
import type { QuizAttempt, Roadmap, StudyPlanState, StudyTask } from '../types'

let passed = 0
const failures: string[] = []

function check(name: string, fn: () => void) {
  try {
    fn()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message}`)
    console.log(`  FAIL  ${name}\n        ${(err as Error).message}`)
  }
}

/* ---------- Fixtures: a small but real 3-step roadmap ---------- */

const roadmap: Roadmap = {
  id: 'test-roadmap',
  title: 'Test Roadmap',
  description: 'fixture',
  steps: [
    {
      id: 'step-1',
      title: 'Basics',
      description: '',
      estimatedHours: 1,
      lessons: [
        { id: 'l1', title: 'Alpha Basics', description: '', minutes: 12, duration: '12 min', level: 'Beginner', completed: false, order: 1 },
        { id: 'l2', title: 'Beta Basics', description: '', minutes: 10, duration: '10 min', level: 'Beginner', completed: false, order: 2 },
      ],
    },
    {
      id: 'step-2',
      title: 'Intermediate',
      description: '',
      estimatedHours: 1,
      lessons: [
        { id: 'l3', title: 'Gamma Core', description: '', minutes: 15, duration: '15 min', level: 'Beginner', completed: false, order: 1 },
      ],
    },
    {
      id: 'step-3',
      title: 'Advanced',
      description: '',
      estimatedHours: 1,
      lessons: [
        { id: 'l4', title: 'Delta Expert', description: '', minutes: 20, duration: '20 min', level: 'Intermediate', completed: false, order: 1 },
      ],
    },
  ],
} as unknown as Roadmap

const MONDAY = '2026-09-28' // a real Monday

function attempt(partial: Partial<QuizAttempt>): QuizAttempt {
  return {
    id: 'att',
    topicName: 'Alpha Basics',
    lessonId: 'l1',
    score: 4,
    total: 5,
    percentage: 80,
    completedAt: `${MONDAY}T10:00:00.000Z`,
    missedQuestionIds: [],
    ...partial,
  } as QuizAttempt
}

console.log('\n=== Study Plan rules engine ===\n')

/* ---------- 1. Daily target is respected ---------- */

check('a day never exceeds the daily target', () => {
  const tasks = buildPlan({
    candidates: buildCandidates(roadmap, []),
    completedLessonIds: [],
    attempts: [],
    focusMinutesByDay: {},
    dailyTargetMinutes: 25,
    today: MONDAY,
  })
  const perDay = new Map<string, number>()
  for (const t of tasks) {
    perDay.set(t.date, (perDay.get(t.date) ?? 0) + t.estimatedMinutes)
  }
  for (const [date, minutes] of perDay) {
    assert.ok(minutes <= 25, `${date} planned ${minutes} min, target is 25`)
  }
})

check('every offered target produces a valid plan', () => {
  for (const target of DAILY_TARGET_OPTIONS) {
    const tasks = buildPlan({
      candidates: buildCandidates(roadmap, []),
      completedLessonIds: [],
      attempts: [],
      focusMinutesByDay: {},
      dailyTargetMinutes: target,
      today: MONDAY,
    })
    const perDay = new Map<string, number>()
    for (const t of tasks) perDay.set(t.date, (perDay.get(t.date) ?? 0) + t.estimatedMinutes)
    for (const minutes of perDay.values()) {
      assert.ok(minutes <= target, `target ${target} exceeded: ${minutes}`)
    }
  }
})

/* ---------- 2. No work is scheduled on a past day ---------- */

check('nothing is scheduled before today', () => {
  const tasks = buildPlan({
    candidates: buildCandidates(roadmap, []),
    completedLessonIds: [],
    attempts: [],
    focusMinutesByDay: {},
    dailyTargetMinutes: 60,
    today: MONDAY,
  })
  for (const t of tasks) {
    assert.ok(daysBetween(MONDAY, t.date) >= 0, `${t.title} landed on past day ${t.date}`)
  }
})

/* ---------- 3. Dependency order ---------- */

check('a topic is never placed before its prerequisites', () => {
  // Big target so as much work as possible gets placed this week.
  const tasks = buildPlan({
    candidates: buildCandidates(roadmap, []),
    completedLessonIds: [],
    attempts: [],
    focusMinutesByDay: {},
    dailyTargetMinutes: 60,
    today: MONDAY,
  })
  const dayOf = new Map<string, string>()
  for (const t of tasks) {
    const existing = dayOf.get(t.ref)
    // A ref may appear twice (missed row + rescheduled copy); the live copy wins.
    if (!existing || t.status !== 'missed') dayOf.set(t.ref, t.date)
  }
  const candidates = buildCandidates(roadmap, [])
  for (const c of candidates) {
    const day = dayOf.get(c.ref)
    for (const prereq of c.prerequisites) {
      const prereqDay = dayOf.get(prereq)
      if (!day || !prereqDay) continue
      assert.ok(
        prereqDay <= day,
        `${c.ref} (${day}) scheduled before prerequisite ${prereq} (${prereqDay})`,
      )
    }
  }
})

check('a quiz is never scheduled before its own lesson', () => {
  const tasks = buildPlan({
    candidates: buildCandidates(roadmap, []),
    completedLessonIds: [],
    attempts: [],
    focusMinutesByDay: {},
    dailyTargetMinutes: 60,
    today: MONDAY,
  })
  const dayOfLesson = new Map<string, string>()
  for (const t of tasks) {
    if (t.kind === 'lesson' && t.status !== 'missed') dayOfLesson.set(t.ref, t.date)
  }
  for (const t of tasks) {
    if (t.kind !== 'quiz') continue
    const lessonRef = t.ref.replace(/^quiz:/, '')
    const lessonDay = dayOfLesson.get(lessonRef)
    if (lessonDay) {
      assert.ok(lessonDay <= t.date, `quiz ${t.ref} on ${t.date} before lesson on ${lessonDay}`)
    }
  }
})

/* ---------- 4. Real quiz weakness changes the plan ---------- */

check('real weak quiz scores create review tasks', () => {
  const weak = weakTopicTitles([attempt({ percentage: 40, missedQuestionIds: ['q1', 'q2', 'q3'] })], 3)
  assert.ok(weak.includes('Alpha Basics'), 'weak topic not detected')

  const tasks = buildPlan({
    candidates: buildCandidates(roadmap, weak),
    completedLessonIds: [],
    attempts: [attempt({ percentage: 40, missedQuestionIds: ['q1', 'q2', 'q3'] })],
    focusMinutesByDay: {},
    dailyTargetMinutes: 60,
    today: MONDAY,
  })
  assert.ok(
    tasks.some((t) => t.kind === 'review' && t.title.includes('Alpha Basics')),
    'no review task for the weak topic',
  )
})

check('a strong quiz score creates no review task', () => {
  const strong = attempt({ percentage: 95, missedQuestionIds: [] })
  const weak = weakTopicTitles([strong], 3)
  const tasks = buildPlan({
    candidates: buildCandidates(roadmap, weak),
    completedLessonIds: [],
    attempts: [strong],
    focusMinutesByDay: {},
    dailyTargetMinutes: 60,
    today: MONDAY,
  })
  assert.ok(!tasks.some((t) => t.kind === 'review'), 'review created for a strong score')
})

check('a review is prioritised above a low-priority roadmap lesson', () => {
  const weak = ['Alpha Basics']
  const tasks = buildPlan({
    candidates: buildCandidates(roadmap, weak),
    completedLessonIds: [],
    attempts: [attempt({ percentage: 35, missedQuestionIds: ['q1', 'q2'] })],
    focusMinutesByDay: {},
    dailyTargetMinutes: 30,
    today: MONDAY,
  })
  const first = tasks.filter((t) => t.status === 'planned')[0]
  assert.equal(first?.kind, 'review', `expected the review first, got ${first?.kind}`)
  assert.equal(first?.priority, 'high')
})

/* ---------- 5. Missed work is rescheduled, not dropped ---------- */

check('a missed past task is rescheduled and keeps its reason', () => {
  const previous: StudyTask[] = [
    {
      id: 'sp-old',
      kind: 'lesson',
      ref: 'l1',
      title: 'Alpha Basics',
      date: '2026-09-21', // last Monday, in the past
      estimatedMinutes: 12,
      actualMinutes: 0,
      priority: 'high',
      status: 'missed',
      source: 'auto',
    },
  ]
  const tasks = buildPlan({
    candidates: buildCandidates(roadmap, []),
    completedLessonIds: [],
    attempts: [],
    focusMinutesByDay: {},
    dailyTargetMinutes: 60,
    today: MONDAY,
    previousTasks: previous,
  })
  const kept = tasks.find((t) => t.status === 'missed' && t.ref === 'l1')
  assert.ok(kept, 'the missed row disappeared')
  const carried = tasks.find((t) => t.ref === 'l1' && t.status === 'planned')
  assert.ok(carried, 'the missed task was not rescheduled')
  assert.equal(carried!.rescheduledFrom, '2026-09-21')
  assert.ok(daysBetween(MONDAY, carried!.date) >= 0, 'rescheduled into the past')
})

/* The runaway bug: rebuilding the plan over and over kept duplicating the same
   missed session (1008+ rows). The rebuild must reach a fixed point: the next
   plan is byte-for-byte identical, so the storage-write guard stops the loop. */

check('re-running the planner with the previous result reaches a fixed point', () => {
  const base = {
    candidates: buildCandidates(roadmap, []),
    completedLessonIds: [],
    attempts: [],
    focusMinutesByDay: {},
    dailyTargetMinutes: 60,
    today: MONDAY,
  }
  let prev = buildPlan({
    ...base,
    previousTasks: [
      {
        id: 'sp-2026-09-21-lesson-l1',
        kind: 'lesson',
        ref: 'l1',
        title: 'Alpha Basics',
        date: '2026-09-21',
        estimatedMinutes: 12,
        actualMinutes: 0,
        priority: 'high',
        status: 'missed',
        source: 'auto',
      },
      {
        id: 'sp-2026-09-22-lesson-l1',
        kind: 'lesson',
        ref: 'l1',
        title: 'Alpha Basics',
        date: '2026-09-22',
        estimatedMinutes: 12,
        actualMinutes: 0,
        priority: 'high',
        status: 'missed',
        source: 'auto',
      },
    ],
  })
  for (let i = 0; i < 10; i += 1) {
    const next = buildPlan({ ...base, previousTasks: prev })
    assert.equal(JSON.stringify(next), JSON.stringify(prev), `plan changed on rerun ${i}`)
  }
})

check('a missed session is carried exactly once, never duplicated', () => {
  const base = {
    candidates: buildCandidates(roadmap, []),
    completedLessonIds: [],
    attempts: [],
    focusMinutesByDay: {},
    dailyTargetMinutes: 60,
    today: MONDAY,
  }
  const previous: StudyTask[] = [
    {
      id: 'sp-2026-09-21-lesson-l1',
      kind: 'lesson',
      ref: 'l1',
      title: 'Alpha Basics',
      date: '2026-09-21',
      estimatedMinutes: 12,
      actualMinutes: 0,
      priority: 'high',
      status: 'missed',
      source: 'auto',
    },
  ]
  const first = buildPlan({ ...base, previousTasks: previous })
  const planned = first.filter((t) => t.ref === 'l1' && t.status === 'planned')
  assert.equal(planned.length, 1, 'expected exactly one carried copy')
  // The carried copy is reused on the next rebuild, not created anew.
  const second = buildPlan({ ...base, previousTasks: first })
  const planned2 = second.filter((t) => t.ref === 'l1' && t.status === 'planned')
  assert.equal(planned2.length, 1, 'rerun created a second carried copy')
  assert.equal(planned2[0].id, planned[0].id, 'carried copy got a new unstable id')
})

check('two missed copies of one session collapse to a single row', () => {
  const tasks = buildPlan({
    candidates: buildCandidates(roadmap, []),
    completedLessonIds: [],
    attempts: [],
    focusMinutesByDay: {},
    dailyTargetMinutes: 60,
    today: MONDAY,
    previousTasks: [
      {
        id: 'sp-2026-09-21-lesson-l1',
        kind: 'lesson',
        ref: 'l1',
        title: 'Alpha Basics',
        date: '2026-09-21',
        estimatedMinutes: 12,
        actualMinutes: 0,
        priority: 'high',
        status: 'missed',
        source: 'auto',
        rescheduledFrom: '2026-09-21',
      },
    ],
  })
  // The corrupted row carves out its own id space (carriedTaskId suffix), it is
  // never merged into — or duplicated against — the real carried copy.
  const ids = tasks.filter((t) => t.ref === 'l1' && t.status === 'planned').map((t) => t.id)
  assert.equal(ids.length, 1, 'a missed copy spawned a rival carried row')
})

check('duplicate ids in stored data are collapsed, never double counted', () => {
  const dup: StudyTask = {
    id: 'sp-2026-09-21-lesson-l1',
    kind: 'lesson',
    ref: 'l1',
    title: 'Alpha Basics',
    date: '2026-09-21',
    estimatedMinutes: 12,
    actualMinutes: 0,
    priority: 'high',
    status: 'missed',
    source: 'auto',
  }
  const tasks = buildPlan({
    candidates: buildCandidates(roadmap, []),
    completedLessonIds: [],
    attempts: [],
    focusMinutesByDay: {},
    dailyTargetMinutes: 60,
    today: MONDAY,
    previousTasks: [dup, { ...dup }],
  })
  const ids = tasks.map((t) => t.id)
  assert.equal(new Set(ids).size, ids.length, 'output contains duplicate ids')
  assert.equal(tasks.filter((t) => t.ref === 'l1').length, 2, 'expected one missed + one carried')
})

check('nothing is ever rescheduled onto an already-past day', () => {
  // Today is Wednesday; the carried work must land Wednesday or later, never
  // on Monday/Tuesday of the same week.
  const WED = '2026-09-30'
  const tasks = buildPlan({
    candidates: buildCandidates(roadmap, []),
    completedLessonIds: [],
    attempts: [],
    focusMinutesByDay: {},
    dailyTargetMinutes: 60,
    today: WED,
    previousTasks: [
      {
        id: 'sp-2026-09-28-lesson-l4',
        kind: 'lesson',
        ref: 'l4',
        title: 'Delta Expert',
        date: '2026-09-28',
        estimatedMinutes: 20,
        actualMinutes: 0,
        priority: 'medium',
        status: 'missed',
        source: 'auto',
      },
    ],
  })
  for (const t of tasks.filter((x) => x.status === 'planned')) {
    assert.ok(daysBetween(WED, t.date) >= 0, `${t.id} landed on ${t.date}, before today`)
  }
})

/* ---------- 6. Only real activity marks a task done ---------- */

const planned = (ref: string, kind: StudyTask['kind'], date: string, minutes = 10): StudyTask => ({
  id: `sp-${ref}-${date}`,
  kind,
  ref,
  title: ref,
  date,
  estimatedMinutes: minutes,
  actualMinutes: 0,
  priority: 'medium',
  status: 'planned',
  source: 'auto',
})

check('a planned lesson is NOT done until the lesson is really completed', () => {
  const out = reconcileWithActivity([planned('l1', 'lesson', MONDAY)], {
    completedLessonIds: [],
    attempts: [],
    focusMinutesByDay: {},
    today: MONDAY,
  })
  assert.equal(out[0].status, 'planned')
  assert.equal(out[0].actualMinutes, 0)
})

check('a lesson is done once completedLessonIds contains it', () => {
  const out = reconcileWithActivity([planned('l1', 'lesson', MONDAY, 12)], {
    completedLessonIds: ['l1'],
    attempts: [],
    focusMinutesByDay: { [MONDAY]: 12 },
    today: MONDAY,
  })
  assert.equal(out[0].status, 'done')
  assert.equal(out[0].actualMinutes, 12, 'real logged minutes not credited')
})

check('a lesson is not marked done by focus minutes alone', () => {
  const out = reconcileWithActivity([planned('l1', 'lesson', MONDAY, 12)], {
    completedLessonIds: [],
    attempts: [],
    focusMinutesByDay: { [MONDAY]: 30 },
    today: MONDAY,
  })
  assert.equal(out[0].status, 'planned', 'focus minutes faked a lesson completion')
})

check('a quiz is done only with a real submitted attempt', () => {
  const tasks = [planned('quiz:l1', 'quiz', MONDAY, 10)]
  const before = reconcileWithActivity(tasks, {
    completedLessonIds: ['l1'],
    attempts: [],
    focusMinutesByDay: { [MONDAY]: 10 },
    today: MONDAY,
  })
  assert.equal(before[0].status, 'planned')

  const after = reconcileWithActivity(tasks, {
    completedLessonIds: ['l1'],
    attempts: [attempt({ topicName: 'l1', lessonId: 'l1' })],
    focusMinutesByDay: { [MONDAY]: 10 },
    today: MONDAY,
  })
  assert.equal(after[0].status, 'done')
})

check('real minutes are never double counted across a day', () => {
  const out = reconcileWithActivity(
    [planned('a', 'lesson', MONDAY, 10), planned('b', 'lesson', MONDAY, 10)],
    {
      completedLessonIds: ['a', 'b'],
      attempts: [],
      focusMinutesByDay: { [MONDAY]: 12 },
      today: MONDAY,
    },
  )
  const total = out.reduce((sum, t) => sum + t.actualMinutes, 0)
  assert.equal(total, 12, `credited ${total} min but only 12 were logged`)
})

check('an unfinished past task becomes missed', () => {
  const out = reconcileWithActivity([planned('l1', 'lesson', '2026-09-21')], {
    completedLessonIds: [],
    attempts: [],
    focusMinutesByDay: {},
    today: MONDAY,
  })
  assert.equal(out[0].status, 'missed')
})

/* ---------- 7. Statistics never overstate progress ---------- */

check('missed rows never inflate the plan', () => {
  const out = reconcileWithActivity(
    [planned('a', 'lesson', MONDAY, 10), planned('b', 'lesson', '2026-09-21', 60)],
    { completedLessonIds: [], attempts: [], focusMinutesByDay: {}, today: MONDAY },
  )
  const week = buildWeek(out, MONDAY)
  const stats = computeStats(week)
  assert.equal(stats.plannedMinutes, 10, 'a missed 60-min row was counted as planned')
  assert.ok(stats.completionPercent <= 100)
  assert.ok(stats.actualMinutes <= stats.plannedMinutes)
})

check('completion percentage reflects real logged minutes', () => {
  const out = reconcileWithActivity([planned('a', 'lesson', MONDAY, 20)], {
    completedLessonIds: ['a'],
    attempts: [],
    focusMinutesByDay: { [MONDAY]: 10 },
    today: MONDAY,
  })
  const stats = computeStats(buildWeek(out, MONDAY))
  assert.equal(stats.plannedMinutes, 20)
  assert.equal(stats.actualMinutes, 10)
  assert.equal(stats.completionPercent, 50)
})

/* ---------- 8. Focus + upcoming selection ---------- */

check("today's focus is the first unfinished task of today", () => {
  const tasks = buildPlan({
    candidates: buildCandidates(roadmap, []),
    completedLessonIds: [],
    attempts: [],
    focusMinutesByDay: {},
    dailyTargetMinutes: 30,
    today: MONDAY,
  })
  const focus = todaysFocus(buildWeek(tasks, MONDAY))
  assert.ok(focus, 'no focus task found')
  assert.equal(focus!.date, MONDAY)
  assert.equal(focus!.status, 'planned')
})

check('upcoming tasks are all in the future and unfinished', () => {
  const tasks = buildPlan({
    candidates: buildCandidates(roadmap, []),
    completedLessonIds: [],
    attempts: [],
    focusMinutesByDay: {},
    dailyTargetMinutes: 30,
    today: MONDAY,
  })
  for (const t of upcomingTasks(buildWeek(tasks, MONDAY), 10)) {
    assert.ok(daysBetween(MONDAY, t.date) >= 0, `${t.title} is in the past`)
    assert.equal(t.status, 'planned')
  }
})

/* ---------- 9. Empty / edge cases ---------- */

check('no roadmap produces no candidates and no crash', () => {
  assert.equal(buildCandidates(null, []).length, 0)
  assert.equal(
    buildPlan({
      candidates: buildCandidates(null, []),
      completedLessonIds: [],
      attempts: [],
      focusMinutesByDay: {},
      dailyTargetMinutes: 30,
      today: MONDAY,
    }).length,
    0,
  )
})

check('a fully completed roadmap produces nothing to schedule', () => {
  const all = roadmap.steps.flatMap((s) => s.lessons).map((l) => l.id)
  const tasks = buildPlan({
    candidates: buildCandidates(roadmap, []),
    completedLessonIds: all,
    attempts: [],
    focusMinutesByDay: {},
    dailyTargetMinutes: 60,
    today: MONDAY,
  })
  const lessons = tasks.filter((t) => t.kind === 'lesson')
  assert.equal(lessons.length, 0, 'finished lessons were rescheduled')
})

check('an absurd daily target cannot produce a negative or zero block', () => {
  const tasks = buildPlan({
    candidates: buildCandidates(roadmap, []),
    completedLessonIds: [],
    attempts: [],
    focusMinutesByDay: {},
    dailyTargetMinutes: 1,
    today: MONDAY,
  })
  for (const t of tasks) {
    assert.ok(t.estimatedMinutes >= 5, `task scheduled with ${t.estimatedMinutes} min`)
  }
})

check('date helpers behave across a week boundary', () => {
  assert.equal(daysBetween('2026-09-28', '2026-10-05'), 7)
  assert.equal(daysBetween('2026-10-05', '2026-09-28'), -7)
  assert.equal(daysBetween('2026-09-28', '2026-09-28'), 0)
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(todayKey()))
})

/* ================================================================== */
/* Daily target selector (reducer)                                     */
/* ================================================================== */

function basePlan(target: number): StudyPlanState {
  return {
    dailyTargetMinutes: target,
    tasks: [],
    updatedAt: null,
    pendingPreview: null,
  }
}

function fakeTask(date: string): StudyTask {
  return {
    id: 'sp-task',
    kind: 'lesson',
    ref: 'l1',
    title: 'Alpha Basics',
    date,
    estimatedMinutes: 15,
    actualMinutes: 0,
    priority: 'medium',
    status: 'planned',
    source: 'auto',
  }
}

check('the reducer accepts only one of the five real targets', () => {
  assert.deepEqual(
    DAILY_TARGET_OPTIONS.map((o) => o),
    [15, 25, 30, 45, 60],
  )
  for (const option of DAILY_TARGET_OPTIONS) {
    assert.equal(
      reduceStudyPlan(basePlan(25), { type: 'set-daily-target', minutes: option }).dailyTargetMinutes,
      option,
      `target ${option} not accepted`,
    )
  }
})

check('an invalid target falls back to the safe middle option', () => {
  const plan = reduceStudyPlan(basePlan(25), { type: 'set-daily-target', minutes: 999 })
  assert.equal(plan.dailyTargetMinutes, 30)
})

/**
 * THE regression test for this bug report: clicking a chip runs BOTH
 * `setDailyTargetMinutes(45)` and (via Replan) a full-task replacement in the
 * SAME React batch. React applies these as consecutive functional updates, each
 * starting from the previous result. The target must survive the second update.
 */
check('daily target survives a same-batch re-plan (the selector bug)', () => {
  let plan = basePlan(25)

  // update 1: the click — target changes to 45.
  plan = reduceStudyPlan(plan, { type: 'set-daily-target', minutes: 45 })
  assert.equal(plan.dailyTargetMinutes, 45)

  // update 2: Replan My Week in the same batch merges new tasks onto the plan
  // that update 1 produced — NOT onto the old closure that had 25.
  plan = reduceStudyPlan(plan, {
    type: 'merge',
    patch: { tasks: [fakeTask(MONDAY)], updatedAt: '2026-09-28T12:00:00.000Z' },
  })

  assert.equal(plan.dailyTargetMinutes, 45, 'target regressed to 25 after the re-plan')
  assert.equal(plan.tasks.length, 1, 'the new tasks were not applied')
  assert.equal(plan.tasks[0].date, MONDAY)
})

check('each of the five options survives a same-batch merge (no stuck selection)', () => {
  for (const option of DAILY_TARGET_OPTIONS) {
    let plan = basePlan(25)
    plan = reduceStudyPlan(plan, { type: 'set-daily-target', minutes: option })
    plan = reduceStudyPlan(plan, { type: 'merge', patch: { tasks: [fakeTask(MONDAY)] } })
    assert.equal(
      plan.dailyTargetMinutes,
      option,
      `target ${option} was overwritten by the task merge`,
    )
  }
})

check('merging preserves every other field of the plan', () => {
  const plan = reduceStudyPlan(
    { ...basePlan(45), pendingPreview: { summary: 'x', tasks: [], fromAi: true } },
    { type: 'merge', patch: { tasks: [fakeTask(MONDAY)] } },
  )
  assert.equal(plan.dailyTargetMinutes, 45)
  assert.equal(plan.pendingPreview?.summary, 'x')
})

check('a select, then merge, then select sequence keeps the latest selection', () => {
  let plan = basePlan(25)
  plan = reduceStudyPlan(plan, { type: 'set-daily-target', minutes: 45 })
  plan = reduceStudyPlan(plan, { type: 'merge', patch: { tasks: [fakeTask(MONDAY)] } })
  plan = reduceStudyPlan(plan, { type: 'set-daily-target', minutes: 15 })
  assert.equal(plan.dailyTargetMinutes, 15, 'second selection was lost')
  assert.equal(plan.tasks.length, 1, 'tasks were dropped by the second selection')
})

/* ---------- Report ---------- */

console.log(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
