import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { GateSite, HostKind } from '../../hooks/core/codex.ts'
import { parseStopped } from '../../hooks/core/decide.ts'
import type { Answered, ConsentSlots, Tomb } from '../../hooks/core/decide.ts'
import type { QuestionCore, Via } from '../../hooks/core/flow.ts'
import type { Anchored, Kind } from '../../hooks/core/reading.ts'
import { VERSION } from '../../hooks/core/text.ts'
import type { Clock } from './clock.ts'
import { firstLine, readOwnJson, withLock, writeFileAtomic, writeJson } from './files.ts'
import type { LockOptions } from './files.ts'
import type { Paths } from './paths.ts'
import { NOTICE_TTL_MS, PRUNE_AFTER_MS, PRUNE_EVERY_MS, PRUNE_MAX } from './timing.ts'
import type { Wake } from './wake.ts'

// The state files of a session and their one lock (Codex design 3.7). Every write of state.json,
// question.json, answer.json and threads/*.json of a session runs under sessions/<sid>/state.lock: read,
// change, write to a temp file, rename. This replaces the compare-and-set of the Claude env writes. The
// values of `consent`, `weeklyConsent` and `stopped` are the exact strings of the Claude env values, so the
// core parsers work on them unchanged.

/** The file format of every session file. A reader that meets another `v` treats the file as absent when it senses, and fails closed when it acts. */
export const FORMAT = 1

type Stamp = { v: 1; by: string }

/** A value without its format stamp: the store stamps each file when it writes it. */
export type Unstamped<T> = Omit<T, 'v' | 'by'> & Partial<Stamp>

/** A transcript line of the root thread (2.4). `stop`: a Stop here line that a release in hold mode drops. */
export type Notice = { at: number; text: string; tag?: 'stop' }

/** A test reading of a session (4.18), bound to the host process that set it. */
export type TestState = {
  hostPid: number
  kinds: Partial<Record<Kind, Anchored>>
  consent: Partial<Record<Kind, ConsentSlots>>
  envDone?: boolean
}

/** `sessions/<sid>/state.json` (3.7). */
export type SessionState = Stamp & {
  rev: number // +1 on each write
  sessionId: string
  hostPid?: number // the Codex process of the root thread (the broker's ppid)
  hostKind?: HostKind // 3.9
  transcript?: string | null // the root rollout
  attended?: boolean // 3.10, for the report and the CLI only: each broker decides for itself
  consent?: string // SPARE10_CONSENT format
  weeklyConsent?: string // SPARE10_WEEKLY_CONSENT format
  tombs?: Partial<Record<Kind, Tomb[]>> // B52
  stopped?: string // SPARE10_STOPPED format
  stopMeta?: { noDialog?: boolean } // noDialog: a held stop (4.4)
  child?: 'stop' // B37 for a nested codex exec
  test?: TestState
  absentCount?: Partial<Record<Kind, number>> // 3.6: observations in a row that omit the kind
  absentAt?: number // 3.6: the time of the newest observation that absentCount counts, so no observation counts twice
  told?: Partial<Record<Kind, { windowEnd: number; keys: string[] }>> // B51
  toldNotice?: Partial<Record<Kind, string>>
  unattendedNote?: Partial<Record<Kind, number>>
  openNote?: Partial<Record<Kind, number>>
  warned?: string[] // warning ids shown in this session
  notices?: Notice[] // 2.4, for the root thread
  continuation?: { text: string; expiresAt: number; notice: string } // 4.7
  interrupts?: Record<string, number> // turn ids that spare10 interrupted, and when
  lastInterrupt?: { turnId: string; at: number; bySpare10: boolean } // P1 (4.12)
  updatedAt: number
}

/** One held call of a thread (3.7). */
export type HeldEntry = {
  call: string
  site: GateSite
  turn?: string
  since: number
  question?: string
  prompt?: string
  brokerPid: number
  hostPid: number
}

