import type { SessionRateLimit } from 'claude-code'
import { DEFAULTS, withEnv } from '../../hooks/core/config.ts'
import type { Effective, EnvReads, Settings, Spans } from '../../hooks/core/config.ts'
import { formatConsent } from '../../hooks/core/decide.ts'
import type { Answered, Consent, Holder, StoppedRecord } from '../../hooks/core/decide.ts'
import {
  againNotice,
  answeredOf,
  answersKind,
  byKind,
  checksStop,
  claimTold,
  commandHolders,
  consentBeyond,
  consentEnd,
  consentOfEnd,
  consentedOf,
  dueMargin,
  dueRelease,
  dueStep,
  dueWait,
  endedFor,
  extendNotice,
  extended,
  factsFrom,
  floorEndsOf,
  gatesAfter,
  handoverTakes,
  holdersFrom,
  modeOf,
  namedKinds,
  namedOf,
  namedStop,
  needsRealList,
  newTold,
  noFloor,
  notStartedFor,
  questionEdges,
  questionOf,
  raiseAtFloor,
  raisesInPlace,
  realBound,
  realHolder,
  refusalText,
  resetOf,
  resetTooRecent,
  resumeCase,
  resumeNotice,
  resumeReadReply,
  resumeTo,
  seenOf,
  seenSplit,
  sensedNote,
  sensesOf,
  simulateOpens,
  simulateText,
  splitFrom,
  statusInput,
  stillHeld,
  stopAskingIdle,
  stopAskingReply,
  stopCase,
  stopInForce,
  stopKept,
  stopKeptReply,
  stopNewer,
  stopNotice,
  stopOpenNotice,
  stopOverdueReply,
  stopPlan,
  stopRecordOf,
  stopTrippedReply,
  stopWriteOf,
  takenOf,
  takeoverSense,
  tellText,
  testReading,
  tickPlan,
  toldHas,
  toldMainOf,
  toldNotice,
  tripOf,
  unansweredGating,
  unansweredHolders,
  unattendedLines,
  untilOf,
  verdictOf,
  viewedOf,
  windowEndFor,
  withRealEntries,
} from '../../hooks/core/flow.ts'
import type { Bases, FallbackEnds, KindSense, Late, Mems, QuestionCore, Sensed, Sourced, Split, StopSense, Told } from '../../hooks/core/flow.ts'
import { FALLBACK_MS, RESET_MARGIN_MS, TEST_MARGIN_MS, initialMemory } from '../../hooks/core/reading.ts'
import type { Basis, Kind } from '../../hooks/core/reading.ts'
import {
  atText,
  clockText,
  consentWarning,
  debugLine,
  factsOf,
  headlessText,
  leadText,
  notStarted,
  notice,
  pauseInstruction,
  pausedText,
  resumeReply,
  simulateReply,
  stopReply,
  stopText,
  untilFor,
  untilPhrase,
} from '../../hooks/core/text.ts'
import type { Ended, Facts } from '../../hooks/core/text.ts'

// The shared cases of hooks/core/flow.ts (Codex design 8.1, 8.2). tests/core/flow.test.ts runs them with
// the Claude host words, and codex/test/flow.spec.ts with the Codex words. So a case never compares a
// text with a literal: it builds the expected text with the same core text function, and pins which
// text and which figures the step chooses. Structural results (records, times, lists) are literal.
// Pure: this file imports core files only, never a test kit. Each case calls `eq(got, want)` for a deep
// equality, which each runner supplies.

export type Eq = (got: unknown, want: unknown) => void
export type FlowCase = { name: string; run: (eq: Eq) => void }

const MIN = 60_000
const HOUR = 3_600_000
const R = Date.parse('2026-09-24T15:00:00.000Z') // the 5-hour reset
const W = Date.parse('2026-09-27T15:00:00.000Z') // the weekly reset
const NOW = R - 2 * HOUR // 13:00, before the 5-hour skip start (R - 20 min)
const SKIP5 = R - 20 * MIN // the 5-hour skip start with the shipped span
const SPANS: Spans = { lastMinutes: 20, weeklyLastHours: 8 } // the shipped spans
const NO_SPANS: Spans = { lastMinutes: 0, weeklyLastHours: 0 }

const cfgOf = (env: EnvReads = {}, over: Partial<Settings> = {}): Effective => withEnv({ ...DEFAULTS, ...over }, env)
const live = (pct: number, resetsAtMs: number | null): Basis => ({ kind: 'live', pct, resetsAtMs })
const testB = (pct: number, resetsAtMs: number): Basis => ({ kind: 'test', pct, resetsAtMs })
const NONE: Basis = { kind: 'none', why: 'no-reading' }
const mems = (): Mems => ({ five_hour: initialMemory(), seven_day: initialMemory() })

/** Both kinds: the view basis, and the real basis beneath (the view basis, unless it is a test reading). */
function basesOf(five: Basis, week: Basis = NONE, real: { five?: Basis; week?: Basis } = {}): Bases {
  return {
    five_hour: { basis: five, real: real.five ?? (five.kind === 'test' ? NONE : five) },
    seven_day: { basis: week, real: real.week ?? (week.kind === 'test' ? NONE : week) },
  }
}

type World = { five: Basis; week?: Basis; real?: { five?: Basis; week?: Basis }; cfg?: Effective; now?: number; spans?: Spans; attended?: boolean }

/** A sense as the gate builds it. */
function sensed(w: World): Sensed {
  const cfg = w.cfg ?? cfgOf()
  const now = w.now ?? NOW
  const kinds = sensesOf(cfg, basesOf(w.five, w.week, w.real), w.spans ?? SPANS, now, {}, mems()).kinds
  const attended = w.attended ?? true
  return { cfg, now, kinds: attended ? kinds : kinds.map(noFloor), tripped: kinds.some((k) => k.tripped), attended }
}

function kindIn(s: Pick<Sensed, 'kinds'>, kind: Kind): KindSense {
  const k = s.kinds.find((x) => x.kind === kind)
  if (k === undefined) throw new Error(`no ${kind} in the sense`)
  return k
}

/** A 5-hour sense at 92% used, reset R, now NOW, shipped spans: in the reserve, the skip start ahead. */
const s92 = (): Sensed => sensed({ five: live(92, R), week: live(50, W) })
const k92 = (): KindSense => kindIn(s92(), 'five_hour')

const fiveFacts = (pct: number, resetsAtMs: number | null): Facts => factsOf(live(pct, resetsAtMs), 10, undefined, 'five_hour', NOW)

/** A question as the gate opens it, with overrides. */
function question(s: Sensed, over: Partial<QuestionCore> = {}, opener: 'loop' | 'prompt' = 'loop'): QuestionCore {
  const gating = s.kinds.filter((k) => k.tripped && !k.open)
  return { ...questionOf(opener, s, { gating, holders: commandHolders(gating) }, s.now), ...over }
}

const stopRec = (over: Partial<StoppedRecord> = {}): StoppedRecord => ({ sessionId: 'S1', windowEnd: R, at: NOW - HOUR, kinds: ['five_hour'], work: false, auto: true, test: false, ...over })

const split = (over: Partial<Split> = {}): Split => ({ gating: [], open: [], consented: [], ...over })

// ---- The sense of each kind ----

