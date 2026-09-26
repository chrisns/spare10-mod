import type { Clock, Timer } from '../../src/clock.ts'

// The fake clock of the Codex specs (Codex design 8.2). Time moves only in advance(). The due timers run
// in time order (in arm order at one time), and the clock settles after each, so the work that a timer
// starts can arm the next timer before the clock looks again.

export type FakeClock = Clock & {
  /** Moves time on by `ms`, and runs each timer that falls due on the way. */
  advance(ms: number): Promise<void>
  /** Moves time on to `at`, as advance does. A time in the past runs only the due timers. */
  advanceTo(at: number): Promise<void>
  /** Drains the microtasks and a few setImmediate turns. */
  settle(): Promise<void>
  /** The number of armed timers, sleeps included. */
  pending(): number
}

type Entry = { due: number; seq: number; period?: number; fn: () => void; live: boolean }

/** Ten setImmediate turns: every promise chain and every short async hop runs to its end. */
export async function settleTurns(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

/** A fake clock that starts at `start` (ms since the epoch). `o.settle` replaces the settle between timers. */
export function fakeClock(start: number, o: { settle?: () => Promise<void> } = {}): FakeClock {
  let now = start
  let seq = 0
  const timers = new Set<Entry>()
  const settle = o.settle ?? (() => settleTurns())

  const arm = (ms: number, fn: () => void, period?: number): Entry => {
    const d = Number.isFinite(ms) && ms > 0 ? ms : 0
    const e: Entry = { due: now + d, seq: seq++, fn, live: true }
    if (period !== undefined) e.period = period
    timers.add(e)
    return e
  }
  const timerOf = (e: Entry): Timer => ({
    cancel() {
      e.live = false
      timers.delete(e)
    },
  })
  const nextDue = (limit: number): Entry | undefined => {
    let best: Entry | undefined
    for (const e of timers) {
      if (e.due > limit) continue
      if (best === undefined || e.due < best.due || (e.due === best.due && e.seq < best.seq)) best = e
    }
    return best
  }

  const advanceTo = async (target: number): Promise<void> => {
    await settle()
    for (;;) {
      const e = nextDue(target)
      if (e === undefined) break
      if (e.due > now) now = e.due
      timers.delete(e)
      if (e.period !== undefined && e.live) {
        // Re-arm first, so a throw or a cancel inside fn acts on the next run as with the real clock.
        e.due += e.period
        e.seq = seq++
        timers.add(e)
      }
      e.fn()
      await settle()
    }
    if (target > now) now = target
  }

  return {
    now: () => now,
    sleep(ms, signal) {
      return new Promise<void>((resolve) => {
        if (signal?.aborted === true) {
          resolve()
          return
        }
        let t: Timer | undefined
        const done = (): void => {
          t?.cancel()
          signal?.removeEventListener('abort', done)
          resolve()
        }
        t = timerOf(arm(ms, done))
        signal?.addEventListener('abort', done, { once: true })
      })
    },
    after: (ms, fn) => timerOf(arm(ms, fn)),
    every: (ms, fn) => {
      const period = Number.isFinite(ms) && ms >= 1 ? ms : 1
      return timerOf(arm(period, fn, period))
    },
    advance: (ms) => advanceTo(now + Math.max(0, ms)),
    advanceTo,
    settle,
    pending: () => timers.size,
  }
}
