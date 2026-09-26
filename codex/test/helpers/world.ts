import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { liveOf } from '../../../hooks/core/codex.ts'
import type { GateSite, HostKind, LiveRead } from '../../../hooks/core/codex.ts'
import type { Kind } from '../../../hooks/core/reading.ts'
import { createBroker } from '../../src/broker.ts'
import type { Broker } from '../../src/broker.ts'
import { main as cliMain } from '../../src/cli.ts'
import type { Env, Paths } from '../../src/paths.ts'
import { sessionStore } from '../../src/store.ts'
import type { SessionState, SessionStore, ThreadState } from '../../src/store.ts'
import { readJson, writeJson } from '../../src/files.ts'
import { fakeClock, settleTurns } from './clock.ts'
import type { FakeClock } from './clock.ts'
import { codexHost } from './codex-host.ts'
import type { CodexHost, ElicitScript, GateHandle } from './codex-host.ts'
import { memoryLog } from './log.ts'
import type { MemoryLog } from './log.ts'
import { memoryDaemon } from './memory-daemon.ts'
import type { MemoryDaemon } from './memory-daemon.ts'
import { fakeRollout } from './rollout.ts'
import type { FakeRollout } from './rollout.ts'
import { tempDir } from './tmp.ts'
import { memoryWake } from './wake.ts'
import type { MemoryWake } from './wake.ts'

// The world of the broker specs (Codex design 8.2 world.ts): a temp CODEX_HOME with its data dir, and any
// number of brokers built with createBroker on in-memory streams, each played by a Codex double
// (codex-host.ts). They share the fake clock, the memory Wake, the memory daemon and a set of live fake
// pids. The locks run on real time with no contention across fake time (3.7). Every resolved path is
// under os.tmpdir(), and SPARE10_CODEX_TEST=1 is set: no spec reaches the real ~/.codex.

export const T0 = Date.UTC(2026, 8, 26, 10)
export const SEC = 1_000
export const MIN = 60 * SEC
export const HOUR = 60 * MIN
export const SID = '01a0da06-c266-7842-bc97-1128f6549960'
export const CHILD = '01a0da07-0000-7000-8000-00000000c41d'
export const HOST_PID = 4000

/** The command line of each kind of host process, for hostKindOf. */
const HOST_ARGS: Record<HostKind, string> = {
  tui: '/opt/homebrew/bin/codex',
  daemon: '/opt/homebrew/bin/codex app-server --listen unix:// --managed-daemon',
  'app-server': '/opt/homebrew/bin/codex app-server',
  exec: '/opt/homebrew/bin/codex exec TOOL',
  unknown: '',
}

export type BrokerOpts = {
  session?: string
  thread?: string
  pid?: number
  hostPid?: number
  hostKind?: HostKind
  env?: Env
  /** The daemon lists the thread as loaded. */
  hosted?: boolean
  /** The client can show a form. */
  form?: boolean
  /** The rollout of the thread: a path, null (ephemeral), or undefined for the world's rollout of this thread. */
  transcript?: string | null
  originator?: string
  source?: unknown
  /** The permission mode of every gate input. */
  mode?: string
  model?: string
  /** Runs the SessionStart gate of a root thread first and drops its answer (its start warnings). Default: true. */
  start?: boolean
}

export type Answer = { done: boolean; text?: string }

export type WorldBroker = {
  host: CodexHost
  broker: Broker
  sid: string
  thread: string
  pid: number
  hostPid: number
  transcript: string | null
  /** The gate input of a site. */
  args(site: GateSite, extra?: Record<string, unknown>): Record<string, unknown>
  /** A gate call: its id and its answer (tracked, so a spec can look while it holds). */
  call(site: GateSite, extra?: Record<string, unknown>): GateHandle & { box: Answer }
  /** A gate call that answers at once (after the world settles). It fails when the call still holds. */
  gate(site: GateSite, extra?: Record<string, unknown>): Promise<string>
  /** Codex drops the call: it stops waiting and ignores the late answer. */
  drop(id: number): void
  /** Scripted answers to the next forms of this broker. */
  script(...a: ElicitScript[]): void
  /** The forms this broker raised. */
  forms(): Array<Record<string, unknown>>
  /** Stdin EOF: the broker shuts down. */
  end(): Promise<void>
}

/** The answer text as JSON, `{}` for a pass. */
export const parsed = (text: string | undefined): Record<string, unknown> => (text === undefined || text === '' ? {} : (JSON.parse(text) as Record<string, unknown>))

export type World = ReturnType<typeof world>

