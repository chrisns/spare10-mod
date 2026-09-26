import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TestContext } from 'node:test'
import { underRealCodexHome } from '../../src/paths.ts'

// The fake Codex daemon of the specs (Codex design 8.2): a WebSocket-over-UDS server on a short temp socket,
// linked from `<CODEX_HOME>/app-server-control/app-server-control.sock`, as the real daemon links its
// socket. It does the upgrade and the frames (fragments, ping, 16-bit and 64-bit lengths), answers each
// request with a scripted handler, and after `initialize` can send unasked pushes and a server request. It
// decodes the client frames with its own code, so a bug in the client's frame code cannot hide itself. It
// runs on the real clock. Only daemon.spec and wiring.spec use it.

type Json = Record<string, unknown>

/** A handler result that the fake never answers. */
export const HANG = Symbol('hang')
/** A handler result that makes the fake close the socket with no answer. */
export const DROP = Symbol('drop')

/** Throw it from a handler to answer a JSON-RPC error. */
export class RpcFail extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

export type Handler = (params: unknown, conn: FakeConn) => unknown

export type ClientFrame = { opcode: number; fin: boolean; masked: boolean; length: number }

export type FakeConn = {
  /** The request line path of the upgrade, and its headers (lower-case names). */
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  /** Every frame the client sent. */
  readonly frames: ClientFrame[]
  /** Every text message the client sent, parsed. */
  readonly received: Json[]
  /** The payloads of the pongs the client sent. */
  readonly pongs: string[]
  /** True once the client sent a close frame. */
  clientClosed: boolean
  /** True once the socket closed. */
  closed: boolean
  /** Resolves when the socket closes. */
  readonly done: Promise<void>
}

export type FakeOptions = {
  /** Handlers by method. `initialize` and `thread/loaded/list` have defaults. Any other method answers `{}`. */
  handlers?: Record<string, Handler>
  /** After `initialize`: unasked pushes (`thread/started`, an item delta) and one server request, id 99. */
  pushes?: boolean
  /** Split each message into text frames of at most this many bytes (the first, then continuations). */
  fragmentBytes?: number
  /** Send a ping before each answer. */
  pingFirst?: boolean
  /** Send a pong nobody asked for before each answer. */
  pongFirst?: boolean
  /** The accept header value. Default: the right one. */
  accept?: (key: string) => string
  /** Answer the handshake with this status and no upgrade. */
  refuseStatus?: number
  /** Mask the frames the fake sends (a server should not, but a client must read them). */
  maskOut?: boolean
  /** Never answer the handshake. */
  silent?: boolean
}

