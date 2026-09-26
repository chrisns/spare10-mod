import { join } from 'node:path'
import { codexText, defaultText, initialPresence, nextPresence, optionText, OPTIONS, parseSetValue } from '../../hooks/core/codex.ts'
import type { CodexSnapshot, Command, OptionName } from '../../hooks/core/codex.ts'
import { watchedKinds } from '../../hooks/core/config.ts'
import type { Effective } from '../../hooks/core/config.ts'
import { formatStopped, parseStopped, phaseOf } from '../../hooks/core/decide.ts'
import type { Holder, Phase } from '../../hooks/core/decide.ts'
import {
  commandHolders,
  consentBeyond,
  factsFrom,
  gatesAfter,
  modeOf,
  raisesInPlace,
  resumeCase,
  seenOf,
  seenSplit,
  simulateText,
  statusInput,
  stopAskingIdle,
  stopAskingReply,
  stopCase,
  stopKept,
  stopKeptReply,
  stopOverdueReply,
  stopTrippedReply,
  stopWriteOf,
  takeoverSense,
  testReading,
  tripOf,
  withRealEntries,
} from '../../hooks/core/flow.ts'
import type { Seen } from '../../hooks/core/flow.ts'
import { parseSimulate, pctOf } from '../../hooks/core/reading.ts'
import type { Kind } from '../../hooks/core/reading.ts'
import { commandFailed, resumeReply, simulateReply, statusReport, stopReply, unknownVerb } from '../../hooks/core/text.ts'
import type { AttendanceSource } from './attend.ts'
import { clearConsent, consentField, consentsIn, writeConsent } from './consent.ts'
import type { DaemonLink } from './daemon.ts'
import type { Deps } from './deps.ts'
import { readJson } from './files.ts'
import { readThread, threadIds } from './held.ts'
import type { Env } from './paths.ts'
import type { Quota } from './quota.ts'
import type { Questions } from './question.ts'
import { toldOf } from './sense.ts'
import type { CodexSensed, SenseApi, SessionCtx } from './sense.ts'
import { configPath, readConfig, setOption } from './settings.ts'
import type { SettingsSource } from './settings.ts'
import { clearStopped, stoppedNow, takeOverdueStop, writeStopped } from './stop.ts'
import { freshState, freshThread, testOf } from './store.ts'
import type { SessionState, SessionStore, Tx } from './store.ts'
import type { Sweep } from './sweep.ts'
import { A_NEAR_MS, LIVE_RELEASE_MAX_AGE_MS } from './timing.ts'

// The commands (Codex design 2.8, 4.19, 4.20, 7.2 commands.ts): the report, resume, stop, simulate, set and
// help. A typed prompt `spare10 ...` in the root thread and the CLI run the same functions, on the session
// files. The replies are the core replies with the Codex host words, and have no prefix: the gate and the
// CLI add `spare10: `. Codex adds three things to register.tsx: the reply case `asking` in place of
// `stopped` while held work waits under a stop, a stop clears the held stop, and a stop that writes a
// stop runs the stop sweep.

export type CommandDeps = Pick<Deps, 'paths' | 'clock' | 'log' | 'owner'> & {
  /** The env of the broker, or of the CLI: `SPARE10_HEADLESS` and the variables that win over an option. */
  env: Env
  settings: Pick<SettingsSource, 'get'>
  /** The report reads the daemon first, so its reading and its `live read` row are fresh (2.8, 9.3). */
  quota?: Pick<Quota, 'live'>
  sense: SenseApi
  questions: Pick<Questions, 'settle' | 'openQuestion'>
  sweep: Pick<Sweep, 'sweep'>
  daemon: Pick<DaemonLink, 'get' | 'hosted'>
  attendance: AttendanceSource
  pidAlive: (pid: number) => boolean
}

