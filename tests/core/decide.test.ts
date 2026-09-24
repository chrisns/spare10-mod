import { test, expect } from 'claude-code/testing'
import {
  BUDGET_FLOOR_MS,
  CHECK_MS,
  TICK_MS,
  afterFailure,
  askVerdict,
  consentCovers,
  decide,
  formatConsent,
  formatStopped,
  isOverdue,
  joinable,
  mergeStopped,
  parseConsent,
  parseStopped,
  phaseOf,
  shouldAbortTurn,
  stopAction,
  stopDue,
} from '../../hooks/core/decide.ts'
import type { Mode, PhaseInput, Site, Snapshot, StoppedRecord } from '../../hooks/core/decide.ts'
import type { Headless } from '../../hooks/core/config.ts'
import type { Basis } from '../../hooks/core/reading.ts'

const R = Date.parse('2026-09-24T15:00:00.000Z')
const HOUR = 3_600_000
const T0 = Date.parse('2026-09-24T12:00:00Z')
const SITES: readonly Site[] = ['tool', 'step', 'prompt']

// A guarded, attended, tripped session in hold mode, not consented, not stopped.
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  site: 'tool',
  tripped: true,
  enabled: true,
  consented: false,
  attended: true,
  headless: 'off',
  mode: 'hold',
  person: false,
  stopped: false,
  mainTold: false,
  ...over,
})
const at = (site: Site, over: Partial<Snapshot> = {}) => decide(snap({ ...over, site }))
const PASS = { kind: 'pass', trip: false }
const THROUGH = { kind: 'pass', trip: true }
const HOLD = { kind: 'hold' }

test('passes when not tripped, when not guarded, and when consented', () => {
  for (const site of SITES) {
    for (const person of [false, true]) {
      expect(at(site, { tripped: false, person })).toEqual(PASS)
      expect(at(site, { tripped: false, person, stopped: true, attended: false, headless: 'stop' })).toEqual(PASS)
      expect(at(site, { enabled: false, person })).toEqual(THROUGH)
      expect(at(site, { enabled: false, person, attended: false, headless: 'stop' })).toEqual(THROUGH)
      expect(at(site, { enabled: false, person, stopped: true })).toEqual(THROUGH)
      expect(at(site, { consented: true, person })).toEqual(THROUGH)
      expect(at(site, { consented: true, person, stopped: true, mode: 'tell' })).toEqual(THROUGH)
      expect(at(site, { consented: true, person, attended: false, headless: 'stop' })).toEqual(THROUGH)
    }
  }
})

test('unattended off passes and marks the trip', () => {
  for (const site of SITES) {
    expect(at(site, { attended: false, headless: 'off' })).toEqual(THROUGH)
    expect(at(site, { attended: false, headless: 'off', person: true, stopped: true })).toEqual(THROUGH)
  }
})

test('unattended stop refuses tool and step and lets a prompt enter', () => {
  const u = { attended: false, headless: 'stop' as Headless }
  expect(at('tool', u)).toEqual({ kind: 'refuse', text: 'headless' })
  expect(at('step', u)).toEqual({ kind: 'refuse', text: 'headless' })
  expect(at('prompt', u)).toEqual(THROUGH)
  expect(at('prompt', { ...u, person: true })).toEqual(THROUGH)
  expect(at('tool', { ...u, mode: 'tell', stopped: true })).toEqual({ kind: 'refuse', text: 'headless' })
})

test('unattended prompt tells tool results and lets prompts enter', () => {
  const u = { attended: false, headless: 'prompt' as Headless }
  expect(at('tool', u)).toEqual({ kind: 'tell' })
  expect(at('step', u)).toEqual(THROUGH)
  expect(at('prompt', u)).toEqual(THROUGH)
  expect(at('prompt', { ...u, person: true })).toEqual(THROUGH)
})

