import type { Headless } from './config.ts'
import type { Basis } from './reading.ts'

// The gate's decision table (design 4.2) and the phase precedence (3.1), written once. No $ here.

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

export function parseConsent(raw: string | undefined): ConsentRecord | undefined {
  const text = (raw ?? '').trim()
  const m = /^(\S+) (\S+)$/.exec(text)
  const stamped = m === null ? Number.NaN : Date.parse(m[2] ?? '')
  if (m !== null && Number.isFinite(stamped)) return { until: stamped, sessionId: m[1] ?? '' }
  const bare = Date.parse(text)
  return text !== '' && Number.isFinite(bare) ? { until: bare } : undefined
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

export type StoppedRecord = { sessionId: string; windowEnd: number; at: number }

/** SPARE10_STOPPED is `${sessionId} ${windowEndMs} ${atMs}`. Anything else is not stopped. */
export function parseStopped(raw: string | undefined): StoppedRecord | undefined {
  const m = /^(\S+) (\d+) (\d+)$/.exec(raw ?? '')
  if (m === null) return undefined
  return { sessionId: m[1] ?? '', windowEnd: Number(m[2]), at: Number(m[3]) }
}

export const formatStopped = (s: StoppedRecord): string => `${s.sessionId} ${s.windowEnd} ${s.at}`

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

/** The breaker phase, first match: off, asking, blind, waiting, armed, consented, stopped, told, reserve, tripped. */
export function phaseOf(i: PhaseInput): Phase {
  if (!i.enabled) return 'off'
  if (i.asking) return 'asking' // an open question outranks any reading (B6)
  if (i.basis.kind === 'none') return i.basis.why === 'blind' ? 'blind' : 'waiting'
  if (!i.tripped) return 'armed'
  if (i.consented) return 'consented'
  if (i.stopped && i.attended) return 'stopped'
  if (i.told) return 'told'
  if (!i.attended) return 'reserve'
  return 'tripped'
}
