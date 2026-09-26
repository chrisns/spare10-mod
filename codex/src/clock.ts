// The Clock seam (Codex design 3.8). The broker uses Node timers only through this seam, so the specs drive
// a fake clock (codex/test/helpers/clock.ts). Every owner of a timer compares wall-clock time at each cycle,
// so a laptop sleep only makes a release later.

export type Timer = { cancel(): void }

export type Clock = {
  /** Wall-clock time in ms since the epoch. */
  now(): number
  /** Resolves after `ms`. It resolves early, with no throw, when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  /** Runs `fn` once after `ms`, unless the timer is cancelled first. */
  after(ms: number, fn: () => void): Timer
  /** Runs `fn` every `ms` until the timer is cancelled. The first run is `ms` from now. */
  every(ms: number, fn: () => void): Timer
}

/** Node clamps a longer timer delay to 1 ms, so a longer wait runs as a chain of timers of at most this length. */
export const MAX_TIMER_MS = 2_147_483_647

const delayOf = (ms: number): number => (Number.isFinite(ms) && ms > 0 ? ms : 0)

/** One timer of any length on Node timers. `arm` re-arms it for the rest of a wait longer than MAX_TIMER_MS. */
function nodeAfter(ms: number, fn: () => void): Timer {
  let handle: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  const arm = (left: number): void => {
    const step = Math.min(left, MAX_TIMER_MS)
    handle = setTimeout(() => {
      handle = undefined
      if (cancelled) return
      if (left > step) arm(left - step)
      else fn()
    }, step)
  }
  arm(delayOf(ms))
  return {
    cancel() {
      cancelled = true
      if (handle !== undefined) clearTimeout(handle)
      handle = undefined
    },
  }
}

/** The production clock: Date.now and Node timers. The timers keep the process alive, as Node timers do. */
export const realClock: Clock = {
  now: () => Date.now(),
  sleep(ms, signal) {
    return new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve()
        return
      }
      const done = (): void => {
        timer.cancel()
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = nodeAfter(ms, done)
      signal?.addEventListener('abort', done, { once: true })
    })
  },
  after: nodeAfter,
  every(ms, fn) {
    const period = Math.max(1, delayOf(ms))
    let current: Timer | undefined
    let cancelled = false
    const arm = (): void => {
      current = nodeAfter(period, () => {
        if (cancelled) return
        arm()
        fn()
      })
    }
    arm()
    return {
      cancel() {
        cancelled = true
        current?.cancel()
      },
    }
  },
}