export type FakeDaemon = {
  /** The Codex home: its `app-server-control/app-server-control.sock` links to the real socket. */
  readonly codexHome: string
  readonly alias: string
  readonly real: string
  readonly conns: FakeConn[]
  /** Every request after `initialize`, in order, with its params. */
  readonly calls: Array<{ method: string; params: unknown }>
  /** Sets the handler of one method. */
  on(method: string, h: Handler): void
  /** Resolves when `n` connections have closed. */
  closedConns(n: number): Promise<void>
  /** Resolves when a request of `method` has arrived. */
  arrived(method: string): Promise<void>
  close(): Promise<void>
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function frame(opcode: number, payload: Buffer, fin: boolean, mask: boolean): Buffer {
  const len = payload.length
  const head = Buffer.alloc(len < 126 ? 2 : len < 65_536 ? 4 : 10)
  head[0] = (fin ? 0x80 : 0) | opcode
  const bit = mask ? 0x80 : 0
  if (len < 126) head[1] = bit | len
  else if (len < 65_536) {
    head[1] = bit | 126
    head.writeUInt16BE(len, 2)
  } else {
    head[1] = bit | 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  if (!mask) return Buffer.concat([head, payload])
  const key = Buffer.from([1, 2, 3, 4])
  const body = Buffer.from(payload.map((b, i) => b ^ (key[i & 3] as number)))
  return Buffer.concat([head, key, body])
}

/** Starts the fake. `codexHome` defaults to a new temp folder. The test removes everything after it. */
export async function fakeDaemon(t: TestContext, o: FakeOptions & { codexHome?: string } = {}): Promise<FakeDaemon> {
  const sockDir = mkdtempSync(join(tmpdir(), 's10d-'))
  const codexHome = o.codexHome ?? mkdtempSync(join(tmpdir(), 's10h-'))
  for (const p of [sockDir, codexHome]) {
    if (underRealCodexHome(p)) throw new Error(`spare10 test: ${p} is under ~/.codex`)
  }
  const real = join(sockDir, 'd.sock')
  const alias = join(codexHome, 'app-server-control', 'app-server-control.sock')
  mkdirSync(dirname(alias), { recursive: true })
  symlinkSync(real, alias)

  const handlers = new Map<string, Handler>(Object.entries(o.handlers ?? {}))
  // The answers of a daemon with no loaded thread, in the shapes of Codex 0.157.
  const DEFAULTS: Record<string, Handler> = {
    initialize: () => ({ userAgent: 'fake', codexHome, platformFamily: 'unix', platformOs: 'macos' }),
    'thread/loaded/list': () => ({ data: [], nextCursor: null }),
  }
  const conns: FakeConn[] = []
  const calls: Array<{ method: string; params: unknown }> = []
  const waiters: Array<() => void> = []
  const poke = (): void => {
    for (const w of waiters.splice(0)) w()
  }
  const until = async (ok: () => boolean): Promise<void> => {
    while (!ok()) await new Promise<void>((resolve) => waiters.push(resolve))
  }
  const sockets = new Set<Socket>()

  const serve = (socket: Socket): void => {
    sockets.add(socket)
    let buf = Buffer.alloc(0)
    let upgraded = false
    let parts: Buffer[] = []
    let closeDone!: () => void
    const done = new Promise<void>((resolve) => (closeDone = resolve))
    const conn: FakeConn = { path: '', headers: {}, frames: [], received: [], pongs: [], clientClosed: false, closed: false, done }
    const w = conn as { -readonly [K in keyof FakeConn]: FakeConn[K] }

    const sendText = (text: string): void => {
      if (socket.destroyed) return
      const body = Buffer.from(text, 'utf8')
      const size = o.fragmentBytes ?? body.length
      if (o.pingFirst === true) socket.write(frame(0x9, Buffer.from('hb'), true, o.maskOut === true))
      if (o.pongFirst === true) socket.write(frame(0xa, Buffer.from('np'), true, o.maskOut === true))
      if (size <= 0 || body.length <= size) {
        socket.write(frame(0x1, body, true, o.maskOut === true))
        return
      }
      for (let off = 0; off < body.length; off += size) {
        const last = off + size >= body.length
        const op = off === 0 ? 0x1 : 0x0
        socket.write(frame(op, body.subarray(off, off + size), last, o.maskOut === true))
        // A ping between two fragments: the client must answer it and keep the message whole.
        if (off === 0 && o.pingFirst === true) socket.write(frame(0x9, Buffer.from('mid'), true, o.maskOut === true))
      }
    }
    const send = (m: Json): void => sendText(JSON.stringify(m))

    const onRequest = async (m: Json): Promise<void> => {
      const method = String(m['method'])
      const id = m['id']
      if (method !== 'initialize') calls.push({ method, params: m['params'] })
      poke()
      const h = handlers.get(method) ?? DEFAULTS[method] ?? (() => ({}))
      let result: unknown
      try {
        result = await h(m['params'], conn)
      } catch (e) {
        if (e instanceof RpcFail) send({ id, error: { code: e.code, message: e.message } })
        else send({ id, error: { code: -32603, message: String(e) } })
        return
      }
      if (result === HANG) return
      if (result === DROP) {
        socket.destroy()
        return
      }
      send({ id, result })
      if (method === 'initialize' && o.pushes === true) {
        send({ method: 'thread/started', params: { thread: { id: 'T-OTHER', status: { type: 'idle' } } } })
        send({ method: 'item/agentMessage/delta', params: { threadId: 'T-OTHER', turnId: 'U-OTHER', itemId: 'I', delta: 'x' } })
        send({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'T-OTHER', turnId: 'U-OTHER', itemId: 'I' } })
      }
    }

    const onFrame = (op: number, fin: boolean, payload: Buffer): void => {
      if (op === 0x8) {
        w.clientClosed = true
        if (!socket.destroyed) socket.end(frame(0x8, Buffer.alloc(0), true, false))
        poke()
        return
      }
      if (op === 0xa) {
        conn.pongs.push(payload.toString('utf8'))
        poke()
        return
      }
      if (op === 0x9) return
      parts.push(payload)
      if (!fin) return
      const text = Buffer.concat(parts).toString('utf8')
      parts = []
      let m: unknown
      try {
        m = JSON.parse(text)
      } catch {
        return
      }
      if (typeof m !== 'object' || m === null) return
      conn.received.push(m as Json)
      poke()
      if (typeof (m as Json)['method'] === 'string' && (m as Json)['id'] !== undefined) void onRequest(m as Json)
    }

    const pumpFrames = (): void => {
      for (;;) {
        if (buf.length < 2) return
        const b0 = buf[0] as number
        const b1 = buf[1] as number
        let len = b1 & 0x7f
        let off = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          off = 4
        } else if (len === 127) {
          if (buf.length < 10) return
          len = Number(buf.readBigUInt64BE(2))
          off = 10
        }
        const masked = (b1 & 0x80) !== 0
        const need = off + (masked ? 4 : 0) + len
        if (buf.length < need) return
        let payload = buf.subarray(off + (masked ? 4 : 0), need)
        if (masked) {
          const key = buf.subarray(off, off + 4)
          payload = Buffer.from(payload.map((b, i) => b ^ (key[i & 3] as number)))
        }
        buf = buf.subarray(need)
        conn.frames.push({ opcode: b0 & 0x0f, fin: (b0 & 0x80) !== 0, masked, length: len })
        onFrame(b0 & 0x0f, (b0 & 0x80) !== 0, payload)
      }
    }

    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n')
        if (end < 0) return
        const lines = buf.subarray(0, end).toString('latin1').split('\r\n')
        buf = buf.subarray(end + 4)
        const [, path = ''] = (lines[0] ?? '').split(' ')
        const headers: Record<string, string> = {}
        for (const l of lines.slice(1)) {
          const at = l.indexOf(':')
          if (at > 0) headers[l.slice(0, at).trim().toLowerCase()] = l.slice(at + 1).trim()
        }
        w.path = path
        w.headers = headers
        conns.push(conn)
        poke()
        if (o.silent === true) return
        if (o.refuseStatus !== undefined) {
          socket.end(`HTTP/1.1 ${o.refuseStatus} No\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
          return
        }
        const key = headers['sec-websocket-key'] ?? ''
        const accept = o.accept?.(key) ?? createHash('sha1').update(key + GUID).digest('base64')
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\nx-codex-websocket-max-unfragmented-message-bytes: 16777216\r\n\r\n`,
        )
        upgraded = true
      }
      pumpFrames()
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      sockets.delete(socket)
      w.closed = true
      closeDone()
      poke()
    })
  }

  const server = createServer(serve)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(real, () => resolve())
  })

  const close = async (): Promise<void> => {
    for (const s of sockets) s.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  t.after(async () => {
    await close()
    rmSync(sockDir, { recursive: true, force: true })
    if (o.codexHome === undefined) rmSync(codexHome, { recursive: true, force: true })
  })

  return {
    codexHome,
    alias,
    real,
    conns,
    calls,
    on: (method, h) => void handlers.set(method, h),
    closedConns: (n) => until(() => conns.filter((c) => c.closed).length >= n),
    arrived: (method) => until(() => calls.some((c) => c.method === method)),
    close,
  }
}
