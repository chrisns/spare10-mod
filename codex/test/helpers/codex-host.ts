import { PassThrough } from 'node:stream'
import { settleTurns } from './clock.ts'

// The Codex double of the specs (Codex design 8.2). It plays Codex toward one MCP server over two in-memory
// streams, as rmcp does over the broker's stdin and stdout: `initialize` (with or without the form
// capability), `notifications/initialized`, `tools/list`, gate calls with `_meta.threadId`, `drop` (Codex
// stops waiting and ignores the late answer), and an elicitation responder with a queue of scripted answers.
// It records every message the server sends.

type Json = Record<string, unknown>

/** A scripted answer to an elicitation: the form's choice, cancel, decline, a JSON-RPC error, or no answer. */
export type ElicitScript = 'resume' | 'stop' | 'cancel' | 'decline' | 'error' | 'hang'

export const elicitResult = (s: Exclude<ElicitScript, 'error' | 'hang'>): Json =>
  s === 'resume' || s === 'stop' ? { action: 'accept', content: { choice: s } } : { action: s }

export type GateHandle = { id: number; answer: Promise<string | undefined> }

export type CodexHost = {
  /** The server's stdin: what the host writes. */
  readonly input: PassThrough
  /** The server's stdout: what the host reads. */
  readonly output: PassThrough
  /** Every message the server sent, in order. */
  readonly sent: Json[]
  /** Every request the server sent (elicitations). */
  readonly requests: Json[]
  /** The answers to calls that the host dropped. */
  readonly late: Json[]
  /** Sends one raw line. */
  line(text: string): void
  /** Sends a request and resolves with the whole response. */
  request(method: string, params?: unknown): Promise<Json>
  notify(method: string, params?: unknown): void
  /** `initialize` as Codex 0.157 sends it. `form: false` leaves out the elicitation capability. */
  initialize(o?: { form?: boolean; elicitation?: unknown; protocolVersion?: string }): Promise<Json>
  initialized(): void
  /** A gate call: its id, and its answer text (undefined when the host dropped it). */
  call(args: unknown, threadId?: string, meta?: Json): GateHandle
  /** A gate call's answer text. It rejects on an error or a non-text answer. */
  gate(args: unknown, threadId?: string): Promise<string>
  /** Codex stops waiting for the call and ignores its late answer (gap-0 P7: no notice to the server). */
  drop(id: number): void
  /** Sends `notifications/cancelled` for the call. */
  cancel(id: number): void
  /** Queues scripted answers to the next elicitations. With none queued, an elicitation waits for `answer`. */
  script(...answers: ElicitScript[]): void
  /** The elicitations that have no answer yet. */
  pending(): Json[]
  /** Answers the oldest pending elicitation with this result, or with a JSON-RPC error. */
  answer(result: Json | { error: { code: number; message: string } }): void
  /** stdin EOF. */
  end(): void
  /** Resolves when a message that matches has come. */
  waitFor(match: (m: Json) => boolean): Promise<Json>
}

