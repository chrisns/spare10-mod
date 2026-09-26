// The end-to-end runs (Codex design 8.3): the real Codex 0.157.0 and the spare10 bundle, with the mock
// provider of mock_responses.py, in test homes that home.mjs makes. No model request leaves the machine, and
// no run reads or writes ~/.codex. run.sh starts the mock and calls this file:
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./codex/test/host-loader.mjs \
//     codex/e2e/scenarios.mjs --work <dir> [--smoke] [--only E3,E4]
//
// The loader gives the core texts the Codex host words, so the runs compare what Codex shows with the core.
// Each run gets its own home in <work>/<id>, and asserts the mock requests, the hook runs and the data dir.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { codexDebug, codexText, elicitParams, withPrefix } from '../../hooks/core/codex.ts'
import { VERSION } from '../../hooks/core/text.ts'
import { fakeDaemon } from '../test/helpers/uds-daemon.ts'
import { AppServer } from './client.mjs'
import { checkCodexVersion, codexEnv, dataDir, guardHome, HOOK_KEY_PREFIX, listHooks, makeHome, stagePlugin } from './home.mjs'

const EVENTS = ['session_start', 'user_prompt_submit', 'pre_tool_use', 'post_tool_use', 'pre_compact', 'subagent_start', 'stop', 'subagent_stop', 'interrupt']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The limits.json of the mock: the header map of Codex's rate limit headers. */
function limits({ five, weekly }) {
  const now = Math.floor(Date.now() / 1000)
  const out = {}
  const slot = (name, used, minutes, resetIn) => {
    out[`x-codex-${name}-used-percent`] = used
    out[`x-codex-${name}-window-minutes`] = minutes
    out[`x-codex-${name}-reset-at`] = now + resetIn
  }
  // Codex puts the 5-hour window in primary when it has one, else the weekly window (quota 2.1).
  if (five !== undefined) {
    slot('primary', five, 300, 4 * 3600)
    if (weekly !== undefined) slot('secondary', weekly, 10080, 3 * 86400)
  } else if (weekly !== undefined) slot('primary', weekly, 10080, 3 * 86400)
  return out
}

/** The world of one run: its home, the mock files and helpers. */
class World {
  constructor(work, id, made) {
    this.work = work
    this.id = id
    this.dir = join(work, id)
    this.home = made.home
    this.project = made.project
    this.data = dataDir(made.home)
  }

  setLimits(l) {
    writeFileSync(join(this.work, 'limits.json'), `${JSON.stringify(limits(l))}\n`)
  }

  /** The model requests that the mock logged since the start of this run. */
  requests() {
    const file = join(this.work, 'requests.jsonl')
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
      .filter((r) => r.n > this.firstRequest)
  }

  env(extra = {}) {
    return codexEnv(this.home, { SPARE10_CODEX_DEBUG: '1', ...extra })
  }

  /** A `codex app-server` over stdio in the project, initialized as `codex-tui`. */
  async appServer(extra = {}) {
    const s = AppServer.stdio({ env: this.env(extra), cwd: this.project, log: join(this.dir, 'client.jsonl'), stderr: join(this.dir, 'app-server.stderr') })
    this.closers.push(() => s.close())
    await s.initialize()
    return s
  }

