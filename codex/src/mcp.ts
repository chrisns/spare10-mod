import type { Readable, Writable } from 'node:stream'
import { codexDebug, render } from '../../hooks/core/codex.ts'
import { HEADLESS_GENERIC, NOT_STARTED_GENERIC, STOP_GENERIC } from '../../hooks/core/text.ts'
import { realClock, type Clock } from './clock.ts'
import type { Log } from './log.ts'

// The stdio MCP server of the broker (Codex design 3.4). One JSON-RPC 2.0 message per line (the rmcp stdio
// transport). It answers `initialize` at once, with no file or network work first (gap-2 L1). It lists no
// tools (gap-2 L2). It runs each `gate` call at the same time as the others, and answers each id once. It
// sends the question form (`elicitation/create`, 2.2) and matches the answer by id. It never answers with
// `isError` and never lets an exception reach the transport (gap-2 L3): a handler that throws answers the
// call's fallback, which is the site's refusal while the call holds, else "" (a pass).

/** The protocol version when the client names none. Codex 0.157 sends this one. */
export const MCP_PROTOCOL = '2025-06-18'

/** The id prefix of the elicitation requests that the broker sends (2.2). */
export const ELICIT_ID_PREFIX = 's10-e-'

/** The one tool: the hook handlers of codex/hooks.json call it. */
export const GATE_TOOL = 'gate'

/** JSON-RPC error codes (3.4). The messages are protocol strings for Codex, not texts that a person reads. */
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602

/** The longest wait of the shutdown for the onClose work, before it answers the open calls (3.4: at most 1 s). */
export const CLOSE_WORK_MS = 1_000

export type Id = string | number

/** One `tools/call`. `holding` and `fallback` follow `setHolding`, which the gate calls (4.2, `ctx.holding`). */
export type ToolCall = {
  readonly id: Id
  readonly name: string
  readonly args: unknown
  readonly meta: Record<string, unknown>
  /** True while the gate holds this call: the actuator fails closed. */
  holding(): boolean
  /** The answer when the handler throws, or at shutdown: the site's refusal while holding, else "". */
  fallback(): string
  /** The gate marks the call held (true) or no longer held. `attended` picks the generic refusal text. */
  setHolding(on: boolean, attended?: boolean): void
}

export type McpServer = {
  /** The handler of each `gate` call. The last one set wins. With none, a call answers "". */
  onCall(fn: (c: ToolCall) => Promise<string>): void
  /** Runs once, at `notifications/initialized`: the broker starts its background work there. */
  onReady(fn: () => void): void
  /** Runs at `notifications/cancelled` for an open call. The call then gets no answer (MCP). */
  onCancelled(fn: (id: Id) => void): void
  /** Runs at the start of the shutdown, before the open calls get their fallback (at most CLOSE_WORK_MS). */
  onClose(fn: () => Promise<void>): void
  /** True when the client can show a form: `capabilities.elicitation` names `form`, or is `{}` (MCP 2025-06-18). */
  canElicit(): boolean
  /** Sends `elicitation/create` and resolves with its result. It rejects with McpError on an error reply, with no form, or at shutdown. */
  elicit(params: object): Promise<unknown>
  /** The calls that have no answer yet, in arrival order. */
  openCalls(): ToolCall[]
  /** True once the shutdown started. */
  closed(): boolean
  /** Shuts down: the onClose work, then every open call gets its fallback, then the output is flushed. Idempotent. */
  close(): Promise<void>
}

/** An elicitation that failed: an error reply (`code`), no form, or the shutdown. */
export class McpError extends Error {
  readonly code: number | undefined
  constructor(message: string, code?: number) {
    super(message)
    this.name = 'McpError'
    this.code = code
  }
}

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isId = (v: unknown): v is Id => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
const keyOf = (id: Id): string => `${typeof id}:${String(id)}`

/**
 * The refusal of a held call that has no decided answer (3.4, 4.2): a prompt is blocked with
 * NOT_STARTED_GENERIC, a tool is denied and a step gets the text as context with STOP_GENERIC. Unattended,
 * the text is HEADLESS_GENERIC. Stop and PreCompact end the turn. The other sites cannot refuse, so "".
 */
export function heldRefusal(site: unknown, attended: boolean): string {
  switch (site) {
    case 'prompt':
      return render('prompt', { kind: 'block', text: attended ? NOT_STARTED_GENERIC : HEADLESS_GENERIC })
    case 'tool':
    case 'step':
      return render(site, { kind: 'deny', text: attended ? STOP_GENERIC : HEADLESS_GENERIC })
    case 'stop':
    case 'compact':
      return render(site, { kind: 'end' })
    default:
      return ''
  }
}

/**
 * MCP 2025-06-18: a client that can show forms declares `elicitation: {}`. Later versions name the modes,
 * and `{}` still means form only. Codex 0.157 sends `{"form": {}, "url": {}}`, or `{}` with the
 * `auth_elicitation` feature off (`core/src/config/mod.rs` L1842-1851).
 */
