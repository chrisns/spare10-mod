import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatConsent } from '../../hooks/core/decide.ts'
import { questionText } from '../../hooks/core/text.ts'
import { readJson } from '../src/files.ts'
import type { QuestionRecord } from '../src/question.ts'
import { HOUR, MIN, SID, T0, parsed, world } from './helpers/world.ts'
import type { World, WorldBroker } from './helpers/world.ts'

// The resume floor through the gate (Codex design 4.8, 8.2 floor.spec). As on Claude: a Resume at the
// reserve holds again at the floor with the second question, the second Resume lasts until the reset,
// `spare10 resume` before and past the floor, a test reading raised in place, and the tombs. One Codex rule
// adds to it: after a reset credit a consent of the old window is void (A22).
//
// The kit port (8.2):
// Each tests/kit case and the Codex case that tests it: codex/test/kit-port.txt, kept complete by kit-port.spec.ts.

const RESET = T0 + 2 * HOUR

const question = (w: World): QuestionRecord | undefined => readJson<QuestionRecord>(w.file('question.json'))

/** One tool call that asks: the form's message, then the answer. The answer text of the call. */
async function askAndAnswer(w: World, b: WorldBroker, choice: 'resume' | 'stop'): Promise<{ message: string; q: QuestionRecord; text: string }> {
  const n = b.forms().length
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false, 'the call holds')
  assert.equal(b.forms().length, n + 1, 'one new form')
  const q = question(w)
  assert.ok(q !== undefined)
  const message = (b.forms()[n]?.['params'] as Record<string, unknown>)['message'] as string
  assert.equal(message, questionText(q.facts, q.opener, q.mode, q.auto))
  b.host.answer({ action: 'accept', content: { choice } })
  await w.settle()
  assert.equal(h.box.done, true)
  return { message, q, text: h.box.text ?? '' }
}

test('floor: a Resume at the reserve asks again at the floor, and the second Resume lasts until the reset', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  const first = await askAndAnswer(w, b, 'resume')
  assert.match(first.message, /^Your 10% reserve is reached: 92% used/)
  assert.equal(w.state().consent, formatConsent(SID, RESET, 95), 'B49: the first Resume goes to the floor')
  assert.equal(await b.gate('tool'), '', 'below the floor the loop passes')
  // At the floor: the second question.
  await w.advance(10 * MIN)
  w.reading(SID, 96, { reset: RESET })
  const second = await askAndAnswer(w, b, 'resume')
  assert.match(second.message, /^Your 5% floor is reached: 96% used/)
  assert.equal(w.state().consent, formatConsent(SID, RESET), 'the second Resume lasts until the reset')
  w.reading(SID, 99, { reset: RESET })
  assert.equal(await b.gate('tool'), '')
  assert.equal(b.forms().length, 2)
})

test('floor: spare10 resume before the floor consents to the floor, and past the floor until the reset', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  const before = parsed(await b.gate('prompt', { prompt: 'spare10 resume' }))['reason'] as string
  assert.match(before, /^spare10: you can use the reserve until 95% used\./)
  assert.equal(w.state().consent, formatConsent(SID, RESET, 95))
  w.reading(SID, 96, { reset: RESET })
  const past = parsed(await b.gate('prompt', { prompt: 'spare10 resume' }))['reason'] as string
  assert.match(past, /^spare10: you can use /)
  assert.equal(w.state().consent, formatConsent(SID, RESET), 'past the floor: until the reset')
  assert.equal(await b.gate('tool'), '')
})

test('floor: a test reading raised in place shows the second question (LCX9)', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 30, { reset: RESET })
  assert.match(parsed(await b.gate('prompt', { prompt: 'spare10 simulate 91 in 1h' }))['reason'] as string, /^spare10: test reading set to 91% used/)
  await askAndAnswer(w, b, 'resume')
  assert.equal(await b.gate('tool'), '')
  assert.match(parsed(await b.gate('prompt', { prompt: 'spare10 simulate 96' }))['reason'] as string, /^spare10: test reading raised to 96% used.+ Your earlier answers stay\./)
  const second = await askAndAnswer(w, b, 'resume')
  assert.match(second.message, /^Your 5% floor is reached: 96% used .+ Continue on the last 4% until /)
})

test('floor: a consent to the floor that ended at its point never comes back (the tombs, B52)', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.setState({ consent: formatConsent(SID, RESET, 95) })
  w.reading(SID, 96, { reset: RESET })
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false, 'at the floor it asks')
  assert.equal(w.state().consent, undefined)
  assert.deepEqual(w.state().tombs?.five_hour?.map((x) => x.to), [95])
  b.host.answer({ action: 'accept', content: { choice: 'stop' } })
  await w.settle()
  // A stale lower reading (another source) does not bring the buried consent back.
  w.setState({ stopped: undefined, consent: formatConsent(SID, RESET, 95) })
  w.reading(SID, 93, { reset: RESET })
  const again = b.call('tool')
  await w.settle()
  assert.equal(again.box.done, false, 'the buried consent does not count: the reserve asks')
  assert.equal(b.forms().length, 2)
})

test('floor: after a reset credit, a consent of the old window is void and the new window asks at its reserve (A22)', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.setState({ consent: formatConsent(SID, RESET, 95) })
  w.reading(SID, 92, { reset: RESET })
  assert.equal(await b.gate('tool'), '', 'the consent covers its window')
  // A reset credit: the window reset early, and the new window ends 5 h from now.
  await w.advance(10 * MIN)
  w.reading(SID, 92, { reset: w.clock.now() + 5 * HOUR })
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false, 'the old consent does not cover the new window')
  assert.equal(w.state().consent, undefined, 'the void value is removed')
  assert.equal(b.forms().length, 1)
})

test('floor: a real consent to the floor survives a Stop here on a test reading, and the stop ends on it with one continuation (TS1)', async (t) => {
  const w = world(t, { daemon: true })
  const b = await w.broker({ hosted: true })
  w.reading(SID, 93, { reset: RESET })
  w.setState({ consent: formatConsent(SID, RESET, 95) })
  w.daemon.script.newestTurn = { id: 'U1', status: 'inProgress', startedAt: Math.floor(T0 / 1000) - 60 }
  const sim = parsed(await b.gate('prompt', { prompt: 'spare10 simulate 97 in 22m' }))
  assert.match(sim['reason'] as string, /^spare10: test reading set to 97% used/)
  const { q, message } = await askAndAnswer(w, b, 'stop')
  assert.equal(q.facts[0]?.test, true)
  assert.equal(q.facts[0]?.floor, 5, 'the second question, on the test reading')
  assert.match(message, /^Your 5% floor is reached: /)
  const { parseStopped } = await import('../../hooks/core/decide.ts')
  const r = parseStopped(w.state().stopped)
  assert.equal(r?.test, true)
  assert.equal(r?.skip, true)
  assert.equal(r?.real, undefined, 'the real reading (93) is below the point of its consent: no real tag')
  assert.equal(w.state().consent, formatConsent(SID, RESET, 95), 'the real consent stays')
  // At the skip start of the test window the stop ends on the real consent: no extension, one turn/start.
  w.daemon.script.newestTurn = { id: 'U1', status: 'interrupted', startedAt: Math.floor(T0 / 1000) - 60 }
  await w.advance(2 * MIN + 31_000)
  assert.equal(w.state().stopped, undefined)
  assert.equal(w.daemon.callsOf('start').length, 1)
  assert.ok(!w.notices().some((n) => n.includes('The stop lasts until')), 'no extension line')
  assert.equal(w.state().consent, formatConsent(SID, RESET, 95))
})