const senseCases: FlowCase[] = [
  {
    name: 'sensesOf: a 5-hour reading in the reserve with its skip start ahead, and a weekly one below it',
    run: (eq) => {
      const r = sensesOf(cfgOf(), basesOf(live(92, R), live(50, W)), SPANS, NOW, {}, mems())
      eq(r.edges, [SKIP5]) // only a tripped kind's skip start is an edge
      eq(r.kinds[0], {
        kind: 'five_hour',
        reserve: 10,
        basis: live(92, R),
        tripped: true,
        windowEnd: R,
        holdEnd: SKIP5,
        stopEnd: SKIP5,
        span: 20 * MIN,
        skipAt: SKIP5,
        open: false,
        test: false,
        seed: false,
        realIn: true,
        realReset: R,
        floor: 5,
        point: 95,
        atFloor: false,
        realPct: 92,
      })
      eq(r.kinds[1], {
        kind: 'seven_day',
        reserve: 10,
        basis: live(50, W),
        tripped: false,
        windowEnd: W,
        holdEnd: W - 8 * HOUR,
        stopEnd: W - 8 * HOUR,
        span: 8 * HOUR,
        skipAt: W - 8 * HOUR,
        open: false,
        test: false,
        seed: false,
        realIn: false,
        realReset: W,
        floor: 5,
        point: 95,
        atFloor: false,
        realPct: 50,
      })
    },
  },
  {
    name: 'sensesOf: in the last span a tripped kind is open, with no skip start and the reset as its hold end (B41)',
    run: (eq) => {
      const r = sensesOf(cfgOf(), basesOf(live(92, R)), SPANS, R - 10 * MIN, {}, mems())
      const k = r.kinds[0]
      eq(r.edges, [])
      eq([k?.tripped, k?.open, k?.skipAt, k?.holdEnd, k?.stopEnd, k?.realIn, k?.atFloor], [true, true, null, R, R, false, false])
    },
  },
  {
    name: 'sensesOf: one fallback end per kind and episode, and a reset ends the episode (R11)',
    run: (eq) => {
      const fallback: FallbackEnds = {}
      const at = (now: number, b: Basis): KindSense | undefined => sensesOf(cfgOf(), basesOf(b), SPANS, now, fallback, mems(), ['five_hour']).kinds[0]
      eq(at(NOW, live(92, null))?.windowEnd, NOW + FALLBACK_MS)
      eq(at(NOW + 30 * MIN, live(92, null))?.windowEnd, NOW + FALLBACK_MS)
      eq(fallback, { five_hour: NOW + FALLBACK_MS })
      eq(at(NOW + FALLBACK_MS, live(92, null))?.windowEnd, NOW + 2 * FALLBACK_MS) // the old one ended: a new episode
      eq(at(NOW + FALLBACK_MS, live(92, R))?.windowEnd, R)
      eq(fallback, {})
      // No reset time: never open, no skip start, and the hold end is one window from the first sight.
      const k = at(NOW, live(92, null))
      eq([k?.open, k?.skipAt, k?.holdEnd], [false, null, NOW + 5 * HOUR])
    },
  },
  {
    name: 'windowEndFor: a basis with a reset is its own bound, and drops the fallback',
    run: (eq) => {
      const fallback: FallbackEnds = { five_hour: NOW + 10 * MIN, seven_day: NOW + 20 * MIN }
      eq(windowEndFor('five_hour', live(92, R), NOW, fallback), R)
      eq(fallback, { seven_day: NOW + 20 * MIN })
      eq(windowEndFor('seven_day', NONE, NOW, fallback), NOW + 20 * MIN)
    },
  },
  {
    name: 'sensesOf: floor points and the floor stage (B48, B54)',
    run: (eq) => {
      const at96 = kindIn(sensed({ five: live(96, R) }), 'five_hour')
      eq([at96.floor, at96.point, at96.atFloor], [5, 95, true])
      const off = kindIn(sensed({ five: live(96, R), cfg: cfgOf({}, { resumeFloor: 0 }) }), 'five_hour')
      eq([off.floor, off.point, off.atFloor], [0, null, false])
      const high = kindIn(sensed({ five: live(96, R), cfg: cfgOf({}, { resumeFloor: 12 }) }), 'five_hour') // not below the reserve
      eq([high.floor, high.point, high.atFloor], [0, null, false])
      const loose = kindIn(sensed({ five: live(96, R), attended: false }), 'five_hour') // B55
      eq([loose.floor, loose.point, loose.atFloor], [0, null, false])
    },
  },
  {
    name: 'sensesOf: a test window in its last span yields to a real trip that is not open (B45)',
    run: (eq) => {
      const k = kindIn(sensed({ five: testB(95, NOW + 10 * MIN), real: { five: live(92, R) } }), 'five_hour')
      eq([k.basis, k.test, k.open, k.realIn, k.windowEnd, k.skipAt], [live(92, R), false, false, true, R, SKIP5])
    },
  },
  {
    name: 'sensesOf: a test reading over a real trip keeps the real figures beneath (TS1)',
    run: (eq) => {
      const k = kindIn(sensed({ five: testB(97, R), real: { five: live(92, R) } }), 'five_hour')
      eq([k.test, k.realIn, k.realReset, k.realPct, pctIs(k, 97)], [true, true, R, 92, true])
    },
  },
  {
    name: 'sensesOf: the watched kinds follow the weekly reserve, or the given list',
    run: (eq) => {
      const kinds = (cfg: Effective, watched?: readonly Kind[]): Kind[] =>
        sensesOf(cfg, basesOf(live(92, R), live(92, W)), SPANS, NOW, {}, mems(), watched).kinds.map((k) => k.kind)
      eq(kinds(cfgOf()), ['five_hour', 'seven_day'])
      eq(kinds(cfgOf({}, { weeklyReserve: 0 })), ['five_hour'])
      eq(kinds(cfgOf(), ['seven_day']), ['seven_day'])
    },
  },
  {
    name: 'resumeTo, noFloor and realBound: the tier of a Resume at the reserve (B48, B55, TS1)',
    run: (eq) => {
      eq(resumeTo(k92()), 95)
      eq(resumeTo(kindIn(sensed({ five: live(96, R) }), 'five_hour')), undefined) // at the floor: a full Resume
      eq(resumeTo(kindIn(sensed({ five: live(92, R), now: R - 10 * MIN }), 'five_hour')), undefined) // open
      eq(resumeTo(noFloor(k92())), undefined)
      eq(realBound(k92(), NOW), R)
      const t = kindIn(sensed({ five: testB(97, R + HOUR), real: { five: live(92, null) } }), 'five_hour')
      eq(realBound(t, NOW), NOW + FALLBACK_MS) // beneath a test reading: the real reset, else one hour
    },
  },
  {
    name: 'testReading: in from now, else the live reset while it is ahead and within one window, else one window from now',
    run: (eq) => {
      const at = (t: number): SessionRateLimit => ({ kind: 'five_hour', percentUsed: 40, resetsAt: new Date(t).toISOString() })
      eq(testReading(92, 'five_hour', undefined, NOW), { pct: 92, resetsAtMs: NOW + 5 * HOUR })
      eq(testReading(92, 'seven_day', undefined, NOW), { pct: 92, resetsAtMs: NOW + 7 * 24 * HOUR })
      eq(testReading(92, 'five_hour', at(R), NOW), { pct: 92, resetsAtMs: R })
      eq(testReading(92, 'five_hour', at(R), NOW, 2 * MIN), { pct: 92, resetsAtMs: NOW + 2 * MIN })
      eq(testReading(92, 'five_hour', at(NOW + 10 * MIN), NOW), { pct: 92, resetsAtMs: NOW + 10 * MIN }) // near, still ahead: borrowed
      eq(testReading(92, 'five_hour', at(R - 6 * HOUR), NOW), { pct: 92, resetsAtMs: NOW + 5 * HOUR }) // passed: as no live reading
      eq(testReading(92, 'five_hour', at(NOW), NOW), { pct: 92, resetsAtMs: NOW + 5 * HOUR }) // at the reset: passed
      eq(testReading(92, 'five_hour', at(NOW + 6 * HOUR), NOW), { pct: 92, resetsAtMs: NOW + 5 * HOUR }) // more than one window ahead
      eq(testReading(92, 'seven_day', { kind: 'seven_day', percentUsed: 40, resetsAt: new Date(W).toISOString() }, NOW), { pct: 92, resetsAtMs: W })
      eq(testReading(92, 'seven_day', { kind: 'seven_day', percentUsed: 40, resetsAt: new Date(NOW - HOUR).toISOString() }, NOW), { pct: 92, resetsAtMs: NOW + 7 * 24 * HOUR })
    },
  },
  {
    name: 'resetTooRecent: a real reset in the reserve less than 5 minutes ago holds a release (4.8)',
    run: (eq) => {
      const m = (resetsAtMs: number, pct: number): Mems => ({ five_hour: { misses: 0, seed: { pct, resetsAtMs } }, seven_day: initialMemory() })
      const s = s92()
      eq(resetTooRecent(s, m(NOW - 2 * MIN, 95)), true)
      eq(resetTooRecent(s, m(NOW - 6 * MIN, 95)), false)
      eq(resetTooRecent(s, m(NOW - 2 * MIN, 50)), false) // not in the reserve
      eq(resetTooRecent(s, mems()), false)
    },
  },
  {
    name: 'modeOf and viewedOf',
    run: (eq) => {
      eq(modeOf(cfgOf()), 'hold')
      eq(modeOf(cfgOf({ pausePrompt: 'Finish, then stop.' })), 'tell')
      eq(viewedOf(k92()), { kind: 'five_hour', pct: 92, test: false })
      eq(viewedOf(kindIn(sensed({ five: NONE }), 'five_hour')), { kind: 'five_hour', pct: 0, test: false })
    },
  },
]

function pctIs(k: KindSense, pct: number): boolean {
  return k.basis.kind !== 'none' && k.basis.pct === pct
}

// ---- Facts and texts ----

const textCases: FlowCase[] = [
  {
    name: 'factsFrom: a hold end that is not the reset, the span of a skip owner, the floor and the end point',
    run: (eq) => {
      const k = k92()
      eq(factsFrom([k], NOW), [{ ...fiveFacts(92, R), holdEnd: SKIP5 }])
      eq(factsFrom([k], NOW, true, resumeTo), [{ ...fiveFacts(92, R), holdEnd: SKIP5, span: 20 * MIN, to: 95 }])
      const f = kindIn(sensed({ five: live(96, R), spans: NO_SPANS }), 'five_hour')
      eq(factsFrom([f], NOW), [{ ...fiveFacts(96, R), floor: 5 }]) // the hold end is the reset: no holdEnd
      const t = kindIn(sensed({ five: testB(97, R), real: { five: NONE }, spans: NO_SPANS }), 'five_hour')
      eq(factsFrom([t], NOW), [{ ...factsOf(testB(97, R), 10, undefined, 'five_hour', NOW), test: true, floor: 5 }])
    },
  },
  {
    name: 'namedKinds, refusalText, tellText and notStartedFor name the gating kinds, else the tripped ones',
    run: (eq) => {
      const s = sensed({ five: live(92, R), week: live(93, W) })
      const five = kindIn(s, 'five_hour')
      eq(namedKinds(s, { gating: [five] }), [five])
      eq(namedKinds(s, { gating: [] }), s.kinds)
      const f = factsFrom([five], NOW)
      eq(refusalText('stop', s, { gating: [five] }, 'S1'), stopText(f))
      eq(refusalText('paused', s, { gating: [five] }, 'S1'), pausedText(f))
      eq(refusalText('headless', s, { gating: [five] }, 'S9'), headlessText(f, 'S9'))
      const tell = sensed({ five: live(92, R), cfg: cfgOf({ pausePrompt: 'Wrap up.' }) })
      eq(tellText(tell, { gating: [] }), pauseInstruction(factsFrom(tell.kinds.filter((k) => k.tripped), NOW), 'Wrap up.'))
      eq(notStartedFor(s, { gating: [five] }), notStarted(f))
    },
  },
  {
    name: 'consentEnd: the end point now of a covering consent to the floor, none for a full one (floor 6.6)',
    run: (eq) => {
      const k = k92()
      eq(consentEnd([{ k, c: { until: R, to: 97 } }])(k), 95) // the floor point is lower
      eq(consentEnd([{ k, c: { until: R, to: 93 } }])(k), 93)
      eq(consentEnd([{ k, c: { until: R } }])(k), undefined)
      eq(consentEnd([])(k), undefined)
    },
  },
  {
    name: 'namedOf, answeredOf, namedStop, consentOfEnd and byKind',
    run: (eq) => {
      const q = { kinds: ['five_hour', 'seven_day'] as Kind[], ends: { five_hour: { end: R, test: true, to: 95 }, seven_day: { end: W, test: false } } }
      eq(namedOf(q), [
        { kind: 'five_hour', test: true },
        { kind: 'seven_day', test: false },
      ])
      eq(answeredOf(q), [
        { kind: 'five_hour', test: true, to: 95 },
        { kind: 'seven_day', test: false },
      ])
      eq(answeredOf(undefined), [])
      eq(namedStop(stopRec({ kinds: ['seven_day'], test: true })), [{ kind: 'seven_day', test: true }])
      const { kinds: _k, ...old } = stopRec()
      eq(namedStop(old), [{ kind: 'five_hour', test: false }]) // a 0.1 value stops the 5-hour window
      eq(consentOfEnd({ end: R, test: false, to: 95 }), { until: R, to: 95 })
      eq(consentOfEnd({ end: R, test: true, skipAt: SKIP5 }), { until: R })
      const week: Facts = { used: 93, left: 7, resetsAtMs: W, reserve: 10, kind: 'seven_day' }
      eq(byKind([week, fiveFacts(92, R)]), [fiveFacts(92, R), week])
    },
  },
]

