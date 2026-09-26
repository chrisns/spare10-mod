import { codexDebug, voidedByReset } from '../../hooks/core/codex.ts'
import { buried, bury, consentCounts, formatConsent, fullCovers, noteSlot, parseConsent, slotList, unbury, withoutFloor } from '../../hooks/core/decide.ts'
import type { Consent, Tomb } from '../../hooks/core/decide.ts'
import { floorEndsOf } from '../../hooks/core/flow.ts'
import type { KindSense, Sourced } from '../../hooks/core/flow.ts'
import type { Kind } from '../../hooks/core/reading.ts'
import type { Log } from './log.ts'
import type { SessionState, SessionStore } from './store.ts'
import { testOf } from './store.ts'

// Consent on Codex (Codex design 3.7, 4.1, 4.8, 7.2 consent.ts). The Claude mod keeps a consent in the
// process env (SPARE10_CONSENT, SPARE10_WEEKLY_CONSENT) and this copy's slots. On Codex the one place is
// state.json of the session, under its one lock, with the same string format: `consent` and
// `weeklyConsent`. So there are no slots, no sweep, no compare-and-set and no restamp: each write runs
// inside `locked`, and a /clear starts a new session with no consent (degraded 7). A Resume on a test
// reading stays in `state.test.consent`, bound to the host pid of the test reading. Two Codex rules add to
// the Claude ones: a real consent that an early reset voids is no consent (A22), and an unattended nested
// run takes the consent of its parent session too (3.10). The core decides: this file only reads and
// writes the fields.

/** The field of state.json that holds the real consent of a kind. */
export const consentField = (kind: Kind): 'consent' | 'weeklyConsent' => (kind === 'seven_day' ? 'weeklyConsent' : 'consent')

/** A stored value that is no consent any more: a tomb buries it (B52), or an early reset voided it (A22). */
export type Dead = { kind: Kind; raw: string }

export type ConsentRead = { list: Sourced[]; dead: Dead[] }

export type ConsentQuery = {
  kind: Kind
  /** The reader is attended: only a consent stamped with this session counts (consentCounts). */
  attended: boolean
  /** The kind's view is a test reading: the test consents count too. */
  testBasis: boolean
  /** A22: the current reset of the kind's real reading, or the consent bound of a question's real kind. None or null: no void. */
  realEnd?: number | null
}

/**
 * The consents of a kind in the state as read (floor 4.2): the test consents on a test basis, then the
 * stored value of this session, then, for an unattended reader, the stored value of the parent session of a
 * nested run (3.10). A value that a tomb buries (B52) or that an early reset voids (A22) is no consent. A
 * dead value of this session is in `dead`, for its owner to remove. `hostPid`: a test consent counts only
 * for the host of its test reading (3.7).
 */
export function consentsIn(i: ConsentQuery & { state: SessionState; parent?: SessionState; hostPid?: number }): ConsentRead {
  const list: Sourced[] = []
  const dead: Dead[] = []
  const { state, kind } = i
  if (i.testBasis) {
    const t = i.hostPid === undefined ? state.test : testOf(state, i.hostPid)
    for (const c of slotList(t?.consent[kind])) list.push({ c, from: 'test' })
  }
  const field = consentField(kind)
  const stored = (st: SessionState, own: boolean): void => {
    const raw = st[field]
    const c = parseConsent(raw)
    if (raw === undefined || c === undefined) return
    const consent: Consent = { until: c.until, ...(c.to === undefined ? {} : { to: c.to }) }
    const tombs: Tomb[] = [...(state.tombs?.[kind] ?? []), ...(own ? [] : (st.tombs?.[kind] ?? []))]
    const voided = i.realEnd !== undefined && i.realEnd !== null && voidedByReset(consent, i.realEnd)
    if (buried(tombs, consent) || voided) {
      if (own) dead.push({ kind, raw })
      return
    }
    if (!consentCounts(c.sessionId, { attended: i.attended, bg: false, ids: [state.sessionId] })) return
    list.push({ c: consent, from: 'env', raw })
  }
  stored(state, true)
  if (i.parent !== undefined && !i.attended) stored(i.parent, false)
  return { list, dead }
}

/** Inside `locked`: removes each dead value that the state still holds as it was read. */
export function removeDead(st: SessionState, dead: readonly Dead[]): void {
  for (const d of dead) {
    const field = consentField(d.kind)
    if (st[field] === d.raw) delete st[field]
  }
}

