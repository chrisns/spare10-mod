import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { OPTIONS, codexText } from '../../hooks/core/codex.ts'
import { formatConsent } from '../../hooks/core/decide.ts'
import { VERSION, simulateReply, stopReply } from '../../hooks/core/text.ts'
import { parseArgs } from '../src/cli.ts'
import { brokerEnvOf, withBrokerEnv } from '../src/store.ts'
import { fakeRollout } from './helpers/rollout.ts'
import { tempDir } from './helpers/tmp.ts'
import { HOST_PID, HOUR, MIN, SEC, SID, T0, parsed, world } from './helpers/world.ts'

// The CLI (Codex design 2.9, 4.20, 8.2 cli.spec): the agent check, a session that must be named, the usage,
// the short line from `!` with the full reply queued, the reply of a command from `!` that changes nothing,
// the full reply from a terminal with the session, broker and daemon rows, and its queued copy, a resume
// that releases a held broker, a stop over a held stop, the path flags, the attendance and the SPARE10_*
// values of the root broker.
//
// The kit port (8.2). Claude has no CLI: /spare10 is a slash command. No kit case maps here.

const RESET = T0 + 2 * HOUR
const OTHER = '01a0da0b-0000-7000-8000-000000000b0b'

test('cli: the agent cannot run it: CODEX_SANDBOX, CODEX_SANDBOX_NETWORK_DISABLED, or a data dir it cannot write (CX35)', async (t) => {
  const w = world(t)
  for (const env of [{ CODEX_SANDBOX: 'seatbelt' }, { CODEX_SANDBOX_NETWORK_DISABLED: '1' }]) {
    const r = await w.cli(['resume', '--session', SID], env)
    assert.deepEqual(r, { code: 2, out: codexText.cliSandbox('resume') })
  }
  mkdirSync(w.data, { recursive: true })
  chmodSync(w.data, 0o500)
  try {
    const r = await w.cli(['stop', '--session', SID])
    assert.deepEqual(r, { code: 2, out: codexText.cliSandbox('stop') })
    assert.equal(existsSync(join(w.data, 'sessions')), false)
  } finally {
    chmodSync(w.data, 0o700)
  }
})

test('cli: bad arguments print the usage (CX37)', async (t) => {
  const w = world(t)
  for (const argv of [['pause'], ['resume', 'now'], ['status', '--nope'], ['help', '--full'], ['simulate'], ['--session']]) {
    assert.deepEqual(await w.cli(argv), { code: 2, out: codexText.cliUsage }, argv.join(' '))
  }
  assert.deepEqual(parseArgs(['set', 'pausePrompt', 'Finish', 'this.', '--session=abc']), { full: false, session: 'abc', verb: 'set', words: ['pausePrompt', 'Finish', 'this.'] })
})

test('cli: resume, stop and simulate never guess the session: CX36 with the sessions of the last 24 h, and no write', async (t) => {
  const w = world(t)
  await w.broker()
  w.reading(SID, 92, { reset: RESET })
  const before = readdirSync(join(w.data, 'sessions', SID)).sort()
  const r = await w.cli(['resume'])
  assert.equal(r.code, 2)
  const lines = r.out.split('\n')
  assert.equal(lines[0], codexText.cliNoSession('resume', []))
  assert.match(lines[1] ?? '', new RegExp(`^  · ${SID}  /tmp/x/proj  tripped$`))
  assert.equal(w.state().consent, undefined)
  assert.deepEqual(readdirSync(join(w.data, 'sessions', SID)).sort(), before)
})

test('cli: status with no session takes the newest and names it, and with none says none (CX45)', async (t) => {
  const w = world(t, { daemon: true })
  const none = await w.cli(['status'])
  assert.equal(none.code, 0)
  assert.match(none.out, new RegExp(`^spare10: version ${VERSION.replaceAll('.', '\\.')}\\n`))
  assert.match(none.out, /\n {2}· session {8}none\n/)
  assert.match(none.out, /\n {2}· daemon {9}reachable\n/)
  assert.equal(existsSync(join(w.data, 'sessions')), false, 'a report of no session writes no session')
  await w.broker()
  await w.advance(MIN)
  await w.broker({ session: OTHER })
  const r = await w.cli(['status'])
  assert.match(r.out, new RegExp(`\\n {2}· session {8}${OTHER}\\n`))
  assert.match(r.out, /\n {2}· broker {9}running\n/)
  assert.match(r.out, /\n {2}· daemon {9}no\. After Stop here, spare10 holds the work in place\.\n/)
})

