import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { formatConsent, formatStopped } from '../../hooks/core/decide.ts'
import { factsFrom, namedKinds } from '../../hooks/core/flow.ts'
import { debugLine, notice } from '../../hooks/core/text.ts'
import { CHILD, HOST_PID, HOUR, MIN, SID, T0, logicWorld, rateReply } from './helpers/logic.ts'

// The sense and the decision (Codex design 4.1, 7.2 sense.ts): the gate half of the quota rows of 3.6, the
// consents of state.json (the Codex form of the env values), the early-reset void (A22), the floor end
// (B52), the test reading (4.18), credits (A23), the present kinds (4.15) and attendance (3.10).
//
// The kit port (8.2). Glue that only Claude has (the badge redraw, the engine fork G8, $.session.surfaces)
// has no Codex form.
// Each tests/kit case and the Codex case that tests it: codex/test/kit-port.txt, kept complete by kit-port.spec.ts.

const RESET = T0 + 2 * HOUR

test('sense: below the reserve nothing trips and the verdict passes', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  w.reading(SID, 50, { reset: RESET })
  const s = await b.sense.sense(b.sx, 'tool')
  assert.equal(s.tripped, false)
  assert.equal(s.attended, true)
  assert.deepEqual(s.present, ['five_hour', 'seven_day'])
  assert.deepEqual(
    s.kinds.map((k) => [k.kind, k.basis.kind, k.tripped]),
    [
      ['five_hour', 'live', false],
      ['seven_day', 'none', false],
    ],
  )
  const a = await b.sense.act(b.sx, s, { site: 'tool' })
  assert.deepEqual(a.verdict, { kind: 'pass', trip: false })
  assert.deepEqual(w.state().notices, undefined)
})

test('sense: at the reserve an attended loop holds, a person prompt holds, and the kind gates with its reset', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  w.reading(SID, 92, { reset: RESET })
  const s = await b.sense.sense(b.sx, 'tool')
  assert.equal(s.tripped, true)
  const five = s.kinds[0]
  assert.equal(five?.kind, 'five_hour')
  assert.equal(five?.tripped, true)
  assert.equal(five?.windowEnd, RESET)
  assert.equal(five?.skipAt, RESET - 20 * MIN)
  assert.equal(five?.point, 95)
  for (const site of ['tool', 'step'] as const) {
    const a = await b.sense.act(b.sx, s, { site })
    assert.deepEqual(a.verdict, { kind: 'hold' })
    assert.deepEqual(
      a.gating.map((k) => k.kind),
      ['five_hour'],
    )
    assert.deepEqual(a.holders, [{ kind: 'five_hour', resetsAtMs: RESET }])
  }
  assert.deepEqual((await b.sense.act(b.sx, s, { site: 'prompt', person: true })).verdict, { kind: 'hold' })
  assert.deepEqual((await b.sense.act(b.sx, s, { site: 'prompt' })).verdict, { kind: 'pass', trip: true })
})

test('sense: a state.json that does not parse makes sense throw (the gate fails open)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  w.reading(SID, 92, { reset: RESET })
  mkdirSync(dirname(w.file('state.json')), { recursive: true })
  writeFileSync(w.file('state.json'), '{"v":1,')
  await assert.rejects(b.sense.sense(b.sx, 'tool'))
})

test('sense: near a trip point the tool and step gates read the daemon first, other sites do not (A19)', async (t) => {
  const w = logicWorld(t, { daemon: true })
  const b = w.broker()
  w.reading(SID, 86, { reset: RESET, at: T0 - MIN })
  w.daemon.script.rateLimits = rateReply({ five: 91, fiveReset: RESET })
  const p = await b.sense.sense(b.sx, 'prompt')
  assert.equal(w.daemon.callsOf('rateLimits').length, 0)
  assert.equal(p.tripped, false)
  const s = await b.sense.sense(b.sx, 'tool')
  assert.equal(w.daemon.callsOf('rateLimits').length, 1)
  assert.equal(s.tripped, true, 'the live read at 91% trips before the rollout shows it')
  assert.equal(s.kinds[0]?.basis.kind, 'live')
})

