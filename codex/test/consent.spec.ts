import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatConsent } from '../../hooks/core/decide.ts'
import type { KindSense } from '../../hooks/core/flow.ts'
import { clearConsent, consentField, consentsIn, consentsOf, endFloors, removeDead, writeConsent } from '../src/consent.ts'
import { freshState } from '../src/store.ts'
import type { SessionState } from '../src/store.ts'
import { HOST_PID, HOUR, MIN, SID, T0, logicWorld } from './helpers/logic.ts'

// Consent on Codex (Codex design 3.7, 4.1, 4.8, 7.2 consent.ts): the Claude env values as fields of
// state.json, written in one lock. The floor tiers (B49), the tombs (B52), the test consents (3.5), the
// early-reset void (A22) and the parent consent of a nested run (3.10).
//
// The kit port (8.2). The compare-and-set races of the env (restamp, late writes, unset if same) have no
// Codex form: each write runs in the session lock.
// Each tests/kit case and the Codex case that tests it: codex/test/kit-port.txt, kept complete by kit-port.spec.ts.

const RESET = T0 + 2 * HOUR

const state = (fields: Partial<SessionState> = {}): SessionState => ({ ...freshState(SID), ...fields })

/** A tripped kind at `pct`, with the floor of 5 (point 95), whose view is its real reading. */
function kind(pct: number, o: Partial<KindSense> = {}): KindSense {
  return {
    kind: 'five_hour',
    reserve: 10,
    basis: { kind: 'live', pct, resetsAtMs: RESET },
    tripped: pct >= 90,
    windowEnd: RESET,
    holdEnd: RESET,
    stopEnd: RESET - 20 * MIN,
    span: 20 * MIN,
    skipAt: RESET - 20 * MIN,
    open: false,
    test: false,
    seed: false,
    realIn: pct >= 90,
    realReset: RESET,
    floor: 5,
    point: 95,
    atFloor: pct >= 95,
    realPct: pct,
    ...o,
  }
}

test('consent: the fields of each kind', () => {
  assert.equal(consentField('five_hour'), 'consent')
  assert.equal(consentField('seven_day'), 'weeklyConsent')
})

test('consent: writeConsent writes the Claude value format, stamped with the session', () => {
  const st = state()
  writeConsent(st, 'five_hour', { until: RESET }, T0, false)
  writeConsent(st, 'seven_day', { until: RESET + HOUR, to: 95 }, T0, false)
  assert.equal(st.consent, formatConsent(SID, RESET))
  assert.equal(st.weeklyConsent, formatConsent(SID, RESET + HOUR, 95))
})

test('consent: writeConsent never writes for a window that has ended (R10)', () => {
  const st = state()
  writeConsent(st, 'five_hour', { until: T0 }, T0, false)
  assert.equal(st.consent, undefined)
})

test('consent: a consent to the floor never replaces a full value of this session for the same window (floor 3.3)', () => {
  const st = state({ consent: formatConsent(SID, RESET) })
  writeConsent(st, 'five_hour', { until: RESET, to: 95 }, T0, false)
  assert.equal(st.consent, formatConsent(SID, RESET))
  // A full value replaces a consent to the floor: the stronger tier wins.
  const st2 = state({ consent: formatConsent(SID, RESET, 95) })
  writeConsent(st2, 'five_hour', { until: RESET }, T0, false)
  assert.equal(st2.consent, formatConsent(SID, RESET))
  // A full value of another session does not stop it.
  const st3 = state({ consent: formatConsent('another', RESET) })
  writeConsent(st3, 'five_hour', { until: RESET, to: 95 }, T0, false)
  assert.equal(st3.consent, formatConsent(SID, RESET, 95))
})

