import { test, expect } from 'claude-code/testing'
import { nextMidnight } from '../../hooks/core/pace.ts'
import { T0, bash, begin, cmd, world02 as world } from '../helpers/world.ts'

// The weekday pace (weeklyPace) through the engine. The kit runs in the machine's zone, so the week is
// built in local time: it begins on the Monday at or before T0 and resets on the next Monday at 00:00.
const day = new Date(T0)
const index = (day.getDay() + 6) % 7 // 0 is Monday
const reset = new Date(day.getFullYear(), day.getMonth(), day.getDate() - index + 7).toISOString()
const ceiling = Math.min(18 * (index + 1), 90) // Fri:10 steps 18% a day to 90

test('weeklyPace Fri:10 holds the weekly window at the pace ceiling of the day, below the reserve', async ($, on) => {
  // The first reading of the day is on pace (below the ceiling of the day before), so no rebase starts.
  const w = world(on, { pct: 10, weekPct: ceiling - 18 - 1, weekResetsAt: reset, env: { SPARE10_WEEKLY_PACE: 'Fri:10' }, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  w.weekPct = ceiling - 0.1
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  w.weekPct = ceiling
  expect((await bash($)).result).toBe('ran') // Resume answers the one question
  expect(w.asked.length).toBe(1)
  // The consent holds: the next call passes with no second question, and the later weekly reset does not void it.
  expect((await bash($)).result).toBe('ran')
  expect(w.asked.length).toBe(1)
  // A Resume at the pace lasts until the next local midnight, not until the weekly reset or the weekly open time.
  const midnight = new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(nextMidnight(T0))
  expect(w.asked[0]?.question).toContain(`Until ${midnight} 00:00, spare10 asks you again`)
  expect(w.asked[0]?.question).toContain('weekly pace ceiling')
  expect(w.asked[0]?.question).toContain('Continue on the weekly pace until 90% used?')
  expect(w.asked[0]?.question).not.toContain('weekly reserve')
})

test('a day that starts above the ceiling of the day before is rebased, so the same reading does not hold', async ($, on) => {
  if (index === 0) return // Monday has no day before
  const w = world(on, { pct: 10, weekPct: ceiling - 0.1, weekResetsAt: reset, env: { SPARE10_WEEKLY_PACE: 'Fri:10' }, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  w.weekPct = ceiling
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([]) // the line now runs from the first reading to Friday
})

test('weeklyPace off by default: the same reading passes below the reserve', async ($, on) => {
  const w = world(on, { pct: 10, weekPct: ceiling, weekResetsAt: reset, answer: 'Resume' })
  await begin($, w)
  if (ceiling < 90) expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
})

test('a bad SPARE10_WEEKLY_PACE is ignored, and the pace stays off', async ($, on) => {
  const w = world(on, { pct: 10, weekPct: 89, weekResetsAt: reset, env: { SPARE10_WEEKLY_PACE: 'Fri:200' }, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
})

test('/spare10 shows the weekly pace row with the ceiling of the day', async ($, on) => {
  const w = world(on, { pct: 10, weekPct: ceiling - 19, weekResetsAt: reset, env: { SPARE10_WEEKLY_PACE: 'Fri:10' } })
  await begin($, w)
  const rows = ((await $.command.run(cmd(''))).text ?? '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
  expect(rows).toContain(`· weekly pace Fri:10 (from SPARE10_WEEKLY_PACE): spare10 holds at ${ceiling}% used until midnight`)
})

test('the badge shows the weekly usage in place of the name', async ($, on) => {
  const w = world(on, { pct: 10, weekPct: 12.5, weekResetsAt: reset })
  await begin($, w)
  const ui = await $.ui.mount({ plugin: 'spare10', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  const t = await ui.find({ type: 'Text', text: /week|spare10/ })
  await ui.unmount()
  expect(t?.text).toBe(' ● week 12.5%')
})
