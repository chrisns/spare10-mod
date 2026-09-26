import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { codexText, withPrefix } from '../../hooks/core/codex.ts'
import { formatConsent } from '../../hooks/core/decide.ts'
import { HEADLESS_GENERIC, NOT_STARTED_GENERIC, STOP_GENERIC } from '../../hooks/core/text.ts'
import { createGate, genericRefusal, parseGateInput } from '../src/gate.ts'
import type { GateCall } from '../src/gate.ts'
import { LockTimeout } from '../src/files.ts'
import type { SessionStore } from '../src/store.ts'
import { sessionStore } from '../src/store.ts'
import { CHILD, HOUR, MIN, SID, T0, logicWorld, rateReply } from './helpers/logic.ts'
import { parsed, world } from './helpers/world.ts'

// The gate (Codex design 4.2, 3.3, 8.2 gate.spec): each site below the reserve, the fail-open sense, the
// Luna rule, the model's own question tool, bad input, the generic refusal of a gate that throws while it
// holds, a finally that fails, a failed removal of a buried consent, the notices of the root thread, and
// the bind that merges the thread file. Gate latency is printed as a metric, never asserted.
//
// The kit port (8.2):
// Each tests/kit case and the Codex case that tests it: codex/test/kit-port.txt, kept complete by kit-port.spec.ts.

const RESET = T0 + 2 * HOUR
const SITES = ['start', 'prompt', 'tool', 'step', 'compact', 'spawn', 'stop', 'interrupt'] as const

test('gate: below the reserve every site answers "" (a pass), and the latency is printed', async (t) => {
  const w = world(t)
  const b = await w.broker({ start: false })
  w.config({})
  // The first root gate carries the start warnings (4.22): CX6 here, and CX19 once per data dir.
  assert.deepEqual(parsed(await b.gate('start'))['systemMessage'], [codexText.noDaemon(true), codexText.cliHint(w.paths.launcher, w.paths.bin)].map(withPrefix).join('\n'))
  w.reading(SID, 40, { reset: RESET })
  for (const site of SITES) {
    const at = performance.now()
    const text = await b.gate(site, site === 'prompt' ? { prompt: 'hello' } : {})
    const ms = performance.now() - at
    assert.equal(text, '', site)
    t.diagnostic(`gate ${site}: ${ms.toFixed(1)} ms`)
  }
})

test('gate: a sense failure passes (the sensor fails open)', async (t) => {
  const w = world(t)
  const b = await w.broker()
  await b.gate('start')
  w.reading(SID, 95, { reset: RESET })
  writeFileSync(w.file('state.json'), '{ not json')
  assert.equal(await b.gate('tool'), '')
  assert.equal(await b.gate('step'), '')
  assert.equal(await b.gate('stop'), '')
  assert.equal(await b.gate('prompt', { prompt: 'hello' }), '')
  assert.equal(b.forms().length, 0)
})

test('gate: the Luna model passes while the live read says allowed false, and holds while allowed true and tripped (A7)', async (t) => {
  const w = world(t)
  const b = await w.broker({ model: 'gpt-reserve' })
  w.live(rateReply({ five: 95, fiveReset: RESET, allowed: false }))
  // A fresh live read with allowed false: every site passes, and no form shows.
  for (const site of ['tool', 'step', 'stop'] as const) assert.equal(await b.gate(site), '', site)
  assert.equal(await b.gate('prompt', { prompt: 'hello' }), '')
  assert.equal(b.forms().length, 0)
  // A command still runs.
  assert.match(parsed(await b.gate('prompt', { prompt: 'spare10' }))['reason'] as string, /^spare10: version /)
  // allowed true and tripped: the step is not Codex's own fallback, so it holds and asks.
  w.live(rateReply({ five: 95, fiveReset: RESET, allowed: true }))
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false)
  assert.equal(b.forms().length, 1)
  b.host.answer({ action: 'accept', content: { choice: 'resume' } })
  await w.settle()
  assert.equal(h.box.done, true)
})

