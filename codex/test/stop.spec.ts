import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexDebug, codexText } from '../../hooks/core/codex.ts'
import { formatConsent, formatStopped, parseStopped } from '../../hooks/core/decide.ts'
import type { StoppedRecord } from '../../hooks/core/decide.ts'
import { factsFrom, namedKinds, refusalText, takenOf } from '../../hooks/core/flow.ts'
import { notice } from '../../hooks/core/text.ts'
import { DaemonError } from '../src/daemon.ts'
import { readThread } from '../src/held.ts'
import type { RefusalResult } from '../src/refuse.ts'
import { clearStopped, markWork, stoppedNow, takeOverdueStop, writeStopped } from '../src/stop.ts'
import { freshState } from '../src/store.ts'
import { HOLD_LIMIT_MS } from '../src/timing.ts'
import { HOUR, MIN, SEC, SID, T0, heldCall, logicWorld, rateReply } from './helpers/logic.ts'
import type { LogicWorld } from './helpers/logic.ts'

// Stops and the refusal modes (Codex design 4.4, 4.6, 7.2 stop.ts and refuse.ts, 8.2 stop.spec). A refused
// tool or step is interrupted when its thread is hosted, held in place when the stop continues by itself,
// and else denied once per thread and turn and then held. A held stop (the question could not show) holds
// in every thread. The root ticker and the continuation (stopTick, turn/start) come with ticker.spec.
//
// The kit port (8.2). $.turn.abort and the PAUSED answer of a step have no Codex form: the modes replace them.
// Each tests/kit case and the Codex case that tests it: codex/test/kit-port.txt, kept complete by kit-port.spec.ts.

const RESET = T0 + 2 * HOUR

type B = ReturnType<LogicWorld['broker']>

/** A tripped sense and its verdict at `site`, under the stop in the state. */
async function refused(w: LogicWorld, b: B, site: 'tool' | 'step' = 'tool', pct = 92, reset = RESET) {
  w.reading(b.thread, pct, { reset })
  const s = await b.sense.sense(b.sx, site)
  const a = await b.sense.act(b.sx, s, { site })
  return { s, a }
}

const stopOf = (r: Partial<StoppedRecord> = {}): string =>
  formatStopped({ sessionId: SID, windowEnd: RESET - 20 * MIN, at: T0, kinds: ['five_hour'], auto: true, work: true, skip: true, ...r })

/** Resolves to the refusal, and records when it came. */
function track(p: Promise<RefusalResult>) {
  const box: { r?: RefusalResult } = {}
  void p.then((r) => {
    box.r = r
  })
  return box
}

test('stop: a hosted attended call is interrupted with its thread and turn, and answers the deny rendering', async (t) => {
  const w = logicWorld(t, { daemon: true })
  w.daemon.script.loaded = [SID]
  const b = w.broker()
  w.setState({ stopped: stopOf() })
  const { s, a } = await refused(w, b)
  assert.deepEqual(a.verdict, { kind: 'refuse', text: 'stop' })
  const call = heldCall({ turn: 'U1' })
  const r = await b.refusal.refusal(b.sx, call, 'tool', 'stop', s, a)
  assert.deepEqual(r, { kind: 'deny', text: refusalText('stop', s, a, SID) })
  assert.deepEqual(w.daemon.callsOf('interrupt'), [[SID, 'U1']])
  assert.equal(w.state().interrupts?.['U1'], T0)
  assert.deepEqual(b.interrupted, [[SID, 'U1']])
  // A second call of the same turn sends no second interrupt.
  assert.deepEqual(await b.refusal.refusal(b.sx, heldCall({ turn: 'U1' }), 'step', 'paused', s, a), { kind: 'deny', text: refusalText('stop', s, a, SID) })
  assert.equal(w.daemon.callsOf('interrupt').length, 1)
})