  /**
   * `codex app-server --listen unix://` in the home: the daemon socket of the home (the Codex daemon without its
   * managed install, 9.1). Codex binds the socket in /tmp/codex-daemon-<uid> and links it from the home.
   */
  async daemon(extra = {}) {
    const link = join(this.home, 'app-server-control', 'app-server-control.sock')
    const child = spawn('codex', ['app-server', '--listen', 'unix://'], { env: this.env(extra), cwd: this.home, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr.pipe(createWriteStream(join(this.dir, 'daemon.stderr')))
    const closed = new Promise((r) => child.on('close', () => r()))
    this.closers.push(async () => {
      child.kill('SIGTERM')
      await Promise.race([closed, sleep(5000)])
      child.kill('SIGKILL')
    })
    const t0 = Date.now()
    for (;;) {
      try {
        const path = realpathSync(link)
        const s = await AppServer.socket({ path, log: join(this.dir, 'client.jsonl') })
        this.closers.push(() => s.close())
        await s.initialize()
        return { socket: path, client: s, child }
      } catch (e) {
        if (Date.now() - t0 > 20000) throw new Error(`the app-server socket did not come up: ${e instanceof Error ? e.message : e}`)
        await sleep(200)
      }
    }
  }

  async thread(s) {
    return (await s.startThread({ cwd: this.project, approvalPolicy: 'on-request', sandbox: 'read-only' })).id
  }

  /** A turn with one text input, to its end: the turn and the hook runs of that turn. */
  async turn(s, threadId, text, timeoutMs = 60000) {
    const turnId = await s.startTurn(threadId, text)
    const turn = await s.turnDone(turnId, timeoutMs)
    await s.quiet(300, 3000)
    return { turnId, turn, hooks: s.hooks.filter((h) => h.turnId === turnId) }
  }

  /** `codex exec` in the project: its exit code, stdout and stderr. */
  exec(args, extra = {}, timeoutMs = 90000) {
    return new Promise((res, rej) => {
      const child = spawn('codex', ['exec', ...args], { env: this.env(extra), cwd: this.project, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (c) => (out += c))
      child.stderr.on('data', (c) => (err += c))
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        rej(new Error(`codex exec did not end in ${timeoutMs} ms`))
      }, timeoutMs)
      child.on('close', (code) => {
        clearTimeout(timer)
        writeFileSync(join(this.dir, 'exec.stdout'), out)
        writeFileSync(join(this.dir, 'exec.stderr'), err)
        res({ code, out, err })
      })
    })
  }

  /** The state.json of a session, or of the only session. */
  state(sid) {
    const dir = join(this.data, 'sessions')
    const ids = existsSync(dir) ? readdirSync(dir) : []
    const id = sid ?? (ids.length === 1 ? ids[0] : undefined)
    if (id === undefined) throw new Error(`no single session in ${dir}: ${ids.join(', ')}`)
    return JSON.parse(readFileSync(join(dir, id, 'state.json'), 'utf8'))
  }

  /** A new world in `<dir>/<name>`, with its own home and data dir, on the same mock. */
  async sub(name) {
    const dir = join(this.dir, name)
    const made = await makeHome({ work: this.work, dir, log: join(dir, 'trust.jsonl') })
    const w = new World(this.work, this.id, made)
    w.dir = dir
    w.closers = this.closers
    w.firstRequest = this.firstRequest
    return w
  }

  /** The session ids of the data dir, oldest first. */
  sessions() {
    const dir = join(this.data, 'sessions')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .map((id) => ({ id, at: JSON.parse(readFileSync(join(dir, id, 'state.json'), 'utf8')).updatedAt ?? 0 }))
      .sort((a, b) => a.at - b.at)
      .map((x) => x.id)
  }

  readData(name) {
    const file = join(this.data, name)
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
  }
}

// ---- Checks on what Codex shows ----

/** The runs of one hook event (camel case, as `hook/completed` names it). */
const runsOf = (hooks, event) => hooks.filter((h) => h.run.eventName === event)

/** The one `userPromptSubmit` run of a turn. */
function promptRun(hooks) {
  const runs = runsOf(hooks, 'userPromptSubmit')
  assert.equal(runs.length, 1, `one userPromptSubmit run, got ${runs.length}`)
  return runs[0].run
}

/** A `userPromptSubmit` run that blocked the prompt: its reason. */
function blockedWith(hooks) {
  const run = promptRun(hooks)
  assert.equal(run.status, 'blocked', `the prompt is blocked, status ${run.status}`)
  const fb = run.entries.filter((e) => e.kind === 'feedback')
  assert.equal(fb.length, 1, `one feedback entry: ${JSON.stringify(run.entries)}`)
  return fb[0].text
}

/** The user texts of a model request (the prompts, not Codex's own tagged context). */
const userTexts = (req) =>
  req.input
    .filter((i) => i.type === 'message' && i.role === 'user')
    .flatMap((i) => (i.content ?? []).filter((c) => c.type === 'input_text').map((c) => c.text))
    .filter((t) => !t.trimStart().startsWith('<'))

/** Every text of a model request, with its role. */
const allTexts = (req) =>
  req.input.flatMap((i) => {
    if (i.type === 'message') return (i.content ?? []).filter((c) => typeof c.text === 'string').map((c) => ({ role: i.role, text: c.text }))
    if (i.type === 'function_call_output') return [{ role: 'tool', text: typeof i.output === 'string' ? i.output : JSON.stringify(i.output) }]
    return []
  })

/** No spare10 text reached the model. The scratch paths hold "spare10-mod", so the check looks for "spare10: ". */
function noSpare10Text(reqs) {
  for (const r of reqs) {
    for (const t of allTexts(r)) assert.ok(!t.text.includes('spare10: '), `request ${r.n} holds a spare10 text: ${t.text.slice(0, 200)}`)
  }
}

// ---- The runs ----

/** E1: install and trust. Nine trusted mcp_tool hooks, no warning, and the spare10 MCP server. */
async function e1(w) {
  const s = await w.appServer()
  const { hooks, warnings, errors } = await listHooks(s, w.project)
  assert.deepEqual(warnings, [], 'hooks/list has no warning')
  assert.deepEqual(errors, [], 'hooks/list has no error')
  assert.deepEqual(hooks.map((h) => h.key).sort(), EVENTS.map((e) => `${HOOK_KEY_PREFIX}${e}:0:0`).sort(), 'the nine spare10 hooks')
  for (const h of hooks) {
    assert.equal(h.handlerType, 'mcpTool', `${h.key} is an mcp_tool hook`)
    assert.equal(h.trustStatus, 'trusted', `${h.key} is trusted`)
    assert.equal(h.server, 'spare10', `${h.key} calls the spare10 server`)
    assert.equal(h.tool, 'gate', `${h.key} calls the gate tool`)
  }
  const r = await runCodex(w, ['mcp', 'list', '--json'])
  const servers = JSON.parse(r)
  const mcp = servers.find((x) => x.name === 'spare10')
  assert.ok(mcp !== undefined, 'codex mcp list names spare10')
  assert.equal(mcp.enabled, true, 'spare10 is enabled')
  assert.equal(mcp.tool_timeout_sec, 691200, 'tool_timeout_sec is 691200')
  assert.equal(mcp.startup_timeout_sec, 30, 'startup_timeout_sec is 30')
  assert.equal(mcp.transport.command, '/bin/sh')
  assert.deepEqual(mcp.transport.args, ['./codex/bin/broker.sh'])
  // `codex mcp list` does not print `required`, so the run reads the file that Codex loaded.
  const installed = mcp.transport.cwd.replace(/\/\.$/, '')
  assert.ok(installed.startsWith(join(w.home, 'plugins', 'cache', 'spare10', 'spare10')), `the server runs from the plugin cache: ${installed}`)
  const file = JSON.parse(readFileSync(join(installed, 'codex', 'mcp.json'), 'utf8'))
  assert.equal(file.mcpServers.spare10.required, true, 'the installed codex/mcp.json says required')
  return `9 hooks trusted, spare10 required with tool_timeout_sec 691200`
}

function runCodex(w, args) {
  return new Promise((res, rej) => {
    const child = spawn('codex', args, { env: w.env(), cwd: w.project, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`codex ${args.join(' ')}: ${code}: ${err}`))))
  })
}