test('gate: the Luna model passes with no live read younger than 60 s (A7)', async (t) => {
  const w = world(t)
  const b = await w.broker({ model: 'GPT-Reserve' })
  w.reading(SID, 97, { reset: RESET })
  assert.equal(await b.gate('tool'), '')
  assert.equal(b.forms().length, 0)
})

test('gate: request_user_input passes while tripped, and the step after it is gated', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 95, { reset: RESET })
  assert.equal(await b.gate('tool', { tool: 'request_user_input' }), '')
  assert.equal(b.forms().length, 0)
  const h = b.call('step', { tool: 'request_user_input' })
  await w.settle()
  assert.equal(h.box.done, false)
  assert.equal(b.forms().length, 1)
})

test('gate: an unknown site and bad input pass, with a debug line', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 95, { reset: RESET })
  const text = await b.host.gate({ site: 'nope', session: SID, transcript: null, model: 'm', cwd: '/' }, SID)
  assert.equal(text, '')
  assert.equal(await b.host.gate({ site: 'tool' }, SID), '')
  assert.equal(await b.host.gate('not an object', SID), '')
  assert.ok(w.log.lines.some((l) => l === codexText.statusHold || /the gate input is not valid/.test(l)))
  assert.equal(parseGateInput({ site: 'tool', session: SID, transcript: 5, turn: 7, active: 'yes', model: 'm', cwd: '/' })?.transcript, null)
  assert.deepEqual(parseGateInput({ site: 'stop', session: SID, transcript: '/r', active: true, model: 'm', cwd: '/', turn: 'U' }), {
    site: 'stop',
    session: SID,
    transcript: '/r',
    model: 'm',
    cwd: '/',
    turn: 'U',
    active: true,
  })
})

test('gate: the generic refusal of each site', () => {
  assert.deepEqual(genericRefusal('prompt', true), { kind: 'block', text: NOT_STARTED_GENERIC })
  assert.deepEqual(genericRefusal('prompt', false), { kind: 'block', text: HEADLESS_GENERIC })
  assert.deepEqual(genericRefusal('tool', true), { kind: 'deny', text: STOP_GENERIC })
  assert.deepEqual(genericRefusal('step', false), { kind: 'deny', text: HEADLESS_GENERIC })
  assert.deepEqual(genericRefusal('stop', true), { kind: 'end' })
  assert.deepEqual(genericRefusal('interrupt', true), { kind: 'pass' })
})

test('gate: a gate that throws while it holds answers the generic refusal (fail closed)', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 95, { reset: RESET })
  // A question file of another format: the open or join throws after the call holds.
  mkdirSync(w.file(''), { recursive: true })
  writeFileSync(w.file('question.json'), JSON.stringify({ v: 99 }))
  const text = await b.gate('tool')
  assert.deepEqual(parsed(text), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: STOP_GENERIC } })
  const prompt = await b.gate('prompt', { prompt: 'hello' })
  assert.deepEqual(parsed(prompt), { decision: 'block', reason: NOT_STARTED_GENERIC })
  assert.ok(w.log.lines.some((l) => l.startsWith('spare10: the gate failed:')))
})

