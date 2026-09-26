import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { codexDebug } from '../../hooks/core/codex.ts'
import { VERSION } from '../../hooks/core/text.ts'
import { realClock } from '../src/clock.ts'
import {
  acceptOf,
  DAEMON_CLIENT_NAME,
  daemonLink,
  DaemonError,
  encodeFrame,
  FrameReader,
  MessageJoiner,
  OP,
  socketAt,
  udsDaemon,
  type Daemon,
} from '../src/daemon.ts'
import { DAEMON_CONNECT_MS, HOSTED_MISS_TTL_MS, HOSTED_TTL_MS, LOADED_MS, THREAD_READ_MS } from '../src/timing.ts'
import { fakeClock } from './helpers/clock.ts'
import { memoryLog } from './helpers/log.ts'
import { memoryDaemon } from './helpers/memory-daemon.ts'
import { tempDir } from './helpers/tmp.ts'
import { DROP, fakeDaemon, HANG, RpcFail, type FakeDaemon } from './helpers/uds-daemon.ts'

// The daemon client (Codex design 3.5, 8.2 daemon.spec) against the WebSocket-over-UDS fake, on the real clock
// (the timeout cases drive a fake clock while the socket runs for real).

type Json = Record<string, unknown>

const client = (fake: FakeDaemon, clock = realClock, o: { maxMessage?: number; connectMs?: number } = {}): Daemon => {
  const d = udsDaemon({ socket: fake.alias }, VERSION, clock, o)
  assert.ok(d !== undefined, 'the fake socket exists')
  return d
}

const isDaemonError = (kind: string) => (e: unknown): boolean => e instanceof DaemonError && e.kind === kind

/** The text messages of one connection, without their ids. */
const shapeOf = (m: Json): string => `${String(m['method'] ?? 'reply')}${m['id'] === undefined ? '' : ' (request)'}`

