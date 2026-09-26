import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexText, withPrefix } from '../../hooks/core/codex.ts'
import { formatStopped } from '../../hooks/core/decide.ts'
import { readJson } from '../src/files.ts'
import type { QuestionRecord } from '../src/question.ts'
import { HOUR, MIN, SEC, SID, T0, parsed, world } from './helpers/world.ts'
import type { World } from './helpers/world.ts'

// The open reserve near the reset through the gate (Codex design 4.9, 8.2 skip.spec): no question in the
// last span, a question whose skip start passes, a Stop here after the skip start (B46), a test window over
// a real trip (B45), a stop that holds past its end in a new broker (TS1), and a kind at 100% with usable
// credits, which is never open (A23) and whose question names the balance (CX46).
//
// The kit port (8.2):
// Each tests/kit case and the Codex case that tests it: codex/test/kit-port.txt, kept complete by kit-port.spec.ts.

const RESET = T0 + 2 * HOUR
const SKIP = RESET - 20 * MIN
const question = (w: World): QuestionRecord | undefined => readJson<QuestionRecord>(w.file('question.json'))

test('skip: in the last 20 min before the reset every step passes with no question', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 97, { reset: T0 + 10 * MIN })
  assert.equal(await b.gate('tool'), '')
  assert.equal(await b.gate('step'), '')
  assert.equal(await b.gate('prompt', { prompt: 'go' }), '')
  assert.equal(b.forms().length, 0)
})

test('skip: a question whose skip start passes continues the held work with its line, and with Continue at the reset off one note and the work waits', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false)
  await w.advance(SKIP - T0 + 1 * SEC)
  assert.equal(h.box.done, true)
  assert.match(parsed(h.box.text)['systemMessage'] as string, /^spare10: the 5-hour window resets at \d\d:\d\d\. Your 10% reserve is open until then\. Held work continues\.$/)
  // Continue at the reset off: one note at the skip start, and the work waits for the answer.
  const v = world(t, { config: { autoResume: false } })
  const c = await v.broker()
  v.reading(SID, 92, { reset: RESET })
  const k = c.call('tool')
  await v.settle()
  await v.advance(SKIP - T0 + 2 * MIN)
  assert.equal(k.box.done, false)
  const notes = v.notices()
  assert.equal(notes.length, 1)
  assert.match(notes[0] ?? '', /but held work still waits for your answer\. New work goes on with no question\.$/)
  c.host.answer({ action: 'accept', content: { choice: 'resume' } })
  await v.settle()
  assert.equal(k.box.done, true)
})

test('skip: a Stop here after the skip start refuses the held work, writes no stop, and new work goes on (B46)', async (t) => {
  const w = world(t, { config: { autoResume: false } })
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  const h = b.call('tool')
  await w.settle()
  await w.advance(SKIP - T0 + 1 * MIN)
  b.host.answer({ action: 'accept', content: { choice: 'stop' } })
  await w.settle()
  assert.equal(h.box.done, true)
  const out = parsed(h.box.text)
  assert.equal((out['hookSpecificOutput'] as Record<string, unknown>)['permissionDecision'], 'deny')
  // The B43 note of the skip start, then the B46 line of the Stop here.
  const lines = (out['systemMessage'] as string).split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0] ?? '', /^spare10: .+, but held work still waits for your answer\. New work goes on with no question\.$/)
  assert.match(lines[1] ?? '', /^spare10: stopped\. Held work is refused\. .+, so new work goes on with no question\.$/)
  assert.equal(w.state().stopped, undefined)
  assert.equal(await b.gate('tool'), '', 'new work goes on')
})