/** The part of a session context that the consent reads use. */
export type ConsentCtx = { store: Pick<SessionStore, 'read' | 'locked'>; parent?: Pick<SessionStore, 'read'>; hostPid: number }

/**
 * The consents of a kind now, read with no lock (4.1). A dead value of this session is removed under the
 * lock, best effort: a LockTimeout leaves it on disk, and the list leaves it out all the same. Never call it
 * inside `locked`. A state.json that does not read throws (the caller fails open when it senses).
 */
export function consentsOf(sx: ConsentCtx, q: ConsentQuery, log?: Log): Sourced[] {
  const state = sx.store.read()
  let parent: SessionState | undefined
  if (!q.attended && sx.parent !== undefined) {
    try {
      parent = sx.parent.read()
    } catch (e) {
      log?.debug(codexDebug.readFailed('the parent session', e instanceof Error ? e.message : String(e)))
    }
  }
  const r = consentsIn({ ...q, state, ...(parent === undefined ? {} : { parent }), hostPid: sx.hostPid })
  if (r.dead.length > 0) {
    try {
      sx.store.locked((tx) => removeDead(tx.state, r.dead))
    } catch (e) {
      log?.debug(codexDebug.writeFailed('a dead consent', e instanceof Error ? e.message : String(e)))
    }
  }
  return r.list
}

/**
 * Inside `locked`: a Resume's consent of one kind (register.tsx writeConsent). Never for a window that has
 * ended (R10). A consent on a test reading goes to the test consents only, never into real use (3.5), and
 * only while this host's test reading is in the state. A new real consent to the floor lifts each tomb
 * that buries it (B52). A consent to the floor never replaces a full value of this session for the same
 * window: the stronger tier stays (floor 3.3).
 */
export function writeConsent(st: SessionState, kind: Kind, c: Consent, now: number, isTest: boolean): void {
  if (c.until <= now) return
  if (isTest) {
    if (st.test === undefined) return
    st.test.consent = { ...st.test.consent, [kind]: noteSlot(st.test.consent[kind], c) }
    return
  }
  if (c.to !== undefined) setTombs(st, kind, unbury(st.tombs?.[kind], c))
  const field = consentField(kind)
  if (c.to !== undefined && fullCovers(parseConsent(st[field]), [st.sessionId], c.until, now)) return
  st[field] = formatConsent(st.sessionId, c.until, c.to)
}

/**
 * Inside `locked`: B52, the consents to the floor of a tripped kind that is not open, whose own basis has
 * reached their end point, end for good (flow.ts floorEndsOf). A test consent loses its floor slot. A
 * stored value goes when the state still holds it as it was read. Each ended real consent gets a tomb,
 * and with `failed` (the read failed) the window whose end point the real reading reached. True when it
 * changed the state.
 */
export function endFloors(st: SessionState, k: KindSense, list: readonly Sourced[], now: number, failed = false): boolean {
  const ends = floorEndsOf(k, list, now, failed)
  let changed = false
  for (const e of ends.unset) {
    if (e.from === 'test') {
      if (st.test === undefined) continue
      const left = withoutFloor(st.test.consent[k.kind])
      const consent = { ...st.test.consent }
      if (left === undefined) delete consent[k.kind]
      else consent[k.kind] = left
      st.test.consent = consent
      changed = true
    } else if (e.raw !== undefined && st[consentField(k.kind)] === e.raw) {
      delete st[consentField(k.kind)]
      changed = true
    }
  }
  for (const t of ends.tombs) {
    setTombs(st, k.kind, bury(st.tombs?.[k.kind], t, now))
    changed = true
  }
  return changed
}

/** Inside `locked`: a stop or a new test reading clears every consent of the session, the test consents too. */
export function clearConsent(st: SessionState): void {
  delete st.consent
  delete st.weeklyConsent
  if (st.test !== undefined) st.test.consent = {}
}

function setTombs(st: SessionState, kind: Kind, tombs: Tomb[]): void {
  const all = { ...(st.tombs ?? {}) }
  if (tombs.length === 0) delete all[kind]
  else all[kind] = tombs
  if (Object.keys(all).length === 0) delete st.tombs
  else st.tombs = all
}
