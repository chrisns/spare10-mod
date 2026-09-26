import { join } from 'node:path'
import { attendedFrom, codexText } from '../../hooks/core/codex.ts'
import type { HostKind } from '../../hooks/core/codex.ts'
import { readJson } from './files.ts'
import type { Env, Paths } from './paths.ts'
import type { Rollouts } from './rollout.ts'
import { checkId, sessionDir, warnOnce } from './store.ts'
import type { SessionStore } from './store.ts'

// Attendance and the policy of a nested run (Codex design 3.10). The pure rule is attendedFrom in
// hooks/core/codex.ts: the host kind, and the session_meta of the thread's own rollout. A subagent
// inherits the root's originator, so its own rollout gives the same answer. Each broker decides for
// itself, and keeps the answer.

export type Attendance = { attended: boolean; warnOriginator?: string }

/** The part of the session context that attendance reads: the thread's rollout, null for an ephemeral thread. */
export type AttendCtx = { transcript: string | null }

export type AttendanceSource = {
  /** 3.10 for this thread. `mode`: the permission mode of the gate input (`bypassPermissions` is approval never). */
  attended(sx: AttendCtx, mode?: string): Attendance
}

/**
 * The attendance of one broker, kept per rollout and mode. An answer is kept only when it is final: the
 * host is exec, the thread has no rollout, or the rollout had its session_meta. A rollout that has no
 * first line yet is read again at the next gate.
 */
export function createAttendance(d: { hostKind: HostKind; rollouts: Rollouts }): AttendanceSource {
  const kept = new Map<string, Attendance>()
  return {
    attended(sx, mode) {
      const transcriptNull = sx.transcript === null || sx.transcript === ''
      const key = `${transcriptNull ? '' : sx.transcript}\u0000${mode ?? ''}`
      const had = kept.get(key)
      if (had !== undefined) return had
      const meta = d.hostKind === 'exec' || transcriptNull ? undefined : d.rollouts.read(sx.transcript as string).meta
      const a = attendedFrom({ transcriptNull, hostKind: d.hostKind, ...(meta === undefined ? {} : { meta }), ...(mode === undefined ? {} : { mode }) })
      if (d.hostKind === 'exec' || transcriptNull || meta !== undefined) kept.set(key, a)
      return a
    },
  }
}

/** 3.10: the parent session of a nested `codex exec`: CODEX_SESSION_ID when it is set and names another session. */
export function nestedParent(env: Env, sid: string): string | undefined {
  const parent = env.CODEX_SESSION_ID
  return parent !== undefined && parent !== '' && parent !== sid ? parent : undefined
}

/**
 * B37, 3.10: the `child` policy that the attended root of the parent session wrote, for the settings of a
 * nested run. Undefined when the run is not nested, or the parent has none. A parent state of another
 * format counts as none. Bad JSON throws (the settings log it and go on without it).
 */
export function parentChildOf(paths: Pick<Paths, 'data'>, env: Env, sid: string): 'stop' | undefined {
  const parent = nestedParent(env, sid)
  if (parent === undefined) return undefined
  checkId('session id', parent)
  const st = readJson<unknown>(join(sessionDir(paths, parent), 'state.json'))
  if (typeof st !== 'object' || st === null || (st as { v?: unknown }).v !== 1) return undefined
  return (st as { child?: unknown }).child === 'stop' ? 'stop' : undefined
}

/** CX43, once per session: an unknown app started this session on the daemon. True when it queued the warning now. */
export function noteOriginator(store: Pick<SessionStore, 'locked'>, a: Attendance, now: number): boolean {
  const name = a.warnOriginator
  if (name === undefined) return false
  return store.locked((tx) => warnOnce(tx.state, 'CX43', codexText.originator(name), now))
}
