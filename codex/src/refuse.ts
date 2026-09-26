import { codexDebug, codexText, refuseModeOf } from '../../hooks/core/codex.ts'
import type { GateResult, GateSite } from '../../hooks/core/codex.ts'
import { formatStopped, parseStopped, stopDue } from '../../hooks/core/decide.ts'
import type { Site, StoppedRecord } from '../../hooks/core/decide.ts'
import { endedFor, extendNotice, extended, factsFrom, namedKinds, namedStop, refusalText, tickPlan } from '../../hooks/core/flow.ts'
import type { Acted, Sensed } from '../../hooks/core/flow.ts'
import { notice } from '../../hooks/core/text.ts'
import type { DaemonLink } from './daemon.ts'
import type { Deps } from './deps.ts'
import { BEAT_EVERY_MS, addHeld, beat, readThread, removeHeld, turnEnded, waiterOf } from './held.ts'
import type { HeldCall } from './held.ts'
import type { Quota } from './quota.ts'
import type { Rollouts } from './rollout.ts'
import { noReading } from './sense.ts'
import type { SenseApi, SessionCtx } from './sense.ts'
import type { SettingsSource } from './settings.ts'
import { clearStopped, dropStopNotices, noticeIn } from './stop.ts'
import type { Interrupts } from './sweep.ts'
import { HOLD_LIMIT_MS, LIVE_RELEASE_MAX_AGE_MS, TICK_MS } from './timing.ts'

// The refusal of a held tool or step, and the held stop (Codex design 4.4, 7.2 refuse.ts). Claude ends a
// refused turn with $.turn.abort and a PAUSED answer. Codex has three modes (A4): `interrupt` sends
// `turn/interrupt` over the daemon socket, so the turn ends with no request; `hold` keeps the call open
// until the stop changes; `deny` answers the deny rendering at once, at most once per thread and turn. The
// pure choice is refuseModeOf in hooks/core/codex.ts. A declined question is a held stop (A5): every held
// call holds, also in a hosted thread, until the stop ends or the person resumes.

/** A refusal's result: the gate answer, or `hold` when the verdict turned to hold while the call held (rounds goes on with a question). */
export type RefusalResult = GateResult | { kind: 'hold' }

export type RefusalDeps = Pick<Deps, 'clock' | 'wake' | 'log' | 'pid'> & {
  sense: SenseApi
  settings: Pick<SettingsSource, 'get'>
  quota: Pick<Quota, 'live'>
  daemon: Pick<DaemonLink, 'hosted'>
  rollouts: Pick<Rollouts, 'read'>
  /** The interrupts of this broker, shared with its stop sweep and its shutdown (4.4). They drop the calls of an interrupted turn. */
  interrupts: Pick<Interrupts, 'interrupt'>
}

