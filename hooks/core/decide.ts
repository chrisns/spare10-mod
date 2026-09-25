import type { Headless } from './config.ts'
import { KINDS, marginOf, windowMs } from './reading.ts'
import type { Basis, Kind } from './reading.ts'

// The gate's decision table (design 4.2) and the phase precedence (3.1), written once. No $ here.

/** One step of the reset clock (4.2). */
export const TICK_MS = 30_000

/** A waiter checks the quota at most this often before the due time (4.5). */
export const CHECK_MS = 60_000

/** Below this much hook budget a hold ends as Stop here (B40). */
export const BUDGET_FLOOR_MS = 2_000

export type Site = 'tool' | 'step' | 'prompt'
export type Mode = 'hold' | 'tell'
export type Outcome = 'resume' | 'stop'

export type Snapshot = {
  site: Site
  tripped: boolean
  enabled: boolean
  consented: boolean
  attended: boolean
  headless: Headless
  mode: Mode
  person: boolean
  stopped: boolean
  mainTold: boolean
  seedOnly?: boolean // every gating kind rests on a seed (row 6a)
}
// consented (row 3): tripped, and no kind gates. A kind gates when it is tripped, not consented and
// not open (B41), so a kind in its skip window passes here too.

export type Verdict =
  | { kind: 'pass'; trip: boolean } // trip: inside the reserve, let through
  | { kind: 'tell' }
  | { kind: 'refuse'; text: 'stop' | 'paused' | 'headless' }
  | { kind: 'hold' } // open or join the question, then wait

const PASS: Verdict = { kind: 'pass', trip: false }
const THROUGH: Verdict = { kind: 'pass', trip: true }

/** The decision table of 4.2, top to bottom, first match wins. */
export function decide(s: Snapshot): Verdict {
  if (!s.tripped) return PASS // row 1
  if (!s.enabled) return THROUGH // row 2
  if (s.consented) return THROUGH // row 3
  if (!s.attended) {
    if (s.headless === 'stop') return s.site === 'prompt' ? THROUGH : { kind: 'refuse', text: 'headless' } // row 5
    if (s.headless === 'prompt') return s.site === 'tool' ? { kind: 'tell' } : THROUGH // row 6
    if (s.headless === 'wait') return s.site === 'prompt' || s.seedOnly === true ? THROUGH : { kind: 'hold' } // row 6a
    return THROUGH // row 4
  }
  if (s.stopped) {
    // row 7, in either mode
    if (s.site === 'tool') return { kind: 'refuse', text: 'stop' }
    if (s.site === 'step') return { kind: 'refuse', text: 'paused' }
    return s.person ? { kind: 'hold' } : THROUGH
  }
  if (s.mode === 'tell') {
    // row 8
    if (s.site === 'tool') return { kind: 'tell' }
    if (s.site === 'step') return THROUGH
    return s.person && !s.mainTold ? { kind: 'hold' } : THROUGH
  }
  if (s.site === 'prompt') return s.person ? { kind: 'hold' } : THROUGH // row 9
  return { kind: 'hold' }
}

/** Only the exact yes label resumes. Everything else is Stop here. */
export const askVerdict = (answer: string, yes: string): Outcome => (answer === yes ? 'resume' : 'stop')

/** What a .catch does: let a failure after next stand, refuse while holding, pass while deciding. */
export function afterFailure(called: boolean, holding: boolean): 'replay' | 'refuse' | 'pass' {
  if (called) return 'replay'
  return holding ? 'refuse' : 'pass'
}

/** Consent counts only for the current window (3.5): a later time is ignored. */
export const consentCovers = (until: number, now: number, windowEnd: number): boolean =>
  now < until && until <= windowEnd + 60_000

/** SPARE10_CONSENT: `${sessionId} ${iso}` as spare10 writes it, or a bare time that a person set before launch. */
export type ConsentRecord = { until: number; sessionId?: string }