test('consent: a Resume on a test reading stays in the test consents, never in real use (3.5)', () => {
  const st = state({ test: { hostPid: HOST_PID, kinds: { five_hour: { pct: 92, resetsAtMs: T0 + HOUR } }, consent: {} } })
  writeConsent(st, 'five_hour', { until: T0 + HOUR, to: 95 }, T0, true)
  assert.equal(st.consent, undefined)
  assert.deepEqual(st.test?.consent, { five_hour: { floor: { until: T0 + HOUR, to: 95 } } })
  // With no test reading in the state, a test consent has nowhere to go.
  const none = state()
  writeConsent(none, 'five_hour', { until: T0 + HOUR }, T0, true)
  assert.deepEqual(none, state())
})

test('consent: a new Resume to the floor lifts the tombs that bury it (B52)', () => {
  const st = state({ tombs: { five_hour: [{ until: RESET, to: 95 }] } })
  writeConsent(st, 'five_hour', { until: RESET, to: 95 }, T0, false)
  assert.equal(st.tombs, undefined)
  assert.equal(st.consent, formatConsent(SID, RESET, 95))
})

test('consent: consentsIn reads the test consents on a test basis, for the host of the test only', () => {
  const st = state({
    consent: formatConsent(SID, RESET),
    test: { hostPid: HOST_PID, kinds: { five_hour: { pct: 92, resetsAtMs: T0 + HOUR } }, consent: { five_hour: { full: T0 + HOUR } } },
  })
  assert.deepEqual(consentsIn({ state: st, kind: 'five_hour', attended: true, testBasis: true, hostPid: HOST_PID }).list, [
    { c: { until: T0 + HOUR }, from: 'test' },
    { c: { until: RESET }, from: 'env', raw: formatConsent(SID, RESET) },
  ])
  assert.deepEqual(
    consentsIn({ state: st, kind: 'five_hour', attended: true, testBasis: true, hostPid: HOST_PID + 1 }).list.map((e) => e.from),
    ['env'],
  )
  assert.deepEqual(
    consentsIn({ state: st, kind: 'five_hour', attended: true, testBasis: false, hostPid: HOST_PID }).list.map((e) => e.from),
    ['env'],
  )
})

test('consent: an attended reader takes only its own stamp, an unattended reader any stamp and its parent value', () => {
  const st = state({ consent: formatConsent('another', RESET) })
  const parent = { ...freshState('parent'), weeklyConsent: formatConsent('parent', RESET + HOUR) }
  assert.deepEqual(consentsIn({ state: st, parent, kind: 'five_hour', attended: true, testBasis: false }).list, [])
  assert.deepEqual(consentsIn({ state: st, parent, kind: 'five_hour', attended: false, testBasis: false }).list.length, 1)
  assert.deepEqual(consentsIn({ state: st, parent, kind: 'seven_day', attended: true, testBasis: false }).list, [])
  assert.deepEqual(consentsIn({ state: st, parent, kind: 'seven_day', attended: false, testBasis: false }).list, [
    { c: { until: RESET + HOUR }, from: 'env', raw: formatConsent('parent', RESET + HOUR) },
  ])
})

test('consent: a buried value and a value that an early reset voids are dead, and only the own value is removed', () => {
  const buriedRaw = formatConsent(SID, RESET, 95)
  const st = state({ consent: buriedRaw, tombs: { five_hour: [{ until: RESET, to: 95 }] } })
  assert.deepEqual(consentsIn({ state: st, kind: 'five_hour', attended: true, testBasis: false }), { list: [], dead: [{ kind: 'five_hour', raw: buriedRaw }] })
  const old = formatConsent(SID, T0 + 30 * MIN)
  const st2 = state({ consent: old })
  const r = consentsIn({ state: st2, kind: 'five_hour', attended: true, testBasis: false, realEnd: RESET })
  assert.deepEqual(r, { list: [], dead: [{ kind: 'five_hour', raw: old }] })
  // No known reset: no void.
  assert.equal(consentsIn({ state: st2, kind: 'five_hour', attended: true, testBasis: false, realEnd: null }).list.length, 1)
  // A parent value that the child's tombs bury is no consent, and it is not the child's to remove.
  const parent = { ...freshState('parent'), consent: formatConsent('parent', RESET, 95) }
  const child = state({ tombs: { five_hour: [{ until: RESET, to: 95 }] } })
  assert.deepEqual(consentsIn({ state: child, parent, kind: 'five_hour', attended: false, testBasis: false }), { list: [], dead: [] })
  // removeDead removes a value only while it is as it was read.
  const st3 = state({ consent: 'newer' })
  removeDead(st3, [{ kind: 'five_hour', raw: old }])
  assert.equal(st3.consent, 'newer')
  removeDead(st2, [{ kind: 'five_hour', raw: old }])
  assert.equal(st2.consent, undefined)
})