// ---- The consent split and the holders ----

const env = (c: Consent, raw = 'raw'): Sourced => ({ c, from: 'env', raw })

const splitCases: FlowCase[] = [
  {
    name: 'splitFrom: the tripped kinds in order, each read once, into consented, gating and open',
    run: (eq) => {
      const s = sensed({ five: live(92, R), week: live(93, W) })
      const asked: Kind[] = []
      const out = splitFrom(
        s.kinds,
        (k) => {
          asked.push(k.kind)
          return { list: k.kind === 'five_hour' ? [env({ until: R })] : [], failed: false }
        },
        NOW,
      )
      eq(asked, ['five_hour', 'seven_day'])
      eq(out, { gating: [kindIn(s, 'seven_day')], open: [], consented: [{ k: kindIn(s, 'five_hour'), c: { until: R } }] })
      eq(splitFrom(s92().kinds, () => ({ list: [], failed: false }), NOW).gating.map((k) => k.kind), ['five_hour']) // 50% weekly: not read
    },
  },
  {
    name: 'splitFrom: a consent to the floor of an open kind leaves it open, a full one consents it (floor 1.3 item 7)',
    run: (eq) => {
      const s = sensed({ five: live(92, R), now: R - 10 * MIN })
      const k = kindIn(s, 'five_hour')
      eq(splitFrom(s.kinds, () => ({ list: [env({ until: R, to: 95 })], failed: false }), s.now), split({ open: [k] }))
      eq(splitFrom(s.kinds, () => ({ list: [env({ until: R })], failed: false }), s.now), split({ consented: [{ k, c: { until: R } }] }))
    },
  },
  {
    name: 'splitFrom: an unreadable list is not consent, and a consent past its window does not apply',
    run: (eq) => {
      const s = s92()
      const k = kindIn(s, 'five_hour')
      eq(splitFrom(s.kinds, () => ({ list: [env({ until: R })], failed: true }), NOW), split({ gating: [k] }))
      eq(splitFrom(s.kinds, () => ({ list: [env({ until: R + 2 * MIN })], failed: false }), NOW), split({ gating: [k] }))
      // A consent to the floor applies below its end point: the full one wins over it, the latest until first.
      eq(splitFrom(s.kinds, () => ({ list: [env({ until: R, to: 95 }), env({ until: R - MIN })], failed: false }), NOW).consented, [{ k, c: { until: R - MIN } }])
    },
  },
  {
    name: 'floorEndsOf: the consents to the floor whose basis reached their end point, and their tombs (B52)',
    run: (eq) => {
      const k = kindIn(sensed({ five: live(96, R) }), 'five_hour')
      const slot: Sourced = { c: { until: R, to: 95 }, from: 'slot' }
      const stored = env({ until: R, to: 95 }, 'S1 x to:95')
      const full = env({ until: R })
      const test: Sourced = { c: { until: R, to: 95 }, from: 'test' }
      eq(floorEndsOf(k, [slot, stored, full, test], NOW), {
        unset: [slot, stored, test],
        tombs: [
          { until: R, to: 95 },
          { until: R, to: 95 },
        ],
      }) // a test consent is never stored: no tomb
      eq(floorEndsOf(k, [slot], NOW, true), { unset: [slot], tombs: [{ until: R, to: 95 }, { until: R, to: 96 }] }) // failed: the real window too
      eq(floorEndsOf(k92(), [slot, stored], NOW), { unset: [], tombs: [] }) // 92 is below 95
      eq(floorEndsOf(k, [env({ until: R + 2 * MIN, to: 95 })], NOW), { unset: [], tombs: [] }) // not in this window
    },
  },
  {
    name: 'floorEndsOf: a test consent ends by the test reading, a real one by the real reading (TS1)',
    run: (eq) => {
      const k = kindIn(sensed({ five: testB(97, R), real: { five: live(92, R) } }), 'five_hour')
      const test: Sourced = { c: { until: R, to: 95 }, from: 'test' }
      const real = env({ until: R, to: 95 })
      eq(floorEndsOf(k, [test, real], NOW), { unset: [test], tombs: [] })
    },
  },
  {
    name: 'holdersFrom: a real reading gates as the view says, and beneath a test reading unless a real consent covers it',
    run: (eq) => {
      const s = s92()
      const k = kindIn(s, 'five_hour')
      let reads = 0
      const none = (): Sourced[] => {
        reads += 1
        return []
      }
      eq(holdersFrom(s.kinds, [k], none, NOW), [{ kind: 'five_hour', resetsAtMs: R }])
      eq(holdersFrom(s.kinds, [], none, NOW), []) // consented: not gating
      eq(reads, 0) // a real view needs no read
      const t = sensed({ five: testB(97, R), real: { five: live(92, R) } })
      const tk = kindIn(t, 'five_hour')
      eq(needsRealList(tk), true)
      eq(needsRealList(k), false)
      eq(holdersFrom(t.kinds, [], none, NOW), [{ kind: 'five_hour', resetsAtMs: R }])
      eq(reads, 1)
      eq(holdersFrom(t.kinds, [], () => [env({ until: R })], NOW), [])
      eq(holdersFrom(t.kinds, [], () => [env({ until: R, to: 95 })], NOW), []) // 92 is below the end point
      eq(realHolder(tk), { kind: 'five_hour', resetsAtMs: R })
      eq(commandHolders(t.kinds), [{ kind: 'five_hour', resetsAtMs: R }])
    },
  },
]

// ---- The verdict and the told keys ----

