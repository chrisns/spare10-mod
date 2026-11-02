import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dayStartOf, paceCeilingAt, parseWeeklyPace } from '../../hooks/core/pace.ts'
import { WEEK_MS } from '../../hooks/core/reading.ts'
import { readJson, writeJson } from '../src/files.ts'
import type { SeedFile } from '../src/quota.ts'
import { VERSION } from '../../hooks/core/text.ts'
import type { QuestionRecord } from '../src/question.ts'
import { HOUR, MIN, SID, T0, parsed, world } from './helpers/world.ts'
import type { World } from './helpers/world.ts'

// The weekly pace on Codex (weeklyPace, the Claude kit pace.test.ts): the same pace line, the same day-scoped
// Resume and midnight rebase, with the rebase kept in state.json. Weekdays are local, as on Claude, so the
// week is built in local time: it begins on the Monday at or before T0 and resets on the next Monday at 00:00.
//
// The kit port (8.2):
// Each tests/kit case and the Codex case that tests it: codex/test/kit-port.txt, kept complete by kit-port.spec.ts.

const day = new Date(T0)
const index = (day.getDay() + 6) % 7 // 0 is Monday
const WEEK_RESET = new Date(day.getFullYear(), day.getMonth(), day.getDate() - index + 7).getTime()
const RESET = T0 + 2 * HOUR
const PACE = 'Sun:10'
const cps = parseWeeklyPace(PACE) ?? []
const ceiling = paceCeilingAt(cps, WEEK_RESET, T0, WEEK_MS) ?? 90
const yesterday = paceCeilingAt(cps, WEEK_RESET, dayStartOf(T0) - 1, WEEK_MS) // null on the first day
const question = (w: World): QuestionRecord | undefined => readJson<QuestionRecord>(w.file('question.json'))
const weekly = (w: World, pct: number): void => w.reading(SID, 10, { reset: RESET, weekly: pct, weeklyReset: WEEK_RESET })

test('pace: Sun:10 holds the weekly window at the pace ceiling of the day, below the reserve', async (t) => {
  const w = world(t, { config: { weeklyPace: PACE } })
  // The first reading of the day is on pace (below the ceiling of the day before), so no rebase starts.
  weekly(w, Math.max(1, (yesterday ?? 2) - 1))
  const b = await w.broker()
  assert.equal(await b.gate('tool'), '')
  await w.advance(MIN)
  weekly(w, ceiling - 0.1)
  assert.equal(await b.gate('tool'), '')
  await w.advance(MIN)
  weekly(w, ceiling)
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false)
  assert.deepEqual(question(w)?.kinds, ['seven_day'])
  const message = (b.forms()[0]?.['params'] as Record<string, unknown>)['message'] as string
  assert.match(message, /^Your weekly pace ceiling \(/)
  assert.match(message, /Continue on the weekly pace until /)
  assert.doesNotMatch(message, /weekly reserve/)
  b.host.answer({ action: 'accept', content: { choice: 'resume' } })
  await w.settle()
  assert.equal(h.box.done, true)
  assert.notEqual(w.state().weeklyConsent, undefined)
  // The Resume lasts until midnight: the next call passes with no second question, and the consent is not voided by the later weekly reset.
  assert.equal(await b.gate('tool'), '')
  assert.equal(b.forms().length, 1)
  assert.notEqual(w.state().weeklyConsent, undefined)
})

test('pace: a day that starts above the ceiling of the day before is rebased, so the same reading does not hold', async (t) => {
  if (yesterday === null) return // Monday has no day before
  const w = world(t, { config: { weeklyPace: PACE } })
  weekly(w, ceiling - 0.1)
  const b = await w.broker()
  assert.equal(await b.gate('tool'), '')
  assert.notEqual(w.state().pace?.anchor, undefined)
  await w.advance(MIN)
  weekly(w, ceiling)
  assert.equal(await b.gate('tool'), '')
  assert.equal(question(w), undefined)
})

test('pace: off by default, the same reading passes below the reserve', async (t) => {
  const w = world(t)
  weekly(w, ceiling)
  const b = await w.broker()
  assert.equal(await b.gate('tool'), '')
  assert.equal(question(w), undefined)
  assert.equal(w.state().pace, undefined)
})

test('pace: a bad SPARE10_WEEKLY_PACE is ignored with a warning, and the pace stays off', async (t) => {
  const w = world(t)
  weekly(w, 89)
  const b = await w.broker({ env: { SPARE10_WEEKLY_PACE: 'Fri:200' } })
  const reply = parsed(await b.gate('prompt', { prompt: 'spare10' }))['reason'] as string
  assert.match(reply, /SPARE10_WEEKLY_PACE="Fri:200" is not a list like Fri:10/)
  assert.doesNotMatch(reply, /weekly pace {4}/)
  assert.equal(await b.gate('tool'), '')
  assert.equal(question(w), undefined)
})

test('pace: spare10 shows the weekly pace row with the ceiling of the day', async (t) => {
  const w = world(t, { config: { weeklyPace: PACE } })
  weekly(w, Math.max(1, (yesterday ?? 2) - 1))
  const b = await w.broker()
  const reply = parsed(await b.gate('prompt', { prompt: 'spare10' }))['reason'] as string
  assert.match(reply, new RegExp(`· weekly pace {4}${PACE} \\([^)]*\\): spare10 holds at ${ceiling}% used until midnight`))
})

test('pace: a new session that has only seed.json reads the first reading of the day from it, and rebases', async (t) => {
  if (yesterday === null) return // Monday has no day before
  const w = world(t, { config: { weeklyPace: PACE } })
  writeJson(join(w.data, 'seed.json'), { v: 1, by: VERSION, seven_day: { pct: ceiling - 0.1, resetsAtMs: WEEK_RESET, at: T0 - MIN } } satisfies SeedFile)
  const b = await w.broker()
  assert.equal(await b.gate('tool'), '')
  assert.notEqual(w.state().pace?.anchor, undefined)
  assert.equal(question(w), undefined)
})
