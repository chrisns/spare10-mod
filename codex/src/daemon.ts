import { createHash, randomBytes } from 'node:crypto'
import { realpathSync, statSync, type Stats } from 'node:fs'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { dirname } from 'node:path'
import type { Duplex } from 'node:stream'
import { codexDebug } from '../../hooks/core/codex.ts'
import type { Clock, Timer } from './clock.ts'
import type { Log } from './log.ts'
import { guardTestPath, type Paths } from './paths.ts'
import {
  A_READ_MS,
  DAEMON_CONNECT_MS,
  DAEMON_MAX_MESSAGE,
  HOSTED_MISS_TTL_MS,
  HOSTED_TTL_MS,
  INTERRUPT_MS,
  LOADED_MS,
  START_MS,
  THREAD_READ_MS,
} from './timing.ts'

// The daemon client (Codex design 3.5): JSON-RPC over a WebSocket over the daemon's Unix socket, with Node
// built-ins only (Node's WebSocket cannot dial a Unix socket, and the plugin cache has no node_modules).
// From the probed client codex-research/probe-gap1/rpc.mjs (gap-1 2.2).
//
// One connection per operation (A13): connect, handshake, `initialize`, the call, close. The daemon attaches
// every initialized connection to each subagent thread created while it is open, and a subscribed connection
// keeps a thread from unloading, so a connection lives for one call only. The client connects as
// `codex_app_server_daemon`, so it never takes the originator of a new thread. It ignores notifications and
// never answers a server request. It never uses the path `/daemon/shutdown`, and never calls `thread/start`,
// `thread/resume`, `thread/unsubscribe`, `thread/queue/*` or `account/rateLimitResetCredit/consume`.

/** The client name of every daemon connection (A13). */
export const DAEMON_CLIENT_NAME = 'codex_app_server_daemon'

/** RFC 6455: the GUID of the `Sec-WebSocket-Accept` check. */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** The WebSocket opcodes the client knows. */
export const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const

/** The newest turn of a thread (`thread/turns/list`, 3.5). `startedAt` is in unix seconds. */
export type TurnInfo = { id: string; status: string; startedAt: number | null }

export type Daemon = {
  /** `account/rateLimits/read` with `excludeResetCreditDetails`: its result, for `liveOf`. */
  rateLimits(timeoutMs?: number): Promise<unknown>
  /** `thread/loaded/list`: the ids of the loaded threads. */
  loaded(): Promise<string[]>
  /** `thread/read` with no turns: `result.thread.status.type` (`notLoaded`, `idle`, `systemError`, `active`). */
  status(threadId: string): Promise<string>
  /** `thread/turns/list` with limit 1: the newest turn, or undefined when the thread has none (also before its first user message). */
  newestTurn(threadId: string): Promise<TurnInfo | undefined>
  /**
   * `turn/interrupt`. Its reply comes only after the abort. A turn that already ended can get no reply at all
   * [P], so a timeout is not a failure: the caller then asks `newestTurn` (3.5).
   */
  interrupt(threadId: string, turnId: string): Promise<void>
  /** `turn/start` with one text input: the new turn's id. */
  start(threadId: string, text: string): Promise<string>
  /** `hooks/list` for one folder (P1): its result. */
  hooksList(cwd: string): Promise<unknown>
}

/** Why a daemon call failed. `timeout` is the call timer. `rpc` is an error reply, with its `code`. */
export type DaemonFailure = 'connect' | 'protocol' | 'timeout' | 'closed' | 'rpc' | 'reply'

export class DaemonError extends Error {
  readonly kind: DaemonFailure
  readonly code: number | undefined
  constructor(kind: DaemonFailure, message: string, code?: number) {
    super(message)
    this.name = 'DaemonError'
    this.kind = kind
    this.code = code
  }
}

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ---- Frames (RFC 6455) ----