test('stop: an interrupt that times out on a turn that ended counts as interrupted', async (t) => {
  const w = logicWorld(t, { daemon: true })
  w.daemon.script.loaded = [SID]
  w.daemon.script.interrupt = new DaemonError('timeout', 'the daemon call took longer than 8000 ms')
  w.daemon.script.newestTurn = { id: 'U1', status: 'interrupted', startedAt: Math.floor(T0 / 1000) }
  const b = w.broker()
  w.setState({ stopped: stopOf() })
  const { s, a } = await refused(w, b)
  const r = await b.refusal.refusal(b.sx, heldCall({ turn: 'U1' }), 'tool', 'stop', s, a)
  assert.equal(r.kind, 'deny')
  assert.equal(w.state().interrupts?.['U1'], T0)
})

test('stop: an interrupt that fails on a running turn falls back to the next rows, and unmarks the turn', async (t) => {
  const w = logicWorld(t, { daemon: true })
  w.daemon.script.loaded = [SID]
  w.daemon.script.interrupt = new DaemonError('timeout', 'the daemon call took longer than 8000 ms')
  w.daemon.script.newestTurn = { id: 'U1', status: 'inProgress', startedAt: Math.floor(T0 / 1000) }
  const b = w.broker({ env: { SPARE10_AUTO_RESUME: 'off' } })
  w.setState({ stopped: stopOf({ auto: false }) })
  const { s, a } = await refused(w, b)
  const r = await b.refusal.refusal(b.sx, heldCall({ turn: 'U1' }), 'tool', 'stop', s, a)
  assert.deepEqual(r, { kind: 'deny', text: refusalText('stop', s, a, SID) }, 'Continue at the reset off: one deny')
  assert.equal(w.state().interrupts, undefined)
  assert.ok(w.log.lines.includes(codexDebug.interruptFailed('the daemon call took longer than 8000 ms')))
  w.daemon.script.interrupt = new DaemonError('rpc', 'turn/interrupt: thread not found', -32600)
  const r2 = await b.refusal.refusal(b.sx, heldCall({ turn: 'U2' }), 'tool', 'stop', s, a)
  assert.equal(r2.kind, 'deny')
  assert.ok(w.log.lines.includes(codexDebug.interruptFailed('turn/interrupt: thread not found')))
})

// CX-R1: one interrupt per thread and turn, shared by the refusals, the stop sweep and the shutdown of a
// broker. A caller never takes a mark for a done interrupt: it waits for the interrupt that made the mark,
// and the broker drops the other calls of the turn only once the turn is interrupted.
test('stop: two refusals of one hosted turn share one interrupt, and when it fails both fall back to hold, none denied', async (t) => {
  const w = logicWorld(t, { daemon: true })
  w.daemon.script.loaded = [SID]
  w.daemon.script.interruptDelayMs = SEC
  w.daemon.script.interrupt = new DaemonError('rpc', 'turn/interrupt: thread not found', -32600)
  const b = w.broker()
  w.setState({ stopped: stopOf() }) // an auto stop, Continue at the reset on: the next row is hold
  const { s, a } = await refused(w, b)
  const A = track(b.refusal.refusal(b.sx, heldCall({ turn: 'U1' }), 'tool', 'stop', s, a))
  const B = track(b.refusal.refusal(b.sx, heldCall({ turn: 'U1' }), 'tool', 'stop', s, a))
  await w.settle()
  assert.equal(A.r, undefined, 'A waits for the interrupt reply')
  assert.equal(B.r, undefined, 'B waits for the same interrupt, and does not take the mark for a done interrupt')
  assert.deepEqual(w.daemon.callsOf('interrupt'), [[SID, 'U1']], 'one interrupt')
  await w.advance(2 * SEC)
  assert.equal(A.r, undefined, 'A holds in place')
  assert.equal(B.r, undefined, 'B holds in place')
  assert.deepEqual(b.interrupted, [], 'no call of the turn is dropped')
  assert.equal(w.state().interrupts, undefined, 'the mark goes')
})

