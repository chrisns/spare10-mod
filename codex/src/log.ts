import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock } from './clock.ts'

// The debug log of the broker and the CLI (Codex design 1.2, 3.7): the Codex form of $.ui.log(..., { to:
// 'debug' }). One file per UTC day, `<data dir>/log/broker-<yyyy-mm-dd>.log`, only with SPARE10_CODEX_DEBUG=1.
// Debug lines keep their own `spare10: `. A log never throws: a full disk must not change a gate answer.

export type Log = { debug(line: string): void }

/** A log that drops every line. */
export const noLog: Log = { debug() {} }

/** True when the env switches the debug log on. */
export const debugOn = (env: Readonly<Record<string, string | undefined>>): boolean => env.SPARE10_CODEX_DEBUG === '1'

/** The log file of the UTC day of `at`. */
export const logFileOf = (dataDir: string, at: number): string =>
  join(dataDir, 'log', `broker-${new Date(at).toISOString().slice(0, 10)}.log`)

/**
 * The file log. Each line is `<ISO time> [<tag>] <line>`, where the tag (for example `pid 4242`) tells
 * apart the brokers that share the file. A line with newlines stays one entry: its newlines become `\n`.
 * With `on` false, the log writes nothing and makes no folder.
 */
export function fileLog(dataDir: string, on: boolean, clock: Clock, o: { tag?: string } = {}): Log {
  if (!on) return noLog
  const tag = o.tag === undefined ? '' : ` [${o.tag}]`
  return {
    debug(line) {
      try {
        const at = clock.now()
        const file = logFileOf(dataDir, at)
        mkdirSync(join(dataDir, 'log'), { recursive: true, mode: 0o700 })
        appendFileSync(file, `${new Date(at).toISOString()}${tag} ${line.replace(/\r?\n/g, '\\n')}\n`, { mode: 0o600 })
      } catch {
        // No log is better than a failed gate.
      }
    },
  }
}