/** E2: `codex exec 'TOOL'` at 50% of a weekly-only plan. The tool runs, two requests, spare10 stays out of sight. */
async function e2(w) {
  w.setLimits({ weekly: 50 })
  const r = await w.exec(['TOOL'])
  assert.equal(r.code, 0, `codex exec exits 0: ${r.err.slice(-500)}`)
  assert.match(r.err, /^exec\n.*echo e2e/m, 'the tool ran')
  assert.match(r.err, /succeeded in \d+ms:\ne2e\n/, 'the tool output is e2e')
  assert.equal(r.out.trim(), 'done', 'the final message is done')
  const reqs = w.requests()
  assert.equal(reqs.length, 2, `2 model requests, got ${reqs.length}`)
  assert.ok(reqs[1].input.some((i) => i.type === 'function_call_output'), 'request 2 has the tool output')
  noSpare10Text(reqs)
  const statuses = [...r.err.matchAll(/^hook: (\w+) (\w+)$/gm)].map((m) => [m[1], m[2]])
  assert.deepEqual(
    statuses.map(([e]) => e),
    ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'],
    `the hook runs of the turn: ${JSON.stringify(statuses)}`,
  )
  for (const [e, st] of statuses) assert.equal(st, 'Completed', `${e} completed`)
  assert.ok(!r.out.includes('spare10: ') && !r.err.includes('spare10: '), 'codex exec shows no spare10 text')
  const st = w.state()
  assert.equal(st.hostKind, 'exec', 'the broker knows codex exec')
  assert.equal(st.attended, false, 'codex exec is unattended')
  assert.equal(st.stopped, undefined, 'no stop')
  assert.equal(w.readData('seed.json')?.seven_day?.pct, 50, 'seed.json has the weekly reading')
  // D10: Codex passes SPARE10_CODEX_TEST through env_vars, so the broker it started has the guard on.
  const logDir = join(w.data, 'log')
  const logs = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), 'utf8')).join('')
  assert.ok(logs.includes(codexDebug.boot(VERSION, true)), 'the broker that Codex started has the test guard on')
  assert.ok(!logs.includes(codexDebug.boot(VERSION, false)), 'no broker ran without the test guard')
  return `2 requests, hooks ${statuses.map(([e]) => e).join(' ')} all Completed, test guard on`
}

/** The 2.2 form schema, from the core. */
const FORM_SCHEMA = elicitParams('').requestedSchema

/** E3 and E4: a typed test reading at 92%, then a prompt that asks. */
async function askAtPrompt(w, answer) {
  w.setLimits({ five: 10, weekly: 50 })
  const s = await w.appServer()
  const th = await w.thread(s)
  const sim = await w.turn(s, th, 'spare10 simulate 92')
  const simReply = blockedWith(sim.hooks)
  assert.match(simReply, /^spare10: test reading set to 92% used, resets \d{2}:\d{2}\. It can only raise the real reading\. The reserve opens at \d{2}:\d{2}, 20 min before the test window ends\. Run spare10 simulate off to clear it\.$/, `the simulate reply: ${simReply}`)
  assert.equal(w.requests().length, 0, 'a command sends no model request')
  s.answers.push(answer)
  const hello = await w.turn(s, th, 'hello')
  assert.equal(s.elicitations.length, 1, `one form, got ${s.elicitations.length}`)
  const form = s.elicitations[0].params
  assert.equal(form.serverName, 'spare10')
  assert.equal(form.mode, 'form')
  assert.equal(form.turnId, hello.turnId, 'the form belongs to the hello turn')
  assert.deepEqual(form.requestedSchema, FORM_SCHEMA, 'the form has the 2.2 schema')
  const b2 =
    'Your 10% reserve is reached: 92% used · 8% left · resets HH:MM. spare10 holds your prompt and any other work. ' +
    'Continue on the reserve until 95% used? Until HH:MM, spare10 asks you again at 95% used. If you do not answer, ' +
    'all of it continues at HH:MM, 20 min before the test window ends, unless a reserve is still reached. ' +
    'Stop here drops your prompt and pauses other work until HH:MM.'
  assert.match(form.message, hhmm(b2), `the B2 message: ${form.message}`)
  // The first root gate (SessionStart) shows CX6 (no daemon here) and, once per data dir, CX19.
  const start = runsOf(s.hooks, 'sessionStart')
  assert.equal(start.length, 1, 'one sessionStart run')
  const bin = join(w.data, 'bin')
  assert.deepEqual(
    start[0].run.entries,
    [{ kind: 'warning', text: withPrefix(`${codexText.noDaemon(true)}\n${codexText.cliHint(join(bin, 'spare10'), bin)}`) }],
    'SessionStart shows CX6 and CX19',
  )
  assert.ok(s.resolved.includes(s.elicitations[0].id), 'Codex resolved the form')
  assert.equal(promptRun(hello.hooks).status === 'blocked', answer === 'stop', 'Stop here blocks the prompt, Resume lets it in')
  return { s, th, hello, form }
}

async function e3(w) {
  const { hello } = await askAtPrompt(w, 'resume')
  assert.equal(hello.turn.status, 'completed')
  const note = promptRun(hello.hooks).entries
  assert.equal(note.length, 1, `one line after the Resume: ${JSON.stringify(note)}`)
  assert.equal(note[0].kind, 'warning')
  assert.match(note[0].text, /^spare10: continuing on your 10% reserve until 95% used\. Until \d{2}:\d{2}, spare10 asks you again at 95% used\.$/, 'notice.continuing')
  const reqs = w.requests()
  assert.equal(reqs.length, 1, `1 model request, got ${reqs.length}`)
  assert.deepEqual(userTexts(reqs[0]).at(-1), 'hello', 'the request carries the prompt')
  const st = w.state()
  const c = st.test?.consent?.five_hour
  assert.equal(c?.floor?.to, 95, `the Resume consent goes to 95% (the floor): ${JSON.stringify(st.test)}`)
  assert.equal(st.consent, undefined, 'a Resume on a test reading writes no real consent')
  return `form answered resume, 1 request, test consent to 95%`
}

async function e4(w) {
  const { hello } = await askAtPrompt(w, 'stop')
  const reason = blockedWith(hello.hooks)
  assert.match(reason, /^spare10: not started\. This session is inside your 10% reserve until \d{1,2}:\d{2}\. Send the prompt again to be asked again, or run spare10 resume\.$/, `the notStarted text: ${reason}`)
  assert.equal(w.requests().length, 0, 'Stop here sends no model request')
  const st = w.state()
  const [sid, until, at, tags] = (st.stopped ?? '').split(' ')
  assert.equal(sid, st.sessionId, `a stop record of this session: ${st.stopped}`)
  assert.ok(Number(until) > Number(at), `the stop ends later: ${st.stopped}`)
  const t = (tags ?? '').split(',')
  assert.ok(t.includes('five_hour') && t.includes('test') && !t.includes('work'), `a test stop of the 5-hour window, with no work: ${st.stopped}`)
  return `form answered stop, prompt blocked with notStarted, 0 requests`
}