/** `sessions/<sid>/threads/<tid>.json` (3.7). */
export type ThreadState = Stamp & {
  threadId: string
  sessionId: string
  brokerPid: number
  hostPid: number
  transcript?: string | null
  beat: number // every 30 s while any call is held
  held: HeldEntry[]
  promptTurns: string[] // the last 8 turn ids seen at a prompt gate (steer detection, 4.10)
  denied: string[] // the last 8 turn ids that got a deny rendering (A4)
}

/** The leader of an open question: the held call that raised its form (4.3). */
export type Leader = { brokerId: string; pid: number; threadId: string; turn?: string; transcript?: string | null; call: string }

/** `sessions/<sid>/question.json`: the open question (4.3). */
export type QuestionFile = Stamp & QuestionCore & { key: string; leader: Leader | null; createdAt: number }

/** `sessions/<sid>/answer.json`: the last settled question (4.3). */
export type AnswerFile = Stamp & {
  key: string
  outcome: 'resume' | 'stop' | 'again'
  via: Via
  at: number
  answered: Answered[]
  noDialog?: boolean
}

/** What a locked step sees and changes. Each file is read at its first use, and written at the end only when it changed. */
export type Tx = {
  state: SessionState
  thread(tid: string): ThreadState
  question(): QuestionFile | undefined
  answer(): AnswerFile | undefined
  setQuestion(q?: Unstamped<QuestionFile>): void
  setAnswer(a: Unstamped<AnswerFile>): void
}

export type SessionStore = {
  sid: string
  dir: string
  /** The state with no lock. An absent or torn file, or one of another format, gives a fresh state. Bad JSON throws. */
  read(): SessionState
  /**
   * Runs `fn` under the session lock. `fn` must be synchronous file work. The files that changed are
   * written before the lock goes, in this order: state.json, threads, answer.json, question.json. So a
   * reader that finds question.json gone finds the answer that settled it. Then the wake fires.
   */
  locked<T>(fn: (tx: Tx) => T): T
  /** Queues a transcript line of the root thread (2.4). */
  queueNotice(text: string, tag?: 'stop'): void
  /** The queued lines younger than NOTICE_TTL_MS, oldest first. It takes the lock only when lines wait. */
  takeNotices(now: number): string[]
}

/** A file of another format than FORMAT, or with no format. A step that acts must not go on (fail closed). */
export class FormatError extends Error {
  readonly file: string
  constructor(file: string, v: unknown) {
    super(`spare10: ${file} has the format ${JSON.stringify(v) ?? 'none'}, which this version does not know`)
    this.name = 'FormatError'
    this.file = file
  }
}

// A session or thread id names a folder or a file: only these characters, so an id can never leave the data dir.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Throws when `id` cannot name a file. */
export function checkId(what: string, id: string): void {
  if (!SAFE_ID.test(id) || id.includes('..')) throw new Error(`spare10: the ${what} ${JSON.stringify(id)} cannot name a file`)
}

/** The folder of a session. */
export const sessionDir = (paths: Pick<Paths, 'data'>, sid: string): string => join(paths.data, 'sessions', sid)

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A fresh state of a session: what an absent state.json means. */
export const freshState = (sid: string): SessionState => ({ v: 1, by: VERSION, rev: 0, sessionId: sid, updatedAt: 0 })

/** A fresh thread file. The broker fills in its pids at the bind. */
export const freshThread = (sid: string, tid: string): ThreadState => ({
  v: 1,
  by: VERSION,
  threadId: tid,
  sessionId: sid,
  brokerPid: 0,
  hostPid: 0,
  beat: 0,
  held: [],
  promptTurns: [],
  denied: [],
})

/**
 * The file as a T, undefined when it is absent or torn by an OS crash (readOwnJson). A file of another format
 * throws FormatError. Bad JSON throws.
 */
function readStamped<T>(file: string): T | undefined {
  const v = readOwnJson<unknown>(file)
  if (v === undefined) return undefined
  if (!isObject(v) || v['v'] !== FORMAT) throw new FormatError(file, isObject(v) ? v['v'] : undefined)
  return v as T
}

