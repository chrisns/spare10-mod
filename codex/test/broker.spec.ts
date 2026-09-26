import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { codexDebug } from '../../hooks/core/codex.ts'
import { HEADLESS_GENERIC, STOP_GENERIC, VERSION } from '../../hooks/core/text.ts'
import { createBroker } from '../src/broker.ts'
import { launcherText } from '../src/paths.ts'
import { PRUNE_AFTER_MS } from '../src/timing.ts'
import { fakeClock } from './helpers/clock.ts'
import { codexHost, flush } from './helpers/codex-host.ts'
import { memoryDaemon } from './helpers/memory-daemon.ts'
import { memoryLog } from './helpers/log.ts'
import { tempDir } from './helpers/tmp.ts'
import { memoryWake } from './helpers/wake.ts'
import { HOUR, SID, T0, parsed, world } from './helpers/world.ts'

// The broker (Codex design 3.4, 7.2 broker.ts): it refuses an old Node.js before `initialize`, answers
// `initialize` before any file work, starts its background work at `notifications/initialized` (the data dir
// and the launcher), and at the shutdown answers each held call with its site's refusal, never a pass, after
// the turn/interrupt of a held call in a hosted thread.

const RESET = T0 + 2 * HOUR

test('broker: an older Node.js than 20 is refused before initialize', (t) => {
  const root = tempDir(t)
  assert.throws(
    () =>
      createBroker({
        input: new PassThrough(),
        output: new PassThrough(),
        env: { CODEX_HOME: root, SPARE10_CODEX_DATA: join(root, 'data'), SPARE10_CODEX_TEST: '1' },
        clock: fakeClock(T0),
        wake: memoryWake(),
        pid: 1,
        ppid: 2,
        selfFile: join(root, 'codex', 'dist', 'spare10.mjs'),
        parentArgs: () => 'codex',
        daemon: () => undefined,
        pidAlive: () => true,
        nodeVersion: '18.20.4',
      }),
    /spare10: the broker needs Node\.js 20 or later\. This is Node\.js 18\.20\.4\./,
  )
})

test('broker: initialize answers before any file work, and the background work starts at initialized', async (t) => {
  const root = tempDir(t)
  const data = join(root, 'data')
  const host = codexHost()
  const broker = createBroker({
    input: host.input,
    output: host.output,
    env: { CODEX_HOME: root, SPARE10_CODEX_DATA: data, SPARE10_CODEX_TEST: '1' },
    clock: fakeClock(T0),
    wake: memoryWake(),
    pid: 11,
    ppid: 12,
    selfFile: join(root, 'plugin', 'codex', 'dist', 'spare10.mjs'),
    parentArgs: () => 'codex',
    daemon: () => memoryDaemon(fakeClock(T0)),
    pidAlive: () => true,
    log: memoryLog(),
    nodePath: '/usr/local/bin/node',
  })
  t.after(() => broker.stop())
  const init = await host.initialize()
  assert.deepEqual((init['result'] as Record<string, unknown>)['serverInfo'], { name: 'spare10', version: '0.3.0' })
  assert.equal(existsSync(data), false, 'no file work before initialized')
  assert.deepEqual((await host.request('tools/list'))['result'], { tools: [] })
  host.initialized()
  await flush()
  assert.equal(readFileSync(join(data, 'bin', 'spare10'), 'utf8'), launcherText('/usr/local/bin/node', join(root, 'plugin')))
})

test('broker: the background work logs the version and the test guard once (D10, the E2E runs read it)', async (t) => {
  const root = tempDir(t)
  const host = codexHost()
  const log = memoryLog()
  const broker = createBroker({
    input: host.input,
    output: host.output,
    env: { CODEX_HOME: root, SPARE10_CODEX_DATA: join(root, 'data'), SPARE10_CODEX_TEST: '1' },
    clock: fakeClock(T0),
    wake: memoryWake(),
    pid: 21,
    ppid: 22,
    selfFile: join(root, 'plugin', 'codex', 'dist', 'spare10.mjs'),
    parentArgs: () => 'codex',
    daemon: () => undefined,
    pidAlive: () => true,
    log,
    nodePath: '/usr/local/bin/node',
  })
  t.after(() => broker.stop())
  await host.initialize()
  assert.equal(log.lines.length, 0, 'nothing before initialized')
  host.initialized()
  await flush()
  await host.request('ping')
  assert.deepEqual(
    log.lines.filter((l) => l.includes('the broker')),
    [codexDebug.boot(VERSION, true)],
  )
})

test('broker: the background work prunes the old session folders once a day, and logs it', async (t) => {
  const w = world(t)
  const dir = join(w.data, 'sessions', 'S-OLD')
  w.setState({ hostPid: 12 }, 'S-OLD')
  const at = (T0 - PRUNE_AFTER_MS - HOUR) / 1000
  utimesSync(join(dir, 'state.json'), at, at)
  await w.broker()
  assert.equal(existsSync(dir), false, 'the old folder is gone')
  assert.ok(existsSync(join(w.data, 'sessions', SID)), 'the session of the broker stays')
  assert.deepEqual(w.log.lines.filter((l) => l.includes('old session')), [codexDebug.pruned(1)])
})

test('broker: stdin EOF answers a held call with its refusal, after the turn/interrupt of a hosted thread', async (t) => {
  const w = world(t, { daemon: true })
  const b = await w.broker({ hosted: true })
  w.reading(SID, 92, { reset: RESET })
  const h = b.call('tool', { turn: 'U-held' })
  await w.settle()
  assert.equal(h.box.done, false)
  await b.end()
  await b.broker.done
  await w.settle()
  assert.equal(h.box.done, true)
  assert.deepEqual(parsed(h.box.text), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: STOP_GENERIC } })
  assert.deepEqual(w.daemon.callsOf('interrupt'), [[SID, 'U-held']])
  assert.equal(typeof w.state().interrupts?.['U-held'], 'number')
})

test('broker: stdin EOF answers an unattended stop hold with the headless refusal, never a pass (3.4)', async (t) => {
  const w = world(t)
  const b = await w.broker({ hostKind: 'exec', originator: 'codex_exec', source: 'exec', env: { SPARE10_HEADLESS: 'stop' } })
  w.reading(SID, 92, { reset: RESET })
  await b.gate('prompt', { prompt: 'plain', turn: 'U-a' }).catch(() => '')
  const first = parsed(await b.gate('tool', { turn: 'U-a' }))
  assert.equal((first['hookSpecificOutput'] as Record<string, unknown>)['permissionDecision'], 'deny', 'the one deny of the turn')
  const h = b.call('tool', { turn: 'U-a' })
  await w.settle()
  assert.equal(h.box.done, false, 'the next tool of the turn holds')
  await b.end()
  await b.broker.done
  await w.settle()
  assert.equal(h.box.done, true)
  assert.deepEqual(parsed(h.box.text), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: HEADLESS_GENERIC } })
})
