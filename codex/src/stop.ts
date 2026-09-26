import { codexDebug } from '../../hooks/core/codex.ts'
import type { Effective } from '../../hooks/core/config.ts'
import { formatStopped, isOverdue, parseStopped } from '../../hooks/core/decide.ts'
import type { Holder, StoppedRecord } from '../../hooks/core/decide.ts'
import { stopInForce, stopRecordOf, takenOf } from '../../hooks/core/flow.ts'
import type { KindSense, StopWrite, Taken } from '../../hooks/core/flow.ts'
import { notice } from '../../hooks/core/text.ts'
import type { Log } from './log.ts'
import type { Notice, SessionState, SessionStore } from './store.ts'

// Stops on Codex (Codex design 3.7, 4.4, 4.6, 7.2 stop.ts). The Claude mod keeps a stop in SPARE10_STOPPED;
// on Codex it is `stopped` of state.json, with the same string format, so the core parses, merges and
// formats it unchanged. `stopMeta.noDialog` marks a held stop (A5): the question could not show. Every
// write runs inside the session lock, so the compare-and-set of register.tsx (markWork, the ticker's
// release) becomes a read and a write in one lock. A stop belongs to its session: a /clear starts a new
// session, so no stop of an ended conversation exists here (no endedSid, no drop).

/** The part of a session context that the stop steps use. */
export type StopCtx = { sid: string; store: Pick<SessionStore, 'read' | 'locked'> }

/** Inside `locked`: queues a transcript line of the root thread (2.4). `stop`: a Stop here line that a release in hold mode drops. */
export function noticeIn(st: SessionState, text: string, now: number, tag?: Notice['tag']): void {
  st.notices = [...(st.notices ?? []), { at: now, text, ...(tag === undefined ? {} : { tag }) }]
}

/** Inside `locked`: drops the queued Stop here lines, because the held work did not stop (2.4, 4.4). */
export function dropStopNotices(st: SessionState): void {
  const kept = (st.notices ?? []).filter((n) => n.tag !== 'stop')
  if (kept.length === 0) delete st.notices
  else st.notices = kept
}

/**
 * The stop of this session that applies now, if any (register.tsx stoppedNow). `gating`: the kinds that
 * gate now. `holders`: the kinds whose real reading gates now. A stop past its until that one of them keeps
 * applies too (TS1), with the end it will have.
 */
export function stoppedNow(sx: StopCtx, now: number, gating: readonly KindSense[], holders: readonly Holder[]): StoppedRecord | undefined {
  return stopInForce(parseStopped(sx.store.read().stopped), sx.sid, undefined, now, gating, holders)
}

/**
 * Inside `locked`: the 0.2 record of a new stop, merged with an earlier stop of this session (3.2). It
 * returns the record as written, for the texts. The caller sets `stopMeta`.
 */
export function writeStopped(st: SessionState, n: StopWrite, now: number): StoppedRecord {
  const r = stopRecordOf(parseStopped(st.stopped), n, st.sessionId, now)
  st.stopped = formatStopped(r)
  return r
}

/** Inside `locked`: no stop, and so no held stop. */
export function clearStopped(st: SessionState): void {
  delete st.stopped
  delete st.stopMeta
}

/**
 * 5.7: the first refused loop of a stop adds `work`, so the reset continues it. It reads first and takes
 * the lock only when the stop lacks `work`. It never throws and never delays the refusal for long: a
 * failure only logs, and the next refused loop tries again.
 */
export function markWork(sx: StopCtx, log?: Log): void {
  const lacks = (raw: string | undefined): StoppedRecord | undefined => {
    const r = parseStopped(raw)
    return r?.kinds !== undefined && r.work !== true && r.sessionId === sx.sid ? r : undefined
  }
  try {
    if (lacks(sx.store.read().stopped) === undefined) return
    sx.store.locked((tx) => {
      const r = lacks(tx.state.stopped)
      if (r !== undefined) tx.state.stopped = formatStopped({ ...r, work: true })
    })
  } catch (e) {
    log?.debug(codexDebug.writeFailed('the work mark of the stop', e instanceof Error ? e.message : String(e)))
  }
}

/** What a takeover knows: the settings, the time, the attendance, a sense of now for the notice, and the kinds whose real reading gates. */
export type TakeoverSense = {
  cfg: Pick<Effective, 'enabled'>
  now: number
  attended: boolean
  kinds?: readonly KindSense[]
  holders: readonly Holder[]
  /** The caller writes a new stop at once (a stop command while a kind gates): no notice says that the stop is over. */
  quiet?: boolean
}

/**
 * 4.6.3, B35 (register.tsx takeOverdueStop): a person prompt or a command after the reset, or after the
 * skip start, takes an overdue stop over. An auto 0.2 stop of this session whose end has passed and that no
 * kind still holds (TS1) is cleared under the lock, and `notice.stopTakenOver` is queued unless `quiet`.
 * The root ticker clears a stop only under the same lock and only over the value it read, so the two never
 * both act on one stop: the Codex form of `release`, `taking` and `handedOver`.
 */
export async function takeOverdueStop(sx: StopCtx, s: TakeoverSense): Promise<Taken | undefined> {
  if (!(s.cfg.enabled && s.attended)) return undefined
  if (!isOverdue(parseStopped(sx.store.read().stopped), sx.sid, undefined, s.now, s.holders)) return undefined
  const at = s.kinds === undefined ? undefined : { kinds: s.kinds, now: s.now }
  return sx.store.locked((tx) => {
    const r = parseStopped(tx.state.stopped)
    if (!isOverdue(r, sx.sid, undefined, s.now, s.holders)) return undefined
    clearStopped(tx.state)
    const t = takenOf(r, at)
    if (s.quiet !== true) noticeIn(tx.state, notice.stopTakenOver(t.reset, t.open), s.now)
    return t
  })
}