export type Commands = {
  /** Runs one command (2.8). The reply has no prefix. A command that throws answers commandFailed. */
  run(sx: SessionCtx, cmd: Command, o: { cli: boolean }): Promise<string>
  /** As `run`, but a command that fails throws (the CLI exits 1). */
  exec(sx: SessionCtx, cmd: Command, o: { cli: boolean }): Promise<string>
  /** The report (4.19). `sx` undefined: the CLI with no session. `cli`: the rows session and broker. */
  statusText(sx: SessionCtx | undefined, o: { cli: boolean; full: boolean }): Promise<string>
  /** The phase line of the report, as one line (2.9). */
  phaseLine(sx: SessionCtx | undefined): Promise<string>
  /** The phase of a session (the CX36 rows). */
  phase(sx: SessionCtx): Promise<Phase>
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The session of a report with no session (the CLI, 2.9): an empty state in memory. It writes nothing,
 * so a report on a data dir with no session leaves no session folder.
 */
export function scratchStore(data: string): SessionStore {
  const sid = 'none'
  let state: SessionState = freshState(sid)
  // Its presence count comes from the earlier good live reads that live.json keeps (3.6): the view counts
  // the newest one itself. So a report with no session knows a plan with only a weekly window.
  try {
    const live = readJson<{ v?: unknown; at?: unknown; recent?: unknown }>(join(data, 'live.json'))
    if (live?.v === 1 && typeof live.at === 'number' && Array.isArray(live.recent)) {
      let p = initialPresence()
      for (const snap of live.recent.slice(0, -1) as CodexSnapshot[]) if (typeof snap === 'object' && snap !== null) p = nextPresence(p, snap, () => false)
      state = { ...state, absentCount: p.count, absentAt: live.at - 1 }
    }
  } catch {
    // No live read: both kinds are present.
  }
  return {
    sid,
    dir: join(data, 'sessions', '.none'),
    read: () => structuredClone(state),
    locked(fn) {
      const tx: Tx = {
        state: structuredClone(state),
        thread: (tid) => freshThread(sid, tid),
        question: () => undefined,
        answer: () => undefined,
        setQuestion() {},
        setAnswer() {},
      }
      const out = fn(tx)
      state = tx.state
      return out
    },
    queueNotice() {},
    takeNotices: () => [],
  }
}

/** The Codex warnings of 2.5 for the report: those the session showed (their ids in `warned`), and those of the kinds of now. */
function codexWarnings(state: SessionState, s: CodexSensed, originator: string | undefined): string[] {
  const out: string[] = []
  const warned = state.warned ?? []
  const has = (id: string): boolean => warned.includes(id)
  if (has('CX6') || has('CX7')) out.push(codexText.noDaemon(s.cfg.autoResume))
  if (has('CX8')) out.push(codexText.approvalNever)
  if (has('CX42')) out.push(codexText.optInDaemon)
  if (has('CX43') && originator !== undefined) out.push(codexText.originator(originator))
  // CX13 and CX40 follow the kinds of now: a report also runs before any gate of the session sensed.
  if (!s.blind && !s.present.includes('five_hour') && s.present.includes('seven_day')) {
    if (s.cfg.weeklyReserve <= 0) out.push(codexText.weeklyOnlyOff)
    else if (s.cfg.weeklyLastHours > 0) out.push(codexText.weeklyOnlyOpen(s.cfg.weeklyLastHours))
  }
  // CX16: a watched kind at 100% or more, and credits can pay.
  const balance = s.credits?.balance
  if (s.creditsUsable && typeof balance === 'string' && s.kinds.some((k) => (pctOf(k.basis) ?? 0) >= 100)) out.push(codexText.credits(balance))
  return out
}

/** The value of an option in the settings in force. */
function valueOf(eff: Effective, name: OptionName): string | number | boolean | null {
  switch (name) {
    case 'reserve':
      return eff.reserve
    case 'weeklyReserve':
      return eff.weeklyReserve
    case 'lastMinutes':
      return eff.lastMinutes
    case 'weeklyLastHours':
      return eff.weeklyLastHours
    case 'resumeFloor':
      return eff.resumeFloor
    case 'weeklyResumeFloor':
      return eff.weeklyResumeFloor
    case 'pausePrompt':
      return eff.pausePrompt
    case 'autoResume':
      return eff.autoResume
    case 'headless':
      return eff.headless
    case 'scope':
      return eff.scope
  }
}

/** A variable of this env wins over the option (A15). */
function envWins(eff: Effective, name: OptionName): boolean {
  if (name === 'scope') return eff.from.enabled === 'SPARE10'
  return eff.from[name] === 'env'
}

export function createCommands(d: CommandDeps): Commands {
  const attendedOf = (sx: SessionCtx): boolean => d.attendance.attended({ transcript: sx.transcript }, sx.mode).attended

  /** Held work of the session waits: a held entry of a live broker in any thread (4.19 heldInPlace, 4.20 `asking`). */
  const heldLive = (sx: SessionCtx): boolean => {
    try {
      for (const tid of threadIds(sx.store)) {
        if (readThread(sx.store, tid)?.held.some((e) => d.pidAlive(e.brokerPid)) === true) return true
      }
    } catch {
      return false
    }
    return false
  }

  /** The watched kinds that the host reports no window for (CX17). */
  const absentOf = (s: CodexSensed): Kind[] => watchedKinds(s.cfg).filter((k) => !s.present.includes(k))

  /** The report's view (register.tsx seen), with the phase of the present kinds (4.15). */
  const seen = async (sx: SessionCtx): Promise<{ p: Seen; s: CodexSensed; state: SessionState }> => {
    const s = await d.sense.sense(sx)
    const state = sx.store.read()
    let parent: SessionState | undefined
    if (!s.attended && sx.parent !== undefined) {
      try {
        parent = sx.parent.read()
      } catch {
        parent = undefined
      }
    }
    const lists = (k: (typeof s.kinds)[number]) =>
      consentsIn({ state, ...(parent === undefined ? {} : { parent }), kind: k.kind, attended: s.attended, testBasis: k.test, realEnd: k.realReset, hostPid: sx.hostPid }).list.map(
        (e) => e.c,
      )
    const split = seenSplit(s.kinds, lists, s.now)
    const guarded = s.cfg.enabled && s.attended
    const holders = guarded ? d.sense.holders(sx, s, split.gating) : []
    const stop = guarded ? stoppedNow(sx, s.now, split.gating, holders) : undefined
    const question = d.questions.openQuestion(sx)
    const p0 = seenOf({
      cfg: s.cfg,
      now: s.now,
      bases: s.bases,
      kinds: s.kinds,
      tripped: s.tripped,
      attended: s.attended,
      split,
      stop,
      question,
      told: toldOf(state),
      sessionId: sx.sid,
    })
    // 4.15: the phase reads the bases of the kinds the host reports, so a weekly-only plan is armed.
    const phase = phaseOf({
      enabled: s.cfg.enabled,
      basis: p0.bases.five_hour,
      tripped: p0.tripped,
      consented: s.cfg.enabled && p0.tripped && p0.gating.length === 0 && p0.open.length === 0,
      open: s.cfg.enabled && p0.tripped && p0.gating.length === 0 && p0.open.length > 0,
      stopped: p0.stop !== undefined,
      asking: question !== undefined && !question.silent,
      told: p0.tripped && p0.toldCount > 0,
      attended: p0.attended,
      bases: s.present.map((k) => p0.bases[k]),
    })
    return { p: { ...p0, phase }, s, state }
  }

  const statusText: Commands['statusText'] = async (sx0, o) => {
    await d.quota?.live(LIVE_RELEASE_MAX_AGE_MS, A_NEAR_MS)
    const sx = sx0 ?? scratchCtx()
    const { p, s, state } = await seen(sx)
    const cfg = s.cfg
    const now = p.now
    const hosted = sx0 === undefined ? false : await d.daemon.hosted(sx.sid).catch(() => false)
    const warnings = [...cfg.warnings, ...codexWarnings(state, s, d.attendance.attended({ transcript: state.transcript ?? sx.transcript }, sx.mode).warnOriginator)]
    for (const k of p.kinds) {
      // R13: a consent that lies beyond this window is ignored, and the report says so (B30).
      const w = consentBeyond(k, state[consentField(k.kind)], now)
      if (w !== undefined) warnings.push(w)
    }
    const st = p.stop
    // 2.5: the reset clock of this session cannot run: a stop with work waits for its end, and the root is not hosted.
    // Held work in a thread with no daemon continues in place at the stop end (4.4): only an idle stopped
    // session needs the reset clock of a hosted root.
    const tickerStale = sx0 !== undefined && st?.work === true && st.auto === true && cfg.autoResume && !hosted && !heldLive(sx)
    const input = statusInput(p, { childPolicy: d.env.SPARE10_HEADLESS ?? state.child ?? cfg.headless, warnings, tickerStale })
    const live = s.view.live
    const liveError = s.view.liveError
    const liveRow = live !== undefined ? codexText.liveRow({ agoMs: Math.max(0, now - live.at) }) : codexText.liveRow(liveError === undefined ? {} : { error: liveError.error })
    let daemonRow: string
    if (sx0 !== undefined) daemonRow = codexText.daemonRow(hosted, cfg.autoResume)
    else {
      let found = false
      try {
        const dm = d.daemon.get()
        if (dm !== undefined) {
          await dm.loaded()
          found = true
        }
      } catch {
        found = false
      }
      daemonRow = codexText.daemonReach(found)
    }
    const rows: Array<readonly [string, string]> = []
    if (o.cli) {
      rows.push(['session', sx0 === undefined ? 'none' : sx.sid])
      if (sx0 !== undefined) {
        const th = readThread(sx.store, sx.sid)
        rows.push(['broker', codexText.brokerRow(th !== undefined && th.brokerPid > 0 && d.pidAlive(th.brokerPid))])
      }
    }
    rows.push(['daemon', daemonRow], ['live read', liveRow], ['cli', d.paths.launcher])
    const absent = absentOf(s)
    return statusReport({
      ...input,
      ...(absent.length === 0 ? {} : { absent }),
      ...(st !== undefined && heldLive(sx) ? { heldInPlace: true } : {}),
      extraRows: rows,
      extraHelp: [codexText.helpSet, codexText.helpAnytime],
    })
  }

  /** A session context for the CLI with no session: nothing is read from or written to a session folder. */
  const scratchCtx = (): SessionCtx => ({ sid: 'none', thread: 'none', root: true, transcript: null, hostPid: 0, store: scratchStore(d.paths.data) })

  /** register.tsx resumeCommand, on the session files. */
  const resumeCommand = async (sx: SessionCtx): Promise<string> => {
    const cfg = d.settings.get()
    if (!cfg.enabled || !attendedOf(sx)) return resumeReply('off')
    const sNow = await d.sense.sense(sx).catch(() => undefined) // skip 4.6: the takeover names what opened
    const now = sNow?.now ?? d.clock.now()
    const absent = sNow === undefined ? undefined : absentOf(sNow)
    const overdue = await takeOverdueStop(sx, { cfg, now, attended: true, ...takeoverSense(sNow) })
    if (overdue !== undefined) return resumeReply('overdue', undefined, overdue.reset, overdue.open)
    const open = d.questions.openQuestion(sx)
    if (open !== undefined) {
      const r = await d.questions.settle(sx, open.key, 'resume', 'command', sNow === undefined ? {} : { raiseAt: sNow })
      const q = r.q ?? open
      return resumeReply('asking', q.facts, undefined, undefined, q.mode)
    }
    const s = sNow ?? (await d.sense.sense(sx))
    const mode = modeOf(cfg)
    const read = s.kinds.filter((k) => k.basis.kind !== 'none')
    if (read.length === 0) return resumeReply('none', undefined, undefined, undefined, 'hold', absent) // B23, CX17
    if (!s.tripped) return resumeReply('below', factsFrom(read, s.now), undefined, undefined, 'hold', absent)
    const c = resumeCase(s, d.sense.split(sx, s), mode)
    if ('reply' in c) return c.reply
    const wasStopped = stoppedNow(sx, s.now, c.gating, commandHolders(s.kinds)) !== undefined // TS1: also a stop that a kind of it still holds
    // The command follows the reading now (floor 1.3 item 2): before the floor to the floor, past it until the reset.
    sx.store.locked((tx) => {
      for (const w of c.write) writeConsent(tx.state, w.kind, w.c, s.now, w.test)
      clearStopped(tx.state)
    })
    // 4.20: held work that waits under the stop continues now, so the reply says so.
    const cse = wasStopped ? (heldLive(sx) ? 'asking' : 'stopped') : 'tripped'
    return resumeReply(cse, c.facts, undefined, undefined, mode, absent)
  }

  /**
   * TS1 (register.tsx addRealEntries): a stop that stays gets the real entries of now, under the lock and
   * only over the value it read. 4.4: a stop command turns a held stop into a plain stop.
   */
  const keepStop = (sx: SessionCtx, raw: string | undefined, realNow: readonly Holder[], now: number): boolean => {
    let wasHeld = false
    sx.store.locked((tx) => {
      if (tx.state.stopMeta?.noDialog === true) {
        delete tx.state.stopMeta
        wasHeld = true
      }
      if (realNow.length === 0 || tx.state.stopped !== raw || raw === undefined) return
      const next = withRealEntries(parseStopped(raw), realNow, now)
      const value = next === undefined ? undefined : formatStopped(next)
      if (value !== undefined && value !== raw) tx.state.stopped = value
    })
    return wasHeld
  }

  /** register.tsx stopCommand, on the session files. */
  const stopCommand = async (sx: SessionCtx): Promise<string> => {
    const cfg = d.settings.get()
    if (!cfg.enabled || !attendedOf(sx)) return stopReply('off')
    const sNow = await d.sense.sense(sx).catch(() => undefined) // skip 4.6: the takeover names what opened
    const now = sNow?.now ?? d.clock.now()
    const after = gatesAfter(sNow) // the kinds that gate after the stop. Unknown when the sense failed.
    const overdue = await takeOverdueStop(sx, { cfg, now, attended: true, ...takeoverSense(sNow), quiet: after })
    if (overdue !== undefined && !after) return stopOverdueReply(overdue) // no stop after a takeover when no kind gates (D0.2)
    const carried = overdue?.record.work === true // a new stop keeps the work of the stop it took over (3.2)
    const open = d.questions.openQuestion(sx)
    if (open !== undefined) {
      const late = await d.questions.settle(sx, open.key, 'stop', 'command') // the settle runs the stop sweep
      return stopAskingReply(late) ?? stopAskingIdle(late.q ?? open, cfg.autoResume, now)
    }
    const s = sNow ?? (await d.sense.sense(sx))
    const absent = absentOf(s)
    const read = s.kinds.filter((k) => k.basis.kind !== 'none')
    if (read.length === 0 || !s.tripped) {
      // B24 with CX17: a weekly-only plan names no 5-hour trip.
      const weeklyTrip = cfg.weeklyReserve > 0 ? tripOf(cfg.weeklyReserve) : undefined
      const facts = read.length === 0 ? undefined : factsFrom(read, s.now)
      return stopReply(read.length === 0 ? 'none' : 'below', facts, tripOf(cfg.reserve), undefined, weeklyTrip, undefined, absent)
    }
    const c = stopCase(s, cfg)
    if ('reply' in c) return c.reply
    const raw = sx.store.read().stopped
    const st = stoppedNow(sx, s.now, c.ks, commandHolders(s.kinds)) // TS1: also a stop that a kind of it still holds
    if (stopKept(st, c.ks)) {
      // A stop in force that names each kind that gates now stays. A held stop becomes a plain stop (4.4).
      const wasHeld = keepStop(sx, raw, c.real, s.now)
      if (wasHeld) await d.sweep.sweep(sx)
      return heldLive(sx) ? stopReply('asking') : stopKeptReply(st, c.facts, cfg.autoResume, s.now)
    }
    const written = sx.store.locked((tx) => {
      clearConsent(tx.state)
      const w = writeStopped(tx.state, stopWriteOf(c.ks, cfg.autoResume, carried), s.now)
      delete tx.state.stopMeta
      return w
    })
    // A crossing during the writes opened a question that this stop cannot answer. Settle it as Stop here.
    const late = d.questions.openQuestion(sx)
    if (late !== undefined) await d.questions.settle(sx, late.key, 'stop', 'command')
    await d.sweep.sweep(sx) // 4.23
    return stopTrippedReply(c.ks, c.facts, written, cfg.autoResume, s.now)
  }

  /** register.tsx simulateCommand, on `state.test` (4.18): bound to the host of the session. */
  const simulateCommand = async (sx: SessionCtx, words: readonly string[]): Promise<string> => {
    const s = await d.sense.sense(sx).catch(() => undefined)
    // A8: with no 5-hour window, a test reading with no kind word is weekly.
    const defaultKind: Kind = s !== undefined && !s.present.includes('five_hour') && s.present.includes('seven_day') ? 'seven_day' : 'five_hour'
    const spec = parseSimulate(words, defaultKind)
    if (spec === undefined) return simulateReply('bad')
    if (spec === 'off') {
      sx.store.locked((tx) => {
        tx.state.test = { hostPid: sx.hostPid, kinds: {}, consent: {}, envDone: true }
        clearConsent(tx.state)
        clearStopped(tx.state)
      })
      return simulateReply('off')
    }
    const cfg = d.settings.get()
    if (spec.kind === 'seven_day' && cfg.weeklyReserve <= 0) return simulateReply('weekly-off')
    const now = d.clock.now()
    const live = s?.view.readings[spec.kind]?.live
    const old = testOf(sx.store.read(), sx.hostPid)?.kinds[spec.kind]
    // B53: a strictly higher value without `in`, in the window of the test reading, raises it in place.
    const inPlace = old !== undefined && raisesInPlace(old, spec, now)
    const replaces = old !== undefined && !inPlace
    const reading = inPlace ? { pct: spec.pct, resetsAtMs: old.resetsAtMs } : testReading(spec.pct, spec.kind, live, now, spec.inMs)
    sx.store.locked((tx) => {
      const t = testOf(tx.state, sx.hostPid) ?? { hostPid: sx.hostPid, kinds: {}, consent: {} }
      tx.state.test = { ...t, kinds: { ...t.kinds, [spec.kind]: reading }, envDone: true }
      if (replaces) {
        // A new test reading starts a new test: no answer given under the old one carries over (3.5).
        clearConsent(tx.state)
        clearStopped(tx.state)
      }
    })
    return simulateText({ spec, reading, inPlace, cfg, spans: cfg, live, mem: d.sense.memOf(sx.sid, spec.kind), now })
  }

  /** 4.20 setCommand: the option list, or one key of config.json under config.lock. */
  const setCommand = (words: readonly string[], rest: string): string => {
    const path = configPath(d.paths)
    const eff = d.settings.get()
    if (words.length === 0) {
      const read = readConfig(path)
      const raw = 'raw' in read && typeof read.raw === 'object' && read.raw !== null && !Array.isArray(read.raw) ? (read.raw as Record<string, unknown>) : {}
      const rows = OPTIONS.map((o) => {
        const inFile = Object.prototype.hasOwnProperty.call(raw, o.name) && o.parse(raw[o.name]) !== undefined
        const source = envWins(eff, o.name) ? `${o.env} wins` : inFile ? 'config.json' : 'default'
        return [o.name, optionText(o.name, valueOf(eff, o.name)), source] as const
      })
      return codexText.setList(path, rows)
    }
    const option = OPTIONS.find((o) => o.name === words[0])
    if (option === undefined) return codexText.setUnknown(words[0] ?? '')
    const name = option.name
    const toDefault = rest.trim().toLowerCase() === 'default'
    let value: string | number | boolean | undefined
    if (!toDefault) {
      const v = parseSetValue(name, rest)
      if (!v.ok) return codexText.setBad(name, option.range)
      value = v.value
    }
    let old: unknown
    try {
      old = setOption(d.paths, d.owner, name, value).old
    } catch (e) {
      return codexText.setFailed(path, errText(e))
    }
    const wins = d.env[option.env] !== undefined ? codexText.setEnvWins(option.env) : ''
    if (value === undefined) return `${codexText.setDefault(name, defaultText(name))}${wins}`
    const was = old === undefined ? undefined : option.parse(old)
    const oldText = was === undefined ? defaultText(name) : optionText(name, was)
    return `${codexText.setOk(name, optionText(name, value), oldText)}${wins}`
  }

  const exec: Commands['exec'] = async (sx, cmd, o) => {
    switch (cmd.verb) {
      case 'status':
        return statusText(sx, { cli: o.cli, full: true })
      case 'help':
        return codexText.help(d.paths.bin)
      case 'resume':
        return resumeCommand(sx)
      case 'stop':
        return stopCommand(sx)
      case 'simulate':
        return simulateCommand(sx, cmd.words)
      case 'set':
        return setCommand(cmd.words, cmd.rest)
      case 'unknownOption':
        return codexText.setUnknown(cmd.word)
      case 'unknown':
        return unknownVerb(cmd.word)
    }
  }

  return {
    async run(sx, cmd, o) {
      try {
        return await exec(sx, cmd, o)
      } catch (e) {
        return commandFailed(errText(e))
      }
    },
    exec,
    statusText,
    async phaseLine(sx) {
      const report = await statusText(sx, { cli: true, full: false })
      // statusReport: the version, a blank line, then the phase line.
      return (report.split('\n')[2] ?? '').replace(/^ {2}/, '')
    },
    async phase(sx) {
      return (await seen(sx)).p.phase
    },
  }
}