/** A gate over the logic world, with a session store whose locks can fail: all of them, or only a lock that removes the 5-hour consent. */
function faultyGate(t: Parameters<typeof logicWorld>[0], o: { daemon?: boolean } = {}) {
  const w = logicWorld(t, o)
  const b = w.broker()
  void b.quota.live(30_000) // the first read of this broker: none, so the first gate waits for nothing
  const fail = { all: false, consentRemoval: false }
  const timeout = (s: SessionStore): LockTimeout => new LockTimeout(`${s.dir}/state.lock`, { owner: 'other', pid: 1, at: Date.now() })
  const wrap = (s: SessionStore): SessionStore => ({
    ...s,
    locked(fn) {
      if (fail.all) throw timeout(s)
      return s.locked((tx) => {
        const before = tx.state.consent
        const out = fn(tx)
        // A throw inside the lock writes nothing, as a lock that timed out.
        if (fail.consentRemoval && before !== undefined && tx.state.consent === undefined) throw timeout(s)
        return out
      })
    },
    takeNotices(now) {
      if (fail.all && (s.read().notices ?? []).length > 0) throw timeout(s)
      return s.takeNotices(now)
    },
  })
  const stores = new Map<string, SessionStore>()
  const calls: GateCall[] = []
  const decided: { hook?: () => void } = {}
  const gate = createGate({
    paths: w.paths,
    clock: w.clock,
    log: w.log,
    owner: b.owner,
    pid: b.pid,
    env: {},
    hostPid: 4000,
    hostKind: 'tui',
    settings: b.settings,
    quota: b.quota,
    sense: b.sense,
    attendance: { attended: () => ({ attended: true }) },
    questions: b.questions,
    refusal: {
      refusal: async (...args) => {
        const r = await b.refusal.refusal(...args)
        decided.hook?.()
        return r
      },
    },
    commands: { run: async () => 'reply' },
    ticker: { start() {} },
    daemon: b.daemonLink,
    pidAlive: (p) => w.alive.has(p),
    storeOf: (sid) => {
      let s = stores.get(sid)
      if (s === undefined) {
        s = wrap(sessionStore(w.paths, sid, b.owner, w.wake, { clock: w.clock, hostPid: 4000 }))
        stores.set(sid, s)
      }
      return s
    },
    liveCalls: () => calls,
    dropTurn: () => 0,
  })
  const newCall = (id: number, site: 'tool' | 'step' = 'tool'): GateCall => {
    const ac = new AbortController()
    const c: GateCall = { id, site, turn: 'U1', since: w.clock.now(), dropped: ac.signal, drop: () => ac.abort(), holding: false }
    calls.push(c)
    return c
  }
  const args = (site: string) => ({ site, session: SID, turn: 'U1', transcript: w.rollout(SID).path, mode: 'default', model: 'gpt-5.5', cwd: '/tmp' })
  return { w, b, gate, fail, decided, newCall, args }
}

test('gate: a LockTimeout in the finally keeps the decided refusal', async (t) => {
  const { w, gate, fail, decided, newCall, args } = faultyGate(t)
  w.reading(SID, 95, { reset: RESET })
  const call = newCall(1)
  call.holding = true
  decided.hook = () => {
    fail.all = true
  }
  // A stop in force: the refusal of a held tool call. Not hosted, Continue at the reset off: one deny.
  w.config({ autoResume: false })
  w.setState({ stopped: `${SID} ${RESET - 20 * MIN} ${T0} five_hour,work` })
  w.setState({ notices: [{ at: T0, text: 'a queued line' }] })
  const text = await gate(args('tool'), { threadId: SID }, call)
  const out = parsed(text)
  assert.equal((out['hookSpecificOutput'] as Record<string, unknown>)['permissionDecision'], 'deny')
  assert.match((out['hookSpecificOutput'] as Record<string, unknown>)['permissionDecisionReason'] as string, /^spare10: the user stopped work at the quota reserve/)
  assert.equal(out['systemMessage'], undefined, 'the notices could not be taken, and the answer stands')
  assert.ok(w.log.lines.some((l) => /could not read the queued lines/.test(l) || /could not write the held entry/.test(l)))
})

test('gate: a LockTimeout in the removal of a voided consent at a trip still holds and asks', async (t) => {
  const { w, b, gate, fail, newCall, args } = faultyGate(t)
  // A22: a real consent of an earlier window (its until is far before the current reset) is void.
  w.setState({ consent: formatConsent(SID, T0 - 3 * HOUR) })
  w.reading(SID, 92, { reset: RESET })
  await gate(args('start'), { threadId: SID }, newCall(1))
  fail.consentRemoval = true // the removal of the dead consent in the split times out
  const call = newCall(2)
  const p = gate(args('tool'), { threadId: SID }, call)
  await w.settle()
  assert.equal(b.mcp.requests.length, 1, 'the call holds and asks')
  assert.equal(w.state().consent, formatConsent(SID, T0 - 3 * HOUR), 'the dead value stays on disk')
  b.mcp.answer('resume')
  assert.match(parsed(await p)['systemMessage'] as string, /^spare10: continuing on your 10% reserve/)
})