test('cli: from ! the resume prints CX44 and queues the full reply, status prints the phase line, and status --full the report', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  const bang = { CODEX_THREAD_ID: SID, CODEX_SESSION_ID: SID }
  const status = await w.cli(['status'], bang)
  assert.deepEqual(status, { code: 0, out: 'spare10: ⚠ tripped        spare10 holds the next step and asks you.' })
  const full = await w.cli(['status', '--full'], bang)
  assert.match(full.out, /^spare10: version /)
  assert.match(full.out, /\n {2}· session {8}01a0da06/)
  const r = await w.cli(['resume'], bang)
  assert.deepEqual(r, { code: 0, out: codexText.cliDone('resume') })
  assert.equal(w.state().consent, formatConsent(SID, RESET, 95))
  // The full reply rides the next root gate.
  const out = parsed(await b.gate('tool'))
  assert.match(out['systemMessage'] as string, /^spare10: you can use the reserve until 95% used\./)
})

test('cli: from a terminal the full reply, and a resume releases a held broker', async (t) => {
  const w = world(t, { daemon: true })
  const b = await w.broker({ hosted: true })
  w.reading(SID, 92, { reset: RESET })
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false)
  const status = await w.cli(['status', '--session', SID])
  assert.match(status.out, /\n {2}· session {8}01a0da06-c266-7842-bc97-1128f6549960\n {2}· broker {9}running\n {2}· daemon {9}yes\. spare10 can end a turn and start one\.\n/)
  const r = await w.cli(['resume', '--session', SID])
  assert.equal(r.code, 0)
  assert.match(r.out, /^spare10: resumed\. Held work continues on the reserve until 95% used\./)
  await w.settle()
  assert.equal(h.box.done, true)
  assert.equal(parsed(h.box.text)['hookSpecificOutput'], undefined, 'the held tool runs')
  // A broker that is gone.
  w.alive.delete(b.pid)
  assert.match((await w.cli(['status', '--session', SID])).out, /\n {2}· broker {9}not running: spare10 does not guard this session now\.\n/)
})

test('cli: stop over a held stop clears noDialog, and the held call then takes the normal mode', async (t) => {
  const w = world(t, { daemon: true })
  const b = await w.broker({ hosted: true, form: false })
  w.reading(SID, 92, { reset: RESET })
  // The daemon shows the turn interrupted once an interrupt of it came (the CLI sends it, 4.23).
  w.daemon.script.newestTurn = () => ({ id: 'U-held', status: w.daemon.callsOf('interrupt').length > 0 ? 'interrupted' : 'inProgress', startedAt: Math.floor(T0 / 1000) - 5 })
  const h = b.call('tool', { turn: 'U-held' })
  await w.settle()
  assert.equal(w.state().stopMeta?.noDialog, true, 'a held stop')
  assert.equal(h.box.done, false, 'it holds, also in a hosted thread')
  assert.deepEqual(w.daemon.callsOf('interrupt'), [], 'the sweep leaves a held call of a held stop')
  const r = await w.cli(['stop', '--session', SID])
  assert.equal(r.code, 0)
  assert.equal(w.state().stopMeta, undefined)
  assert.match(r.out, /^spare10: stopped\. Held work is refused\.$/)
  await w.settle()
  assert.equal(h.box.done, true)
  assert.deepEqual(w.daemon.callsOf('interrupt'), [[SID, 'U-held']])
})

test('cli: stop over a held stop with no daemon clears noDialog, and the reply says that the held call still waits', async (t) => {
  const w = world(t)
  const b = await w.broker({ form: false })
  w.reading(SID, 92, { reset: RESET })
  const h = b.call('tool', { turn: 'U-held' })
  await w.settle()
  assert.equal(w.state().stopMeta?.noDialog, true, 'a held stop')
  assert.equal(h.box.done, false)
  const r = await w.cli(['stop', '--session', SID])
  assert.equal(r.code, 0)
  assert.equal(w.state().stopMeta, undefined)
  // No interrupt can reach a thread that no daemon hosts: the call holds on under the plain stop.
  assert.match(r.out, /^spare10: already stopped( until \d\d:\d\d)?\. Held work waits\. Run !spare10 resume to continue it now\.$/)
  await w.settle()
  assert.equal(h.box.done, false, 'the held call still waits')
  assert.match((await w.cli(['status', '--session', SID])).out, /Held work waits\. Run !spare10 resume to continue it now\./)
})

