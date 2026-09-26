import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexText, withPrefix } from '../../hooks/core/codex.ts'
import { questionText } from '../../hooks/core/text.ts'
import { readJson } from '../src/files.ts'
import type { QuestionRecord } from '../src/question.ts'
import { HOUR, MIN, SID, T0, parsed, world } from './helpers/world.ts'
import type { World } from './helpers/world.ts'

// Both windows, and plans with only a weekly window (Codex design 4.15, 3.6, 8.2 weekly.spec): one question
// for both windows. The owner's weekly-only plan: armed, the weekly trip asks, `spare10 simulate 92` and
// SPARE10_SIMULATE=92 give a weekly test reading, the replies name no 5-hour trip, CX40. A weekly reserve of
// 0 on such a plan watches nothing (CX13). A login whose live reads have no window is blind.
//
// The kit port (8.2):
// Each tests/kit case and the Codex case that tests it: codex/test/kit-port.txt, kept complete by kit-port.spec.ts.

const RESET = T0 + 2 * HOUR
const WEEK_RESET = T0 + 3 * 24 * HOUR
const question = (w: World): QuestionRecord | undefined => readJson<QuestionRecord>(w.file('question.json'))

/** The account of the owner: the codex bucket reports only a weekly window. Two observations: the rollout's and the live read's. */
function weeklyOnly(w: World, pct: number): void {
  const snap = { limitId: 'codex', primary: { usedPercent: pct, windowDurationMins: 10080, resetsAt: Math.floor(WEEK_RESET / 1000) }, secondary: null }
  w.rollout(SID).tokenCount({ at: w.clock.now() - MIN, primary: { pct, mins: 10080, resetsAt: WEEK_RESET }, secondary: null })
  w.live({ ordinaryUsageAllowed: true, rateLimits: snap, rateLimitsByLimitId: { codex: snap } }, w.clock.now(), 2)
}

test('weekly: both windows in the reserve give one question that names both', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET, weekly: 95, weeklyReset: WEEK_RESET })
  const h = b.call('tool')
  await w.settle()
  const q = question(w)
  assert.deepEqual(q?.kinds, ['five_hour', 'seven_day'])
  assert.equal((b.forms()[0]?.['params'] as Record<string, unknown>)['message'], questionText(q?.facts ?? [], 'loop', 'hold', q?.auto))
  assert.equal(b.forms().length, 1)
  b.host.answer({ action: 'accept', content: { choice: 'resume' } })
  await w.settle()
  assert.equal(h.box.done, true)
  assert.notEqual(w.state().consent, undefined)
  assert.notEqual(w.state().weeklyConsent, undefined)
})

test('weekly: a weekly-only plan is armed, its weekly trip asks, and the replies name no 5-hour trip (CX40)', async (t) => {
  const w = world(t)
  weeklyOnly(w, 61)
  const b = await w.broker()
  const report = parsed(await b.gate('prompt', { prompt: 'spare10' }))['reason'] as string
  assert.match(report, /● armed {10}spare10 steps in at 90% used of the weekly window\./)
  assert.match(report, /· reading {8}none: Codex reports no 5-hour window for this plan/)
  assert.equal(parsed(await b.gate('prompt', { prompt: 'spare10 stop' }))['reason'], 'spare10: nothing to stop. spare10 steps in at 90% used of the weekly window.')
  // The first root sense warns once: only a weekly window, with the weekly open span.
  const tool = parsed(await b.gate('tool'))
  assert.equal(tool['systemMessage'], withPrefix(codexText.weeklyOnlyOpen(8)))
  assert.equal(await b.gate('tool'), '')
  // The weekly trip asks with the weekly texts: a newer response than the live read.
  await w.advance(MIN)
  w.rollout(SID).tokenCount({ at: w.clock.now(), primary: { pct: 92, mins: 10080, resetsAt: WEEK_RESET }, secondary: null })
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false)
  assert.deepEqual(question(w)?.kinds, ['seven_day'])
  assert.match((b.forms()[0]?.['params'] as Record<string, unknown>)['message'] as string, /^Your 10% weekly reserve is reached: 92% used/)
})

test('weekly: spare10 simulate 92 sets a weekly test reading on a weekly-only plan, and so does SPARE10_SIMULATE=92', async (t) => {
  const w = world(t)
  weeklyOnly(w, 40)
  const b = await w.broker()
  await b.gate('tool') // the kinds are known
  const reply = parsed(await b.gate('prompt', { prompt: 'spare10 simulate 92' }))['reason'] as string
  assert.match(reply, /^spare10: test reading set to 92% used of the weekly window/)
  assert.equal(w.state().test?.kinds.seven_day?.pct, 92)
  assert.equal(w.state().test?.kinds.five_hour, undefined)
  // SPARE10_SIMULATE on a TUI host, at the first root gate of a new session.
  const v = world(t)
  weeklyOnly(v, 40)
  await v.broker({ env: { SPARE10_SIMULATE: '92' } })
  assert.equal(v.state().test?.kinds.seven_day?.pct, 92)
  assert.equal(v.state().test?.envDone, true)
})

test('weekly: a weekly reserve of 0 on a weekly-only plan watches no window, and says so (CX13)', async (t) => {
  const w = world(t, { config: { weeklyReserve: 0 } })
  weeklyOnly(w, 97)
  const b = await w.broker()
  assert.equal(parsed(await b.gate('tool'))['systemMessage'], withPrefix(codexText.weeklyOnlyOff))
  assert.equal(await b.gate('tool'), '')
  assert.equal(b.forms().length, 0)
  const report = parsed(await b.gate('prompt', { prompt: 'spare10' }))['reason'] as string
  assert.match(report, /● armed {10}spare10 watches no window\./)
  assert.ok(report.includes(`⚠ ${codexText.weeklyOnlyOff}`))
})

test('weekly: two live reads with no window make the login blind, and every step passes', async (t) => {
  const w = world(t)
  const b = await w.broker()
  const empty = { limitId: 'codex', primary: null, secondary: null }
  w.live({ ordinaryUsageAllowed: true, rateLimits: empty, rateLimitsByLimitId: { codex: empty } }, w.clock.now(), 2)
  assert.equal(await b.gate('tool'), '')
  const report = parsed(await b.gate('prompt', { prompt: 'spare10' }))['reason'] as string
  assert.match(report, /⚠ blind {10}Codex reports no quota windows for this login\./)
  assert.match(report, /· reading {8}none: Codex reports no quota \(blind\)/)
})