/** The test reading in force for a reader whose host pid is `hostPid` (3.7): a daemon restart or a new host ends it. */
export const testOf = (state: Pick<SessionState, 'test'>, hostPid: number): TestState | undefined =>
  state.test !== undefined && state.test.hostPid === hostPid ? state.test : undefined

/**
 * Shows a warning once per session (2.5): its id goes into `warned`, and its text into the notice queue of
 * the root thread. False when the session showed it already. Call it inside `locked`.
 */
export function warnOnce(state: SessionState, id: string, text: string, now: number): boolean {
  if ((state.warned ?? []).includes(id)) return false
  state.warned = [...(state.warned ?? []), id]
  state.notices = [...(state.notices ?? []), { at: now, text }]
  return true
}

const text = (v: unknown): string => JSON.stringify(v)

type Slot<T> = { loaded: boolean; before: string | undefined; value: T | undefined }

/**
 * The store of one session. `o.hostPid`: the host pid of this reader. A test reading of another host is
 * hidden from `read` and `locked`, and cleared at the next write. `o.clock`: the time of `updatedAt` and of
 * the queued lines.
 */
export function sessionStore(
  paths: Pick<Paths, 'data'>,
  sid: string,
  owner: string,
  wake: Pick<Wake, 'fire'>,
  o: { clock?: Pick<Clock, 'now'>; hostPid?: number; lock?: LockOptions } = {},
): SessionStore {
  checkId('session id', sid)
  const dir = sessionDir(paths, sid)
  const stateFile = join(dir, 'state.json')
  const lockFile = join(dir, 'state.lock')
  const questionFile = join(dir, 'question.json')
  const answerFile = join(dir, 'answer.json')
  const threadFile = (tid: string): string => join(dir, 'threads', `${tid}.json`)
  const now = (): number => (o.clock ?? Date).now()
  let inLock = false

  /** Hides a test reading of another host. True when it hid one. */
  const hideForeignTest = (s: SessionState): boolean => {
    if (o.hostPid === undefined || s.test === undefined || s.test.hostPid === o.hostPid) return false
    delete s.test
    return true
  }

  const read = (): SessionState => {
    let s: SessionState | undefined
    try {
      s = readStamped<SessionState>(stateFile)
    } catch (e) {
      if (!(e instanceof FormatError)) throw e
      s = undefined // another format: absent when sensing
    }
    const out = s ?? freshState(sid)
    hideForeignTest(out)
    return out
  }

  const locked = <T>(fn: (tx: Tx) => T): T => {
    if (inLock) throw new Error('spare10: the session lock is not reentrant')
    let wrote = false
    const result = withLock(
      lockFile,
      owner,
      () => {
        inLock = true
        try {
          const loaded = readStamped<SessionState>(stateFile)
          const state = loaded ?? freshState(sid)
          // A test reading of another host is hidden before the compare, so it goes with the next write (3.7).
          hideForeignTest(state)
          const stateBefore = text(state)
          const threads = new Map<string, Slot<ThreadState>>()
          const question: Slot<QuestionFile> = { loaded: false, before: undefined, value: undefined }
          const answer: Slot<AnswerFile> = { loaded: false, before: undefined, value: undefined }
          const load = <F>(slot: Slot<F>, file: string): void => {
            if (slot.loaded) return
            slot.value = readStamped<F>(file)
            slot.before = slot.value === undefined ? undefined : text(slot.value)
            slot.loaded = true
          }
          const tx: Tx = {
            state,
            thread(tid) {
              checkId('thread id', tid)
              let slot = threads.get(tid)
              if (slot === undefined) {
                // An absent thread file reads as a fresh thread, and a fresh thread that stays as it is is not written.
                const value = readStamped<ThreadState>(threadFile(tid)) ?? freshThread(sid, tid)
                slot = { loaded: true, before: text(value), value }
                threads.set(tid, slot)
              }
              return slot.value as ThreadState
            },
            question() {
              load(question, questionFile)
              return question.value
            },
            answer() {
              load(answer, answerFile)
              return answer.value
            },
            setQuestion(q) {
              load(question, questionFile)
              question.value = q === undefined ? undefined : ({ ...q, v: 1, by: VERSION } as QuestionFile)
            },
            setAnswer(a) {
              load(answer, answerFile)
              answer.value = { ...a, v: 1, by: VERSION } as AnswerFile
            },
          }
          const out = fn(tx)
          // state.json first, the question last (see SessionStore.locked).
          const current = tx.state
          if (text(current) !== stateBefore) {
            current.v = 1
            current.by = VERSION
            current.rev = (loaded?.rev ?? 0) + 1
            current.updatedAt = now()
            writeJson(stateFile, current)
            wrote = true
          }
          for (const [tid, slot] of threads) {
            const v = slot.value
            if (v === undefined || text(v) === slot.before) continue
            v.v = 1
            v.by = VERSION
            writeJson(threadFile(tid), v)
            wrote = true
          }
          for (const [slot, file] of [
            [answer, answerFile],
            [question, questionFile],
          ] as const) {
            if (!slot.loaded) continue
            const after = slot.value === undefined ? undefined : text(slot.value)
            if (after === slot.before) continue
            if (slot.value === undefined) {
              try {
                unlinkSync(file)
              } catch (e) {
                if ((e as { code?: unknown }).code !== 'ENOENT') throw e
              }
            } else {
              writeJson(file, slot.value)
            }
            wrote = true
          }
          return out
        } finally {
          inLock = false
        }
      },
      o.lock,
    )
    if (wrote) wake.fire(dir)
    return result
  }

  return {
    sid,
    dir,
    read,
    locked,
    queueNotice(line, tag) {
      locked((tx) => {
        tx.state.notices = [...(tx.state.notices ?? []), { at: now(), text: line, ...(tag === undefined ? {} : { tag }) }]
      })
    },
    takeNotices(at) {
      if ((read().notices ?? []).length === 0) return []
      return locked((tx) => {
        const all = tx.state.notices ?? []
        delete tx.state.notices
        return all.filter((n) => n.at > at - NOTICE_TTL_MS).map((n) => n.text)
      })
    },
  }
}