test('stop: a refusal whose turn the stop sweep marked first answers only after the interrupt reply', async (t) => {
  const w = logicWorld(t, { daemon: true })
  w.daemon.script.loaded = [SID]
  w.daemon.script.interruptDelayMs = SEC
  w.daemon.script.newestTurn = { id: 'U1', status: 'inProgress', startedAt: Math.floor(T0 / 1000) - 60 }
  const b = w.broker()
  w.setState({ stopped: stopOf() })
  const { s, a } = await refused(w, b)
  w.store().locked((tx) => {
    const th = tx.thread(SID)
    th.brokerPid = b.pid
    th.hostPid = 4000
    th.beat = T0
  })
  let swept: number | undefined
  void b.sweep.sweep(b.sx).then((n) => {
    swept = n
  })
  await w.settle()
  assert.equal(typeof w.state().interrupts?.['U1'], 'number', 'the sweep marked the turn and waits for the reply')
  const box = track(b.refusal.refusal(b.sx, heldCall({ turn: 'U1' }), 'tool', 'stop', s, a))
  await w.settle()
  assert.equal(box.r, undefined, 'no deny before the turn is interrupted')
  await w.advance(2 * SEC)
  assert.deepEqual(box.r, { kind: 'deny', text: refusalText('stop', s, a, SID) })
  assert.equal(swept, 1)
  assert.deepEqual(w.daemon.callsOf('interrupt'), [[SID, 'U1']], 'one interrupt')
  assert.deepEqual(b.interrupted, [[SID, 'U1']], 'the calls of the turn drop once, after the reply')
})

test('stop: a turn that another process marked counts as interrupted only once the daemon shows it ended, else the next rows', async (t) => {
  const w = logicWorld(t, { daemon: true })
  w.daemon.script.loaded = [SID]
  let running = true
  w.daemon.script.newestTurn = () => ({ id: 'U1', status: running ? 'inProgress' : 'interrupted', startedAt: Math.floor(T0 / 1000) - 60 })
  const b = w.broker({ env: { SPARE10_AUTO_RESUME: 'off' } })
  w.setState({ stopped: stopOf({ auto: false }), interrupts: { U1: T0 } }) // the CLI sweep marked it
  const { s, a } = await refused(w, b)
  const box = track(b.refusal.refusal(b.sx, heldCall({ turn: 'U1' }), 'tool', 'stop', s, a))
  await w.advance(SEC)
  assert.equal(box.r, undefined, 'the turn still runs: wait')
  running = false
  await w.advance(SEC)
  assert.deepEqual(box.r, { kind: 'deny', text: refusalText('stop', s, a, SID) })
  assert.deepEqual(w.daemon.callsOf('interrupt'), [], 'no second interrupt')
  // A mark whose turn keeps running past INTERRUPT_MS: the next rows (Continue at the reset off: one deny).
  running = true
  w.daemon.script.newestTurn = { id: 'U2', status: 'inProgress', startedAt: Math.floor(T0 / 1000) }
  w.setState({ interrupts: { U1: T0, U2: T0 + 2 * SEC } })
  const late = track(b.refusal.refusal(b.sx, heldCall({ turn: 'U2' }), 'tool', 'stop', s, a))
  await w.advance(7 * SEC)
  assert.equal(late.r, undefined)
  await w.advance(2 * SEC)
  assert.deepEqual(late.r, { kind: 'deny', text: refusalText('stop', s, a, SID) }, 'the one deny of the turn')
  assert.deepEqual(readThread(w.store(), SID)?.denied, ['U2'])
})