test('stopped, in either mode: stop text for tools, paused text for steps, a person prompt asks again', () => {
  for (const mode of ['hold', 'tell'] as const) {
    for (const mainTold of [false, true]) {
      const s = { stopped: true, mode, mainTold }
      expect(at('tool', s)).toEqual({ kind: 'refuse', text: 'stop' })
      expect(at('step', s)).toEqual({ kind: 'refuse', text: 'paused' })
      expect(at('prompt', { ...s, person: true })).toEqual(HOLD)
      expect(at('prompt', { ...s, person: false })).toEqual(THROUGH)
    }
  }
})

test('tell mode: tool tells, step passes, a person prompt asks only while main is untold', () => {
  const t = { mode: 'tell' as Mode }
  expect(at('tool', t)).toEqual({ kind: 'tell' })
  expect(at('tool', { ...t, mainTold: true })).toEqual({ kind: 'tell' })
  expect(at('step', t)).toEqual(THROUGH)
  expect(at('prompt', { ...t, person: true })).toEqual(HOLD)
  expect(at('prompt', { ...t, person: true, mainTold: true })).toEqual(THROUGH)
  expect(at('prompt', { ...t, person: false })).toEqual(THROUGH)
})

test('hold mode: tool and step hold, a person prompt holds, other prompts pass', () => {
  expect(at('tool')).toEqual(HOLD)
  expect(at('step')).toEqual(HOLD)
  expect(at('prompt', { person: true })).toEqual(HOLD)
  expect(at('prompt', { person: false })).toEqual(THROUGH)
  expect(at('tool', { mainTold: true })).toEqual(HOLD)
})

test('askVerdict: only the exact yes label resumes', () => {
  expect(askVerdict('Resume', 'Resume')).toBe('resume')
  for (const answer of ['resume', ' Resume', 'Resume ', '', 'Resume, Stop here', 'keep going', 'Stop here', 'RESUME']) {
    expect(askVerdict(answer, 'Resume')).toBe('stop')
  }
})

test('afterFailure: replay after next, refuse while holding, pass while deciding', () => {
  expect(afterFailure(true, true)).toBe('replay')
  expect(afterFailure(true, false)).toBe('replay')
  expect(afterFailure(false, true)).toBe('refuse')
  expect(afterFailure(false, false)).toBe('pass')
})

test('consentCovers needs a time inside this window', () => {
  expect(consentCovers(R, T0, R)).toBe(true) // the window end
  expect(consentCovers(R + 60_000, T0, R)).toBe(true) // the minute of slack
  expect(consentCovers(T0 - 1, T0, R)).toBe(false) // expired
  expect(consentCovers(T0, T0, R)).toBe(false) // equal to now
  expect(consentCovers(R + 5 * 3_600_000 + 61_000, T0, R)).toBe(false) // one window ahead + 61 s
  expect(consentCovers(R + 61_000, T0, R)).toBe(false)
  expect(consentCovers(0, T0, R)).toBe(false)
})

test('parseStopped reads the three fields and refuses junk', () => {
  const rec = { sessionId: 'S1', windowEnd: R, at: T0 }
  expect(formatStopped(rec)).toBe(`S1 ${R} ${T0}`)
  expect(parseStopped(formatStopped(rec))).toEqual(rec)
  const uuid = { sessionId: '0f6c1c2e-8f7a-4c1e-9d55-2b8a1d3e4f50', windowEnd: R, at: T0 + 5 }
  expect(parseStopped(formatStopped(uuid))).toEqual(uuid)
  for (const junk of [undefined, '', 'S1', `S1 ${R}`, `S1 ${R} x`, ` ${R} ${T0}`, `S1 ${R} ${T0} extra`, `S1  ${R} ${T0}`, `S1 -1 ${T0}`]) {
    expect(parseStopped(junk)).toBeUndefined()
  }
})

test('shouldAbortTurn: attended always, unattended only on a repeat', () => {
  expect(shouldAbortTurn(true, false)).toBe(true)
  expect(shouldAbortTurn(true, true)).toBe(true)
  expect(shouldAbortTurn(false, false)).toBe(false)
  expect(shouldAbortTurn(false, true)).toBe(true)
})