// A Resume answers one round only. A held call that a stop then holds decides afresh when the stop ends.
for (const [site, second] of [
  ['tool', { action: 'accept', content: { choice: 'stop' } }],
  ['step', { action: 'decline' }],
] as const) {
  test(`skip: a held ${site} call that got a Resume and then ${second.action === 'decline' ? 'a declined form' : 'a Stop here'} asks again at the weekly skip start, and the old Resume does not cover the new 5-hour window`, async (t) => {
    const w = world(t)
    const b = await w.broker()
    const reset1 = T0 + HOUR
    const weekReset = T0 + 11 * HOUR // its skip start: T0 + 3 h
    w.reading(SID, 92, { reset: reset1, weekly: 50, weeklyReset: weekReset })
    const h = b.call(site)
    await w.settle()
    assert.deepEqual(question(w)?.kinds, ['five_hour'])
    // The weekly window trips while the first question is open. The Resume answers only the 5-hour window.
    w.reading(SID, 92, { reset: reset1, weekly: 92, weeklyReset: weekReset })
    b.host.answer({ action: 'accept', content: { choice: 'resume' } })
    await w.settle()
    assert.equal(h.box.done, false)
    assert.equal(b.forms().length, 2)
    assert.deepEqual(question(w)?.kinds, ['seven_day'])
    // A Stop here or a declined form on the weekly question: the call holds in place under the weekly stop.
    b.host.answer(second)
    await w.settle()
    assert.equal(h.box.done, false)
    assert.notEqual(w.state().stopped, undefined)
    // The 5-hour window resets, and its new window climbs into the reserve.
    await w.advance(reset1 - T0 + 5 * MIN)
    w.reading(SID, 92, { reset: T0 + 6 * HOUR, weekly: 92, weeklyReset: weekReset })
    await w.advance(10 * MIN)
    assert.equal(h.box.done, false, 'the weekly stop still holds the call')
    // At the weekly skip start the stop ends. The new 5-hour window gates, so the call asks again.
    await w.advance(weekReset - 8 * HOUR - w.clock.now() + SEC)
    assert.equal(h.box.done, false, 'no pass on the Resume of the old window')
    assert.equal(b.forms().length, 3)
    assert.deepEqual(question(w)?.kinds, ['five_hour'])
    b.host.answer({ action: 'accept', content: { choice: 'resume' } })
    await w.settle()
    assert.equal(h.box.done, true)
  })
}

test('skip: a test window over a real trip does not open its reserve (B45)', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  const reply = parsed(await b.gate('prompt', { prompt: 'spare10 simulate 93 in 10m' }))['reason'] as string
  assert.match(reply, /The real reading is also in the reserve, so the test window does not open it\./)
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false, 'the real trip still asks')
  assert.equal(b.forms().length, 1)
})

test('skip: a test skip stop with the real tag still refuses past its end in a new broker while the real reading gates (TS1)', async (t) => {
  const w = world(t, { config: { autoResume: false } })
  w.reading(SID, 92, { reset: RESET })
  const end = T0 + 10 * MIN
  w.setState({
    stopped: formatStopped({ sessionId: SID, windowEnd: end, at: T0, kinds: ['five_hour'], auto: false, work: true, skip: true, test: true, real: [{ kind: 'five_hour', resetsAtMs: RESET }] }),
  })
  await w.advance(end - T0 + 5 * MIN)
  // A "reload": a new broker of the same thread reads the stop from the files.
  const b = await w.broker({ pid: 555 })
  const out = parsed(await b.gate('tool'))
  assert.equal((out['hookSpecificOutput'] as Record<string, unknown>)['permissionDecision'], 'deny')
  assert.match((out['hookSpecificOutput'] as Record<string, unknown>)['permissionDecisionReason'] as string, /^spare10: the user stopped work at the quota reserve/)
  assert.equal(b.forms().length, 0)
})

test('skip: a kind at 100% with usable credits is never open, and its question names the balance (A23, CX46)', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 100, { reset: T0 + 10 * MIN, credits: { has_credits: true, unlimited: false, balance: '42.50' } })
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false, 'inside the last 20 min, and still asked')
  const q = question(w)
  assert.equal(q?.credits, '42.50')
  const message = (b.forms()[0]?.['params'] as Record<string, unknown>)['message'] as string
  assert.ok(message.endsWith(` ${codexText.creditsQuestion('42.50')}`))
  // The report names the credits (CX16).
  const report = parsed(await b.gate('prompt', { prompt: 'spare10' }))['reason'] as string
  assert.ok(report.includes(`⚠ ${codexText.credits('42.50')}`))
  b.host.answer({ action: 'accept', content: { choice: 'resume' } })
  await w.settle()
  assert.match(parsed(h.box.text)['systemMessage'] as string, new RegExp(`^${withPrefix('continuing').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
})