test('stop: not hosted and Continue at the reset on, the call holds, and at the stop end it continues in place', async (t) => {
  const w = logicWorld(t, { daemon: true })
  w.daemon.script.loaded = [] // the daemon runs, but it does not host this thread
  const soon = T0 + 25 * MIN
  w.daemon.script.rateLimits = rateReply({ five: 92, fiveReset: soon })
  const b = w.broker()
  // A Stop here until the skip start at T0 + 5 min, with its line still queued.
  w.setState({ stopped: stopOf({ windowEnd: soon - 20 * MIN }), notices: [{ at: T0, text: 'the stop line', tag: 'stop' }] })
  const { s, a } = await refused(w, b, 'tool', 92, soon)
  const call = heldCall({ turn: 'U1' })
  const box = track(b.refusal.refusal(b.sx, call, 'tool', 'stop', s, a))
  await w.settle()
  assert.equal(box.r, undefined, 'held in place')
  assert.deepEqual(w.daemon.callsOf('interrupt'), [])
  assert.deepEqual(readThread(b.sx.store, SID)?.held.map((e) => [e.call, e.question]), [[String(call.id), undefined]])
  const reads = w.daemon.callsOf('rateLimits').length
  await w.advance(5 * MIN)
  assert.deepEqual(box.r, { kind: 'pass' })
  assert.ok(w.daemon.callsOf('rateLimits').length > reads, 'the release reads the daemon first')
  assert.equal(w.state().stopped, undefined)
  const texts = (w.state().notices ?? []).map((n) => n.text)
  assert.equal(texts.length, 1, 'the stop line goes, because the work did not stop')
  assert.match(texts[0] ?? '', /Held work continues\.$/)
  assert.deepEqual(readThread(b.sx.store, SID)?.held, [])
})

test('stop: not hosted and Continue at the reset off, one deny per thread and turn, then hold, and a new turn gets one deny again', async (t) => {
  const w = logicWorld(t, { config: { autoResume: false } })
  const b = w.broker()
  w.setState({ stopped: stopOf({ auto: false, skip: false, windowEnd: RESET }) })
  const { s, a } = await refused(w, b)
  const deny = { kind: 'deny', text: refusalText('stop', s, a, SID) }
  assert.deepEqual(await b.refusal.refusal(b.sx, heldCall({ turn: 'U1' }), 'tool', 'stop', s, a), deny)
  assert.deepEqual(readThread(b.sx.store, SID)?.denied, ['U1'])
  const second = heldCall({ turn: 'U1' })
  const box = track(b.refusal.refusal(b.sx, second, 'tool', 'stop', s, a))
  await w.advance(MIN)
  assert.equal(box.r, undefined, 'the second call of the turn holds')
  assert.deepEqual(await b.refusal.refusal(b.sx, heldCall({ turn: 'U2' }), 'step', 'paused', s, a), deny)
  second.drop()
  await w.settle()
  assert.deepEqual(box.r, deny, 'a dropped call answers the ignored deny rendering')
})

test('stop: a held stop holds also in a hosted thread, and a resume from the CLI lets the call through', async (t) => {
  const w = logicWorld(t, { daemon: true })
  w.daemon.script.loaded = [SID]
  const b = w.broker()
  w.setState({ stopped: stopOf(), stopMeta: { noDialog: true } })
  const { s, a } = await refused(w, b)
  const box = track(b.refusal.refusal(b.sx, heldCall({ turn: 'U1' }), 'tool', 'stop', s, a))
  await w.settle()
  assert.equal(box.r, undefined)
  assert.deepEqual(w.daemon.callsOf('interrupt'), [])
  // `!spare10 resume` writes the consent and clears the stop, under the lock: the wake decides again.
  b.sx.store.locked((tx) => {
    tx.state.consent = formatConsent(SID, RESET)
    delete tx.state.stopped
    delete tx.state.stopMeta
  })
  await w.settle()
  assert.deepEqual(box.r, { kind: 'pass' })
})

