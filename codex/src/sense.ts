import { codexDebug } from '../../hooks/core/codex.ts'
import type { CodexCredits, GateSite } from '../../hooks/core/codex.ts'
import { floorOf, reserveOf, watchedKinds } from '../../hooks/core/config.ts'
import type { Effective, Spans } from '../../hooks/core/config.ts'
import { parseConsent, slotList } from '../../hooks/core/decide.ts'
import type { Answered, Holder, Site } from '../../hooks/core/decide.ts'
import {
  checksStop,
  claimTold as claimToldCore,
  floorEndsOf,
  holdersFrom,
  namedKinds,
  needsRealList,
  newTold,
  noFloor,
  resetTooRecent as resetTooRecentCore,
  sensesOf,
  splitFrom,
  testReading,
  toldMainOf,
  toldNotice,
  tripOf,
  unansweredGating,
  unansweredHolders,
  unattendedLines,
  verdictOf,
} from '../../hooks/core/flow.ts'
import type { Acted, Bases, FallbackEnds, KindSense, Sensed, Sourced, Split, Told, UnattendedMarks } from '../../hooks/core/flow.ts'
import { BLIND_AFTER, KINDS, basis, initialMemory, inWindow, pctOf, pointOf, sawLive } from '../../hooks/core/reading.ts'
import type { Anchored, Kind, Memory } from '../../hooks/core/reading.ts'
import { debugLine } from '../../hooks/core/text.ts'
import type { AttendanceSource } from './attend.ts'
import { consentField, consentsIn, endFloors, removeDead } from './consent.ts'
import type { Dead } from './consent.ts'
import type { Deps } from './deps.ts'
import { noRollout } from './quota.ts'
import type { Points, Quota, QuotaCtx, View } from './quota.ts'
import type { SettingsSource } from './settings.ts'
import { noticeIn, stoppedNow } from './stop.ts'
import { testOf } from './store.ts'
import type { SessionState, SessionStore } from './store.ts'

// The sense and the decision on Codex (Codex design 4.1, 7.2 sense.ts): glue around hooks/core/flow.ts.
// register.tsx reads the engine's usage, its $.store seeds and its env; this file reads the quota view of
// quota.ts (the live read, the own rollout, seed.json), the test reading and the consents of state.json,
// and the attendance of attend.ts. Then it calls the same flow.ts steps with the same inputs. Sense fails
// open: a read that fails makes `sense` throw, and the gate passes while it does not hold. A lock or write
// failure after a good read never passes a step: the decision stands, and the write is tried again.

/** One gate call's view of its session (4.1). `store` is the session of `sid`; `parent` the session of a nested run's parent (3.10). */
export type SessionCtx = {
  sid: string
  thread: string
  root: boolean
  /** The rollout of the calling thread; null for an ephemeral thread. */
  transcript: string | null
  /** The Codex process that hosts the thread: a test reading counts only for it (3.7). */
  hostPid: number
  store: SessionStore
  parent?: SessionStore
  /** The permission mode of the gate input (`bypassPermissions` is approval never), for attendance (3.10). */
  mode?: string
}

/** A sense, with what the Codex adapter adds: the present kinds, the bases, the credits and the quota view. */
export type CodexSensed = Sensed & {
  /** The kinds the host reports, and each kind with a test reading in force (3.6, 4.15). */
  present: Kind[]
  /** The basis of each kind with the test reading, and without it (B45). */
  bases: Bases
  credits?: CodexCredits
  /** A23: the credits can pay past 100%. */
  creditsUsable: boolean
  blind: boolean
  view: View
}

export type SenseDeps = Pick<Deps, 'clock' | 'log'> & {
  settings: Pick<SettingsSource, 'get'>
  quota: Pick<Quota, 'view' | 'nearView'>
  attendance: AttendanceSource
}

