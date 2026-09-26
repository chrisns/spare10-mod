import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexDebug } from '../../hooks/core/codex.ts'
import { formatStopped } from '../../hooks/core/decide.ts'
import type { StoppedRecord } from '../../hooks/core/decide.ts'
import { refusalText } from '../../hooks/core/flow.ts'
import { DaemonError } from '../src/daemon.ts'
import type { TurnInfo } from '../src/daemon.ts'
import { coveredBy } from '../src/sweep.ts'
import { INTERRUPT_MARK_MS } from '../src/timing.ts'
import { CHILD, HOUR, MIN, SEC, SID, T0, heldCall, logicWorld } from './helpers/logic.ts'
import type { LogicWorld } from './helpers/logic.ts'

// The stop sweep (Codex design 4.23, A18, 8.2 sweep.spec): when a stop starts on the daemon, every running
// turn of the session that started at or before the stop is interrupted once, also where no call is held
// (a shell command that polls with write_stdin has no gate). A turn that started after the stop passed its
// own gates and is never swept. Without the daemon there is no sweep.
//
// The kit port (8.2): the sweep has no Claude form (Claude aborts only the refused turn).

const RESET = T0 + 2 * HOUR
const OTHER = '01a0da07-0000-7000-8000-00000000c42e'
const THIRD = '01a0da07-0000-7000-8000-00000000c43f'
const startedAt = (ms: number): number => Math.floor(ms / 1000)

const stopRecord = (r: Partial<StoppedRecord> = {}): string =>
  formatStopped({ sessionId: SID, windowEnd: RESET - 20 * MIN, at: T0, kinds: ['five_hour'], auto: true, work: true, skip: true, ...r })

/** Thread files of the session, as the gate's bind writes them. */
function bind(w: LogicWorld, ...tids: string[]): void {
  w.store().locked((tx) => {
    for (const tid of tids) {
      const th = tx.thread(tid)
      th.brokerPid = 900
      th.hostPid = 4000
      th.beat = w.clock.now()
    }
  })
}

/** The daemon's newest turn per thread. */
function turns(w: LogicWorld, map: Record<string, TurnInfo | undefined>): void {
  w.daemon.script.newestTurn = (tid: string) => map[tid]
}

test('sweep: coveredBy compares the turn start in seconds with the stop time, and sweeps an unknown start', () => {
  assert.equal(coveredBy({ startedAt: startedAt(T0) }, T0), true)
  assert.equal(coveredBy({ startedAt: startedAt(T0) + 1 }, T0), false)
  assert.equal(coveredBy({ startedAt: null }, T0), true)
})

test('sweep: Stop here with three threads interrupts each running turn once, also where no call is held', async (t) => {
  const w = logicWorld(t, { daemon: true })
  w.daemon.script.loaded = [SID, CHILD, OTHER]
  turns(w, {
    [SID]: { id: 'U1', status: 'inProgress', startedAt: startedAt(T0) - 60 },
    [CHILD]: { id: 'C1', status: 'inProgress', startedAt: startedAt(T0) - 30 },
    [OTHER]: { id: 'O1', status: 'inProgress', startedAt: startedAt(T0) - 10 },
  })
  bind(w, CHILD, OTHER)
  const b = w.broker()
  w.reading(SID, 92, { reset: RESET })
  const s = await b.sense.sense(b.sx, 'tool')
  const a = await b.sense.act(b.sx, s, { site: 'tool' })
  const call = heldCall({ turn: 'U1' })
  const key = b.questions.ensureQuestion(b.sx, call, 'loop', s, a)
  const out = b.questions.waitQuestion(b.sx, call, key)
  await w.settle()
  b.mcp.answer('stop')
  assert.equal(await out, 'stop')
  await w.settle()
  assert.deepEqual(
    w.daemon.callsOf('interrupt').sort(),
    [
      [CHILD, 'C1'],
      [OTHER, 'O1'],
      [SID, 'U1'],
    ].sort(),
  )
  assert.deepEqual(Object.keys(w.state().interrupts ?? {}).sort(), ['C1', 'O1', 'U1'])
  assert.ok(w.log.lines.includes(codexDebug.swept(3)))
  // The held call refuses by its mode (hosted: interrupt), which the sweep did already.
  assert.deepEqual(await b.refusal.refusal(b.sx, call, 'tool', 'stop', s, a), { kind: 'deny', text: refusalText('stop', s, a, SID) })
  assert.equal(w.daemon.callsOf('interrupt').length, 3)
})