const verdictCases: FlowCase[] = [
  {
    name: 'verdictOf: hold at the reserve, pass when consented, refuse under a stop (decide rows 3, 7, 9)',
    run: (eq) => {
      const s = s92()
      const k = kindIn(s, 'five_hour')
      const holders: Holder[] = [{ kind: 'five_hour', resetsAtMs: R }]
      const at = (site: 'tool' | 'step' | 'prompt', gating: KindSense[], stopped: boolean, person = false) =>
        verdictOf({ s, site, person, gating, holders, stopped, toldMain: false })
      eq(at('tool', [k], false), { verdict: { kind: 'hold' }, stopped: false, gating: [k], holders })
      eq(at('tool', [], false).verdict, { kind: 'pass', trip: true })
      eq(at('tool', [k], true).verdict, { kind: 'refuse', text: 'stop' })
      eq(at('step', [k], true).verdict, { kind: 'refuse', text: 'paused' })
      eq(at('prompt', [k], true, true).verdict, { kind: 'hold' })
      eq(at('prompt', [k], false, false).verdict, { kind: 'pass', trip: true })
    },
  },
  {
    name: 'verdictOf: no engine fork rule in the core (G8 is a Claude host step)',
    run: (eq) => {
      const s = s92()
      eq(verdictOf({ s, site: 'tool', person: false, gating: [kindIn(s, 'five_hour')], holders: [], stopped: false, toldMain: false }).verdict, { kind: 'hold' })
    },
  },
  {
    name: 'verdictOf: tell mode, the told main loop, and the unattended policies (decide rows 4 to 8)',
    run: (eq) => {
      const tell = sensed({ five: live(92, R), cfg: cfgOf({ pausePrompt: 'Wrap up.' }) })
      const v = (s: Sensed, site: 'tool' | 'step' | 'prompt', o: { person?: boolean; toldMain?: boolean; gating?: KindSense[] } = {}) =>
        verdictOf({ s, site, person: o.person === true, gating: o.gating ?? [kindIn(s, 'five_hour')], holders: [], stopped: false, toldMain: o.toldMain === true }).verdict
      eq(v(tell, 'tool'), { kind: 'tell' })
      eq(v(tell, 'step'), { kind: 'pass', trip: true })
      eq(v(tell, 'prompt', { person: true }), { kind: 'hold' })
      eq(v(tell, 'prompt', { person: true, toldMain: true }), { kind: 'pass', trip: true })
      const stop = sensed({ five: live(92, R), attended: false, cfg: cfgOf({ headless: 'stop' }) })
      eq(v(stop, 'tool'), { kind: 'refuse', text: 'headless' })
      eq(v(stop, 'prompt'), { kind: 'pass', trip: true })
      const wait = sensed({ five: live(92, R), attended: false, cfg: cfgOf({ headless: 'wait' }) })
      eq(v(wait, 'tool'), { kind: 'hold' })
      const seedOnly = { ...kindIn(wait, 'five_hour'), seed: true }
      eq(v(wait, 'tool', { gating: [seedOnly] }), { kind: 'pass', trip: true }) // row 6a
      const off = sensed({ five: live(92, R), attended: false })
      eq(v(off, 'tool'), { kind: 'pass', trip: true })
    },
  },
  {
    name: 'unansweredGating and unansweredHolders: a Resume answers its kinds on its basis and below its end point (B38, B50)',
    run: (eq) => {
      const s = s92()
      const k = kindIn(s, 'five_hour')
      const h: Holder[] = [{ kind: 'five_hour', resetsAtMs: R }]
      const answered = (a: Answered[]): [number, number] => [unansweredGating(a, [k]).length, unansweredHolders(s, a, h).length]
      eq(answered([]), [1, 1])
      eq(answered([{ kind: 'five_hour', test: false }]), [0, 0])
      eq(answered([{ kind: 'five_hour', test: false, to: 95 }]), [0, 0]) // 92 is below 95
      eq(answered([{ kind: 'five_hour', test: false, to: 91 }]), [1, 1]) // past the end point: asks again
      eq(answered([{ kind: 'five_hour', test: true }]), [1, 1]) // another basis
      eq(answered([{ kind: 'seven_day', test: false }]), [1, 1])
      // A holder of a kind the sense does not list reads as 0% on the real basis.
      eq(unansweredHolders({ kinds: [] }, [{ kind: 'seven_day', test: false }], [{ kind: 'seven_day', resetsAtMs: W }]), [])
      eq(unansweredHolders({ kinds: [] }, [{ kind: 'seven_day', test: false, to: 95 }], [{ kind: 'seven_day', resetsAtMs: W }]), [])
    },
  },
  {
    name: 'consentedOf and checksStop: the stop is read only when guarded, attended and not consented',
    run: (eq) => {
      const s = s92()
      const k = kindIn(s, 'five_hour')
      eq([consentedOf(s, []), consentedOf(s, [k])], [true, false])
      eq([checksStop(s, [k]), checksStop(s, [])], [true, false])
      eq(checksStop({ ...s, attended: false }, [k]), false)
      eq(checksStop({ ...s, cfg: cfgOf({ onOff: 'off' }) }, [k]), false)
    },
  },
  {
    name: 'claimTold, toldHas and toldMainOf: one tell per loop at the reserve and one at the floor (B51)',
    run: (eq) => {
      const told: Told = newTold()
      const k = k92()
      eq(toldMainOf(told, [k], 'S1'), false)
      eq(claimTold(told, [k], 'S1:main'), true)
      eq(claimTold(told, [k], 'S1:main'), false)
      eq([toldHas(told, k, 'S1:main'), toldMainOf(told, [k], 'S1'), toldMainOf(told, [k], 'S2'), toldMainOf(told, [], 'S1')], [true, true, false, false])
      const floor = kindIn(sensed({ five: live(96, R) }), 'five_hour')
      eq(toldHas(told, floor, 'S1:main'), false)
      eq(claimTold(told, [floor], 'S1:main'), true)
      eq([...told.five_hour.keys], ['S1:main', 'S1:main:floor'])
      const next = { ...k, windowEnd: R + 5 * HOUR } // a new window starts a new set
      eq(claimTold(told, [next], 'S1:main'), true)
      eq([told.five_hour.windowEnd, [...told.five_hour.keys]], [R + 5 * HOUR, ['S1:main']])
    },
  },
  {
    name: 'toldNotice: once per kind, window and stage (B12, B51)',
    run: (eq) => {
      const s = s92()
      const a = { gating: [kindIn(s, 'five_hour')] }
      const marks: Record<Kind, string> = { five_hour: '', seven_day: '' }
      eq(toldNotice(s, a, marks), notice.told(factsFrom(a.gating, NOW)))
      eq(marks, { five_hour: `${R}:reserve`, seven_day: '' })
      eq(toldNotice(s, a, marks), undefined)
      const f = sensed({ five: live(96, R) })
      eq(toldNotice(f, { gating: [kindIn(f, 'five_hour')] }, marks), notice.told(factsFrom([kindIn(f, 'five_hour')], NOW)))
    },
  },
  {
    name: 'unattendedLines: one debug line per kind and window, in the reserve and open (B15, skip 2.5)',
    run: (eq) => {
      const s = sensed({ five: live(92, R), week: live(93, W), attended: false, now: R - 10 * MIN })
      const marks = { reserve: { five_hour: 0, seven_day: 0 }, open: { five_hour: 0, seven_day: 0 } }
      eq(unattendedLines(s, marks), [
        debugLine.unattended(factsFrom([kindIn(s, 'seven_day')], s.now), 'off'),
        debugLine.unattendedOpen(factsFrom([kindIn(s, 'five_hour')], s.now)),
      ])
      eq(marks, { reserve: { five_hour: 0, seven_day: W }, open: { five_hour: R, seven_day: 0 } })
      eq(unattendedLines(s, marks), [])
    },
  },
]

// ---- The question ----

const questionCases: FlowCase[] = [
  {
    name: 'questionOf: a skip owner, due at its skip start with no margin, notes at it (B42)',
    run: (eq) => {
      const s = s92()
      const k = kindIn(s, 'five_hour')
      const q = questionOf('loop', s, { gating: [k], holders: [{ kind: 'five_hour', resetsAtMs: R }] }, NOW)
      eq(q, {
        kinds: ['five_hour'],
        ends: { five_hour: { end: R, test: false, skipAt: SKIP5, to: 95 } },
        latestEnd: R,
        real: [{ kind: 'five_hour', resetsAtMs: R }],
        stopEnd: SKIP5,
        holdEnd: SKIP5,
        due: SKIP5,
        skip: true,
        noteAt: SKIP5,
        nextCheck: NOW + 60_000,
        silent: false,
        auto: true,
        loops: 1,
        since: NOW,
        mode: 'hold',
        opener: 'loop',
        facts: factsFrom([k], NOW, true, resumeTo),
        handoffs: 0,
        noted: false,
      })
      eq(questionEdges(q), [R, SKIP5, SKIP5, SKIP5, SKIP5])
    },
  },
  {
    name: 'questionOf: spans off, both windows: due after the latest reset plus the margin, notes at the latest end',
    run: (eq) => {
      const s = sensed({ five: live(92, R), week: live(93, W), spans: NO_SPANS })
      const q = questionOf('prompt', s, { gating: s.kinds, holders: [] }, NOW)
      eq(
        [q.kinds, q.ends, q.latestEnd, q.holdEnd, q.stopEnd, q.due, q.skip, q.noteAt, q.loops, q.real],
        [['five_hour', 'seven_day'], { five_hour: { end: R, test: false, to: 95 }, seven_day: { end: W, test: false, to: 95 } }, W, W, W, W + RESET_MARGIN_MS, false, W, 0, []],
      )
      eq(questionEdges(q), [R, W, W, W + RESET_MARGIN_MS, W, W])
    },
  },
  {
    name: 'questionOf: a test reading has the short margin, the floor stage asks for a full Resume, tell and silent',
    run: (eq) => {
      const t = sensed({ five: testB(97, R), real: { five: NONE }, spans: NO_SPANS })
      const q = questionOf('loop', t, { gating: t.kinds.filter((k) => k.tripped), holders: [] }, NOW)
      eq([q.due, q.ends.five_hour], [R + TEST_MARGIN_MS, { end: R, test: true }]) // 97 is past the floor: no tier
      const tell = sensed({ five: live(92, R), cfg: cfgOf({ pausePrompt: 'Wrap up.', autoResume: 'off' }), attended: false })
      const q2 = questionOf('loop', tell, { gating: [kindIn(tell, 'five_hour')], holders: [] }, NOW)
      eq([q2.mode, q2.auto, q2.silent, q2.ends.five_hour?.to], ['tell', false, true, undefined]) // unattended: no floor (B55)
      eq(dueMargin(kindIn(t, 'five_hour')), TEST_MARGIN_MS)
      eq(dueMargin(k92()), 0)
    },
  },
  {
    name: 'questionOf: with no gating kind it names the tripped ones',
    run: (eq) => {
      const s = s92()
      eq(questionOf('loop', s, { gating: [], holders: [] }, NOW).kinds, ['five_hour'])
    },
  },
  {
    name: 'resumeNotice: what continues, or a new window when every bound has passed (B9)',
    run: (eq) => {
      const q = question(s92())
      eq(resumeNotice(q, NOW), notice.continuing(q.facts, 'hold'))
      eq(resumeNotice(q, R), notice.newWindowFor(['five_hour']))
      const both = question(sensed({ five: live(92, R), week: live(93, W), spans: NO_SPANS }), { mode: 'tell' })
      eq(resumeNotice(both, R + MIN), notice.continuing(both.facts.slice(1), 'tell'))
    },
  },
  {
    name: 'raiseAtFloor: resume on a question raises a kind at the floor to a full Resume, in its window only (B50 item 4)',
    run: (eq) => {
      const q = question(sensed({ five: live(92, R), spans: NO_SPANS }))
      const same = { ...q, ends: { ...q.ends }, facts: [...q.facts] }
      raiseAtFloor(same, sensed({ five: live(92, R), spans: NO_SPANS })) // not at the floor
      eq(same.ends, q.ends)
      const at = sensed({ five: live(96, R), spans: NO_SPANS })
      const raised = { ...q, ends: { ...q.ends }, facts: [...q.facts] }
      raiseAtFloor(raised, at)
      eq(raised.ends, { five_hour: { end: R, test: false } })
      eq(raised.facts, factsFrom([kindIn(at, 'five_hour')], NOW, false))
      const later = { ...q, ends: { ...q.ends }, facts: [...q.facts] }
      raiseAtFloor(later, sensed({ five: live(96, R + 2 * MIN), spans: NO_SPANS })) // another window
      eq(later.ends, q.ends)
    },
  },
]

