import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import {
  FIRST_LINE_MAX_BYTES,
  LOCK_SLEEP_MAX_MS,
  LOCK_SLEEP_MIN_MS,
  LOCK_STALE_MS,
  LOCK_WAIT_MS,
} from './timing.ts'

// The file work of the broker and the CLI (Codex design 3.7): folders 0700, files 0600, every write by
// rename, and the one synchronous lock per session. The lock runs on real time, never on the test clock.

const codeOf = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined

const absent = (e: unknown): boolean => {
  const c = codeOf(e)
  return c === 'ENOENT' || c === 'ENOTDIR'
}

/** Makes `dir` and its missing parents with mode 0700. A folder that exists keeps its mode. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/** The text of `file`, or undefined when it is absent. */
function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    if (absent(e)) return undefined
    throw e
  }
}

/**
 * The parsed JSON of `file`, or undefined when the file is absent. Any other failure throws: bad JSON (a
 * person edited the file), a folder, no access. So the caller chooses: fail open when it senses, fail closed
 * when it acts, and the error text for CX12.
 */
export function readJson<T>(file: string): T | undefined {
  const text = readText(file)
  return text === undefined ? undefined : (JSON.parse(text) as T)
}

/**
 * True for the text of a write that an OS crash tore: empty, only white space, or with a NUL byte. The
 * rename of writeFileAtomic can reach the disk before the data (it does not fsync), so a kernel panic or a
 * power loss can leave such a file. writeJson never writes one, and a person's edit has no NUL byte.
 */
export const isTorn = (text: string): boolean => text.trim() === '' || text.includes('\0')

/**
 * readJson for a file that only spare10 writes (the session files, 3.7): a torn file (isTorn) is absent too.
 * So the next write replaces it, and a lost stop or consent only makes spare10 ask again. Other bad JSON
 * still throws.
 */
export function readOwnJson<T>(file: string): T | undefined {
  const text = readText(file)
  return text === undefined || isTorn(text) ? undefined : (JSON.parse(text) as T)
}

/**
 * Writes `data` to `file` in one step: a temp file in the same folder, with `mode`, then `rename`. A reader
 * sees the old file or the new one, never a part, also when the writer dies (SIGKILL) half way. It does not
 * fsync (a full flush costs about 8 ms on macOS, under the session lock), so an OS crash can tear the new
 * file: readOwnJson reads such a session file as absent.
 */
export function writeFileAtomic(file: string, data: string, mode = 0o600): void {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'wx', mode)
    fchmodSync(fd, mode) // the umask can take bits away from the create mode
    const buf = Buffer.from(data, 'utf8')
    let at = 0
    while (at < buf.length) at += writeSync(fd, buf, at, buf.length - at)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, file)
  } catch (e) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Closed already.
      }
    }
    try {
      unlinkSync(tmp)
    } catch {
      // No temp file.
    }
    throw e
  }
}