export type Refusal = {
  /**
   * 4.4: the answer of a refused call. `text` is the verdict's text. A prompt is blocked with it. A tool or
   * step is refused by its mode with stopText (attended) or headlessText (unattended): a step gets the
   * same text as context, not pausedText, because on PostToolUse the model does get one more request.
   */
  refusal(sx: SessionCtx, call: HeldCall, site: GateSite, text: 'stop' | 'paused' | 'headless', s: Sensed, a: Acted): Promise<RefusalResult>
  /**
   * 4.4: the hold-mode form of the ticker's stopTick. An auto stop past its due time ends, or is extended
   * while a kind still gates (B34). True when it changed the stop. Any broker that holds under the stop may run it.
   */
  releaseInPlace(sx: SessionCtx): Promise<boolean>
  /**
   * 4.4 interrupt mode, once per thread and turn: `turn/interrupt` of the call's turn. True only once the turn
   * counts as interrupted: this call's interrupt got its reply, or the one it waited for did.
   */
  interrupt(sx: SessionCtx, call: Pick<HeldCall, 'turn'>): Promise<boolean>
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The turns of a thread that got a deny rendering: the last 8 (3.7). */
const DENIED_KEPT = 8

export function createRefusal(d: RefusalDeps): Refusal {
  const interrupt: Refusal['interrupt'] = async (sx, call) => {
    const turn = call.turn
    if (turn === undefined) return false
    const r = await d.interrupts.interrupt(sx, sx.thread, turn)
    return r === 'sent' || r === 'joined'
  }

  /** A4: this thread and turn got a deny rendering already. A read that fails is no deny (the next row gives one). */
  const deniedThisTurn = (sx: SessionCtx, turn: string | undefined): boolean => {
    if (turn === undefined) return false
    try {
      return readThread(sx.store, sx.thread)?.denied.includes(turn) === true
    } catch (e) {
      d.log.debug(codexDebug.readFailed('the denied turns', errText(e)))
      return false
    }
  }

  /**
   * A4: records the deny of this turn under the lock. False when another call of the turn got it first: this
   * call holds. Best effort: the deny stands when the write fails.
   */
  const claimDenied = (sx: SessionCtx, turn: string | undefined): boolean => {
    if (turn === undefined) return true
    try {
      return sx.store.locked((tx) => {
        const th = tx.thread(sx.thread)
        if (th.denied.includes(turn)) return false
        th.denied = [...th.denied, turn].slice(-DENIED_KEPT)
        return true
      })
    } catch (e) {
      d.log.debug(codexDebug.writeFailed('the denied turns', errText(e)))
      return true
    }
  }

  const releaseInPlace: Refusal['releaseInPlace'] = async (sx) => {
    const raw = sx.store.read().stopped
    const r = parseStopped(raw)
    if (raw === undefined || r?.kinds === undefined || r.auto !== true || r.sessionId !== sx.sid) return false
    if (d.clock.now() < stopDue(r) || !d.settings.get().autoResume) return false
    await d.quota.live(LIVE_RELEASE_MAX_AGE_MS)
    const s = await d.sense.sense(sx)
    if (noReading(s)) return false
    const gatingNow = d.sense.split(sx, s).gating
    const plan = tickPlan(gatingNow, d.sense.resetTooRecent(sx, s))
    if (plan === 'skip') return false // a test stop that ends near a real reset (4.8)
    const holders = plan === 'extend' ? d.sense.holders(sx, s, gatingNow) : [] // TS1: the real tag of an extension
    return sx.store.locked((tx) => {
      if (tx.state.stopped !== raw) return false // a prompt, a command or another broker took it
      if (plan === 'extend') {
        const longer = extended(r, gatingNow, holders, s.now)
        tx.state.stopped = formatStopped(longer)
        noticeIn(tx.state, extendNotice(r, longer, gatingNow, s), s.now)
        return true
      }
      const ended = endedFor(namedStop(r), s, [], r.skip === true) // skip 4.5: what reset and what opened
      clearStopped(tx.state)
      dropStopNotices(tx.state) // the work did not stop
      noticeIn(tx.state, notice.resetContinues(ended.reset, ended.open), s.now)
      return true
    })
  }

  /**
   * 4.4 hold mode: the call stays open under a held entry with no question, until the stop changes. Each
   * cycle decides again. A `hold` verdict leaves: the gate goes on with a question. A pass lets the call
   * through, but for an attended call only once no stop of its session that applied during the hold
   * stands: spare10 never lets held work go before the stop's due time (the margin of 4.8), and with
   * Continue at the reset off held work waits for the person (the table of 4.4). An auto stop past its due
   * time ends in place (releaseInPlace).
   * A held stop that the person turns into a plain stop (`spare10 stop` clears `noDialog`) takes the normal
   * mode: a hosted call is interrupted.
   */
  const holdStopped = async (sx: SessionCtx, call: HeldCall, site: GateSite, s0: Sensed, a0: Acted): Promise<RefusalResult> => {
    const start = d.clock.now()
    // 3.4: a held call answers its site's refusal at a failure or a shutdown, never a pass. The text follows the attendance.
    call.attended = s0.attended
    call.holding = true
    try {
      sx.store.locked((tx) => addHeld(tx, sx.thread, call, { brokerPid: d.pid, hostPid: sx.hostPid }, start))
    } catch (e) {
      d.log.debug(codexDebug.writeFailed('the held entry', errText(e)))
    }
    const w = waiterOf(d, sx.store.dir, call.dropped)
    const actSite: Site = site === 'tool' ? 'tool' : 'step'
    let last = { s: s0, a: a0 }
    let lastBeat = start
    let heldStop: boolean | undefined
    const deny = (): GateResult => ({ kind: 'deny', text: refusalText(last.s.attended ? 'stop' : 'headless', last.s, last.a, sx.sid) })
    try {
      for (;;) {
        if (call.dropped.aborted) return deny() // Codex ignores it
        if (turnEnded(d.rollouts, sx.transcript, call.turn)) {
          call.drop()
          return deny()
        }
        const now = d.clock.now()
        if (now >= call.since + HOLD_LIMIT_MS) {
          try {
            sx.store.locked((tx) => noticeIn(tx.state, notice.holdLimit(factsFrom(namedKinds(last.s, last.a), now)), now))
          } catch (e) {
            d.log.debug(codexDebug.writeFailed('the hold limit line', errText(e)))
          }
          return deny()
        }
        let v: Acted['verdict']['kind'] | undefined
        try {
          const s = await d.sense.sense(sx, site)
          const a = await d.sense.act(sx, s, { site: actSite })
          last = { s, a }
          v = a.verdict.kind
        } catch (e) {
          d.log.debug(codexDebug.readFailed('the quota while held', errText(e))) // fail closed: keep holding
        }
        if (v === 'hold') return { kind: 'hold' }
        let rec: StoppedRecord | undefined
        let noDialog = false
        try {
          const st = sx.store.read()
          rec = parseStopped(st.stopped)
          noDialog = st.stopMeta?.noDialog === true
        } catch (e) {
          d.log.debug(codexDebug.readFailed('the stop while held', errText(e)))
        }
        const mine = last.s.attended && rec !== undefined && rec.sessionId === sx.sid
        // The stop applied during this hold: an older record that ended before the hold began holds nothing.
        const stands = mine && rec !== undefined && rec.windowEnd > start
        const due = mine && rec?.kinds !== undefined && rec.auto === true && d.settings.get().autoResume ? stopDue(rec) : undefined
        if ((v === 'pass' || v === 'tell') && !stands) {
          try {
            sx.store.locked((tx) => dropStopNotices(tx.state)) // the work did not stop
          } catch (e) {
            d.log.debug(codexDebug.writeFailed('the queued lines', errText(e)))
          }
          return { kind: 'pass' }
        }
        if (due !== undefined && now >= due && (await releaseInPlace(sx))) continue // the next cycle decides
        if (heldStop === true && !noDialog && last.s.attended && (await d.daemon.hosted(sx.thread)) && (await interrupt(sx, call))) return deny()
        heldStop = noDialog
        const t = d.clock.now()
        if (t - lastBeat >= BEAT_EVERY_MS) {
          beat(sx.store, sx.thread, t, d.log)
          lastBeat = t
        }
        const ahead = [TICK_MS, call.since + HOLD_LIMIT_MS - t, ...(due !== undefined && due > t ? [due - t] : [])]
        await w.next(Math.max(1, Math.min(...ahead)))
      }
    } finally {
      w.close()
      try {
        sx.store.locked((tx) => removeHeld(tx, sx.thread, call, d.pid))
      } catch (e) {
        d.log.debug(codexDebug.writeFailed('the held entry', errText(e))) // the next gate of this thread removes it
      }
    }
  }

  return {
    interrupt,
    releaseInPlace,
    async refusal(sx, call, site, text, s, a) {
      if (site === 'prompt') return { kind: 'block', text: refusalText(text, s, a, sx.sid) }
      if (site === 'stop' || site === 'compact') return { kind: 'end', text: codexText.turnEnds }
      if (site !== 'tool' && site !== 'step' && site !== 'start') return { kind: 'pass' } // spawn and interrupt cannot refuse
      const denyText = refusalText(s.attended ? 'stop' : 'headless', s, a, sx.sid)
      if (site === 'start') {
        // P1 recovery: interrupt, else hold. Never deny, never pass.
        if (await interrupt(sx, call)) return { kind: 'deny', text: denyText }
        return holdStopped(sx, call, site, s, a)
      }
      let noDialog = false
      let autoStop = false
      try {
        const st = sx.store.read()
        noDialog = st.stopMeta?.noDialog === true
        const r = parseStopped(st.stopped)
        autoStop = r?.kinds !== undefined && r.auto === true
      } catch (e) {
        d.log.debug(codexDebug.readFailed('the stop', errText(e)))
      }
      const hosted = s.attended && !noDialog ? await d.daemon.hosted(sx.thread) : false
      const pick = (h: boolean) =>
        refuseModeOf({ attended: s.attended, noDialog, hosted: h, autoStop, autoResume: s.cfg.autoResume, deniedThisTurn: deniedThisTurn(sx, call.turn) })
      let mode = pick(hosted)
      if (mode === 'interrupt') {
        if (await interrupt(sx, call)) return { kind: 'deny', text: denyText } // Codex dropped the call: the answer is ignored
        mode = pick(false) // the next rows: hold, or one deny then hold
      }
      if (mode === 'deny' && claimDenied(sx, call.turn)) return { kind: 'deny', text: denyText }
      return holdStopped(sx, call, site, s, a)
    },
  }
}