// ---- Stops ----

const holder5: Holder = { kind: 'five_hour', resetsAtMs: R }

/** A Stop here sense: the split and holders of `s`, as the gate reads them with no consent. */
function stopSense(s: Sensed): StopSense {
  const out = splitFrom(s.kinds, () => ({ list: [], failed: false }), s.now)
  return { s, split: out, holders: holdersFrom(s.kinds, out.gating, () => [], s.now) }
}

const stopCases: FlowCase[] = [
  {
    name: 'stopPlan: B46 open, after the skip start with no work: nothing is written',
    run: (eq) => {
      const q = question(s92(), {}, 'prompt') // a skip owner with no loop: no work
      const now = R - 10 * MIN
      const sNow = stopSense(sensed({ five: live(92, R), now }))
      const plan = stopPlan(q, now, true, sNow)
      const ended: Ended = { reset: [], open: factsFrom([kindIn(sNow.s, 'five_hour')], now) }
      eq(plan, { kind: 'open', until: SKIP5, ended })
      eq(stopOpenNotice(q, ended, 'dialog'), notice.stoppedLate(q.facts, ended, false))
      eq(stopOpenNotice(q, ended, 'time limit'), notice.holdLimitLate(q.facts, ended, false))
      eq(stopOpenNotice(q, ended, 'command'), undefined)
    },
  },
  {
    name: 'stopPlan and stopNotice: B46 soon, after the skip start with work: a stop with its passed until',
    run: (eq) => {
      const q = question(s92())
      const now = R - 10 * MIN
      const sNow = stopSense(sensed({ five: live(92, R), now }))
      const plan = stopPlan(q, now, true, sNow)
      const ended: Ended = { reset: [], open: factsFrom([kindIn(sNow.s, 'five_hour')], now) }
      const record = { kinds: ['five_hour'] as Kind[], windowEnd: SKIP5, work: true, auto: true, test: false, skip: true, real: [] }
      eq(plan, { kind: 'write', until: SKIP5, ended, late: [], record })
      if (plan.kind !== 'write') return
      const written = stopRecordOf(undefined, plan.record, 'S1', now)
      eq(written, { kinds: ['five_hour'], windowEnd: SKIP5, work: true, auto: true, test: false, skip: true, sessionId: 'S1', at: now })
      const u = untilFor(q.facts, SKIP5, ['five_hour'], true, now)
      eq(stopNotice(q, plan, written, 'dialog', now, true), { text: notice.stoppedLate(q.facts, ended, true), late: { record: written, ended, until: u } })
      eq(stopNotice(q, plan, written, 'time limit', now, true).text, notice.holdLimitLate(q.facts, ended, true))
      eq(stopNotice(q, plan, written, 'command', now, true), { late: { record: written, ended, until: u } })
    },
  },
  {
    name: 'stopPlan and stopNotice: a skip stop before its skip start, with the TS1 real entries of now',
    run: (eq) => {
      const q = question(s92())
      const sNow = stopSense(s92())
      const plan = stopPlan(q, NOW, true, sNow)
      eq(plan, { kind: 'write', until: SKIP5, late: [], record: { kinds: ['five_hour'], windowEnd: SKIP5, work: true, auto: true, test: false, skip: true, real: [holder5] } })
      if (plan.kind !== 'write') return
      const written = stopRecordOf(undefined, plan.record, 'S1', NOW)
      eq(written.real, [holder5])
      const u = untilFor(q.facts, SKIP5, ['five_hour'], true, NOW)
      eq(stopNotice(q, plan, written, 'dialog', NOW, true), { text: notice.stopped(q.facts, { ...u, work: true }), late: { record: written, until: u } })
      // autoResume off: a skip stop still shows its end, with no work to continue.
      const off = stopPlan(q, NOW, false, sNow)
      if (off.kind !== 'write') return
      const w2 = stopRecordOf(undefined, off.record, 'S1', NOW)
      eq(stopNotice(q, off, w2, 'dialog', NOW, false).text, notice.stopped(q.facts, { ...u, work: false }))
    },
  },
  {
    name: 'stopPlan: a failed sense writes the D0.2 stop with the real kinds of the question',
    run: (eq) => {
      const q = question(sensed({ five: live(92, R), spans: NO_SPANS }))
      eq(stopPlan(q, NOW, true, undefined), {
        kind: 'write',
        until: R,
        late: [],
        record: { kinds: ['five_hour'], windowEnd: R, work: true, auto: true, test: false, skip: false, real: [holder5] },
      })
      eq(stopPlan(q, NOW, false, undefined).kind, 'write')
    },
  },
  {
    name: 'stopPlan: past the hold end, a late kind that gates now joins the stop and its fresh facts',
    run: (eq) => {
      const q = question(sensed({ five: live(92, R), spans: NO_SPANS }))
      const now = R + MIN
      const s = sensed({ five: live(20, R + 5 * HOUR), week: live(93, W), now, spans: NO_SPANS })
      const plan = stopPlan(q, now, true, stopSense(s))
      const week = kindIn(s, 'seven_day')
      eq(plan, {
        kind: 'write',
        until: W,
        late: [week],
        record: { kinds: ['five_hour', 'seven_day'], windowEnd: W, work: true, auto: true, test: false, skip: false, real: [{ kind: 'seven_day', resetsAtMs: W }] },
      })
      if (plan.kind !== 'write') return
      const written = stopRecordOf(undefined, plan.record, 'S1', now)
      const facts = byKind([...q.facts, ...factsFrom([week], now, false)])
      const u = untilFor(facts, W, ['five_hour', 'seven_day'], false, now)
      eq(stopNotice(q, plan, written, 'dialog', now, true).text, notice.stopped(facts, { ...u, work: true }))
    },
  },
  {
    name: 'stopRecordOf: a merge with an earlier stop of the session keeps its kinds, later end and work (3.2)',
    run: (eq) => {
      const prev = stopRec({ kinds: ['seven_day'], windowEnd: R + HOUR, work: true })
      const n = { kinds: ['five_hour'] as Kind[], windowEnd: R, work: false, auto: true, test: false, skip: false, real: [holder5, { kind: 'seven_day' as const, resetsAtMs: W }] }
      eq(stopRecordOf(prev, n, 'S1', NOW), { kinds: ['five_hour', 'seven_day'], windowEnd: R + HOUR, work: true, auto: true, test: false, sessionId: 'S1', at: NOW, real: [holder5] })
      eq(stopRecordOf(prev, n, 'S2', NOW), { kinds: ['five_hour'], windowEnd: R, work: false, auto: true, test: false, real: [holder5], sessionId: 'S2', at: NOW })
    },
  },
  {
    name: 'stopNotice: the text follows the record as written, after a merge with a later end',
    run: (eq) => {
      const q = question(sensed({ five: live(92, R), spans: NO_SPANS }), {}, 'prompt')
      const plan = stopPlan(q, NOW, true, stopSense(sensed({ five: live(92, R), spans: NO_SPANS })))
      if (plan.kind !== 'write') return
      const written = stopRecordOf(stopRec({ kinds: ['seven_day'], windowEnd: W, work: true }), plan.record, 'S1', NOW)
      const u = untilFor(q.facts, W, ['five_hour', 'seven_day'], false, NOW)
      eq(stopNotice(q, plan, written, 'dialog', NOW, true).text, notice.stopped(q.facts, { ...u, work: true }))
      eq(stopNotice(q, plan, written, 'dialog', NOW, false).text, notice.stopped(q.facts, undefined)) // off, and not a skip stop: no time
    },
  },
  {
    name: 'stopInForce: only this conversation, until its end, and past it while a kind still holds it (TS1)',
    run: (eq) => {
      const s = s92()
      const g = [kindIn(s, 'five_hour')]
      const st = stopRec({ windowEnd: R })
      eq(stopInForce(undefined, 'S1', undefined, NOW, g, [holder5]), undefined)
      eq(stopInForce(st, 'S2', undefined, NOW, g, [holder5]), undefined)
      eq(stopInForce(st, 'S1', 'S1', NOW, g, [holder5]), undefined) // ended by /clear
      eq(stopInForce(st, 'S1', undefined, NOW, g, [holder5]), st)
      const past = stopRec({ windowEnd: NOW - MIN, auto: false, test: true, real: [holder5] })
      eq(stopInForce(past, 'S1', undefined, NOW, g, []), undefined)
      eq(stopInForce(past, 'S1', undefined, NOW, g, [holder5]), { ...past, windowEnd: SKIP5, skip: true })
      eq(stopInForce(stopRec({ windowEnd: NOW - MIN }), 'S1', undefined, NOW, g, [holder5]), undefined) // not skip or test: it ended at a reset
    },
  },
  {
    name: 'stillHeld and extended: an auto stop past its end takes the kinds that gate now (B34, TS1)',
    run: (eq) => {
      const s = s92()
      const g = [kindIn(s, 'five_hour')]
      const st = stopRec({ windowEnd: NOW - MIN, test: true, real: [{ kind: 'five_hour', resetsAtMs: R + MIN }] })
      const want: StoppedRecord = { sessionId: 'S1', windowEnd: SKIP5, at: NOW - HOUR, kinds: ['five_hour'], work: false, auto: true, test: false, skip: true, real: [holder5] }
      eq(stillHeld(st, g, [holder5], NOW), want)
      eq(extended(st, g, [holder5], NOW), want)
      eq(stillHeld(st, [], [holder5], NOW), st) // no kind of it gates now: as it is
      const t = sensed({ five: testB(97, R), real: { five: NONE }, spans: NO_SPANS })
      const ext = extended(stopRec({ test: true, skip: true }), [kindIn(t, 'five_hour')], [], NOW)
      eq(ext, { sessionId: 'S1', windowEnd: R, at: NOW - HOUR, kinds: ['five_hour'], work: false, auto: true, test: true })
    },
  },
  {
    name: 'extendNotice: the kinds that gate now and the new end (B34)',
    run: (eq) => {
      const s = s92()
      const g = [kindIn(s, 'five_hour')]
      const r = stopRec({ windowEnd: NOW - MIN })
      const longer = extended(r, g, [holder5], NOW)
      const facts = factsFrom(g, NOW, true)
      eq(
        extendNotice(r, longer, g, s),
        notice.stopExtended([{ kind: 'five_hour', test: false }], facts, untilPhrase(untilFor(facts, SKIP5, ['five_hour'], true, NOW)), []),
      )
    },
  },
  {
    name: 'endedFor and takenOf: what reset and what opened (skip 4.4)',
    run: (eq) => {
      const named = [{ kind: 'five_hour' as const, test: false }]
      eq(endedFor(named, undefined, [], false), { reset: named, open: [] })
      eq(endedFor(named, undefined, [], true), { reset: [], open: [] })
      const open = sensed({ five: live(92, R), now: R - 10 * MIN })
      eq(endedFor(named, open, [], true), { reset: [], open: factsFrom([kindIn(open, 'five_hour')], open.now) })
      eq(endedFor(named, s92(), [k92()], true), { reset: [], open: [] })
      eq(endedFor(named, sensed({ five: live(5, R + 5 * HOUR), now: R + MIN }), [], true), { reset: named, open: [] })
      const rec = stopRec()
      eq(takenOf(rec, undefined), { record: rec, reset: named, open: [] })
      eq(takenOf(stopRec({ skip: true }), undefined), { record: stopRec({ skip: true }), reset: [], open: [] })
    },
  },
  {
    name: 'handoverTakes: a fresh hand-over that no kind still holds (4.6.3)',
    run: (eq) => {
      const h = { record: stopRec({ skip: true, real: [holder5] }), at: NOW - 30_000 }
      eq(handoverTakes(undefined, NOW, []), false)
      eq(handoverTakes(h, NOW, []), true)
      eq(handoverTakes(h, NOW + 30_000, []), false) // a check period old
      eq(handoverTakes(h, NOW, [holder5]), false)
    },
  },
]

