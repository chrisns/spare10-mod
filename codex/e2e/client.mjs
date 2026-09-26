// An app-server client for the end-to-end runs (Codex design 8.3): JSON-RPC over the stdio of a
// `codex app-server` child, or over a WebSocket on a Unix socket (the daemon socket of a test home). Node
// built-ins only. It connects as `codex-tui` with `experimentalApi`, so its threads are attended. It answers
// each `mcpServer/elicitation/request` from a queue of scripted answers, accepts command approvals, and
// records every message, hook run, turn end and resolved server request.

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { connect } from 'node:net'

/** The answer of a form, as the client sends it. `hang` never answers. */
export const ELICIT_ANSWERS = ['resume', 'stop', 'cancel', 'decline', 'error', 'hang']

const now = () => Date.now()

export class AppServer {
  /**
   * @param {{ send(line: string): void; close(): void; closed: Promise<void> }} transport
   * @param {{ log?: string; name?: string }} o
   */
  constructor(transport, o = {}) {
    this.transport = transport
    this.name = o.name ?? 'codex-tui'
    this.nextId = 1
    this.pending = new Map()
    this.waiters = []
    /** Every message from the server, in order, with the time it came. */
    this.messages = []
    /** `hook/completed` runs: { threadId, turnId, run }. */
    this.hooks = []
    /** `turn/completed`: turn id to its turn. */
    this.turns = new Map()
    /** `mcpServer/elicitation/request` params, in order, with the answer sent. */
    this.elicitations = []
    /** Ids of `serverRequest/resolved`. */
    this.resolved = []
    /** Scripted form answers, taken in order. A function gets the params and returns an answer. */
    this.answers = []
    /** Forms that got `hang`: answer one later with `answer()`. */
    this.hanging = []
    this.log = o.log === undefined ? undefined : createWriteStream(o.log, { flags: 'a' })
    this.t0 = now()
    this.closed = transport.closed
  }