/** E5: typed commands are blocked with their replies, an ordinary prompt that starts with Spare10 is not. */
async function e5(w) {
  w.setLimits({ five: 10, weekly: 50 })
  const s = await w.appServer()
  const th = await w.thread(s)
  const status = blockedWith((await w.turn(s, th, 'spare10')).hooks)
  assert.ok(status.startsWith(`spare10: version ${VERSION}\n`), `the report: ${status.slice(0, 200)}`)
  assert.ok(!status.includes('spare10: spare10'), 'no double prefix')
  const set = blockedWith((await w.turn(s, th, 'spare10 set reserve 15')).hooks)
  assert.equal(set, `spare10: ${codexText.setOk('reserve', '15', '10')}`)
  const off = blockedWith((await w.turn(s, th, 'spare10 simulate off')).hooks)
  assert.equal(off, 'spare10: test reading cleared. Consent and stop for this window are cleared too.')
  assert.equal(w.requests().length, 0, 'the three commands send no model request')
  assert.equal(w.readData('config.json')?.reserve, 15, 'config.json has reserve 15')
  const plain = await w.turn(s, th, 'Spare10 is slow today')
  assert.equal(promptRun(plain.hooks).status, 'completed', 'an ordinary prompt passes')
  assert.equal(plain.turn.status, 'completed')
  const reqs = w.requests()
  assert.equal(reqs.length, 1, `the ordinary prompt reaches the model once, got ${reqs.length}`)
  assert.equal(userTexts(reqs[0]).at(-1), 'Spare10 is slow today')
  return `3 commands blocked, config.json reserve 15, the ordinary prompt made 1 request`
}

/** E5s: a steered `spare10 status` during a turn runs, shows its reply, and lets the turn go on. */
async function e5s(w) {
  w.setLimits({ five: 10, weekly: 50 })
  const s = await w.appServer()
  const th = await w.thread(s)
  const turnId = await s.startTurn(th, 'SLOW')
  // Steer while the SLOW request is in flight.
  const t0 = Date.now()
  while (w.requests().length === 0) {
    if (Date.now() - t0 > 20000) throw new Error('the SLOW request did not come')
    await sleep(100)
  }
  await sleep(300)
  const steered = await s.steer(th, turnId, 'spare10 status')
  assert.equal(steered, turnId, 'the steer joins the running turn')
  const turn = await s.turnDone(turnId, 60000)
  await s.quiet(300, 3000)
  assert.equal(turn.status, 'completed', 'the turn completes normally')
  const prompts = runsOf(s.hooks.filter((h) => h.turnId === turnId), 'userPromptSubmit').map((h) => h.run)
  assert.equal(prompts.length, 2, `two userPromptSubmit runs in the turn, got ${prompts.length}`)
  const steer = prompts[1]
  assert.equal(steer.status, 'completed', `the steered command does not block: ${steer.status}`)
  const warn = steer.entries.filter((e) => e.kind === 'warning').map((e) => e.text)
  assert.equal(warn.length, 1, `one systemMessage entry: ${JSON.stringify(steer.entries)}`)
  assert.ok(warn[0].startsWith(`spare10: version ${VERSION}\n`), `the systemMessage is the prefixed report: ${warn[0].slice(0, 120)}`)
  assert.ok(warn[0].split('\n').every((l) => l === '' || l.startsWith('spare10: ')), 'each line has the prefix')
  const reqs = w.requests()
  assert.equal(reqs.length, 2, `2 model requests, got ${reqs.length}`)
  const texts = allTexts(reqs[1]).map((t) => t.text)
  assert.ok(texts.includes('spare10 status'), 'request 2 has the steered line')
  assert.ok(texts.some((t) => t.includes(codexText.steerNote)), `request 2 holds CX4: ${JSON.stringify(texts.slice(-4))}`)
  assert.ok(!allTexts(reqs[0]).some((t) => t.text.includes(codexText.steerNote)), 'request 1 does not')
  return `steer ran in turn ${turnId.slice(0, 8)}, reply as systemMessage, request 2 holds CX4`
}

/** The turn-start and hook messages of one turn, for a failure message. */
const story = (s, turnId) =>
  s.hooks
    .filter((h) => h.turnId === turnId)
    .map((h) => `${h.run.eventName}:${h.run.status}${h.run.entries.length > 0 ? `:${JSON.stringify(h.run.entries).slice(0, 300)}` : ''}`)
    .join(' | ')

/** The stop record of a state: its parts. */
function stopOf(st) {
  const [sid, until, at, tags] = (st.stopped ?? '').split(' ')
  return { sid, until: Number(until), at: Number(at), tags: (tags ?? '').split(',') }
}

/** The `interrupt` run of a turn: its transcript lines. */
function interruptLines(s, turnId) {
  const runs = runsOf(s.hooks.filter((h) => h.turnId === turnId), 'interrupt')
  assert.equal(runs.length, 1, `one Interrupt run: ${story(s, turnId)}`)
  return runs[0].run.entries.filter((e) => e.kind === 'warning').map((e) => e.text)
}

/** The stop line of an auto stop with work (notice.stopped). */
const STOPPED_WORK = /^spare10: stopped at your 10% reserve until \d{2}:\d{2}, 20 min before the reset\. Then spare10 continues the work, unless a reserve is still reached\. Type a prompt to be asked again, or run spare10 resume\.$/

/** The B2 text of a question that a held step raised (loop opener, hold mode). */
const B2_LOOP =
  'Your 10% reserve is reached: 92% used · 8% left · resets HH:MM. All work is on hold. Continue on the reserve until 95% used? ' +
  'Until HH:MM, spare10 asks you again at 95% used. If you choose Stop here or do not answer, the work waits until HH:MM, ' +
  '20 min before the reset. Then spare10 continues it, unless a reserve is still reached.'

const hhmm = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('HH:MM', '\\d{2}:\\d{2}')}$`)

/** Waits until `f()` is true, at most `ms`. */
async function until(f, ms, what) {
  const t0 = Date.now()
  while (!(await f())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms: ${what}`)
    await sleep(200)
  }
}