// Date.parse is lenient ('abc-123' is a number), so a time must also start like an ISO date.
const isoMs = (text: string): number => (/^\d{4}-\d{2}-\d{2}T/.test(text) ? Date.parse(text) : Number.NaN)

export function parseConsent(raw: string | undefined): ConsentRecord | undefined {
  const text = (raw ?? '').trim()
  const m = /^(\S+) (\S+)$/.exec(text)
  const stamped = m === null ? Number.NaN : isoMs(m[2] ?? '')
  if (m !== null && Number.isFinite(stamped)) return { until: stamped, sessionId: m[1] ?? '' }
  const bare = isoMs(text)
  return Number.isFinite(bare) ? { until: bare } : undefined
}

export const formatConsent = (sessionId: string, until: number): string => `${sessionId} ${new Date(until).toISOString()}`

/**
 * Whose consent counts (3.5, 9.3). The process env reaches every descendant, also a long-lived one: the
 * transient `claude daemon` and every --bg session it starts. So an attended session takes only a
 * consent stamped with its own id (now or before a /clear or /resume in this process). An unattended
 * run takes any consent: a nested `claude -p` follows the session that started it. A bare time is the
 * person's own answer before launch, and counts outside a --bg session.
 */
export function consentCounts(
  stamp: string | undefined,
  who: { attended: boolean; bg: boolean; ids: readonly string[] },
): boolean {
  if (!who.attended) return true
  if (stamp === undefined) return !who.bg
  return who.ids.includes(stamp)
}

/**
 * TS1: a kind whose real reading gates now: tripped, not open and not consented, read on the real basis
 * beneath any test reading. `resetsAtMs`: the reset of that real reading, null when unknown. An entry of
 * a stop's `real` tag has the same form: the kind, and the reset of its real window when it was written.
 */
export type Holder = { kind: Kind; resetsAtMs: number | null }

/**
 * A stop. No `kinds`: a 0.1 value, which stops the 5-hour window until `windowEnd` and is never
 * continued. `windowEnd` is the `until` of 3.2. `work`: the stop held or refused a loop. `auto`:
 * autoResume was on when the stop was made. `test`: every kind of the stop was a test reading.
 * `skip`: the until is a skip start and the stop is a skip owner, so it has no margin (skip 3.5).
 * `real` (TS1): the kinds of the stop whose real reading, beneath any test reading, was in the reserve
 * when the entry was written: tripped, not open and not consented. Each entry keeps the reset of that
 * real reading, the identity of its window (null: unknown). The value carries it only with `skip` or
 * `test`, the stops that can hold past their end (`holdsPast`). A value without it (0.1, 0.2 before
 * TS1, or a stop that ends at a reset) names none. One entry per kind, in KINDS order.
 */
export type StoppedRecord = {
  sessionId: string
  windowEnd: number
  at: number
  kinds?: Kind[]
  work?: boolean
  auto?: boolean
  test?: boolean
  skip?: boolean
  real?: Holder[]
}

/**
 * TS1: the tag of a real entry, `real_<kind>:<resetMs>`. A bare `real_<kind>` has an unknown reset: this
 * build writes it for a real reading without a reset time, and a 0.2 value from before the reset in the
 * tag reads the same way (fail closed). `:0` also reads as unknown.
 */
const realTag = (h: Holder): string => (h.resetsAtMs === null ? `real_${h.kind}` : `real_${h.kind}:${h.resetsAtMs}`)

const REAL_TAG = /^real_(five_hour|seven_day)(?::(\d{1,16}))?$/

const TAGS = new Set(['five_hour', 'seven_day', 'work', 'auto', 'test', 'skip'])

/** TS1: a real tag as an entry, or undefined when the tag is not a real tag. */
function realOf(tag: string): Holder | undefined {
  const m = REAL_TAG.exec(tag)
  if (m === null) return undefined
  const kind: Kind = m[1] === 'seven_day' ? 'seven_day' : 'five_hour'
  const ms = m[2] === undefined ? 0 : Number(m[2])
  return { kind, resetsAtMs: ms > 0 ? ms : null }
}

