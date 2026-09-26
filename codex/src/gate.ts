import { closeSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { codexDebug, codexText, offQuota, parseCommand, render, rootOnly, withPrefix } from '../../hooks/core/codex.ts'
import type { Command, GateResult, GateSite, HostKind, LiveRead } from '../../hooks/core/codex.ts'
import { childHeadless } from '../../hooks/core/config.ts'
import { parseStopped } from '../../hooks/core/decide.ts'
import type { Answered } from '../../hooks/core/decide.ts'
import { factsFrom, modeOf, namedKinds, notStartedFor, refusalText, tellText } from '../../hooks/core/flow.ts'
import type { Acted, Sensed } from '../../hooks/core/flow.ts'
import type { Facts } from '../../hooks/core/text.ts'
import { HEADLESS_GENERIC, NOT_STARTED_GENERIC, STOP_GENERIC, notPerson, resetContext, resumeContext } from '../../hooks/core/text.ts'
import type { AttendanceSource } from './attend.ts'
import { nestedParent, noteOriginator } from './attend.ts'
import type { Commands } from './commands.ts'
import type { DaemonLink } from './daemon.ts'
import type { Deps } from './deps.ts'
import { ensureDir, readJson } from './files.ts'
import { callId, readThread, removeHeld, threadIds } from './held.ts'
import type { HeldCall } from './held.ts'
import type { Env } from './paths.ts'
import type { Quota } from './quota.ts'
import type { Questions } from './question.ts'
import type { Refusal } from './refuse.ts'
import type { CodexSensed, SenseApi, SessionCtx } from './sense.ts'
import type { SettingsSource } from './settings.ts'
import { markWork, noticeIn, takeOverdueStop } from './stop.ts'
import { warnOnce } from './store.ts'
import type { SessionState, SessionStore } from './store.ts'
import type { Ticker } from './ticker.ts'

// The gate (Codex design 3.3, 4.2, 4.10, 4.12, 4.22, 7.2 gate.ts). Each hook handler of codex/hooks.json
// calls the hidden MCP tool `gate`, and this module answers it: the Codex form of the tool.call, turn.step,
// prompt.submit and command.run hooks of register.tsx. It binds the call to its session and thread, runs
// the first root gate work once, and then the site's own steps. The answer is decided inside `try`. The
// `finally` only cleans up and adds the queued transcript lines of the root thread: it never replaces a
// decided answer. A failure while the call holds answers the site's refusal (fail closed), any other
// failure passes (fail open).

/** A gate call: a held call, with its thread once bound. */
export type GateCall = HeldCall & { thread?: string }

/** The input of the gate tool (3.3). */
export type GateInput = {
  site: GateSite
  session: string
  turn?: string
  transcript: string | null
  mode?: string
  model: string
  cwd: string
  source?: string
  prompt?: string
  tool?: string
  call?: string
  trigger?: string
  agent?: string
  agentType?: string
  active?: boolean
}

export type Gate = (args: unknown, meta: Record<string, unknown>, call: GateCall) => Promise<string>

export type GateDeps = Pick<Deps, 'paths' | 'clock' | 'log' | 'owner' | 'pid'> & {
  env: Env
  /** The Codex process that hosts this broker's thread (the broker's parent). */
  hostPid: number
  hostKind: HostKind
  settings: Pick<SettingsSource, 'get'>
  quota: Pick<Quota, 'awaitFirstRead'>
  sense: SenseApi
  attendance: AttendanceSource
  questions: Pick<Questions, 'ensureQuestion' | 'waitQuestion' | 'answeredOf' | 'answerFor' | 'openQuestion'>
  refusal: Pick<Refusal, 'refusal'>
  commands: Pick<Commands, 'run'>
  ticker: Pick<Ticker, 'start'>
  daemon: Pick<DaemonLink, 'hosted'>
  pidAlive: (pid: number) => boolean
  /** The store of a session. `waitMs`: a shorter lock wait (the Interrupt gate waits at most 500 ms). */
  storeOf: (sid: string, o?: { waitMs?: number }) => SessionStore
  /** The calls of this broker that have no answer yet. */
  liveCalls: () => readonly GateCall[]
  /** Marks the held calls of this broker of `turn` as dropped (4.12 item 1). The number it dropped. */
  dropTurn: (turn: string) => number
  /** Each sense of a root gate, for the settings of this broker (the simulate kind, A8). */
  onSensed?: (s: CodexSensed) => void
}

const SITES: readonly GateSite[] = ['start', 'prompt', 'tool', 'step', 'compact', 'spawn', 'stop', 'interrupt']

/** The Interrupt gate answers within 3 s, so it waits at most this long for the session lock (4.12). */
export const INTERRUPT_LOCK_MS = 500

/** A thread keeps the turn ids of its last prompt gates, for the steer rule (3.7, 4.10). */
const PROMPT_TURNS_KEPT = 8

/** The model's own question tool: it spends no quota, and the step after it is gated (3.3). */
export const QUESTION_TOOL = 'request_user_input'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The hand-written guard of 3.3. The site and the session are required. A field of the wrong type is
 * left out, and `transcript` that is not a text is null. Unknown input is undefined: the gate passes.
 */
export function parseGateInput(args: unknown): GateInput | undefined {
  if (!isObject(args)) return undefined
  const site = args['site']
  const session = args['session']
  if (typeof site !== 'string' || !SITES.includes(site as GateSite)) return undefined
  if (typeof session !== 'string' || session === '') return undefined
  const out: GateInput = {
    site: site as GateSite,
    session,
    transcript: typeof args['transcript'] === 'string' && args['transcript'] !== '' ? args['transcript'] : null,
    model: text(args['model']) ?? '',
    cwd: text(args['cwd']) ?? '',
  }
  for (const k of ['turn', 'mode', 'source', 'prompt', 'tool', 'call', 'trigger', 'agent', 'agentType'] as const) {
    const v = text(args[k])
    if (v !== undefined && (v !== '' || k === 'prompt')) out[k] = v
  }
  if (typeof args['active'] === 'boolean') out.active = args['active']
  return out
}

/** The refusal of a call that holds when the gate fails (4.2): the site's refusal with the generic text. */
export function genericRefusal(site: GateSite, attended: boolean): GateResult {
  switch (site) {
    case 'prompt':
      return { kind: 'block', text: attended ? NOT_STARTED_GENERIC : HEADLESS_GENERIC }
    case 'tool':
    case 'step':
      return { kind: 'deny', text: attended ? STOP_GENERIC : HEADLESS_GENERIC }
    case 'stop':
    case 'compact':
      return { kind: 'end' }
    default:
      return { kind: 'pass' }
  }
}

/** The verb of a command, as notPerson names it. */
const verbOf = (c: Command): string => (c.verb === 'unknown' || c.verb === 'unknownOption' ? 'set' : c.verb)

/** An answer of one site: the result, and the transcript lines it carries besides the queued ones (a steered command). */
type Answer = { r: GateResult; message?: string }

const PASS: Answer = { r: { kind: 'pass' } }
const pass = (context?: string): Answer => (context === undefined || context === '' ? PASS : { r: { kind: 'pass', context } })

export function createGate(d: GateDeps): Gate {
  /** The sessions whose first root gate ran in this broker (4.22). */
  const started = new Set<string>()

  const markHolding = (call: GateCall, attended: boolean): void => {
    call.attended = attended
    call.holding = true
  }

  /** live.json as it is, for the Luna rule (A7). A file that does not read is no live read. */
  const liveFile = (): LiveRead | undefined => {
    try {
      const v = readJson<unknown>(join(d.paths.data, 'live.json'))
      return isObject(v) && v['v'] === 1 && typeof v['at'] === 'number' ? (v as unknown as LiveRead) : undefined
    } catch {
      return undefined
    }
  }
  const luna = (input: GateInput): boolean => offQuota(input.model, liveFile(), d.clock.now())

  /** A held entry is stale when its broker is dead, or it is this broker's and names no live call (4.2, 4.21). */
  const staleIn = (mine: ReadonlySet<string>) => (e: { call: string; brokerPid: number }): boolean =>
    e.brokerPid === d.pid ? !mine.has(e.call) : !d.pidAlive(e.brokerPid)

  /**
   * 4.2 bind: the thread file takes this broker's pids and the transcript, merged under the lock, and the
   * stale held entries go (a root gate cleans every thread of the session). It never drops a held entry
   * of a live broker. A held person prompt of a dead broker in the root thread queues CX18 (4.21). It
   * reads first, and locks only when something changes. Best effort: a failure only logs.
   */
  const merge = (sx: SessionCtx, input: GateInput): void => {
    const keepTranscript = !(input.site === 'stop' && input.agent !== undefined) // SubagentStop names the parent's rollout
    const mine = new Set(d.liveCalls().map((c) => callId(c)))
    const stale = staleIn(mine)
    const tids = sx.root ? [...new Set([sx.thread, ...threadIds(sx.store)])] : [sx.thread]
    const needs = tids.some((tid) => {
      const th = readThread(sx.store, tid)
      if (tid === sx.thread) {
        if (th === undefined || th.brokerPid !== d.pid || th.hostPid !== d.hostPid) return true
        if (keepTranscript && th.transcript !== sx.transcript) return true
        return th.held.some(stale)
      }
      return th !== undefined && th.held.some((e) => e.brokerPid !== d.pid && !d.pidAlive(e.brokerPid))
    })
    if (!needs) return
    const now = d.clock.now()
    sx.store.locked((tx) => {
      for (const tid of tids) {
        const th = tx.thread(tid)
        if (tid === sx.thread) {
          th.brokerPid = d.pid
          th.hostPid = d.hostPid
          if (keepTranscript) th.transcript = sx.transcript
        }
        const gone = th.held.filter((e) => (tid === sx.thread ? stale(e) : e.brokerPid !== d.pid && !d.pidAlive(e.brokerPid)))
        if (gone.length === 0) continue
        th.held = th.held.filter((e) => !gone.includes(e))
        if (sx.root && tid === sx.sid && gone.some((e) => e.site === 'prompt' && e.brokerPid !== d.pid)) noticeIn(tx.state, codexText.promptLost, now)
      }
    })
  }

  /** 4.2 bind: the session context of the call. The thread is `_meta.threadId`, else `agent`, else the session. */
  const bind = (input: GateInput, meta: Record<string, unknown>): SessionCtx => {
    const tid = text(meta['threadId'])
    const thread = tid !== undefined && tid !== '' ? tid : (input.agent ?? input.session)
    const store = d.storeOf(input.session, input.site === 'interrupt' ? { waitMs: INTERRUPT_LOCK_MS } : undefined)
    const parent = nestedParent(d.env, input.session)
    const sx: SessionCtx = {
      sid: input.session,
      thread,
      root: thread === input.session,
      transcript: input.transcript,
      hostPid: d.hostPid,
      store,
      ...(parent === undefined ? {} : { parent: d.storeOf(parent) }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    }
    if (input.site !== 'interrupt') {
      try {
        merge(sx, input)
      } catch (e) {
        d.log.debug(codexDebug.writeFailed(`the thread file of ${thread}`, errText(e)))
      }
    }
    return sx
  }

  /** 4.22 step 4, CX19: once per data dir, at the first attended root gate. A stamp file makes it once. */
  const cliHintOnce = (sx: SessionCtx, now: number): void => {
    const stamp = join(d.paths.data, 'cli-hint')
    try {
      ensureDir(d.paths.data)
      closeSync(openSync(stamp, 'wx', 0o600))
    } catch (e) {
      if ((e as { code?: unknown }).code !== 'EEXIST') d.log.debug(codexDebug.writeFailed(stamp, errText(e)))
      return
    }
    sx.store.locked((tx) => noticeIn(tx.state, codexText.cliHint(d.paths.launcher, d.paths.bin), now))
  }

  /**
   * 4.22: the first gate of the root thread, once per session in this broker. The session state gets the
   * host and the attendance, the child policy (B37), the warnings of 2.5 once per session, CX19 once per
   * data dir, and the root ticker starts. SPARE10_SIMULATE takes effect at the first root sense (4.18).
   */
  const firstRootGate = async (sx: SessionCtx, input: GateInput): Promise<void> => {
    started.add(sx.sid)
    d.ticker.start(sx)
    const cfg = d.settings.get()
    const att = d.attendance.attended({ transcript: sx.transcript }, input.mode)
    const guarded = att.attended && cfg.enabled
    const hosted = guarded ? await d.daemon.hosted(sx.thread).catch(() => false) : false
    const now = d.clock.now()
    sx.store.locked((tx) => {
      const st = tx.state
      st.hostPid = d.hostPid
      st.hostKind = d.hostKind
      st.transcript = sx.transcript
      st.attended = att.attended
      if (guarded) {
        const child = childHeadless(cfg.headless, d.env.SPARE10_HEADLESS !== undefined)
        if (child === undefined) delete st.child
        else st.child = child
      }
      for (const w of cfg.warnings) warnOnce(st, `cfg:${w}`, w, now)
      if (guarded && !hosted) warnOnce(st, cfg.autoResume ? 'CX6' : 'CX7', codexText.noDaemon(cfg.autoResume), now)
      if (guarded && input.mode === 'bypassPermissions') warnOnce(st, 'CX8', codexText.approvalNever, now)
      if (cfg.scope === 'opt-in' && d.hostKind === 'daemon' && d.env.SPARE10 === undefined) warnOnce(st, 'CX42', codexText.optInDaemon, now)
    })
    noteOriginator(sx.store, att, now)
    if (att.attended) cliHintOnce(sx, now)
    if (cfg.testPct !== undefined) {
      // 4.18: SPARE10_SIMULATE counts from this gate. The sense writes it once per session and host.
      await d.quota.awaitFirstRead()
      await d.sense.sense(sx).catch((e: unknown) => d.log.debug(codexDebug.readFailed('the quota at the start', errText(e))))
    }
  }

  /** CX13 and CX40 (2.5): once the kinds are known, a root sense that finds only a weekly window warns once. */
  const noteSensed = (sx: SessionCtx, s: CodexSensed): void => {
    if (!sx.root) return
    d.onSensed?.(s)
    if (s.blind || s.present.includes('five_hour') || !s.present.includes('seven_day')) return
    const id = s.cfg.weeklyReserve <= 0 ? 'CX13' : s.cfg.weeklyLastHours > 0 ? 'CX40' : undefined
    if (id === undefined) return
    try {
      if ((sx.store.read().warned ?? []).includes(id)) return
      const t = id === 'CX13' ? codexText.weeklyOnlyOff : codexText.weeklyOnlyOpen(s.cfg.weeklyLastHours)
      sx.store.locked((tx) => warnOnce(tx.state, id, t, s.now))
    } catch (e) {
      d.log.debug(codexDebug.writeFailed(`the warning ${id}`, errText(e)))
    }
  }

  /** B51 keys: the main loop of the root thread, or the subagent thread. */
  const loopKey = (sx: SessionCtx): string => (sx.root ? `${sx.sid}:main` : `${sx.sid}:${sx.thread}`)

  /** The text of a refused step that must not send its request: a blocked prompt (2.7). */
  const blockOf = (s: Pick<Sensed, 'kinds' | 'now' | 'attended'>, a: Pick<Acted, 'gating'>, sid: string): GateResult => ({
    kind: 'block',
    text: refusalText(s.attended ? 'paused' : 'headless', s, a, sid),
  })
  const denyOf = (s: Pick<Sensed, 'kinds' | 'now' | 'attended'>, a: Pick<Acted, 'gating'>, sid: string): GateResult => ({
    kind: 'deny',
    text: refusalText(s.attended ? 'stop' : 'headless', s, a, sid),
  })

  /**
   * 4.2 rounds: the port of on('tool.call') and on('turn.step'). `block`: the step phase of a prompt
   * gate (4.10), whose refusal is always a block, so no request goes out.
   */
  const rounds = async (sx: SessionCtx, input: GateInput, call: GateCall, site: 'tool' | 'step', o: { block?: boolean } = {}): Promise<GateResult> => {
    if (luna(input)) return { kind: 'pass' } // A7
    await d.quota.awaitFirstRead()
    let closed = false // after again: a failed sense refuses (B38)
    let resumed: readonly Answered[] = [] // one round only
    let last: { s: CodexSensed; a: Acted } | undefined
    const refused = (s: CodexSensed, a: Acted): GateResult => (o.block === true ? blockOf(s, a, sx.sid) : denyOf(s, a, sx.sid))
    for (;;) {
      let s: CodexSensed
      try {
        s = await d.sense.sense(sx, site)
      } catch (e) {
        d.log.debug(codexDebug.readFailed('the quota', errText(e)))
        if (!closed || last === undefined) return { kind: 'pass' } // the sensor fails open
        return refused(last.s, last.a)
      }
      noteSensed(sx, s)
      if (!s.tripped) return { kind: 'pass' }
      if (s.cfg.enabled && (s.attended || s.cfg.headless === 'wait')) markHolding(call, s.attended) // the actuator fails closed from here
      const a = await d.sense.act(sx, s, { site, resumed })
      const v = a.verdict
      if (v.kind === 'pass') return { kind: 'pass' }
      if (v.kind === 'refuse') {
        // 3.4: a refusal never fails into a pass, also for an unattended `stop` that holds after its one deny.
        if (s.cfg.enabled) markHolding(call, s.attended)
        if (v.text === 'stop' || v.text === 'paused') markWork(sx, d.log)
        if (o.block === true) return blockOf(s, a, sx.sid)
        const r = await d.refusal.refusal(sx, call, site, v.text, s, a)
        if (r.kind === 'hold') {
          // The verdict turned to hold while the call held: ask. An earlier Resume answers no later round.
          resumed = []
          continue
        }
        return r
      }
      if (v.kind === 'tell') {
        if (site !== 'tool') return { kind: 'pass' }
        return d.sense.claimTold(sx, s, a, loopKey(sx)) ? { kind: 'pass', context: tellText(s, a) } : { kind: 'pass' }
      }
      last = { s, a }
      const key = d.questions.ensureQuestion(sx, call, 'loop', s, a)
      const out = await d.questions.waitQuestion(sx, call, key)
      if (out === 'resume') {
        resumed = d.questions.answeredOf(sx, key)
        closed = false
        continue
      }
      if (out === 'again') {
        resumed = []
        closed = true
        continue
      }
      if (out === 'dropped') return refused(s, a) // Codex ignores it
      if (o.block === true) return blockOf(s, a, sx.sid)
      const r = await d.refusal.refusal(sx, call, site, s.attended ? (site === 'tool' ? 'stop' : 'paused') : 'headless', s, a)
      if (r.kind === 'hold') {
        resumed = [] // as above: the Resume of an older question does not answer this round
        continue
      }
      return r
    }
  }

  /** CX39 (2.6): spare10 interrupted a turn of the stop that began at `stopAt`. */
  const interruptedSince = (sx: SessionCtx, stopAt: number | undefined): boolean => {
    if (stopAt === undefined) return false
    try {
      return Object.values(sx.store.read().interrupts ?? {}).some((at) => at >= stopAt)
    } catch {
      return false
    }
  }
  const withInterrupted = (sx: SessionCtx, stopAt: number | undefined, note: string): string =>
    interruptedSince(sx, stopAt) ? `${codexText.interruptedNote} ${note}` : note

  /** The facts of the open question of `key`, read right after the open or join (for the B9 note). */
  const factsOfOpen = (sx: SessionCtx, key: string): Facts[] | undefined => {
    const q = d.questions.openQuestion(sx)
    return q?.key === key ? q.facts : undefined
  }

  /**
   * 4.10 person rounds: the port of on('prompt.submit'). The prompt decision asks the person. Then the
   * step decision (`stepPhase`) of the first request of the turn. A block there wins. The B9 note of a
   * Resume that cleared a stop, or the B35 note of a stop that the prompt took over, rides the pass as
   * context, after CX39 when spare10 interrupted a turn of that stop.
   */
  const personRounds = async (sx: SessionCtx, input: GateInput, call: GateCall): Promise<Answer> => {
    if (luna(input)) return PASS // A7: both phases
    await d.quota.awaitFirstRead()
    let wasStopped = false
    let stopAt: number | undefined
    let personResume = false
    let closed = false
    let resumed: readonly Answered[] = []
    let last: { s: CodexSensed; a: Acted } | undefined
    let lastFacts: Facts[] | undefined // B50 item 5: the question whose Resume the B9 note describes
    for (;;) {
      let s: CodexSensed
      try {
        s = await d.sense.sense(sx, 'prompt')
      } catch (e) {
        d.log.debug(codexDebug.readFailed('the quota', errText(e)))
        if (!closed || last === undefined) return PASS
        return { r: { kind: 'block', text: notStartedFor(last.s, last.a) } }
      }
      noteSensed(sx, s)
      if (s.tripped && s.attended && s.cfg.enabled) markHolding(call, s.attended) // the actuator fails closed from here
      const a = s.tripped ? await d.sense.act(sx, s, { site: 'prompt', person: true, resumed }) : undefined
      if (a?.stopped === true && !wasStopped) {
        wasStopped = true
        try {
          stopAt = parseStopped(sx.store.read().stopped)?.at
        } catch {
          stopAt = undefined
        }
      }
      if (a === undefined || a.verdict.kind !== 'hold') {
        let note: string | undefined
        if (personResume && wasStopped && last !== undefined) {
          note = withInterrupted(sx, stopAt, resumeContext(lastFacts ?? factsFrom(namedKinds(last.s, last.a), last.s.now))) // B9
        } else {
          try {
            const t = await takeOverdueStop(sx, { cfg: s.cfg, now: s.now, attended: s.attended, kinds: s.kinds, holders: a?.holders ?? [] })
            if (t?.record.work === true) note = withInterrupted(sx, t.record.at, resetContext(t.reset, t.open)) // B35
          } catch (e) {
            d.log.debug(codexDebug.writeFailed('the takeover of the stop', errText(e)))
          }
        }
        // For an attended person prompt in hold mode the prompt phase already asked: the step phase passes.
        if (!(s.attended && modeOf(s.cfg) === 'hold')) {
          const step = await rounds(sx, input, call, 'step', { block: true })
          if (step.kind !== 'pass') return { r: step }
        }
        return pass(note)
      }
      last = { s, a }
      const key = d.questions.ensureQuestion(sx, call, 'prompt', s, a)
      lastFacts = factsOfOpen(sx, key) ?? lastFacts
      const out = await d.questions.waitQuestion(sx, call, key)
      if (out === 'resume') {
        resumed = d.questions.answeredOf(sx, key)
        personResume = true
        closed = false
        continue
      }
      if (out === 'again') {
        resumed = []
        closed = true
        continue
      }
      if (out === 'dropped') return { r: { kind: 'block', text: notStartedFor(s, a) } } // Codex ignores it
      const noDialog = d.questions.answerFor(sx, key)?.noDialog === true
      return { r: { kind: 'block', text: noDialog ? codexText.notStartedNoDialog(factsFrom(namedKinds(s, a), s.now)) : notStartedFor(s, a) } }
    }
  }

  /** 4.10 steer rule: the turn was at a prompt gate of this thread already. The first gate of a turn records it. */
  const steerOf = (sx: SessionCtx, turn: string | undefined): boolean => {
    if (turn === undefined) return false
    try {
      if (readThread(sx.store, sx.thread)?.promptTurns.includes(turn) === true) return true
      return sx.store.locked((tx) => {
        const th = tx.thread(sx.thread)
        if (th.promptTurns.includes(turn)) return true
        th.promptTurns = [...th.promptTurns, turn].slice(-PROMPT_TURNS_KEPT)
        return false
      })
    } catch (e) {
      d.log.debug(codexDebug.writeFailed('the prompt turns', errText(e)))
      return false
    }
  }

  /** 4.7: the continuation turn's prompt, while its record is fresh. The record is consumed and its line queued. */
  const takeContinuation = (sx: SessionCtx, prompt: string): boolean => {
    let st: SessionState
    try {
      st = sx.store.read()
    } catch {
      return false
    }
    const c = st.continuation
    const now = d.clock.now()
    if (c === undefined || c.text !== prompt || now >= c.expiresAt) return false
    try {
      return sx.store.locked((tx) => {
        const cur = tx.state.continuation
        if (cur === undefined || cur.text !== prompt || now >= cur.expiresAt) return false
        delete tx.state.continuation
        noticeIn(tx.state, cur.notice, now)
        return true
      })
    } catch (e) {
      d.log.debug(codexDebug.writeFailed('the continuation', errText(e)))
      return false
    }
  }

  /** A command typed as the whole prompt (2.8, 4.10). */
  const onCommand = async (sx: SessionCtx, cmd: Command, steer: boolean): Promise<Answer> => {
    if (!sx.root && rootOnly(cmd)) return { r: { kind: 'block', text: `spare10: ${notPerson(verbOf(cmd))}` } }
    const reply = await d.commands.run(sx, cmd, { cli: false })
    // A steer goes on: the reply shows as a transcript line and the model reads CX4. A steered stop ends the turn.
    if (steer && sx.root && cmd.verb !== 'stop') return { r: { kind: 'pass', context: codexText.steerNote }, message: withPrefix(reply) }
    return { r: { kind: 'block', text: `spare10: ${reply}` } }
  }

  /** 4.10 onPrompt. */
  const onPrompt = async (sx: SessionCtx, input: GateInput, call: GateCall): Promise<Answer> => {
    const steer = steerOf(sx, input.turn)
    const prompt = input.prompt ?? ''
    const cmd = parseCommand(prompt)
    if (cmd !== undefined) return onCommand(sx, cmd, steer)
    if (sx.root && takeContinuation(sx, prompt)) return { r: await rounds(sx, input, call, 'step', { block: true }) }
    if (!sx.root) return { r: await rounds(sx, input, call, 'step', { block: true }) } // a subagent message: never asked
    call.prompt = prompt // CX18 finds a held prompt of a broker that died
    return personRounds(sx, input, call)
  }

  /** 4.2 onStop (Stop and SubagentStop): the turn ends anyway. A refusal or a hold verdict ends it with no request. */
  const onStop = async (sx: SessionCtx, input: GateInput): Promise<GateResult> => {
    if (luna(input)) return { kind: 'pass' }
    try {
      const s = await d.sense.sense(sx)
      noteSensed(sx, s)
      if (!s.tripped) return { kind: 'pass' }
      const v = (await d.sense.act(sx, s, { site: 'step' })).verdict
      if (v.kind === 'refuse') return { kind: 'end', text: codexText.turnEnds }
      if (v.kind === 'hold') return s.attended ? { kind: 'end', text: codexText.turnEndsHold } : { kind: 'end' }
      return { kind: 'pass' }
    } catch (e) {
      d.log.debug(codexDebug.readFailed('the quota at the end of the turn', errText(e)))
      return { kind: 'pass' } // a sense failure passes
    }
  }

  /**
   * 4.12 item 1, the Interrupt gate: no sense and no network. It drops the held calls of the turn in this
   * broker, and records the interrupt with a short lock wait. False: the lock was busy, so the answer is "".
   */
  const onInterrupt = (sx: SessionCtx, input: GateInput): boolean => {
    const turn = input.turn
    if (turn === undefined) return true
    const n = d.dropTurn(turn)
    if (n > 0) d.log.debug(codexDebug.dropped(n))
    const now = d.clock.now()
    try {
      sx.store.locked((tx) => {
        tx.state.lastInterrupt = { turnId: turn, at: now, bySpare10: tx.state.interrupts?.[turn] !== undefined }
      })
      return true
    } catch (e) {
      d.log.debug(codexDebug.writeFailed('the interrupt', errText(e)))
      return false
    }
  }

  const dispatch = async (sx: SessionCtx, input: GateInput, call: GateCall): Promise<Answer> => {
    if (sx.root && !started.has(sx.sid) && input.site !== 'interrupt') {
      try {
        await firstRootGate(sx, input)
      } catch (e) {
        d.log.debug(codexDebug.writeFailed('the start of the session', errText(e)))
      }
    }
    switch (input.site) {
      case 'stop':
        return { r: await onStop(sx, input) }
      case 'prompt':
        return onPrompt(sx, input, call)
      case 'tool':
        return input.tool === QUESTION_TOOL ? PASS : { r: await rounds(sx, input, call, 'tool') }
      case 'step':
        return { r: await rounds(sx, input, call, 'step') }
      default:
        return PASS // start (4.22 above), spawn (A2), compact (P0)
    }
  }

  return async (args, meta, call) => {
    const input = parseGateInput(args)
    if (input === undefined) {
      d.log.debug(codexDebug.gateError('the gate input is not valid, so the gate passes'))
      return ''
    }
    let answer: Answer = PASS
    let sx: SessionCtx | undefined
    let notices = true
    try {
      sx = bind(input, meta)
      call.thread = sx.thread
      if (input.site === 'interrupt') notices = onInterrupt(sx, input)
      else answer = await dispatch(sx, input, call)
    } catch (e) {
      d.log.debug(codexDebug.gateError(e instanceof Error ? (e.stack ?? e.message) : String(e)))
      answer = { r: call.holding ? genericRefusal(input.site, call.attended !== false) : { kind: 'pass' } }
    }
    // Best effort: the decided answer stands whatever fails here.
    const lines: string[] = []
    if (sx !== undefined) {
      const ctx = sx
      if (call.holding) {
        try {
          const id = callId(call)
          if (readThread(ctx.store, ctx.thread)?.held.some((e) => e.call === id && e.brokerPid === d.pid) === true) {
            ctx.store.locked((tx) => removeHeld(tx, ctx.thread, call, d.pid))
          }
        } catch (e) {
          d.log.debug(codexDebug.writeFailed('the held entry', errText(e))) // the next gate of this thread removes it
        }
      }
      // A call that Codex dropped gets no reader: its lines wait for the next answer (the Interrupt gate).
      if (ctx.root && notices && !call.dropped.aborted) {
        try {
          lines.push(...ctx.store.takeNotices(d.clock.now()).map(withPrefix))
        } catch (e) {
          d.log.debug(codexDebug.readFailed('the queued lines', errText(e)))
        }
      }
    }
    if (answer.message !== undefined) lines.push(answer.message)
    // 2.4: several lines join with a newline, each with its own prefix.
    return render(input.site, answer.r, lines.length === 0 ? undefined : lines.join('\n'))
  }
}