  /** Spawns `codex app-server` (stdio) with `env` in `cwd`. `stderr` names a file for its stderr. */
  static stdio({ env, cwd, codex = 'codex', args = [], log, stderr }) {
    const child = spawn(codex, ['app-server', ...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    if (stderr !== undefined) child.stderr.pipe(createWriteStream(stderr, { flags: 'a' }))
    else child.stderr.resume()
    const closed = new Promise((res) => child.on('close', () => res()))
    const transport = {
      send: (line) => {
        if (child.stdin.writable) child.stdin.write(`${line}\n`)
      },
      close: () => child.stdin.end(),
      kill: () => child.kill('SIGKILL'),
      closed,
      child,
    }
    const server = new AppServer(transport, { log })
    let buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim() !== '') server.receive(line)
      }
    })
    closed.then(() => server.fail(new Error('the app-server closed')))
    return server
  }

  /** Connects to an app-server that listens on the Unix socket `path` (WebSocket, RFC 6455). */
  static async socket({ path, log, timeoutMs = 5000 }) {
    const sock = connect(path)
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`no connection to ${path}`)), timeoutMs)
      sock.once('connect', () => (clearTimeout(t), res()))
      sock.once('error', (e) => (clearTimeout(t), rej(e)))
    })
    const key = randomBytes(16).toString('base64')
    sock.write(
      `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    )
    let pending = Buffer.alloc(0)
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('no WebSocket handshake')), timeoutMs)
      const onData = (chunk) => {
        pending = Buffer.concat([pending, chunk])
        const end = pending.indexOf('\r\n\r\n')
        if (end < 0) return
        sock.off('data', onData)
        clearTimeout(t)
        const head = pending.subarray(0, end).toString('latin1')
        pending = pending.subarray(end + 4)
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
        if (!/^HTTP\/1\.1 101/.test(head) || !head.toLowerCase().includes(accept.toLowerCase())) rej(new Error(`bad handshake: ${head.split('\r\n')[0]}`))
        else res()
      }
      sock.on('data', onData)
    })
    const frame = (op, payload) => {
      const len = payload.length
      const head = len < 126 ? Buffer.from([0x80 | op, 0x80 | len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
      if (len >= 126 && len < 65536) {
        head[0] = 0x80 | op
        head[1] = 0x80 | 126
        head.writeUInt16BE(len, 2)
      } else if (len >= 65536) {
        head[0] = 0x80 | op
        head[1] = 0x80 | 127
        head.writeBigUInt64BE(BigInt(len), 2)
      }
      const mask = randomBytes(4)
      const body = Buffer.from(payload)
      for (let i = 0; i < len; i += 1) body[i] ^= mask[i & 3]
      return Buffer.concat([head, mask, body])
    }
    const closed = new Promise((res) => sock.on('close', () => res()))
    const transport = {
      send: (line) => {
        if (!sock.destroyed) sock.write(frame(0x1, Buffer.from(line, 'utf8')))
      },
      close: () => {
        if (!sock.destroyed) sock.end(frame(0x8, Buffer.alloc(0)))
      },
      kill: () => sock.destroy(),
      closed,
    }
    const server = new AppServer(transport, { log })
    let buf = pending
    let parts = []
    const drain = () => {
      for (;;) {
        if (buf.length < 2) return
        const fin = (buf[0] & 0x80) !== 0
        const op = buf[0] & 0x0f
        const masked = (buf[1] & 0x80) !== 0
        let len = buf[1] & 0x7f
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
        const need = off + (masked ? 4 : 0) + len
        if (buf.length < need) return
        let payload = buf.subarray(off + (masked ? 4 : 0), need)
        if (masked) {
          const m = buf.subarray(off, off + 4)
          payload = Buffer.from(payload)
          for (let i = 0; i < len; i += 1) payload[i] ^= m[i & 3]
        }
        buf = buf.subarray(need)
        if (op === 0x9) sock.write(frame(0xa, payload))
        else if (op === 0x8) sock.end()
        else if (op === 0x1 || op === 0x2 || op === 0x0) {
          parts.push(payload)
          if (fin) {
            const text = Buffer.concat(parts).toString('utf8')
            parts = []
            server.receive(text)
          }
        }
      }
    }
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      drain()
    })
    drain()
    closed.then(() => server.fail(new Error('the socket closed')))
    return server
  }

  write(obj) {
    const line = JSON.stringify(obj)
    this.log?.write(`${JSON.stringify({ dt: (now() - this.t0) / 1000, out: obj })}\n`)
    this.transport.send(line)
  }

  fail(err) {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }

  receive(line) {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    const at = now()
    this.messages.push({ at, m })
    this.log?.write(`${JSON.stringify({ dt: (at - this.t0) / 1000, m })}\n`)
    if (m.id !== undefined && m.method === undefined) {
      const p = this.pending.get(m.id)
      if (p !== undefined) {
        this.pending.delete(m.id)
        if (m.error !== undefined) p.reject(Object.assign(new Error(`${p.method}: ${m.error.message ?? JSON.stringify(m.error)}`), { rpc: m.error }))
        else p.resolve(m.result)
      }
    } else if (m.id !== undefined && m.method !== undefined) {
      this.serverRequest(m)
    } else if (m.method === 'hook/completed') {
      this.hooks.push({ at, threadId: m.params.threadId, turnId: m.params.turnId, run: m.params.run })
    } else if (m.method === 'turn/completed') {
      this.turns.set(m.params.turn.id, { at, threadId: m.params.threadId, ...m.params.turn })
    } else if (m.method === 'serverRequest/resolved') {
      this.resolved.push(m.params.requestId)
    }
    for (const w of [...this.waiters]) {
      if (w.pred(m)) {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        clearTimeout(w.timer)
        w.resolve(m)
      }
    }
  }

  serverRequest(m) {
    if (m.method === 'mcpServer/elicitation/request') {
      const next = this.answers.shift()
      const answer = typeof next === 'function' ? next(m.params) : (next ?? 'hang')
      const entry = { at: now(), id: m.id, params: m.params, answer }
      this.elicitations.push(entry)
      if (answer === 'hang') this.hanging.push(entry)
      else this.answerForm(m.id, answer)
      return
    }
    if (m.method === 'item/commandExecution/requestApproval' || m.method === 'item/fileChange/requestApproval') {
      this.write({ id: m.id, result: { decision: 'accept' } })
      return
    }
    this.write({ id: m.id, error: { code: -32601, message: `the e2e client does not handle ${m.method}` } })
  }

  /** Sends the answer of a form: `resume` and `stop` accept with that choice. */
  answerForm(id, answer) {
    if (answer === 'resume' || answer === 'stop') this.write({ id, result: { action: 'accept', content: { choice: answer }, _meta: null } })
    else if (answer === 'cancel' || answer === 'decline') this.write({ id, result: { action: answer, content: null, _meta: null } })
    else if (answer === 'error') this.write({ id, error: { code: -32603, message: 'the e2e client failed the form' } })
    else throw new Error(`unknown form answer ${answer}`)
  }

  /** Answers the oldest form that got `hang`. */
  answer(answer) {
    const e = this.hanging.shift()
    if (e === undefined) throw new Error('no form waits for an answer')
    e.answer = answer
    this.answerForm(e.id, answer)
  }

  request(method, params, { timeoutMs = 30000 } = {}) {
    const id = this.nextId++
    const out = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method}: no reply in ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      })
    })
    this.write(params === undefined ? { id, method } : { id, method, params })
    return out
  }

  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params })
  }

  /** The next message (or one already seen, with `seen: true`) for which `pred` is true. */
  waitFor(pred, { timeoutMs = 30000, seen = false, what = 'a message' } = {}) {
    if (seen) {
      const hit = this.messages.find((x) => pred(x.m))
      if (hit !== undefined) return Promise.resolve(hit.m)
    }
    return new Promise((resolve, reject) => {
      const w = { pred, resolve }
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        reject(new Error(`no ${what} in ${timeoutMs} ms`))
      }, timeoutMs)
      this.waiters.push(w)
    })
  }

  async initialize() {
    const r = await this.request('initialize', { clientInfo: { name: this.name, title: null, version: '0' }, capabilities: { experimentalApi: true } })
    this.notify('initialized')
    return r
  }

  async startThread(params) {
    const r = await this.request('thread/start', params, { timeoutMs: 60000 })
    return r.thread
  }

  /** Starts a turn with one text input: its turn id. */
  async startTurn(threadId, text) {
    const r = await this.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] })
    return r.turn.id
  }

  async steer(threadId, turnId, text) {
    const r = await this.request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text, text_elements: [] }] })
    return r.turnId
  }

  interrupt(threadId, turnId) {
    return this.request('turn/interrupt', { threadId, turnId })
  }

  /** The `turn/completed` turn of `turnId`, when it comes. */
  async turnDone(turnId, timeoutMs = 60000) {
    const t = this.turns.get(turnId)
    if (t !== undefined) return t
    await this.waitFor((m) => m.method === 'turn/completed' && m.params.turn.id === turnId, { timeoutMs, what: `turn/completed of ${turnId}` })
    return this.turns.get(turnId)
  }

  /** Waits until `ms` pass with no new message. */
  async quiet(ms = 500, maxMs = 10000) {
    const end = now() + maxMs
    for (;;) {
      const last = this.messages.at(-1)?.at ?? this.t0
      const idle = now() - last
      if (idle >= ms || now() >= end) return
      await new Promise((r) => setTimeout(r, ms - idle))
    }
  }

  /** Closes the connection and waits for the end, at most `ms`, then kills it. */
  async close(ms = 10000) {
    this.transport.close()
    let timer
    const late = new Promise((r) => {
      timer = setTimeout(() => {
        this.transport.kill?.()
        r()
      }, ms)
    })
    await Promise.race([this.closed, late])
    clearTimeout(timer)
    await new Promise((r) => (this.log === undefined ? r() : this.log.end(r)))
  }
}