test('sense: far from a trip point no gate reads the daemon', async (t) => {
  const w = logicWorld(t, { daemon: true })
  const b = w.broker()
  w.reading(SID, 80, { reset: RESET })
  await b.sense.sense(b.sx, 'tool')
  await b.sense.sense(b.sx, 'step')
  assert.equal(w.daemon.callsOf('rateLimits').length, 0)
})

test('sense: a consent of this session covers the window, and the verdict passes inside the reserve', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  w.reading(SID, 92, { reset: RESET })
  w.setState({ consent: formatConsent(SID, RESET) })
  const s = await b.sense.sense(b.sx, 'tool')
  const split = b.sense.split(b.sx, s)
  assert.deepEqual(split.gating, [])
  assert.deepEqual(
    split.consented.map((x) => [x.k.kind, x.c]),
    [['five_hour', { until: RESET }]],
  )
  assert.deepEqual((await b.sense.act(b.sx, s, { site: 'tool' })).verdict, { kind: 'pass', trip: true })
})

test('sense: a consent value that is not the Claude format is no consent, so the kind holds and asks (fail closed)', async (t) => {
  const iso = new Date(RESET).toISOString()
  const later = new Date(RESET + 6 * HOUR).toISOString()
  for (const [name, raw] of [
    ['a junk end point', `${SID} ${iso} to:abc`],
    ['an end point of 0', `${SID} ${iso} to:0`],
    ['an end point of 100', `${SID} ${iso} to:100`],
    ['an end point with two decimals', `${SID} ${iso} to:95.55`],
    ['an empty end point', `${SID} ${iso} to:`],
    ['a third token that is not an end point', `${SID} ${iso} until:95`],
    ['a fourth token', `${SID} ${iso} to:95 x`],
    ['an end point after a bare time', `${iso} to:95`],
    ['a time after this window', `${SID} ${later} to:95`],
  ] as const) {
    const w = logicWorld(t)
    const b = w.broker()
    w.reading(SID, 92, { reset: RESET })
    w.setState({ consent: raw })
    const s = await b.sense.sense(b.sx, 'tool')
    assert.deepEqual((await b.sense.act(b.sx, s, { site: 'tool' })).verdict, { kind: 'hold' }, name)
  }
  // A full value with no end point is a full consent: it covers the window past the floor.
  const w = logicWorld(t)
  const b = w.broker()
  w.reading(SID, 97, { reset: RESET })
  w.setState({ consent: `${SID} ${iso}` })
  const s = await b.sense.sense(b.sx, 'tool')
  assert.deepEqual((await b.sense.act(b.sx, s, { site: 'tool' })).verdict, { kind: 'pass', trip: true })
})

test('sense: a consent of another session does not count for an attended session', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  w.reading(SID, 92, { reset: RESET })
  w.setState({ consent: formatConsent('another-session', RESET) })
  const s = await b.sense.sense(b.sx, 'tool')
  assert.deepEqual((await b.sense.act(b.sx, s, { site: 'tool' })).verdict, { kind: 'hold' })
  assert.equal(w.state().consent, formatConsent('another-session', RESET), 'not dead, only not ours: it stays')
})

test('sense: a nested unattended run takes its parent session consent, an attended one does not (3.10)', async (t) => {
  const w = logicWorld(t)
  const NESTED = '01a0da08-0000-7000-8000-0000000000e1'
  w.setState({ consent: formatConsent(SID, RESET) }, SID)
  const exec = w.broker({ sid: NESTED, hostKind: 'exec', parent: SID, env: { SPARE10_HEADLESS: 'stop' }, originator: 'codex_exec', source: 'exec' })
  w.reading(NESTED, 92, { reset: RESET })
  const s = await exec.sense.sense(exec.sx, 'tool')
  assert.equal(s.attended, false)
  assert.deepEqual((await exec.sense.act(exec.sx, s, { site: 'tool' })).verdict, { kind: 'pass', trip: true })
  const ATTENDED = '01a0da08-0000-7000-8000-0000000000e2'
  const tui = w.broker({ sid: ATTENDED, parent: SID })
  w.reading(ATTENDED, 92, { reset: RESET })
  const s2 = await tui.sense.sense(tui.sx, 'tool')
  assert.equal(s2.attended, true)
  assert.deepEqual((await tui.sense.act(tui.sx, s2, { site: 'tool' })).verdict, { kind: 'hold' })
})