test('consent: consentsOf reads with no lock and removes a dead value under the lock (A22)', (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const old = formatConsent(SID, T0 + 30 * MIN)
  w.setState({ consent: old, weeklyConsent: formatConsent(SID, RESET + HOUR) })
  assert.deepEqual(consentsOf(b.sx, { kind: 'five_hour', attended: true, testBasis: false, realEnd: RESET }), [])
  assert.equal(w.state().consent, undefined)
  assert.equal(w.state().weeklyConsent, formatConsent(SID, RESET + HOUR), 'the other kind stays')
})

test('consent: endFloors ends a consent to the floor at its point, with a tomb, and keeps it below (B52)', () => {
  const raw = formatConsent(SID, RESET, 95)
  const list = [{ c: { until: RESET, to: 95 }, from: 'env' as const, raw }]
  const below = state({ consent: raw })
  assert.equal(endFloors(below, kind(94), list, T0), false)
  assert.equal(below.consent, raw)
  const at = state({ consent: raw })
  assert.equal(endFloors(at, kind(95), list, T0), true)
  assert.equal(at.consent, undefined)
  assert.deepEqual(at.tombs, { five_hour: [{ until: RESET, to: 95 }] })
  // A value that changed since the read stays, and the tomb still comes.
  const changed = state({ consent: formatConsent(SID, RESET) })
  endFloors(changed, kind(96), list, T0)
  assert.equal(changed.consent, formatConsent(SID, RESET))
  assert.deepEqual(changed.tombs, { five_hour: [{ until: RESET, to: 95 }] })
})

test('consent: endFloors takes the floor slot of a test consent, with no tomb', () => {
  const k = kind(96, { test: true, basis: { kind: 'test', pct: 96, resetsAtMs: T0 + HOUR }, windowEnd: T0 + HOUR })
  const st = state({ test: { hostPid: HOST_PID, kinds: { five_hour: { pct: 96, resetsAtMs: T0 + HOUR } }, consent: { five_hour: { full: T0 + 10 * MIN, floor: { until: T0 + HOUR, to: 95 } } } } })
  assert.equal(endFloors(st, k, [{ c: { until: T0 + HOUR, to: 95 }, from: 'test' }], T0), true)
  assert.deepEqual(st.test?.consent, { five_hour: { full: T0 + 10 * MIN } })
  assert.equal(st.tombs, undefined)
})

test('consent: endFloors with a failed read buries the window whose end point the real reading reached (B52)', () => {
  const st = state()
  assert.equal(endFloors(st, kind(96), [], T0, true), true)
  assert.deepEqual(st.tombs, { five_hour: [{ until: RESET, to: 96 }] })
})

test('consent: clearConsent clears both values and the test consents', () => {
  const st = state({
    consent: formatConsent(SID, RESET),
    weeklyConsent: formatConsent(SID, RESET),
    test: { hostPid: HOST_PID, kinds: {}, consent: { five_hour: { full: RESET } } },
  })
  clearConsent(st)
  assert.equal(st.consent, undefined)
  assert.equal(st.weeklyConsent, undefined)
  assert.deepEqual(st.test?.consent, {})
})