// ---- The waits ----

/** A question due at R plus the margin, holding until R, checked each minute from NOW, noting at R. */
const waitQ = (over: Partial<QuestionCore> = {}): QuestionCore => question(sensed({ five: live(92, R), spans: NO_SPANS }), over)

const waitCases: FlowCase[] = [
  {
    name: 'dueWait: nothing to do before the next check and the note time, or once noted',
    run: (eq) => {
      const q = waitQ()
      eq([q.due, q.holdEnd, q.nextCheck, q.noteAt], [R + RESET_MARGIN_MS, R, NOW + 60_000, R])
      eq(dueWait(q, NOW), true)
      eq(dueWait(q, NOW + 60_000), false)
      eq(dueWait(q, R), false) // the note is due
      eq(dueWait(waitQ({ noted: true, nextCheck: R + MIN }), R), true)
      eq(dueWait(waitQ({ noted: true, nextCheck: R + 10 * MIN }), R + RESET_MARGIN_MS), false) // due
    },
  },
  {
    name: 'dueStep: check, wait inside the margin, and the note of autoResume off (B6, B43)',
    run: (eq) => {
      const q = waitQ()
      eq(dueStep(q, NOW + MIN, true), 'check')
      eq(dueStep(q, R, true), 'wait') // at the reset: inside the margin
      eq(dueStep(q, R + MIN, true), 'wait') // past the reset, inside the margin
      eq(dueStep(q, R + RESET_MARGIN_MS, true), 'check')
      eq(dueStep(q, NOW + MIN, false), 'wait')
      eq(dueStep(q, R, false), 'note')
      eq(dueStep(waitQ({ skip: true }), R, false), 'noteSensed')
      eq(dueStep(waitQ({ noted: true }), R, false), 'wait')
      eq(dueStep(waitQ({ silent: true }), NOW + MIN, false), 'check') // a silent question never waits for an answer
    },
  },
  {
    name: 'sensedNote: a skip owner notes what opened, or waits for the hold end of its kinds (B43, B45)',
    run: (eq) => {
      const q = question(s92())
      const s = s92()
      eq(sensedNote(q, s, [kindIn(s, 'five_hour')], NOW), { noteAt: SKIP5 })
      eq(sensedNote(q, s, [kindIn(s, 'five_hour')], SKIP5), { noteAt: SKIP5 + 60_000 }) // at least a check period on
      const open = sensed({ five: live(92, R), now: R - 10 * MIN })
      eq(sensedNote(q, open, [], open.now), { text: notice.resetWaitingFor([], factsFrom([kindIn(open, 'five_hour')], open.now), true) })
      const reset = sensed({ five: live(5, R + 5 * HOUR), now: R + MIN })
      eq(sensedNote(q, reset, [], reset.now), { text: notice.resetWaitingFor([{ kind: 'five_hour', test: false }], [], true) })
    },
  },
  {
    name: 'dueRelease: reset at the due time, quota when no kind gates, and never inside a real reset margin',
    run: (eq) => {
      const q = waitQ()
      const g = [k92()]
      eq(dueRelease(q, NOW + MIN, g, false), undefined)
      eq(dueRelease(q, NOW + MIN, [], false), 'quota')
      eq(dueRelease(q, R + RESET_MARGIN_MS, g, false), 'reset')
      eq(dueRelease(q, R + RESET_MARGIN_MS, [], true), undefined)
      eq(dueRelease(q, R + RESET_MARGIN_MS, g, true), 'reset')
    },
  },
  {
    name: 'againNotice: the D0.2 texts, and what reset or opened for a skip owner',
    run: (eq) => {
      const q = waitQ()
      const named = namedOf(q)
      const s = s92()
      eq(againNotice(q, 'quota', [], s), notice.outOfReserve)
      eq(againNotice(q, 'reset', [], s), notice.resetContinues(named))
      eq(againNotice(q, 'reset', [kindIn(s, 'five_hour')], s), notice.resetStillHeld(named, factsFrom([kindIn(s, 'five_hour')], NOW)))
      const owner = question(s92())
      const open = sensed({ five: live(92, R), now: R - 10 * MIN })
      eq(againNotice(owner, 'quota', [], open), notice.resetContinues([], factsFrom([kindIn(open, 'five_hour')], open.now)))
      const week = sensed({ five: live(92, R), week: live(93, W), now: R - 10 * MIN })
      const wk = kindIn(week, 'seven_day')
      eq(againNotice(owner, 'reset', [wk], week), notice.resetStillHeld([], factsFrom([wk], week.now), factsFrom([kindIn(week, 'five_hour')], week.now)))
    },
  },
  {
    name: 'tickPlan: skip inside a real reset margin, extend while a kind gates, else end (4.6, B34)',
    run: (eq) => {
      eq([tickPlan([], true), tickPlan([], false), tickPlan([k92()], true), tickPlan([k92()], false)], ['skip', 'end', 'extend', 'extend'])
    },
  },
  {
    name: 'answersKind and stopNewer: decided elsewhere (B50 item 3, R6)',
    run: (eq) => {
      const end = { end: R, test: false, to: 95 }
      eq(answersKind(end, [env({ until: R })], NOW), true)
      eq(answersKind(end, [env({ until: R, to: 95 })], NOW), true)
      eq(answersKind(end, [env({ until: R, to: 93 })], NOW), false)
      eq(answersKind({ end: R, test: false }, [env({ until: R, to: 99 })], NOW), false) // asked at the floor
      eq(answersKind(undefined, [env({ until: R })], NOW), false)
      const q = { since: NOW - MIN }
      eq(stopNewer(stopRec({ at: NOW }), q, NOW), true)
      eq(stopNewer(stopRec({ at: NOW - 2 * MIN }), q, NOW), false)
      eq(stopNewer(stopRec({ at: NOW, windowEnd: NOW }), q, NOW), false)
      eq(stopNewer(undefined, q, NOW), false)
    },
  },
]

// ---- Commands ----

