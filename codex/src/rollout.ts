import { statSync } from 'node:fs'
import { codexLimits, isCodexBucket, isObservation, sessionMetaOf, tokenCountOf, turnEndOf } from '../../hooks/core/codex.ts'
import type { CodexSnapshot } from '../../hooks/core/codex.ts'
import type { Kind } from '../../hooks/core/reading.ts'
import { firstLine, readBack, readFrom } from './files.ts'
import type { Lines } from './files.ts'
import { ROLLOUT_CHUNK_BYTES, ROLLOUT_SCAN_MAX } from './timing.ts'

// The rollout cursor (Codex design 3.6, route C). Each broker keeps, per rollout path, the offset of the
// next line and what it found so far: the newest `codex` token_count, the newest turn start and the turn
// ends, and the session_meta of the first line. A read parses only the bytes after the offset, up to the
// last full line. On the first read, or when the file got shorter or was replaced, it scans backwards in
// 256 KiB chunks until it finds the newest `codex` observation, at most 8 MiB, and reads the first line.
// One sampling step can write more than 256 KiB between two token_count lines, so a fixed tail is not enough.

/** A `codex` token_count: its time (the line's timestamp) and its snapshot. */
export type TokenCount = { at: number; snapshot: CodexSnapshot }

/** The first line of a rollout: `sessionMetaOf`, plus the cwd for the CLI rows. */
export type SessionMeta = { type: 'session_meta'; originator?: string; source?: unknown; cwd?: string }

/** The end of a turn: `turn_aborted` or `task_complete`. `at`: the line's timestamp. */
export type TurnEnd = { turnId: string; how: 'aborted' | 'complete'; startedAt?: number | null; at: number }

/** The start of a turn: `task_started`. `startedAt` in unix seconds, null when absent. */
export type TurnStart = { turnId: string; startedAt: number | null; at: number }

/** What the cursor keeps of one rollout path. */
export type Cursor = {
  /** The identity of the file: a replaced file starts over. */
  ino: number
  /** The offset of the next line to parse. */
  offset: number
  /** The newest `codex` token_count, with windows or not (the 429 marker has none). */
  newest?: TokenCount
  /** The newest `codex` observation: a token_count with at least one window. */
  newestObs?: TokenCount
  /** Per kind, the newest observation that has the kind. */
  byKind: Partial<Record<Kind, TokenCount>>
  meta?: SessionMeta
  turnStart?: TurnStart
  turnEnds: Map<string, TurnEnd>
}

/** One read of a rollout path. */
export type RolloutRead = {
  newest?: TokenCount
  newestObs?: TokenCount
  byKind: Partial<Record<Kind, TokenCount>>
  /** The `codex` token_counts that this read found, oldest first. The first read gives the ones its scan found. */
  fresh: TokenCount[]
  meta?: SessionMeta
  turnStart?: TurnStart
  turnEnds: Map<string, TurnEnd>
}

/** The file reads of the cursor. The specs wrap them to see which bytes a read touches. */
export type RolloutIo = {
  readFrom: (file: string, offset: number) => Lines | undefined
  readBack: (file: string, fromEnd: number, max: number) => Lines | undefined
  firstLine: (file: string) => string | undefined
  /** The inode and size of the file, or undefined when it is absent. */
  stat: (file: string) => { ino: number; size: number } | undefined
}

export type Rollouts = {
  /** Reads the new lines of `path`. An absent file gives an empty read. Other file errors throw. */
  read(path: string): RolloutRead
  /** The cursor of `path`, for the specs and the report. */
  cursor(path: string): Readonly<Cursor> | undefined
  /** Forgets the cursor of `path`. */
  forget(path: string): void
}

/** The turn ends a cursor keeps: the newest ones. */
export const TURN_ENDS_KEPT = 64

/** The fresh token_counts one read gives at most: the newest ones. */
export const FRESH_KEPT = 64

