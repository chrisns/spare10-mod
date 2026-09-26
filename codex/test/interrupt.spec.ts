import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatStopped } from '../../hooks/core/decide.ts'
import { CHILD, HOUR, MIN, SEC, SID, T0, parsed, world } from './helpers/world.ts'

// Esc, the Interrupt gate and dropped calls (Codex design 4.12, 8.2 interrupt.spec): the Interrupt gate
// answers fast with the queued stop line, drops the held calls of its turn, records whether spare10
// caused the interrupt, and a turn end in a subagent's rollout drops the subagent's held call.
//
// The kit port (8.2). The withdrawal of a dialog (hook 5) has no Codex form.
// Each tests/kit case and the Codex case that tests it: codex/test/kit-port.txt, kept complete by kit-port.spec.ts.

const RESET = T0 + 2 * HOUR

test('interrupt: the Interrupt gate answers in under 100 ms with the queued stop line', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  const h = b.call('tool', { turn: 'U1' })
  await w.settle()
  b.host.answer({ action: 'accept', content: { choice: 'stop' } })
  await w.settle()
  // Not hosted, Continue at the reset on: the call holds in place under the stop, and the stop line waits.
  assert.equal(h.box.done, false)
  assert.equal(w.notices().length, 1)
  const at = performance.now()
  const out = parsed(await b.gate('interrupt', { turn: 'U1' }))
  const ms = performance.now() - at
  t.diagnostic(`interrupt gate: ${ms.toFixed(1)} ms`)
  assert.ok(ms < 100, `the Interrupt gate took ${ms} ms`)
  assert.match(out['systemMessage'] as string, /^spare10: stopped at your 10% reserve until /)
  assert.deepEqual(Object.keys(out), ['systemMessage'])
})

test('interrupt: Esc drops the held calls of its turn, and only those', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  w.setState({ stopped: formatStopped({ sessionId: SID, windowEnd: RESET - 20 * MIN, at: T0, kinds: ['five_hour'], auto: true, work: true, skip: true }) })
  const h1 = b.call('tool', { turn: 'U1' })
  const h2 = b.call('tool', { turn: 'U2' })
  await w.settle()
  assert.equal(h1.box.done, false)
  assert.equal(h2.box.done, false)
  await b.gate('interrupt', { turn: 'U1' })
  await w.settle()
  assert.equal(h1.box.done, true)
  assert.equal(h2.box.done, false)
  assert.deepEqual(
    w.thread(SID)?.held.map((e) => e.turn),
    ['U2'],
  )
  assert.equal(w.state().lastInterrupt?.bySpare10, false, 'an Esc: not spare10')
  assert.ok(w.log.lines.includes('spare10: 1 held call(s) dropped.'), w.log.lines.join('\n'))
})

test('interrupt: bySpare10 is true after the broker interrupted the turn itself', async (t) => {
  const w = world(t, { daemon: true })
  const b = await w.broker({ hosted: true })
  w.reading(SID, 92, { reset: RESET })
  w.daemon.script.newestTurn = { id: 'U1', status: 'inProgress', startedAt: Math.floor(T0 / 1000) - 5 }
  const h = b.call('tool', { turn: 'U1' })
  await w.settle()
  b.host.answer({ action: 'accept', content: { choice: 'stop' } })
  await w.settle()
  assert.equal(h.box.done, true)
  assert.deepEqual(w.daemon.callsOf('interrupt'), [[SID, 'U1']])
  // Codex then runs the Interrupt hook of the turn.
  const out = parsed(await b.gate('interrupt', { turn: 'U1' }))
  assert.equal(w.state().lastInterrupt?.bySpare10, true)
  assert.equal(w.state().lastInterrupt?.turnId, 'U1')
  assert.match(out['systemMessage'] as string, /^spare10: stopped at your 10% reserve/)
})

test('interrupt: a turn end in a subagent rollout drops its held call', async (t) => {
  const w = world(t)
  await w.broker()
  const child = await w.broker({ thread: CHILD })
  w.reading(CHILD, 92, { reset: RESET })
  const h = child.call('tool', { turn: 'C1' })
  await w.settle()
  assert.equal(h.box.done, false)
  w.rollout(CHILD).turnAborted('C1', Math.floor(T0 / 1000), w.clock.now())
  await w.advance(31 * SEC)
  assert.equal(h.box.done, true)
  assert.deepEqual(w.thread(CHILD)?.held, [])
})