test('stop: an unattended stop policy denies once with the codex exec resume text, then holds until the reserve no longer gates', async (t) => {
  const w = logicWorld(t)
  const b = w.broker({ hostKind: 'exec', env: { SPARE10_HEADLESS: 'stop' }, originator: 'codex_exec', source: 'exec' })
  const { s, a } = await refused(w, b)
  assert.deepEqual(a.verdict, { kind: 'refuse', text: 'headless' })
  const deny = await b.refusal.refusal(b.sx, heldCall({ turn: 'U1' }), 'tool', 'headless', s, a)
  assert.deepEqual(deny, { kind: 'deny', text: refusalText('headless', s, a, SID) })
  assert.match(deny.kind === 'deny' ? deny.text : '', new RegExp(`codex exec resume ${SID}`))
  const box = track(b.refusal.refusal(b.sx, heldCall({ turn: 'U1' }), 'tool', 'headless', s, a))
  await w.advance(MIN)
  assert.equal(box.r, undefined)
  w.reading(SID, 50, { reset: RESET })
  await w.advance(30 * SEC)
  assert.deepEqual(box.r, { kind: 'pass' })
})

test('stop: a held call is not let go at the reset itself, only at the stop due time after the 5-minute margin (4.8)', async (t) => {
  const w = logicWorld(t, { config: { lastMinutes: 0 } })
  w.daemon.script.loaded = []
  const b = w.broker()
  const reset = T0 + 10 * MIN
  w.setState({ stopped: stopOf({ windowEnd: reset, skip: false }) })
  const { s, a } = await refused(w, b, 'tool', 92, reset)
  const box = track(b.refusal.refusal(b.sx, heldCall({ turn: 'U1' }), 'tool', 'stop', s, a))
  await w.advance(12 * MIN)
  assert.equal(box.r, undefined, 'the window reset at T0 + 10 min, but the margin runs')
  assert.ok(w.state().stopped !== undefined)
  await w.advance(3 * MIN)
  assert.deepEqual(box.r, { kind: 'pass' })
  assert.equal(w.state().stopped, undefined)
  assert.match((w.state().notices ?? [])[0]?.text ?? '', /Held work continues\.$/)
})

test('stop: with Continue at the reset off a held call waits for the person after the stop end, and a resume lets it through', async (t) => {
  const w = logicWorld(t, { config: { autoResume: false } })
  const b = w.broker()
  const reset = T0 + 10 * MIN
  w.setState({ stopped: stopOf({ windowEnd: reset, auto: false, skip: false }), stopMeta: { noDialog: true } })
  const { s, a } = await refused(w, b, 'tool', 92, reset)
  const box = track(b.refusal.refusal(b.sx, heldCall({ turn: 'U1' }), 'tool', 'stop', s, a))
  await w.advance(HOUR)
  assert.equal(box.r, undefined, 'held work still waits for your answer')
  b.sx.store.locked((tx) => {
    delete tx.state.stopped
    delete tx.state.stopMeta
  })
  await w.settle()
  assert.deepEqual(box.r, { kind: 'pass' })
})

test('stop: an old stop record that ended before the hold began never keeps a held call', async (t) => {
  const w = logicWorld(t, { config: { autoResume: false } })
  const b = w.broker({ hostKind: 'exec', env: { SPARE10_HEADLESS: 'stop' }, originator: 'codex_exec', source: 'exec' })
  // The run is unattended: its hold ends when the reserve no longer gates, whatever stop the state holds.
  w.setState({ stopped: stopOf({ windowEnd: T0 - HOUR, at: T0 - 2 * HOUR, auto: false, skip: false }) })
  const { s, a } = await refused(w, b)
  b.sx.store.locked((tx) => {
    tx.thread(SID).denied = ['U1']
  })
  const box = track(b.refusal.refusal(b.sx, heldCall({ turn: 'U1' }), 'tool', 'headless', s, a))
  await w.settle()
  assert.equal(box.r, undefined)
  w.reading(SID, 50, { reset: RESET })
  await w.advance(30 * SEC)
  assert.deepEqual(box.r, { kind: 'pass' })
  // Attended (a late Stop here that wrote nothing, B46 open): an old record that ended an hour ago holds nothing.
  const w2 = logicWorld(t, { config: { autoResume: false } })
  const b2 = w2.broker()
  w2.setState({ stopped: stopOf({ windowEnd: T0 - HOUR, at: T0 - 2 * HOUR, auto: false, skip: false }) })
  const r2 = await refused(w2, b2, 'tool', 92, T0 + 10 * MIN) // open: the last 20 min before the reset
  assert.equal(r2.s.kinds[0]?.open, true)
  b2.sx.store.locked((tx) => {
    tx.thread(SID).denied = ['U1']
  })
  assert.deepEqual(await b2.refusal.refusal(b2.sx, heldCall({ turn: 'U1' }), 'tool', 'stop', r2.s, r2.a), { kind: 'pass' })
})