const statOf = (file: string): { ino: number; size: number } | undefined => {
  try {
    const st = statSync(file)
    return { ino: Number(st.ino), size: Number(st.size) }
  } catch (e) {
    const code = (e as { code?: unknown }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw e
  }
}

export const nodeRolloutIo: RolloutIo = { readFrom, readBack, firstLine, stat: statOf }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The session_meta of a first line, with its cwd. */
export function metaOf(line: string): SessionMeta | undefined {
  const m = sessionMetaOf(line)
  if (m === undefined) return undefined
  try {
    const o: unknown = JSON.parse(line)
    const p = isObject(o) && isObject(o['payload']) ? o['payload'] : undefined
    if (p !== undefined && typeof p['cwd'] === 'string') return { ...m, cwd: p['cwd'] }
  } catch {
    // sessionMetaOf parsed it, so this does not happen.
  }
  return m
}

/** A `task_started` line: the turn id and its start in unix seconds. */
export function turnStartOf(line: string): TurnStart | undefined {
  if (!line.includes('"task_started"')) return undefined
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return undefined
  }
  const p = isObject(o) && isObject(o['payload']) ? o['payload'] : undefined
  if (!isObject(o) || p === undefined || o['type'] !== 'event_msg' || p['type'] !== 'task_started') return undefined
  const turnId = p['turn_id']
  if (typeof turnId !== 'string' || turnId === '') return undefined
  const s = p['started_at']
  return { turnId, startedAt: typeof s === 'number' && Number.isFinite(s) ? s : null, at: timeOf(o) }
}

const timeOf = (o: Record<string, unknown>): number => (typeof o['timestamp'] === 'string' ? Date.parse(o['timestamp']) : Number.NaN)

/** The timestamp of a line, or NaN. Only for the turn ends, whose core parser has no time. */
function lineTime(line: string): number {
  const m = /"timestamp":"([^"]+)"/.exec(line.slice(0, 200))
  return m === null ? Number.NaN : Date.parse(m[1] ?? '')
}

const newCursor = (ino: number): Cursor => ({ ino, offset: 0, byKind: {}, turnEnds: new Map() })

/** Keeps the newest turn ends only. */
function keepEnd(c: Cursor, end: TurnEnd): void {
  c.turnEnds.delete(end.turnId)
  c.turnEnds.set(end.turnId, end)
  while (c.turnEnds.size > TURN_ENDS_KEPT) {
    const oldest = c.turnEnds.keys().next().value
    if (oldest === undefined) break
    c.turnEnds.delete(oldest)
  }
}

/**
 * One codex token_count into the cursor. True when it is an observation. `forward`: the lines come oldest
 * first, so a later line wins a tie. A backward scan keeps the first line it meets.
 */
function noteCount(c: Cursor, tc: TokenCount, forward: boolean): boolean {
  const wins = (prev: TokenCount | undefined): boolean => prev === undefined || tc.at > prev.at || (forward && tc.at === prev.at)
  if (wins(c.newest)) c.newest = tc
  if (!isObservation(tc.snapshot)) return false
  if (wins(c.newestObs)) c.newestObs = tc
  for (const l of codexLimits(tc.snapshot)) {
    const k: Kind = l.kind === 'seven_day' ? 'seven_day' : 'five_hour'
    if (wins(c.byKind[k])) c.byKind[k] = tc
  }
  return true
}

/** The codex token_count of a line, or undefined. */
function codexCountOf(line: string): TokenCount | undefined {
  const tc = tokenCountOf(line)
  return tc !== undefined && isCodexBucket(tc.snapshot) ? tc : undefined
}

/** One line of a forward read. */
function parseLine(c: Cursor, line: string, fresh: TokenCount[]): void {
  const tc = codexCountOf(line)
  if (tc !== undefined) {
    noteCount(c, tc, true)
    fresh.push(tc)
    return
  }
  const end = turnEndOf(line)
  if (end !== undefined) {
    keepEnd(c, { ...end, at: lineTime(line) })
    return
  }
  const start = turnStartOf(line)
  if (start !== undefined) {
    if (c.turnStart === undefined || !(start.at < c.turnStart.at)) c.turnStart = start
    return
  }
  if (c.meta === undefined) {
    const m = metaOf(line)
    if (m !== undefined) c.meta = m
  }
}

