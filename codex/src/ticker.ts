import { codexDebug, codexText } from '../../hooks/core/codex.ts'
import { formatStopped, parseStopped, stopAction, stopDue } from '../../hooks/core/decide.ts'
import { endedFor, extendNotice, extended, namedStop, tickPlan } from '../../hooks/core/flow.ts'
import { debugLine, notice, resumePrompt } from '../../hooks/core/text.ts'
import type { AttendanceSource } from './attend.ts'
import type { Timer } from './clock.ts'
import type { DaemonLink } from './daemon.ts'
import type { Deps } from './deps.ts'
import { readThread } from './held.ts'
import type { Quota } from './quota.ts'
import { noReading } from './sense.ts'
import type { SenseApi, SessionCtx } from './sense.ts'
import type { SettingsSource } from './settings.ts'
import { clearStopped, noticeIn } from './stop.ts'
import type { Sweep } from './sweep.ts'
import { CONTINUATION_TTL_MS, LIVE_RELEASE_MAX_AGE_MS, TICK_MS } from './timing.ts'

// The root ticker (Codex design 3.8, 4.6, 4.23, A17, 7.2 ticker.ts). Only the broker of the root thread
// runs it, every TICK_MS from its first root gate on, for its own session. Each cycle sweeps the running
// turns of the session while an attended stop is in force (the stop sweep), and at the due time of an
// auto stop it extends the stop, ends it, or continues the stopped work with `turn/start` (the Codex
// form of stopTick, extendStop and submitResume of register.tsx). It never continues work unless the
// daemon hosts the root thread: held work in a thread with no daemon releases in place (4.4).

export type TickerDeps = Pick<Deps, 'clock' | 'log'> & {
  settings: Pick<SettingsSource, 'get'>
  quota: Pick<Quota, 'live'>
  sense: SenseApi
  attendance: AttendanceSource
  daemon: Pick<DaemonLink, 'get' | 'hosted'>
  sweep: Pick<Sweep, 'sweep'>
  /** The liveness test of a held entry's broker. Default: every broker is alive. */
  pidAlive?: (pid: number) => boolean
}

