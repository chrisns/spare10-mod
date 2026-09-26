import { statSync, watch } from 'node:fs'
import { join, resolve } from 'node:path'
import { codexDebug } from '../../hooks/core/codex.ts'
import type { Clock, Timer } from './clock.ts'
import type { Log } from './log.ts'
import { WAKE_POLL_MS } from './timing.ts'

// The Wake source (Codex design 3.7). A waiter of a session watches the session folder. A change of a
// session file there (WAKE_FILES) wakes every waiter of that session in this broker (the Codex form of
// wakeAll). The lock, the temp files and the thread files wake no one. The specs use one in-process
// emitter that the world shares (codex/test/helpers/wake.ts), and every store write fires it.

export type Wake = {
  /** Calls `fn` at each change in `dir`. The result stops the watch. */
  watch(dir: string, fn: () => void): () => void
  /** Wakes the waiters of `dir`. In production the file events do it, so it does nothing. */
  fire(dir: string): void
}

/** The session files whose mtime the poll compares (3.7). */
export const WAKE_FILES: readonly string[] = ['state.json', 'question.json', 'answer.json']

/** A short mark of one file for the poll: its inode, size and mtime, or `-` when it is absent. */
function markOf(file: string): string {
  try {
    const st = statSync(file)
    return `${st.ino}:${st.size}:${st.mtimeMs}`
  } catch {
    return '-'
  }
}

const marksOf = (dir: string): string => WAKE_FILES.map((f) => markOf(join(dir, f))).join(' ')

/** One folder watch: `onEvent` at each change in `dir`, `onError` when the watch fails. It throws when it cannot start. */
export type WatchDir = (dir: string, onEvent: () => void, onError: (e: unknown) => void) => { close(): void }

/** The folder watch of Node: `fs.watch`, not recursive. An event with no file name wakes too. */
export const nodeWatchDir: WatchDir = (dir, onEvent, onError) => {
  const w = watch(dir, { persistent: true }, (_ev, name) => {
    // A lock, a temp file or the folder itself tells a waiter nothing: the poll compares only WAKE_FILES.
    if (name === null || name === undefined || WAKE_FILES.includes(String(name))) onEvent()
  })
  w.on('error', onError)
  return w
}

type Entry = { fns: Set<() => void>; watcher?: { close(): void }; poll: Timer; marks: string }

/**
 * The production Wake: `fs.watch` on the session folder, plus a poll of the mtime of the session files every
 * WAKE_POLL_MS while any waiter watches (`fs.watch` can miss an event, and a folder can appear later). The
 * watch and the poll of a folder live only while it has a waiter. `o.watchDir` replaces `fs.watch` in the specs.
 */
export function fsWake(clock: Clock, log: Log, o: { watchDir?: WatchDir } = {}): Wake {
  const watchDir = o.watchDir ?? nodeWatchDir
  const entries = new Map<string, Entry>()

  const wakeAll = (e: Entry): void => {
    for (const fn of [...e.fns]) {
      try {
        fn()
      } catch (err) {
        log.debug(codexDebug.wakeFailed(String(err)))
      }
    }
  }

  const close = (dir: string, e: Entry): void => {
    e.poll.cancel()
    try {
      e.watcher?.close()
    } catch {
      // A watcher that fails to close is gone already.
    }
    e.watcher = undefined
    entries.delete(dir)
  }

  const startWatcher = (dir: string, e: Entry): void => {
    let w: { close(): void } | undefined
    try {
      w = watchDir(
        dir,
        () => {
          if (e.watcher !== w) return // an event of a watch that ended
          // The poll then sees no change for this event, so one change wakes the waiters once.
          e.marks = marksOf(dir)
          wakeAll(e)
        },
        (err) => {
          log.debug(codexDebug.watchFailed(dir, String(err)))
          try {
            w?.close()
          } catch {
            // Closed already.
          }
          if (e.watcher === w) e.watcher = undefined
        },
      )
      e.watcher = w
    } catch {
      // No folder yet, or no watch on this file system: the poll does the work, and starts the watch later.
      e.watcher = undefined
    }
  }

  return {
    watch(dir, fn) {
      const key = resolve(dir)
      let e = entries.get(key)
      if (e === undefined) {
        const entry: Entry = { fns: new Set(), marks: marksOf(key), poll: { cancel() {} } }
        entry.poll = clock.every(WAKE_POLL_MS, () => {
          if (entry.watcher === undefined) startWatcher(key, entry)
          const now = marksOf(key)
          if (now === entry.marks) return
          entry.marks = now
          wakeAll(entry)
        })
        startWatcher(key, entry)
        entries.set(key, entry)
        e = entry
      }
      const mine = (): void => fn()
      e.fns.add(mine)
      const entry = e
      return () => {
        entry.fns.delete(mine)
        if (entry.fns.size === 0 && entries.get(key) === entry) close(key, entry)
      }
    },
    fire() {},
  }
}