/** E6: on the daemon socket, the second tool of TOOL2 asks. Stop here interrupts the turn with no further request. */
async function e6(w) {
  w.setLimits({ five: 92, weekly: 50 })
  const { client: s } = await w.daemon()
  const th = await w.thread(s)
  s.answers.push('stop')
  const turnId = await s.startTurn(th, 'TOOL2')
  const turn = await s.turnDone(turnId, 60000)
  await s.quiet(1000, 5000)
  assert.equal(s.elicitations.length, 1, `one form: ${story(s, turnId)}`)
  const form = s.elicitations[0].params
  assert.equal(form.threadId, th)
  assert.equal(form.turnId, turnId)
  assert.deepEqual(form.requestedSchema, FORM_SCHEMA)
  assert.match(form.message, hhmm(B2_LOOP), `the B2 message of a held step: ${form.message}`)
  // The first PreToolUse passes (no reading yet), the request after the tool too. The second PreToolUse asks.
  const started = s.messages.filter((x) => x.m.method === 'hook/started' && x.m.params.turnId === turnId).map((x) => x.m.params.run.eventName)
  assert.deepEqual(started.filter((e) => e === 'preToolUse').length, 2, `two PreToolUse runs: ${started}`)
  assert.equal(turn.status, 'interrupted', `the turn is interrupted: ${turn.status}`)
  const reqs = w.requests()
  assert.deepEqual(reqs.map((r) => r.kind), ['tool1', 'tool2'], 'no request after the stop')
  const lines = interruptLines(s, turnId)
  assert.ok(lines.some((t) => STOPPED_WORK.test(t)), `the Interrupt run shows the stop line: ${JSON.stringify(lines)}`)
  const st = w.state()
  const stop = stopOf(st)
  assert.ok(stop.sid === st.sessionId && stop.tags.includes('five_hour') && stop.tags.includes('work') && stop.tags.includes('auto'), `an auto stop with work: ${st.stopped}`)
  assert.ok(st.interrupts?.[turnId] !== undefined, 'spare10 recorded its interrupt')
  return `form at the second tool, Stop here interrupted the turn, 2 requests`
}

/**
 * The test reading of E7 to E9, set in the middle of a turn: a turn whose first reply comes after 3 s, and the
 * CLI `spare10 simulate <words> --session <id>` from a terminal while it waits. The first tool then trips. A
 * steer cannot do it: Codex 0.157 runs the UserPromptSubmit hook of a steered line only at the next request.
 */
async function midTurnTest(w, s, th, words) {
  const n0 = w.requests().length
  const turnId = await s.startTurn(th, 'SLOWTOOL 3')
  await until(() => w.requests().length > n0, 20000, 'the SLOWTOOL request')
  const cli = await runCli(w, ['simulate', ...words.split(' '), '--session', th])
  assert.equal(cli.code, 0, `the CLI simulate exits 0: ${cli.out}`)
  assert.match(cli.out, /^spare10: test reading set to 92% used/, `the CLI simulate reply: ${cli.out}`)
  return turnId
}

/** E7: on the daemon, a stopped turn with work continues by itself at the end of a test window: CX39 and B34. */
async function e7(w) {
  w.setLimits({ five: 10, weekly: 50 })
  const { client: s } = await w.daemon()
  const th = await w.thread(s)
  const set = blockedWith((await w.turn(s, th, 'spare10 set lastMinutes 0')).hooks)
  assert.equal(set, `spare10: ${codexText.setOk('lastMinutes', '0', '20')}`)
  s.answers.push('stop')
  const turnId = await midTurnTest(w, s, th, '92 in 20s')
  const turn = await s.turnDone(turnId, 60000)
  assert.equal(s.elicitations.length, 1, `one form: ${story(s, turnId)}`)
  assert.equal(turn.status, 'interrupted', 'Stop here interrupts the turn')
  const stoppedAt = Date.now()
  const n = w.requests().length
  // The test window ends in 20 s, the test margin is 60 s, and the root ticker looks every 30 s.
  const next = await s.waitFor((m) => m.method === 'turn/started' && m.params.threadId === th && m.params.turn.id !== turnId, {
    timeoutMs: 150000,
    what: 'the continuation turn',
  })
  const took = (Date.now() - stoppedAt) / 1000
  const nextId = next.params.turn.id
  const done = await s.turnDone(nextId, 60000)
  assert.equal(done.status, 'completed')
  const msg = await s.waitFor((m) => m.method === 'item/completed' && m.params.turnId === nextId && m.params.item.type === 'userMessage', { seen: true, what: 'the user message of the continuation' })
  const text = msg.params.item.content.map((c) => c.text).join('')
  assert.ok(text.startsWith(`${codexText.interruptedNote} `), `the continuation starts with CX39: ${text}`)
  assert.match(text, /, so the stop at the quota reserve is over\. spare10 is set to continue the work at the reset, so do not wait for the user\. Continue the task from the point where it stopped\. /, `B34: ${text}`)
  const reqs = w.requests().slice(n)
  assert.equal(reqs.length, 1, `the continuation makes one request: ${reqs.map((r) => r.kind)}`)
  assert.ok(userTexts(reqs[0]).includes(text), 'the model reads the continuation')
  assert.ok(took >= 70 && took <= 130, `the continuation came ${took.toFixed(0)} s after the stop`)
  const st = w.state()
  assert.equal(st.stopped, undefined, 'the stop is over')
  return `the continuation turn started ${took.toFixed(0)} s after Stop here, with CX39 and B34`
}

/** E8: with no daemon (stdio app-server), Stop here holds the tool in place, and it runs after the test margin. */
async function e8(w) {
  w.setLimits({ five: 10, weekly: 50 })
  const s = await w.appServer()
  const th = await w.thread(s)
  blockedWith((await w.turn(s, th, 'spare10 set lastMinutes 0')).hooks)
  // A first turn, so that the session log has a real reading (LCX2 does the same). Codex 0.157 writes the
  // reading of a request only after its tool round, and a release in place needs a reading.
  assert.equal((await w.turn(s, th, 'hello')).turn.status, 'completed')
  const n = w.requests().length
  s.answers.push('stop')
  const turnId = await midTurnTest(w, s, th, '92 in 20s')
  await until(() => s.resolved.length === 1, 30000, 'the form and its answer')
  const stoppedAt = Date.now()
  await sleep(3000)
  assert.equal(s.turns.get(turnId), undefined, 'the turn still runs: the tool is held')
  assert.equal(w.requests().length, n + 1, 'no request while the tool is held')
  assert.ok(!s.messages.some((x) => x.m.method === 'item/started' && x.m.params.item?.type === 'commandExecution'), 'the tool has not run')
  const turn = await s.turnDone(turnId, 150000)
  const took = (Date.now() - stoppedAt) / 1000
  assert.equal(turn.status, 'completed', 'the turn completes')
  assert.ok(s.messages.some((x) => x.m.method === 'item/completed' && x.m.params.item?.type === 'commandExecution' && x.m.params.item.exitCode === 0), 'the tool ran')
  const reqs = w.requests().slice(n)
  assert.equal(reqs.length, 2, `only the normal follow-up: ${reqs.map((r) => r.kind)}`)
  assert.ok(reqs[1].input.some((i) => i.type === 'function_call_output'), 'the follow-up has the tool output')
  assert.ok(took >= 70 && took <= 130, `the tool ran ${took.toFixed(0)} s after Stop here`)
  const lines = s.hooks.filter((h) => h.turnId === turnId).flatMap((h) => h.run.entries.filter((e) => e.kind === 'warning').map((e) => e.text))
  assert.ok(lines.some((t) => t.includes('Held work continues.')), `the release line: ${JSON.stringify(lines)}`)
  return `the held tool ran ${took.toFixed(0)} s after Stop here, 2 requests`
}