/** One frame. A client frame is masked with 4 random bytes (RFC 6455 5.3). */
export function encodeFrame(opcode: number, payload: Buffer, mask: Buffer | null = randomBytes(4), fin = true): Buffer {
  const len = payload.length
  const head = Buffer.alloc(len < 126 ? 2 : len < 65_536 ? 4 : 10)
  head[0] = (fin ? 0x80 : 0) | (opcode & 0x0f)
  const bit = mask === null ? 0 : 0x80
  if (len < 126) head[1] = bit | len
  else if (len < 65_536) {
    head[1] = bit | 126
    head.writeUInt16BE(len, 2)
  } else {
    head[1] = bit | 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  if (mask === null) return Buffer.concat([head, payload])
  const body = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i += 1) body[i] = (payload[i] as number) ^ (mask[i & 3] as number)
  return Buffer.concat([head, mask, body])
}

export type Frame = { fin: boolean; opcode: number; masked: boolean; payload: Buffer }

/**
 * Reads frames from a byte stream. It keeps the chunks in a list and copies each payload once, so a reply of
 * many MiB costs no quadratic copy. A frame longer than `max` throws before its payload arrives.
 */
export class FrameReader {
  private chunks: Buffer[] = []
  private size = 0
  private readonly max: number

  constructor(max: number) {
    this.max = max
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.size += chunk.length
  }

  /** The first `n` bytes, or undefined when fewer have arrived. It removes nothing. */
  private peek(n: number): Buffer | undefined {
    if (this.size < n) return undefined
    const first = this.chunks[0] as Buffer
    if (first.length >= n) return first.subarray(0, n)
    const out = Buffer.allocUnsafe(n)
    let off = 0
    for (const c of this.chunks) {
      const k = Math.min(c.length, n - off)
      c.copy(out, off, 0, k)
      off += k
      if (off === n) break
    }
    return out
  }

  /** Removes the first `n` bytes (at most `size`) and returns them as one buffer. */
  private take(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0)
    const first = this.chunks[0] as Buffer
    if (first.length >= n) {
      const out = first.subarray(0, n)
      if (first.length === n) this.chunks.shift()
      else this.chunks[0] = first.subarray(n)
      this.size -= n
      return out
    }
    const out = Buffer.allocUnsafe(n)
    let off = 0
    while (off < n) {
      const c = this.chunks[0] as Buffer
      const k = Math.min(c.length, n - off)
      c.copy(out, off, 0, k)
      off += k
      if (k === c.length) this.chunks.shift()
      else this.chunks[0] = c.subarray(k)
    }
    this.size -= n
    return out
  }

  /** The next whole frame, or undefined when it has not all arrived. */
  next(): Frame | undefined {
    const h = this.peek(2)
    if (h === undefined) return undefined
    const b0 = h[0] as number
    const b1 = h[1] as number
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let off = 2
    if (len === 126) {
      const x = this.peek(4)
      if (x === undefined) return undefined
      len = x.readUInt16BE(2)
      off = 4
    } else if (len === 127) {
      const x = this.peek(10)
      if (x === undefined) return undefined
      const big = x.readBigUInt64BE(2)
      if (big > BigInt(this.max)) throw new DaemonError('protocol', `a daemon frame of ${big} bytes is over the cap of ${this.max}`)
      len = Number(big)
      off = 10
    }
    if (len > this.max) throw new DaemonError('protocol', `a daemon frame of ${len} bytes is over the cap of ${this.max}`)
    const need = off + (masked ? 4 : 0) + len
    if (this.size < need) return undefined
    this.take(off)
    const mask = masked ? this.take(4) : undefined
    let payload = this.take(len)
    if (mask !== undefined) {
      const out = Buffer.allocUnsafe(len)
      for (let i = 0; i < len; i += 1) out[i] = (payload[i] as number) ^ (mask[i & 3] as number)
      payload = out
    }
    return { fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, masked, payload }
  }
}

/**
 * Joins the frames of a message (fragments, with control frames between them). A message over `max` bytes
 * throws. It gives the text of each whole text message, and drops binary messages.
 */
export class MessageJoiner {
  private parts: Buffer[] = []
  private size = 0
  private kind: number | undefined
  private readonly max: number

  constructor(max: number) {
    this.max = max
  }

