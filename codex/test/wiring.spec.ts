import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { codexText } from '../../hooks/core/codex.ts'
import { parseStopped } from '../../hooks/core/decide.ts'
import { VERSION } from '../../hooks/core/text.ts'
import { createBroker } from '../src/broker.ts'
import { realClock } from '../src/clock.ts'
import type { Clock } from '../src/clock.ts'
import { udsDaemon } from '../src/daemon.ts'
import { pidAlive } from '../src/files.ts'
import { sessionStore } from '../src/store.ts'
import { fsWake } from '../src/wake.ts'
import { codexHost } from './helpers/codex-host.ts'
import { memoryLog } from './helpers/log.ts'
import { fakeRollout } from './helpers/rollout.ts'
import { fakeDaemon } from './helpers/uds-daemon.ts'

// The wiring (Codex design 8.2 wiring.spec): one broker from createBroker over the real stdioServer, the real
// udsDaemon on the WebSocket-over-UDS fake, the production Wake (fs.watch and its poll) and real timers. A
// test reading of 3 s trips a tool, Stop here interrupts the turn on the socket, the stop sweep runs, and
// at the end of the test window (plus its 60 s margin) the root ticker continues the work with turn/start.
//
// The clock is the real one, with two changes so the spec runs in seconds: a timer waits 1/20 of its time
// (the ticker's 30 s is 1.5 s), and the spec moves the clock on over the test window and its 60 s margin.
// The test window is 10 s, the shortest that `simulate ... in` takes (the spec of 8.2 names 3 s).

const SID = '01a0da06-c266-7842-bc97-1128f6549960'
const SCALE = 20

/** Real time and real timers, with the timers 1/SCALE as long, and a `jump` that moves the clock on. */
function quickClock(): Clock & { jump(ms: number): void } {
  let offset = 0
  return {
    now: () => Date.now() + offset,
    sleep: (ms, signal) => realClock.sleep(ms / SCALE, signal),
    after: (ms, fn) => realClock.after(ms / SCALE, fn),
    every: (ms, fn) => realClock.every(ms / SCALE, fn),
    jump(ms) {
      offset += ms
    },
  }
}

const until = async (ok: () => boolean, ms = 8_000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('the wiring spec waited too long')
    await realClock.sleep(20)
  }
}

test('wiring: a trip, Stop here, turn/interrupt on the socket, the stop sweep, and turn/start at the end of a short test window', async (t) => {
  const start = Date.now()
  let status: 'inProgress' | 'interrupted' = 'inProgress'
  const fake = await fakeDaemon(t, {
    handlers: {
      'account/rateLimits/read': () => {
        const codex = {
          limitId: 'codex',
          primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: Math.floor(start / 1000) + 3 * 3600 },
          secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: Math.floor(start / 1000) + 3 * 86400 },
          credits: { hasCredits: false, unlimited: false, balance: '0' },
        }
        return { ordinaryUsageAllowed: true, rateLimits: codex, rateLimitsByLimitId: { codex } }
      },
      'thread/loaded/list': () => ({ data: [SID], nextCursor: null }),
      'thread/read': () => ({ thread: { id: SID, status: { type: status === 'inProgress' ? 'active' : 'idle' } } }),
      'thread/turns/list': () => ({ data: [{ id: 'U-tool', status, startedAt: Math.floor(start / 1000) - 5 }] }),
      'turn/interrupt': () => {
        status = 'interrupted'
        return {}
      },
      'turn/start': () => ({ turn: { id: 'U-next' } }),
    },
  })
  const data = join(fake.codexHome, 'data')
  const rollout = fakeRollout(join(fake.codexHome, 'sessions', 'rollout.jsonl'))
  rollout.sessionMeta({ originator: 'codex-tui', source: 'cli', id: SID })
  const clock = quickClock()
  const log = memoryLog()
  const host = codexHost()
  const broker = createBroker({
    input: host.input,
    output: host.output,
    env: { CODEX_HOME: fake.codexHome, SPARE10_CODEX_DATA: data, SPARE10_CODEX_TEST: '1' },
    clock,
    wake: fsWake(clock, log),
    pid: process.pid,
    ppid: process.ppid,
    selfFile: join(fake.codexHome, 'plugin', 'codex', 'dist', 'spare10.mjs'),
    parentArgs: () => '/opt/homebrew/bin/codex app-server --listen unix://',
    daemon: (paths) => udsDaemon(paths, VERSION, clock),
    pidAlive,
    log,
    nodePath: process.execPath,
  })
  t.after(async () => {
    await broker.stop()
  })
  await host.initialize()
  host.initialized()
  const args = (site: string, extra: Record<string, unknown> = {}) => ({ site, session: SID, transcript: rollout.path, mode: 'default', model: 'gpt-5.5', cwd: '/tmp/x', ...extra })
  await host.gate(args('start', { source: 'startup' }), SID)
  const set = JSON.parse(await host.gate(args('prompt', { turn: 'U-set', prompt: 'spare10 set lastMinutes 0' }), SID)) as Record<string, unknown>
  assert.equal(set['reason'], `spare10: ${codexText.setOk('lastMinutes', '0', '20')}`)
  const sim = JSON.parse(await host.gate(args('prompt', { turn: 'U-sim', prompt: 'spare10 simulate 92 in 10s' }), SID)) as Record<string, unknown>
  assert.match(sim['reason'] as string, /^spare10: test reading set to 92% used/)

  // The trip: the tool call holds and one form shows.
  const held = host.call(args('tool', { turn: 'U-tool', tool: 'exec_command', call: 'call_1' }), SID)
  await host.waitFor((m) => m['method'] === 'elicitation/create')
  host.answer({ action: 'accept', content: { choice: 'stop' } })
  const text = await held.answer
  const out = JSON.parse(text ?? '{}') as Record<string, unknown>
  assert.equal((out['hookSpecificOutput'] as Record<string, unknown>)['permissionDecision'], 'deny')
  // Stop here on the daemon: turn/interrupt on the socket, once (the sweep and the refusal share the mark).
  await until(() => fake.calls.some((c) => c.method === 'turn/interrupt'))
  const interrupts = fake.calls.filter((c) => c.method === 'turn/interrupt')
  assert.deepEqual(
    interrupts.map((c) => c.params),
    [{ threadId: SID, turnId: 'U-tool' }],
  )
  const store = sessionStore({ data }, SID, 'test', { fire() {} })
  const stop = parseStopped(store.read().stopped)
  assert.ok(stop !== undefined && stop.test === true && stop.work === true && stop.auto === true)
  assert.equal(typeof store.read().interrupts?.['U-tool'], 'number')

  // The end of the test window, then its 60 s margin: the root ticker continues the stopped work.
  clock.jump(Math.max(0, (stop?.windowEnd ?? 0) - clock.now()) + 61_000)
  await until(() => fake.calls.some((c) => c.method === 'turn/start'))
  const startCall = fake.calls.find((c) => c.method === 'turn/start')
  const input = (startCall?.params as { threadId: string; input: Array<{ type: string; text: string; text_elements: unknown[] }> })
  assert.equal(input.threadId, SID)
  assert.equal(input.input.length, 1)
  assert.ok(input.input[0]?.text.startsWith(`${codexText.interruptedNote} The test window ended, so the stop at the quota reserve is over.`), input.input[0]?.text)
  assert.equal(store.read().stopped, undefined)
  assert.equal(store.read().continuation?.text, input.input[0]?.text)
  // Every daemon connection was one call: each closed after its reply.
  assert.ok(fake.conns.every((c) => c.received.filter((m) => m['method'] !== 'initialize' && m['method'] !== 'initialized').length <= 1))
})