test('stop: a held stop that spare10 stop turns into a plain stop interrupts a hosted call', async (t) => {
  const w = logicWorld(t, { daemon: true })
  w.daemon.script.loaded = [SID]
  const b = w.broker()
  w.setState({ stopped: stopOf(), stopMeta: { noDialog: true } })
  const { s, a } = await refused(w, b)
  const box = track(b.refusal.refusal(b.sx, heldCall({ turn: 'U1' }), 'tool', 'stop', s, a))
  await w.settle()
  assert.equal(box.r, undefined)
  // `!spare10 stop` over a held stop: the stop stays, and noDialog goes.
  b.sx.store.locked((tx) => {
    delete tx.state.stopMeta
  })
  await w.settle()
  assert.deepEqual(box.r, { kind: 'deny', text: refusalText('stop', s, a, SID) })
  assert.deepEqual(w.daemon.callsOf('interrupt'), [[SID, 'U1']])
})

test('stop: a prompt is blocked with the verdict text, Stop and PreCompact end the turn, and the other sites pass', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  w.setState({ stopped: stopOf() })
  const { s, a } = await refused(w, b)
  const call = heldCall()
  assert.deepEqual(await b.refusal.refusal(b.sx, call, 'prompt', 'paused', s, a), { kind: 'block', text: refusalText('paused', s, a, SID) })
  assert.deepEqual(await b.refusal.refusal(b.sx, call, 'stop', 'stop', s, a), { kind: 'end', text: codexText.turnEnds })
  assert.deepEqual(await b.refusal.refusal(b.sx, call, 'compact', 'stop', s, a), { kind: 'end', text: codexText.turnEnds })
  assert.deepEqual(await b.refusal.refusal(b.sx, call, 'spawn', 'stop', s, a), { kind: 'pass' })
  assert.deepEqual(await b.refusal.refusal(b.sx, call, 'interrupt', 'stop', s, a), { kind: 'pass' })
})

test('stop: a held call past the hold limit queues the hold-limit line and answers the deny rendering', async (t) => {
  const w = logicWorld(t)
  const b = w.broker({ hostKind: 'exec', env: { SPARE10_HEADLESS: 'stop' }, originator: 'codex_exec', source: 'exec' })
  const { s, a } = await refused(w, b)
  b.sx.store.locked((tx) => {
    tx.thread(SID).denied = ['U1']
  })
  const box = track(b.refusal.refusal(b.sx, heldCall({ turn: 'U1', since: T0 - HOLD_LIMIT_MS + MIN }), 'tool', 'headless', s, a))
  await w.advance(MIN)
  assert.deepEqual(box.r, { kind: 'deny', text: refusalText('headless', s, a, SID) })
  assert.deepEqual(
    (w.state().notices ?? []).map((n) => n.text),
    [notice.holdLimit(factsFrom(namedKinds(s, a), T0 + MIN))],
  )
})

