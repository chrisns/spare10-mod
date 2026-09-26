import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TestContext } from 'node:test'
import type { GateSite, HostKind } from '../../../hooks/core/codex.ts'
import type { Kind } from '../../../hooks/core/reading.ts'
import { createAttendance } from '../../src/attend.ts'
import { daemonLink } from '../../src/daemon.ts'
import type { DaemonLink } from '../../src/daemon.ts'
import type { HeldCall } from '../../src/held.ts'
import type { Env, Paths } from '../../src/paths.ts'
import { createQuestions } from '../../src/question.ts'
import type { QuestionDeps } from '../../src/question.ts'
import { createQuota } from '../../src/quota.ts'
import { createRefusal } from '../../src/refuse.ts'
import { createRollouts } from '../../src/rollout.ts'
import { createSense } from '../../src/sense.ts'
import type { SessionCtx } from '../../src/sense.ts'
import { createSettings } from '../../src/settings.ts'
import { sessionStore } from '../../src/store.ts'
import type { SessionState, SessionStore } from '../../src/store.ts'
import { createInterrupts, createSweep } from '../../src/sweep.ts'
import { fakeClock } from './clock.ts'
import type { FakeClock } from './clock.ts'
import { elicitResult } from './codex-host.ts'
import type { ElicitScript } from './codex-host.ts'
import { memoryLog } from './log.ts'
import type { MemoryLog } from './log.ts'
import { memoryDaemon } from './memory-daemon.ts'
import type { MemoryDaemon } from './memory-daemon.ts'
import { fakeRollout } from './rollout.ts'
import type { FakeRollout } from './rollout.ts'
import { tempDir } from './tmp.ts'
import { memoryWake } from './wake.ts'
import type { MemoryWake } from './wake.ts'

// The world of the logic specs (Codex design 8.2): the session modules of step 4 (sense, consent, stop,
// question, refuse, sweep) over real session files in a temp CODEX_HOME, with the fake clock, the memory
// Wake, the memory daemon and a fake MCP form. Each broker of the world is one thread of a session, with
// fake pids: a pid is alive while it is in `alive`. The gate is not here: the specs call the modules as
// the gate will.

export const T0 = Date.UTC(2026, 8, 26, 10)
export const SEC = 1_000
export const MIN = 60 * SEC
export const HOUR = 60 * MIN
export const SID = '01a0da06-c266-7842-bc97-1128f6549960'
export const CHILD = '01a0da07-0000-7000-8000-00000000c41d'
export const HOST_PID = 4000

/** An `account/rateLimits/read` result of the probed shape (quota 2.1). The resets are ms since the epoch. */
export function rateReply(o: {
  five?: number
  week?: number
  fiveReset: number
  weekReset?: number
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string | null } | null
  allowed?: boolean | null
}): unknown {
  const win = (pct: number | undefined, mins: number, reset: number) =>
    pct === undefined ? null : { usedPercent: pct, windowDurationMins: mins, resetsAt: Math.floor(reset / 1000) }
  const codex = {
    limitId: 'codex',
    limitName: null,
    primary: win(o.five, 300, o.fiveReset),
    secondary: win(o.week, 10080, o.weekReset ?? o.fiveReset + 3 * 24 * 3_600_000),
    credits: o.credits === undefined ? { hasCredits: false, unlimited: false, balance: '0' } : o.credits,
    spendControlReached: false,
    planType: 'prolite',
    rateLimitReachedType: null,
  }
  return { ordinaryUsageAllowed: o.allowed === undefined ? true : o.allowed, rateLimits: codex, rateLimitsByLimitId: { codex } }
}