  /** The text of the message that this data frame ends, else undefined. */
  add(f: Frame): string | undefined {
    if (f.opcode === OP.continuation) {
      if (this.kind === undefined) throw new DaemonError('protocol', 'a daemon continuation frame came with no message')
    } else {
      if (this.kind !== undefined) throw new DaemonError('protocol', 'a daemon message started inside another message')
      this.kind = f.opcode
    }
    this.size += f.payload.length
    if (this.size > this.max) throw new DaemonError('protocol', `a daemon message is over the cap of ${this.max} bytes`)
    this.parts.push(f.payload)
    if (!f.fin) return undefined
    const kind = this.kind
    const whole = this.parts.length === 1 ? (this.parts[0] as Buffer) : Buffer.concat(this.parts, this.size)
    this.parts = []
    this.size = 0
    this.kind = undefined
    return kind === OP.text ? whole.toString('utf8') : undefined
  }
}

/** RFC 6455 4.2.2: the accept value of a key. */
export const acceptOf = (key: string): string => createHash('sha1').update(key + WS_GUID).digest('base64')

// ---- One connection ----

type Rpc = {
  request(method: string, params: unknown): Promise<unknown>
  notify(method: string, params?: unknown): void
}

/** `uid`: the user that must own the socket and its folder, or undefined on a host with no POSIX uids. */
type Opts = { connectMs: number; maxMessage: number; uid: number | undefined }

/** Where the daemon socket alias leads: the real socket, no socket at all, or a socket that is not safe to dial. */
export type SocketAt = { real: string } | { missing: string } | { unsafe: string }

/**
 * The daemon socket at the end of `alias`. Codex links the alias to a short path in a shared temp folder,
 * so another user could put a socket there (after a reboot empties the folder, for example). spare10 dials
 * it only when it is a socket, `uid` owns it and its folder, and no other user can write to the folder.
 * Then no other user can answer in the daemon's place, or swap the socket before the connect.
 */
export function socketAt(alias: string, uid: number | undefined): SocketAt {
  let real: string
  let sock: Stats
  let dir: Stats
  try {
    // The alias can pass the 104-byte sun_path limit of macOS. Its target is short (gap-1 2.2).
    real = realpathSync(alias)
    sock = statSync(real)
    dir = statSync(dirname(real))
  } catch (e) {
    return { missing: errText(e) }
  }
  const unsafe = (why: string): SocketAt => ({ unsafe: `the daemon socket ${real} is not safe to dial: ${why}` })
  if (!sock.isSocket()) return unsafe('it is not a socket')
  if (uid !== undefined && sock.uid !== uid) return unsafe(`the user ${sock.uid} owns it`)
  if (uid !== undefined && dir.uid !== uid) return unsafe(`the user ${dir.uid} owns its folder`)
  if ((dir.mode & 0o002) !== 0) return unsafe('every user can write to its folder')
  return { real }
}

/** Opens the WebSocket on the real socket path. It resolves with the upgraded socket and the bytes after the headers. */
function upgrade(socketPath: string, clock: Clock, o: Opts): Promise<{ socket: Duplex; head: Buffer }> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    let done = false
    let timer: Timer | undefined
    const fail = (e: DaemonError): void => {
      if (done) return
      done = true
      timer?.cancel()
      reject(e)
    }
    const req = httpRequest({
      socketPath,
      path: '/',
      method: 'GET',
      agent: false,
      headers: {
        Host: 'localhost',
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    })
    timer = clock.after(o.connectMs, () => {
      fail(new DaemonError('connect', `the daemon did not answer the handshake within ${o.connectMs} ms`))
      req.destroy()
    })
    req.on('error', (e) => fail(new DaemonError('connect', `the daemon socket failed: ${e.message}`)))
    req.on('response', (res: IncomingMessage) => {
      res.resume()
      fail(new DaemonError('protocol', `the daemon answered the handshake with status ${res.statusCode ?? 0}`))
      req.destroy()
    })
    req.on('upgrade', (res: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (done) {
        socket.destroy()
        return
      }
      if (res.headers['sec-websocket-accept'] !== acceptOf(key)) {
        socket.destroy()
        fail(new DaemonError('protocol', 'the daemon handshake has a bad Sec-WebSocket-Accept'))
        return
      }
      done = true
      timer?.cancel()
      resolve({ socket, head })
    })
    req.end()
  })
}