const commandCases: FlowCase[] = [
  {
    name: 'resumeReadReply: no reading, or below every reserve',
    run: (eq) => {
      eq(resumeReadReply(sensed({ five: NONE })), resumeReply('none'))
      const below = sensed({ five: live(40, R), week: live(30, W) })
      eq(resumeReadReply(below), resumeReply('below', factsFrom(below.kinds, NOW)))
      eq(resumeReadReply(s92()), undefined)
    },
  },
  {
    name: 'resumeCase: open, already consented, or the consents to write at the tier of now (B23, B44, floor 2.8)',
    run: (eq) => {
      const s = s92()
      const k = kindIn(s, 'five_hour')
      eq(resumeCase(s, split({ open: [k] }), 'hold'), { reply: resumeReply('open', factsFrom([k], NOW)) })
      eq(resumeCase(s, split({ consented: [{ k, c: { until: R } }] }), 'hold'), { reply: resumeReply('consented', factsFrom([k], NOW), undefined, undefined, 'hold') })
      eq(resumeCase(s, split({ consented: [{ k, c: { until: R, to: 97 } }] }), 'tell'), {
        reply: resumeReply('consented', [{ ...factsFrom([k], NOW)[0], to: 95 }] as Facts[], undefined, undefined, 'tell'),
      })
      eq(resumeCase(s, split({ gating: [k] }), 'hold'), { gating: [k], write: [{ kind: 'five_hour', c: { until: R, to: 95 }, test: false }], facts: factsFrom([k], NOW, false, resumeTo) })
      const f = kindIn(sensed({ five: live(96, R) }), 'five_hour')
      eq(resumeCase(s, split({ gating: [f] }), 'hold'), { gating: [f], write: [{ kind: 'five_hour', c: { until: R }, test: false }], facts: factsFrom([f], NOW) })
    },
  },
  {
    name: 'stopCase: none, below, all open, or the kinds that gate after the stop (B24, B44)',
    run: (eq) => {
      eq(stopCase(sensed({ five: NONE }), cfgOf()), { reply: stopReply('none', undefined, 90, undefined, 90) })
      eq(stopCase(sensed({ five: NONE }), cfgOf({}, { weeklyReserve: 0 })), { reply: stopReply('none', undefined, 90, undefined, undefined) })
      const below = sensed({ five: live(40, R) })
      eq(stopCase(below, cfgOf({}, { reserve: 12.5 })), { reply: stopReply('below', factsFrom([kindIn(below, 'five_hour')], NOW), 87.5, undefined, 90) })
      const open = sensed({ five: live(92, R), now: R - 10 * MIN })
      eq(stopCase(open, cfgOf()), { reply: stopReply('open', factsFrom([kindIn(open, 'five_hour')], open.now)) })
      const both = sensed({ five: live(92, R), week: live(93, W), now: R - 10 * MIN })
      const wk = kindIn(both, 'seven_day')
      eq(stopCase(both, cfgOf()), { ks: [wk], facts: factsFrom(both.kinds, both.now), real: [{ kind: 'seven_day', resetsAtMs: W }] })
      eq([tripOf(10), tripOf(10.6)], [90, 89.4])
    },
  },
  {
    name: 'stopWriteOf, stopKept and the replies of a stop command',
    run: (eq) => {
      const k = k92()
      eq(stopWriteOf([k], true, false), { kinds: ['five_hour'], windowEnd: SKIP5, work: false, auto: true, test: false, skip: true, real: [holder5] })
      const nk = kindIn(sensed({ five: live(92, R), spans: NO_SPANS }), 'five_hour')
      eq(stopWriteOf([nk], true, true), { kinds: ['five_hour'], windowEnd: R, work: true, auto: true, test: false, skip: false, real: [holder5] })
      eq(stopWriteOf([nk], false, false).windowEnd, R)
      const { kinds: _k, ...old } = stopRec()
      eq([stopKept(undefined, [k]), stopKept(stopRec(), [k]), stopKept(stopRec({ kinds: ['seven_day'] }), [k]), stopKept(old, [k])], [false, true, false, true])
      const f = factsFrom([k], NOW)
      eq(stopKeptReply(stopRec(), f, true, NOW), stopReply('stopped', f, undefined, { at: atText(R, ['five_hour'], undefined, NOW) }))
      eq(stopKeptReply(stopRec(), f, false, NOW), stopReply('stopped', f, undefined, undefined))
      eq(stopKeptReply(stopRec({ auto: false, skip: true }), f, false, NOW), stopReply('stopped', f, undefined, { at: atText(R, ['five_hour'], undefined, NOW) }))
      const written = stopRecordOf(undefined, stopWriteOf([k], true, false), 'S1', NOW)
      eq(stopTrippedReply([k], f, written, true, NOW), stopReply('tripped', f, undefined, { ...untilFor(factsFrom([k], NOW, true), SKIP5, ['five_hour'], true, NOW), continues: true }))
      const plain = stopRecordOf(undefined, stopWriteOf([nk], false, false), 'S1', NOW)
      eq(stopTrippedReply([nk], f, plain, false, NOW), stopReply('tripped', f, undefined, undefined))
    },
  },
  {
    name: 'stopOverdueReply, stopAskingReply and stopAskingIdle (B24, B46)',
    run: (eq) => {
      const named = [{ kind: 'five_hour' as const, test: false }]
      const open = [fiveFacts(92, R)]
      eq(stopOverdueReply({ reset: named, open }), stopReply('overdue-open', open))
      eq(stopOverdueReply({ reset: named, open: [] }), stopReply('overdue'))
      eq(stopOverdueReply({ reset: [], open: [] }), stopReply('overdue-skip'))
      const ended: Ended = { reset: [], open }
      const rec = stopRec({ work: true })
      const until = { at: '15:00' }
      eq(stopAskingReply({ record: rec, ended, until }), stopReply('asking-soon', undefined, undefined, undefined, undefined, ended))
      eq(stopAskingReply({ ended }), stopReply('asking-open', undefined, undefined, undefined, undefined, ended))
      eq(stopAskingReply({ record: rec, until }), stopReply('asking', undefined, undefined, until))
      eq(stopAskingReply({ record: stopRec(), until }), stopReply('asking', undefined, undefined, undefined)) // no work to continue
      const none: Late = {}
      eq(stopAskingReply(none), undefined)
      const q = waitQ()
      eq(stopAskingIdle(q, true, NOW), stopReply('asking', undefined, undefined, { at: atText(R, ['five_hour'], undefined, NOW) }))
      eq(stopAskingIdle(q, false, NOW), stopReply('asking', undefined, undefined, undefined))
      eq(stopAskingIdle(waitQ({ loops: 0 }), true, NOW), stopReply('asking', undefined, undefined, undefined))
      eq(stopAskingIdle(undefined, true, NOW), stopReply('asking', undefined, undefined, undefined))
      const owner = question(s92())
      eq(stopAskingIdle(owner, true, NOW), stopReply('asking', undefined, undefined, { at: atText(SKIP5, ['five_hour'], undefined, NOW), lead: leadText(owner.facts[0] as Facts) as string }))
    },
  },
  {
    name: 'gatesAfter, takeoverSense and withRealEntries (skip 4.6, TS1)',
    run: (eq) => {
      eq([gatesAfter(undefined), gatesAfter(s92()), gatesAfter(sensed({ five: live(92, R), now: R - 10 * MIN })), gatesAfter(sensed({ five: live(40, R) }))], [false, true, false, false])
      eq(takeoverSense(undefined), { holders: [] })
      const s = s92()
      eq(takeoverSense(s), { kinds: s.kinds, holders: [holder5] })
      const real = [holder5, { kind: 'seven_day' as const, resetsAtMs: W }]
      eq(withRealEntries(undefined, real, NOW), undefined)
      eq(withRealEntries(stopRec(), real, NOW), undefined) // cannot hold past its end
      eq(withRealEntries(stopRec({ skip: true, real: [{ kind: 'five_hour', resetsAtMs: NOW - MIN }] }), real, NOW), { ...stopRec({ skip: true }), real: [holder5] })
    },
  },
  {
    name: 'raisesInPlace: a strictly higher value without in, in the window of the test reading (B53)',
    run: (eq) => {
      const old = { pct: 92, resetsAtMs: R }
      eq(raisesInPlace(old, { pct: 95, kind: 'five_hour' }, NOW), true)
      eq(raisesInPlace(old, { pct: 92, kind: 'five_hour' }, NOW), false)
      eq(raisesInPlace(old, { pct: 95, kind: 'five_hour', inMs: 10 * MIN }, NOW), false)
      eq(raisesInPlace(old, { pct: 95, kind: 'five_hour' }, R), false)
    },
  },
  {
    name: 'simulateOpens: when a test reading opens its reserve (skip 2.9, B45)',
    run: (eq) => {
      const t = testB(92, R)
      const f: Facts = { ...factsOf(t, 10, undefined, 'five_hour', NOW), test: true, span: 20 * MIN }
      eq(simulateOpens(t, NONE, 10, 0, NOW, f), undefined)
      eq(simulateOpens(testB(80, R), NONE, 10, 20 * MIN, NOW, f), undefined)
      eq(simulateOpens(t, NONE, 10, 20 * MIN, NOW, f), { at: clockText(SKIP5, 'five_hour', undefined, NOW), lead: leadText(f) ?? '' })
      eq(simulateOpens(testB(92, NOW + 10 * MIN), NONE, 10, 20 * MIN, NOW, f), 'now')
      eq(simulateOpens(testB(92, NOW + 10 * MIN), live(91, R), 10, 20 * MIN, NOW, f), 'real')
      eq(simulateOpens(testB(92, NOW + 10 * MIN), live(91, NOW + 15 * MIN), 10, 20 * MIN, NOW, f), 'now') // the real skip start comes first
    },
  },
  {
    name: 'simulateText: the reply of a test reading, past the floor, and over a real reading in the reserve',
    run: (eq) => {
      const base = { inPlace: false, cfg: cfgOf(), spans: SPANS, live: undefined, mem: initialMemory(), now: NOW }
      const reading = { pct: 92, resetsAtMs: R }
      const f: Facts = { ...factsOf(testB(92, R), 10, undefined, 'five_hour', NOW), test: true, span: 20 * MIN }
      const opens = { at: clockText(SKIP5, 'five_hour', undefined, NOW), lead: leadText(f) ?? '' }
      eq(simulateText({ ...base, spec: { pct: 92, kind: 'five_hour' }, reading }), simulateReply('set', f, opens, undefined, false))
      const r96 = { pct: 96, resetsAtMs: R }
      const f96: Facts = { ...factsOf(testB(96, R), 10, undefined, 'five_hour', NOW), test: true, span: 20 * MIN }
      eq(simulateText({ ...base, inPlace: true, spec: { pct: 96, kind: 'five_hour' }, reading: r96 }), simulateReply('raised', f96, { at: opens.at, lead: leadText(f96) ?? '' }, 5, false))
      // Spans off, over a real reading in the reserve: no forecast, and a Resume on the test reading covers it.
      const liveIn: SessionRateLimit = { kind: 'five_hour', percentUsed: 91, resetsAt: new Date(R).toISOString() }
      eq(simulateText({ ...base, spans: NO_SPANS, live: liveIn, spec: { pct: 96, kind: 'five_hour' }, reading: r96 }), simulateReply('set', noSpan(f96), undefined, 5, true))
    },
  },
]