test('sense: a consent that an early reset voids is no consent, and it goes from state.json (A22)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  // The consent of the old window ends at T0 + 30 min. A reset credit started a new window that ends at RESET.
  const old = formatConsent(SID, T0 + 30 * MIN)
  w.setState({ consent: old })
  w.reading(SID, 92, { reset: RESET })
  const s = await b.sense.sense(b.sx, 'tool')
  assert.deepEqual((await b.sense.act(b.sx, s, { site: 'tool' })).verdict, { kind: 'hold' })
  assert.equal(w.state().consent, undefined)
})

test('sense: a consent whose end jitters by 30 s from the reset is the same window and counts (A22)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  w.setState({ consent: formatConsent(SID, RESET - 30_000) })
  w.reading(SID, 92, { reset: RESET })
  const s = await b.sense.sense(b.sx, 'tool')
  assert.deepEqual((await b.sense.act(b.sx, s, { site: 'tool' })).verdict, { kind: 'pass', trip: true })
})

test('sense: a consent to the floor lets work through below its point, and ends for good at it (B52)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const toFloor = formatConsent(SID, RESET, 95)
  w.setState({ consent: toFloor })
  w.reading(SID, 92, { reset: RESET })
  const s = await b.sense.sense(b.sx, 'tool')
  assert.deepEqual((await b.sense.act(b.sx, s, { site: 'tool' })).verdict, { kind: 'pass', trip: true })
  assert.equal(w.state().consent, toFloor)
  w.reading(SID, 96, { reset: RESET })
  const at = await b.sense.sense(b.sx, 'tool')
  assert.equal(at.kinds[0]?.atFloor, true)
  assert.deepEqual((await b.sense.act(b.sx, at, { site: 'tool' })).verdict, { kind: 'hold' })
  assert.equal(w.state().consent, undefined)
  assert.deepEqual(w.state().tombs, { five_hour: [{ until: RESET, to: 95 }] })
  // A late write of the ended consent (the same until and end point) is buried: no consent, and it goes.
  w.setState({ consent: toFloor })
  w.reading(SID, 93, { reset: RESET })
  const fell = await b.sense.sense(b.sx, 'tool')
  assert.deepEqual((await b.sense.act(b.sx, fell, { site: 'tool' })).verdict, { kind: 'hold' })
  assert.equal(w.state().consent, undefined)
})

test('sense: a test reading counts only for the host of its test (3.7)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  w.setState({ test: { hostPid: HOST_PID, kinds: { five_hour: { pct: 93, resetsAtMs: T0 + HOUR } }, consent: {} } })
  const s = await b.sense.sense(b.sx, 'tool')
  assert.equal(s.tripped, true)
  assert.equal(s.kinds[0]?.test, true)
  assert.equal(s.kinds[0]?.basis.kind, 'test')
  const other = w.broker({ hostPid: HOST_PID + 1 })
  const s2 = await other.sense.sense(other.sx, 'tool')
  assert.equal(s2.tripped, false)
})

test('sense: SPARE10_SIMULATE sets the test reading once per session, at a root gate (4.18)', async (t) => {
  const w = logicWorld(t)
  const child = w.broker({ thread: CHILD, env: { SPARE10_SIMULATE: '92 in 20m' } })
  const c = await child.sense.sense(child.sx, 'tool')
  assert.equal(c.tripped, false, 'a subagent does not read it')
  assert.equal(w.state().test, undefined)
  const root = w.broker({ env: { SPARE10_SIMULATE: '92 in 20m' } })
  const s = await root.sense.sense(root.sx, 'start')
  assert.equal(s.tripped, true)
  assert.deepEqual(w.state().test, { hostPid: HOST_PID, kinds: { five_hour: { pct: 92, resetsAtMs: T0 + 20 * MIN } }, consent: {}, envDone: true })
  await w.advance(MIN)
  await root.sense.sense(root.sx, 'tool')
  assert.equal(w.state().test?.kinds.five_hour?.resetsAtMs, T0 + 20 * MIN, 'in counts from the first gate, once')
})

