import { codexDebug } from '../../hooks/core/codex.ts'
import { parseStopped } from '../../hooks/core/decide.ts'
import type { Daemon, DaemonLink, TurnInfo } from './daemon.ts'
import { DaemonError } from './daemon.ts'
import type { Deps } from './deps.ts'
import type { Log } from './log.ts'
import { readThread, threadIds } from './held.ts'
import type { SessionStore } from './store.ts'
import { INTERRUPT_MARK_MS, INTERRUPT_MS, INTERRUPT_POLL_MS } from './timing.ts'

// The stop sweep (Codex design 4.23, A18). A shell command that yields keeps polling with `write_stdin`,
// which has no PreToolUse and gives PostToolUse only at its end, so a held-call refusal alone cannot end
// such a turn. When a stop starts on the daemon, and at each root ticker cycle while it lasts, the acting
// process interrupts every running turn of the session that started at or before the stop. It never
// interrupts a turn that started after the stop: that turn passed its own gates (a Luna turn, a consent).
// Without the daemon there is no sweep (degraded 11).

export type SweepCtx = { sid: string; store: Pick<SessionStore, 'dir' | 'read' | 'locked'> }

export type InterruptDeps = Pick<Deps, 'clock' | 'log'> & {
  daemon: Pick<DaemonLink, 'get'>
  /** The broker marks its own held calls of that thread and turn as dropped (4.12 item 2), once the turn is interrupted. */
  onInterrupted?: (thread: string, turn: string) => void
}

/**
 * One interrupt: `sent` this caller interrupted the turn; `joined` another caller of this process did, or
 * the turn that another process marked no longer runs; `skipped` another caller has it and this one does not
 * wait; `failed` the turn may still run (no daemon, a lock or write failure, a failed or timed out interrupt).
 */
export type InterruptResult = 'sent' | 'joined' | 'skipped' | 'failed'

export type Interrupts = {
  /**
   * 4.4, 4.23: `turn/interrupt` of `turn` of `thread`, once per turn, shared by the refusals, the stop sweep
   * and the shutdown of one process. The first caller marks the turn (CX39) and sends the interrupt. A caller
   * that finds the turn in flight in this process awaits that interrupt and takes its result. A caller that
   * finds a mark of another process (the CLI sweep, another broker) waits until `thread/turns/list` shows the
   * turn no longer in progress, for at most INTERRUPT_MS. `join: false` waits for no other caller (the sweep).
   * The calls of the turn drop only once it is interrupted. Never throws.
   */
  interrupt(sx: Pick<SweepCtx, 'store'>, thread: string, turn: string, o?: { join?: boolean }): Promise<InterruptResult>
}

export type SweepDeps = InterruptDeps & {
  /** The interrupts of this process. Default: its own (the CLI). */
  interrupts?: Interrupts
}

export type Sweep = {
  /** Interrupts each running turn of the session that the stop covers. The number of turns it interrupted. Never throws. */
  sweep(sx: SweepCtx): Promise<number>
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** A turn that started after the stop (its `startedAt` in unix seconds) passed its own gates. An unknown start is swept (fail closed). */
export const coveredBy = (t: Pick<TurnInfo, 'startedAt'>, stopAt: number): boolean => t.startedAt === null || t.startedAt * 1000 <= stopAt

/**
 * `turn/interrupt` with the rule of 3.5: the reply comes only after the abort, so a timeout is no failure.
 * After a timeout the newest turn decides: the turn counts as interrupted unless it is still the newest
 * and still `inProgress`. Any other error, or a failed look, is a failure.
 */
export async function interruptTurn(daemon: Pick<Daemon, 'interrupt' | 'newestTurn'>, thread: string, turn: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await daemon.interrupt(thread, turn)
    return { ok: true }
  } catch (e) {
    if (!(e instanceof DaemonError && e.kind === 'timeout')) return { ok: false, error: errText(e) }
    try {
      const t = await daemon.newestTurn(thread)
      return t !== undefined && t.id === turn && t.status === 'inProgress' ? { ok: false, error: errText(e) } : { ok: true }
    } catch (e2) {
      return { ok: false, error: errText(e2) }
    }
  }
}

/**
 * A mark: `mine` this call marked the turn, and `lost` is the mark older than INTERRUPT_MARK_MS that it
 * replaced. `taken` a sweep or another held call of the turn marked it first. `failed` the lock or the
 * write failed, so nothing is marked.
 */
export type Mark = { kind: 'mine'; lost?: number } | { kind: 'taken' } | { kind: 'failed' }

/**
 * Under the lock: marks the turn as interrupted by spare10 (CX39, 4.4), before the interrupt goes out. A
 * mark older than INTERRUPT_MARK_MS is lost (its process died, or it could not unmark), so this call takes it.
 */
export function markInterrupt(sx: Pick<SweepCtx, 'store'>, turn: string, at: number, log: Log): Mark {
  try {
    return sx.store.locked((tx): Mark => {
      const i = tx.state.interrupts ?? {}
      const prev = i[turn]
      if (prev !== undefined && Math.abs(at - prev) < INTERRUPT_MARK_MS) return { kind: 'taken' }
      tx.state.interrupts = { ...i, [turn]: at }
      return prev === undefined ? { kind: 'mine' } : { kind: 'mine', lost: prev }
    })
  } catch (e) {
    log.debug(codexDebug.writeFailed('the interrupted turns', errText(e)))
    return { kind: 'failed' }
  }
}