const LIVE: Basis = { kind: 'live', pct: 95, resetsAtMs: R }
const BELOW: Basis = { kind: 'live', pct: 50, resetsAtMs: R }
const phase = (over: Partial<PhaseInput> = {}) =>
  phaseOf({ enabled: true, basis: LIVE, tripped: true, consented: false, stopped: false, asking: false, told: false, attended: true, ...over })

test('phaseOf ranks off, asking, blind, waiting, armed, consented, stopped, told, reserve, tripped', () => {
  const all = { consented: true, stopped: true, asking: true, told: true }
  expect(phase({ ...all, enabled: false })).toBe('off')
  expect(phase({ enabled: false, basis: { kind: 'none', why: 'blind' }, tripped: false })).toBe('off')
  expect(phase(all)).toBe('asking')
  expect(phase({ asking: true, basis: { kind: 'none', why: 'blind' }, tripped: false })).toBe('asking')
  expect(phase({ asking: true, basis: BELOW, tripped: false })).toBe('asking')
  expect(phase({ ...all, asking: false, basis: { kind: 'none', why: 'blind' }, tripped: false })).toBe('blind')
  expect(phase({ ...all, asking: false, basis: { kind: 'none', why: 'no-reading' }, tripped: false })).toBe('waiting')
  expect(phase({ ...all, asking: false, basis: { kind: 'none', why: 'window-reset' }, tripped: false })).toBe('waiting')
  expect(phase({ ...all, asking: false, basis: BELOW, tripped: false })).toBe('armed')
  expect(phase({ ...all, asking: false })).toBe('consented')
  expect(phase({ ...all, asking: false, consented: false })).toBe('stopped')
  expect(phase({ told: true })).toBe('told')
  expect(phase({ stopped: true, told: true, attended: false })).toBe('told')
  expect(phase({ attended: false })).toBe('reserve')
  expect(phase({ stopped: true, attended: false })).toBe('reserve')
  expect(phase()).toBe('tripped')
  expect(phase({ basis: { kind: 'seed', pct: 93, resetsAtMs: R } })).toBe('tripped')
  expect(phase({ basis: { kind: 'test', pct: 95, resetsAtMs: R } })).toBe('tripped')
})

test('phaseOf agrees with decide', () => {
  const bools = [false, true]
  const bases: Basis[] = [LIVE, BELOW, { kind: 'none', why: 'blind' }, { kind: 'none', why: 'no-reading' }]
  let checked = 0
  for (const enabled of bools)
    for (const b of bases)
      for (const consented of bools)
        for (const stopped of bools)
          for (const asking of bools)
            for (const told of bools)
              for (const attended of bools)
                for (const mode of ['hold', 'tell'] as const)
                  for (const headless of ['off', 'prompt', 'stop'] as const) {
                    const tripped = b.kind !== 'none' && b.pct >= 90
                    // A question opens only in a guarded session that is not consented.
                    if (asking && (!enabled || !attended || consented)) continue
                    const p = phaseOf({ enabled, basis: b, tripped, consented, stopped, asking, told, attended })
                    const d = (site: Site) =>
                      decide({ site, tripped, enabled, consented, attended, headless, mode, person: false, stopped, mainTold: told })
                    if (p === 'stopped') expect(d('tool')).toEqual({ kind: 'refuse', text: 'stop' })
                    if (p === 'consented' || p === 'off') for (const site of SITES) expect(d(site).kind).toBe('pass')
                    if (mode === 'hold' && (p === 'tripped' || (p === 'asking' && tripped && !stopped))) {
                      expect(d('tool')).toEqual(HOLD)
                      expect(d('step')).toEqual(HOLD)
                    }
                    checked += 1
                  }
  expect(checked).toBe(864)
})

// ---- 0.2 ----

test('the 0.2 clock and budget constants are the design values', () => {
  expect(TICK_MS).toBe(30_000)
  expect(CHECK_MS).toBe(60_000)
  expect(BUDGET_FLOOR_MS).toBe(2_000)
})

