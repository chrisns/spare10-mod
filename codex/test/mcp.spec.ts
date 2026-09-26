import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { elicitParams, render } from '../../hooks/core/codex.ts'
import { HEADLESS_GENERIC, NOT_STARTED_GENERIC, STOP_GENERIC, VERSION } from '../../hooks/core/text.ts'
import {
  ELICIT_ID_PREFIX,
  formCapable,
  heldRefusal,
  INVALID_PARAMS,
  McpError,
  MCP_PROTOCOL,
  METHOD_NOT_FOUND,
  stdioServer,
  type McpServer,
  type ToolCall,
} from '../src/mcp.ts'
import { fakeClock } from './helpers/clock.ts'
import { codexHost, elicitResult, flush, type CodexHost } from './helpers/codex-host.ts'
import { memoryLog, type MemoryLog } from './helpers/log.ts'

// The stdio MCP server (Codex design 3.4, 8.2 mcp.spec). The Codex double plays rmcp over two in-memory
// streams. Every gate answer is one text item with isError false (gap-2 L3).

type World = { host: CodexHost; server: McpServer; log: MemoryLog; clock: ReturnType<typeof fakeClock> }

function world(o: { closeWorkMs?: number } = {}): World {
  const host = codexHost()
  const log = memoryLog()
  const clock = fakeClock(1_000_000)
  const server = stdioServer(host.input, host.output, { name: 'spare10', version: VERSION }, log, {
    clock,
    ...(o.closeWorkMs === undefined ? {} : { closeWorkMs: o.closeWorkMs }),
  })
  return { host, server, log, clock }
}