/** The fake form of one broker: scripted answers, or pending ones that the spec answers. */
export type FakeMcp = QuestionDeps['mcp'] & {
  form: boolean
  /** The params of every elicitation, in order. */
  readonly requests: object[]
  /** Queues answers to the next elicitations (as codex-host.ts: resume, stop, cancel, decline, error, hang). */
  script(...answers: ElicitScript[]): void
  /** The elicitations that wait for an answer. */
  pending(): number
  /** Answers the oldest pending elicitation. */
  answer(a: Exclude<ElicitScript, 'hang'>): void
  /** The broker shuts down: every pending elicitation rejects. */
  shut(): void
}

export function fakeMcp(form = true): FakeMcp {
  const requests: object[] = []
  const queue: ElicitScript[] = []
  const open: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = []
  let closed = false
  const respond = (p: { resolve: (v: unknown) => void; reject: (e: Error) => void }, a: Exclude<ElicitScript, 'hang'>): void => {
    if (a === 'error') p.reject(new Error('elicitation failed'))
    else p.resolve(elicitResult(a))
  }
  const m: FakeMcp = {
    form,
    requests,
    canElicit: () => m.form,
    closed: () => closed,
    elicit(params) {
      requests.push(params)
      return new Promise<unknown>((resolve, reject) => {
        const p = { resolve, reject }
        const next = queue.shift()
        if (next === undefined || next === 'hang') open.push(p)
        else respond(p, next)
      })
    },
    script(...answers) {
      queue.push(...answers)
    },
    pending: () => open.length,
    answer(a) {
      const p = open.shift()
      if (p === undefined) throw new Error('no pending elicitation')
      respond(p, a)
    },
    shut() {
      closed = true
      for (const p of open.splice(0)) p.reject(new Error('the server shuts down'))
    },
  }
  return m
}

/** A held call that the spec can drop. */
export type TestCall = HeldCall & { ac: AbortController }

let nextCall = 0

export function heldCall(o: { id?: string | number; site?: GateSite; turn?: string; since?: number; prompt?: string } = {}): TestCall {
  nextCall += 1
  const ac = new AbortController()
  return {
    id: o.id ?? nextCall,
    site: o.site ?? 'tool',
    ...(o.turn === undefined ? { turn: 'U1' } : { turn: o.turn }),
    since: o.since ?? T0,
    dropped: ac.signal,
    drop: () => ac.abort(),
    holding: true,
    ...(o.prompt === undefined ? {} : { prompt: o.prompt }),
    ac,
  }
}

export type BrokerOpts = {
  sid?: string
  thread?: string
  pid?: number
  hostPid?: number
  hostKind?: HostKind
  env?: Env
  /** The rollout of the thread: a path, null (ephemeral), or undefined for the world's rollout of this thread. */
  transcript?: string | null
  /** The session_meta of a new rollout: the TUI's by default. */
  originator?: string
  source?: unknown
  form?: boolean
  mode?: string
  /** A nested run: the session of its parent (3.10). */
  parent?: string
}

export type LogicWorld = ReturnType<typeof logicWorld>