test('unattended wait holds tool and step, lets a prompt enter, and lets a seed-only trip go', () => {
  const u = { attended: false, headless: 'wait' as Headless }
  expect(at('tool', u)).toEqual(HOLD)
  expect(at('step', u)).toEqual(HOLD)
  expect(at('prompt', u)).toEqual(THROUGH)
  expect(at('prompt', { ...u, person: true })).toEqual(THROUGH)
  expect(at('tool', { ...u, seedOnly: false })).toEqual(HOLD)
  expect(at('tool', { ...u, seedOnly: true })).toEqual(THROUGH)
  expect(at('step', { ...u, seedOnly: true })).toEqual(THROUGH)
  expect(at('tool', { ...u, mode: 'tell' })).toEqual(HOLD) // the pause prompt is for attended sessions
  expect(at('tool', { ...u, consented: true })).toEqual(THROUGH) // an inherited consent passes
  expect(at('tool', { ...u, tripped: false })).toEqual(PASS)
  expect(at('tool', { ...u, enabled: false })).toEqual(THROUGH)
  // seedOnly changes nothing outside row 6a.
  for (const site of SITES) {
    expect(at(site, { seedOnly: true })).toEqual(at(site))
    expect(at(site, { seedOnly: true, attended: false, headless: 'stop' })).toEqual(at(site, { attended: false, headless: 'stop' }))
  }
})

const REC: StoppedRecord = { sessionId: 'S1', windowEnd: R, at: T0, kinds: ['five_hour'], work: true, auto: true, test: false }

test('parseStopped reads the 0.2 form with its tags, and formatStopped round-trips it', () => {
  expect(formatStopped(REC)).toBe(`S1 ${R} ${T0} five_hour,work,auto`)
  expect(parseStopped(formatStopped(REC))).toEqual(REC)
  const both: StoppedRecord = { sessionId: 'S1', windowEnd: R, at: T0, kinds: ['five_hour', 'seven_day'], work: false, auto: true, test: true }
  expect(formatStopped(both)).toBe(`S1 ${R} ${T0} five_hour,seven_day,auto,test`)
  expect(parseStopped(formatStopped(both))).toEqual(both)
  // Kinds come out five_hour first, tags in a fixed order, whatever order the value has.
  expect(parseStopped(`S1 ${R} ${T0} auto,seven_day,five_hour`)).toEqual({ ...both, test: false })
  expect(formatStopped({ ...REC, kinds: ['seven_day', 'five_hour'] })).toBe(`S1 ${R} ${T0} five_hour,seven_day,work,auto`)
  expect(parseStopped(`S1 ${R} ${T0} seven_day`)).toEqual({ sessionId: 'S1', windowEnd: R, at: T0, kinds: ['seven_day'], work: false, auto: false, test: false })
  expect(formatStopped({ sessionId: 'S1', windowEnd: R, at: T0, kinds: ['seven_day'] })).toBe(`S1 ${R} ${T0} seven_day`)
})

test('parseStopped reads a 0.1 value with no kinds, as before', () => {
  const old = parseStopped(`S1 ${R} ${T0}`)
  expect(old).toEqual({ sessionId: 'S1', windowEnd: R, at: T0 })
  expect(old?.kinds).toBeUndefined()
  expect(old?.auto).toBeUndefined()
  expect(formatStopped({ sessionId: 'S1', windowEnd: R, at: T0 })).toBe(`S1 ${R} ${T0}`)
  expect(formatStopped({ sessionId: 'S1', windowEnd: R, at: T0, kinds: [], work: true })).toBe(`S1 ${R} ${T0}`)
})

test('parseStopped refuses a record without a kind, or with an unknown tag', () => {
  for (const junk of [
    `S1 ${R} ${T0} work,auto`,
    `S1 ${R} ${T0} test`,
    `S1 ${R} ${T0} five_hour,later`,
    `S1 ${R} ${T0} five_hour,,auto`,
    `S1 ${R} ${T0} five_hour,`,
    `S1 ${R} ${T0} Five_hour`,
    `S1 ${R} ${T0} five_hour auto`,
    `S1 ${R} ${T0}  five_hour`,
    `S1 ${R} five_hour`,
  ]) {
    expect(parseStopped(junk)).toBeUndefined()
  }
})