export function codexHost(): CodexHost {
  const input = new PassThrough()
  const output = new PassThrough()
  const sent: Json[] = []
  const requests: Json[] = []
  const late: Json[] = []
  const waiting = new Map<string, (m: Json) => void>()
  const dropped = new Set<string>()
  const gates = new Map<number, (text: string | undefined) => void>()
  const queue: ElicitScript[] = []
  const open: Json[] = []
  const watchers: Array<{ match: (m: Json) => boolean; resolve: (m: Json) => void }> = []
  let nextId = 0
  let buf = ''

  const write = (m: Json): void => void input.write(`${JSON.stringify(m)}\n`)

  const hung = new Set<Json>()
  const respond = (req: Json, s: ElicitScript): void => {
    if (s === 'hang') {
      hung.add(req)
      return
    }
    const at = open.indexOf(req)
    if (at >= 0) open.splice(at, 1)
    if (s === 'error') write({ jsonrpc: '2.0', id: req['id'], error: { code: -32603, message: 'elicitation failed' } })
    else write({ jsonrpc: '2.0', id: req['id'], result: elicitResult(s) })
  }

  const onMessage = (m: Json): void => {
    sent.push(m)
    for (const w of [...watchers]) {
      if (w.match(m)) {
        watchers.splice(watchers.indexOf(w), 1)
        w.resolve(m)
      }
    }
    if (typeof m['method'] === 'string' && m['id'] !== undefined) {
      requests.push(m)
      open.push(m)
      const next = queue.shift()
      if (next !== undefined) respond(m, next)
      return
    }
    const key = JSON.stringify(m['id'])
    if (dropped.has(key)) {
      late.push(m)
      return
    }
    const w = waiting.get(key)
    if (w !== undefined) {
      waiting.delete(key)
      w(m)
    }
  }

  output.setEncoding('utf8')
  output.on('data', (chunk: string) => {
    buf += chunk
    for (;;) {
      const at = buf.indexOf('\n')
      if (at < 0) return
      const text = buf.slice(0, at)
      buf = buf.slice(at + 1)
      if (text.trim() !== '') onMessage(JSON.parse(text) as Json)
    }
  })

  const request = (method: string, params?: unknown): Promise<Json> => {
    nextId += 1
    const id = nextId
    const p = new Promise<Json>((resolve) => waiting.set(JSON.stringify(id), resolve))
    write(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params })
    return p
  }

  const call = (args: unknown, threadId?: string, meta?: Json): GateHandle => {
    nextId += 1
    const id = nextId
    const answer = new Promise<string | undefined>((resolve) => {
      gates.set(id, resolve)
      waiting.set(JSON.stringify(id), (m) => {
        gates.delete(id)
        const result = m['result'] as Json | undefined
        const content = result?.['content'] as Json[] | undefined
        const first = content?.[0]
        if (m['error'] !== undefined || result?.['isError'] !== false || typeof first?.['text'] !== 'string') {
          resolve(`(not a text answer: ${JSON.stringify(m)})`)
          return
        }
        resolve(first['text'] as string)
      })
    })
    const _meta: Json = { ...(meta ?? {}), ...(threadId === undefined ? {} : { threadId }) }
    write({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'gate', arguments: args, _meta } })
    return { id, answer }
  }

  return {
    input,
    output,
    sent,
    requests,
    late,
    line: (text) => void input.write(`${text}\n`),
    request,
    notify: (method, params) => write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }),
    initialize: (o = {}) => {
      const capabilities: Json =
        o.elicitation !== undefined ? { elicitation: o.elicitation } : o.form === false ? {} : { elicitation: { form: {}, url: {} } }
      return request('initialize', {
        protocolVersion: o.protocolVersion ?? '2025-06-18',
        capabilities,
        clientInfo: { name: 'codex-mcp-client', title: 'Codex', version: '0.157.0' },
      })
    },
    initialized: () => write({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    call,
    gate: async (args, threadId) => {
      const text = await call(args, threadId).answer
      if (text === undefined) throw new Error('the call was dropped')
      if (text.startsWith('(not a text answer')) throw new Error(text)
      return text
    },
    drop: (id) => {
      dropped.add(JSON.stringify(id))
      waiting.delete(JSON.stringify(id))
      gates.get(id)?.(undefined)
      gates.delete(id)
    },
    cancel: (id) => write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'test' } }),
    script: (...answers) => {
      queue.push(...answers)
      for (;;) {
        const req = open.find((r) => !hung.has(r))
        const next = req === undefined ? undefined : queue.shift()
        if (req === undefined || next === undefined) return
        respond(req, next)
      }
    },
    pending: () => [...open],
    answer: (result) => {
      const req = open.shift()
      if (req === undefined) throw new Error('no pending elicitation')
      hung.delete(req)
      if ('error' in result) write({ jsonrpc: '2.0', id: req['id'], error: result.error })
      else write({ jsonrpc: '2.0', id: req['id'], result })
    },
    end: () => void input.end(),
    waitFor: (match) =>
      new Promise<Json>((resolve) => {
        const seen = sent.find(match)
        if (seen !== undefined) resolve(seen)
        else watchers.push({ match, resolve })
      }),
  }
}

/** Lets the streams and the server's promise chains run. */
export const flush = (): Promise<void> => settleTurns(10)