/** One session folder for the CLI rows (CX36): its id, the mtime of its state.json, and the cwd of its root rollout. */
export type SessionRow = { sid: string; mtime: number; cwd?: string }

/** The cwd of a rollout's session_meta line, when it has one. */
function cwdOf(transcript: string | null | undefined): string | undefined {
  if (typeof transcript !== 'string' || transcript === '') return undefined
  try {
    const line = firstLine(transcript)
    if (line === undefined) return undefined
    const o: unknown = JSON.parse(line)
    const p = isObject(o) && isObject(o['payload']) ? o['payload'] : undefined
    return p !== undefined && typeof p['cwd'] === 'string' ? p['cwd'] : undefined
  } catch {
    return undefined
  }
}

/**
 * Every session folder with a state.json, newest first. A folder that cannot be read is left out. With
 * `since`, a folder whose state.json did not change after that time is left out before any file read, so
 * the old folders cost one stat each.
 */
export function listSessions(paths: Pick<Paths, 'data'>, since?: number): SessionRow[] {
  let names: string[]
  try {
    names = readdirSync(join(paths.data, 'sessions'))
  } catch {
    return []
  }
  const rows: SessionRow[] = []
  for (const sid of names) {
    if (!SAFE_ID.test(sid)) continue
    const file = join(paths.data, 'sessions', sid, 'state.json')
    let mtime: number
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      continue
    }
    if (since !== undefined && mtime <= since) continue
    let transcript: string | null | undefined
    try {
      transcript = readStamped<SessionState>(file)?.transcript
    } catch {
      transcript = undefined
    }
    const cwd = cwdOf(transcript)
    rows.push(cwd === undefined ? { sid, mtime } : { sid, mtime, cwd })
  }
  return rows.sort((a, b) => b.mtime - a.mtime || a.sid.localeCompare(b.sid))
}