test('the handshake: GET / with the upgrade headers, a 16-byte key, and the accept check', async (t) => {
  const fake = await fakeDaemon(t)
  const d = client(fake)
  await d.loaded()
  const c = fake.conns[0]
  assert.ok(c !== undefined)
  assert.equal(c.path, '/')
  assert.equal(c.headers['host'], 'localhost')
  assert.equal(c.headers['upgrade'], 'websocket')
  assert.equal(c.headers['connection'], 'Upgrade')
  assert.equal(c.headers['sec-websocket-version'], '13')
  assert.equal(Buffer.from(c.headers['sec-websocket-key'] ?? '', 'base64').length, 16)
  assert.equal(acceptOf('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

test('a bad Sec-WebSocket-Accept, and a refused handshake, reject as protocol errors', async (t) => {
  const bad = await fakeDaemon(t, { accept: () => 'nope' })
  await assert.rejects(client(bad).loaded(), isDaemonError('protocol'))
  const refused = await fakeDaemon(t, { refuseStatus: 403 })
  await assert.rejects(client(refused).loaded(), isDaemonError('protocol'))
})

test('a long alias path works: the client connects to its short real path', async (t) => {
  const home = join(tempDir(t), 'a-rather-long-codex-home-folder-name-for-the-alias', 'and-one-more-level-of-folders')
  const fake = await fakeDaemon(t, { codexHome: home })
  assert.ok(Buffer.byteLength(fake.alias) > 104, `the alias has ${Buffer.byteLength(fake.alias)} bytes`)
  assert.deepEqual(await client(fake).loaded(), [])
})

test('the client name codex_app_server_daemon, then initialized, then the call, and every frame masked', async (t) => {
  const fake = await fakeDaemon(t)
  await client(fake).status('T1').catch(() => undefined)
  const c = fake.conns[0]
  assert.ok(c !== undefined)
  assert.deepEqual(c.received[0], {
    id: 1,
    method: 'initialize',
    params: { clientInfo: { name: DAEMON_CLIENT_NAME, title: 'spare10', version: VERSION }, capabilities: {} },
  })
  assert.deepEqual(c.received[1], { method: 'initialized' })
  assert.deepEqual(c.received[2], { id: 2, method: 'thread/read', params: { threadId: 'T1' } })
  assert.ok(c.frames.length >= 3)
  for (const f of c.frames) assert.equal(f.masked, true)
  // No jsonrpc field, as the probed client (3.5).
  for (const m of c.received) assert.equal('jsonrpc' in m, false)
})

test('one connection per call: each call opens its own, and closes it with a close frame after the reply', async (t) => {
  const fake = await fakeDaemon(t)
  const d = client(fake)
  await d.loaded()
  await d.loaded()
  await fake.closedConns(2)
  assert.equal(fake.conns.length, 2)
  for (const c of fake.conns) {
    assert.equal(c.clientClosed, true)
    assert.equal(c.closed, true)
    assert.deepEqual(c.received.map(shapeOf), ['initialize (request)', 'initialized', 'thread/loaded/list (request)'])
    assert.equal(c.path, '/')
  }
})

test('unasked pushes and a server request are ignored, and the request is never answered', async (t) => {
  const fake = await fakeDaemon(t, {
    pushes: true,
    handlers: { 'thread/loaded/list': () => ({ data: ['T1', 'T2'], nextCursor: null }) },
  })
  assert.deepEqual(await client(fake).loaded(), ['T1', 'T2'])
  await fake.closedConns(1)
  const c = fake.conns[0]
  assert.ok(c !== undefined)
  assert.equal(c.received.some((m) => m['id'] === 99), false)
  assert.deepEqual(c.received.map(shapeOf), ['initialize (request)', 'initialized', 'thread/loaded/list (request)'])
})

test('fragmented replies with a ping between the fragments: the reply is whole, and each ping gets its pong', async (t) => {
  const fake = await fakeDaemon(t, {
    fragmentBytes: 7,
    pingFirst: true,
    handlers: { 'thread/read': () => ({ thread: { id: 'T1', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } } }) },
  })
  assert.equal(await client(fake).status('T1'), 'active')
  const c = fake.conns[0]
  assert.ok(c !== undefined)
  assert.ok(c.pongs.includes('hb'))
  assert.ok(c.pongs.includes('mid'))
  for (const f of c.frames) assert.equal(f.masked, true)
})

test('7-bit, 16-bit and 64-bit lengths in, masked server frames, and an unasked pong', async (t) => {
  for (const size of [10, 1_000, 100_000]) {
    const fake = await fakeDaemon(t, { maskOut: true, pongFirst: true, handlers: { 'hooks/list': () => ({ blob: 'z'.repeat(size) }) } })
    const r = (await client(fake).hooksList('/w')) as Json
    assert.equal(String(r['blob']).length, size)
  }
})

test('a reply over 16 MiB is read', async (t) => {
  const size = 17 * 1024 * 1024
  const fake = await fakeDaemon(t, { handlers: { 'account/rateLimits/read': () => ({ blob: 'q'.repeat(size) }) } })
  const r = (await client(fake).rateLimits()) as Json
  assert.equal(String(r['blob']).length, size)
})

test('a reply over the size cap closes the connection with a protocol error', async (t) => {
  const fake = await fakeDaemon(t, { handlers: { 'hooks/list': () => ({ blob: 'z'.repeat(4_096) }) } })
  await assert.rejects(client(fake, realClock, { maxMessage: 1_024 }).hooksList('/w'), isDaemonError('protocol'))
  const frag = await fakeDaemon(t, { fragmentBytes: 300, handlers: { 'hooks/list': () => ({ blob: 'z'.repeat(4_096) }) } })
  await assert.rejects(client(frag, realClock, { maxMessage: 1_024 }).hooksList('/w'), isDaemonError('protocol'))
})

test('account/rateLimits/read: its params, and its result as it came', async (t) => {
  const result = {
    rateLimits: { limitId: 'codex', primary: { usedPercent: 97, windowDurationMins: 10080, resetsAt: 1790693559 }, secondary: null },
    rateLimitsByLimitId: null,
    ordinaryUsageAllowed: true,
  }
  const fake = await fakeDaemon(t, { handlers: { 'account/rateLimits/read': () => result } })
  assert.deepEqual(await client(fake).rateLimits(), result)
  assert.deepEqual(fake.calls, [{ method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } }])
})

test('an error reply rejects with its message and code', async (t) => {
  const fake = await fakeDaemon(t, {
    handlers: {
      'account/rateLimits/read': () => {
        throw new RpcFail(-32600, 'codex account authentication required to read rate limits')
      },
    },
  })
  await assert.rejects(
    client(fake).rateLimits(),
    (e: unknown) => e instanceof DaemonError && e.kind === 'rpc' && e.code === -32600 && /authentication required/.test(e.message),
  )
})

test('thread/loaded/list gives the ids, and follows a next cursor', async (t) => {
  const pages: Record<string, Json> = {
    first: { data: ['T1', 'T2'], nextCursor: 'c2' },
    c2: { data: ['T3', 7], nextCursor: null },
  }
  const fake = await fakeDaemon(t, {
    handlers: { 'thread/loaded/list': (p) => pages[String((p as Json)['cursor'] ?? 'first')] },
  })
  assert.deepEqual(await client(fake).loaded(), ['T1', 'T2', 'T3'])
  assert.deepEqual(
    fake.calls.map((c) => c.params),
    [{}, { cursor: 'c2' }],
  )
  assert.equal(fake.conns.length, 1)
})

test('thread/read unwraps result.thread.status.type, and a reply with no status rejects', async (t) => {
  const fake = await fakeDaemon(t, {
    handlers: {
      'thread/read': (p) =>
        (p as Json)['threadId'] === 'T1' ? { thread: { id: 'T1', status: { type: 'idle' } } } : { thread: { id: 'T2' } },
    },
  })
  const d = client(fake)
  assert.equal(await d.status('T1'), 'idle')
  await assert.rejects(d.status('T2'), isDaemonError('reply'))
  assert.deepEqual(fake.calls[0], { method: 'thread/read', params: { threadId: 'T1' } })
})

test('thread/turns/list: its params, the newest turn, none, and a turn with no start time', async (t) => {
  const turns: Record<string, Json> = {
    T1: { data: [{ id: 'U1', items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: 1790000000 }] },
    T2: { data: [], nextCursor: null },
    T3: { data: [{ id: 'U3', status: 'interrupted', startedAt: null }] },
  }
  const fake = await fakeDaemon(t, { handlers: { 'thread/turns/list': (p) => turns[String((p as Json)['threadId'])] } })
  const d = client(fake)
  assert.deepEqual(await d.newestTurn('T1'), { id: 'U1', status: 'inProgress', startedAt: 1790000000 })
  assert.equal(await d.newestTurn('T2'), undefined)
  assert.deepEqual(await d.newestTurn('T3'), { id: 'U3', status: 'interrupted', startedAt: null })
  assert.deepEqual(fake.calls[0], { method: 'thread/turns/list', params: { threadId: 'T1', limit: 1, itemsView: 'notLoaded' } })
})

test('thread/turns/list of a thread with no user message yet is no turn, and another error still rejects', async (t) => {
  const fake = await fakeDaemon(t, {
    handlers: {
      'thread/turns/list': (p) => {
        if ((p as Json)['threadId'] === 'T-NEW') {
          throw new RpcFail(-32600, 'thread T-NEW is not materialized yet; thread/turns/list is unavailable before first user message')
        }
        throw new RpcFail(-32600, 'thread not loaded: T-GONE')
      },
    },
  })
  const d = client(fake)
  assert.equal(await d.newestTurn('T-NEW'), undefined)
  await assert.rejects(d.newestTurn('T-GONE'), isDaemonError('rpc'))
})

test('turn/interrupt and turn/start: their params, and the new turn id', async (t) => {
  const fake = await fakeDaemon(t, {
    handlers: {
      'turn/interrupt': () => ({}),
      'turn/start': () => ({ turn: { id: 'U-NEW', items: [], status: 'inProgress', error: null } }),
    },
  })
  const d = client(fake)
  assert.equal(await d.interrupt('T1', 'U1'), undefined)
  assert.equal(await d.start('T1', 'spare10: continue.'), 'U-NEW')
  assert.deepEqual(fake.calls, [
    { method: 'turn/interrupt', params: { threadId: 'T1', turnId: 'U1' } },
    { method: 'turn/start', params: { threadId: 'T1', input: [{ type: 'text', text: 'spare10: continue.', text_elements: [] }] } },
  ])
})

test('a call past its timeout rejects as a timeout and closes its connection', async (t) => {
  const fake = await fakeDaemon(t, { handlers: { 'thread/read': () => HANG } })
  const clock = fakeClock(0)
  const p = client(fake, clock).status('T1')
  const failed = assert.rejects(p, isDaemonError('timeout'))
  await fake.arrived('thread/read')
  await clock.advance(THREAD_READ_MS - 1)
  assert.equal(fake.conns[0]?.closed, false)
  await clock.advance(1)
  await failed
  await fake.closedConns(1)
})

test('the timeout of thread/loaded/list is its own', async (t) => {
  const fake = await fakeDaemon(t, { handlers: { 'thread/loaded/list': () => HANG } })
  const clock = fakeClock(0)
  const failed = assert.rejects(client(fake, clock).loaded(), isDaemonError('timeout'))
  await fake.arrived('thread/loaded/list')
  await clock.advance(LOADED_MS)
  await failed
})

test('a handshake with no answer rejects after the connect timeout', async (t) => {
  const fake = await fakeDaemon(t, { silent: true })
  const clock = fakeClock(0)
  const failed = assert.rejects(client(fake, clock).loaded(), isDaemonError('connect'))
  while (fake.conns.length === 0) await new Promise<void>((resolve) => setImmediate(resolve))
  await clock.advance(DAEMON_CONNECT_MS)
  await failed
})

test('a socket that closes before the reply rejects the call', async (t) => {
  const fake = await fakeDaemon(t, { handlers: { 'turn/interrupt': () => DROP } })
  await assert.rejects(client(fake).interrupt('T1', 'U1'), isDaemonError('closed'))
})

test('no socket file means no daemon, and a dangling alias too', (t) => {
  const home = tempDir(t)
  assert.equal(udsDaemon({ socket: join(home, 'app-server-control', 'app-server-control.sock') }, VERSION, realClock), undefined)
  mkdirSync(join(home, 'app-server-control'))
  symlinkSync(join(home, 'gone.sock'), join(home, 'app-server-control', 'app-server-control.sock'))
  assert.equal(udsDaemon({ socket: join(home, 'app-server-control', 'app-server-control.sock') }, VERSION, realClock), undefined)
})

test('a call on a socket that went away rejects as a connect error', async (t) => {
  const fake = await fakeDaemon(t)
  const d = client(fake)
  await fake.close()
  await assert.rejects(d.loaded(), isDaemonError('connect'))
})

test('the socket trust check: the fake passes, and the real layout of this user passes', async (t) => {
  const fake = await fakeDaemon(t)
  const uid = process.getuid?.()
  assert.deepEqual(socketAt(fake.alias, uid), { real: realpathSync(fake.real) })
  assert.ok('missing' in socketAt(join(dirname(fake.real), 'gone.sock'), uid), 'no socket is missing, not unsafe')
})

test('the socket trust check: a folder that every user can write to, another owner, or no socket is no daemon, with a reason', async (t) => {
  const uid = process.getuid?.()
  if (uid === undefined) return t.skip('no POSIX uids')
  const fake = await fakeDaemon(t, { handlers: { 'account/rateLimits/read': () => ({ rateLimits: { usedPercent: 0 } }) } })
  const unsafe = (re: RegExp) => (e: unknown): boolean => isDaemonError('connect')(e) && /is not safe to dial/.test(String(e)) && re.test(String(e))
  // Another user as the owner of the socket and its folder (the uid seam).
  assert.throws(() => udsDaemon({ socket: fake.alias }, VERSION, realClock, { uid: uid + 1 }), unsafe(/the user \d+ owns it/))
  // The folder of the socket is open to every user, as a folder that another user made in /tmp can be.
  chmodSync(dirname(fake.real), 0o777)
  assert.throws(() => udsDaemon({ socket: fake.alias }, VERSION, realClock), unsafe(/every user can write to its folder/))
  chmodSync(dirname(fake.real), 0o700)
  assert.ok(udsDaemon({ socket: fake.alias }, VERSION, realClock) !== undefined, 'the same socket passes again')
  // A file that is not a socket.
  const home = tempDir(t)
  const file = join(home, 'plain.sock')
  writeFileSync(file, '')
  assert.throws(() => udsDaemon({ socket: file }, VERSION, realClock), unsafe(/it is not a socket/))
  assert.equal(fake.calls.length, 0, 'no untrusted socket was dialled')
})

test('the socket trust check: a folder that another user owns is no daemon, also when this user owns the socket (the stat seam)', async (t) => {
  const uid = process.getuid?.()
  if (uid === undefined) return t.skip('no POSIX uids')
  const fake = await fakeDaemon(t)
  const real = realpathSync(fake.real)
  const folder = dirname(real)
  assert.equal(statSync(real).uid, uid, 'this user owns the socket')
  // The real stats, except that the user uid + 1 owns the folder of the socket.
  const stat = (p: string) => {
    const s = statSync(p)
    return p === folder ? { isSocket: () => s.isSocket(), uid: uid + 1, mode: s.mode } : s
  }
  assert.deepEqual(socketAt(fake.alias, uid, stat), { unsafe: `the daemon socket ${real} is not safe to dial: the user ${uid + 1} owns its folder` })
  assert.deepEqual(socketAt(fake.alias, uid, statSync), { real }, 'with the real stats, the same socket passes')
  assert.equal(fake.calls.length, 0, 'no socket was dialled')
})

test('the socket trust check runs again at each connect: a socket that became unsafe after the client was made is a connect error', async (t) => {
  const fake = await fakeDaemon(t, { handlers: { 'account/rateLimits/read': () => ({ rateLimits: { usedPercent: 0 } }) } })
  const d = client(fake)
  chmodSync(dirname(fake.real), 0o777)
  await assert.rejects(d.rateLimits(), (e: unknown) => isDaemonError('connect')(e) && /is not safe to dial/.test(String(e)))
  assert.equal(fake.conns.length, 0, 'it never connected')
})

test('the link: a socket that is not safe to dial is no daemon, with one debug line for each new reason', async (t) => {
  const fake = await fakeDaemon(t)
  const log = memoryLog()
  chmodSync(dirname(fake.real), 0o777)
  const link = daemonLink(() => udsDaemon({ socket: fake.alias }, VERSION, realClock), realClock, { log })
  assert.equal(link.get(), undefined)
  assert.equal(await link.hosted('T1'), false)
  assert.equal(await link.known('T1'), false, 'no daemon is known: not hosted')
  const why = `the daemon socket ${realpathSync(fake.real)} is not safe to dial: every user can write to its folder`
  assert.deepEqual(log.lines, [codexDebug.liveFailed('daemon', why)])
  chmodSync(dirname(fake.real), 0o700)
  assert.ok(link.get() !== undefined, 'a safe socket is the daemon again')
  assert.equal(fake.conns.length, 0)
})

test('the test guard: a socket under ~/.codex throws before any file access', () => {
  assert.equal(process.env.SPARE10_CODEX_TEST, '1', 'the specs run with SPARE10_CODEX_TEST=1')
  assert.throws(
    () => udsDaemon({ socket: join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock') }, VERSION, realClock),
    /SPARE10_CODEX_TEST is set/,
  )
})

// ---- The frame code on its own ----

test('encodeFrame and FrameReader: lengths, masks, and chunks cut anywhere', () => {
  for (const size of [0, 125, 126, 65_535, 65_536, 70_000]) {
    const payload = Buffer.alloc(size, 7)
    const bytes = Buffer.concat([encodeFrame(OP.text, payload), encodeFrame(OP.ping, Buffer.from('p'), null)])
    const r = new FrameReader(1_000_000)
    // Feed one byte, then the rest in two parts.
    r.push(bytes.subarray(0, 1))
    assert.equal(r.next(), undefined)
    r.push(bytes.subarray(1, 5))
    r.push(bytes.subarray(5))
    const f = r.next()
    assert.ok(f !== undefined)
    assert.equal(f.opcode, OP.text)
    assert.equal(f.masked, true)
    assert.equal(f.fin, true)
    assert.ok(f.payload.equals(payload))
    const g = r.next()
    assert.deepEqual([g?.opcode, g?.masked, g?.payload.toString()], [OP.ping, false, 'p'])
    assert.equal(r.next(), undefined)
  }
})

test('FrameReader refuses a frame over its cap from the header alone', () => {
  const r = new FrameReader(100)
  const head = encodeFrame(OP.text, Buffer.alloc(200), null).subarray(0, 4)
  r.push(head)
  assert.throws(() => r.next(), isDaemonError('protocol'))
  const big = Buffer.alloc(10)
  big[0] = 0x81
  big[1] = 127
  big.writeBigUInt64BE(2n ** 62n, 2)
  const r2 = new FrameReader(100)
  r2.push(big)
  assert.throws(() => r2.next(), isDaemonError('protocol'))
})

test('MessageJoiner: fragments join, binary is dropped, and a bad order throws', () => {
  const j = new MessageJoiner(100)
  assert.equal(j.add({ fin: false, opcode: OP.text, masked: false, payload: Buffer.from('he') }), undefined)
  assert.equal(j.add({ fin: true, opcode: OP.continuation, masked: false, payload: Buffer.from('llo') }), 'hello')
  assert.equal(j.add({ fin: true, opcode: OP.binary, masked: false, payload: Buffer.from('x') }), undefined)
  assert.throws(() => j.add({ fin: true, opcode: OP.continuation, masked: false, payload: Buffer.alloc(0) }), isDaemonError('protocol'))
  const k = new MessageJoiner(100)
  k.add({ fin: false, opcode: OP.text, masked: false, payload: Buffer.from('a') })
  assert.throws(() => k.add({ fin: true, opcode: OP.text, masked: false, payload: Buffer.from('b') }), isDaemonError('protocol'))
  const m = new MessageJoiner(4)
  m.add({ fin: false, opcode: OP.text, masked: false, payload: Buffer.from('abc') })
  assert.throws(() => m.add({ fin: true, opcode: OP.continuation, masked: false, payload: Buffer.from('de') }), isDaemonError('protocol'))
})

// ---- The link: hosted() and its cache ----

test('hosted(): a list that names the thread is kept 60 s, then read again', async () => {
  const clock = fakeClock(0)
  const d = memoryDaemon(clock, { loaded: ['T1'] })
  const link = daemonLink(() => d, clock)
  assert.equal(await link.hosted('T1'), true)
  await clock.advance(HOSTED_TTL_MS - 1)
  assert.equal(await link.hosted('T1'), true)
  assert.equal(d.callsOf('loaded').length, 1)
  await clock.advance(1)
  assert.equal(await link.hosted('T1'), true)
  assert.equal(d.callsOf('loaded').length, 2)
})

test('hosted(): a list that does not name the thread is read again after the miss time, so a new thread shows', async () => {
  const clock = fakeClock(0)
  const d = memoryDaemon(clock, { loaded: ['T1'] })
  const link = daemonLink(() => d, clock)
  assert.equal(await link.hosted('T2'), false)
  assert.equal(await link.hosted('T2'), false)
  assert.equal(d.callsOf('loaded').length, 1)
  d.script.loaded = ['T1', 'T2']
  await clock.advance(HOSTED_MISS_TTL_MS)
  assert.equal(await link.hosted('T2'), true)
  assert.equal(d.callsOf('loaded').length, 2)
  // The new list also answers T1 from the cache.
  assert.equal(await link.hosted('T1'), true)
  assert.equal(d.callsOf('loaded').length, 2)
})

test('known(): a failed read is undefined with a debug line, a good read is true or false, and no daemon is false', async () => {
  const clock = fakeClock(0)
  const d = memoryDaemon(clock, { loaded: new Error('down') })
  const log = memoryLog()
  let present = true
  const link = daemonLink(() => (present ? d : undefined), clock, { log })
  assert.equal(await link.known('T1'), undefined)
  assert.equal(await link.hosted('T1'), false, 'hosted keeps its rule: a failed read is false')
  assert.deepEqual(log.lines, [codexDebug.readFailed('the loaded threads', 'down'), codexDebug.readFailed('the loaded threads', 'down')])
  d.script.loaded = ['T1']
  assert.equal(await link.known('T1'), true)
  assert.equal(await link.known('T2'), false, 'from the cache')
  present = false
  assert.equal(await link.known('T1'), false)
  assert.equal(log.lines.length, 2)
})

test('hosted(): a failed read is false and is not kept, reads at the same time share one call, and no daemon is false', async () => {
  const clock = fakeClock(0)
  const d = memoryDaemon(clock, { loaded: new Error('down') })
  let present = true
  const link = daemonLink(() => (present ? d : undefined), clock)
  assert.equal(await link.hosted('T1'), false)
  d.script.loaded = ['T1']
  const both = await Promise.all([link.hosted('T1'), link.hosted('T1')])
  assert.deepEqual(both, [true, true])
  assert.equal(d.callsOf('loaded').length, 2)
  present = false
  assert.equal(link.get(), undefined)
  assert.equal(await link.hosted('T1'), false)
  assert.equal(d.callsOf('loaded').length, 2)
})