/** Writes `v` as JSON (two-space indent, a final newline) by rename, mode 0600. */
export function writeJson(file: string, v: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(v, null, 2)}\n`)
}

/**
 * True while the process `pid` exists. Signal 0 checks and sends nothing. EPERM means that it exists and
 * belongs to another user. A pid that is not a positive integer is never alive: kill(0) and kill(-1) would
 * name a process group.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return codeOf(e) === 'EPERM'
  }
}

/** The content of a lock file. `at` is real time (Date.now) at the create. */
export type LockHolder = { owner: string; pid: number; at: number; nonce?: string }

/** Thrown when a lock stays busy for longer than the wait. */
export class LockTimeout extends Error {
  readonly lockFile: string
  readonly holder: LockHolder | undefined
  constructor(lockFile: string, holder: LockHolder | undefined) {
    super(
      `spare10: the lock ${lockFile} stayed busy` +
        (holder === undefined ? '' : ` (held by ${holder.owner}, pid ${holder.pid})`),
    )
    this.name = 'LockTimeout'
    this.lockFile = lockFile
    this.holder = holder
  }
}

export type LockOptions = {
  /** A lock older than this is free (default LOCK_STALE_MS). */
  staleMs?: number
  /** The longest wait before LockTimeout (default LOCK_WAIT_MS). */
  waitMs?: number
  /** The liveness test of the holder's pid (default pidAlive). */
  pidAlive?: (pid: number) => boolean
}

const isHolder = (v: unknown): v is LockHolder =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as LockHolder).owner === 'string' &&
  typeof (v as LockHolder).pid === 'number' &&
  typeof (v as LockHolder).at === 'number'

/** What a lock file holds now: its identity (device and inode), its mtime and the parsed holder. */
type Seen = { dev: number; ino: number; mtimeMs: number; text: string; holder: LockHolder | undefined }

function seeLock(lockFile: string): Seen | undefined {
  let fd: number
  try {
    fd = openSync(lockFile, 'r')
  } catch (e) {
    if (absent(e)) return undefined
    throw e
  }
  try {
    const st = fstatSync(fd)
    const buf = Buffer.alloc(Math.min(Number(st.size), 4096))
    const n = buf.length === 0 ? 0 : readSync(fd, buf, 0, buf.length, 0)
    const text = buf.subarray(0, n).toString('utf8')
    let holder: LockHolder | undefined
    try {
      const v: unknown = JSON.parse(text)
      holder = isHolder(v) ? v : undefined
    } catch {
      holder = undefined // empty (its writer is between the create and the write) or broken
    }
    return { dev: Number(st.dev), ino: Number(st.ino), mtimeMs: st.mtimeMs, text, holder }
  } finally {
    closeSync(fd)
  }
}

/**
 * A lock is stale when its `at` is older than `staleMs`, or its pid is dead. A lock with no readable holder
 * (a writer that died between the create and the write) is stale when its mtime is older than `staleMs`. A
 * time more than `staleMs` in the future (the wall clock went back) is stale too.
 */
function isStale(s: Seen, now: number, staleMs: number, alive: (pid: number) => boolean): boolean {
  if (s.holder === undefined) return Math.abs(now - s.mtimeMs) > staleMs
  return Math.abs(now - s.holder.at) > staleMs || !alive(s.holder.pid)
}

/**
 * Removes the stale lock that `s` saw, only when the file is still that one: the same device, inode, mtime
 * and content. So two waiters that both find one stale lock never remove the fresh lock of a third, also
 * when the file system gives the new lock the inode of the old one.
 */
function breakStale(lockFile: string, s: Seen): void {
  try {
    const st = lstatSync(lockFile)
    if (Number(st.dev) !== s.dev || Number(st.ino) !== s.ino || st.mtimeMs !== s.mtimeMs) return
    if (readFileSync(lockFile, 'utf8') !== s.text) return
    unlinkSync(lockFile)
  } catch (e) {
    if (!absent(e)) throw e
  }
}

/** The exclusive create of a lock file: its fd, or undefined when it exists. A missing folder is made. */
function createLock(lockFile: string): number | undefined {
  for (let tries = 0; ; tries += 1) {
    try {
      return openSync(lockFile, 'wx', 0o600)
    } catch (e) {
      const code = codeOf(e)
      if (code === 'EEXIST') return undefined
      if (code !== 'ENOENT' || tries > 0) throw e
      ensureDir(dirname(lockFile))
    }
  }
}

/** Sleeps `ms` on real time, synchronously. The lock never uses the test clock. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const isThenable = (v: unknown): boolean =>
  (typeof v === 'object' || typeof v === 'function') && v !== null && typeof (v as { then?: unknown }).then === 'function'

/**
 * Runs `fn` under the lock file `lockFile` (3.7). The create is exclusive (`wx`), and the file holds `{ owner,
 * pid, at, nonce }`. A busy lock is tried again after 2 to 10 ms of real time, for at most `waitMs`, then
 * LockTimeout. A stale lock is removed and the create is tried again. The release removes the file only while
 * it is still this lock. `fn` must be synchronous file work: it must not wait for anything.
 */
export function withLock<T>(lockFile: string, owner: string, fn: () => T, o: LockOptions = {}): T {
  const staleMs = o.staleMs ?? LOCK_STALE_MS
  const waitMs = o.waitMs ?? LOCK_WAIT_MS
  const alive = o.pidAlive ?? pidAlive
  const start = Date.now()
  let mine = ''
  let last: LockHolder | undefined
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0 && Date.now() - start >= waitMs) throw new LockTimeout(lockFile, last)
    const holder: LockHolder = { owner, pid: process.pid, at: Date.now(), nonce: randomBytes(6).toString('hex') }
    const text = JSON.stringify(holder)
    const fd = createLock(lockFile)
    if (fd !== undefined) {
      try {
        writeSync(fd, text)
      } catch (e) {
        closeSync(fd)
        unlinkSync(lockFile) // an empty lock of ours would block the others until it is stale
        throw e
      }
      closeSync(fd)
      mine = text
      break
    }
    const seen = seeLock(lockFile)
    if (seen === undefined) continue // released between the create and the read
    last = seen.holder
    if (isStale(seen, Date.now(), staleMs, alive)) {
      breakStale(lockFile, seen)
      continue
    }
    sleepSync(LOCK_SLEEP_MIN_MS + Math.random() * (LOCK_SLEEP_MAX_MS - LOCK_SLEEP_MIN_MS))
  }
  let result: T
  try {
    result = fn()
  } finally {
    release(lockFile, mine)
  }
  if (isThenable(result)) throw new TypeError('spare10: withLock runs synchronous work only')
  return result
}

/**
 * One try at a lock that its taker holds across async work, such as `live.lock` around a daemon read (3.6).
 * It never waits: the result is the holder text (the token for `unlock`) when it took the lock, else
 * undefined. A stale lock is removed and the create is tried again, a few times at most.
 */
export function tryLock(lockFile: string, owner: string, o: LockOptions = {}): string | undefined {
  const staleMs = o.staleMs ?? LOCK_STALE_MS
  const alive = o.pidAlive ?? pidAlive
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const text = JSON.stringify({ owner, pid: process.pid, at: Date.now(), nonce: randomBytes(6).toString('hex') } satisfies LockHolder)
    const fd = createLock(lockFile)
    if (fd !== undefined) {
      try {
        writeSync(fd, text)
      } catch (e) {
        closeSync(fd)
        unlinkSync(lockFile)
        throw e
      }
      closeSync(fd)
      return text
    }
    const seen = seeLock(lockFile)
    if (seen === undefined) continue // released between the create and the read
    if (!isStale(seen, Date.now(), staleMs, alive)) return undefined
    breakStale(lockFile, seen)
  }
  return undefined
}

/** Releases a lock that tryLock took. The file goes only while it still holds `token`. */
export function unlock(lockFile: string, token: string): void {
  release(lockFile, token)
}

/** Removes the lock file only while it holds `mine`: a lock that another taker found stale is theirs now. */
function release(lockFile: string, mine: string): void {
  try {
    if (readFileSync(lockFile, 'utf8') === mine) unlinkSync(lockFile)
  } catch (e) {
    if (!absent(e)) throw e
  }
}

/** Full lines of a part of a file, with the byte offsets of that part. */
export type Lines = {
  /** The full lines, oldest first, with no newline and no empty line. */
  lines: string[]
  /**
   * The offset of the first line start in the part. readBack: the chunk start when the chunk is all inside
   * one line longer than the chunk.
   */
  start: number
  /** The offset just after the last newline in the part (a line start), or `start` when the part has none. */
  end: number
  /** The size of the file at the read. */
  size: number
}

/** Reads `length` bytes at `position` of the open file `fd`. */
function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length)
  let got = 0
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, position + got)
    if (n === 0) break
    got += n
  }
  return got === length ? buf : buf.subarray(0, got)
}

/** The lines of `buf` between `from` and `to` (byte offsets of `buf`, `to` just after a newline). */
function linesOf(buf: Buffer, from: number, to: number): string[] {
  if (to <= from) return []
  return buf
    .toString('utf8', from, to - 1)
    .split('\n')
    .filter((l) => l !== '')
}

function openRead(file: string): number | undefined {
  try {
    return openSync(file, 'r')
  } catch (e) {
    if (absent(e)) return undefined
    throw e
  }
}

/**
 * Reads one chunk of `file` backwards (the rollout cursor, 3.6): at most `max` bytes that end `fromEnd` bytes
 * before the end of the file. It returns only full lines. A line cut at the start of the chunk, and a line
 * with no newline yet at the end, are left out. To go on backwards, the caller passes `size - start` as the
 * next `fromEnd`, so the cut line comes whole in the next chunk. A line longer than `max` never comes: a
 * chunk inside it gives no line, and its `start` is the chunk start, so the scan goes on past it. The result
 * is undefined when the file is absent.
 */
export function readBack(file: string, fromEnd: number, max: number): Lines | undefined {
  const fd = openRead(file)
  if (fd === undefined) return undefined
  try {
    const size = Number(fstatSync(fd).size)
    const endPos = Math.max(0, size - Math.max(0, fromEnd))
    const startPos = Math.max(0, endPos - Math.max(1, max)) // at least one byte, so a scan always moves back
    // One byte more in front tells whether the chunk starts at a line start.
    const lead = startPos > 0 ? 1 : 0
    const buf = readAt(fd, startPos - lead, endPos - startPos + lead)
    const firstNl = lead === 1 ? buf.indexOf(0x0a) : -1
    // The first line start: the chunk start when the byte before it is a newline (or it is the file start).
    const from = lead === 0 ? 0 : buf[0] === 0x0a ? 1 : firstNl < 0 ? buf.length : firstNl + 1
    const base = startPos - lead
    // No line starts inside the chunk: it is all inside a line longer than `max`, so the scan goes on from
    // the chunk start.
    const inLongLine = lead === 1 && (firstNl < 0 || firstNl + 1 >= buf.length)
    const start = inLongLine ? startPos : base + from
    const to = buf.lastIndexOf(0x0a) + 1
    const end = to > 0 ? base + to : start
    return { lines: to > from ? linesOf(buf, from, to) : [], start, end, size }
  } finally {
    closeSync(fd)
  }
}

/**
 * Reads `file` from `offset` to the end, and returns its full lines (the rollout cursor, 3.6). `end` is the
 * offset for the next read: the bytes after the last newline (a line that Codex still writes) come again. A
 * file shorter than `offset` gives no line and its `size`, so the caller sees that it shrank. The result is
 * undefined when the file is absent.
 */
export function readFrom(file: string, offset: number): Lines | undefined {
  const fd = openRead(file)
  if (fd === undefined) return undefined
  try {
    const size = Number(fstatSync(fd).size)
    const from = Math.max(0, offset)
    if (size <= from) return { lines: [], start: from, end: from, size }
    const buf = readAt(fd, from, size - from)
    const to = buf.lastIndexOf(0x0a) + 1
    return { lines: linesOf(buf, 0, to), start: from, end: from + to, size }
  } finally {
    closeSync(fd)
  }
}

/**
 * The first line of `file` (the rollout `session_meta`, about 22 KB), read in 64 KiB steps up to `max`
 * bytes. Undefined when the file is absent, or when no newline comes within `max` bytes or before the end.
 */
export function firstLine(file: string, max = FIRST_LINE_MAX_BYTES): string | undefined {
  const fd = openRead(file)
  if (fd === undefined) return undefined
  try {
    const parts: Buffer[] = []
    let read = 0
    while (read < max) {
      const chunk = readAt(fd, read, Math.min(65_536, max - read))
      if (chunk.length === 0) return undefined
      const nl = chunk.indexOf(0x0a)
      if (nl >= 0) {
        parts.push(chunk.subarray(0, nl))
        return Buffer.concat(parts).toString('utf8')
      }
      parts.push(chunk)
      read += chunk.length
    }
    return undefined
  } finally {
    closeSync(fd)
  }
}