test('mergeStopped keeps work, joins kinds, takes the later end, and ignores another session or an ended stop', () => {
  const prev: StoppedRecord = { sessionId: 'S1', windowEnd: R + HOUR, at: T0, kinds: ['seven_day'], work: true, auto: false, test: true }
  const next: StoppedRecord = { sessionId: 'S1', windowEnd: R, at: T0 + 60_000, kinds: ['five_hour'], work: false, auto: true, test: true }
  expect(mergeStopped(prev, next, T0 + 60_000)).toEqual({
    sessionId: 'S1',
    windowEnd: R + HOUR,
    at: T0 + 60_000,
    kinds: ['five_hour', 'seven_day'],
    work: true,
    auto: true,
    test: true,
  })
  expect(mergeStopped({ ...prev, test: false }, next, T0).test).toBe(false) // test only if both
  expect(mergeStopped({ ...prev, windowEnd: R - HOUR }, next, T0).windowEnd).toBe(R) // the later end
  expect(mergeStopped(prev, { ...next, auto: false }, T0).auto).toBe(false) // auto from the new Stop
  expect(mergeStopped(undefined, next, T0)).toEqual(next)
  expect(mergeStopped({ ...prev, sessionId: 'S0' }, next, T0)).toEqual(next) // another session
  expect(mergeStopped(prev, next, R + HOUR)).toEqual(next) // the old stop ended
  expect(mergeStopped({ sessionId: 'S1', windowEnd: R + HOUR, at: T0 }, next, T0)).toEqual(next) // a 0.1 value
})

test('stopDue adds 5 minutes, or 60 s for a test stop', () => {
  expect(stopDue(REC)).toBe(R + 300_000)
  expect(stopDue({ ...REC, test: true })).toBe(R + 60_000)
  expect(stopDue({ sessionId: 'S1', windowEnd: R, at: T0 })).toBe(R + 300_000)
})

test('stopAction: 0.1 value, no auto, before due, another conversation, off, check', () => {
  const due = stopDue(REC)
  const i = { record: REC, now: due, sessionId: 'S1', autoResume: true, enabled: true, attended: true }
  expect(stopAction(i)).toBe('check')
  expect(stopAction({ ...i, now: due + 7 * 24 * HOUR })).toBe('check')
  expect(stopAction({ ...i, record: { sessionId: 'S1', windowEnd: R, at: T0 } })).toBe('none') // a 0.1 value
  expect(stopAction({ ...i, record: { ...REC, auto: false } })).toBe('none')
  expect(stopAction({ ...i, now: due - 1 })).toBe('none')
  expect(stopAction({ ...i, now: R })).toBe('none') // inside the margin
  expect(stopAction({ ...i, sessionId: 'S2' })).toBe('drop')
  expect(stopAction({ ...i, endedSid: 'S1' })).toBe('drop') // /clear, before the engine answers the new id
  expect(stopAction({ ...i, endedSid: 'S0' })).toBe('check') // /resume back to this conversation
  expect(stopAction({ ...i, autoResume: false })).toBe('none')
  expect(stopAction({ ...i, autoResume: false, sessionId: 'S2' })).toBe('none') // ends by time
  expect(stopAction({ ...i, enabled: false })).toBe('none')
  expect(stopAction({ ...i, attended: false })).toBe('none')
  expect(stopAction({ ...i, record: { ...REC, test: true }, now: R + 60_000 })).toBe('check')
})