/** E9: approval never, so no form can show: the question is declined, the call holds, and the CLI resume releases it. */
async function e9(w) {
  w.setLimits({ five: 10, weekly: 50 })
  const s = await w.appServer()
  const th = (await s.startThread({ cwd: w.project, approvalPolicy: 'never', sandbox: 'read-only' })).id
  const turnId = await midTurnTest(w, s, th, '92')
  await sleep(6000)
  assert.equal(s.elicitations.length, 0, 'no form reaches the client')
  assert.equal(s.turns.get(turnId), undefined, `the turn still runs: ${story(s, turnId)}`)
  assert.equal(w.requests().length, 1, 'no request while the call holds')
  const st = w.state()
  assert.ok(st.stopped !== undefined && st.stopMeta?.noDialog === true, `a held stop: ${st.stopped} ${JSON.stringify(st.stopMeta)}`)
  const cli = await runCli(w, ['resume'], { CODEX_SESSION_ID: st.sessionId })
  assert.equal(cli.code, 0, `the CLI resume exits 0: ${cli.out}`)
  assert.ok(cli.out.startsWith('spare10: '), `the CLI reply: ${cli.out}`)
  const turn = await s.turnDone(turnId, 30000)
  assert.equal(turn.status, 'completed')
  assert.ok(s.messages.some((x) => x.m.method === 'item/completed' && x.m.params.item?.type === 'commandExecution' && x.m.params.item.exitCode === 0), 'the tool ran')
  assert.equal(w.requests().length, 2, 'the follow-up request')
  return `declined form, held stop, the CLI resume ran the tool`
}