/**
 * Runs `fn` on one initialized connection, then closes it. The call timer (`timeoutMs`) starts after the
 * handshake and covers `initialize` and `fn`.
 */
async function withConnection<T>(socketAlias: string, version: string, clock: Clock, timeoutMs: number, o: Opts, fn: (rpc: Rpc) => Promise<T>): Promise<T> {
  guardTestPath({}, 'daemon socket', socketAlias)
  // The check again at each connect: the socket can change after udsDaemon made the client.
  const at = socketAt(socketAlias, o.uid)
  if ('missing' in at) throw new DaemonError('connect', `no daemon socket: ${at.missing}`)
  if ('unsafe' in at) throw new DaemonError('connect', at.unsafe)
  const { socket, head } = await upgrade(at.real, clock, o)
  const reader = new FrameReader(o.maxMessage)
  const joiner = new MessageJoiner(o.maxMessage)
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: DaemonError) => void; method: string }>()
  let nextId = 0
  let ended: DaemonError | undefined

  const send = (opcode: number, payload: Buffer): void => {
    if (ended !== undefined) return
    try {
      socket.write(encodeFrame(opcode, payload))
    } catch (e) {
      finish(new DaemonError('closed', `the daemon socket failed: ${(e as Error).message}`))
    }
  }
  function finish(e: DaemonError): void {
    if (ended !== undefined) return
    ended = e
    for (const p of pending.values()) p.reject(e)
    pending.clear()
    socket.destroy()
  }
  const onText = (text: string): void => {
    let m: unknown
    try {
      m = JSON.parse(text)
    } catch {
      return
    }
    if (!isObject(m)) return
    // A server request or a notification has a method. Both are ignored, and a request is never answered (A13).
    if (m['method'] !== undefined) return
    const id = m['id']
    if (typeof id !== 'number') return
    const p = pending.get(id)
    if (p === undefined) return
    pending.delete(id)
    const err = m['error']
    if (isObject(err)) {
      const message = typeof err['message'] === 'string' ? err['message'] : 'error reply'
      p.reject(new DaemonError('rpc', `${p.method}: ${message}`, typeof err['code'] === 'number' ? err['code'] : undefined))
    } else p.resolve(m['result'])
  }
  const pump = (): void => {
    try {
      for (;;) {
        if (ended !== undefined) return
        const f = reader.next()
        if (f === undefined) return
        if (f.opcode === OP.ping) send(OP.pong, f.payload)
        else if (f.opcode === OP.pong) continue
        else if (f.opcode === OP.close) {
          send(OP.close, Buffer.alloc(0))
          finish(new DaemonError('closed', 'the daemon closed the connection'))
        } else if (f.opcode === OP.text || f.opcode === OP.binary || f.opcode === OP.continuation) {
          const text = joiner.add(f)
          if (text !== undefined) onText(text)
        } else throw new DaemonError('protocol', `a daemon frame has the unknown opcode ${f.opcode}`)
      }
    } catch (e) {
      finish(e instanceof DaemonError ? e : new DaemonError('protocol', String(e)))
    }
  }
  socket.on('data', (d: Buffer) => {
    reader.push(d)
    pump()
  })
  socket.on('error', (e: Error) => finish(new DaemonError('closed', `the daemon socket failed: ${e.message}`)))
  socket.on('close', () => finish(new DaemonError('closed', 'the daemon socket closed')))
  if (head.length > 0) {
    reader.push(head)
    pump()
  }

  const rpc: Rpc = {
    request(method, params) {
      if (ended !== undefined) return Promise.reject(ended)
      nextId += 1
      const id = nextId
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject, method })
        send(OP.text, Buffer.from(JSON.stringify({ id, method, params }), 'utf8'))
      })
    },
    notify(method, params) {
      send(OP.text, Buffer.from(JSON.stringify(params === undefined ? { method } : { method, params }), 'utf8'))
    },
  }

  const timer = clock.after(timeoutMs, () => finish(new DaemonError('timeout', `the daemon call took longer than ${timeoutMs} ms`)))
  try {
    await rpc.request('initialize', {
      clientInfo: { name: DAEMON_CLIENT_NAME, title: 'spare10', version },
      capabilities: {},
    })
    rpc.notify('initialized')
    return await fn(rpc)
  } finally {
    timer.cancel()
    if (ended === undefined) {
      // Close at once: a close frame (1000, normal), then the end of the socket.
      const code = Buffer.alloc(2)
      code.writeUInt16BE(1000, 0)
      try {
        const last = encodeFrame(OP.close, code)
        ended = new DaemonError('closed', 'the connection is closed')
        socket.end(last, () => socket.destroy())
      } catch {
        socket.destroy()
      }
    }
  }
}