test('gate: transcript lines ride only the answers of the root thread, each with its prefix', async (t) => {
  const w = world(t)
  const root = await w.broker()
  const child = await w.broker({ thread: CHILD })
  w.setState({ notices: [{ at: T0, text: 'first line' }, { at: T0, text: 'second line' }] })
  assert.equal(await child.gate('tool'), '')
  assert.deepEqual(w.notices(), ['first line', 'second line'])
  assert.deepEqual(parsed(await root.gate('interrupt')), { systemMessage: `${withPrefix('first line')}\n${withPrefix('second line')}` })
  assert.deepEqual(w.notices(), [])
  // A line older than 30 min is dropped.
  w.setState({ notices: [{ at: T0 - 31 * MIN, text: 'old' }] })
  assert.equal(await root.gate('tool'), '')
})

test('gate: bind merges the thread file, keeps the held entries of live brokers and removes those of dead ones', async (t) => {
  const w = world(t)
  const b = await w.broker({ pid: 700 })
  w.alive.add(701)
  w.store().locked((tx) => {
    const th = tx.thread(SID)
    th.held = [
      { call: 'c-live', site: 'tool', turn: 'U0', since: T0, brokerPid: 701, hostPid: 4000 },
      { call: 'c-dead', site: 'tool', turn: 'U0', since: T0, brokerPid: 702, hostPid: 4000 },
      { call: 'c-mine-stale', site: 'tool', turn: 'U0', since: T0, brokerPid: 700, hostPid: 4000 },
    ]
    tx.thread(CHILD).held = [{ call: 'c-child-dead', site: 'step', turn: 'U9', since: T0, brokerPid: 703, hostPid: 4000 }]
  })
  assert.equal(await b.gate('tool'), '')
  const th = w.thread(SID)
  assert.equal(th?.brokerPid, 700)
  assert.equal(th?.hostPid, 4000)
  assert.equal(th?.transcript, b.transcript)
  assert.deepEqual(
    th?.held.map((e) => e.call),
    ['c-live'],
  )
  assert.deepEqual(w.thread(CHILD)?.held, [], 'a root gate cleans every thread of the session')
})

test('gate: the first root gate shows the start warnings once per session: CX7, CX8, CX11, CX42, CX43, and CX19 once per data dir', async (t) => {
  const w = world(t, { daemon: true, config: { autoResume: false, reserve: 150 } })
  const b = await w.broker({ start: false, hostKind: 'daemon', originator: 'gap7-remote-client', source: 'vscode', mode: 'bypassPermissions' })
  const lines = (parsed(await b.gate('start'))['systemMessage'] as string).split('\n')
  assert.deepEqual(lines, [
    withPrefix(codexText.configBad(join(w.data, 'config.json'), 'reserve', 150, '1 to 99', '10')),
    withPrefix(codexText.noDaemon(false)),
    withPrefix(codexText.approvalNever),
    withPrefix(codexText.originator('gap7-remote-client')),
    withPrefix(codexText.cliHint(w.paths.launcher, w.paths.bin)),
  ])
  assert.equal(w.state().attended, true)
  assert.equal(w.state().hostKind, 'daemon')
  assert.equal(w.state().child, 'stop', 'B37: the child policy of nested runs')
  // A new broker of the same session (a restart) shows none of them again.
  const again = await w.broker({ start: false, hostKind: 'daemon', originator: 'gap7-remote-client', source: 'vscode', mode: 'bypassPermissions' })
  assert.equal(await again.gate('start'), '')
  // Scope opt-in on the daemon with no SPARE10: CX42, in another session.
  const v = world(t, { config: { scope: 'opt-in' } })
  const c = await v.broker({ start: false, hostKind: 'daemon' })
  assert.equal(parsed(await c.gate('start'))['systemMessage'], `${withPrefix(codexText.optInDaemon)}\n${withPrefix(codexText.cliHint(v.paths.launcher, v.paths.bin))}`)
})