/**
 * The first read of a path (or after it shrank, was replaced, or grew by more than the scan cap): a
 * backward scan until it has the newest observation (3.6), with the newer window-less token_counts, the turn
 * ends and a turn start of the scanned part, and the session_meta of the first line. It never scans on for a
 * turn start (CX-R4): no part of the broker reads one yet, and a long turn would make each scan read 8 MiB.
 * The next forward read starts after the last full line of the file: the end of the newest chunk that holds
 * a full line.
 */
function scan(io: RolloutIo, path: string, c: Cursor, fresh: TokenCount[]): void {
  let fromEnd = 0
  let offset: number | undefined
  let lastStart = 0
  const counts: TokenCount[] = [] // newest first
  const ends: TurnEnd[] = [] // newest first
  for (;;) {
    const part = io.readBack(path, fromEnd, ROLLOUT_CHUNK_BYTES)
    if (part === undefined) break
    if (offset === undefined && part.lines.length > 0) offset = part.end
    let found = c.newestObs !== undefined
    for (let i = part.lines.length - 1; i >= 0 && !found; i -= 1) {
      const line = part.lines[i] ?? ''
      const tc = codexCountOf(line)
      if (tc !== undefined) {
        counts.push(tc)
        noteCount(c, tc, false)
        found = c.newestObs !== undefined
        continue
      }
      const end = turnEndOf(line)
      if (end !== undefined) {
        if (!ends.some((e) => e.turnId === end.turnId)) ends.push({ ...end, at: lineTime(line) })
        continue
      }
      if (c.turnStart === undefined) {
        const start = turnStartOf(line)
        if (start !== undefined) c.turnStart = start
      }
    }
    const scanned = part.size - part.start
    lastStart = part.start
    if (found || part.start <= 0 || scanned >= ROLLOUT_SCAN_MAX) break
    fromEnd = scanned
  }
  // No full line in the scanned part: the file start, or a line longer than the scan cap (its rest is no JSON).
  c.offset = offset ?? lastStart
  for (const e of ends.reverse()) keepEnd(c, e)
  fresh.push(...counts.reverse())
  const line = io.firstLine(path)
  if (line !== undefined) {
    const m = metaOf(line)
    if (m !== undefined) c.meta = m
  }
}

const readOf = (c: Cursor, fresh: TokenCount[]): RolloutRead => ({
  ...(c.newest === undefined ? {} : { newest: c.newest }),
  ...(c.newestObs === undefined ? {} : { newestObs: c.newestObs }),
  byKind: { ...c.byKind },
  fresh: fresh.slice(-FRESH_KEPT),
  ...(c.meta === undefined ? {} : { meta: c.meta }),
  ...(c.turnStart === undefined ? {} : { turnStart: c.turnStart }),
  turnEnds: c.turnEnds,
})

/** The cursors of one broker. `io` replaces the file reads in the specs. */
export function createRollouts(d: { io?: RolloutIo } = {}): Rollouts {
  const io = d.io ?? nodeRolloutIo
  const cursors = new Map<string, Cursor>()
  return {
    read(path) {
      const fresh: TokenCount[] = []
      const st = io.stat(path)
      if (st === undefined) {
        cursors.delete(path)
        return readOf(newCursor(0), fresh)
      }
      let c = cursors.get(path)
      if (c === undefined || c.ino !== st.ino || st.size < c.offset || st.size - c.offset > ROLLOUT_SCAN_MAX) {
        // A new path, a replaced file, a file that got shorter, or one that grew by more than a scan
        // reads: start from the end.
        c = newCursor(st.ino)
        cursors.set(path, c)
        scan(io, path, c, fresh)
        return readOf(c, fresh)
      }
      const part = io.readFrom(path, c.offset)
      if (part === undefined) {
        cursors.delete(path)
        return readOf(newCursor(0), fresh)
      }
      if (c.offset === 0 && c.meta === undefined && part.lines.length > 0) {
        const m = metaOf(part.lines[0] ?? '')
        if (m !== undefined) c.meta = m
      }
      for (const line of part.lines) parseLine(c, line, fresh)
      c.offset = part.end
      return readOf(c, fresh)
    },
    cursor: (path) => cursors.get(path),
    forget(path) {
      cursors.delete(path)
    },
  }
}