/** A promise with its resolve and reject outside. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const TOOL = { site: 'tool', session: 'S', turn: 'U', transcript: null, model: 'm', cwd: '/w', tool: 'exec_command', call: 'c1' }
const PROMPT = { site: 'prompt', session: 'S', turn: 'U', transcript: null, model: 'm', cwd: '/w', prompt: 'hi' }
const STEP = { site: 'step', session: 'S', turn: 'U', transcript: null, model: 'm', cwd: '/w', tool: 'exec_command', call: 'c1' }

test('initialize answers at once, before the start-up work, and the work starts only at initialized', async () => {
  const w = world()
  const events: string[] = []
  // A start-up that stalls (a slow file system): it must delay nothing.
  w.server.onReady(() => {
    events.push('ready')
    void new Promise<never>(() => {})
  })
  w.server.onCall(async () => {
    events.push('call')
    return ''
  })
  const init = await w.host.initialize()
  assert.deepEqual(events, [])
  assert.deepEqual(init, {
    jsonrpc: '2.0',
    id: 1,
    result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'spare10', version: VERSION } },
  })
  w.host.initialized()
  await flush()
  assert.deepEqual(events, ['ready'])
  // A second initialized starts nothing again, and the stalled start-up blocks no request.
  w.host.initialized()
  const list = await w.host.request('tools/list', {})
  assert.deepEqual(events, ['ready'])
  assert.deepEqual(list['result'], { tools: [] })
})

test('initialize: the client protocol version is kept, else 2025-06-18, and no experimental capability', async () => {
  const w = world()
  const a = await w.host.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } })
  assert.equal((a['result'] as Record<string, unknown>)['protocolVersion'], '2025-11-25')
  const b = await w.host.request('initialize', { capabilities: {}, clientInfo: { name: 'x', version: '1' } })
  const r = b['result'] as Record<string, unknown>
  assert.equal(r['protocolVersion'], MCP_PROTOCOL)
  assert.deepEqual(r['capabilities'], { tools: {} })
  assert.equal('experimental' in (r['capabilities'] as object), false)
})

test('tools/list is empty, so the gate stays invisible to the model', async () => {
  const w = world()
  await w.host.initialize()
  const r = await w.host.request('tools/list', {})
  assert.deepEqual(r, { jsonrpc: '2.0', id: 2, result: { tools: [] } })
})

test('an unknown tool is -32602, an unknown method is -32601, and ping answers {}', async () => {
  const w = world()
  await w.host.initialize()
  const tool = await w.host.request('tools/call', { name: 'other', arguments: {} })
  assert.equal((tool['error'] as Record<string, unknown>)['code'], INVALID_PARAMS)
  assert.match(String((tool['error'] as Record<string, unknown>)['message']), /unknown tool/)
  const method = await w.host.request('resources/list', {})
  assert.equal((method['error'] as Record<string, unknown>)['code'], METHOD_NOT_FOUND)
  const ping = await w.host.request('ping')
  assert.deepEqual(ping['result'], {})
})

test('gate calls run at the same time, and each id gets its own answer once', async () => {
  const w = world()
  const d1 = deferred<string>()
  const d2 = deferred<string>()
  const seen: ToolCall[] = []
  w.server.onCall((c) => {
    seen.push(c)
    return seen.length === 1 ? d1.promise : d2.promise
  })
  await w.host.initialize()
  const a = w.host.call(TOOL, 'T1')
  const b = w.host.call(PROMPT, 'T2', { other: 1 })
  await flush()
  assert.equal(seen.length, 2)
  assert.deepEqual(seen[0]?.args, TOOL)
  assert.deepEqual(seen[0]?.meta, { threadId: 'T1' })
  assert.deepEqual(seen[1]?.meta, { other: 1, threadId: 'T2' })
  assert.equal(seen[0]?.name, 'gate')
  d2.resolve('second')
  assert.equal(await b.answer, 'second')
  d1.resolve('first')
  assert.equal(await a.answer, 'first')
  const answers = w.host.sent.filter((m) => m['id'] === a.id || m['id'] === b.id)
  assert.equal(answers.length, 2)
  for (const m of answers) assert.equal((m['result'] as Record<string, unknown>)['isError'], false)
})

test('a gate call with no handler set passes', async () => {
  const w = world()
  await w.host.initialize()
  assert.equal(await w.host.gate(TOOL, 'T1'), '')
})

test('an elicitation round trip: the 2.2 request, and its result', async () => {
  const w = world()
  await w.host.initialize()
  assert.equal(w.server.canElicit(), true)
  const params = elicitParams('Your 10% weekly reserve is reached.')
  const answer = w.server.elicit(params)
  await flush()
  assert.equal(w.host.requests.length, 1)
  const req = w.host.requests[0] as Record<string, unknown>
  assert.equal(req['id'], `${ELICIT_ID_PREFIX}1`)
  assert.equal(req['method'], 'elicitation/create')
  assert.equal(req['jsonrpc'], '2.0')
  assert.deepEqual(req['params'], params)
  w.host.answer(elicitResult('resume'))
  assert.deepEqual(await answer, { action: 'accept', content: { choice: 'resume' } })
  // The ids count up.
  w.host.script('cancel')
  assert.deepEqual(await w.server.elicit(params), { action: 'cancel' })
  assert.equal((w.host.requests[1] as Record<string, unknown>)['id'], `${ELICIT_ID_PREFIX}2`)
})

test('a JSON-RPC error on the elicitation rejects with McpError and its code', async () => {
  const w = world()
  await w.host.initialize()
  w.host.script('error')
  await assert.rejects(w.server.elicit(elicitParams('q')), (e: unknown) => e instanceof McpError && e.code === -32603)
})

test('elicit with no form capability rejects and sends nothing', async () => {
  const w = world()
  await w.host.initialize({ form: false })
  assert.equal(w.server.canElicit(), false)
  await assert.rejects(w.server.elicit(elicitParams('q')), McpError)
  await flush()
  assert.equal(w.host.requests.length, 0)
})

test('formCapable: the 2025-06-18 {} shape and a named form are forms, url alone and none are not', () => {
  assert.equal(formCapable({ elicitation: { form: {}, url: {} } }), true)
  assert.equal(formCapable({ elicitation: { form: {} } }), true)
  assert.equal(formCapable({ elicitation: {} }), true)
  assert.equal(formCapable({ elicitation: { url: {} } }), false)
  assert.equal(formCapable({ elicitation: { form: null } }), false)
  assert.equal(formCapable({}), false)
  assert.equal(formCapable(undefined), false)
  assert.equal(formCapable({ elicitation: true }), false)
})

test('an onCall throw answers a pass when the call does not hold, and never isError', async () => {
  const w = world()
  w.server.onCall(() => {
    throw new Error('boom')
  })
  await w.host.initialize()
  const h = w.host.call(TOOL, 'T1')
  assert.equal(await h.answer, '')
  const m = w.host.sent.find((x) => x['id'] === h.id) as Record<string, unknown>
  assert.deepEqual(m['result'], { content: [{ type: 'text', text: '' }], isError: false })
  assert.ok(w.log.lines.some((l) => l.startsWith('spare10: the gate failed: ') && l.includes('boom')))
})

test('an onCall throw while holding answers the site refusal: prompt, tool, step, and unattended', async () => {
  const w = world()
  w.server.onCall(async (c) => {
    const a = c.args as { site: string; unattended?: boolean }
    c.setHolding(true, a.unattended !== true)
    throw new Error('boom')
  })
  await w.host.initialize()
  assert.equal(await w.host.gate(PROMPT, 'T1'), render('prompt', { kind: 'block', text: NOT_STARTED_GENERIC }))
  assert.equal(await w.host.gate(TOOL, 'T1'), render('tool', { kind: 'deny', text: STOP_GENERIC }))
  assert.equal(await w.host.gate(STEP, 'T1'), render('step', { kind: 'deny', text: STOP_GENERIC }))
  assert.equal(await w.host.gate({ ...TOOL, unattended: true }, 'T1'), render('tool', { kind: 'deny', text: HEADLESS_GENERIC }))
  assert.equal(await w.host.gate({ ...PROMPT, unattended: true }, 'T1'), render('prompt', { kind: 'block', text: HEADLESS_GENERIC }))
  assert.deepEqual(JSON.parse(await w.host.gate(TOOL, 'T1')), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: STOP_GENERIC },
  })
})

test('a gate that answers a non-text answers its fallback', async () => {
  const w = world()
  w.server.onCall(async (c) => {
    c.setHolding(true, true)
    return 42 as unknown as string
  })
  await w.host.initialize()
  assert.equal(await w.host.gate(TOOL, 'T1'), heldRefusal('tool', true))
})

test('heldRefusal: each site', () => {
  assert.equal(heldRefusal('prompt', true), JSON.stringify({ decision: 'block', reason: NOT_STARTED_GENERIC }))
  assert.equal(
    heldRefusal('step', false),
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: HEADLESS_GENERIC } }),
  )
  assert.equal(heldRefusal('stop', true), JSON.stringify({ continue: false }))
  assert.equal(heldRefusal('compact', true), JSON.stringify({ continue: false }))
  for (const site of ['start', 'spawn', 'interrupt', 'bogus', undefined]) assert.equal(heldRefusal(site, true), '')
})

test('stdin EOF: the onClose work first, then each held call gets its refusal and the others a pass, once', async () => {
  const w = world()
  const order: string[] = []
  const held = deferred<string>()
  const free = deferred<string>()
  w.server.onCall((c) => {
    if ((c.args as { site: string }).site === 'tool') {
      c.setHolding(true, true)
      return held.promise
    }
    return free.promise
  })
  w.server.onClose(async () => {
    order.push(`close work, ${w.server.openCalls().length} open`)
  })
  await w.host.initialize()
  const a = w.host.call(TOOL, 'T1')
  const b = w.host.call(PROMPT, 'T1')
  await flush()
  assert.equal(w.server.openCalls().length, 2)
  w.host.end()
  const ta = await a.answer
  const tb = await b.answer
  order.push('answered')
  assert.deepEqual(order, ['close work, 2 open', 'answered'])
  assert.equal(ta, render('tool', { kind: 'deny', text: STOP_GENERIC }))
  assert.equal(tb, '')
  assert.equal(w.server.closed(), true)
  await w.server.close()
  // The handlers end later: no second answer.
  held.resolve('')
  free.resolve('late')
  await flush()
  assert.equal(w.host.sent.filter((m) => m['id'] === a.id).length, 1)
  assert.equal(w.host.sent.filter((m) => m['id'] === b.id).length, 1)
  assert.ok(w.log.lines.includes('spare10: the MCP server shuts down (stdin closed), with 2 open call(s).'))
})

test('shutdown: a held call that the gate passes during the close work still gets its refusal', async () => {
  const w = world()
  const held = deferred<string>()
  w.server.onCall((c) => {
    c.setHolding(true, true)
    return held.promise
  })
  w.server.onClose(async () => {
    held.resolve('')
    await flush()
  })
  await w.host.initialize()
  const a = w.host.call(STEP, 'T1')
  await flush()
  await w.server.close()
  assert.equal(await a.answer, render('step', { kind: 'deny', text: STOP_GENERIC }))
})

test('shutdown: a gate answer decided during the close work is kept when it is not a pass', async () => {
  const w = world()
  const held = deferred<string>()
  const decided = render('tool', { kind: 'deny', text: 'spare10: decided.' })
  w.server.onCall((c) => {
    c.setHolding(true, true)
    return held.promise
  })
  w.server.onClose(async () => {
    held.resolve(decided)
    await flush()
  })
  await w.host.initialize()
  const a = w.host.call(TOOL, 'T1')
  await flush()
  await w.server.close()
  assert.equal(await a.answer, decided)
})

test('shutdown: close work that hangs is cut after closeWorkMs, then the calls are answered', async () => {
  const w = world({ closeWorkMs: 1_000 })
  w.server.onCall((c) => {
    c.setHolding(true, false)
    return new Promise<string>(() => {})
  })
  w.server.onClose(() => new Promise<void>(() => {}))
  await w.host.initialize()
  const a = w.host.call(TOOL, 'T1')
  await flush()
  let done = false
  const closing = w.server.close().then(() => (done = true))
  await w.clock.advance(999)
  assert.equal(done, false)
  await w.clock.advance(1)
  await closing
  assert.equal(await a.answer, render('tool', { kind: 'deny', text: HEADLESS_GENERIC }))
})

test('close is idempotent, a new gate call after it passes, and a pending elicitation rejects', async () => {
  const w = world()
  await w.host.initialize()
  const e = w.server.elicit(elicitParams('q'))
  await flush()
  const c1 = w.server.close()
  const c2 = w.server.close()
  assert.equal(c1, c2)
  await c1
  await assert.rejects(e, McpError)
  await assert.rejects(w.server.elicit(elicitParams('q')), McpError)
  // The server still reads after a close (a SIGTERM): a late gate call passes at once, with no handler run.
  let called = false
  w.server.onCall(async () => {
    called = true
    return 'x'
  })
  assert.equal(await w.host.call(TOOL, 'T1').answer, '')
  assert.equal(called, false)
  assert.deepEqual((await w.host.request('ping'))['result'], {})
})

test('notifications/cancelled: onCancelled runs, and the call gets no answer', async () => {
  const w = world()
  const held = deferred<string>()
  const cancelled: Array<string | number> = []
  w.server.onCall(() => held.promise)
  w.server.onCancelled((id) => cancelled.push(id))
  await w.host.initialize()
  const a = w.host.call(TOOL, 'T1')
  await flush()
  w.host.cancel(a.id)
  // A cancel of an unknown id does nothing.
  w.host.cancel(999)
  await flush()
  assert.deepEqual(cancelled, [a.id])
  assert.equal(w.server.openCalls().length, 0)
  held.resolve('late')
  await flush()
  assert.equal(w.host.sent.filter((m) => m['id'] === a.id).length, 0)
  assert.ok(w.log.lines.includes(`spare10: Codex cancelled the call ${a.id}.`))
})

test('a call that Codex dropped gets its late answer, and the server keeps serving', async () => {
  const w = world()
  const held = deferred<string>()
  w.server.onCall((c) => ((c.args as { site: string }).site === 'tool' ? held.promise : Promise.resolve('next')))
  await w.host.initialize()
  const a = w.host.call(TOOL, 'T1')
  await flush()
  w.host.drop(a.id)
  assert.equal(await a.answer, undefined)
  held.resolve('late')
  await flush()
  assert.equal(w.host.late.length, 1)
  assert.equal(await w.host.gate(PROMPT, 'T1'), 'next')
})

test('a line that is not JSON-RPC is ignored with a debug line, and the server keeps serving', async () => {
  const w = world()
  w.host.line('{not json')
  w.host.line('[1, 2]')
  w.host.line('   ')
  const r = await w.host.initialize()
  assert.ok(r['result'] !== undefined)
  assert.ok(w.log.lines.some((l) => l.startsWith('spare10: an MCP input line was ignored: ')))
})

test('a line split across two chunks, and CRLF line ends, are read whole', async () => {
  const w = world()
  const init = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { capabilities: {} } })
  w.host.input.write(init.slice(0, 10))
  await flush()
  w.host.input.write(`${init.slice(10)}\r\n`)
  const m = await w.host.waitFor((x) => x['id'] === 7)
  assert.ok(m['result'] !== undefined)
})

test('a response to an unknown id and an unknown notification are ignored', async () => {
  const w = world()
  await w.host.initialize()
  w.host.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 's10-e-99', result: {} })}\n`)
  w.host.notify('notifications/progress', { progressToken: 1, progress: 1 })
  const r = await w.host.request('ping')
  assert.deepEqual(r['result'], {})
})

test('a failed output shuts the server down with no throw', async () => {
  const host = codexHost()
  const log = memoryLog()
  const broken = new Writable({
    write(_chunk, _enc, cb) {
      cb(new Error('EPIPE'))
    },
  })
  const server = stdioServer(host.input, broken, { name: 'spare10', version: VERSION }, log, { clock: fakeClock(0) })
  let closeRan = false
  server.onClose(async () => {
    closeRan = true
  })
  host.line(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }))
  await flush()
  await server.close()
  assert.equal(closeRan, true)
  assert.ok(log.lines.some((l) => l.startsWith('spare10: the MCP output failed: ')))
})
