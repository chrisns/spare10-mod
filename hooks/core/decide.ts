import type { Headless } from './config.ts'
import { KINDS, RESET_MARGIN_MS, TEST_MARGIN_MS } from './reading.ts'
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
 * A stop. No `kinds`: a 0.1 value, which stops the 5-hour window until `windowEnd` and is never
 * continued. `windowEnd` is the `until` of 3.2. `work`: the stop held or refused a loop. `auto`:
 * autoResume was on when the stop was made. `test`: every kind of the stop was a test reading.
 */
export type StoppedRecord = { sessionId: string; windowEnd: number; at: number; kinds?: Kind[]; work?: boolean; auto?: boolean; test?: boolean }

const TAGS = new Set(['five_hour', 'seven_day', 'work', 'auto', 'test'])

/** SPARE10_STOPPED is `${sessionId} ${untilMs} ${atMs} ${tags}`, or the 0.1 `${sessionId} ${windowEndMs} ${atMs}`. Anything else is not stopped. */
export function parseStopped(raw: string | undefined): StoppedRecord | undefined {
  const m = /^(\S+) (\d+) (\d+)(?: (\S+))?$/.exec(raw ?? '')
  if (m === null) return undefined
  const rec = { sessionId: m[1] ?? '', windowEnd: Number(m[2]), at: Number(m[3]) }
  if (m[4] === undefined) return rec
  const tags = m[4].split(',')
  if (tags.some((t) => !TAGS.has(t))) return undefined
  const kinds = KINDS.filter((k) => tags.includes(k))
  if (kinds.length === 0) return undefined
  return { ...rec, kinds, work: tags.includes('work'), auto: tags.includes('auto'), test: tags.includes('test') }
}

export function formatStopped(s: StoppedRecord): string {
  const head = `${s.sessionId} ${s.windowEnd} ${s.at}`
  const kinds = KINDS.filter((k) => s.kinds?.includes(k) === true)
  if (kinds.length === 0) return head
  const tags = [...kinds, ...(s.work === true ? ['work'] : []), ...(s.auto === true ? ['auto'] : []), ...(s.test === true ? ['test'] : [])]
  return `${head} ${tags.join(',')}`
}

/**
 * 3.2: a new stop keeps what an earlier 0.2 stop of the same session that still applies knew. Kinds
 * join, the later end wins, work if either had it, test only if both had it, auto and at are new.
 */
export function mergeStopped(prev: StoppedRecord | undefined, next: StoppedRecord, now: number): StoppedRecord {
  if (prev?.kinds === undefined || next.kinds === undefined) return next
  if (prev.sessionId !== next.sessionId || now >= prev.windowEnd) return next
  const joined = [...prev.kinds, ...next.kinds]
  return {
    ...next,
    kinds: KINDS.filter((k) => joined.includes(k)),
    windowEnd: Math.max(prev.windowEnd, next.windowEnd),
    work: prev.work === true || next.work === true,
    test: prev.test === true && next.test === true,
  }
}

/** When spare10 may end a stop by itself: its end plus the margin (4.8). */
export const stopDue = (r: StoppedRecord): number => r.windowEnd + (r.test === true ? TEST_MARGIN_MS : RESET_MARGIN_MS)

/** B35: an auto 0.2 stop of this conversation whose end has passed, and that nobody released yet. */
export function isOverdue(r: StoppedRecord | undefined, sessionId: string, endedSid: string | undefined, now: number): r is StoppedRecord {
  return r?.kinds !== undefined && r.auto === true && r.sessionId === sessionId && r.sessionId !== endedSid && now >= r.windowEnd
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

export type Phase = 'off' | 'blind' | 'waiting' | 'armed' | 'consented' | 'stopped' | 'asking' | 'told' | 'reserve' | 'tripped'

export type PhaseInput = {
  enabled: boolean
  basis: Basis
  tripped: boolean
  consented: boolean
  stopped: boolean
  asking: boolean
  told: boolean
  attended: boolean
}

/**
 * The breaker phase, first match: off, asking, blind, waiting, armed, consented, stopped, told, reserve,
 * tripped. `basis` is the five_hour basis, `tripped` is any watched kind (3.5).
 */
export function phaseOf(i: PhaseInput): Phase {
  if (!i.enabled) return 'off'
  if (i.asking) return 'asking' // an open question outranks any reading (B6)
  if (i.basis.kind === 'none' && !i.tripped) return i.basis.why === 'blind' ? 'blind' : 'waiting'
  if (!i.tripped) return 'armed'
  if (i.consented) return 'consented'
  if (i.stopped && i.attended) return 'stopped'
  if (i.told) return 'told'
  if (!i.attended) return 'reserve'
  return 'tripped'
}