const badReply = (method: string, what: string): DaemonError => new DaemonError('reply', `${method}: the reply has no ${what}`)

/**
 * The error of `thread/turns/list` for a thread with no user message yet
 * (`app-server/src/request_processors/thread_processor.rs` L5893).
 */
export const NOT_MATERIALIZED = /is not materialized yet/

/**
 * The daemon client of `paths.socket`, or undefined when no socket file exists (no daemon). A socket that is
 * not safe to dial (socketAt) throws a DaemonError: the link counts it as no daemon, with a debug line. With
 * SPARE10_CODEX_TEST=1, a socket under ~/.codex throws (3.9). `o` sets the handshake timeout, the size cap
 * and the owner uid (default: this process's uid), for the specs.
 */
export function udsDaemon(paths: Pick<Paths, 'socket'>, version: string, clock: Clock, o: Partial<Opts> = {}): Daemon | undefined {
  guardTestPath({}, 'daemon socket', paths.socket)
  const uid = 'uid' in o ? o.uid : process.getuid?.()
  const at = socketAt(paths.socket, uid)
  if ('missing' in at) return undefined
  if ('unsafe' in at) throw new DaemonError('connect', at.unsafe)
  const opts: Opts = { connectMs: o.connectMs ?? DAEMON_CONNECT_MS, maxMessage: o.maxMessage ?? DAEMON_MAX_MESSAGE, uid }
  const op = <T>(timeoutMs: number, fn: (rpc: Rpc) => Promise<T>): Promise<T> =>
    withConnection(paths.socket, version, clock, timeoutMs, opts, fn)
  return {
    rateLimits: (timeoutMs = A_READ_MS) => op(timeoutMs, (c) => c.request('account/rateLimits/read', { excludeResetCreditDetails: true })),
    loaded: () =>
      op(LOADED_MS, async (c) => {
        const ids: string[] = []
        let cursor: string | undefined
        // The list has no page size by default. A cursor is followed for a few pages all the same.
        for (let page = 0; page < 20; page += 1) {
          const r = await c.request('thread/loaded/list', cursor === undefined ? {} : { cursor })
          if (!isObject(r) || !Array.isArray(r['data'])) throw badReply('thread/loaded/list', 'data list')
          for (const id of r['data']) if (typeof id === 'string') ids.push(id)
          const next = r['nextCursor']
          if (typeof next !== 'string' || next === '') break
          cursor = next
        }
        return ids
      }),
    status: (threadId) =>
      op(THREAD_READ_MS, async (c) => {
        const r = await c.request('thread/read', { threadId })
        const thread = isObject(r) ? r['thread'] : undefined
        const status = isObject(thread) ? thread['status'] : undefined
        const type = isObject(status) ? status['type'] : undefined
        if (typeof type !== 'string') throw badReply('thread/read', 'thread status')
        return type
      }),
    newestTurn: (threadId) =>
      op(THREAD_READ_MS, async (c) => {
        let r: unknown
        try {
          r = await c.request('thread/turns/list', { threadId, limit: 1, itemsView: 'notLoaded' })
        } catch (e) {
          // A thread with no user message yet has no rollout, and Codex answers an error, not an empty list [P].
          if (e instanceof DaemonError && e.kind === 'rpc' && NOT_MATERIALIZED.test(e.message)) return undefined
          throw e
        }
        if (!isObject(r) || !Array.isArray(r['data'])) throw badReply('thread/turns/list', 'data list')
        const t: unknown = r['data'][0]
        if (t === undefined) return undefined
        if (!isObject(t) || typeof t['id'] !== 'string' || typeof t['status'] !== 'string') throw badReply('thread/turns/list', 'turn')
        const at = t['startedAt']
        return { id: t['id'], status: t['status'], startedAt: typeof at === 'number' && Number.isFinite(at) ? at : null }
      }),
    interrupt: (threadId, turnId) =>
      op(INTERRUPT_MS, async (c) => {
        await c.request('turn/interrupt', { threadId, turnId })
      }),
    start: (threadId, text) =>
      op(START_MS, async (c) => {
        const r = await c.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] })
        const turn = isObject(r) ? r['turn'] : undefined
        const id = isObject(turn) ? turn['id'] : undefined
        if (typeof id !== 'string') throw badReply('turn/start', 'turn id')
        return id
      }),
    hooksList: (cwd) => op(THREAD_READ_MS, (c) => c.request('hooks/list', { cwds: [cwd] })),
  }
}