test('sense: a kind at 100% with usable credits is never open, and without credits it is (A23)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const soon = T0 + 10 * MIN // inside the last 20 min
  w.reading(SID, 100, { reset: soon, credits: { has_credits: true, unlimited: false, balance: '42' } })
  const s = await b.sense.sense(b.sx, 'tool')
  assert.equal(s.creditsUsable, true)
  assert.equal(s.credits?.balance, '42')
  assert.equal(s.kinds[0]?.open, false)
  assert.deepEqual((await b.sense.act(b.sx, s, { site: 'tool' })).verdict, { kind: 'hold' })
  w.reading(SID, 100, { reset: soon, credits: { has_credits: false, unlimited: false, balance: '0' } })
  const s2 = await b.sense.sense(b.sx, 'tool')
  assert.equal(s2.creditsUsable, false)
  assert.equal(s2.kinds[0]?.open, true)
  assert.deepEqual((await b.sense.act(b.sx, s2, { site: 'tool' })).verdict, { kind: 'pass', trip: true })
})

test('sense: two observations with no 5-hour window make it absent, and a test reading makes it present again (4.15)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const weekReset = T0 + 3 * 24 * HOUR
  w.reading(SID, 61, { kind: 'seven_day', reset: weekReset, at: T0 - 2 * MIN })
  await b.sense.sense(b.sx, 'tool')
  w.reading(SID, 61, { kind: 'seven_day', reset: weekReset, at: T0 - MIN })
  const s = await b.sense.sense(b.sx, 'tool')
  assert.deepEqual(s.present, ['seven_day'])
  assert.deepEqual(
    s.kinds.map((k) => k.kind),
    ['seven_day'],
  )
  w.setState({ test: { hostPid: HOST_PID, kinds: { five_hour: { pct: 92, resetsAtMs: T0 + HOUR } }, consent: {} } })
  const t2 = await b.sense.sense(b.sx, 'tool')
  assert.deepEqual(t2.present, ['five_hour', 'seven_day'])
  assert.equal(t2.kinds[0]?.tripped, true)
})

test('sense: an unattended run has no floor, passes with policy off, and logs its debug line once per window (B15, B55)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker({ hostKind: 'exec', originator: 'codex_exec', source: 'exec' })
  w.reading(SID, 96, { reset: RESET })
  const s = await b.sense.sense(b.sx, 'tool')
  assert.equal(s.attended, false)
  assert.equal(s.kinds[0]?.floor, 0)
  assert.equal(s.kinds[0]?.atFloor, false)
  assert.deepEqual((await b.sense.act(b.sx, s, { site: 'tool' })).verdict, { kind: 'pass', trip: true })
  await b.sense.act(b.sx, s, { site: 'step' })
  const line = debugLine.unattended(factsFrom([s.kinds[0]!], s.now), 'off')
  assert.deepEqual(
    w.log.lines.filter((l) => l.startsWith('spare10: unattended')),
    [line],
  )
  assert.deepEqual(w.state().unattendedNote, { five_hour: RESET, seven_day: 0 })
})

test('sense: an unattended run with policy stop refuses a tool and a step, and lets a prompt through', async (t) => {
  const w = logicWorld(t)
  const b = w.broker({ hostKind: 'exec', env: { SPARE10_HEADLESS: 'stop' }, originator: 'codex_exec', source: 'exec' })
  w.reading(SID, 92, { reset: RESET })
  const s = await b.sense.sense(b.sx, 'tool')
  assert.deepEqual((await b.sense.act(b.sx, s, { site: 'tool' })).verdict, { kind: 'refuse', text: 'headless' })
  assert.deepEqual((await b.sense.act(b.sx, s, { site: 'step' })).verdict, { kind: 'refuse', text: 'headless' })
  assert.deepEqual((await b.sense.act(b.sx, s, { site: 'prompt' })).verdict, { kind: 'pass', trip: true })
})

