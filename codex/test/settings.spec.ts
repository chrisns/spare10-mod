import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { codexDebug, codexText } from '../../hooks/core/codex.ts'
import type { HostKind } from '../../hooks/core/codex.ts'
import { DEFAULTS } from '../../hooks/core/config.ts'
import type { Kind } from '../../hooks/core/reading.ts'
import { badWarning } from '../../hooks/core/text.ts'
import { ENV_NAMES, configPath, createSettings, envReadsOf, ownsSimulate, readConfig, setOption } from '../src/settings.ts'
import type { Env } from '../src/paths.ts'
import { memoryLog } from './helpers/log.ts'
import { tempDir } from './helpers/tmp.ts'

// The settings of a broker (Codex design 5.1, 5.2, 8.2 settings.spec): precedence, an unreadable config.json,
// SPARE10_SIMULATE on a shared host, the child policy of a nested run.
//
// The kit port (8.2):
// Each tests/kit case and the Codex case that tests it: codex/test/kit-port.txt, kept complete by kit-port.spec.ts.

function setup(t: Parameters<typeof tempDir>[0], o: { env?: Env; hostKind?: HostKind; child?: () => 'stop' | undefined; kind?: () => Kind; config?: string } = {}) {
  const data = join(tempDir(t), 'data')
  mkdirSync(data, { recursive: true })
  if (o.config !== undefined) writeFileSync(join(data, 'config.json'), o.config)
  const log = memoryLog()
  const asked = { child: 0 }
  const settings = createSettings({
    paths: { data },
    log,
    env: o.env ?? {},
    parentChild: () => {
      asked.child += 1
      return (o.child ?? (() => undefined))()
    },
    simulateKind: o.kind ?? (() => 'five_hour'),
    ...(o.hostKind === undefined ? {} : { hostKind: o.hostKind }),
  })
  return { data, log, settings, asked, path: join(data, 'config.json') }
}

test('settings: no config.json and no variable give the defaults', (t) => {
  const { settings, path } = setup(t)
  assert.equal(settings.path, path)
  const eff = settings.get()
  for (const k of ['reserve', 'weeklyReserve', 'lastMinutes', 'weeklyLastHours', 'resumeFloor', 'weeklyResumeFloor', 'pausePrompt', 'autoResume', 'headless', 'scope'] as const) {
    assert.equal(eff[k], DEFAULTS[k], k)
  }
  assert.equal(eff.enabled, true)
  assert.equal(eff.from.reserve, 'option')
  assert.deepEqual(eff.warnings, [])
  assert.equal(eff.testPct, undefined)
})

test('settings: config.json sets the options, and a variable wins over it (A15)', (t) => {
  const { settings } = setup(t, {
    config: JSON.stringify({ reserve: 15, weeklyReserve: 5, lastMinutes: 30, resumeFloor: 3, autoResume: false, headless: 'wait', pausePrompt: 'Finish, then stop.' }),
    env: { SPARE10_RESERVE: '20', SPARE10_AUTO_RESUME: 'on' },
  })
  const eff = settings.get()
  assert.equal(eff.reserve, 20)
  assert.equal(eff.from.reserve, 'env')
  assert.equal(eff.weeklyReserve, 5)
  assert.equal(eff.from.weeklyReserve, 'option')
  assert.equal(eff.lastMinutes, 30)
  assert.equal(eff.resumeFloor, 3)
  assert.equal(eff.autoResume, true)
  assert.equal(eff.from.autoResume, 'env')
  assert.equal(eff.headless, 'wait')
  assert.equal(eff.pausePrompt, 'Finish, then stop.')
})

test('settings: autoResume false in the file is off, and "off" and "on" read too', (t) => {
  for (const [raw, want] of [
    [false, false],
    [true, true],
    ['off', false],
    ['on', true],
  ] as const) {
    const { settings } = setup(t, { config: JSON.stringify({ autoResume: raw }) })
    assert.equal(settings.get().autoResume, want, String(raw))
  }
})

test('settings: a bad value in config.json warns with CX11 and uses the default, before the B27 warnings of the env', (t) => {
  const { settings, path } = setup(t, { config: JSON.stringify({ reserve: 150, headless: 'sometimes', nonsense: 1 }), env: { SPARE10_WEEKLY_RESERVE: 'x' } })
  const eff = settings.get()
  assert.equal(eff.reserve, 10)
  assert.equal(eff.headless, 'off')
  assert.deepEqual(eff.warnings, [
    `${path} sets reserve to 150, which is not 1 to 99. spare10 uses 10.`,
    `${path} sets headless to "sometimes", which is not off, prompt, stop or wait. spare10 uses off.`,
    badWarning('SPARE10_WEEKLY_RESERVE', 'x', '10'),
  ])
})

test('settings: a config.json that does not parse keeps the variables, and zeroes only the spans that no variable sets (CX12)', (t) => {
  const { settings, path } = setup(t, { config: '{"reserve": 15,', env: { SPARE10_RESERVE: '20', SPARE10_LAST_MINUTES: '25' } })
  const eff = settings.get()
  assert.equal(eff.reserve, 20, 'the variable')
  assert.equal(eff.weeklyReserve, 10, 'the default, not the file')
  assert.equal(eff.lastMinutes, 25)
  assert.equal(eff.from.lastMinutes, 'env')
  assert.equal(eff.weeklyLastHours, 0)
  assert.equal(eff.from.weeklyLastHours, 'unread')
  assert.equal(eff.warnings.length, 1)
  const err = readConfig(path)
  assert.ok('error' in err)
  assert.equal(eff.warnings[0], codexText.configUnread(path, err.error))
  assert.match(eff.warnings[0] ?? '', /^cannot read .*config\.json \(.+\)\. spare10 uses the default options, and keeps each reserve until the reset\.$/)
})