export type Ticker = {
  /** Starts the ticker of the root session `sx`, once. */
  start(sx: SessionCtx): void
  /** Stops it (the broker shuts down). */
  stop(): void
  /** One cycle now, for the specs. Never throws. */
  tick(): Promise<void>
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** CX39: spare10 interrupted a turn of the stop that began at `at`. */
const interruptedSince = (interrupts: Record<string, number> | undefined, at: number): boolean =>
  Object.values(interrupts ?? {}).some((t) => t >= at)

export function createTicker(d: TickerDeps): Ticker {
  const alive = d.pidAlive ?? ((): boolean => true)
  /** A live held prompt of the root thread in `turn`. A read that fails is none. */
  const heldPrompt = (sx: SessionCtx, turn: string): boolean => {
    try {
      return readThread(sx.store, sx.sid)?.held.some((e) => e.site === 'prompt' && e.turn === turn && alive(e.brokerPid)) === true
    } catch {
      return false
    }
  }
  let timer: Timer | undefined
  let session: SessionCtx | undefined
  let busy = false

  /** 4.6 stopTick of the root session. */
  const stopTick = async (sx: SessionCtx): Promise<void> => {
    const st0 = sx.store.read()
    const raw = st0.stopped
    const r = parseStopped(raw)
    if (raw === undefined || r === undefined || r.sessionId !== sx.sid) return
    const attended = d.attendance.attended({ transcript: sx.transcript }, sx.mode).attended
    // 4.23: the sweep at each cycle while an attended stop is in force. It leaves the held work of a held stop (4.4).
    if (attended && d.clock.now() < r.windowEnd) await d.sweep.sweep(sx)
    const now = d.clock.now()
    if (r.kinds === undefined || r.auto !== true || now < stopDue(r)) return
    const cfg = d.settings.get()
    // `drop` has no Codex case: a stop belongs to its session.
    if (stopAction({ record: r, now, sessionId: sx.sid, autoResume: cfg.autoResume, enabled: cfg.enabled, attended }) !== 'check') return
    if (!(await d.daemon.hosted(sx.sid))) return // not hosted: held work releases in place (4.4)
    await d.quota.live(LIVE_RELEASE_MAX_AGE_MS)
    const s = await d.sense.sense(sx)
    if (noReading(s)) return // 3.6: no reading at all, nothing is released at this cycle
    const gatingNow = d.sense.split(sx, s).gating
    const plan = tickPlan(gatingNow, d.sense.resetTooRecent(sx, s))
    if (plan === 'skip') return // a test stop that ends near a real reset (4.8)
    if (plan === 'extend') {
      const holders = d.sense.holders(sx, s, gatingNow) // TS1: the real tag of an extension
      sx.store.locked((tx) => {
        if (tx.state.stopped !== raw) return // a prompt, a command or a release took it
        const longer = extended(r, gatingNow, holders, s.now)
        tx.state.stopped = formatStopped(longer)
        noticeIn(tx.state, extendNotice(r, longer, gatingNow, s), s.now)
      })
      return
    }
    const ended = endedFor(namedStop(r), s, [], r.skip === true) // skip 4.5: what reset and what opened
    if (r.work === true) {
      const daemon = d.daemon.get()
      if (daemon === undefined) return
      const status = await daemon.status(sx.sid)
      const newest = await daemon.newestTurn(sx.sid)
      // A person prompt of that turn still waits on its gate (a prompt question in a stopped session): its
      // own decision takes the stop over with the B35 note, as register.tsx does. The ticker leaves it.
      if (newest !== undefined && heldPrompt(sx, newest.id)) return
      if (newest !== undefined && newest.startedAt !== null && newest.startedAt * 1000 > r.at) {
        // A turn after the stop: the person went on. The stop ends, and spare10 sends nothing.
        const cleared = sx.store.locked((tx) => {
          if (tx.state.stopped !== raw) return false
          clearStopped(tx.state)
          return true
        })
        if (cleared) d.log.debug(debugLine.resumeSkipped)
        return
      }
      if (status !== 'idle') return // a turn still runs: the next cycle looks again
    }
    const at = d.clock.now()
    const text = sx.store.locked((tx): string | undefined => {
      if (tx.state.stopped !== raw) return undefined
      clearStopped(tx.state)
      if (r.work !== true) {
        noticeIn(tx.state, notice.resetStopOver(ended.reset, ended.open), at)
        return undefined
      }
      const prompt = resumePrompt(ended.reset, ended.open)
      const t = interruptedSince(tx.state.interrupts, r.at) ? `${codexText.interruptedNote} ${prompt}` : prompt
      tx.state.continuation = { text: t, expiresAt: at + CONTINUATION_TTL_MS, notice: notice.resetResumes(ended.reset, ended.open) }
      return t
    })
    if (text === undefined) return
    try {
      const daemon = d.daemon.get()
      if (daemon === undefined) throw new Error('the Codex daemon is gone')
      await daemon.start(sx.sid, text)
    } catch (e) {
      const reason = errText(e)
      d.log.debug(codexDebug.startFailed(reason))
      sx.store.locked((tx) => {
        if (tx.state.continuation?.text === text) delete tx.state.continuation
        noticeIn(tx.state, notice.resumeFailed(reason), d.clock.now())
      })
    }
  }

  const tick = async (): Promise<void> => {
    const sx = session
    if (sx === undefined || busy) return
    busy = true
    try {
      await stopTick(sx)
    } catch (e) {
      d.log.debug(debugLine.checkFailed(errText(e)))
    } finally {
      busy = false
    }
  }

  return {
    start(sx) {
      if (timer !== undefined) return
      session = sx
      timer = d.clock.every(TICK_MS, () => void tick())
    },
    stop() {
      timer?.cancel()
      timer = undefined
    },
    tick,
  }
}
