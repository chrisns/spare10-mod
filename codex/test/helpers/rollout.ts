import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// Fake rollout files of the Codex specs (Codex design 8.2). Each line has the shape of the probed lines
// (codex-research probe-gap3, probe-gap6, probe-gap8), with only the fields spare10 reads and a few others.

/** One window: `pct` used, `mins` long, and its reset as ms since the epoch or as an RFC 3339 string. */
export type WindowSpec = { pct: number; mins: number; resetsAt: number | string }

export const iso = (ms: number): string => new Date(ms).toISOString()

const windowOf = (w: WindowSpec | null | undefined): object | null =>
  w === undefined || w === null
    ? null
    : { used_percent: w.pct, window_minutes: w.mins, resets_at: typeof w.resetsAt === 'number' ? Math.floor(w.resetsAt / 1000) : w.resetsAt }

export type TokenCountSpec = {
  at: number
  primary?: WindowSpec | null
  secondary?: WindowSpec | null
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string | null } | null
  limitId?: string | null
}

/** A `token_count` event with rate limits. */
export const tokenCountLine = (o: TokenCountSpec): string =>
  JSON.stringify({
    timestamp: iso(o.at),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: null,
      rate_limits: {
        limit_id: o.limitId === undefined ? 'codex' : o.limitId,
        limit_name: null,
        primary: windowOf(o.primary),
        secondary: windowOf(o.secondary),
        credits: o.credits ?? null,
        individual_limit: null,
        spend_control_reached: null,
        plan_type: 'prolite',
        rate_limit_reached_type: null,
      },
    },
  })

/** The 429 marker: a codex token_count with no window. */
export const windowlessLine = (at: number): string => tokenCountLine({ at, primary: null, secondary: null })

export type MetaSpec = { originator?: string; source?: unknown; cwd?: string; id?: string; at?: number }

/** The first line of a rollout. */
export const sessionMetaLine = (o: MetaSpec): string =>
  JSON.stringify({
    timestamp: iso(o.at ?? Date.UTC(2026, 8, 25, 19)),
    type: 'session_meta',
    payload: {
      session_id: o.id ?? '01a0da06-c266-7842-bc97-1128f6549960',
      id: o.id ?? '01a0da06-c266-7842-bc97-1128f6549960',
      cwd: o.cwd ?? '/tmp/x/proj',
      ...(o.originator === undefined ? {} : { originator: o.originator }),
      cli_version: '0.157.0',
      ...(o.source === undefined ? {} : { source: o.source }),
      model_provider: 'mock',
    },
  })

export const turnContextLine = (o: { turn: string; approval?: string; sandbox?: string; at?: number }): string =>
  JSON.stringify({
    timestamp: iso(o.at ?? Date.UTC(2026, 8, 25, 19)),
    type: 'turn_context',
    payload: { turn_id: o.turn, cwd: '/tmp/x/proj', approval_policy: o.approval ?? 'on-request', sandbox_policy: { type: o.sandbox ?? 'read-only' } },
  })

export const taskStartedLine = (turn: string, startedAt: number | undefined, at: number): string =>
  JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type: 'task_started', turn_id: turn, ...(startedAt === undefined ? {} : { started_at: startedAt }) } })

export const turnAbortedLine = (turn: string, startedAt: number | undefined, at: number): string =>
  JSON.stringify({
    timestamp: iso(at),
    type: 'event_msg',
    payload: { type: 'turn_aborted', turn_id: turn, reason: 'interrupted', ...(startedAt === undefined ? {} : { started_at: startedAt }) },
  })

export const taskCompleteLine = (turn: string, at: number): string =>
  JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, last_agent_message: 'done' } })

/** A tool output line of about `bytes` bytes, newline included. */
export function fillerLine(bytes: number, at = Date.UTC(2026, 8, 25, 19)): string {
  const head = JSON.stringify({ timestamp: iso(at), type: 'response_item', payload: { type: 'function_call_output', output: '' } })
  return head.replace('"output":""', `"output":"${'x'.repeat(Math.max(0, bytes - head.length - 1))}"`)
}

export type FakeRollout = {
  path: string
  sessionMeta(o: MetaSpec): FakeRollout
  tokenCount(o: TokenCountSpec): FakeRollout
  windowless(at: number): FakeRollout
  turnContext(o: { turn: string; approval?: string; sandbox?: string; at?: number }): FakeRollout
  taskStarted(turn: string, startedAt: number | undefined, at: number): FakeRollout
  turnAborted(turn: string, startedAt: number | undefined, at: number): FakeRollout
  taskComplete(turn: string, at: number): FakeRollout
  /** Tool output lines of `bytes` bytes in all, in lines of at most `lineBytes`. */
  filler(bytes: number, lineBytes?: number): FakeRollout
  /** Any text, as it is: a line cut in half has no newline. */
  raw(text: string): FakeRollout
}

/** A rollout file that each call appends to, as Codex does. */
export function fakeRollout(path: string): FakeRollout {
  mkdirSync(dirname(path), { recursive: true })
  const line = (l: string): FakeRollout => {
    appendFileSync(path, `${l}\n`)
    return r
  }
  const r: FakeRollout = {
    path,
    sessionMeta: (o) => line(sessionMetaLine(o)),
    tokenCount: (o) => line(tokenCountLine(o)),
    windowless: (at) => line(windowlessLine(at)),
    turnContext: (o) => line(turnContextLine(o)),
    taskStarted: (turn, startedAt, at) => line(taskStartedLine(turn, startedAt, at)),
    turnAborted: (turn, startedAt, at) => line(turnAbortedLine(turn, startedAt, at)),
    taskComplete: (turn, at) => line(taskCompleteLine(turn, at)),
    filler(bytes, lineBytes = bytes) {
      let left = bytes
      while (left > 0) {
        const n = Math.min(left, lineBytes)
        line(fillerLine(n))
        left -= n
      }
      return r
    },
    raw(text) {
      appendFileSync(path, text)
      return r
    },
  }
  return r
}