test('sweep: a thread that is not loaded, an idle thread and a thread with no turn are skipped', async (t) => {
  const w = logicWorld(t, { daemon: true })
  w.daemon.script.loaded = [SID, CHILD, THIRD]
  turns(w, {
    [SID]: { id: 'U1', status: 'completed', startedAt: startedAt(T0) - 60 },
    [CHILD]: undefined,
    [OTHER]: { id: 'O1', status: 'inProgress', startedAt: startedAt(T0) - 10 },
    [THIRD]: { id: 'T1', status: 'inProgress', startedAt: startedAt(T0) - 10 },
  })
  bind(w, SID, CHILD, OTHER, THIRD)
  w.setState({ stopped: stopRecord() })
  const b = w.broker()
  assert.equal(await b.sweep.sweep(b.sx), 1)
  assert.deepEqual(w.daemon.callsOf('interrupt'), [[THIRD, 'T1']])
  assert.deepEqual(
    w.daemon.callsOf('newestTurn').map((c) => c[0]),
    [SID, CHILD, THIRD].sort(),
  )
})

test('sweep: a turn that started after the stop (a Luna turn) is never swept', async (t) => {
  const w = logicWorld(t, { daemon: true })
  w.daemon.script.loaded = [SID, CHILD]
  turns(w, {
    [SID]: { id: 'U2', status: 'inProgress', startedAt: startedAt(T0) + 5 },
    [CHILD]: { id: 'C1', status: 'inProgress', startedAt: startedAt(T0) },
  })
  bind(w, SID, CHILD)
  w.setState({ stopped: stopRecord({ at: T0 }) })
  const b = w.broker()
  assert.equal(await b.sweep.sweep(b.sx), 1)
  assert.deepEqual(w.daemon.callsOf('interrupt'), [[CHILD, 'C1']])
})

test('sweep: no daemon, no stop, a stop of another session or a stop that ended: no sweep', async (t) => {
  const w = logicWorld(t, { daemon: true })
  w.daemon.script.loaded = [SID]
  turns(w, { [SID]: { id: 'U1', status: 'inProgress', startedAt: startedAt(T0) - 60 } })
  bind(w, SID)
  const b = w.broker()
  assert.equal(await b.sweep.sweep(b.sx), 0, 'no stop')
  w.setState({ stopped: stopRecord({ sessionId: 'another' }) })
  assert.equal(await b.sweep.sweep(b.sx), 0, 'another session')
  w.setState({ stopped: stopRecord({ windowEnd: T0 }) })
  assert.equal(await b.sweep.sweep(b.sx), 0, 'the stop ended')
  w.setState({ stopped: stopRecord() })
  w.link.on = false
  assert.equal(await b.sweep.sweep(b.sx), 0, 'no daemon')
  assert.deepEqual(w.daemon.callsOf('interrupt'), [])
})

test('sweep: a stop that the CLI wrote is swept, and a later sweep (the root ticker) takes a thread that was bound late, once', async (t) => {
  const w = logicWorld(t, { daemon: true })
  w.daemon.script.loaded = [SID, CHILD]
  turns(w, {
    [SID]: { id: 'U1', status: 'inProgress', startedAt: startedAt(T0) - 60 },
    [CHILD]: { id: 'C1', status: 'inProgress', startedAt: startedAt(T0) - 60 },
  })
  bind(w, SID)
  // The CLI writes the stop in its own process, and runs the sweep there.
  w.setState({ stopped: stopRecord() })
  const cli = w.broker()
  assert.equal(await cli.sweep.sweep(cli.sx), 1)
  turns(w, {
    [SID]: { id: 'U1', status: 'interrupted', startedAt: startedAt(T0) - 60 },
    [CHILD]: { id: 'C1', status: 'inProgress', startedAt: startedAt(T0) - 60 },
  })
  await w.advance(30 * SEC)
  bind(w, CHILD)
  const root = w.broker()
  assert.equal(await root.sweep.sweep(root.sx), 1)
  assert.deepEqual(w.daemon.callsOf('interrupt'), [
    [SID, 'U1'],
    [CHILD, 'C1'],
  ])
  assert.equal(await root.sweep.sweep(root.sx), 0, 'the interrupted turns are marked')
})