/** True when a session file in `dir` (not its lock) changed after `since`. It stops at the first one. */
function changedSince(dir: string, since: number): boolean {
  const newer = (file: string): boolean => {
    try {
      return statSync(file).mtimeMs > since
    } catch {
      return false // absent
    }
  }
  if (['state.json', 'question.json', 'answer.json'].some((name) => newer(join(dir, name)))) return true
  let threads: string[] = []
  try {
    threads = readdirSync(join(dir, 'threads'))
  } catch {
    // No thread files.
  }
  return threads.some((name) => newer(join(dir, 'threads', name)))
}

/** The start of the name of a folder that a prune moved out of `sessions/`. */
const PRUNED = '.pruned-'

/** Removes a folder tree. A failure leaves it for the next prune. */
function removeTree(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // The next prune tries again.
  }
}

/**
 * Removes old session folders, so the data dir does not grow with each session (3.7). It runs at most once
 * per PRUNE_EVERY_MS for each data dir (the file `pruned` keeps the time), and removes at most PRUNE_MAX
 * folders. A folder goes only when none of its files changed for PRUNE_AFTER_MS, it has no open question
 * and no stop that ends in that time, and no host or broker pid in it is alive. So the report, the sweep and
 * a stop lose nothing that they still need. The folder goes under its session lock, by a rename out of
 * `sessions/` first, so a broker that resumes the session later starts a fresh folder. It never throws. The
 * ids it removed.
 */
export function pruneSessions(paths: Pick<Paths, 'data'>, owner: string, now: number, alive: (pid: number) => boolean): string[] {
  const root = join(paths.data, 'sessions')
  const stamp = join(paths.data, 'pruned') // not in sessions/, where each entry is a session
  let names: string[]
  try {
    let last = Number.NaN
    try {
      last = Number(readFileSync(stamp, 'utf8'))
    } catch {
      // No prune yet.
    }
    if (now - last >= 0 && now - last < PRUNE_EVERY_MS) return []
    names = readdirSync(root)
    writeFileAtomic(stamp, String(now))
  } catch {
    return []
  }
  const live = (pid: number | undefined): boolean => pid !== undefined && pid > 0 && alive(pid)
  /** True while nothing in `dir` needs the folder. */
  const unused = (dir: string): boolean => {
    if (changedSince(dir, now - PRUNE_AFTER_MS) || existsSync(join(dir, 'question.json'))) return false
    try {
      const st = readOwnJson<Partial<SessionState>>(join(dir, 'state.json'))
      if (st !== undefined && (st.v !== FORMAT || live(st.hostPid))) return false
      const stop = parseStopped(st?.stopped)
      if (stop !== undefined && stop.windowEnd > now - PRUNE_AFTER_MS) return false
      let threads: string[] = []
      try {
        threads = readdirSync(join(dir, 'threads'))
      } catch {
        // No thread files.
      }
      for (const name of threads.filter((n) => n.endsWith('.json'))) {
        const th = readOwnJson<Partial<ThreadState>>(join(dir, 'threads', name))
        if (th === undefined) continue
        if (th.v !== FORMAT || live(th.brokerPid) || live(th.hostPid) || (th.held ?? []).some((e) => live(e.brokerPid))) return false
      }
    } catch {
      return false // bad JSON: a person's edit stays
    }
    return true
  }
  const gone: string[] = []
  for (const name of names) {
    if (name.startsWith(PRUNED)) {
      removeTree(join(root, name)) // a prune that stopped half way
      continue
    }
    if (gone.length >= PRUNE_MAX) break
    if (!SAFE_ID.test(name)) continue
    const dir = join(root, name)
    if (!unused(dir)) continue
    const trash = join(root, `${PRUNED}${name}-${randomBytes(4).toString('hex')}`)
    try {
      const moved = withLock(
        join(dir, 'state.lock'),
        owner,
        () => {
          if (!unused(dir)) return false
          renameSync(dir, trash)
          return true
        },
        { waitMs: 0 },
      )
      if (!moved) continue
    } catch {
      continue // a busy lock or a failed rename: the folder stays for the next prune
    }
    removeTree(trash)
    gone.push(name)
  }
  return gone
}