export function logicWorld(t: TestContext, o: { daemon?: boolean; config?: Record<string, unknown> } = {}) {
  const root = tempDir(t, 's10l')
  const data = join(root, 'data')
  const paths: Paths = { codexHome: root, data, pluginRoot: root, socket: join(root, 'daemon.sock'), launcher: join(data, 'bin', 'spare10'), bin: join(data, 'bin'), home: join(root, 'home') }
  const clock: FakeClock = fakeClock(T0)
  const wake: MemoryWake = memoryWake()
  const log: MemoryLog = memoryLog()
  const daemon: MemoryDaemon = memoryDaemon(clock)
  const link = { on: o.daemon ?? false }
  const alive = new Set<number>()
  const pidAlive = (p: number): boolean => alive.has(p)
  let nextPid = 100
  const rollouts = new Map<string, FakeRollout>()

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

  /** A reading of one kind in the rollout of `thread` (route C), observed at `at`. */
  const reading = (thread: string, pct: number, x: { kind?: Kind; reset?: number; at?: number; weekly?: number; weeklyReset?: number; credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string | null } } = {}): void => {
    const kind = x.kind ?? 'five_hour'
    const reset = x.reset ?? clock.now() + 2 * HOUR
    const win = kind === 'five_hour' ? { pct, mins: 300, resetsAt: reset } : { pct, mins: 10080, resetsAt: reset }
    const second = x.weekly === undefined ? null : { pct: x.weekly, mins: 10080, resetsAt: x.weeklyReset ?? clock.now() + 3 * 24 * HOUR }
    rollout(thread).tokenCount({
      at: x.at ?? clock.now(),
      primary: kind === 'five_hour' ? win : second,
      secondary: kind === 'five_hour' ? second : win,
      ...(x.credits === undefined ? {} : { credits: x.credits }),
    })
  }

  const store = (sid = SID, hostPid = HOST_PID, owner = 'test'): SessionStore => sessionStore(paths, sid, owner, wake, { clock, hostPid })

  /** Writes fields of a session's state.json under its lock. */
  const setState = (fields: Partial<SessionState>, sid = SID): void => {
    store(sid).locked((tx) => {
      Object.assign(tx.state, fields)
    })
  }

  function broker(b: BrokerOpts = {}) {
    const sid = b.sid ?? SID
    const thread = b.thread ?? sid
    const pid = b.pid ?? nextPid++
    alive.add(pid)
    const hostPid = b.hostPid ?? HOST_PID
    const hostKind = b.hostKind ?? 'tui'
    const owner = `broker-${pid}`
    const transcript =
      b.transcript === undefined ? rollout(thread, { ...(b.originator === undefined ? {} : { originator: b.originator }), ...(b.source === undefined ? {} : { source: b.source }) }).path : b.transcript
    const rolls = createRollouts()
    const dl: DaemonLink = daemonLink(() => (link.on ? daemon : undefined), clock)
    const quota = createQuota({ paths, clock, log, owner, daemon: dl, rollouts: rolls, pidAlive })
    const settings = createSettings({ paths, log, env: b.env ?? {}, parentChild: () => undefined, simulateKind: () => 'five_hour', hostKind })
    const attendance = createAttendance({ hostKind, rollouts: rolls })
    const sense = createSense({ clock, log, settings, quota, attendance })
    const interrupted: Array<[string, string]> = []
    const onInterrupted = (th: string, turn: string): void => void interrupted.push([th, turn])
    const interrupts = createInterrupts({ clock, log, daemon: dl, onInterrupted })
    const sweep = createSweep({ clock, log, daemon: dl, interrupts })
    const mcp = fakeMcp(b.form ?? true)
    const questions = createQuestions({ clock, wake, log, owner, pid, sense, settings, quota, rollouts: rolls, mcp, sweep, pidAlive })
    const refusal = createRefusal({ clock, wake, log, pid, sense, settings, quota, daemon: dl, rollouts: rolls, interrupts })
    const st = sessionStore(paths, sid, owner, wake, { clock, hostPid })
    const sx: SessionCtx = {
      sid,
      thread,
      root: thread === sid,
      transcript,
      hostPid,
      store: st,
      ...(b.parent === undefined ? {} : { parent: sessionStore(paths, b.parent, owner, wake, { clock, hostPid }) }),
      ...(b.mode === undefined ? {} : { mode: b.mode }),
    }
    const out = { sid, thread, pid, owner, sx, sense, sweep, interrupts, questions, refusal, mcp, quota, settings, rollouts: rolls, interrupted, daemonLink: dl }
    return out
  }

  return {
    root,
    data,
    paths,
    clock,
    wake,
    log,
    daemon,
    link,
    alive,
    config,
    rollout,
    reading,
    store,
    setState,
    state: (sid = SID): SessionState => store(sid).read(),
    broker,
    /** Moves time on and lets every chain run. */
    advance: (ms: number) => clock.advance(ms),
    settle: () => clock.settle(),
    file: (name: string, sid = SID) => join(data, 'sessions', sid, name),
    dirOf: (p: string) => dirname(p),
  }
}