test('isOverdue takes only an auto 0.2 record of this session past its end', () => {
  expect(isOverdue(REC, 'S1', undefined, R)).toBe(true)
  expect(isOverdue(REC, 'S1', undefined, R + HOUR)).toBe(true)
  expect(isOverdue(REC, 'S1', undefined, R - 1)).toBe(false)
  expect(isOverdue(REC, 'S2', undefined, R)).toBe(false)
  expect(isOverdue(REC, 'S1', 'S1', R)).toBe(false)
  expect(isOverdue({ ...REC, auto: false }, 'S1', undefined, R)).toBe(false)
  expect(isOverdue({ sessionId: 'S1', windowEnd: R, at: T0 }, 'S1', undefined, R)).toBe(false)
  expect(isOverdue(undefined, 'S1', undefined, R)).toBe(false)
})

test('joinable: open, stop, resume that covers, resume that does not, again', () => {
  expect(joinable(undefined, ['five_hour'], ['five_hour', 'seven_day'])).toBe(true)
  expect(joinable('stop', ['five_hour'], ['seven_day'])).toBe(true)
  expect(joinable('resume', ['five_hour', 'seven_day'], ['seven_day'])).toBe(true)
  expect(joinable('resume', ['five_hour'], ['five_hour'])).toBe(true)
  expect(joinable('resume', ['five_hour'], ['five_hour', 'seven_day'])).toBe(false)
  expect(joinable('resume', ['seven_day'], ['five_hour'])).toBe(false)
  expect(joinable('again', ['five_hour', 'seven_day'], ['five_hour'])).toBe(false)
})

test('parseConsent refuses a value that only Date.parse accepts', () => {
  expect(Number.isFinite(Date.parse('abc-123'))).toBe(true) // why the prefix check exists
  for (const junk of ['abc-123', '1', 'S1 abc-123', 'S1 1', 'S1 2026-09-24', '2026-09-24 15:00', 'S1 Thu Sep 24 2026', '', ' ']) {
    expect(parseConsent(junk)).toBeUndefined()
  }
  expect(parseConsent(undefined)).toBeUndefined()
  expect(parseConsent('2026-09-24T15:00:00.000Z')).toEqual({ until: R })
  expect(parseConsent(' 2026-09-24T15:00:00Z ')).toEqual({ until: R })
  expect(parseConsent(formatConsent('S1', R))).toEqual({ until: R, sessionId: 'S1' })
  expect(parseConsent('S1 2026-09-24T25:00:00Z')).toBeUndefined() // the prefix, but Date.parse refuses it
})

test('phaseOf: a weekly or test trip over a none 5-hour basis shows tripped, not waiting or blind', () => {
  for (const why of ['blind', 'no-reading', 'window-reset'] as const) {
    const basis: Basis = { kind: 'none', why }
    expect(phase({ basis, tripped: true })).toBe('tripped')
    expect(phase({ basis, tripped: true, told: true })).toBe('told')
    expect(phase({ basis, tripped: true, consented: true })).toBe('consented')
    expect(phase({ basis, tripped: true, stopped: true })).toBe('stopped')
    expect(phase({ basis, tripped: true, attended: false })).toBe('reserve')
    expect(phase({ basis, tripped: false })).toBe(why === 'blind' ? 'blind' : 'waiting')
  }
})

test('phaseOf agrees with decide for wait', () => {
  const bases: Basis[] = [LIVE, { kind: 'seed', pct: 95, resetsAtMs: R }, { kind: 'test', pct: 95, resetsAtMs: R }, { kind: 'none', why: 'no-reading' }]
  for (const b of bases)
    for (const mode of ['hold', 'tell'] as const) {
      // A silent wait hold is not asking, so the phase is reserve.
      expect(phaseOf({ enabled: true, basis: b, tripped: true, consented: false, stopped: false, asking: false, told: false, attended: false })).toBe('reserve')
      const d = (site: Site) =>
        decide({ site, tripped: true, enabled: true, consented: false, attended: false, headless: 'wait', mode, person: site === 'prompt', stopped: false, mainTold: false })
      expect(d('tool')).toEqual(HOLD)
      expect(d('step')).toEqual(HOLD)
      expect(d('prompt')).toEqual(THROUGH)
    }
})
