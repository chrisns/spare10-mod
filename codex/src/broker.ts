import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { codexDebug, codexLimits, hostKindOf, isGateSite, isObservation } from '../../hooks/core/codex.ts'
import type { CodexSnapshot } from '../../hooks/core/codex.ts'
import type { HostKind } from '../../hooks/core/codex.ts'
import { BLIND_AFTER } from '../../hooks/core/reading.ts'
import type { Kind } from '../../hooks/core/reading.ts'
import { VERSION } from '../../hooks/core/text.ts'
import { createAttendance, parentChildOf } from './attend.ts'
import type { Clock } from './clock.ts'
import { createCommands } from './commands.ts'
import { daemonLink } from './daemon.ts'
import type { Daemon } from './daemon.ts'
import { ensureDir, readJson } from './files.ts'
import { createGate } from './gate.ts'
import type { Gate, GateCall } from './gate.ts'
import { debugOn, fileLog } from './log.ts'
import type { Log } from './log.ts'
import { stdioServer } from './mcp.ts'
import type { McpServer, ToolCall } from './mcp.ts'
import { findPaths, testGuardOn, writeLauncher } from './paths.ts'
import type { Env, Paths } from './paths.ts'
import { createQuestions } from './question.ts'
import { createQuota } from './quota.ts'
import { createRefusal } from './refuse.ts'
import { createRollouts } from './rollout.ts'
import { createSense } from './sense.ts'
import { createSettings } from './settings.ts'
import { pruneSessions, sessionStore } from './store.ts'
import type { SessionStore } from './store.ts'
import { createInterrupts, createSweep } from './sweep.ts'
import type { Interrupts } from './sweep.ts'
import { createTicker } from './ticker.ts'
import type { Ticker } from './ticker.ts'
import { MIN_NODE_MAJOR } from './timing.ts'
import { fsWake } from './wake.ts'
import type { Wake } from './wake.ts'

// The broker (Codex design 3.1, 3.4, 7.2 broker.ts): one stdio MCP server per loaded thread. It wires the
// adapter modules together. The MCP server starts at once, so `initialize` answers before any file or
// network work. At `notifications/initialized` the background work starts: the data dir, the launcher, the
// host kind, the settings and the first live read. Each `gate` call gets a held call that the Interrupt
// gate, the broker's own `turn/interrupt` and a cancel can drop. At the shutdown every held call answers
// its site's refusal, never a pass.

export type BrokerDeps = {
  input: Readable
  output: Writable
  /** The broker env: the `env_vars` of codex/mcp.json and the few names that Codex keeps. */
  env: Env
  clock: Clock
  /** The Wake source. Default: fs.watch and a 1 s poll (fsWake). */
  wake?: Wake
  pid: number
  /** The Codex process that started the broker: the host of its thread. */
  ppid: number
  /** The running file (codex/dist/spare10.mjs): the plugin root is two folders above it. */
  selfFile: string
  parentArgs(pid: number): string
  daemon: (paths: Paths) => Daemon | undefined
  pidAlive(pid: number): boolean
  /** The debug log. Default: the file log, only with SPARE10_CODEX_DEBUG=1. */
  log?: Log
  /** The Node.js that the CLI launcher runs. Default: process.execPath. */
  nodePath?: string
  /** The Node.js version. Default: process.versions.node. */
  nodeVersion?: string
}