/**
 * TS1: of two entries of one kind, the one of the later window: a known reset over an unknown one, else
 * the later reset (a tie: the first). The known reset is the more exact, and a stop of the current
 * window still holds with it: the reading of that window has that reset.
 */
const laterEntry = (a: Holder, b: Holder): Holder => {
  if (a.resetsAtMs === null) return b
  if (b.resetsAtMs === null) return a
  return b.resetsAtMs > a.resetsAtMs ? b : a
}

/** TS1: an entry whose recorded reset has passed: the window of that entry is over. */
const windowOver = (h: Holder, now: number): boolean => h.resetsAtMs !== null && h.resetsAtMs <= now

/** One entry per kind of `kinds`, in KINDS order: the later entry of each kind (`laterEntry`). */
function perKind(entries: readonly Holder[], kinds: readonly Kind[] = KINDS): Holder[] {
  const out: Holder[] = []
  for (const k of KINDS) {
    if (!kinds.includes(k)) continue
    const mine = entries.filter((h) => h.kind === k)
    const first = mine[0]
    if (first !== undefined) out.push(mine.slice(1).reduce(laterEntry, first))
  }
  return out
}

/** SPARE10_STOPPED is `${sessionId} ${untilMs} ${atMs} ${tags}`, or the 0.1 `${sessionId} ${windowEndMs} ${atMs}`. Anything else is not stopped. */
export function parseStopped(raw: string | undefined): StoppedRecord | undefined {
  const m = /^(\S+) (\d+) (\d+)(?: (\S+))?$/.exec(raw ?? '')
  if (m === null) return undefined
  const rec = { sessionId: m[1] ?? '', windowEnd: Number(m[2]), at: Number(m[3]) }
  if (m[4] === undefined) return rec
  const tags = m[4].split(',')
  if (tags.some((t) => !TAGS.has(t) && realOf(t) === undefined)) return undefined
  const kinds = KINDS.filter((k) => tags.includes(k))
  if (kinds.length === 0) return undefined
  const out: StoppedRecord = { ...rec, kinds, work: tags.includes('work'), auto: tags.includes('auto'), test: tags.includes('test') }
  if (tags.includes('skip')) out.skip = true
  const real = perKind(tags.map(realOf).filter((h): h is Holder => h !== undefined), kinds)
  if (real.length > 0) out.real = real
  return out
}

export function formatStopped(s: StoppedRecord): string {
  const head = `${s.sessionId} ${s.windowEnd} ${s.at}`
  const kinds = KINDS.filter((k) => s.kinds?.includes(k) === true)
  if (kinds.length === 0) return head
  const tags = [
    ...kinds,
    ...(s.work === true ? ['work'] : []),
    ...(s.auto === true ? ['auto'] : []),
    ...(s.test === true ? ['test'] : []),
    ...(s.skip === true ? ['skip'] : []),
    ...(s.skip === true || s.test === true ? perKind(s.real ?? [], kinds).map(realTag) : []),
  ]
  return `${head} ${tags.join(',')}`
}

/**
 * TS1: the real entries of two stops of one session, one per kind (`laterEntry`). An entry whose window
 * is over is dropped: a trip in a later window asks again.
 */
export const joinReal = (a: readonly Holder[] | undefined, b: readonly Holder[] | undefined, now: number): Holder[] =>
  perKind([...(a ?? []), ...(b ?? [])].filter((h) => !windowOver(h, now)))

/**
 * TS1 (B34): the real entries of an extension to `kinds`. A kind whose real reading gates now gets its
 * current reset, which replaces its earlier entry. Any other kind keeps its earlier entry while that
 * window lasts.
 */