test('sweep: a failed interrupt unmarks the turn so the next sweep tries again, and a timeout on an ended turn counts', async (t) => {
  const w = logicWorld(t, { daemon: true })
  w.daemon.script.loaded = [SID]
  turns(w, { [SID]: { id: 'U1', status: 'inProgress', startedAt: startedAt(T0) - 60 } })
  bind(w, SID)
  w.setState({ stopped: stopRecord() })
  const b = w.broker()
  w.daemon.script.interrupt = new DaemonError('rpc', 'turn/interrupt: thread not found', -32600)
  assert.equal(await b.sweep.sweep(b.sx), 0)
  assert.equal(w.state().interrupts, undefined)
  assert.ok(w.log.lines.includes(codexDebug.interruptFailed('turn/interrupt: thread not found')))
  w.daemon.script.interrupt = new DaemonError('timeout', 'the daemon call took longer than 8000 ms')
  let calls = 0
  w.daemon.script.newestTurn = () => (calls++ === 0 ? { id: 'U1', status: 'inProgress', startedAt: startedAt(T0) - 60 } : { id: 'U1', status: 'interrupted', startedAt: startedAt(T0) - 60 })
  assert.equal(await b.sweep.sweep(b.sx), 1)
  assert.equal(typeof w.state().interrupts?.['U1'], 'number')
})

test('sweep: a lost mark (its process died before the interrupt went out) is swept again, and a fresh mark of another process is not', async (t) => {
  const w = logicWorld(t, { daemon: true })
  w.daemon.script.loaded = [SID, CHILD]
  turns(w, {
    [SID]: { id: 'U1', status: 'inProgress', startedAt: startedAt(T0) - 60 },
    [CHILD]: { id: 'C1', status: 'inProgress', startedAt: startedAt(T0) - 60 },
  })
  bind(w, SID, CHILD)
  // U1: a mark of T0 - 30 s whose interrupt never went out. C1: another process marked it just now.
  w.setState({ stopped: stopRecord(), interrupts: { U1: T0 - 30 * SEC, C1: T0 } })
  const b = w.broker()
  assert.equal(await b.sweep.sweep(b.sx), 1)
  assert.deepEqual(w.daemon.callsOf('interrupt'), [[SID, 'U1']])
  assert.equal(w.state().interrupts?.['U1'], T0, 'the sweep takes the lost mark')
  // An interrupt of a retaken mark that fails puts the lost mark back, so CX39 still sees it and the next sweep tries again.
  w.daemon.script.interrupt = new DaemonError('rpc', 'turn/interrupt: thread not found', -32600)
  w.setState({ interrupts: { U1: T0 - 30 * SEC, C1: T0 } })
  const c = w.broker()
  assert.equal(await c.sweep.sweep(c.sx), 0)
  assert.deepEqual(w.state().interrupts, { U1: T0 - 30 * SEC, C1: T0 })
  // Once the mark of C1 is older than its lifetime, a sweep takes it too.
  w.daemon.script.interrupt = undefined
  await w.advance(INTERRUPT_MARK_MS + SEC)
  const d = w.broker()
  assert.equal(await d.sweep.sweep(d.sx), 2)
  assert.deepEqual(
    w.daemon.callsOf('interrupt').slice(-2).sort(),
    [
      [CHILD, 'C1'],
      [SID, 'U1'],
    ].sort(),
  )
})

test('sweep: under a held stop the held work stays in place, and every other running turn is swept (4.4)', async (t) => {
  const w = logicWorld(t, { daemon: true })
  w.daemon.script.loaded = [SID, CHILD]
  turns(w, {
    [SID]: { id: 'U1', status: 'inProgress', startedAt: startedAt(T0) - 60 },
    [CHILD]: { id: 'C1', status: 'inProgress', startedAt: startedAt(T0) - 30 },
  })
  bind(w, SID, CHILD)
  w.store().locked((tx) => {
    tx.thread(SID).held = [{ call: '7', site: 'tool', turn: 'U1', since: T0, brokerPid: 900, hostPid: 4000 }]
  })
  w.setState({ stopped: stopRecord(), stopMeta: { noDialog: true } })
  const b = w.broker()
  assert.equal(await b.sweep.sweep(b.sx), 1)
  assert.deepEqual(w.daemon.callsOf('interrupt'), [[CHILD, 'C1']])
  // A plain stop sweeps the held turn too (its refusal interrupts it anyway).
  w.setState({ stopMeta: undefined })
  assert.equal(await b.sweep.sweep(b.sx), 1)
  assert.deepEqual(w.daemon.callsOf('interrupt'), [
    [CHILD, 'C1'],
    [SID, 'U1'],
  ])
})