export type SenseApi = {
  /** 4.1: every watched kind now. At `tool` and `step` near a trip point, the daemon is read first (A19). Throws when a read fails. */
  sense(sx: SessionCtx, site?: GateSite): Promise<CodexSensed>
  /** Skip 3.3, floor 4.2: the tripped kinds, split. It ends the consents to the floor that their basis reached (B52), best effort. Never throws. */
  split(sx: SessionCtx, s: Sensed): Split
  /** TS1: the kinds whose real reading gates now. It only reads. Never throws. */
  holders(sx: SessionCtx, s: Sensed, gating: readonly KindSense[]): Holder[]
  /** The verdict with the inputs of register.tsx act (no engine-fork check, G8 has no Codex form). */
  act(sx: SessionCtx, s: Sensed, c: { site: Site; person?: boolean; resumed?: readonly Answered[] }): Promise<Acted>
  /** 4.8: a watched kind's last real reading in the reserve reset less than the margin ago. */
  resetTooRecent(sx: SessionCtx, s: Pick<Sensed, 'kinds' | 'now'>): boolean
  /** B51 under the lock: the loop `key` is told now at the stage of each gating kind. It queues notice.told once per window and stage. */
  claimTold(sx: SessionCtx, s: Sensed, a: Pick<Acted, 'gating'>, key: string): boolean
  /** What this broker remembers of a kind of the session (for the simulate reply). */
  memOf(sid: string, kind: Kind): Memory
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 3.6: every watched kind of a sense has no reading at all (not a reset, not blind). Then nothing is released at this cycle. */
export const noReading = (s: Pick<Sensed, 'kinds'>): boolean =>
  s.kinds.length > 0 && s.kinds.every((k) => k.basis.kind === 'none' && k.basis.why === 'no-reading')

/** The told sets of the state (B51). */
export function toldOf(st: Pick<SessionState, 'told'>): Told {
  const t = newTold()
  for (const k of KINDS) {
    const e = st.told?.[k]
    if (e !== undefined) t[k] = { windowEnd: e.windowEnd, keys: new Set(e.keys) }
  }
  return t
}

function toldBack(t: Told): NonNullable<SessionState['told']> {
  const out: NonNullable<SessionState['told']> = {}
  for (const k of KINDS) if (t[k].windowEnd !== 0 || t[k].keys.size > 0) out[k] = { windowEnd: t[k].windowEnd, keys: [...t[k].keys] }
  return out
}

const marksOf = (m: Partial<Record<Kind, string>> | undefined): Record<Kind, string> => ({ five_hour: m?.five_hour ?? '', seven_day: m?.seven_day ?? '' })

const unattendedMarksOf = (st: Pick<SessionState, 'unattendedNote' | 'openNote'>): UnattendedMarks => ({
  reserve: { five_hour: st.unattendedNote?.five_hour ?? 0, seven_day: st.unattendedNote?.seven_day ?? 0 },
  open: { five_hour: st.openNote?.five_hour ?? 0, seven_day: st.openNote?.seven_day ?? 0 },
})

/**
 * A19: the trip point of each watched kind, and its floor point while the kind has a consent to the floor.
 * The quota reads the daemon again when a reading is near one of them.
 */
function pointsOf(cfg: Effective, st: SessionState): Points {
  const out: Points = {}
  for (const k of watchedKinds(cfg)) {
    const floor = floorOf(cfg, k)
    const toFloor = parseConsent(st[consentField(k)])?.to !== undefined || slotList(st.test?.consent[k]).some((c) => c.to !== undefined)
    out[k] = { trip: tripOf(reserveOf(cfg, k)), ...(floor > 0 && toFloor ? { floorPoint: pointOf(floor) } : {}) }
  }
  return out
}

/** A23: the spans of the settings, with the span of a kind at 100% or more set to 0 while credits can pay. */
function spansOf(cfg: Effective, bases: Bases, creditsUsable: boolean): Spans {
  const paid = (k: Kind): boolean => creditsUsable && (pctOf(bases[k].basis) ?? 0) >= 100
  return { lastMinutes: paid('five_hour') ? 0 : cfg.lastMinutes, weeklyLastHours: paid('seven_day') ? 0 : cfg.weeklyLastHours }
}

/** The sense of one broker (4.1). It remembers per session what register.tsx keeps in module state: the memory of each kind and the fallback ends (R11). */
export function createSense(d: SenseDeps): SenseApi {
  const mems = new Map<string, Record<Kind, Memory>>()
  const fallbacks = new Map<string, FallbackEnds>()
  const memsOf = (sid: string): Record<Kind, Memory> => {
    let m = mems.get(sid)
    if (m === undefined) {
      m = { five_hour: initialMemory(), seven_day: initialMemory() }
      mems.set(sid, m)
    }
    return m
  }
  const fallbackOf = (sid: string): FallbackEnds => {
    let f = fallbacks.get(sid)
    if (f === undefined) {
      f = {}
      fallbacks.set(sid, f)
    }
    return f
  }

  /**
   * 4.18: SPARE10_SIMULATE, once per session and host, at a root gate, when the session has no test reading
   * of that kind. `in` counts from this gate. A failed write keeps the reading for this sense only.
   */
  const envTest = (sx: SessionCtx, cfg: Effective, view: View, now: number, had: SessionState['test']): Partial<Record<Kind, Anchored>> => {
    const apply = (t: SessionState['test']): Partial<Record<Kind, Anchored>> => {
      const kinds = { ...(t?.kinds ?? {}) }
      const kind = cfg.testKind ?? 'five_hour'
      if (kinds[kind] === undefined && cfg.testPct !== undefined) kinds[kind] = testReading(cfg.testPct, kind, view.readings[kind]?.live, now, cfg.testInMs)
      return kinds
    }
    try {
      return sx.store.locked((tx) => {
        const t = testOf(tx.state, sx.hostPid)
        if (t?.envDone === true) return { ...t.kinds }
        const kinds = apply(t)
        tx.state.test = { hostPid: sx.hostPid, kinds, consent: t?.consent ?? {}, envDone: true }
        return kinds
      })
    } catch (e) {
      d.log.debug(codexDebug.writeFailed('the test reading of SPARE10_SIMULATE', errText(e)))
      return apply(had)
    }
  }

  const sense = async (sx: SessionCtx, site?: GateSite): Promise<CodexSensed> => {
    const cfg = d.settings.get()
    const state = sx.store.read()
    const test0 = testOf(state, sx.hostPid)
    const points = pointsOf(cfg, state)
    const q: QuotaCtx = { transcript: sx.transcript, store: sx.store }
    // A19 at a tool or step gate. Q1: a thread with no rollout reads the daemon at a prompt gate too, since
    // in hold mode the prompt decision is the only gate before the first request of its turn.
    const fresh = site === 'tool' || site === 'step' || (site === 'prompt' && noRollout(sx))
    const view = fresh ? await d.quota.nearView(q, points) : d.quota.view(q, d.clock.now(), points)
    const now = d.clock.now()
    const tests = sx.root && cfg.testPct !== undefined && test0?.envDone !== true ? envTest(sx, cfg, view, now, test0) : { ...(test0?.kinds ?? {}) }
    const mem = memsOf(sx.sid)
    for (const k of KINDS) {
      const r = view.readings[k]
      const m = r?.live === undefined ? mem[k] : sawLive(mem[k], r.live, now)
      // 3.6: the seed picked by observation time, not by the later window; blindness from the live reads only.
      mem[k] = { ...m, ...(r?.seed === undefined ? {} : { seed: r.seed }), misses: view.blind ? BLIND_AFTER : 0 }
    }
    const both = (k: Kind): Bases[Kind] => {
      const live = view.readings[k]?.live
      return { basis: basis(live, mem[k], now, tests[k], k), real: basis(live, mem[k], now, undefined, k) }
    }
    const bases: Bases = { five_hour: both('five_hour'), seven_day: both('seven_day') }
    const inForce = (k: Kind): boolean => {
      const t = tests[k]
      return t !== undefined && inWindow(t, now, k)
    }
    const present = KINDS.filter((k) => view.present.includes(k) || inForce(k))
    const spans = spansOf(cfg, bases, view.creditsUsable)
    const { kinds } = sensesOf(cfg, bases, spans, now, fallbackOf(sx.sid), mem, watchedKinds(cfg, present))
    const tripped = kinds.some((k) => k.tripped)
    const attended = d.attendance.attended({ transcript: sx.transcript }, sx.mode).attended
    return {
      cfg,
      now,
      kinds: attended ? kinds : kinds.map(noFloor), // B55
      tripped,
      attended,
      present,
      bases,
      ...(view.credits === undefined ? {} : { credits: view.credits }),
      creditsUsable: view.creditsUsable,
      blind: view.blind,
      view,
    }
  }

  /** The state and, for an unattended reader, the parent state, as read now. Undefined state: the read failed. */
  const statesOf = (sx: SessionCtx, attended: boolean): { state?: SessionState; parent?: SessionState } => {
    let state: SessionState | undefined
    try {
      state = sx.store.read()
    } catch (e) {
      d.log.debug(codexDebug.readFailed('the consents', errText(e)))
      return {}
    }
    let parent: SessionState | undefined
    if (!attended && sx.parent !== undefined) {
      try {
        parent = sx.parent.read()
      } catch (e) {
        d.log.debug(codexDebug.readFailed('the parent session', errText(e)))
      }
    }
    return { state, ...(parent === undefined ? {} : { parent }) }
  }

  const split = (sx: SessionCtx, s: Sensed): Split => {
    const { state, parent } = statesOf(sx, s.attended)
    const failed = state === undefined
    const dead: Dead[] = []
    const ends: Array<{ k: KindSense; list: readonly Sourced[] }> = []
    const out = splitFrom(
      s.kinds,
      (k) => {
        const r =
          state === undefined
            ? { list: [], dead: [] }
            : consentsIn({ state, ...(parent === undefined ? {} : { parent }), kind: k.kind, attended: s.attended, testBasis: k.test, realEnd: k.realReset, hostPid: sx.hostPid })
        dead.push(...r.dead)
        if (!k.open) {
          // B52: a consent to the floor whose basis reached its end point ends for good, before the kind is classified.
          const e = floorEndsOf(k, r.list, s.now, failed)
          if (e.unset.length > 0 || e.tombs.length > 0) ends.push({ k, list: r.list })
        }
        return { list: r.list, failed }
      },
      s.now,
    )
    if (dead.length > 0 || ends.length > 0) {
      try {
        sx.store.locked((tx) => {
          removeDead(tx.state, dead)
          for (const e of ends) endFloors(tx.state, e.k, e.list, s.now, failed)
        })
      } catch (e) {
        d.log.debug(codexDebug.writeFailed('the ended consents', errText(e)))
      }
    }
    return out
  }

  const holders = (sx: SessionCtx, s: Sensed, gating: readonly KindSense[]): Holder[] => {
    const need = s.kinds.some(needsRealList)
    const { state, parent } = need ? statesOf(sx, s.attended) : {}
    return holdersFrom(
      s.kinds,
      gating,
      (k) =>
        state === undefined
          ? []
          : consentsIn({ state, ...(parent === undefined ? {} : { parent }), kind: k.kind, attended: s.attended, testBasis: false, realEnd: k.realReset, hostPid: sx.hostPid }).list,
      s.now,
    )
  }

  /** B15, skip 2.5: the debug lines of an unattended run, once per kind and window. The marks live in the state. */
  const noteUnattended = (sx: SessionCtx, s: Sensed): void => {
    try {
      if (unattendedLines(s, unattendedMarksOf(sx.store.read())).length === 0) return
      const lines = sx.store.locked((tx) => {
        const m = unattendedMarksOf(tx.state)
        const ls = unattendedLines(s, m)
        if (ls.length > 0) {
          tx.state.unattendedNote = m.reserve
          tx.state.openNote = m.open
        }
        return ls
      })
      for (const l of lines) d.log.debug(l)
    } catch (e) {
      d.log.debug(codexDebug.writeFailed('the unattended marks', errText(e)))
    }
  }

  return {
    sense,
    split,
    holders,
    async act(sx, s, c) {
      // B38, B50: the round after a Resume leaves out the kinds it answered, on its basis and below its end point.
      const resumed = c.resumed ?? []
      const gating = s.cfg.enabled ? unansweredGating(resumed, split(sx, s).gating) : []
      // TS1: the kinds whose real reading gates. They keep a stop past its end, and a Stop here names them.
      const hs = s.cfg.enabled ? unansweredHolders(s, resumed, holders(sx, s, gating)) : []
      let stopped = false
      if (checksStop(s, gating)) {
        try {
          stopped = stoppedNow(sx, s.now, gating, hs) !== undefined
        } catch (e) {
          d.log.debug(codexDebug.readFailed('the stop', errText(e)))
        }
      }
      let toldMain = false
      try {
        toldMain = toldMainOf(toldOf(sx.store.read()), gating, sx.sid)
      } catch (e) {
        d.log.debug(codexDebug.readFailed('the told loops', errText(e)))
      }
      const { verdict } = verdictOf({ s, site: c.site, person: c.person === true, gating, holders: hs, stopped, toldMain })
      if (s.cfg.enabled && !s.attended) noteUnattended(sx, s) // R2: enabled runs only
      return { verdict, stopped, gating, holders: hs }
    },
    resetTooRecent: (sx, s) => resetTooRecentCore(s, memsOf(sx.sid)),
    claimTold(sx, s, a, key) {
      try {
        const fresh = sx.store.locked((tx) => {
          const told = toldOf(tx.state)
          if (!claimToldCore(told, namedKinds(s, a), key)) return false
          tx.state.told = toldBack(told)
          const marks = marksOf(tx.state.toldNotice)
          const text = toldNotice(s, a, marks)
          tx.state.toldNotice = marks
          if (text !== undefined) noticeIn(tx.state, text, s.now)
          return true
        })
        if (fresh) d.log.debug(debugLine.told(key))
        return fresh
      } catch (e) {
        // Fail closed: a tell that cannot be recorded is given, so the agents wind down.
        d.log.debug(codexDebug.writeFailed('the told loops', errText(e)))
        return true
      }
    },
    memOf: (sid, kind) => ({ ...memsOf(sid)[kind] }),
  }
}