export type Broker = {
  /** Shuts down: the held calls answer their refusal, then the output is flushed. Idempotent. */
  stop(): Promise<void>
  /** Resolves when the server has shut down (stdin EOF, a failed output, or stop). */
  done: Promise<void>
  paths: Paths
  log: Log
  mcp: McpServer
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The part of the broker that exists once the background work has started. */
type Parts = { gate: Gate; ticker: Ticker; hostKind: HostKind; link: ReturnType<typeof daemonLink>; interrupts: Interrupts }

export function createBroker(d: BrokerDeps): Broker {
  const version = d.nodeVersion ?? process.versions.node
  const major = Number(version.split('.')[0])
  if (!(major >= MIN_NODE_MAJOR)) {
    throw new Error(`spare10: the broker needs Node.js ${MIN_NODE_MAJOR} or later. This is Node.js ${version}.`)
  }
  const paths = findPaths(d.env, d.selfFile)
  const log = d.log ?? fileLog(paths.data, debugOn(d.env), d.clock, { tag: `pid ${d.pid}` })
  const wake = d.wake ?? fsWake(d.clock, log)
  const clock = d.clock
  const owner = `broker-${d.pid}`
  const mcp = stdioServer(d.input, d.output, { name: 'spare10', version: VERSION }, log, { clock })

  /** The gate calls with no answer yet, by id. */
  const calls = new Map<string, GateCall>()
  /** The session of this broker's thread, from the first gate. */
  let session: string | undefined
  /** The kinds of the last root sense, for the simulate kind (A8). */
  let lastPresent: readonly Kind[] | undefined

  const stores = new Map<string, SessionStore>()
  const storeOf = (sid: string, o: { waitMs?: number } = {}): SessionStore => {
    const key = `${sid}\u0000${o.waitMs ?? ''}`
    let s = stores.get(key)
    if (s === undefined) {
      s = sessionStore(paths, sid, owner, wake, { clock, hostPid: d.ppid, ...(o.waitMs === undefined ? {} : { lock: { waitMs: o.waitMs } }) })
      stores.set(key, s)
    }
    return s
  }

  /**
   * A8: a SPARE10_SIMULATE with no kind word is weekly when the session has no 5-hour window: the kinds of
   * this broker's last root sense, else the presence count of the session, else the last good live reads
   * of the data dir (a new session has no count yet, and SPARE10_SIMULATE counts from its first gate).
   */
  const simulateKind = (): Kind => {
    const weekly = (present: readonly Kind[]): Kind => (!present.includes('five_hour') && present.includes('seven_day') ? 'seven_day' : 'five_hour')
    if (lastPresent !== undefined) return weekly(lastPresent)
    try {
      if (session !== undefined) {
        const count = storeOf(session).read().absentCount ?? {}
        if ((count.five_hour ?? 0) >= BLIND_AFTER && (count.seven_day ?? 0) < BLIND_AFTER) return 'seven_day'
      }
      const live = readJson<{ v?: unknown; recent?: unknown }>(join(paths.data, 'live.json'))
      const recent = Array.isArray(live?.recent) ? (live.recent as CodexSnapshot[]).slice(-BLIND_AFTER) : []
      const seen = recent.filter((r) => typeof r === 'object' && r !== null && isObservation(r)).map((r) => codexLimits(r).map((l) => l.kind as Kind))
      if (seen.length >= BLIND_AFTER && seen.every((ks) => weekly(ks) === 'seven_day')) return 'seven_day'
    } catch {
      // No hint: the 5-hour window.
    }
    return 'five_hour'
  }

  const dropTurn = (turn: string): number => {
    let n = 0
    for (const c of calls.values()) {
      if (c.site === 'interrupt' || c.turn !== turn || c.dropped.aborted) continue
      c.drop()
      n += 1
    }
    return n
  }

  /** 4.12 item 2: the broker's own `turn/interrupt` (or the sweep's) drops its calls of that thread and turn. */
  const onInterrupted = (thread: string, turn: string): void => {
    for (const c of calls.values()) if (c.site !== 'interrupt' && c.thread === thread && c.turn === turn && !c.dropped.aborted) c.drop()
  }

  let parts: Parts | undefined
  const boot = (): Parts => {
    if (parts !== undefined) return parts
    log.debug(codexDebug.boot(VERSION, testGuardOn(d.env)))
    const hostKind = hostKindOf(d.parentArgs(d.ppid))
    try {
      ensureDir(paths.data)
      writeLauncher(paths, d.nodePath ?? process.execPath)
    } catch (e) {
      log.debug(codexDebug.writeFailed(paths.launcher, errText(e)))
    }
    // At most once a day for each data dir: the session folders that nothing needs any more go.
    const pruned = pruneSessions(paths, owner, clock.now(), d.pidAlive)
    if (pruned.length > 0) log.debug(codexDebug.pruned(pruned.length))
    const rollouts = createRollouts()
    // A factory that throws (a socket that is not safe to dial, the test guard) is no daemon, with a debug line.
    const link = daemonLink(() => d.daemon(paths), clock, { log })
    const settings = createSettings({
      paths,
      log,
      env: d.env,
      parentChild: () => (session === undefined ? undefined : parentChildOf(paths, d.env, session)),
      simulateKind,
      hostKind,
    })
    const quota = createQuota({ paths, clock, log, owner, daemon: link, rollouts, pidAlive: d.pidAlive })
    const attendance = createAttendance({ hostKind, rollouts })
    const sense = createSense({ clock, log, settings, quota, attendance })
    // One interrupt per thread and turn in this broker, shared by the refusals, the sweep and the shutdown (4.4).
    const interrupts = createInterrupts({ clock, log, daemon: link, onInterrupted })
    const sweep = createSweep({ clock, log, daemon: link, interrupts })
    const questions = createQuestions({ clock, wake, log, owner, pid: d.pid, sense, settings, quota, rollouts, mcp, sweep, pidAlive: d.pidAlive })
    const refusal = createRefusal({ clock, wake, log, pid: d.pid, sense, settings, quota, daemon: link, rollouts, interrupts })
    const commands = createCommands({ paths, clock, log, owner, env: d.env, settings, quota, sense, questions, sweep, daemon: link, attendance, pidAlive: d.pidAlive })
    const ticker = createTicker({ clock, log, settings, quota, sense, attendance, daemon: link, sweep, pidAlive: d.pidAlive })
    const gate = createGate({
      paths,
      clock,
      log,
      owner,
      pid: d.pid,
      env: d.env,
      hostPid: d.ppid,
      hostKind,
      settings,
      quota,
      sense,
      attendance,
      questions,
      refusal,
      commands,
      ticker,
      daemon: link,
      pidAlive: d.pidAlive,
      storeOf,
      liveCalls: () => [...calls.values()],
      dropTurn,
      onSensed: (s) => {
        lastPresent = s.present
      },
    })
    parts = { gate, ticker, hostKind, link, interrupts }
    // The first live read of this broker, in the background (3.6). The first gate waits for it at most 2 s.
    void quota.live(30_000).catch((e: unknown) => log.debug(codexDebug.liveFailed('daemon', errText(e))))
    return parts
  }

  mcp.onReady(() => {
    try {
      boot()
    } catch (e) {
      log.debug(codexDebug.gateError(errText(e)))
    }
  })

  mcp.onCall(async (c: ToolCall) => {
    const p = boot()
    const args = isObject(c.args) ? c.args : {}
    if (session === undefined && typeof args['session'] === 'string' && args['session'] !== '') session = args['session']
    const site = isGateSite(args['site']) ? args['site'] : 'spawn'
    const turn = typeof args['turn'] === 'string' && args['turn'] !== '' ? args['turn'] : undefined
    const ac = new AbortController()
    const call: GateCall = {
      id: c.id,
      site,
      ...(turn === undefined ? {} : { turn }),
      since: clock.now(),
      dropped: ac.signal,
      drop: () => ac.abort(),
      attended: true,
      get holding(): boolean {
        return c.holding()
      },
      set holding(on: boolean) {
        c.setHolding(on, call.attended !== false)
      },
    }
    const key = `${typeof c.id}:${String(c.id)}`
    calls.set(key, call)
    try {
      return await p.gate(c.args, c.meta, call)
    } finally {
      if (calls.get(key) === call) calls.delete(key)
    }
  })

  mcp.onCancelled((id) => {
    calls.get(`${typeof id}:${String(id)}`)?.drop()
  })

  let closeStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    closeStarted = resolve
  })

  // 3.4 shutdown: a held call in a hosted thread is interrupted first, so no request follows its refusal.
  // The MCP server bounds this work (1 s), then answers every open call with its fallback.
  mcp.onClose(async () => {
    closeStarted()
    parts?.ticker.stop()
    const p = parts
    const sid = session
    if (p === undefined || sid === undefined) return
    if (p.link.get() === undefined) return
    const held = [...calls.values()].filter((c) => c.holding && c.attended !== false && c.turn !== undefined && c.thread !== undefined)
    for (const c of held) {
      const thread = c.thread as string
      const turn = c.turn as string
      if (!(await p.link.hosted(thread))) continue
      await p.interrupts.interrupt({ store: storeOf(sid) }, thread, turn)
    }
  })

  return {
    stop: () => mcp.close(),
    done: started.then(() => mcp.close()),
    paths,
    log,
    mcp,
  }
}