// Q1: a thread with no rollout (TUI /side, codex exec --ephemeral, an ephemeral app-server thread) has no
// reading of its own that grows as it spends. On the daemon, each of its tool, step and prompt gates reads
// the daemon (live 15 s), so it trips on the account's reading and not on the one from its start.
test('gate: a thread with no rollout on the daemon trips on a fresh daemon read at a tool gate, not on the start read', async (t) => {
  const w = world(t, { daemon: true })
  w.daemon.script.rateLimits = rateReply({ five: 80, fiveReset: RESET })
  const b = await w.broker({ transcript: null, hosted: true })
  w.daemon.script.rateLimits = rateReply({ five: 97, fiveReset: RESET })
  await w.advance(5 * MIN)
  const before = w.daemon.callsOf('rateLimits').length
  b.script('hang')
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false, 'the tool holds')
  assert.equal(b.forms().length, 1, 'and asks')
  assert.equal(w.daemon.callsOf('rateLimits').length, before + 1, 'one fresh read')
})

test('gate: a thread with no rollout on the daemon asks at a prompt on a fresh daemon read', async (t) => {
  const w = world(t, { daemon: true })
  w.daemon.script.rateLimits = rateReply({ five: 80, fiveReset: RESET })
  const b = await w.broker({ transcript: null, hosted: true })
  w.daemon.script.rateLimits = rateReply({ five: 97, fiveReset: RESET })
  await w.advance(5 * MIN)
  b.script('hang')
  const h = b.call('prompt', { prompt: 'hello' })
  await w.settle()
  assert.equal(h.box.done, false, 'the prompt holds')
  assert.equal(b.forms().length, 1, 'and asks')
})

test('gate: an ephemeral codex exec with SPARE10_HEADLESS=stop is denied on a fresh daemon read', async (t) => {
  const w = world(t, { daemon: true })
  w.daemon.script.rateLimits = rateReply({ five: 80, fiveReset: RESET })
  const b = await w.broker({ hostKind: 'exec', originator: 'codex_exec', source: 'exec', transcript: null, env: { SPARE10_HEADLESS: 'stop' } })
  w.daemon.script.rateLimits = rateReply({ five: 97, fiveReset: RESET })
  await w.advance(10 * MIN)
  const out = parsed(await b.gate('tool'))
  assert.equal((out['hookSpecificOutput'] as Record<string, unknown>)['permissionDecision'], 'deny')
})

test('gate: the first root gate writes the child policy of codex exec children only in a guarded attended session (B37)', async (t) => {
  const childOf = async (o: { config?: Record<string, unknown>; broker?: Parameters<ReturnType<typeof world>['broker']>[0] }): Promise<string | undefined> => {
    const w = world(t, o.config === undefined ? {} : { config: o.config })
    await w.broker(o.broker ?? {})
    return w.state().child
  }
  assert.equal(await childOf({}), 'stop', 'guarded, policy off: children stop')
  assert.equal(await childOf({ config: { headless: 'wait' } }), 'stop', 'guarded, policy wait: children stop')
  assert.equal(await childOf({ config: { headless: 'prompt' } }), undefined, 'guarded, policy prompt: children follow their own')
  assert.equal(await childOf({ broker: { env: { SPARE10_HEADLESS: 'off' } } }), undefined, 'a set SPARE10_HEADLESS reaches the children itself')
  assert.equal(await childOf({ broker: { hostKind: 'exec', originator: 'codex_exec', source: 'exec' } }), undefined, 'an unattended root sets nothing')
  assert.equal(await childOf({ config: { scope: 'opt-in' } }), undefined, 'a root that is switched off sets nothing')
})

test('gate: a sense that fails in the round after a question ended with no answer refuses the call (fail closed)', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  b.script('hang')
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false)
  // The question ends with no answer (the waiter decides again), and the next sense fails.
  writeFileSync(w.file('state.json'), '{ not json')
  rmSync(w.file('question.json'))
  await w.advance(31_000)
  assert.equal(h.box.done, true)
  const out = parsed(h.box.text)['hookSpecificOutput'] as Record<string, unknown>
  assert.equal(out['permissionDecision'], 'deny', 'never a pass')
})
