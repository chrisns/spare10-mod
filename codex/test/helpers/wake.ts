import { resolve } from 'node:path'
import type { Wake } from '../../src/wake.ts'

// The in-process Wake of the Codex specs (Codex design 3.7, 8.2). The world shares one, and every store
// write fires it. A fire calls the waiters of that folder in a microtask, as a file event comes later in
// production, so a waiter never runs inside the lock of the write that woke it.

export type MemoryWake = Wake & {
  /** The folders fired so far, in order. */
  readonly fired: string[]
  /** The number of waiters of `dir`. */
  waiters(dir: string): number
}

export function memoryWake(): MemoryWake {
  const fns = new Map<string, Set<() => void>>()
  const fired: string[] = []
  return {
    fired,
    watch(dir, fn) {
      const key = resolve(dir)
      let set = fns.get(key)
      if (set === undefined) {
        set = new Set()
        fns.set(key, set)
      }
      const mine = (): void => fn()
      set.add(mine)
      const owner = set
      return () => {
        owner.delete(mine)
        if (owner.size === 0 && fns.get(key) === owner) fns.delete(key)
      }
    },
    fire(dir) {
      const key = resolve(dir)
      fired.push(key)
      const set = fns.get(key)
      if (set === undefined) return
      const now = [...set]
      queueMicrotask(() => {
        for (const fn of now) if (set.has(fn)) fn()
      })
    },
    waiters: (dir) => fns.get(resolve(dir))?.size ?? 0,
  }
}