test('settings: a config.json that is not an object is unread too', (t) => {
  for (const config of ['[1, 2]', '"reserve 15"', 'null']) {
    const { settings, path } = setup(t, { config })
    const eff = settings.get()
    assert.equal(eff.lastMinutes, 0, config)
    assert.equal(eff.from.lastMinutes, 'unread')
    assert.equal(eff.from.weeklyLastHours, 'unread')
    assert.deepEqual(eff.warnings, [codexText.configUnread(path, 'it is not a JSON object')], config)
  }
})

test('settings: the result is kept until config.json changes, and setOption round trips (autoResume off)', (t) => {
  const { settings, data } = setup(t)
  assert.equal(settings.get().autoResume, true)
  const a = settings.get()
  a.reserve = 50 // a copy: the kept value does not change
  assert.equal(settings.get().reserve, 10)
  assert.deepEqual(setOption({ data }, 'cli', 'autoResume', false), { old: undefined })
  assert.equal(settings.get().autoResume, false)
  assert.deepEqual(setOption({ data }, 'cli', 'reserve', 15), { old: undefined })
  assert.deepEqual(setOption({ data }, 'cli', 'reserve', 20), { old: 15 })
  assert.equal(settings.get().reserve, 20)
  assert.deepEqual(setOption({ data }, 'cli', 'autoResume', undefined), { old: false })
  assert.equal(settings.get().autoResume, true)
  assert.deepEqual(JSON.parse(readFileSync(configPath({ data }), 'utf8')), { reserve: 20 })
  assert.equal(statSync(configPath({ data })).mode & 0o777, 0o600)
})

test('settings: setOption never overwrites a config.json that does not parse or is not an object', (t) => {
  const { data, path } = setup(t, { config: '{"reserve": 15,' })
  assert.throws(() => setOption({ data }, 'cli', 'reserve', 20), SyntaxError)
  assert.equal(readFileSync(path, 'utf8'), '{"reserve": 15,')
  writeFileSync(path, '[1]')
  assert.throws(() => setOption({ data }, 'cli', 'reserve', 20), /not a JSON object/)
  assert.equal(readFileSync(path, 'utf8'), '[1]')
})

test('settings: SPARE10_SIMULATE is ignored with a debug line on the daemon and an app-server, and honoured on tui and exec', (t) => {
  for (const hostKind of ['daemon', 'app-server', 'unknown'] as const) {
    const { settings, log } = setup(t, { env: { SPARE10_SIMULATE: '92' }, hostKind })
    assert.equal(settings.get().testPct, undefined, hostKind)
    settings.get()
    assert.deepEqual(log.lines, [codexDebug.simulateIgnored], `${hostKind}: one line`)
  }
  for (const hostKind of ['tui', 'exec'] as const) {
    const { settings, log } = setup(t, { env: { SPARE10_SIMULATE: '92 in 20s' }, hostKind })
    const eff = settings.get()
    assert.equal(eff.testPct, 92, hostKind)
    assert.equal(eff.testInMs, 20_000)
    assert.deepEqual(log.lines, [])
  }
  assert.equal(ownsSimulate(undefined), true, 'the CLI')
})

test('settings: SPARE10_SIMULATE with no kind word takes the weekly window when the 5-hour window is absent (A8)', (t) => {
  let kind: Kind = 'five_hour'
  const { settings } = setup(t, { env: { SPARE10_SIMULATE: '92' }, hostKind: 'exec', kind: () => kind })
  assert.equal(settings.get().testKind, undefined)
  kind = 'seven_day'
  const eff = settings.get()
  assert.equal(eff.testPct, 92)
  assert.equal(eff.testKind, 'seven_day')
})

test('settings: a nested run takes the child policy of its parent, and SPARE10_HEADLESS wins (3.10)', (t) => {
  const nested = setup(t, { child: () => 'stop' })
  const eff = nested.settings.get()
  assert.equal(eff.headless, 'stop')
  assert.equal(eff.from.headless, 'env')
  const own = setup(t, { child: () => 'stop', env: { SPARE10_HEADLESS: 'wait' } })
  assert.equal(own.settings.get().headless, 'wait')
  assert.equal(own.asked.child, 0, 'the parent is not read when the variable is set')
  let child: 'stop' | undefined
  const late = setup(t, { child: () => child })
  assert.equal(late.settings.get().headless, 'off')
  child = 'stop'
  assert.equal(late.settings.get().headless, 'stop', 'a new parent policy is not hidden by the kept value')
})

test('settings: a parent state that cannot be read is logged and ignored', (t) => {
  const { settings, log } = setup(t, {
    child: () => {
      throw new Error('bad JSON')
    },
  })
  assert.equal(settings.get().headless, 'off')
  assert.deepEqual(log.lines, [codexDebug.readFailed('the parent session', 'bad JSON')])
})

test('settings: envReadsOf takes the eleven names, empty values included', () => {
  assert.equal(ENV_NAMES.length, 11)
  assert.deepEqual(
    envReadsOf({ SPARE10: 'on', SPARE10_PAUSE_PROMPT: '', SPARE10_RESERVE: '15', SPARE10_SIMULATE: '92', OTHER: 'x', SPARE10_CONSENT: 'S 2026' }),
    { onOff: 'on', pausePrompt: '', reserve: '15', simulate: '92' },
  )
})