test('cli: --data and --codex-home set the paths, and simulate and set work from a terminal', async (t) => {
  const w = world(t)
  await w.broker()
  const home = tempDir(t, 's10c')
  const data = join(home, 'data2')
  const r = await w.cli(['set', 'reserve', '15', '--codex-home', home, '--data', data], { SPARE10_CODEX_DATA: undefined, CODEX_HOME: undefined })
  assert.deepEqual(r, { code: 0, out: `spare10: ${codexText.setOk('reserve', '15', '10')}` })
  assert.ok(existsSync(join(data, 'config.json')))
  assert.equal(existsSync(join(data, 'bin', 'spare10')), false, 'only a broker writes the launcher (3.9): a CLI of another copy or another Node.js never takes it over')
  assert.equal(existsSync(join(w.data, 'config.json')), false)
  const sim = await w.cli(['simulate', '92', '--session', SID])
  assert.match(sim.out, /^spare10: test reading set to 92% used/)
  assert.equal(w.state().test?.kinds.five_hour?.pct, 92)
  assert.equal(w.state().test?.hostPid, 4000, 'bound to the host of the session')
  const help = await w.cli(['help'])
  assert.deepEqual(help, { code: 0, out: `spare10: ${codexText.help(w.paths.bin, w.paths.home)}` })
})

test('cli: status from a terminal with no session reads the daemon and writes only live.json and seed.json (LCX-REAL shape)', async (t) => {
  const w = world(t, { daemon: true })
  const week = { usedPercent: 97, windowDurationMins: 10080, resetsAt: Math.floor((T0 + 2 * 24 * HOUR) / 1000) }
  const codex = { limitId: 'codex', primary: week, secondary: null, credits: { hasCredits: false, unlimited: false, balance: '0' } }
  w.daemon.script.rateLimits = { ordinaryUsageAllowed: true, rateLimits: codex, rateLimitsByLimitId: { codex } }
  const r = await w.cli(['status'])
  assert.equal(r.code, 0)
  assert.match(r.out, /\n {2}· live read {6}from the Codex daemon, under 1 min ago\n/)
  assert.match(r.out, /\n {2}· weekly reading live · 97% used · 3% left · resets /)
  assert.match(r.out, /\n {2}· session {8}none\n/)
  assert.match(r.out, /\n {2}· daemon {9}reachable\n/)
  assert.deepEqual(readdirSync(w.data).sort(), ['live.json', 'seed.json'])
  // One live read is one observation. From the second read on, the report knows the plan has no 5-hour window.
  assert.match(r.out, /\n {2}· reading {8}none: no reading yet\n/)
  await w.advance(31 * SEC)
  const again = await w.cli(['status'])
  assert.match(again.out, /\n {2}· reading {8}none: Codex reports no 5-hour window for this plan\n/)
  assert.match(again.out, /^spare10: version .+\n\n {2}⚠ tripped/)
})

test('cli: from ! a command that changes nothing prints its reply at once and queues nothing', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false, 'the tool holds')
  const bang = { CODEX_THREAD_ID: SID, CODEX_SESSION_ID: SID }
  assert.deepEqual(await w.cli(['simulate', '9x'], bang), { code: 0, out: `spare10: ${simulateReply('bad')}` })
  const range = OPTIONS.find((o) => o.name === 'reserve')?.range ?? ''
  assert.deepEqual(await w.cli(['set', 'reserve', 'abc'], bang), { code: 0, out: `spare10: ${codexText.setBad('reserve', range)}` })
  assert.equal(w.state().notices, undefined, 'no line waits for the end of the hold')
  // A command that changes config.json prints CX44 and queues its reply.
  assert.deepEqual(await w.cli(['set', 'reserve', '20'], bang), { code: 0, out: codexText.cliDone('set') })
  assert.equal(w.notices().length, 1)
  assert.equal(h.box.done, false, 'the tool still holds')
  // Below the reserve, a stop changes nothing.
  const v = world(t)
  await v.broker()
  v.reading(SID, 40, { reset: RESET })
  const r = await v.cli(['stop'], bang)
  assert.match(r.out, /^spare10: nothing to stop\./)
  assert.equal(v.state().stopped, undefined)
  assert.equal(v.state().notices, undefined)
})

test('cli: a command from a terminal that can change a named session also queues its reply, also with an empty CODEX_THREAD_ID', async (t) => {
  const w = world(t, { daemon: true })
  const b = await w.broker({ hosted: true })
  w.reading(SID, 92, { reset: RESET })
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false)
  const r = await w.cli(['resume', '--session', SID], { CODEX_THREAD_ID: '' })
  assert.match(r.out, /^spare10: resumed\. Held work continues/)
  await w.settle()
  assert.equal(h.box.done, true, 'the held tool runs')
  assert.match(parsed(h.box.text)['systemMessage'] as string, /^spare10: resumed\. Held work continues/, 'the transcript shows the resume')
  const s = await w.cli(['stop', '--session', SID])
  assert.deepEqual(w.notices(), [s.out.replace(/^spare10: /, '')])
})

