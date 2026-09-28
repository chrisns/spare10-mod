import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock } from './clock.ts'

// The debug log of the broker and the CLI (Codex design 1.2, 3.7): the Codex form of $.ui.log(..., { to:
// 'debug' }). One file per UTC day, `<data dir>/log/broker-<yyyy-mm-dd>.log`, only with SPARE10_CODEX_DEBUG=1.
// Debug lines keep their own `spare10: `. A log never throws: a full disk must not change a gate answer.
// A flag that stays on must not fill the disk: the day files go after LOG_KEEP_DAYS, and a day file stops at
// LOG_DAY_MAX_BYTES.

export type Log = { debug(line: string): void }

/** A log that drops every line. */
export const noLog: Log = { debug() {} }

/** True when the env switches the debug log on. */
export const debugOn = (env: Readonly<Record<string, string | undefined>>): boolean => env.SPARE10_CODEX_DEBUG === '1'

/** The days of day files that the log keeps: the UTC day of the line and the 6 days before it. */
export const LOG_KEEP_DAYS = 7

/** The size at which a day file takes no more lines. */
export const LOG_DAY_MAX_BYTES = 50 * 1024 * 1024

const DAY_MS = 86_400_000

/** The UTC day of `at`, `yyyy-mm-dd`. */
const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10)

const DAY_FILE = /^broker-(\d{4}-\d{2}-\d{2})\.log$/

/** The log file of the UTC day of `at`. */
export const logFileOf = (dataDir: string, at: number): string => join(dataDir, 'log', `broker-${dayOf(at)}.log`)

/**
 * Removes the day files older than LOG_KEEP_DAYS before the UTC day of `at`. Only a name of the day file form
 * counts. A day after the day of `at` stays: the clock can step back. unlink never follows a link and fails on
 * a folder, and each failure is ignored, also when another broker removed the file first.
 */
function pruneLogs(dataDir: string, at: number): void {
  const oldest = dayOf(at - (LOG_KEEP_DAYS - 1) * DAY_MS)
  const dir = join(dataDir, 'log')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const day = DAY_FILE.exec(name)?.[1]
    if (day === undefined || day >= oldest) continue
    try {
      unlinkSync(join(dir, name))
    } catch {
      // Gone already, or not a file: nothing to do.
    }
  }
}

/**
 * The file log. Each line is `<ISO time> [<tag>] <line>`, where the tag (for example `pid 4242`) tells
 * apart the brokers that share the file. A line with newlines stays one entry: its newlines become `\n`.
 * With `on` false, the log writes nothing and makes no folder. The first line of each UTC day removes the old
 * day files (pruneLogs). A line that finds its day file at LOG_DAY_MAX_BYTES or more is dropped.
 */
export function fileLog(dataDir: string, on: boolean, clock: Clock, o: { tag?: string } = {}): Log {
  if (!on) return noLog
  const tag = o.tag === undefined ? '' : ` [${o.tag}]`
  /** The UTC day of the last prune of this log. */
  let pruned = ''
  return {
    debug(line) {
      try {
        const at = clock.now()
        const file = logFileOf(dataDir, at)
        mkdirSync(join(dataDir, 'log'), { recursive: true, mode: 0o700 })
        if (pruned !== dayOf(at)) {
          pruned = dayOf(at)
          pruneLogs(dataDir, at)
        }
        if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) >= LOG_DAY_MAX_BYTES) return
        appendFileSync(file, `${new Date(at).toISOString()}${tag} ${line.replace(/\r?\n/g, '\\n')}\n`, { mode: 0o600 })
      } catch {
        // No log is better than a failed gate.
      }
    },
  }
}