export function world(t: TestContext, o: { daemon?: boolean; config?: Record<string, unknown>; env?: Env } = {}) {
  const root = tempDir(t, 's10w')
  const data = join(root, 'data')
  const plugin = join(root, 'plugin')
  const brokerFile = join(plugin, 'codex', 'dist', 'spare10.mjs')
  const cliFile = join(plugin, 'codex', 'dist', 'cli.mjs')
  const baseEnv: Env = { CODEX_HOME: root, SPARE10_CODEX_DATA: data, SPARE10_CODEX_TEST: '1', ...(o.env ?? {}) }
  const clock: FakeClock = fakeClock(T0)
  const wake: MemoryWake = memoryWake()
  const log: MemoryLog = memoryLog()
  const daemon: MemoryDaemon = memoryDaemon(clock)
  const hosted = new Set<string>()
  daemon.script.loaded = () => [...hosted]
  const link = { on: o.daemon ?? false }
  const alive = new Set<number>()
  const pidAlive = (p: number): boolean => alive.has(p)
  let nextPid = 100
  let nextTurn = 0
  const rollouts = new Map<string, FakeRollout>()
  const brokers: WorldBroker[] = []
  const tmp = realpathSync(tmpdir())

  const config = (c: Record<string, unknown>): void => {
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, 'config.json'), JSON.stringify(c))
  }
  if (o.config !== undefined) config(o.config)

  /** The rollout of a thread, made with its session_meta at first use. */
  const rollout = (thread: string, meta: { originator?: string; source?: unknown } = {}): FakeRollout => {
    let r = rollouts.get(thread)
    if (r === undefined) {
      r = fakeRollout(join(root, 'sessions', `rollout-${thread}.jsonl`))
      r.sessionMeta({ originator: meta.originator ?? 'codex-tui', source: meta.source ?? 'cli', id: thread })
      rollouts.set(thread, r)
    }
    return r
  }

  /** A reading of one kind in the rollout of `thread` (route C), observed now. `weekly`: a second window of the other kind. */
  const reading = (
    thread: string,
    pct: number,
    x: { kind?: Kind; reset?: number; at?: number; weekly?: number | null; weeklyReset?: number; credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string | null } } = {},
  ): void => {
    const kind = x.kind ?? 'five_hour'
    const reset = x.reset ?? clock.now() + 2 * HOUR
    const win = kind === 'five_hour' ? { pct, mins: 300, resetsAt: reset } : { pct, mins: 10080, resetsAt: reset }
    const second = x.weekly === undefined || x.weekly === null ? null : { pct: x.weekly, mins: 10080, resetsAt: x.weeklyReset ?? clock.now() + 3 * 24 * HOUR }
    rollout(thread).tokenCount({
      at: x.at ?? clock.now(),
      primary: kind === 'five_hour' ? win : second,
      secondary: kind === 'five_hour' ? second : null,
      ...(x.credits === undefined ? {} : { credits: x.credits }),
    })
  }

  /** Writes live.json: a good live read of this reply (rateReply of logic.ts) at `at`, as quota.ts does. `reads`: how many good reads in a row saw it (the blind rule). */
  const live = (reply: unknown, at = clock.now(), reads = 1): LiveRead => {
    const r = liveOf(reply, at, 'daemon')
    if ('error' in r) throw new Error(r.error)
    writeJson(join(data, 'live.json'), { ...r, v: 1, by: 'test', recent: Array.from({ length: reads }, () => r.codex ?? null) })
    return r
  }

  const store = (sid = SID, hostPid = HOST_PID): SessionStore => sessionStore({ data }, sid, 'test', wake, { clock, hostPid })
  const setState = (fields: Partial<SessionState>, sid = SID): void => {
    store(sid).locked((tx) => {
      Object.assign(tx.state, fields)
    })
  }
  const settle = async (): Promise<void> => {
    await clock.settle()
    await settleTurns(10)
  }

  async function broker(b: BrokerOpts = {}): Promise<WorldBroker> {
    const sid = b.session ?? SID
    const thread = b.thread ?? sid
    const pid = b.pid ?? nextPid++
    alive.add(pid)
    const hostPid = b.hostPid ?? HOST_PID
    const hostKind = b.hostKind ?? 'tui'
    const transcript =
      b.transcript === undefined
        ? rollout(thread, { ...(b.originator === undefined ? {} : { originator: b.originator }), ...(b.source === undefined ? {} : { source: b.source }) }).path
        : b.transcript
    if (b.hosted === true) hosted.add(thread)
    const host = codexHost()
    const br = createBroker({
      input: host.input,
      output: host.output,
      env: { ...baseEnv, ...(b.env ?? {}) },
      clock,
      wake,
      pid,
      ppid: hostPid,
      selfFile: brokerFile,
      parentArgs: () => HOST_ARGS[hostKind],
      daemon: () => (link.on ? daemon : undefined),
      pidAlive,
      log,
      nodePath: '/usr/local/bin/node',
    })
    for (const p of [br.paths.codexHome, br.paths.data, br.paths.socket, br.paths.launcher]) {
      assert.ok(p.startsWith(root) && (root.startsWith(tmp) || root.startsWith(tmpdir())), `spare10 test: ${p} is not under the temp folder`)
    }
    await host.initialize({ form: b.form ?? true })
    host.initialized()
    await settle()
    // Each prompt starts a new turn, unless the spec names one (a steer). The other sites run in the current turn.
    let turn = `U${thread.slice(-4)}-0`
    const args = (site: GateSite, extra: Record<string, unknown> = {}): Record<string, unknown> => {
      nextTurn += 1
      if (site === 'prompt' && extra['turn'] === undefined) turn = `U${thread.slice(-4)}-${nextTurn}`
      else if (typeof extra['turn'] === 'string') turn = extra['turn']
      return {
        site,
        session: sid,
        ...(site === 'start' ? {} : { turn }),
        transcript,
        mode: b.mode ?? 'default',
        model: b.model ?? 'gpt-5.5',
        cwd: '/tmp/x/proj',
        ...(site === 'tool' || site === 'step' ? { tool: 'exec_command', call: `call_${nextTurn}` } : {}),
        ...(site === 'start' ? { source: 'startup' } : {}),
        ...extra,
      }
    }
    const call = (site: GateSite, extra?: Record<string, unknown>): GateHandle & { box: Answer } => {
      const h = host.call(args(site, extra), thread)
      const box: Answer = { done: false }
      void h.answer.then((text) => {
        box.done = true
        if (text !== undefined) box.text = text
      })
      return { ...h, box }
    }
    const wb: WorldBroker = {
      host,
      broker: br,
      sid,
      thread,
      pid,
      hostPid,
      transcript,
      args,
      call,
      async gate(site, extra) {
        const h = call(site, extra)
        await settle()
        assert.ok(h.box.done, `the ${site} gate still holds`)
        return h.box.text ?? ''
      },
      drop: (id) => host.drop(id),
      script: (...a) => host.script(...a),
      forms: () => host.requests.filter((r) => r['method'] === 'elicitation/create'),
      async end() {
        host.end()
        await settle()
      },
    }
    brokers.push(wb)
    if (b.start !== false && thread === sid) {
      await wb.gate('start')
      store(sid).locked((tx) => {
        delete tx.state.notices
      })
    }
    t.after(async () => {
      await br.stop().catch(() => undefined)
    })
    return wb
  }

  /** Runs the CLI in this process, with the world's clock, daemon, pids and Wake. */
  const cli = async (argv: string[], env: Env = {}): Promise<{ code: number; out: string }> => {
    let out = ''
    const code = await cliMain(argv, {
      env: { ...baseEnv, ...env },
      stdout: { write: (s: string) => (out += s) },
      clock,
      selfFile: cliFile,
      daemon: () => (link.on ? daemon : undefined),
      pidAlive,
      pid: 90_000,
      log,
      wake,
    })
    await settle()
    return { code, out: out.replace(/\n$/, '') }
  }

  return {
    root,
    data,
    paths: { codexHome: root, data, pluginRoot: plugin, socket: join(root, 'app-server-control', 'app-server-control.sock'), launcher: join(data, 'bin', 'spare10'), bin: join(data, 'bin') } satisfies Paths,
    env: baseEnv,
    clock,
    wake,
    log,
    daemon,
    hosted,
    link,
    alive,
    brokers,
    config,
    rollout,
    reading,
    live,
    store,
    setState,
    state: (sid = SID): SessionState => store(sid).read(),
    thread: (tid: string, sid = SID): ThreadState | undefined => readJson<ThreadState>(join(data, 'sessions', sid, 'threads', `${tid}.json`)),
    file: (name: string, sid = SID): string => join(data, 'sessions', sid, name),
    broker,
    cli,
    settle,
    /** Moves time on, lets every chain run, and settles the streams. */
    advance: async (ms: number): Promise<void> => {
      await clock.advance(ms)
      await settle()
    },
    /** The notices queued for the root thread, oldest first. */
    notices: (sid = SID): string[] => (store(sid).read().notices ?? []).map((n) => n.text),
  }
}