test('cli: resume and stop act on a daemon session whose rollout had no session_meta at its first root gate', async (t) => {
  const w = world(t)
  const late = join(w.root, 'sessions', 'rollout-late.jsonl')
  const b = await w.broker({ hostKind: 'daemon', transcript: late })
  assert.equal(w.state().attended, false, 'the first root gate read no session_meta')
  fakeRollout(late).sessionMeta({ originator: 'codex-tui', source: 'cli', id: SID }).tokenCount({ at: w.clock.now(), primary: { pct: 92, mins: 300, resetsAt: RESET } })
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false, 'the gate holds and asks')
  const r = await w.cli(['stop', '--session', SID])
  assert.notEqual(r.out, `spare10: ${stopReply('off')}`)
  assert.ok(w.state().stopped !== undefined, 'the stop is written')
  // With no rollout, the CLI keeps the answer of the broker, which knows the permission mode.
  const v = world(t)
  await v.broker({ transcript: null, mode: 'bypassPermissions' })
  assert.deepEqual(await v.cli(['stop', '--session', SID]), { code: 0, out: `spare10: ${stopReply('off')}` })
})

test('cli: a codex exec resume of a live TUI session keeps the TUI as its host, so a stop from ! acts', async (t) => {
  const w = world(t)
  w.alive.add(HOST_PID)
  const tui = await w.broker()
  const exec = await w.broker({ hostKind: 'exec', hostPid: 5000 })
  const host = (): unknown[] => [w.state().attended, w.state().hostKind, w.state().hostPid]
  assert.deepEqual(host(), [true, 'tui', HOST_PID])
  await exec.end()
  w.reading(SID, 92, { reset: RESET })
  const h = tui.call('tool')
  await w.settle()
  assert.equal(h.box.done, false)
  assert.deepEqual(await w.cli(['stop'], { CODEX_THREAD_ID: SID, CODEX_SESSION_ID: SID }), { code: 0, out: codexText.cliDone('stop') })
  assert.ok(w.state().stopped !== undefined, 'the stop is written')
  // Once the TUI is gone, the next host takes the fields.
  w.alive.delete(HOST_PID)
  await w.broker({ hostKind: 'exec', hostPid: 6000 })
  assert.deepEqual(host(), [false, 'exec', 6000])
})

test('cli: a named session is judged with the SPARE10_* values of its root broker, not of the terminal', async (t) => {
  // Scope opt-in, and the broker has SPARE10=on.
  const w = world(t, { config: { scope: 'opt-in' } })
  const b = await w.broker({ env: { SPARE10: 'on' } })
  assert.deepEqual(w.state().brokerEnv, { SPARE10: 'on' })
  w.reading(SID, 92, { reset: RESET })
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false)
  const r = await w.cli(['stop', '--session', SID])
  assert.notEqual(r.out, `spare10: ${stopReply('off')}`)
  assert.ok(w.state().stopped !== undefined, 'the stop is written')
  // A terminal with SPARE10=off still stops a guarded session.
  const v = world(t)
  await v.broker()
  v.reading(SID, 92, { reset: RESET })
  assert.match((await v.cli(['stop', '--session', SID], { SPARE10: 'off' })).out, /^spare10: stopped/)
  assert.ok(v.state().stopped !== undefined)
  // A broker with SPARE10_RESERVE=20 trips at 80%: at 85% the stop is written.
  const u = world(t)
  await u.broker({ env: { SPARE10_RESERVE: '20' } })
  u.reading(SID, 85, { reset: RESET })
  assert.match((await u.cli(['stop', '--session', SID])).out, /^spare10: stopped/)
  assert.ok(u.state().stopped !== undefined)
  // A junk record counts as none: the CLI takes its own env, with no error.
  const x = world(t, { config: { scope: 'opt-in' } })
  await x.broker({ env: { SPARE10: 'on' } })
  x.setState({ brokerEnv: 'junk' as unknown as Record<string, string> })
  x.reading(SID, 92, { reset: RESET })
  assert.match((await x.cli(['stop', '--session', SID], { SPARE10: 'on' })).out, /^spare10: stopped/)
})

test('cli: brokerEnvOf keeps the SPARE10_* values but SPARE10_SIMULATE, and withBrokerEnv takes a record that is no object as none', () => {
  assert.deepEqual(brokerEnvOf({ SPARE10: 'on', SPARE10_RESERVE: '20', SPARE10_SIMULATE: '50', HOME: '/h' }), { SPARE10: 'on', SPARE10_RESERVE: '20' })
  const env = { SPARE10: 'off', SPARE10_SIMULATE: '50', HOME: '/h' }
  for (const junk of ['x', [1], null, undefined, 5]) assert.equal(withBrokerEnv(env, junk), env)
  const e = withBrokerEnv(env, { SPARE10_RESERVE: '20', SPARE10: 5 })
  assert.equal(e['SPARE10_RESERVE'], '20')
  assert.equal(e['SPARE10'], undefined, 'an entry that is not a text counts as unset')
  assert.equal(e['SPARE10_SIMULATE'], undefined)
  assert.equal(e['HOME'], '/h')
})
