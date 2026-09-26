import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { codexDebug } from '../../hooks/core/codex.ts'
import type { GateSite } from '../../hooks/core/codex.ts'
import type { Clock } from './clock.ts'
import { readJson } from './files.ts'
import type { Log } from './log.ts'
import type { Rollouts } from './rollout.ts'
import { FORMAT } from './store.ts'
import type { HeldEntry, SessionStore, ThreadState, Tx } from './store.ts'
import { BEAT_STALE_MS, TICK_MS } from './timing.ts'
import type { Wake } from './wake.ts'

// The held calls of a broker and their entries in `threads/<tid>.json` (Codex design 3.7, 4.3, 4.4, 4.12).
// question.ts, refuse.ts and the gate share these helpers. A held entry names the call, its site and turn,
// the question it waits on (none under a stop in hold mode), and the pids of its broker and host. The beat
// of the thread file says that the entries are alive: a waiter beats at most once per TICK_MS, so a beat
// write never wakes the other waiters into a loop of writes.

/**
 * One gate call that the broker may hold (7.2). `dropped` aborts when Codex dropped the call: an Esc, the
 * Interrupt gate, the broker's own `turn/interrupt`, or a turn end in the rollout (4.12). `holding` is the
 * actuator flag of 4.2: a call that holds answers its site's refusal when the gate fails or the broker shuts
 * down (3.4), never a pass. `attended` picks that refusal's text: set it before `holding`. `prompt`: the call
 * is a person prompt (CX18 finds it after a host restart).
 */
export type HeldCall = {
  id: string | number
  site: GateSite
  turn?: string
  since: number
  dropped: AbortSignal
  drop(): void
  holding: boolean
  attended?: boolean
  prompt?: string
}

/** The pids that own a held entry: this broker, and the Codex process that hosts its thread. */
export type HeldOwner = { brokerPid: number; hostPid: number }

/** The id of a call in a held entry. */
export const callId = (call: Pick<HeldCall, 'id'>): string => String(call.id)

/** A waiter beats the thread file at most this often (3.8: every 30 s while a call is held). */
export const BEAT_EVERY_MS = TICK_MS

/**
 * Adds the held entry of `call` to its thread file, in place of an earlier entry of the same call, and
 * beats. Run it inside `locked`. A fresh thread file takes the pids of the owner.
 */
export function addHeld(tx: Tx, tid: string, call: HeldCall, owner: HeldOwner, now: number, question?: string): void {
  const th = tx.thread(tid)
  const id = callId(call)
  const entry: HeldEntry = {
    call: id,
    site: call.site,
    ...(call.turn === undefined ? {} : { turn: call.turn }),
    since: call.since,
    ...(question === undefined ? {} : { question }),
    ...(call.prompt === undefined ? {} : { prompt: call.prompt }),
    brokerPid: owner.brokerPid,
    hostPid: owner.hostPid,
  }
  th.held = [...th.held.filter((e) => !(e.call === id && e.brokerPid === owner.brokerPid)), entry]
  if (th.brokerPid === 0) th.brokerPid = owner.brokerPid
  if (th.hostPid === 0) th.hostPid = owner.hostPid
  th.beat = now
}

/** Removes the held entry of `call` of this broker from its thread file. Run it inside `locked`. */
export function removeHeld(tx: Tx, tid: string, call: Pick<HeldCall, 'id'>, brokerPid: number): void {
  const th = tx.thread(tid)
  const id = callId(call)
  if (!th.held.some((e) => e.call === id && e.brokerPid === brokerPid)) return
  th.held = th.held.filter((e) => !(e.call === id && e.brokerPid === brokerPid))
}

/** The ids of the thread files of a session. No folder: none. */
export function threadIds(store: Pick<SessionStore, 'dir'>): string[] {
  try {
    return readdirSync(join(store.dir, 'threads'))
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .sort()
  } catch (e) {
    const code = (e as { code?: unknown }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw e
  }
}

/** A thread file with no lock: undefined when it is absent or of another format. Bad JSON throws. */
export function readThread(store: Pick<SessionStore, 'dir'>, tid: string): ThreadState | undefined {
  const v = readJson<unknown>(join(store.dir, 'threads', `${tid}.json`))
  if (typeof v !== 'object' || v === null || (v as { v?: unknown }).v !== FORMAT) return undefined
  return v as ThreadState
}

/** A thread whose beat is younger than BEAT_STALE_MS: its held entries are alive (4.3). */
export const freshBeat = (th: Pick<ThreadState, 'beat'>, now: number): boolean => now - th.beat < BEAT_STALE_MS

/**
 * Inside `locked`: a live held entry waits on `key`. An entry is live while its broker's pid is alive and
 * its thread file has a fresh beat. The beat is per thread file, and a new broker of the same thread (after
 * a restart) beats it too, so the pid tells a dead broker's entry apart.
 */
export function heldNames(tx: Tx, store: Pick<SessionStore, 'dir'>, key: string, now: number, alive: (pid: number) => boolean): boolean {
  for (const tid of threadIds(store)) {
    const th = tx.thread(tid)
    if (freshBeat(th, now) && th.held.some((e) => e.question === key && alive(e.brokerPid))) return true
  }
  return false
}

/** Beats the thread file of `tid` (best effort: a failure only logs). */
export function beat(store: Pick<SessionStore, 'locked'>, tid: string, now: number, log: Log): void {
  try {
    store.locked((tx) => {
      tx.thread(tid).beat = now
    })
  } catch (e) {
    log.debug(codexDebug.writeFailed(`the beat of ${tid}`, e instanceof Error ? e.message : String(e)))
  }
}

/**
 * 4.12 item 3: the rollout of the thread shows the end of `turn` (`turn_aborted` or `task_complete`). A
 * read that fails is no end.
 */
export function turnEnded(rollouts: Pick<Rollouts, 'read'>, transcript: string | null, turn: string | undefined): boolean {
  if (transcript === null || transcript === '' || turn === undefined) return false
  try {
    return rollouts.read(transcript).turnEnds.has(turn)
  } catch {
    return false
  }
}

/** The wait of one held call: a wake of its session, its drop, or a time. */
export type Waiter = {
  /** Resolves at once when a wake or the drop came since the last call, else at the first of them or after `ms`. */
  next(ms: number): Promise<void>
  close(): void
}

/**
 * A waiter on the session folder `dir`. A wake that comes while the caller checks the files is kept, so
 * the next `next` returns at once and the caller checks again: no wake is lost between a check and a wait.
 */
export function waiterOf(d: { clock: Pick<Clock, 'sleep'>; wake: Pick<Wake, 'watch'> }, dir: string, signal: AbortSignal): Waiter {
  let pending = false
  let release: (() => void) | undefined
  const fire = (): void => {
    pending = true
    const r = release
    release = undefined
    r?.()
  }
  const unwatch = d.wake.watch(dir, fire)
  signal.addEventListener('abort', fire)
  return {
    async next(ms) {
      if (pending || signal.aborted) {
        pending = false
        return
      }
      const ac = new AbortController()
      try {
        await new Promise<void>((resolve) => {
          release = resolve
          void d.clock.sleep(Math.max(0, ms), ac.signal).then(() => {
            if (release === resolve) release = undefined
            resolve()
          })
        })
      } finally {
        ac.abort()
        pending = false
      }
    },
    close() {
      unwatch()
      signal.removeEventListener('abort', fire)
    },
  }
}
