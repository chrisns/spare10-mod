import { test, expect } from 'claude-code/testing'
import {
  BUDGET_FLOOR_MS,
  CHECK_MS,
  TICK_MS,
  afterFailure,
  answers,
  answersQuestion,
  askVerdict,
  buried,
  bury,
  consentApplies,
  consentCovers,
  coveringConsent,
  decide,
  endOf,
  endedFloor,
  floorEnded,
  formatConsent,
  fullCovers,
  extendedReal,
  formatStopped,
  heldPast,
  holdsPast,
  isOverdue,
  joinReal,
  joinable,
  joinableAt,
  keyStage,
  mergeStopped,
  noteSlot,
  parseConsent,
  parseStopped,
  phaseOf,
  sameWindow,
  shouldAbortTurn,
  skipTag,
  slotList,
  stageKey,
  stopAction,
  stopDue,
  unbury,
  withoutFloor,
} from '../../hooks/core/decide.ts'
import type { Answered, Consent, Holder, Mode, PhaseInput, Site, Snapshot, StoppedRecord, Tomb } from '../../hooks/core/decide.ts'
import type { Headless } from '../../hooks/core/config.ts'
import type { Basis } from '../../hooks/core/reading.ts'

const R = Date.parse('2026-09-24T15:00:00.000Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
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

test('mergeStopped keeps work, joins kinds, takes the later end, and ignores another session or a stop that ended by time', () => {
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
  expect(mergeStopped(prev, next, R + HOUR)).toEqual(next) // the old stop ended by time: it had no auto tag
  // An auto stop past its until that nobody released yet (it is still in the env) keeps its work and kinds (F1).
  const overdue: StoppedRecord = { ...prev, windowEnd: R, auto: true }
  expect(mergeStopped(overdue, { ...next, at: R + 60_000 }, R + 60_000)).toEqual({
    sessionId: 'S1',
    windowEnd: R,
    at: R + 60_000,
    kinds: ['five_hour', 'seven_day'],
    work: true,
    auto: true,
    test: true,
  })
  expect(mergeStopped({ ...overdue, sessionId: 'S0' }, next, R + 60_000)).toEqual(next) // another session
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
  expect(isOverdue(REC, 'S1', undefined, R, [])).toBe(true)
  expect(isOverdue(REC, 'S1', undefined, R + HOUR, [])).toBe(true)
  expect(isOverdue(REC, 'S1', undefined, R - 1, [])).toBe(false)
  expect(isOverdue(REC, 'S2', undefined, R, [])).toBe(false)
  expect(isOverdue(REC, 'S1', 'S1', R, [])).toBe(false)
  expect(isOverdue({ ...REC, auto: false }, 'S1', undefined, R, [])).toBe(false)
  expect(isOverdue({ sessionId: 'S1', windowEnd: R, at: T0 }, 'S1', undefined, R, [])).toBe(false)
  expect(isOverdue(undefined, 'S1', undefined, R, [])).toBe(false)
})

// TS1 entries: the reset of the real window when the entry was written.
const F: Holder = { kind: 'five_hour', resetsAtMs: R } // a real 5-hour reading of the window 10:00 to 15:00
const W: Holder = { kind: 'seven_day', resetsAtMs: R + 3 * DAY }

test('TS1: a skip or test 0.2 stop past its end still holds while a kind with its real tag gates on a real reading of the same window', () => {
  const skipRec: StoppedRecord = { ...REC, skip: true, real: [F] }
  const five: Holder = { kind: 'five_hour', resetsAtMs: R } // its real reading gates now, in the window 10:00 to 15:00
  const week: Holder = { kind: 'seven_day', resetsAtMs: R + 3 * DAY }
  expect(heldPast(skipRec, [five])).toBe(true)
  expect(heldPast(skipRec, [five, week])).toBe(true)
  expect(holdsPast(skipRec, five)).toBe(true)
  expect(holdsPast(skipRec, week)).toBe(false) // another kind: the ticker extends the stop to it (B34)
  expect(heldPast({ ...skipRec, kinds: ['five_hour', 'seven_day'] }, [week])).toBe(false) // its real reading was not in the reserve at the stop
  expect(heldPast({ ...REC, test: true, real: [F] }, [five])).toBe(true) // a test window ended over a real trip
  expect(heldPast({ ...skipRec, auto: false }, [five])).toBe(true) // autoResume off: a skip start that did not open
  expect(heldPast(skipRec, [])).toBe(false)
  expect(heldPast(skipRec, [week])).toBe(false)
  expect(heldPast({ ...REC, real: [F] }, [five])).toBe(false) // it ended at a reset: a new trip asks again (D0.2)
  expect(heldPast({ sessionId: 'S1', windowEnd: R, at: T0 }, [five])).toBe(false) // a 0.1 value ends by time
  expect(isOverdue(skipRec, 'S1', undefined, R + HOUR, [five])).toBe(false)
  expect(isOverdue(skipRec, 'S1', undefined, R + HOUR, [week])).toBe(true)
  expect(isOverdue({ ...REC, real: [F] }, 'S1', undefined, R + HOUR, [five])).toBe(true)
})

test('TS1: the hold past the end is bound to the window of the real entry, by its reset, and to the real tag that the stop wrote', () => {
  const skipRec: StoppedRecord = { ...REC, skip: true, real: [F] }
  const five: Holder = { kind: 'five_hour', resetsAtMs: R }
  // The window of the entry: a reset less than half a window (2.5 h) from the recorded one. The time of the stop plays no part.
  expect(heldPast(skipRec, [{ ...five, resetsAtMs: R + 1000 }])).toBe(true) // the same window, its reset 1 s later
  expect(heldPast(skipRec, [{ ...five, resetsAtMs: R - 1000 }])).toBe(true)
  expect(heldPast(skipRec, [{ ...five, resetsAtMs: R + 2.5 * HOUR - 1 }])).toBe(true)
  expect(heldPast(skipRec, [{ ...five, resetsAtMs: R + 2.5 * HOUR }])).toBe(false)
  expect(heldPast(skipRec, [{ ...five, resetsAtMs: R + 5 * HOUR }])).toBe(false) // the next window
  expect(heldPast({ ...skipRec, at: R - 10 * HOUR }, [five])).toBe(true) // a stop written before the window started: an extension adopted it
  expect(heldPast({ ...skipRec, real: [{ ...F, resetsAtMs: R + 5 * HOUR }] }, [five])).toBe(false) // an entry of another window
  // The weekly window is 7 days long: its bound is 3.5 days.
  const week: Holder = { kind: 'seven_day', resetsAtMs: T0 + 7 * DAY }
  const weekRec: StoppedRecord = { ...skipRec, kinds: ['seven_day'], real: [{ kind: 'seven_day', resetsAtMs: T0 + 7 * DAY }] }
  expect(heldPast(weekRec, [week])).toBe(true)
  expect(heldPast(weekRec, [{ ...week, resetsAtMs: T0 + 7 * DAY + 3 * DAY }])).toBe(true)
  expect(heldPast(weekRec, [{ ...week, resetsAtMs: T0 + 14 * DAY }])).toBe(false)
  // Its real reading must be in the reserve at the stop: the real tag. A value without it (0.1, or 0.2 before TS1) keeps nothing.
  const { real: _real, ...untagged } = skipRec
  expect(heldPast(untagged, [five])).toBe(false) // a real trip after the stop asks again
  expect(heldPast({ ...skipRec, real: [W] }, [five])).toBe(false)
  expect(heldPast({ ...untagged, test: true }, [five])).toBe(false) // a test stop over a real reading below the reserve
  // An unknown reset, now or in the entry, keeps it while it gates: fail closed.
  expect(heldPast(skipRec, [{ ...five, resetsAtMs: null }])).toBe(true)
  expect(heldPast({ ...skipRec, real: [{ kind: 'five_hour', resetsAtMs: null }] }, [{ ...five, resetsAtMs: R + 5 * HOUR }])).toBe(true)
  expect(heldPast(untagged, [{ ...five, resetsAtMs: null }])).toBe(false)
  expect(isOverdue(untagged, 'S1', undefined, R + HOUR, [five])).toBe(true)
  expect(isOverdue(skipRec, 'S1', undefined, R + HOUR, [{ ...five, resetsAtMs: R + 5 * HOUR }])).toBe(true)
})

test('TS1: sameWindow compares two resets of one kind against half its window, and an unknown reset matches', () => {
  expect(sameWindow('five_hour', R, R + 2.5 * HOUR - 1)).toBe(true)
  expect(sameWindow('five_hour', R, R - 2.5 * HOUR)).toBe(false)
  expect(sameWindow('seven_day', R, R + 3.5 * DAY - 1)).toBe(true)
  expect(sameWindow('seven_day', R, R + 3.5 * DAY)).toBe(false)
  expect(sameWindow('five_hour', null, R)).toBe(true)
  expect(sameWindow('seven_day', R, null)).toBe(true)
})

test('TS1: parseStopped and formatStopped carry the real tags last with their resets, on a skip or test stop only, and read a value without them as before', () => {
  const rec: StoppedRecord = { ...REC, kinds: ['five_hour', 'seven_day'], test: true, skip: true, real: [F, W] }
  expect(formatStopped(rec)).toBe(`S1 ${R} ${T0} five_hour,seven_day,work,auto,test,skip,real_five_hour:${R},real_seven_day:${R + 3 * DAY}`)
  expect(parseStopped(formatStopped(rec))).toEqual(rec)
  expect(parseStopped(`S1 ${R} ${T0} real_seven_day:${R + 3 * DAY},skip,seven_day`)).toEqual({ sessionId: 'S1', windowEnd: R, at: T0, kinds: ['seven_day'], work: false, auto: false, test: false, skip: true, real: [W] })
  expect(formatStopped({ ...REC, test: true, real: [F] })).toBe(`S1 ${R} ${T0} five_hour,work,auto,test,real_five_hour:${R}`)
  expect(formatStopped({ ...REC, skip: true, real: [F] })).toBe(`S1 ${R} ${T0} five_hour,work,auto,skip,real_five_hour:${R}`)
  // An unknown reset: a bare tag. A bare tag, as 0.2 before the reset in the tag wrote it, and `:0` read as unknown.
  const unknown: StoppedRecord = { ...REC, skip: true, real: [{ kind: 'five_hour', resetsAtMs: null }] }
  expect(formatStopped(unknown)).toBe(`S1 ${R} ${T0} five_hour,work,auto,skip,real_five_hour`)
  expect(parseStopped(`S1 ${R} ${T0} five_hour,work,auto,skip,real_five_hour`)).toEqual(unknown)
  expect(parseStopped(`S1 ${R} ${T0} five_hour,work,auto,skip,real_five_hour:0`)).toEqual(unknown)
  // One entry per kind: the later window, a known reset before an unknown one.
  expect(parseStopped(`S1 ${R} ${T0} five_hour,skip,real_five_hour:${R},real_five_hour:${R + 5 * HOUR}`)?.real).toEqual([{ kind: 'five_hour', resetsAtMs: R + 5 * HOUR }])
  expect(parseStopped(`S1 ${R} ${T0} five_hour,skip,real_five_hour,real_five_hour:${R}`)?.real).toEqual([F])
  expect(formatStopped({ ...REC, skip: true, real: [{ kind: 'five_hour', resetsAtMs: null }, F] })).toBe(`S1 ${R} ${T0} five_hour,work,auto,skip,real_five_hour:${R}`)
  // A stop that ends at a reset never holds past it: its value stays as in D0.2.
  expect(formatStopped({ ...REC, real: [F] })).toBe(`S1 ${R} ${T0} five_hour,work,auto`)
  // A real tag names only a kind of the stop.
  expect(formatStopped({ ...REC, skip: true, real: [W] })).toBe(`S1 ${R} ${T0} five_hour,work,auto,skip`)
  expect('real' in (parseStopped(`S1 ${R} ${T0} five_hour,real_seven_day:${R}`) ?? { real: 0 })).toBe(false)
  expect(formatStopped({ ...REC, real: [] })).toBe(`S1 ${R} ${T0} five_hour,work,auto`)
  // A 0.1 value and a 0.2 value from before TS1 read as before, with no real field.
  expect(parseStopped(`S1 ${R} ${T0}`)).toEqual({ sessionId: 'S1', windowEnd: R, at: T0 })
  expect(parseStopped(`S1 ${R} ${T0} five_hour,work,auto,test,skip`)).toEqual({ ...REC, test: true, skip: true })
  for (const junk of [
    `S1 ${R} ${T0} real_five_hour`,
    `S1 ${R} ${T0} real_five_hour:${R}`,
    `S1 ${R} ${T0} five_hour,real`,
    `S1 ${R} ${T0} five_hour,real_5h`,
    `S1 ${R} ${T0} five_hour,Real_five_hour`,
    `S1 ${R} ${T0} five_hour,real_five_hour:`,
    `S1 ${R} ${T0} five_hour,real_five_hour:abc`,
    `S1 ${R} ${T0} five_hour,real_five_hour:-1`,
    `S1 ${R} ${T0} five_hour,real_five_hour:1:2`,
    `S1 ${R} ${T0} five_hour,five_hour:${R}`,
  ]) {
    expect(parseStopped(junk)).toBeUndefined()
  }
})

test('TS1: mergeStopped joins the real entries of one session by kind, keeps the later window, and drops a window that is over', () => {
  const prev: StoppedRecord = { sessionId: 'S1', windowEnd: R + HOUR, at: T0, kinds: ['seven_day'], work: true, auto: true, test: false, real: [W] }
  const next: StoppedRecord = { sessionId: 'S1', windowEnd: R, at: T0 + 60_000, kinds: ['five_hour'], work: false, auto: true, test: false, real: [F] }
  expect(mergeStopped(prev, next, T0 + 60_000).real).toEqual([F, W])
  const { real: _p, ...prevUntagged } = prev
  expect(mergeStopped(prevUntagged, next, T0 + 60_000).real).toEqual([F])
  const { real: _n, ...nextUntagged } = next
  expect(mergeStopped(prev, nextUntagged, T0 + 60_000).real).toEqual([W])
  expect('real' in mergeStopped(prevUntagged, nextUntagged, T0 + 60_000)).toBe(false)
  expect(mergeStopped({ ...prev, sessionId: 'S0' }, nextUntagged, T0 + 60_000)).toEqual(nextUntagged) // another session: nothing joins
  // One kind in both: the entry of the later window. A known reset wins over an unknown one.
  const older: StoppedRecord = { ...prev, kinds: ['five_hour'], real: [{ kind: 'five_hour', resetsAtMs: R - HOUR }] }
  expect(mergeStopped(older, next, T0 + 60_000).real).toEqual([F])
  expect(mergeStopped({ ...older, real: [{ kind: 'five_hour', resetsAtMs: R + HOUR }] }, next, T0 + 60_000).real).toEqual([{ kind: 'five_hour', resetsAtMs: R + HOUR }])
  expect(mergeStopped({ ...older, real: [{ kind: 'five_hour', resetsAtMs: null }] }, next, T0 + 60_000).real).toEqual([F])
  expect(mergeStopped(next, { ...older, real: [{ kind: 'five_hour', resetsAtMs: null }] }, T0 + 60_000).real).toEqual([F])
  expect(mergeStopped({ ...older, real: [{ kind: 'five_hour', resetsAtMs: null }] }, nextUntagged, T0 + 60_000).real).toEqual([{ kind: 'five_hour', resetsAtMs: null }])
  // An entry whose recorded reset has passed: that window is over, so a trip in the next window asks again.
  const w1: StoppedRecord = { ...prev, windowEnd: R + 40 * 60_000, kinds: ['five_hour'], test: true, skip: true, real: [F] }
  const w2: StoppedRecord = { ...nextUntagged, windowEnd: R + 40 * 60_000, at: R + 10 * 60_000, test: true, skip: true }
  expect('real' in mergeStopped(w1, w2, R + 10 * 60_000)).toBe(false)
  expect(mergeStopped(w1, w2, R - 1).real).toEqual([F])
  expect(mergeStopped(w1, { ...w2, real: [{ kind: 'five_hour', resetsAtMs: R + 5 * HOUR }] }, R + 10 * 60_000).real).toEqual([{ kind: 'five_hour', resetsAtMs: R + 5 * HOUR }])
})

test('TS1: joinReal and extendedReal give one entry per kind; an extension writes the current reset of each kind whose real reading gates', () => {
  expect(joinReal(undefined, undefined, T0)).toEqual([])
  expect(joinReal([W], [F], T0)).toEqual([F, W]) // KINDS order
  expect(joinReal([F], [], R)).toEqual([]) // its window is over
  expect(joinReal([{ kind: 'five_hour', resetsAtMs: null }], [], R + DAY)).toEqual([{ kind: 'five_hour', resetsAtMs: null }]) // unknown: kept
  const later: Holder = { kind: 'five_hour', resetsAtMs: R + 5 * HOUR }
  // A kind whose real reading gates now gets its current reset, also over an earlier entry of it.
  expect(extendedReal([F], [later], ['five_hour'], R + 10 * 60_000)).toEqual([later])
  expect(extendedReal([F], [later], ['five_hour'], T0)).toEqual([later])
  expect(extendedReal([W], [later], ['five_hour'], T0)).toEqual([later]) // a kind the extension drops loses its entry
  expect(extendedReal(undefined, [{ kind: 'five_hour', resetsAtMs: null }], ['five_hour'], T0)).toEqual([{ kind: 'five_hour', resetsAtMs: null }])
  // Another kind that still gates keeps its entry while that window lasts.
  expect(extendedReal([F, W], [], ['five_hour', 'seven_day'], T0)).toEqual([F, W])
  expect(extendedReal([F, W], [], ['five_hour', 'seven_day'], R)).toEqual([W])
  expect(extendedReal([F], [later], ['seven_day'], T0)).toEqual([]) // only the kinds of the extension
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

// ---- Skip near the reset (skip design 3.5, 6.3) ----

const OPENS = R - 20 * 60_000 // the 5-hour skip start

test('parseStopped and formatStopped carry the skip tag, last in the list', () => {
  const skip: StoppedRecord = { sessionId: 'S1', windowEnd: OPENS, at: T0, kinds: ['five_hour'], work: true, auto: true, test: false, skip: true }
  expect(formatStopped(skip)).toBe(`S1 ${OPENS} ${T0} five_hour,work,auto,skip`)
  expect(parseStopped(formatStopped(skip))).toEqual(skip)
  const all: StoppedRecord = { sessionId: 'S1', windowEnd: OPENS, at: T0, kinds: ['five_hour', 'seven_day'], work: true, auto: true, test: true, skip: true }
  expect(formatStopped(all)).toBe(`S1 ${OPENS} ${T0} five_hour,seven_day,work,auto,test,skip`)
  expect(parseStopped(`S1 ${OPENS} ${T0} skip,test,seven_day,auto,five_hour,work`)).toEqual(all) // any order in, a fixed order out
  expect(parseStopped(`S1 ${OPENS} ${T0} five_hour,skip`)).toEqual({ sessionId: 'S1', windowEnd: OPENS, at: T0, kinds: ['five_hour'], work: false, auto: false, test: false, skip: true })
  // Without the tag the record has no skip field: the D0.2 value reads as before.
  expect('skip' in (parseStopped(`S1 ${R} ${T0} five_hour,auto`) ?? {})).toBe(false)
  expect(formatStopped({ ...skip, skip: false })).toBe(`S1 ${OPENS} ${T0} five_hour,work,auto`)
  expect(parseStopped(`S1 ${OPENS} ${T0} skip`)).toBeUndefined() // still needs a kind
  expect(parseStopped(`S1 ${OPENS} ${T0} five_hour,skipped`)).toBeUndefined()
})

test('stopDue adds no margin to a skip stop, also with the test tag', () => {
  expect(stopDue({ ...REC, windowEnd: OPENS, skip: true })).toBe(OPENS)
  expect(stopDue({ ...REC, windowEnd: OPENS, skip: true, test: true })).toBe(OPENS)
  expect(stopDue({ ...REC, windowEnd: OPENS, skip: false })).toBe(OPENS + 300_000)
  // A skip stop is due, and overdue, from its skip start.
  expect(stopAction({ record: { ...REC, windowEnd: OPENS, skip: true }, now: OPENS, sessionId: 'S1', autoResume: true, enabled: true, attended: true })).toBe('check')
  expect(stopAction({ record: { ...REC, windowEnd: OPENS, skip: true }, now: OPENS - 1, sessionId: 'S1', autoResume: true, enabled: true, attended: true })).toBe('none')
  expect(isOverdue({ ...REC, windowEnd: OPENS, skip: true }, 'S1', undefined, OPENS, [])).toBe(true)
})

test('skipTag needs a skip start at until, and with auto no later due', () => {
  expect(skipTag(OPENS, [OPENS], [OPENS], true)).toBe(true)
  expect(skipTag(OPENS, [OPENS], [OPENS, OPENS - 60_000], true)).toBe(true)
  expect(skipTag(OPENS, [OPENS], [OPENS, OPENS + 30_000], true)).toBe(false) // a due 30 s after until keeps its margin
  expect(skipTag(OPENS, [OPENS], [OPENS + 30_000], false)).toBe(true) // autoResume off: spare10 never releases it, the dues do not count
  expect(skipTag(R, [OPENS], [R + 300_000], true)).toBe(false) // until is a reset
  expect(skipTag(R, [OPENS], [], false)).toBe(false)
  expect(skipTag(OPENS, [], [OPENS], true)).toBe(false)
})

test('mergeStopped takes the skip tag of the record with the later end, and drops it when the earlier due is later', () => {
  const at = T0 + 60_000
  const skipNext: StoppedRecord = { sessionId: 'S1', windowEnd: OPENS, at, kinds: ['five_hour'], work: false, auto: true, test: false, skip: true }
  const realPrev: StoppedRecord = { sessionId: 'S1', windowEnd: OPENS - 2 * 60_000, at: T0, kinds: ['seven_day'], work: true, auto: true, test: false }
  // The earlier real end is due 3 min after the skip until: no skip, so the earlier kind keeps its margin.
  const merged = mergeStopped(realPrev, skipNext, at)
  expect(merged).toEqual({ sessionId: 'S1', windowEnd: OPENS, at, kinds: ['five_hour', 'seven_day'], work: true, auto: true, test: false })
  expect(stopDue(merged)).toBe(OPENS + 300_000)
  // An earlier end that is due by the later until keeps the skip.
  const earlyPrev = { ...realPrev, windowEnd: OPENS - 10 * 60_000 }
  expect(mergeStopped(earlyPrev, skipNext, at).skip).toBe(true)
  // Without auto the dues do not count: the later record's tag stands.
  expect(mergeStopped({ ...realPrev, auto: false }, { ...skipNext, auto: false }, at).skip).toBe(true)
  // The later end wins, with its own tag: a later reset-based prev drops the new skip tag.
  const laterPrev = { ...realPrev, windowEnd: R }
  expect('skip' in mergeStopped(laterPrev, skipNext, at)).toBe(false)
  expect(mergeStopped({ ...laterPrev, skip: true }, { ...skipNext, windowEnd: OPENS - 60 * 60_000 }, at).skip).toBe(true)
  // A tie: the new record's tag, and still only while the earlier record is due by then.
  expect(mergeStopped({ ...realPrev, windowEnd: OPENS, skip: true }, { ...skipNext, skip: false }, at).skip).toBeUndefined()
  expect(mergeStopped({ ...realPrev, windowEnd: OPENS, skip: true }, skipNext, at).skip).toBe(true)
  expect(mergeStopped({ ...realPrev, windowEnd: OPENS }, skipNext, at).skip).toBeUndefined() // the reset-based record is due 5 min later
  // No earlier record: the new record whole.
  expect(mergeStopped(undefined, skipNext, at)).toEqual(skipNext)
})

test('phaseOf: open comes after consented and before stopped', () => {
  const all = { stopped: true, told: true }
  expect(phase({ ...all, open: true })).toBe('open')
  expect(phase({ ...all, open: true, consented: true })).toBe('consented')
  expect(phase({ ...all, open: true, asking: true })).toBe('asking')
  expect(phase({ open: true, attended: false })).toBe('open')
  expect(phase({ open: true, basis: BELOW, tripped: false })).toBe('armed') // open needs a trip
  expect(phase({ open: true, enabled: false })).toBe('off')
  expect(phase({ open: false, stopped: true })).toBe('stopped')
  expect(phase({ stopped: true })).toBe('stopped') // absent: the D0.2 phase
})

test('phaseOf agrees with decide for open', () => {
  // open: tripped, and no kind gates (each tripped kind is consented or open). Decide row 3 then passes,
  // attended and unattended, whatever the stop, the mode and the policy say.
  let checked = 0
  for (const attended of [false, true])
    for (const stopped of [false, true])
      for (const told of [false, true])
        for (const mode of ['hold', 'tell'] as const)
          for (const headless of ['off', 'prompt', 'stop', 'wait'] as const) {
            const p = phaseOf({ enabled: true, basis: LIVE, tripped: true, consented: false, open: true, stopped, asking: false, told, attended })
            expect(p).toBe('open')
            for (const site of SITES)
              for (const person of [false, true]) {
                // The gate reads the stop only while a kind gates (B44), so an open session is never stopped.
                const d = decide({ site, tripped: true, enabled: true, consented: true, attended, headless, mode, person, stopped: false, mainTold: told })
                expect(d).toEqual(THROUGH)
                checked += 1
              }
          }
  expect(checked).toBe(384)
})

// ---- The resume floor: two tiers of consent (floor design 3, 6.3, 7.2) ----

const ISO = '2026-09-24T14:00:00.000Z'
const UNTIL = Date.parse(ISO)
const BEFORE = UNTIL - 3_600_000 // a now inside the window

test('parseConsent reads an end point, formatConsent writes it, and a 0.2 value has none', () => {
  expect(parseConsent(`S1 ${ISO} to:95`)).toEqual({ until: UNTIL, sessionId: 'S1', to: 95 })
  expect(parseConsent(`S1 ${ISO} to:97.5`)).toEqual({ until: UNTIL, sessionId: 'S1', to: 97.5 })
  expect(parseConsent(`S1 ${ISO} to:0.1`)).toEqual({ until: UNTIL, sessionId: 'S1', to: 0.1 })
  expect(formatConsent('S1', UNTIL, 95)).toBe(`S1 ${ISO} to:95`)
  expect(formatConsent('S1', UNTIL, 97.5)).toBe(`S1 ${ISO} to:97.5`)
  expect(formatConsent('S1', UNTIL, 97.54)).toBe(`S1 ${ISO} to:97.5`)
  expect(formatConsent('S1', UNTIL)).toBe(`S1 ${ISO}`)
  for (const to of [95, 97.5, 99.9]) expect(parseConsent(formatConsent('S2', UNTIL, to))).toEqual({ until: UNTIL, sessionId: 'S2', to })
  // A 0.2 value and a bare time are full: no `to` key at all.
  const full = parseConsent(`S1 ${ISO}`)
  expect(full).toEqual({ until: UNTIL, sessionId: 'S1' })
  expect(full !== undefined && 'to' in full).toBe(false)
  const bare = parseConsent(ISO)
  expect(bare).toEqual({ until: UNTIL })
  expect(bare !== undefined && 'to' in bare).toBe(false)
})

test('parseConsent refuses a junk end point, a fourth token and an end point after a bare time', () => {
  for (const raw of [
    `S1 ${ISO} to:abc`,
    `S1 ${ISO} to:0`,
    `S1 ${ISO} to:100`,
    `S1 ${ISO} to:95.55`,
    `S1 ${ISO} to:`,
    `S1 ${ISO} 95`,
    `S1 ${ISO} to:95 x`,
    `${ISO} to:95`,
    `S1 soon to:95`,
  ]) {
    expect(parseConsent(raw)).toBeUndefined()
  }
})

test('consentApplies: a full consent in its window, a consent to the floor only below min(to, point)', () => {
  const full: Consent = { until: UNTIL }
  const floor: Consent = { until: UNTIL, to: 95 }
  expect(consentApplies(full, BEFORE, UNTIL, 99, 95)).toBe(true)
  expect(consentApplies(full, UNTIL, UNTIL, 50, 95)).toBe(false) // the window ended
  expect(consentApplies(floor, BEFORE, UNTIL, 94.9, 95)).toBe(true)
  expect(consentApplies(floor, BEFORE, UNTIL, 95, 95)).toBe(false) // pct = to
  expect(consentApplies(floor, BEFORE, UNTIL, 93, 92)).toBe(false) // a lower point in force wins
  expect(consentApplies(floor, BEFORE, UNTIL, 91.9, 92)).toBe(true)
  expect(consentApplies(floor, BEFORE, UNTIL, 95, 97)).toBe(false) // a higher point in force does not raise it
  expect(consentApplies(floor, BEFORE, UNTIL, 94.9, 97)).toBe(true)
  expect(consentApplies(floor, BEFORE, UNTIL, 94.9, null)).toBe(true) // point null uses to
  expect(consentApplies(floor, BEFORE, UNTIL, 95, null)).toBe(false)
  expect(consentApplies(floor, BEFORE, UNTIL - 2 * 60_000, 50, 95)).toBe(false) // a later window: not this one
  expect(endOf(95, null)).toBe(95)
  expect(endOf(95, 97)).toBe(95)
  expect(endOf(95, 92)).toBe(92)
})

test('floorEnded: a consent to the floor at its end point in its window, never a full one, never out of its window', () => {
  const floor: Consent = { until: UNTIL, to: 95 }
  expect(floorEnded(floor, BEFORE, UNTIL, 95, 95)).toBe(true)
  expect(floorEnded(floor, BEFORE, UNTIL, 99, 95)).toBe(true)
  expect(floorEnded(floor, BEFORE, UNTIL, 94.9, 95)).toBe(false)
  expect(floorEnded(floor, BEFORE, UNTIL, 92, 92)).toBe(true) // the end point now
  expect(floorEnded({ until: UNTIL }, BEFORE, UNTIL, 99, 95)).toBe(false)
  expect(floorEnded(floor, UNTIL, UNTIL, 99, 95)).toBe(false) // the window ended: it ends by time
  expect(floorEnded(floor, BEFORE, UNTIL - 2 * 60_000, 99, 95)).toBe(false) // another window
})

test('coveringConsent prefers a full consent, else the highest end point, and endedFloor finds a consent at its end point', () => {
  const full: Consent = { until: UNTIL }
  const f93: Consent = { until: UNTIL, to: 93 }
  const f95: Consent = { until: UNTIL, to: 95 }
  expect(coveringConsent([f95, full], BEFORE, UNTIL, 92, 95)).toEqual(full)
  expect(coveringConsent([f93, f95], BEFORE, UNTIL, 92, 95)).toEqual(f95)
  expect(coveringConsent([f93, f95], BEFORE, UNTIL, 94, 95)).toEqual(f95)
  expect(coveringConsent([f93, f95], BEFORE, UNTIL, 95, 95)).toBeUndefined()
  expect(coveringConsent([f93], BEFORE, UNTIL, 93, 95)).toBeUndefined()
  expect(coveringConsent([full, f95], BEFORE, UNTIL, 99, 95)).toEqual(full)
  expect(coveringConsent([], BEFORE, UNTIL, 92, 95)).toBeUndefined()
  expect(coveringConsent([{ until: UNTIL - 60_000 }, { until: UNTIL }], BEFORE, UNTIL, 92, 95)).toEqual({ until: UNTIL })
  expect(endedFloor([f93, f95, full], BEFORE, UNTIL, 96, 95)).toEqual(f95)
  expect(endedFloor([f93, f95], BEFORE, UNTIL, 94, 95)).toEqual(f93)
  expect(endedFloor([f95], BEFORE, UNTIL, 94, 95)).toBeUndefined()
  expect(endedFloor([full], BEFORE, UNTIL, 99, 95)).toBeUndefined()
})

test('noteSlot keeps the later full until and the latest consent to the floor, and withoutFloor keeps the full one', () => {
  const a = noteSlot(undefined, { until: UNTIL, to: 95 })
  expect(a).toEqual({ floor: { until: UNTIL, to: 95 } })
  expect(noteSlot(a, { until: UNTIL, to: 97 })).toEqual({ floor: { until: UNTIL, to: 97 } }) // the same until, a higher to
  expect(noteSlot(a, { until: UNTIL, to: 93 })).toEqual(a) // a lower to never replaces
  expect(noteSlot(a, { until: UNTIL - 1, to: 99 })).toEqual(a) // an earlier until never does
  expect(noteSlot(a, { until: UNTIL + 1, to: 93 })).toEqual({ floor: { until: UNTIL + 1, to: 93 } }) // a later until does
  const b = noteSlot(noteSlot(a, { until: UNTIL }), { until: UNTIL - 5 })
  expect(b).toEqual({ full: UNTIL, floor: { until: UNTIL, to: 95 } })
  expect(slotList(b)).toEqual([{ until: UNTIL }, { until: UNTIL, to: 95 }])
  expect(slotList(undefined)).toEqual([])
  expect(withoutFloor(b)).toEqual({ full: UNTIL })
  expect(withoutFloor(a)).toBeUndefined()
  expect(withoutFloor(undefined)).toBeUndefined()
})

test('buried: a tomb buries a consent to the floor with its until and an end point at or below its own, never a full one', () => {
  const tombs: Tomb[] = [{ until: UNTIL, to: 95 }]
  expect(buried(tombs, { until: UNTIL, to: 95 })).toBe(true)
  expect(buried(tombs, { until: UNTIL, to: 93 })).toBe(true) // a lower end point ended too
  expect(buried(tombs, { until: UNTIL, to: 97.5 })).toBe(false) // a higher end point did not
  expect(buried(tombs, { until: UNTIL })).toBe(false) // a full consent never
  expect(buried(tombs, { until: UNTIL + 1000, to: 95 })).toBe(false) // another time in the value
  expect(buried(tombs, { until: UNTIL - 1000, to: 95 })).toBe(false)
  expect(buried([], { until: UNTIL, to: 95 })).toBe(false)
  expect(buried(undefined, { until: UNTIL, to: 95 })).toBe(false)
  // parseConsent gives the value of any stamp: a restamp under a new id is buried too.
  const restamped = parseConsent(formatConsent('S2', UNTIL, 95))
  expect(restamped !== undefined && buried(tombs, restamped)).toBe(true)
})

test('bury adds a tomb, keeps the highest end point per until, and drops a tomb whose window reset', () => {
  const a = bury(undefined, { until: UNTIL, to: 95 }, BEFORE)
  expect(a).toEqual([{ until: UNTIL, to: 95 }])
  expect(bury(a, { until: UNTIL, to: 93 }, BEFORE)).toEqual(a) // covered: nothing new
  expect(bury(a, { until: UNTIL, to: 96.3 }, BEFORE)).toEqual([{ until: UNTIL, to: 96.3 }]) // a higher end point replaces
  const later = UNTIL + 5 * 3_600_000
  expect(bury(a, { until: later, to: 95 }, BEFORE)).toEqual([
    { until: UNTIL, to: 95 },
    { until: later, to: 95 },
  ])
  // A tomb ends when its window resets: at its until, it goes, and a tomb for a past window is never added.
  expect(bury(a, { until: later, to: 95 }, UNTIL)).toEqual([{ until: later, to: 95 }])
  expect(bury(a, { until: UNTIL, to: 97 }, UNTIL)).toEqual([])
})

test('unbury: a new Resume lifts each tomb that buries its consent, and keeps the others', () => {
  const later = UNTIL + 5 * 3_600_000
  const tombs: Tomb[] = [
    { until: UNTIL, to: 96.3 },
    { until: later, to: 95 },
  ]
  expect(unbury(tombs, { until: UNTIL, to: 95 })).toEqual([{ until: later, to: 95 }])
  expect(unbury(tombs, { until: UNTIL, to: 97.5 })).toEqual(tombs) // not buried: nothing to lift
  expect(unbury(tombs, { until: UNTIL })).toEqual(tombs) // a full consent is never buried
  expect(unbury(undefined, { until: UNTIL, to: 95 })).toEqual([])
  expect(buried(unbury(tombs, { until: UNTIL, to: 95 }), { until: UNTIL, to: 95 })).toBe(false)
})

test('answers: a Resume answers a kind only on its basis and below its end point, and a full Resume on its basis always', () => {
  const atReserve: Answered[] = [{ kind: 'five_hour', test: false, to: 95 }]
  expect(answers(atReserve, { kind: 'five_hour', pct: 94.9, test: false })).toBe(true)
  expect(answers(atReserve, { kind: 'five_hour', pct: 95, test: false })).toBe(false)
  expect(answers(atReserve, { kind: 'seven_day', pct: 91, test: false })).toBe(false)
  const full: Answered[] = [{ kind: 'five_hour', test: false }]
  expect(answers(full, { kind: 'five_hour', pct: 99, test: false })).toBe(true)
  // A test Answered never answers a real view, and the other way round.
  expect(answers([{ kind: 'five_hour', test: true }], { kind: 'five_hour', pct: 91, test: false })).toBe(false)
  expect(answers(full, { kind: 'five_hour', pct: 91, test: true })).toBe(false)
  expect(answers([], { kind: 'five_hour', pct: 91, test: false })).toBe(false)
})

test('joinableAt: a settled Resume at the reserve takes no joiner past its end point or on another basis, and joinable keeps its 0.2 result', () => {
  const named: Answered[] = [{ kind: 'five_hour', test: false, to: 95 }]
  expect(joinableAt('resume', named, [{ kind: 'five_hour', pct: 93, test: false }])).toBe(true)
  expect(joinableAt('resume', named, [{ kind: 'five_hour', pct: 96, test: false }])).toBe(false)
  expect(joinableAt('resume', named, [{ kind: 'five_hour', pct: 93, test: true }])).toBe(false)
  expect(joinableAt(undefined, named, [{ kind: 'five_hour', pct: 99, test: true }])).toBe(true) // an open question takes every joiner
  expect(joinableAt('stop', named, [{ kind: 'seven_day', pct: 99, test: false }])).toBe(true)
  expect(joinableAt('again', named, [])).toBe(false)
  // The 0.2 cases of joinable, through joinableAt with no end points and one basis.
  const v = (kind: 'five_hour' | 'seven_day') => ({ kind, pct: 93, test: false })
  const a = (kind: 'five_hour' | 'seven_day') => ({ kind, test: false })
  const cases: Array<[Parameters<typeof joinable>[0], Array<'five_hour' | 'seven_day'>, Array<'five_hour' | 'seven_day'>]> = [
    [undefined, ['five_hour'], ['seven_day']],
    ['stop', ['five_hour'], ['five_hour', 'seven_day']],
    ['resume', ['five_hour'], ['five_hour']],
    ['resume', ['five_hour'], ['five_hour', 'seven_day']],
    ['resume', ['five_hour', 'seven_day'], ['seven_day']],
    ['resume', ['five_hour'], []],
    ['again', ['five_hour'], ['five_hour']],
  ]
  for (const [o, named2, gating] of cases) {
    expect(joinableAt(o, named2.map(a), gating.map(v))).toBe(joinable(o, named2, gating))
  }
})

test('answersQuestion: a full consent answers any kind, a consent to the floor only a kind asked at the reserve with an end point at least as high', () => {
  const atReserve = { end: UNTIL, to: 95 }
  const atFloor = { end: UNTIL }
  expect(answersQuestion({ until: UNTIL }, atReserve, BEFORE)).toBe(true)
  expect(answersQuestion({ until: UNTIL }, atFloor, BEFORE)).toBe(true)
  expect(answersQuestion({ until: UNTIL, to: 95 }, atReserve, BEFORE)).toBe(true)
  expect(answersQuestion({ until: UNTIL, to: 97 }, atReserve, BEFORE)).toBe(true)
  expect(answersQuestion({ until: UNTIL, to: 93 }, atReserve, BEFORE)).toBe(false)
  expect(answersQuestion({ until: UNTIL, to: 95 }, atFloor, BEFORE)).toBe(false)
  expect(answersQuestion({ until: UNTIL }, atReserve, UNTIL)).toBe(false) // expired
  expect(answersQuestion({ until: UNTIL + 2 * 60_000 }, atReserve, BEFORE)).toBe(false) // another window
})

test('fullCovers keeps a full value of this process for the same window, and nothing else', () => {
  expect(fullCovers({ until: UNTIL, sessionId: 'S1' }, ['S1'], UNTIL, BEFORE)).toBe(true)
  expect(fullCovers({ until: UNTIL, sessionId: 'S0' }, ['S0', 'S1'], UNTIL, BEFORE)).toBe(true) // a past id of this process
  expect(fullCovers({ until: UNTIL, sessionId: 'S9' }, ['S1'], UNTIL, BEFORE)).toBe(false) // another id
  expect(fullCovers({ until: UNTIL, sessionId: 'S1', to: 95 }, ['S1'], UNTIL, BEFORE)).toBe(false) // a consent to the floor
  expect(fullCovers({ until: UNTIL - 3_600_000 * 5, sessionId: 'S1' }, ['S1'], UNTIL, BEFORE)).toBe(false) // expired
  expect(fullCovers({ until: UNTIL + 3_600_000, sessionId: 'S1' }, ['S1'], UNTIL, BEFORE)).toBe(false) // another window
  expect(fullCovers({ until: UNTIL }, ['S1'], UNTIL, BEFORE)).toBe(false) // a bare time has no stamp
  expect(fullCovers(undefined, ['S1'], UNTIL, BEFORE)).toBe(false)
})

test('stageKey and keyStage round-trip the floor stage', () => {
  expect(stageKey('S1:main', false)).toBe('S1:main')
  expect(stageKey('S1:main', true)).toBe('S1:main:floor')
  expect(keyStage('S1:main')).toEqual({ base: 'S1:main', atFloor: false })
  expect(keyStage('S1:a1:floor')).toEqual({ base: 'S1:a1', atFloor: true })
  for (const key of ['S1:main', 'S2:a7']) for (const f of [true, false]) expect(keyStage(stageKey(key, f))).toEqual({ base: key, atFloor: f })
})