test('stop: a turn end in the rollout drops a held call (a subagent has no Interrupt gate)', async (t) => {
  const w = logicWorld(t, { config: { autoResume: false } })
  const b = w.broker()
  w.setState({ stopped: stopOf({ auto: false, skip: false, windowEnd: RESET }) })
  const { s, a } = await refused(w, b)
  b.sx.store.locked((tx) => {
    tx.thread(SID).denied = ['U1']
  })
  const call = heldCall({ turn: 'U1' })
  const box = track(b.refusal.refusal(b.sx, call, 'tool', 'stop', s, a))
  await w.settle()
  w.rollout(SID).turnAborted('U1', Math.floor(T0 / 1000), T0)
  await w.advance(30 * SEC)
  assert.equal(call.dropped.aborted, true)
  assert.equal(box.r?.kind, 'deny')
})

test('stop: releaseInPlace extends an auto stop while a kind still gates, with the B34 line', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const r0 = { sessionId: SID, windowEnd: T0 + 5 * MIN, at: T0, kinds: ['five_hour' as const], auto: true, work: true }
  w.setState({ stopped: formatStopped(r0) })
  w.reading(SID, 92, { reset: RESET })
  assert.equal(await b.refusal.releaseInPlace(b.sx), false, 'not due yet')
  await w.advance(10 * MIN)
  w.reading(SID, 92, { reset: RESET })
  assert.equal(await b.refusal.releaseInPlace(b.sx), true)
  const r = parseStopped(w.state().stopped)
  assert.equal(r?.windowEnd, RESET - 20 * MIN)
  assert.deepEqual(r?.kinds, ['five_hour'])
  const texts = (w.state().notices ?? []).map((n) => n.text)
  assert.equal(texts.length, 1)
  assert.match(texts[0] ?? '', /The stop lasts until /)
})

test('stop: releaseInPlace waits inside the 5-minute margin after a real reset in the reserve (4.8)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const reset = T0 + MIN
  w.reading(SID, 92, { reset })
  await b.sense.sense(b.sx, 'tool')
  w.setState({ stopped: formatStopped({ sessionId: SID, windowEnd: T0 + MIN, at: T0, kinds: ['five_hour'], auto: true, work: true, test: true }) })
  await w.advance(2 * MIN + 1)
  assert.equal(await b.refusal.releaseInPlace(b.sx), false, 'a test stop over a real reading that reset 1 min ago')
  assert.ok(w.state().stopped !== undefined)
  await w.advance(5 * MIN)
  assert.equal(await b.refusal.releaseInPlace(b.sx), true)
  assert.equal(w.state().stopped, undefined)
})

test('stop: writeStopped merges with the stop of the session, and clearStopped clears the held stop too', () => {
  const st = freshState(SID)
  const first = writeStopped(st, { kinds: ['five_hour'], windowEnd: T0 + HOUR, work: false, auto: true, test: false, skip: false, real: [] }, T0)
  assert.deepEqual(first, { sessionId: SID, windowEnd: T0 + HOUR, at: T0, kinds: ['five_hour'], work: false, auto: true, test: false })
  const merged = writeStopped(st, { kinds: ['seven_day'], windowEnd: T0 + 2 * HOUR, work: true, auto: true, test: false, skip: false, real: [] }, T0 + MIN)
  assert.deepEqual(merged.kinds, ['five_hour', 'seven_day'])
  assert.equal(merged.windowEnd, T0 + 2 * HOUR)
  assert.equal(merged.work, true)
  assert.equal(st.stopped, formatStopped(merged))
  st.stopMeta = { noDialog: true }
  clearStopped(st)
  assert.equal(st.stopped, undefined)
  assert.equal(st.stopMeta, undefined)
})

test('stop: markWork adds work to the stop of this session once, and never to another one', (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  w.setState({ stopped: stopOf({ work: false }) })
  markWork(b.sx, w.log)
  assert.equal(parseStopped(w.state().stopped)?.work, true)
  const rev = w.state().rev
  markWork(b.sx, w.log)
  assert.equal(w.state().rev, rev, 'no second write')
  w.setState({ stopped: formatStopped({ sessionId: 'another', windowEnd: RESET, at: T0, kinds: ['five_hour'], auto: true }) })
  markWork(b.sx, w.log)
  assert.notEqual(parseStopped(w.state().stopped)?.work, true)
})