export function extendedReal(prev: readonly Holder[] | undefined, holders: readonly Holder[], kinds: readonly Kind[], now: number): Holder[] {
  const out: Holder[] = []
  for (const k of KINDS) {
    if (!kinds.includes(k)) continue
    const h = holders.find((x) => x.kind === k)
    const old = prev?.find((x) => x.kind === k)
    if (h !== undefined) out.push({ kind: k, resetsAtMs: h.resetsAtMs })
    else if (old !== undefined && !windowOver(old, now)) out.push(old)
  }
  return out
}

/**
 * 3.2: a new stop keeps what an earlier 0.2 stop of the same session knew, while that stop still
 * applies, or while it is an auto stop past its end that nobody released yet (it is still in the env,
 * so its work still waits for the reset). Kinds join, the later end wins (a tie: the new record), work
 * if either had it, test only if both had it, auto and at are new. `skip` is the later record's, and
 * with `auto` only while the earlier record's due time is not after the later end (skip 3.5): a kind
 * whose release rests on a reset never loses its margin to a skip start. `real` joins by kind (TS1,
 * `joinReal`): the entry of the later window, and none whose window is over.
 */
export function mergeStopped(prev: StoppedRecord | undefined, next: StoppedRecord, now: number): StoppedRecord {
  if (prev?.kinds === undefined || next.kinds === undefined) return next
  if (prev.sessionId !== next.sessionId) return next
  if (now >= prev.windowEnd && prev.auto !== true) return next // it ended by time, and nothing continues it
  const joined = [...prev.kinds, ...next.kinds]
  const later = prev.windowEnd > next.windowEnd ? prev : next
  const earlier = later === prev ? next : prev
  const { skip: _skip, real: _real, ...rest } = next
  const out: StoppedRecord = {
    ...rest,
    kinds: KINDS.filter((k) => joined.includes(k)),
    windowEnd: later.windowEnd,
    work: prev.work === true || next.work === true,
    test: prev.test === true && next.test === true,
  }
  if (later.skip === true && (out.auto !== true || stopDue(earlier) <= later.windowEnd)) out.skip = true
  const real = joinReal(prev.real, next.real, now)
  if (real.length > 0) out.real = real
  return out
}

/** When spare10 may end a stop by itself: its end plus the margin (4.8). A skip stop has no margin. */
export const stopDue = (r: StoppedRecord): number => r.windowEnd + marginOf(r.skip === true, r.test === true)

/**
 * The skip tag of a new stop (skip 3.5): its until is a skip start of its kinds, and with autoResume on
 * no kind of it is due later (its hold end plus margin). With autoResume off spare10 never releases the
 * stop, so only the first part counts.
 */
export const skipTag = (until: number, skipStarts: readonly number[], dues: readonly number[], auto: boolean): boolean =>
  skipStarts.includes(until) && (!auto || dues.every((d) => d <= until))

/**
 * TS1: two resets of one kind name the same window: they lie less than half a window apart. An unknown
 * reset matches any (fail closed). A reset that moves by a few seconds stays in its window.
 */
export const sameWindow = (kind: Kind, a: number | null, b: number | null): boolean =>
  a === null || b === null || Math.abs(a - b) < windowMs(kind) / 2

/**
 * TS1: a kind whose real reading gates now keeps a 0.2 stop past its end, when that end was not a reset
 * of the kind. A skip stop ends at a skip start: a kind that gates there has not opened (a test skip
 * start over a real trip, B45, or a span lowered after the stop was written, B47). A test stop ends when
 * its test window ends, and the real reading beneath can still gate. The stop must name the kind with
 * its `real` tag: its real reading was in the reserve when the entry was written. The reading must be in
 * the window of that entry (`sameWindow` of the two resets), or either reset is unknown (fail closed: it
 * keeps the stop while it gates). The time of the stop plays no part: an extension adopts a kind whose
 * window started after it. A later window or a later trip asks again, as in D0.2. Any other stop ended
 * at a reset. A 0.1 value ends by time.
 */