test('sense: a stop in force refuses a tool with stop and a step with paused, and a person prompt holds', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  w.reading(SID, 92, { reset: RESET })
  w.setState({ stopped: formatStopped({ sessionId: SID, windowEnd: RESET, at: T0, kinds: ['five_hour'], auto: true }) })
  const s = await b.sense.sense(b.sx, 'tool')
  const tool = await b.sense.act(b.sx, s, { site: 'tool' })
  assert.deepEqual(tool.verdict, { kind: 'refuse', text: 'stop' })
  assert.equal(tool.stopped, true)
  assert.deepEqual((await b.sense.act(b.sx, s, { site: 'step' })).verdict, { kind: 'refuse', text: 'paused' })
  assert.deepEqual((await b.sense.act(b.sx, s, { site: 'prompt', person: true })).verdict, { kind: 'hold' })
  // A stop of another session never applies here.
  w.setState({ stopped: formatStopped({ sessionId: 'another', windowEnd: RESET, at: T0, kinds: ['five_hour'], auto: true }) })
  assert.deepEqual((await b.sense.act(b.sx, s, { site: 'tool' })).verdict, { kind: 'hold' })
})

test('sense: claimTold tells a loop once per stage, and queues notice.told once per window (B51)', async (t) => {
  const w = logicWorld(t, { config: { pausePrompt: 'Finish the step, then stop.' } })
  const b = w.broker()
  w.reading(SID, 92, { reset: RESET })
  const s = await b.sense.sense(b.sx, 'tool')
  const a = await b.sense.act(b.sx, s, { site: 'tool' })
  assert.deepEqual(a.verdict, { kind: 'tell' })
  assert.equal(b.sense.claimTold(b.sx, s, a, `${SID}:main`), true)
  assert.equal(b.sense.claimTold(b.sx, s, a, `${SID}:main`), false)
  assert.equal(b.sense.claimTold(b.sx, s, a, `${SID}:${CHILD}`), true)
  assert.deepEqual(
    (w.state().notices ?? []).map((n) => n.text),
    [notice.told(factsFrom(namedKinds(s, a), s.now))],
  )
  assert.deepEqual(w.state().told, { five_hour: { windowEnd: RESET, keys: [`${SID}:main`, `${SID}:${CHILD}`] } })
  assert.ok(w.log.lines.includes(debugLine.told(`${SID}:main`)))
  // The main loop is told now, so a person prompt no longer asks in tell mode.
  assert.deepEqual((await b.sense.act(b.sx, s, { site: 'prompt', person: true })).verdict, { kind: 'pass', trip: true })
})

test('sense: resetTooRecent holds a release inside the 5-minute margin after a real reset in the reserve (4.8)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  w.reading(SID, 92, { reset: T0 + MIN })
  await b.sense.sense(b.sx, 'tool')
  await w.advance(2 * MIN)
  const s = await b.sense.sense(b.sx, 'tool')
  assert.equal(s.tripped, false, 'the window reset')
  assert.equal(b.sense.resetTooRecent(b.sx, s), true)
  await w.advance(5 * MIN)
  const later = await b.sense.sense(b.sx, 'tool')
  assert.equal(b.sense.resetTooRecent(b.sx, later), false)
})

test('sense: a test window that opens over a real trip does not open the kind: the real reading holds it (B45)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  w.reading(SID, 92, { reset: RESET })
  w.setState({ test: { hostPid: HOST_PID, kinds: { five_hour: { pct: 93, resetsAtMs: T0 + 10 * MIN } }, consent: {} } })
  const s = await b.sense.sense(b.sx, 'tool')
  const five = s.kinds[0]
  assert.equal(five?.open, false)
  assert.equal(five?.basis.kind, 'live')
  assert.equal(five?.realIn, true)
  assert.deepEqual((await b.sense.act(b.sx, s, { site: 'tool' })).verdict, { kind: 'hold' })
})