export function formCapable(caps: unknown): boolean {
  if (!isObject(caps)) return false
  const e = caps['elicitation']
  if (!isObject(e)) return false
  if ('form' in e) return isObject(e['form'])
  return !('url' in e)
}

/**
 * The server on `input` (the broker's stdin) and `output` (its stdout). `o.clock` bounds the onClose work of
 * the shutdown (default: the real clock).
 */
export function stdioServer(
  input: Readable,
  output: Writable,
  info: { name: string; version: string },
  log: Log,
  o: { clock?: Clock; closeWorkMs?: number } = {},
): McpServer {
  const clock = o.clock ?? realClock
  const closeWorkMs = o.closeWorkMs ?? CLOSE_WORK_MS
  let handler: ((c: ToolCall) => Promise<string>) | undefined
  const readyFns: Array<() => void> = []
  const cancelFns: Array<(id: Id) => void> = []
  const closeFns: Array<() => Promise<void>> = []
  const open = new Map<string, ToolCall>()
  const elicits = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  let clientCaps: unknown
  let ready = false
  let elicitN = 0
  let buffer = ''
  let outputOk = true
  let closing: Promise<void> | undefined

  const write = (msg: Json): void => {
    if (!outputOk) return
    let line: string
    try {
      line = `${JSON.stringify(msg)}\n`
    } catch (err) {
      log.debug(codexDebug.mcpBadOut(String(err)))
      return
    }
    try {
      output.write(line)
    } catch (err) {
      outputFailed(err)
    }
  }
  const reply = (id: Id, result: unknown): void => write({ jsonrpc: '2.0', id, result })
  const replyError = (id: Id, code: number, message: string): void => write({ jsonrpc: '2.0', id, error: { code, message } })
  const answerText = (id: Id, text: string): void =>
    reply(id, { content: [{ type: 'text', text }], isError: false })

  /**
   * Each id is answered once: an answer after the shutdown fallback or after a cancel is dropped. Once the
   * shutdown started, a held call never answers a pass (3.4): it gets its fallback instead.
   */
  const answerCall = (call: ToolCall, text: string): void => {
    const k = keyOf(call.id)
    if (open.get(k) !== call) return
    open.delete(k)
    answerText(call.id, closing !== undefined && call.holding() && text === '' ? call.fallback() : text)
  }

  const makeCall = (id: Id, name: string, args: unknown, meta: Record<string, unknown>): ToolCall => {
    let held = false
    let attended = true
    const site = isObject(args) ? args['site'] : undefined
    return {
      id,
      name,
      args,
      meta,
      holding: () => held,
      fallback: () => (held ? heldRefusal(site, attended) : ''),
      setHolding(on, isAttended) {
        held = on
        if (isAttended !== undefined) attended = isAttended
      },
    }
  }

  const runCall = (call: ToolCall): void => {
    open.set(keyOf(call.id), call)
    const fn = handler
    let p: Promise<string>
    try {
      p = fn === undefined ? Promise.resolve('') : Promise.resolve(fn(call))
    } catch (err) {
      p = Promise.reject(err)
    }
    p.then(
      (text) => {
        if (typeof text === 'string') return text
        log.debug(codexDebug.gateError(`the gate answered ${typeof text}, not a text`))
        return call.fallback()
      },
      (err: unknown) => {
        log.debug(codexDebug.gateError(err instanceof Error ? (err.stack ?? err.message) : String(err)))
        return call.fallback()
      },
    )
      .then((text) => answerCall(call, text))
      .catch((err: unknown) => log.debug(codexDebug.gateError(String(err))))
  }

  const onRequest = (id: Id, method: string, params: unknown): void => {
    const p = isObject(params) ? params : {}
    switch (method) {
      case 'initialize': {
        clientCaps = p['capabilities']
        const version = typeof p['protocolVersion'] === 'string' && p['protocolVersion'] !== '' ? p['protocolVersion'] : MCP_PROTOCOL
        reply(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: info.name, version: info.version } })
        return
      }
      case 'ping':
        reply(id, {})
        return
      case 'tools/list':
        reply(id, { tools: [] })
        return
      case 'tools/call': {
        const name = p['name']
        if (name !== GATE_TOOL) {
          replyError(id, INVALID_PARAMS, `unknown tool: ${typeof name === 'string' ? name : String(name)}`)
          return
        }
        if (closing !== undefined) {
          // The broker shuts down. A new gate passes, as it would with no broker (the sensor fails open).
          answerText(id, '')
          return
        }
        const meta = isObject(p['_meta']) ? p['_meta'] : {}
        runCall(makeCall(id, GATE_TOOL, p['arguments'], meta))
        return
      }
      default:
        replyError(id, METHOD_NOT_FOUND, `method not found: ${method}`)
    }
  }

  const onNotification = (method: string, params: unknown): void => {
    if (method === 'notifications/initialized') {
      if (ready) return
      ready = true
      for (const fn of readyFns) {
        try {
          fn()
        } catch (err) {
          log.debug(codexDebug.gateError(String(err)))
        }
      }
      return
    }
    if (method === 'notifications/cancelled') {
      const id = isObject(params) ? params['requestId'] : undefined
      if (!isId(id)) return
      const k = keyOf(id)
      if (!open.has(k)) return
      open.delete(k)
      log.debug(codexDebug.cancelled(String(id)))
      for (const fn of cancelFns) {
        try {
          fn(id)
        } catch (err) {
          log.debug(codexDebug.gateError(String(err)))
        }
      }
    }
    // Every other notification is ignored.
  }

  const onResponse = (id: Id, m: Json): void => {
    if (typeof id !== 'string') return
    const e = elicits.get(id)
    if (e === undefined) return
    elicits.delete(id)
    if (isObject(m['error'])) {
      const code = typeof m['error']['code'] === 'number' ? m['error']['code'] : undefined
      const message = typeof m['error']['message'] === 'string' ? m['error']['message'] : 'error reply'
      e.reject(new McpError(message, code))
    } else e.resolve(m['result'])
  }

  const onMessage = (m: unknown): void => {
    if (!isObject(m)) {
      log.debug(codexDebug.mcpBadLine('not an object'))
      return
    }
    const method = m['method']
    const id = m['id']
    if (typeof method === 'string') {
      if (isId(id)) onRequest(id, method, m['params'])
      else onNotification(method, m['params'])
      return
    }
    if (isId(id) && ('result' in m || 'error' in m)) onResponse(id, m)
  }

  const onLine = (line: string): void => {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line
    if (text.trim() === '') return
    let m: unknown
    try {
      m = JSON.parse(text)
    } catch (err) {
      log.debug(codexDebug.mcpBadLine(String(err)))
      return
    }
    try {
      if (Array.isArray(m)) for (const one of m) onMessage(one)
      else onMessage(m)
    } catch (err) {
      log.debug(codexDebug.gateError(String(err)))
    }
  }

  const onData = (chunk: string | Buffer): void => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    for (;;) {
      const at = buffer.indexOf('\n')
      if (at < 0) return
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      onLine(line)
    }
  }

  const onEnd = (): void => {
    if (buffer.trim() !== '') onLine(buffer)
    buffer = ''
    void close('stdin closed')
  }

  function outputFailed(err: unknown): void {
    if (!outputOk) return
    outputOk = false
    log.debug(codexDebug.mcpOutputFailed(String(err)))
    void close('stdout failed')
  }

  /** Waits for `p`, at most `ms` on the clock. */
  const bounded = async (p: Promise<unknown>, ms: number): Promise<void> => {
    let timer: { cancel(): void } | undefined
    const late = new Promise<void>((resolve) => {
      timer = clock.after(ms, resolve)
    })
    try {
      await Promise.race([p.then(() => undefined, () => undefined), late])
    } finally {
      timer?.cancel()
    }
  }

  const flush = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (!outputOk) {
        resolve()
        return
      }
      try {
        output.write('', () => resolve())
      } catch {
        resolve()
      }
    })

  function close(why = 'close'): Promise<void> {
    if (closing !== undefined) return closing
    // The input stays read: after a SIGTERM, a new gate call still gets its pass, and a ping its answer.
    closing = (async () => {
      log.debug(codexDebug.mcpClosed(why, open.size))
      await bounded(
        Promise.allSettled(
          closeFns.map(async (fn) => {
            await fn()
          }),
        ),
        closeWorkMs,
      )
      for (const call of [...open.values()]) answerCall(call, call.fallback())
      for (const [id, e] of [...elicits]) {
        elicits.delete(id)
        e.reject(new McpError('the MCP server shut down'))
      }
      await flush()
    })()
    return closing
  }

  input.setEncoding?.('utf8')
  input.on('data', onData)
  input.on('end', onEnd)
  input.on('close', onEnd)
  input.on('error', (err: unknown) => {
    log.debug(codexDebug.mcpBadLine(`stdin: ${String(err)}`))
    onEnd()
  })
  output.on('error', outputFailed)

  return {
    onCall(fn) {
      handler = fn
    },
    onReady(fn) {
      readyFns.push(fn)
    },
    onCancelled(fn) {
      cancelFns.push(fn)
    },
    onClose(fn) {
      closeFns.push(fn)
    },
    canElicit: () => formCapable(clientCaps),
    elicit(params) {
      if (closing !== undefined) return Promise.reject(new McpError('the MCP server shut down'))
      if (!formCapable(clientCaps)) return Promise.reject(new McpError('the client cannot show a form'))
      elicitN += 1
      const id = `${ELICIT_ID_PREFIX}${elicitN}`
      return new Promise<unknown>((resolve, reject) => {
        elicits.set(id, { resolve, reject })
        write({ jsonrpc: '2.0', id, method: 'elicitation/create', params })
        if (!outputOk && elicits.delete(id)) reject(new McpError('stdout failed'))
      })
    },
    openCalls: () => [...open.values()],
    closed: () => closing !== undefined,
    close: () => close(),
  }
}