test('stop: stoppedNow names the stop of this session in force, never another session one', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const { s } = await refused(w, b)
  const gating = s.kinds.filter((k) => k.tripped)
  assert.equal(stoppedNow(b.sx, T0, gating, []), undefined)
  w.setState({ stopped: stopOf() })
  assert.equal(stoppedNow(b.sx, T0, gating, [])?.sessionId, SID)
  w.setState({ stopped: formatStopped({ sessionId: 'another', windowEnd: RESET, at: T0, kinds: ['five_hour'], auto: true }) })
  assert.equal(stoppedNow(b.sx, T0, gating, []), undefined)
})

test('stop: takeOverdueStop clears an overdue auto stop with its line, quiet with none, and leaves a stop that a real kind holds (B35, TS1)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const cfg = { enabled: true }
  const r = { sessionId: SID, windowEnd: T0 - MIN, at: T0 - HOUR, kinds: ['five_hour' as const], auto: true, work: true }
  w.setState({ stopped: formatStopped(r) })
  assert.equal(await takeOverdueStop(b.sx, { cfg, now: T0, attended: false, holders: [] }), undefined, 'unattended: never')
  const taken = await takeOverdueStop(b.sx, { cfg, now: T0, attended: true, holders: [] })
  assert.deepEqual(taken, takenOf(parseStopped(formatStopped(r))!, undefined))
  assert.equal(w.state().stopped, undefined)
  assert.deepEqual(
    (w.state().notices ?? []).map((n) => n.text),
    [notice.stopTakenOver(taken?.reset ?? [], taken?.open ?? [])],
  )
  w.setState({ stopped: formatStopped(r), notices: [] })
  assert.ok((await takeOverdueStop(b.sx, { cfg, now: T0, attended: true, holders: [], quiet: true })) !== undefined)
  assert.deepEqual(w.state().notices, [])
  // TS1: a test skip stop with the real tag of a kind whose real reading still gates in that window holds.
  const held = { ...r, skip: true, real: [{ kind: 'five_hour' as const, resetsAtMs: RESET }] }
  w.setState({ stopped: formatStopped(held) })
  assert.equal(await takeOverdueStop(b.sx, { cfg, now: T0, attended: true, holders: [{ kind: 'five_hour', resetsAtMs: RESET }] }), undefined)
  assert.ok(w.state().stopped !== undefined)
})

test('stop: a test skip stop with the real tag still refuses past its end in a new broker while the real reading gates in its window (TS1)', async (t) => {
  const w = logicWorld(t)
  w.reading(SID, 92, { reset: RESET })
  // A Stop here over a test window that opened at T0 + 5 min, over a real trip of the window that resets at RESET.
  w.setState({
    stopped: formatStopped({ sessionId: SID, windowEnd: T0 + 5 * MIN, at: T0, kinds: ['five_hour'], auto: false, work: true, test: true, skip: true, real: [{ kind: 'five_hour', resetsAtMs: RESET }] }),
  })
  await w.advance(10 * MIN)
  const b = w.broker() // a reload: a new broker with no memory
  w.reading(SID, 92, { reset: RESET })
  const s = await b.sense.sense(b.sx, 'tool')
  const a = await b.sense.act(b.sx, s, { site: 'tool' })
  assert.deepEqual(a.verdict, { kind: 'refuse', text: 'stop' })
  assert.equal(a.stopped, true)
  // A real reading of a new window no longer holds it: the kind asks again.
  w.reading(SID, 92, { reset: RESET + 5 * HOUR })
  const s2 = await b.sense.sense(b.sx, 'tool')
  assert.deepEqual((await b.sense.act(b.sx, s2, { site: 'tool' })).verdict, { kind: 'hold' })
})