/** The CLI through the launcher that the broker wrote, from a terminal (no CODEX_THREAD_ID). */
function runCli(w, args, extra = {}) {
  return new Promise((res) => {
    const child = spawn(join(w.data, 'bin', 'spare10'), args, { env: w.env(extra), cwd: w.project, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (out += c))
    child.on('close', (code) => res({ code, out }))
  })
}

/** E11: codex exec and the unattended policies stop, wait and prompt, each in a home of its own (no seed of another run). */
async function e11(root) {
  const notes = []
  // stop: the second tool trips on the real reading. Its deny text reaches the model, and the run ends.
  let w = await root.sub('stop')
  w.setLimits({ five: 92, weekly: 50 })
  let n = w.requests().length
  let r = await w.exec(['TOOL2'], { SPARE10_HEADLESS: 'stop' })
  assert.equal(r.code, 0, `stop: exit 0: ${r.err.slice(-400)}`)
  let reqs = w.requests().slice(n)
  const denied = reqs.at(-1)
  const sid = w.sessions().at(-1)
  assert.ok(
    denied !== undefined && allTexts(denied).some((t) => t.role === 'tool' && t.text.includes('spare10 stopped this unattended run at the quota reserve') && t.text.includes(`To pick it up later: codex exec resume ${sid}.`)),
    `stop: the last request holds the deny text: ${reqs.map((x) => x.kind)}`,
  )
  assert.match(r.err, /^hook: PreToolUse Blocked$/m, 'stop: the second tool is denied')
  assert.match(r.err, /^hook: Stop Stopped$/m, 'stop: the Stop hook ends the turn')
  notes.push(`stop denied the tool (${reqs.length} requests)`)
  // wait: a test reading from the start holds the first request, and releases it after the test margin.
  w = await root.sub('wait')
  w.setLimits({ five: 10, weekly: 50 })
  // A first run leaves a real reading in seed.json. With no reading at all, a held first request can never
  // get one (the reading comes with a request), and spare10 releases nothing without a reading (3.6).
  assert.equal((await w.exec(['hello'])).code, 0, 'wait: the first run')
  assert.equal(w.readData('seed.json')?.five_hour?.pct, 10, 'wait: seed.json has the real reading')
  n = w.requests().length
  const t0 = Date.now()
  r = await w.exec(['TOOL'], { SPARE10_HEADLESS: 'wait', SPARE10_SIMULATE: '92 in 15s', SPARE10_LAST_MINUTES: '0' }, 180000)
  const took = (Date.now() - t0) / 1000
  assert.equal(r.code, 0, `wait: exit 0: ${r.err.slice(-400)}`)
  reqs = w.requests().slice(n)
  assert.equal(reqs.length, 2, `wait: the tool and the follow-up: ${reqs.map((x) => x.kind)}`)
  const firstAfter = (reqs[0].t * 1000 - t0) / 1000
  assert.ok(firstAfter >= 60, `wait: the first request came ${firstAfter.toFixed(0)} s after the start`)
  noSpare10Text(reqs)
  notes.push(`wait held the first request ${firstAfter.toFixed(0)} s`)
  // prompt: the wind-down text as the context of the first tool, so request 2 holds it.
  w = await root.sub('prompt')
  w.setLimits({ five: 10, weekly: 50 })
  n = w.requests().length
  r = await w.exec(['TOOL'], { SPARE10_HEADLESS: 'prompt', SPARE10_SIMULATE: '92' })
  assert.equal(r.code, 0, `prompt: exit 0: ${r.err.slice(-400)}`)
  reqs = w.requests().slice(n)
  assert.equal(reqs.length, 2, `prompt: 2 requests: ${reqs.map((x) => x.kind)}`)
  const dev = allTexts(reqs[1]).filter((t) => t.role === 'developer' && t.text.includes('spare10'))
  assert.ok(dev.length > 0, `prompt: request 2 holds the developer message: ${JSON.stringify(allTexts(reqs[1]).slice(-3))}`)
  notes.push('prompt told the model')
  return notes.join(', ')
}

/** The turn of a thread, when its `turn/completed` comes. */
async function threadTurnDone(s, threadId, ms) {
  const m = await s.waitFor((x) => x.method === 'turn/completed' && x.params.threadId === threadId, { seen: true, timeoutMs: ms, what: `a turn end of ${threadId}` })
  return m.params.turn
}

/** E10: a subagent's first tool asks, with the child's thread id, while the root is idle. Resume runs the child's tool. On the daemon, Stop here interrupts both turns. */
async function e10(root) {
  // Resume, with no daemon. The child's first request waits 5 s, so the test reading comes after the root's turn.
  let w = await root.sub('resume')
  w.setLimits({ five: 10, weekly: 50 })
  let s = await w.appServer()
  let th = await w.thread(s)
  s.answers.push('resume')
  const rootTurn = await s.startTurn(th, 'SPAWN SLOWTOOL 5')
  assert.equal((await s.turnDone(rootTurn, 30000)).status, 'completed', 'the root turn ends: the root is idle')
  await until(() => w.requests().some((r) => r.kind === 'slowtool'), 20000, "the child's first request")
  let cli = await runCli(w, ['simulate', '92', '--session', th])
  assert.equal(cli.code, 0, `the CLI simulate: ${cli.out}`)
  await until(() => s.elicitations.length > 0, 30000, "the child's form")
  const form = s.elicitations[0].params
  assert.notEqual(form.threadId, th, 'the form has the thread id of the child')
  const child = form.threadId
  assert.match(form.message, hhmm(B2_LOOP.replace('before the reset', 'before the test window ends')), `the B2 message of a held step: ${form.message}`)
  const childTurn = await threadTurnDone(s, child, 30000)
  assert.equal(childTurn.status, 'completed', "the child's turn completes")
  assert.ok(s.messages.some((x) => x.m.method === 'item/completed' && x.m.params.threadId === child && x.m.params.item?.type === 'commandExecution' && x.m.params.item.exitCode === 0), "the child's tool ran")
  assert.equal(s.elicitations.length, 1, 'one form')
  assert.deepEqual(w.requests().map((r) => r.kind).sort(), ['done', 'done', 'slowtool', 'spawn'], `the requests: ${w.requests().map((r) => r.kind)}`)
  const st = w.state(th)
  assert.equal(st.test?.consent?.five_hour?.floor?.to, 95, `the Resume consent: ${JSON.stringify(st.test)}`)
  // Stop here, on the daemon. The root still waits for its last reply, so both turns run when the child asks.
  w = await root.sub('stop')
  w.setLimits({ five: 10, weekly: 50 })
  const d = await w.daemon()
  s = d.client
  th = await w.thread(s)
  s.answers.push('stop')
  const n0 = w.requests().length
  const rootTurn2 = await s.startTurn(th, 'SPAWN 40 SLOWTOOL 5')
  await until(() => w.requests().slice(n0).some((r) => r.kind === 'slowtool'), 20000, "the child's first request")
  cli = await runCli(w, ['simulate', '92', '--session', th])
  assert.equal(cli.code, 0, `the CLI simulate: ${cli.out}`)
  await until(() => s.elicitations.length > 0, 30000, "the child's form")
  const child2 = s.elicitations[0].params.threadId
  assert.notEqual(child2, th, 'the child leads')
  const [r2, c2] = await Promise.all([s.turnDone(rootTurn2, 30000), threadTurnDone(s, child2, 30000)])
  assert.equal(c2.status, 'interrupted', "the child's turn is interrupted")
  assert.equal(r2.status, 'interrupted', "the root's turn is interrupted (the stop sweep)")
  const n1 = w.requests().length
  await sleep(3000)
  assert.equal(w.requests().length, n1, 'no request after the stop')
  assert.ok(!w.requests().slice(n0).some((r) => r.kind === 'done' && r.input.some((i) => i.type === 'function_call_output' && JSON.stringify(i).includes('e2e'))), "the child's tool never ran")
  return `the child led one form, Resume ran its tool; on the daemon Stop here interrupted both turns`
}

/** The daemon answer of `account/rateLimits/read` for E12. */
const rateLimitsRead = (allowed) => {
  const now = Math.floor(Date.now() / 1000)
  const snap = {
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: now + 4 * 3600 },
    secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: now + 3 * 86400 },
    credits: null,
    planType: 'plus',
    rateLimitReachedType: allowed ? null : 'rate_limit_reached',
  }
  return { rateLimits: snap, rateLimitsByLimitId: { codex: snap }, ordinaryUsageAllowed: allowed }
}

/** E12: the Luna Reserve model passes every gate while the daemon says that ordinary usage is not allowed (A7). */
async function e12(root) {
  const run = async (name, allowed) => {
    const w = await root.sub(name)
    const cfg = join(w.home, 'config.toml')
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('model = "mock-model"', 'model = "gpt-reserve"'))
    const fake = await fakeDaemon({ after: (fn) => void w.closers.push(fn) }, { codexHome: w.home, handlers: { 'account/rateLimits/read': () => rateLimitsRead(allowed) } })
    w.setLimits({ five: 10, weekly: 50 })
    const s = await w.appServer()
    const th = await w.thread(s)
    const sim = blockedWith((await w.turn(s, th, 'spare10 simulate 99')).hooks)
    assert.match(sim, /^spare10: test reading set to 99% used/, `the simulate reply: ${sim}`)
    s.answers.push('stop')
    const t = await w.turn(s, th, 'TOOL')
    assert.ok(fake.calls.some((c) => c.method === 'account/rateLimits/read'), 'the broker read the daemon')
    return { w, s, t }
  }
  const off = await run('reserve', false)
  assert.equal(off.s.elicitations.length, 0, 'no form on Luna Reserve')
  assert.equal(off.t.turn.status, 'completed')
  for (const h of off.t.hooks) assert.equal(h.run.status, 'completed', `${h.run.eventName} passes: ${JSON.stringify(h.run.entries)}`)
  const reqs = off.w.requests()
  assert.deepEqual(reqs.map((r) => r.kind), ['tool', 'done'], 'the tool runs')
  assert.ok(reqs.every((r) => r.model === 'gpt-reserve'), 'the requests use gpt-reserve')
  // The same with ordinary usage allowed: the reserve model is gated as usual, so the prompt asks.
  const on = await run('allowed', true)
  assert.equal(on.s.elicitations.length, 1, 'with ordinary usage allowed, the prompt asks')
  assert.equal(promptRun(on.t.hooks).status, 'blocked', 'Stop here blocks the prompt')
  return 'gpt-reserve passed every gate with allowed false, and was asked with allowed true'
}