// ---- The link of one broker ----

export type DaemonLink = {
  /** The daemon client, or undefined when no daemon socket exists now, or when it is not safe to dial. */
  get(): Daemon | undefined
  /** True when the daemon lists the thread in `thread/loaded/list`. A failed read is false and is not kept. */
  hosted(threadId: string): Promise<boolean>
  /** As `hosted`, but a failed read is undefined: nobody knows yet. With no daemon it is false. */
  known(threadId: string): Promise<boolean | undefined>
}

/**
 * The daemon of one broker. `make` runs at each `get`, so a daemon that starts or stops later shows. A `make`
 * that throws (a socket that is not safe to dial, the test guard) is no daemon, with one debug line for each
 * new reason. `hosted` keeps a list that names the thread for HOSTED_TTL_MS (60 s), and reads a list that
 * does not name it again after HOSTED_MISS_TTL_MS, so a thread that loaded later shows. Reads at the same
 * time share one call. A failed read writes a debug line.
 */
export function daemonLink(make: () => Daemon | undefined, clock: Clock, o: { ttlMs?: number; missTtlMs?: number; log?: Log } = {}): DaemonLink {
  const ttl = o.ttlMs ?? HOSTED_TTL_MS
  const missTtl = o.missTtlMs ?? HOSTED_MISS_TTL_MS
  let cache: { at: number; ids: ReadonlySet<string> } | undefined
  let reading: Promise<ReadonlySet<string> | undefined> | undefined
  let told: string | undefined

  const get = (): Daemon | undefined => {
    try {
      const d = make()
      told = undefined
      return d
    } catch (e) {
      const why = errText(e)
      if (why !== told) o.log?.debug(codexDebug.liveFailed('daemon', why))
      told = why
      return undefined
    }
  }

  const refresh = (d: Daemon): Promise<ReadonlySet<string> | undefined> => {
    if (reading !== undefined) return reading
    reading = d
      .loaded()
      .then(
        (ids) => {
          const set = new Set(ids)
          cache = { at: clock.now(), ids: set }
          return set
        },
        (e: unknown) => {
          o.log?.debug(codexDebug.readFailed('the loaded threads', errText(e)))
          return undefined
        },
      )
      .finally(() => {
        reading = undefined
      })
    return reading
  }

  /**
   * `hosted` (a failed read is false) or `known` (a failed read is undefined). Each awaits once, as
   * `hosted` always did: the specs count the turns of a chain.
   */
  const lookup =
    <F extends false | undefined>(failed: F) =>
    async (threadId: string): Promise<boolean | F> => {
      const d = get()
      if (d === undefined) {
        cache = undefined
        return false
      }
      if (cache !== undefined) {
        const age = clock.now() - cache.at
        const has = cache.ids.has(threadId)
        if (age >= 0 && age < (has ? ttl : missTtl)) return has
      }
      const ids = await refresh(d)
      return ids === undefined ? failed : ids.has(threadId)
    }

  return { get, hosted: lookup(false), known: lookup(undefined) }
}