function noSpan(f: Facts): Facts {
  const { span: _span, ...rest } = f
  return rest
}

// ---- The report ----

const toldAt = (windowEnd: number, keys: string[]): Told => ({ ...newTold(), five_hour: { windowEnd, keys: new Set(keys) } })

function seenFor(w: World, o: { lists?: (k: KindSense) => Consent[]; stop?: StoppedRecord; question?: QuestionCore; told?: Told } = {}) {
  const s = sensed(w)
  const view = seenSplit(s.kinds, o.lists ?? (() => []), s.now)
  return seenOf({
    cfg: s.cfg,
    now: s.now,
    bases: basesOf(w.five, w.week, w.real),
    kinds: s.kinds,
    tripped: s.tripped,
    attended: s.attended,
    split: view,
    stop: o.stop,
    question: o.question,
    told: o.told ?? newTold(),
    sessionId: 'S1',
  })
}

const reportCases: FlowCase[] = [
  {
    name: 'seenSplit: consented, ended at the floor, gating and open, and it never ends a consent (B52)',
    run: (eq) => {
      const s = sensed({ five: live(96, R), week: live(93, NOW + HOUR) }) // the weekly reserve is open
      const five = kindIn(s, 'five_hour')
      const week = kindIn(s, 'seven_day')
      const out = seenSplit(s.kinds, (k) => (k.kind === 'five_hour' ? [{ until: R, to: 95 }] : []), s.now)
      eq(out, { consent: {}, ended: { five_hour: { until: R, to: 95 } }, gating: [five], open: [week] })
      eq(seenSplit(s92().kinds, () => [{ until: R }], NOW), { consent: { five_hour: { until: R }, seven_day: { until: R } }, ended: {}, gating: [], open: [] })
    },
  },
  {
    name: 'seenOf: the phase and the told loops of this session at the stage of now (B51)',
    run: (eq) => {
      eq(seenFor({ five: live(92, R) }).phase, 'tripped')
      eq(seenFor({ five: live(40, R) }).phase, 'armed')
      eq(seenFor({ five: NONE }).phase, 'waiting')
      eq(seenFor({ five: live(92, R) }, { lists: () => [{ until: R }] }).phase, 'consented')
      eq(seenFor({ five: live(92, R), now: R - 10 * MIN }).phase, 'open')
      eq(seenFor({ five: live(92, R) }, { stop: stopRec() }).phase, 'stopped')
      eq(seenFor({ five: live(92, R) }, { question: waitQ() }).phase, 'asking')
      eq(seenFor({ five: live(92, R) }, { question: waitQ({ silent: true }) }).phase, 'tripped')
      eq(seenFor({ five: live(92, R), attended: false }).phase, 'reserve')
      eq(seenFor({ five: live(92, R), cfg: cfgOf({ onOff: 'off' }) }).phase, 'off')
      const told = toldAt(R, ['S1:main', 'S1:agent-1', 'S1:agent-2:floor', 'S2:main'])
      const p = seenFor({ five: live(92, R) }, { told })
      eq([p.phase, p.toldCount], ['told', 2])
      eq(seenFor({ five: live(96, R) }, { told }).toldCount, 1) // at the floor: the floor stage only
      eq(seenFor({ five: live(92, R) }, { told: toldAt(R - HOUR, ['S1:main']) }).toldCount, 0) // another window
    },
  },
  {
    name: 'untilOf: the end point of a consent to the floor, the open reset, the stop end and the question end (2.6)',
    run: (eq) => {
      eq(untilOf(seenFor({ five: live(92, R) }, { lists: () => [{ until: R, to: 97 }] })), { to: '95' })
      eq(untilOf(seenFor({ five: live(92, R) }, { lists: () => [{ until: R }] })), {})
      const open = seenFor({ five: live(92, R), now: R - 10 * MIN })
      eq(untilOf(open), { until: clockText(R, 'five_hour', undefined, R - 10 * MIN) })
      eq(resetOf(kindIn(sensed({ five: live(92, R) }), 'five_hour')), R)
      eq(resetOf(kindIn(sensed({ five: NONE }), 'five_hour')), Number.POSITIVE_INFINITY)
      eq(untilOf(seenFor({ five: live(92, R) }, { stop: stopRec() })), { until: atText(R, ['five_hour'], undefined, NOW) })
      eq(untilOf(seenFor({ five: live(92, R), cfg: cfgOf({ autoResume: 'off' }) }, { stop: stopRec() })), {})
      eq(untilOf(seenFor({ five: live(92, R), cfg: cfgOf({ autoResume: 'off' }) }, { stop: stopRec({ skip: true }) })), { until: atText(R, ['five_hour'], undefined, NOW) })
      eq(untilOf(seenFor({ five: live(92, R) }, { question: waitQ() })), { until: atText(R, ['five_hour'], undefined, NOW) })
      eq(untilOf(seenFor({ five: live(92, R), cfg: cfgOf({ autoResume: 'off' }) }, { question: waitQ() })), {})
    },
  },
  {
    name: 'consentBeyond: a consent value past the window of its kind is ignored, and the report says so (R13, B30)',
    run: (eq) => {
      const k = k92()
      const at = (ms: number): string => formatConsent('S1', ms)
      eq(consentBeyond(k, undefined, NOW), undefined)
      eq(consentBeyond(k, 'junk', NOW), undefined)
      eq(consentBeyond(k, at(R + 60_000), NOW), undefined)
      eq(consentBeyond(k, at(R + 61_000), NOW), consentWarning(at(R + 61_000), 'five_hour'))
      const blind = kindIn(sensed({ five: NONE }), 'five_hour')
      eq(consentBeyond(blind, at(NOW + 5 * HOUR + 60_000), NOW), undefined)
      eq(consentBeyond(blind, at(NOW + 5 * HOUR + 61_000), NOW), consentWarning(at(NOW + 5 * HOUR + 61_000), 'five_hour'))
    },
  },
  {
    name: 'statusInput: the report input of a trip, with every row the report needs (2.7)',
    run: (eq) => {
      const p = seenFor({ five: live(92, R), week: live(50, W) })
      eq(statusInput(p, { childPolicy: 'stop', warnings: ['w'], tickerStale: false }), {
        phase: 'tripped',
        mode: 'hold',
        reserve: 10,
        reserveFrom: 'option',
        pausePrompt: null,
        attended: true,
        headless: 'off',
        headlessFrom: 'option',
        childPolicy: 'stop',
        enabled: true,
        enabledFrom: 'scope',
        scope: 'all',
        basis: live(92, R),
        facts: factsOf(live(92, R), 10),
        now: NOW,
        toldCount: 0,
        warnings: ['w'],
        weekly: { reserve: 10, from: 'option', basis: live(50, W) },
        autoResume: { on: true, from: 'option' },
        tickerStale: false,
        spans: { lastMinutes: 20, lastMinutesFrom: 'option', weeklyLastHours: 8, weeklyLastHoursFrom: 'option' },
        floors: { resumeFloor: 5, resumeFloorFrom: 'option', weeklyResumeFloor: 5, weeklyResumeFloorFrom: 'option' },
      })
    },
  },
  {
    name: 'statusInput: consent rows, the stop and question times, and the open kinds',
    run: (eq) => {
      const c = seenFor({ five: live(92, R), week: live(93, W) }, { lists: (k) => (k.kind === 'five_hour' ? [{ until: R, to: 97 }] : [{ until: W }]) })
      const ci = statusInput(c, { childPolicy: 'stop', warnings: [], tickerStale: true })
      eq([ci.phase, ci.consentUntil, ci.consentTo, ci.tickerStale], ['consented', R, 95, true])
      eq(ci.weekly, { reserve: 10, from: 'option', basis: live(93, W), consentUntil: W })
      eq(ci.consented, factsFrom(c.kinds, NOW, false, (k) => (k.kind === 'five_hour' ? 95 : undefined)))
      const ended = seenFor({ five: live(96, R) }, { lists: () => [{ until: R, to: 95 }] })
      const ei = statusInput(ended, { childPolicy: 'stop', warnings: [], tickerStale: false })
      eq([ei.consentUntil, ei.consentTo, ei.consentEnded], [undefined, 95, true])
      const st = statusInput(seenFor({ five: live(92, R) }, { stop: stopRec({ work: true }) }), { childPolicy: 'stop', warnings: [], tickerStale: false })
      eq([st.phase, st.at, st.work, st.autoStop, st.skipStop], ['stopped', { ms: R, kinds: ['five_hour'], skip: false }, true, true, false])
      const q = statusInput(seenFor({ five: live(92, R) }, { question: question(s92()) }), { childPolicy: 'stop', warnings: [], tickerStale: false })
      eq([q.phase, q.at], ['asking', { ms: SKIP5, kinds: ['five_hour'], skip: true }])
      const open = seenFor({ five: live(92, R), now: R - 10 * MIN })
      eq(statusInput(open, { childPolicy: 'stop', warnings: [], tickerStale: false }).open, factsFrom(open.open, open.now))
      const tell = statusInput(seenFor({ five: live(92, R), cfg: cfgOf({ pausePrompt: 'Wrap up.' }) }), { childPolicy: 'off', warnings: [], tickerStale: false })
      eq([tell.mode, tell.pausePrompt, tell.childPolicy], ['tell', 'Wrap up.', 'off'])
    },
  },
]

/** Every case, in the order of flow.ts. */
export const FLOW_CASES: readonly FlowCase[] = [
  ...senseCases,
  ...textCases,
  ...splitCases,
  ...verdictCases,
  ...questionCases,
  ...stopCases,
  ...waitCases,
  ...commandCases,
  ...reportCases,
]