/**
 * E13: on the daemon, the root polls a shell command that yields (write_stdin, no gate), and its child runs
 * TOOL2 (after 7 s) on a reading in the reserve. The child's second tool asks. Stop here: the stop sweep interrupts the
 * root's polling turn, so the requests stop within one poll interval (5 s).
 */
async function e13(w) {
  w.setLimits({ five: 10, weekly: 50 })
  const childLimits = join(w.work, 'limits-TOOL2.json')
  writeFileSync(childLimits, `${JSON.stringify(limits({ five: 92, weekly: 50 }))}\n`)
  w.closers.push(async () => rmSync(childLimits, { force: true }))
  const { client: s } = await w.daemon()
  const th = await w.thread(s)
  s.answers.push('stop')
  const n0 = w.requests().length
  const rootTurn = await s.startTurn(th, 'LONGSPAWN')
  await until(() => s.elicitations.length > 0, 30000, "the child's form")
  const stopAt = Date.now()
  const child = s.elicitations[0].params.threadId
  assert.notEqual(child, th, 'the child asks')
  const kinds = () => w.requests().slice(n0).map((r) => r.kind)
  assert.ok(kinds().includes('tool2'), `the child's second tool asks: ${kinds()}`)
  const [r, c] = await Promise.all([s.turnDone(rootTurn, 30000), threadTurnDone(s, child, 30000)])
  assert.equal(c.status, 'interrupted', "the child's turn is interrupted")
  assert.equal(r.status, 'interrupted', "the root's polling turn is interrupted (the stop sweep)")
  const n1 = w.requests().length
  await sleep(7000)
  assert.equal(w.requests().length, n1, `no request after the stop: ${kinds()}`)
  const last = w.requests().at(-1)
  assert.ok(last.t * 1000 - stopAt < 5500, `the requests stopped within one poll interval: ${((last.t * 1000 - stopAt) / 1000).toFixed(1)} s`)
  assert.ok(!w.requests().slice(n0).some((x) => allTexts(x).some((t) => t.text.includes('long-done'))), 'the shell command never finished in the turn')
  const polls = kinds().filter((k) => k === 'poll').length
  assert.ok(polls >= 2, `the root polled while the child worked: ${kinds()}`)
  return `the sweep ended the polling root turn after ${polls} polls, no request after the stop`
}

export const SCENARIOS = [
  { id: 'E1', set: 'smoke', title: 'install and trust', run: e1 },
  { id: 'E2', set: 'smoke', title: 'codex exec below the reserve', run: e2 },
  { id: 'E3', set: 'smoke', title: 'a prompt question, Resume', run: e3 },
  { id: 'E4', set: 'smoke', title: 'a prompt question, Stop here', run: e4 },
  { id: 'E5', set: 'smoke', title: 'typed commands', run: e5 },
  { id: 'E5s', set: 'smoke', title: 'a steered command', run: e5s },
  { id: 'E6', set: 'full', title: 'Stop here on the daemon', run: e6 },
  { id: 'E7', set: 'full', title: 'the continuation at the end of a stop', run: e7 },
  { id: 'E8', set: 'full', title: 'a hold in place with no daemon', run: e8 },
  { id: 'E9', set: 'full', title: 'approval never: a held stop and the CLI resume', run: e9 },
  { id: 'E10', set: 'full', title: 'a subagent asks', run: e10 },
  { id: 'E11', set: 'full', title: 'codex exec and the unattended policies', run: e11 },
  { id: 'E12', set: 'full', title: 'Luna Reserve passes', run: e12 },
  { id: 'E13', set: 'full', title: 'the stop sweep ends a polling turn', run: e13 },
]

async function runOne(work, sc) {
  const dir = join(work, sc.id)
  const made = await makeHome({ work, dir, log: join(dir, 'trust.jsonl') })
  const w = new World(work, sc.id, made)
  w.closers = []
  const reqFile = join(work, 'requests.jsonl')
  w.firstRequest = existsSync(reqFile) ? Math.max(0, ...readFileSync(reqFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).n)) : 0
  try {
    return await sc.run(w)
  } finally {
    for (const c of w.closers.reverse()) await c().catch(() => undefined)
    guardHome(made.home)
  }
}

async function main(argv) {
  let work
  let only
  let smoke = false
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--work') work = argv[++i]
    else if (a === '--only') only = new Set(argv[++i].split(','))
    else if (a === '--smoke') smoke = true
    else throw new Error(`unknown argument ${a}`)
  }
  if (work === undefined || !existsSync(join(work, 'port'))) throw new Error('usage: scenarios.mjs --work <dir with the mock port> [--smoke] [--only E1,E2]')
  if (process.env.SPARE10_CODEX_TEST !== '1') throw new Error('e2e: set SPARE10_CODEX_TEST=1 (run.sh does)')
  checkCodexVersion()
  stagePlugin(join(work, 'stage'))
  const list = SCENARIOS.filter((s) => (only === undefined ? !smoke || s.set === 'smoke' : only.has(s.id)))
  let failed = 0
  for (const sc of list) {
    const t0 = Date.now()
    try {
      const note = await runOne(work, sc)
      process.stdout.write(`ok   ${sc.id.padEnd(4)} ${sc.title} (${((Date.now() - t0) / 1000).toFixed(1)} s): ${note}\n`)
    } catch (e) {
      failed += 1
      process.stdout.write(`FAIL ${sc.id.padEnd(4)} ${sc.title} (${((Date.now() - t0) / 1000).toFixed(1)} s): ${e instanceof Error ? e.message : String(e)}\n`)
      process.stdout.write(`     logs: ${join(work, sc.id)}\n`)
    }
  }
  process.stdout.write(`${list.length - failed} of ${list.length} end-to-end runs passed\n`)
  return failed === 0 ? 0 : 1
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (e) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
    process.exitCode = 1
  },
)