/**
 * Under the lock: the mark of a turn that was not interrupted goes, so that a later sweep or refusal tries
 * again and CX39 stays right. `lost`: the older mark that this one replaced comes back.
 */
export function unmarkInterrupt(sx: Pick<SweepCtx, 'store'>, turn: string, at: number, log: Log, lost?: number): void {
  try {
    sx.store.locked((tx) => {
      const i = { ...(tx.state.interrupts ?? {}) }
      if (i[turn] !== at) return
      if (lost !== undefined) i[turn] = lost
      else delete i[turn]
      if (Object.keys(i).length === 0) delete tx.state.interrupts
      else tx.state.interrupts = i
    })
  } catch (e) {
    log.debug(codexDebug.writeFailed('the interrupted turns', errText(e)))
  }
}

/** The confirmed interrupts that a process keeps, so a later caller of the same turn asks nothing. */
const DONE_KEPT = 64

export function createInterrupts(d: InterruptDeps): Interrupts {
  const inflight = new Map<string, Promise<boolean>>()
  const done = new Set<string>()
  const keyOf = (thread: string, turn: string): string => `${thread}\u0000${turn}`

  /** A mark of another process: the turn counts as interrupted once the daemon shows it no longer in progress. */
  const ended = async (daemon: Pick<Daemon, 'newestTurn'>, thread: string, turn: string): Promise<boolean> => {
    const deadline = d.clock.now() + INTERRUPT_MS
    for (;;) {
      let t: TurnInfo | undefined
      try {
        t = await daemon.newestTurn(thread)
      } catch (e) {
        d.log.debug(codexDebug.readFailed(`the newest turn of ${thread}`, errText(e)))
        return false
      }
      if (t === undefined || t.id !== turn || t.status !== 'inProgress') return true
      const left = deadline - d.clock.now()
      if (left <= 0) {
        d.log.debug(codexDebug.interruptFailed(`the turn ${turn} still runs ${INTERRUPT_MS} ms after another process marked it`))
        return false
      }
      await d.clock.sleep(Math.min(INTERRUPT_POLL_MS, left))
    }
  }

  return {
    async interrupt(sx, thread, turn, o = {}) {
      const join = o.join !== false
      const key = keyOf(thread, turn)
      if (done.has(key)) return join ? 'joined' : 'skipped'
      const running = inflight.get(key)
      if (running !== undefined) return join ? ((await running) ? 'joined' : 'failed') : 'skipped'
      let daemon: Daemon | undefined
      try {
        daemon = d.daemon.get()
      } catch (e) {
        d.log.debug(codexDebug.interruptFailed(errText(e)))
        daemon = undefined
      }
      if (daemon === undefined) return 'failed'
      const dm = daemon
      const at = d.clock.now()
      // The mark comes first, so the root Interrupt gate and CX39 know that spare10 caused it.
      const mark = markInterrupt(sx, turn, at, d.log)
      if (mark.kind === 'failed') return 'failed'
      if (mark.kind === 'taken' && !join) return 'skipped'
      const p = (async (): Promise<boolean> => {
        if (mark.kind === 'taken') return ended(dm, thread, turn)
        const r = await interruptTurn(dm, thread, turn)
        if (r.ok) return true
        d.log.debug(codexDebug.interruptFailed(r.error))
        unmarkInterrupt(sx, turn, at, d.log, mark.lost)
        return false
      })()
      inflight.set(key, p)
      let ok = false
      try {
        ok = await p
      } catch (e) {
        d.log.debug(codexDebug.interruptFailed(errText(e)))
        ok = false
      } finally {
        if (inflight.get(key) === p) inflight.delete(key)
      }
      if (!ok) return 'failed'
      done.add(key)
      for (const k of done) {
        if (done.size <= DONE_KEPT) break
        done.delete(k)
      }
      d.onInterrupted?.(thread, turn)
      return mark.kind === 'mine' ? 'sent' : 'joined'
    },
  }
}

export function createSweep(d: SweepDeps): Sweep {
  const interrupts = d.interrupts ?? createInterrupts(d)
  return {
    async sweep(sx) {
      try {
        const state = sx.store.read()
        const stop = parseStopped(state.stopped)
        if (stop === undefined || stop.sessionId !== sx.sid || d.clock.now() >= stop.windowEnd) return 0
        // 4.4: a held stop (the question could not show) holds its held work in place, also in a hosted
        // thread. The sweep still ends every other running turn of the session.
        const heldStop = state.stopMeta?.noDialog === true
        const daemon = d.daemon.get()
        if (daemon === undefined) return 0
        const loaded = new Set(await daemon.loaded())
        let n = 0
        for (const tid of threadIds(sx.store)) {
          if (!loaded.has(tid)) continue
          let t: TurnInfo | undefined
          try {
            t = await daemon.newestTurn(tid)
          } catch (e) {
            d.log.debug(codexDebug.readFailed(`the newest turn of ${tid}`, errText(e)))
            continue
          }
          if (t === undefined || t.status !== 'inProgress' || !coveredBy(t, stop.at)) continue
          if (heldStop && readThread(sx.store, tid)?.held.some((e) => e.turn === t.id) === true) continue
          // A turn that another caller interrupts is theirs: the sweep does not wait for it.
          if ((await interrupts.interrupt(sx, tid, t.id, { join: false })) === 'sent') n += 1
        }
        if (n > 0) d.log.debug(codexDebug.swept(n))
        return n
      } catch (e) {
        d.log.debug(codexDebug.interruptFailed(errText(e)))
        return 0
      }
    },
  }
}