export const holdsPast = (r: StoppedRecord, h: Holder): boolean =>
  (r.skip === true || r.test === true) &&
  r.kinds?.includes(h.kind) === true &&
  r.real?.some((t) => t.kind === h.kind && sameWindow(h.kind, t.resetsAtMs, h.resetsAtMs)) === true

/** TS1: a 0.2 stop past its end still holds while a kind that gates now keeps it (`holdsPast`). The ticker extends such an auto stop at its due time (B34). */
export const heldPast = (r: StoppedRecord, holders: readonly Holder[]): boolean => holders.some((h) => holdsPast(r, h))

/**
 * B35: an auto 0.2 stop of this conversation whose end has passed, that nobody released yet, and that
 * no kind of it still holds (TS1: `holders` are the kinds whose real reading gates now).
 */
export function isOverdue(
  r: StoppedRecord | undefined,
  sessionId: string,
  endedSid: string | undefined,
  now: number,
  holders: readonly Holder[],
): r is StoppedRecord {
  return (
    r?.kinds !== undefined &&
    r.auto === true &&
    r.sessionId === sessionId &&
    r.sessionId !== endedSid &&
    now >= r.windowEnd &&
    !heldPast(r, holders)
  )
}

export type StopAction = 'none' | 'drop' | 'check'

/** What the ticker does with a stop (4.6): nothing, drop a stop of another conversation, or check the quota. */
export function stopAction(i: {
  record: StoppedRecord
  now: number
  sessionId: string
  endedSid?: string
  autoResume: boolean
  enabled: boolean
  attended: boolean
}): StopAction {
  const r = i.record
  if (r.kinds === undefined || r.auto !== true || i.now < stopDue(r)) return 'none'
  if (!(i.autoResume && i.enabled && i.attended)) return 'none'
  if (r.sessionId !== i.sessionId || r.sessionId === i.endedSid) return 'drop'
  return 'check'
}

/**
 * 5.6: a loop joins the open question while it is open, or settled as Stop here, or settled as Resume
 * for every kind that gates now. Never after again, and never a Resume for a kind the dialog did not name.
 */
export function joinable(outcome: 'resume' | 'stop' | 'again' | undefined, named: readonly Kind[], gating: readonly Kind[]): boolean {
  if (outcome === undefined || outcome === 'stop') return true
  return outcome === 'resume' && gating.every((k) => named.includes(k))
}

/** Attended: every refused main step ends its turn. Unattended: only a repeat in the same turn. */
export const shouldAbortTurn = (attended: boolean, refusedBefore: boolean): boolean => attended || refusedBefore

export type Phase = 'off' | 'blind' | 'waiting' | 'armed' | 'consented' | 'open' | 'stopped' | 'asking' | 'told' | 'reserve' | 'tripped'

export type PhaseInput = {
  enabled: boolean
  basis: Basis
  tripped: boolean
  consented: boolean // tripped, and every tripped kind is consented
  open?: boolean // tripped, no kind gates, and a kind is in its skip window (B41)
  stopped: boolean
  asking: boolean
  told: boolean
  attended: boolean
}

/**
 * The breaker phase, first match: off, asking, blind, waiting, armed, consented, open, stopped, told,
 * reserve, tripped. `basis` is the five_hour basis, `tripped` is any watched kind (3.5). A stop never
 * holds an open kind (B44), so open outranks stopped.
 */
export function phaseOf(i: PhaseInput): Phase {
  if (!i.enabled) return 'off'
  if (i.asking) return 'asking' // an open question outranks any reading (B6)
  if (i.basis.kind === 'none' && !i.tripped) return i.basis.why === 'blind' ? 'blind' : 'waiting'
  if (!i.tripped) return 'armed'
  if (i.consented) return 'consented'
  if (i.open === true) return 'open'
  if (i.stopped && i.attended) return 'stopped'
  if (i.told) return 'told'
  if (!i.attended) return 'reserve'
  return 'tripped'
}
