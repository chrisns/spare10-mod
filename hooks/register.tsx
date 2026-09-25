import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'
import {
  DEFAULTS,
  NO_SPANS,
  childHeadless,
  flagOnlyInShell,
  fromOptions,
  questionTimeout,
  reserveOf,
  spanOf,
  unreadEnv,
  watchedKinds,
  withEnv,
} from './core/config.ts'
import type { Effective, EnvReads, Settings, Spans } from './core/config.ts'
import {
  BUDGET_FLOOR_MS,
  CHECK_MS,
  TICK_MS,
  afterFailure,
  askVerdict,
  consentCounts,
  consentCovers,
  decide,
  formatConsent,
  formatStopped,
  isOverdue,
  joinable,
  mergeStopped,
  parseConsent,
  parseStopped,
  phaseOf,
  shouldAbortTurn,
  skipTag,
  stopAction,
  stopDue,
} from './core/decide.ts'
import type { Mode, Outcome, Phase, Site, StoppedRecord, Verdict } from './core/decide.ts'
import {
  FALLBACK_MS,
  KINDS,
  anchoredOf,
  asAnchored,
  basis,
  holdEndOf,
  inResetMargin,
  initialMemory,
  isTripped,
  limitOf,
  marginOf,
  newer,
  parseReset,
  parseSimulate,
  sawLive,
  sawMeasure,
  skipStartOf,
  viewOf,
  windowMs,
} from './core/reading.ts'
import type { Anchored, Basis, Kind, Memory } from './core/reading.ts'
import {
  ARGUMENT_HINT,
  COMMAND_DESCRIPTION,
  HEADER,
  HEADLESS_GENERIC,
  NOT_STARTED_GENERIC,
  QUESTION_OPTIONS,
  RESUME_LABEL,
  STOP_GENERIC,
  W_FLAG,
  atText,
  bgEnvWarning,
  clockText,
  commandFailed,
  consentWarning,
  debugLine,
  factsOf,
  headlessText,
  leadText,
  notPerson,
  notStarted,
  notice,
  pauseInstruction,
  pausedText,
  questionText,
  resetContext,
  resumeContext,
  resumePrompt,
  resumeReply,
  simulateReply,
  statusReport,
  stopReply,
  stopText,
  timeoutWarning,
  unknownVerb,
  untilFor,
  untilPhrase,
  whenOf,
  withdrawnText,
} from './core/text.ts'
import type { Ended, Facts, Named } from './core/text.ts'
import { badgeView } from './core/badge.ts'
import type { View } from './core/badge.ts'

// The only file that uses $ (design 10.9.6). Sense fails open, act fails closed (4.2). Every held
// dispatch parks on the re-armed $.spare10.park carrier (4.4). The first waiter raises the one question
// in its own dispatch, and a lost raiser hands it on (4.5). Decisions cross module copies in the env.
// 0.2: one basis, consent and told set per kind. A ticker that session.start arms continues held and
// stopped work at the reset (4 of the 0.2 design). The gates decide in rounds (5.3).
// Skip near the reset: a tripped kind in the last span before its reset is open. It never gates, and no
// stop holds it (B41, B44). While its skip start is ahead, that start is its hold end, with no margin (B42).

type Ctx = { site: Site; agentId?: string; person?: boolean; resumed?: readonly Kind[] } // resumed: the kinds of the Resume that ended the last round
type KindSense = {
  kind: Kind
  reserve: number
  basis: Basis // the view basis: the real one when a test reading yields to a real trip (B45)
  tripped: boolean
  windowEnd: number // the consent bound
  holdEnd: number // the skip start while it is ahead, else the D0.2 hold end (B42)
  stopEnd: number // the end of a stop with autoResume off: the skip start while it is ahead, else windowEnd
  span: number // ms, 0 is off
  skipAt: number | null // the skip start while it is ahead
  open: boolean // tripped and in its skip window (B41)
  test: boolean
  seed: boolean
}
type Sensed = { cfg: Effective; now: number; kinds: KindSense[]; tripped: boolean; attended: boolean }
type Acted = { verdict: Verdict; stopped: boolean; gating: KindSense[] }
type Settled = Outcome | 'again' // again: ended without an answer (4.5)
type Raiser = { signal: AbortSignal }
type Question = {
  kinds: Kind[] // the gating kinds when it opened, five_hour first
  ends: Partial<Record<Kind, { end: number; test: boolean; skipAt?: number }>> // consent bound, test flag and skip start per kind
  latestEnd: number // the latest consent bound (the B6 note of a question that is not a skip owner)
  stopEnd: number // the latest stop end of its kinds: the until of a Stop here with autoResume off
  holdEnd: number // the latest hold end of its kinds
  due: number // the latest hold end plus margin of its kinds
  skip: boolean // a skip owner: its hold end is a skip start, and no kind of it is due later (B42)
  noteAt: number // autoResume off: the time of the one note. B43 can move it later
  nextCheck: number // the next check before the due time
  budgetLogAt: number // the last B40 debug line
  silent: boolean // an unattended wait hold: no dialog, never raised
  auto: boolean // autoResume when it opened: the text only
  loops: number // tool and step waiters that joined (a Stop with loops has work)
  checking: boolean // one waiter runs the check at a time
  since: number
  mode: Mode
  opener: 'loop' | 'prompt'
  facts: Facts[]
  waiting: number
  handoffs: number
  raiser?: Raiser
  noted: boolean
}
type Via =
  | 'dialog'
  | 'command'
  | 'elsewhere'
  | 'could not ask'
  | 'dialog ended without an answer'
  | 'reset'
  | 'quota'
  | 'time limit'
type Release = { raw: string; record: StoppedRecord; cancelled: boolean }
type Split = { gating: KindSense[]; open: KindSense[] } // skip 3.3
type Taken = { record: StoppedRecord } & Ended // takeOverdueStop's result (skip 4.6)
type Late = { record?: StoppedRecord; ended?: Ended; until?: { at: string; lead?: string } } // settle's result for a Stop (B46)
type Wake = { p: Promise<'woke'>; fire: () => void }
type Seen = {
  cfg: Effective
  now: number
  bases: Record<Kind, Basis> // with the test reading, for the reading rows
  kinds: KindSense[]
  tripped: boolean
  attended: boolean
  open: KindSense[] // tripped, not consented, and open (skip 3.3)
  gating: KindSense[] // tripped, not consented, and not open (skip 3.3)
  consent: Partial<Record<Kind, number>> // consent that covers each kind's window
  stop?: StoppedRecord // the stop that applies
  question?: Question // this copy's open question
  toldCount: number
  phase: Phase
}

const NAME = 'spare10'
const ENV = crypto.randomUUID() // this copy of the module
const HANDOFF_LIMIT = 5
const FAST_MS = 1000
const FAST_LIMIT = 3
const PULSE_MS = 1000
const BUDGET_LOG_MS = 600_000 // one budget debug line per 10 minutes per question (B40)
const EDGE_LIMIT = 64
const WATCH_MS = 300_000 // the period of the watch timer, the ticker's slow second clock (4.2)
const BOX_DEFER_LIMIT = 10 // ticks the resume prompt waits for the prompt box (4.6.2)
const STALE_TICK_MS = 90_000 // /spare10 warns when the last tick is older (2.7)

function noKinds<T>(make: () => T): Record<Kind, T> {
  return { five_hour: make(), seven_day: make() }
}

let base: Settings = DEFAULTS // register()
let effective: Promise<Effective> | undefined // register() resets it
let autoNow: boolean = DEFAULTS.autoResume // this copy's effective autoResume, answered by $.spare10.auto()
let spansNow: Spans = NO_SPANS // B47: this copy's spans of its last successful settings read, answered by $.spare10.spans()
let attended: boolean | undefined // session.start, else lazily
let sid: string | undefined // session.start, refreshed by stoppedNow, writeStopped, writeConsent, and act on a tell or headless verdict
let endedSid: string | undefined // the id the last /clear or /resume ended: its stop no longer counts (D3)
const pastIds = new Set<string>() // ids that /clear or /resume ended in this process: their consent is this process's
let bgKind: boolean | undefined // CLAUDE_CODE_SESSION_KIND=bg, read once
const mem: Record<Kind, Memory> = noKinds(initialMemory)
let seedLoaded = false
let test: Partial<Record<Kind, Anchored>> = {}
let testFromEnvDone = false
let consentCache: Partial<Record<Kind, number>> = {}
let testConsent: Partial<Record<Kind, number>> = {} // a Resume on a test reading: never in the env, cleared with the test reading
let consentEpoch = 0
const fallbackEnd: Partial<Record<Kind, number>> = {} // R11: one fallback window end per kind and episode
let startWarnings: string[] = []
let seq = 0
let openKey: string | undefined
const questions = new Map<string, Question>()
const outcomes = new Map<string, Settled>()
const outcomeWaits = new Map<string, Array<(o: Settled) => void>>()
const needsRaise = new Set<string>()
const raising: Array<{ text: string; key: string }> = [] // one entry per $.ui.ask in flight, until that ask ends
const parked = new Map<string, (why: string) => void>()
let wake = newWake()
const stepped = new Set<string>()
const refusedTurns: string[] = []
const HOLDING = new WeakSet<object>()
const told: Record<Kind, { windowEnd: number; keys: Set<string> }> = noKinds(() => ({ windowEnd: 0, keys: new Set<string>() }))
const toldNoticeFor: Record<Kind, number> = noKinds(() => 0) // window end of the last B12 notice
const unattendedNoteFor: Record<Kind, number> = noKinds(() => 0) // window end of the last B15 debug line
const openNoteFor: Record<Kind, number> = noKinds(() => 0) // window end of the last open B15 debug line (skip 2.5)
let tickerWanted = false // session.start: enabled, and attended or wait
let ticker: Timer | undefined
let tickGen = 0
let lastTick = 0 // clock time of the last tick (the watchdog reads it)
let ticking = false // a tick is running: the next one skips its work
const edges: number[] = [] // times at which the badge can change
let release: Release | undefined // the ticker's stop release in flight in this copy (4.6)
let taking = false // a person path takes an overdue stop over (4.6.3)
let handedOver: { record: StoppedRecord; at: number } | undefined // cleared by the ticker while a person prompt was in flight
let personHeld = 0 // person prompt.submit dispatches in flight in this copy
let stopEpoch = 0 // writeStopped and clearStopped in this copy
let workMarked = false // markWork ran for the current stop
let lastRestored: string | undefined // the draft restoreDraft put back
let resumeDefers = 0 // ticks the resume prompt waited for the prompt box
let deferFor: string | undefined // the SPARE10_STOPPED value that resumeDefers counts for
let watch: Timer | undefined // the second clock: it re-arms a dead ticker (4.2)
let lastWatch = 0 // clock time of the last watch period (the ticker reads it)
let pulse: Timer | undefined
let blink = true
let viewKey = ''

// ---- Settings (8.2) ----

function settings($: EngineInterface): Promise<Effective> {
  effective ??= readEnv($).then(
    (env) => {
      const eff = withEnv(base, env)
      autoNow = eff.autoResume
      spansNow = { lastMinutes: eff.lastMinutes, weeklyLastHours: eff.weeklyLastHours }
      return eff
    },
    () => {
      effective = undefined // a failed read is tried again at the next event
      return unreadEnv(base) // B47: spans of 0 until a read succeeds
    },
  )
  return effective
}

async function readEnv($: EngineInterface): Promise<EnvReads> {
  const reserve = await $.env.get('SPARE10_RESERVE')
  const weeklyReserve = await $.env.get('SPARE10_WEEKLY_RESERVE')
  const lastMinutes = await $.env.get('SPARE10_LAST_MINUTES')
  const weeklyLastHours = await $.env.get('SPARE10_WEEKLY_LAST_HOURS')
  const pausePrompt = await $.env.get('SPARE10_PAUSE_PROMPT')
  const autoResume = await $.env.get('SPARE10_AUTO_RESUME')
  const headless = await $.env.get('SPARE10_HEADLESS')
  const onOff = await $.env.get('SPARE10')
  const simulate = await $.env.get('SPARE10_SIMULATE')
  return {
    ...(reserve !== undefined && { reserve }),
    ...(weeklyReserve !== undefined && { weeklyReserve }),
    ...(lastMinutes !== undefined && { lastMinutes }),
    ...(weeklyLastHours !== undefined && { weeklyLastHours }),
    ...(pausePrompt !== undefined && { pausePrompt }),
    ...(autoResume !== undefined && { autoResume }),
    ...(headless !== undefined && { headless }),
    ...(onOff !== undefined && { onOff }),
    ...(simulate !== undefined && { simulate }),
  }
}

const modeOf = (cfg: Effective): Mode => (cfg.pausePrompt === null ? 'hold' : 'tell')

// ---- Attendance (9.1) ----

async function isAttended($: EngineInterface): Promise<boolean> {
  if (attended !== undefined) return attended
  attended = (await $.session.surfaces()).includes('terminal')
  return attended
}

// ---- Reading (6, 3.1 of 0.2) ----

/** A test reading of a kind: `in` from now, else the live reset, else one window from now. */
function testReading(pct: number, kind: Kind, live: SessionRateLimit | undefined, now: number, inMs?: number): Anchored {
  const liveReset = live === undefined ? null : parseReset(live.resetsAt)
  const resetsAtMs = inMs !== undefined ? now + inMs : (liveReset ?? now + windowMs(kind))
  addEdge(resetsAtMs)
  return { pct, resetsAtMs }
}

/**
 * The spans in force (B47): the newest copy's answer. A copy that cannot reach the noun uses 0. The
 * try also covers a newest copy whose noun has no spans method (an older build): that call throws
 * before it returns a promise, and a throw here would fail the whole sense open.
 */
async function spansInForce($: EngineInterface): Promise<Spans> {
  try {
    return await $.spare10.spans()
  } catch {
    return NO_SPANS
  }
}

type Bases = Record<Kind, { basis: Basis; real: Basis }> // with the test reading, and without it (B45)

/** One usage read, the seeds once, the test reading per kind. */
async function currentBases($: EngineInterface, now: number): Promise<Bases> {
  if (!seedLoaded) {
    seedLoaded = true
    const five = asAnchored(await $.store.get('seed').catch(() => undefined))
    if (five !== undefined) mem.five_hour = { ...mem.five_hour, seed: newer(mem.five_hour.seed, five) }
    const week = asAnchored(await $.store.get('seed-weekly').catch(() => undefined))
    if (week !== undefined) mem.seven_day = { ...mem.seven_day, seed: newer(mem.seven_day.seed, week) }
  }
  const limits = (await $.session.usage()).rateLimits
  for (const kind of KINDS) {
    const live = limitOf(limits, kind)
    if (live !== undefined) mem[kind] = sawLive(mem[kind], live, now)
  }
  if (!testFromEnvDone) {
    testFromEnvDone = true
    const cfg = await settings($)
    if (cfg.testPct !== undefined) {
      const kind = cfg.testKind ?? 'five_hour'
      test[kind] = testReading(cfg.testPct, kind, limitOf(limits, kind), now, cfg.testInMs)
    }
  }
  const both = (kind: Kind): { basis: Basis; real: Basis } => ({
    basis: basis(limitOf(limits, kind), mem[kind], now, test[kind], kind),
    real: basis(limitOf(limits, kind), mem[kind], now, undefined, kind),
  })
  return { five_hour: both('five_hour'), seven_day: both('seven_day') }
}

/** The spans for one sense: asked only when a watched kind is tripped, so an event below the reserve costs no noun call. */
async function spansFor($: EngineInterface, cfg: Effective, bases: Bases): Promise<Spans> {
  const anyTripped = watchedKinds(cfg).some((kind) => isTripped(bases[kind].basis, reserveOf(cfg, kind)))
  return anyTripped ? await spansInForce($) : NO_SPANS
}

/** The window end that bounds consent and stopped. Without resetsAt, one fallback per kind and episode (R11). */
function windowEndFor(kind: Kind, b: Basis, now: number): number {
  if (b.kind !== 'none' && b.resetsAtMs !== null) {
    delete fallbackEnd[kind]
    return b.resetsAtMs
  }
  const f = fallbackEnd[kind]
  if (f !== undefined && now < f) return f
  fallbackEnd[kind] = now + FALLBACK_MS
  return now + FALLBACK_MS
}

function sensesOf(cfg: Effective, bases: Bases, spans: Spans, now: number): KindSense[] {
  return watchedKinds(cfg).map((kind) => {
    const reserve = reserveOf(cfg, kind)
    const span = spanOf(spans, kind)
    const v = viewOf(bases[kind].real, bases[kind].basis, reserve, span, now) // B41, B45
    const b = v.basis
    const windowEnd = windowEndFor(kind, b, now)
    if (v.tripped && v.skipAt !== null) addEdge(v.skipAt) // the ticker redraws at the skip start (skip 4.1)
    return {
      kind,
      reserve,
      basis: b,
      tripped: v.tripped,
      windowEnd,
      holdEnd: v.skipAt ?? holdEndOf(b, mem[kind], now, kind),
      stopEnd: v.skipAt ?? windowEnd,
      span,
      skipAt: v.skipAt,
      open: v.open,
      test: b.kind === 'test',
      seed: b.kind === 'seed',
    }
  })
}

function noteBasis($: EngineInterface, kinds: ReadonlyArray<{ kind: Kind; basis: Basis; tripped: boolean; open: boolean }>): void {
  // The reset is in the key too: a new window at the same figure starts a new told set (5.1).
  const key = kinds
    .map((k) => `${k.kind}:${k.basis.kind}:${k.basis.kind === 'none' ? k.basis.why : `${k.basis.pct}:${k.basis.resetsAtMs}`}:${k.tripped}:${k.open}`)
    .join('|')
  if (key === viewKey) return
  viewKey = key
  redraw($)
}

// ---- Consent and stopped (3.5, 3.2) ----

async function isBg($: EngineInterface): Promise<boolean> {
  bgKind ??= (await $.env.get('CLAUDE_CODE_SESSION_KIND')) === 'bg'
  return bgKind
}

/** The consent end of a kind in force: this copy's caches, and an env value that belongs to this process (3.5, 9.3). */
async function consentMs($: EngineInterface, kind: Kind, attendedNow: boolean, testBasis: boolean): Promise<number> {
  const epoch = consentEpoch
  // Two branches, so each $.env.get keeps a literal name.
  const raw = kind === 'seven_day' ? await $.env.get('SPARE10_WEEKLY_CONSENT') : await $.env.get('SPARE10_CONSENT')
  const c = parseConsent(raw)
  const counts =
    c !== undefined &&
    consentCounts(c.sessionId, {
      attended: attendedNow,
      bg: attendedNow && c.sessionId === undefined ? await isBg($) : false,
      ids: attendedNow && c.sessionId !== undefined ? [...pastIds, await $.session.id()] : [],
    })
  const cached = consentCache[kind] ?? 0
  if (epoch !== consentEpoch) return cached // a clear ran meanwhile: this read is stale
  return Math.max(cached, testBasis ? (testConsent[kind] ?? 0) : 0, counts ? c.until : 0)
}

function noteConsent(kind: Kind, until: number, isTest: boolean): void {
  if (isTest) testConsent[kind] = Math.max(testConsent[kind] ?? 0, until)
  else consentCache[kind] = Math.max(consentCache[kind] ?? 0, until)
}

async function writeConsent($: EngineInterface, kind: Kind, until: number, now: number, isTest: boolean): Promise<void> {
  if (until <= now) return // never for a window that has ended (R10)
  noteConsent(kind, until, isTest)
  addEdge(until)
  if (isTest) return // a Resume on a test reading never carries into real use (3.5)
  sid = await $.session.id() // stamped: only this process honours it in an attended session (9.3)
  if (kind === 'seven_day') await $.env.set('SPARE10_WEEKLY_CONSENT', formatConsent(sid, until))
  else await $.env.set('SPARE10_CONSENT', formatConsent(sid, until))
}

async function clearConsent($: EngineInterface): Promise<void> {
  consentEpoch += 1
  consentCache = {}
  testConsent = {}
  await Promise.all([$.env.set('SPARE10_CONSENT', undefined), $.env.set('SPARE10_WEEKLY_CONSENT', undefined)])
}

/** After /clear or /resume: a consent stamped with an ended id of this process takes the new id. */
async function restampConsent($: EngineInterface): Promise<void> {
  const epoch = consentEpoch
  const five = parseConsent(await $.env.get('SPARE10_CONSENT'))
  const week = parseConsent(await $.env.get('SPARE10_WEEKLY_CONSENT'))
  const ended = (c: typeof five): c is { until: number; sessionId: string } => c?.sessionId !== undefined && pastIds.has(c.sessionId)
  if (!ended(five) && !ended(week)) return
  const id = await $.session.id()
  if (epoch !== consentEpoch) return // cleared meanwhile
  if (ended(five) && id !== five.sessionId) await $.env.set('SPARE10_CONSENT', formatConsent(id, five.until))
  if (ended(week) && id !== week.sessionId) await $.env.set('SPARE10_WEEKLY_CONSENT', formatConsent(id, week.until))
}

/** The stop of this conversation that applies now, if any. */
async function stoppedNow($: EngineInterface, now: number): Promise<StoppedRecord | undefined> {
  sid = await $.session.id()
  const st = parseStopped(await $.env.get('SPARE10_STOPPED'))
  // A stop of the conversation that /clear or /resume ended no longer counts, also before the engine
  // answers the new id (D3).
  return st !== undefined && st.sessionId === sid && st.sessionId !== endedSid && now < st.windowEnd ? st : undefined
}

/** 5.7: the 0.2 record, merged with an earlier stop of this session (3.2). Returns what it wrote, for the texts. */
async function writeStopped(
  $: EngineInterface,
  n: { kinds: Kind[]; windowEnd: number; work: boolean; auto: boolean; test: boolean; skip: boolean },
  now: number,
): Promise<StoppedRecord> {
  sid = await $.session.id() // R3: a fresh id, a /clear may have run since the last read
  const prev = parseStopped(await $.env.get('SPARE10_STOPPED').catch(() => undefined))
  const { skip, ...rest } = n
  const r = mergeStopped(prev, { ...rest, ...(skip ? { skip: true } : {}), sessionId: sid, at: now }, now)
  stopEpoch += 1
  workMarked = r.work === true
  await $.env.set('SPARE10_STOPPED', formatStopped(r))
  addEdge(r.windowEnd)
  addEdge(stopDue(r))
  return r
}

async function clearStopped($: EngineInterface): Promise<void> {
  stopEpoch += 1
  workMarked = false
  await $.env.set('SPARE10_STOPPED', undefined)
}

/** 5.7: the first refused loop of a stop adds `work`, so the reset continues it. Never delays the refusal. */
function markWork($: EngineInterface): void {
  if (workMarked) return
  workMarked = true
  const epoch = stopEpoch
  void (async () => {
    const raw = await $.env.get('SPARE10_STOPPED')
    const r = parseStopped(raw)
    if (r?.kinds === undefined || r.work === true || r.sessionId !== sid) return
    // A Resume, a release or a new Stop may have come meanwhile: write only over the value just read.
    if ((await $.env.get('SPARE10_STOPPED')) !== raw || epoch !== stopEpoch) return
    await $.env.set('SPARE10_STOPPED', formatStopped({ ...r, work: true }))
  })().catch(() => {
    workMarked = false
  })
}

async function listed($: EngineInterface, agentId: string): Promise<boolean> {
  return (await $.agent.list()).some((a) => a.id === agentId)
}

// ---- The decision (5.2) ----

async function sense($: EngineInterface): Promise<Sensed> {
  const cfg = await settings($)
  const now = await $.clock.now()
  const bases = await currentBases($, now)
  const kinds = sensesOf(cfg, bases, await spansFor($, cfg, bases), now)
  noteBasis($, kinds)
  const tripped = kinds.some((k) => k.tripped)
  return { cfg, now, kinds, tripped, attended: tripped ? await isAttended($) : attended === true }
}

/**
 * Skip 3.3: the tripped kinds that are not consented, split into those that gate and those that are
 * open. Never throws: an unreadable consent is not consent.
 */
async function splitOf($: EngineInterface, s: { kinds: readonly KindSense[]; now: number; attended: boolean }): Promise<Split> {
  const out: Split = { gating: [], open: [] }
  for (const k of s.kinds) {
    if (!k.tripped) continue
    const until = await consentMs($, k.kind, s.attended, k.test).catch(() => 0) // unreadable: not consented
    if (consentCovers(until, s.now, k.windowEnd)) continue
    if (k.open) out.open.push(k)
    else out.gating.push(k)
  }
  return out
}

/** The watched kinds that gate: tripped, not consented and not open. Never throws. */
async function gatingOf($: EngineInterface, s: Sensed): Promise<KindSense[]> {
  return (await splitOf($, s)).gating
}

function toldHas(k: KindSense, key: string): boolean {
  const t = told[k.kind]
  return t.windowEnd === k.windowEnd && t.keys.has(key)
}

async function act($: EngineInterface, s: Sensed, ctx: Ctx): Promise<Acted> {
  // The round after a Resume leaves out the kinds it answered: only a kind the dialog did not name asks again (B38).
  const resumed = ctx.resumed ?? []
  const gating = s.cfg.enabled ? (await gatingOf($, s)).filter((k) => !resumed.includes(k.kind)) : []
  const consented = s.cfg.enabled && s.tripped && gating.length === 0
  const stopped =
    s.cfg.enabled && s.attended && !consented ? (await stoppedNow($, s.now).catch(() => undefined)) !== undefined : false
  const mainTold = gating.length > 0 && gating.every((k) => toldHas(k, `${sid ?? ''}:main`))
  const seedOnly = gating.length > 0 && gating.every((k) => k.seed)
  let verdict = decide({
    site: ctx.site,
    tripped: s.tripped,
    enabled: s.cfg.enabled,
    consented,
    attended: s.attended,
    headless: s.cfg.headless,
    mode: modeOf(s.cfg),
    person: ctx.person === true,
    stopped,
    mainTold,
    seedOnly,
  })
  if (
    (verdict.kind === 'hold' || verdict.kind === 'refuse') &&
    ctx.site === 'tool' &&
    ctx.agentId !== undefined &&
    !stepped.has(ctx.agentId) &&
    !(await listed($, ctx.agentId).catch(() => true))
  ) {
    verdict = { kind: 'pass', trip: true } // an engine fork: never held (G8)
  }
  // The told key and HEADLESS carry the current id: a /clear brings no session.start (3.6), and an
  // unattended run never reaches stoppedNow.
  if (verdict.kind === 'tell' || (!s.attended && (verdict.kind === 'refuse' || verdict.kind === 'hold'))) {
    sid = await $.session.id().catch(() => sid)
  }
  if (s.cfg.enabled && !s.attended) noteUnattended($, s) // B15 debug line, once per kind and window (R2: enabled runs only)
  return { verdict, stopped, gating }
}

/**
 * The figures of some kinds, five_hour first. A hold end that is not the reset (a reading without a
 * reset time, or a skip start ahead) rides along for {at}. `owner`: a skip owner, whose kinds with a
 * skip start ahead carry their span for {lead} (skip 2.1).
 */
function factsFrom(ks: readonly KindSense[], now: number, owner = false): Facts[] {
  return ks.map((k) => {
    const f = factsOf(k.basis, k.reserve, undefined, k.kind, now)
    const reset = k.basis.kind === 'none' ? undefined : k.basis.resetsAtMs
    return {
      ...f,
      ...(reset !== undefined && k.holdEnd !== reset ? { holdEnd: k.holdEnd } : {}),
      ...(k.test ? { test: true } : {}),
      ...(owner && k.skipAt !== null ? { span: k.span } : {}),
    }
  })
}

/** The kinds a text names: the gating kinds, else the tripped ones. */
const namedKinds = (s: Sensed, a: Acted): KindSense[] => (a.gating.length > 0 ? a.gating : s.kinds.filter((k) => k.tripped))

function refusalText(kind: 'stop' | 'paused' | 'headless', s: Sensed, a: Acted): string {
  const f = factsFrom(namedKinds(s, a), s.now)
  if (kind === 'stop') return stopText(f)
  if (kind === 'paused') return pausedText(f)
  return headlessText(f, sid ?? '')
}

const tellText = (s: Sensed, a: Acted): string => pauseInstruction(factsFrom(namedKinds(s, a), s.now), s.cfg.pausePrompt)

const namedOf = (q: Question): Named[] => q.kinds.map((kind) => ({ kind, test: q.ends[kind]?.test === true }))
const namedStop = (r: StoppedRecord): Named[] => (r.kinds ?? ['five_hour']).map((kind) => ({ kind, test: r.test === true }))

// ---- The hold (4.4, 5.4) ----

function newWake(): Wake {
  let fire: () => void = () => undefined
  const p = new Promise<'woke'>((resolve) => {
    fire = () => resolve('woke')
  })
  return { p, fire }
}

function wakeAll(): void {
  for (const resolve of parked.values()) resolve('wake')
  parked.clear()
  wake.fire()
  wake = newWake()
}

function outcomeOf(key: string): Promise<Settled> {
  const o = outcomes.get(key)
  if (o !== undefined) return Promise.resolve(o)
  return new Promise((resolve) => outcomeWaits.set(key, [...(outcomeWaits.get(key) ?? []), resolve]))
}

async function hold($: EngineInterface, signal: AbortSignal, key: string, left: () => number): Promise<Settled | 'aborted'> {
  const q0 = questions.get(key)
  if (q0 !== undefined) q0.waiting += 1
  try {
    const waiter = crypto.randomUUID()
    const aborted = new Promise<'aborted'>((resolve) => {
      if (signal.aborted) resolve('aborted')
      else signal.addEventListener('abort', () => resolve('aborted'), { once: true })
    })
    let fast = 0
    for (;;) {
      const o = outcomes.get(key)
      if (o !== undefined) return o
      if (signal.aborted) return 'aborted'
      if (!questions.has(key)) return 'stop' // closed under a live waiter: fail closed
      if (left() < BUDGET_FLOOR_MS) {
        void settle($, key, 'stop', 'time limit') // B40: before the budget runs out
        return 'stop'
      }
      if (needsRaise.has(key)) {
        needsRaise.delete(key)
        raise($, key, { signal }) // this waiter raises the dialog (4.5)
      }
      const t0 = performance.now()
      const carrier = $.spare10.park({ waiter }).then(
        () => 'woke' as const,
        () => 'rejected' as const,
      )
      // The park call is in flight from here: the reads below cost the budget nothing (G2).
      const d = await decidedElsewhere($, key)
      if (d !== undefined) {
        void settle($, key, d, 'elsewhere')
        return d
      }
      if (await dueCheck($, key)) continue // the top returns 'again'
      await noteBudget($, key, left())
      // A hand-off or a close that came while this waiter read the env: act on it now, not after a carrier cycle.
      if (outcomes.has(key) || signal.aborted || needsRaise.has(key) || !questions.has(key)) continue
      const r = await Promise.race([carrier, wake.p, aborted])
      if (r === 'aborted') return 'aborted'
      if (r === 'rejected' && performance.now() - t0 < FAST_MS) {
        fast += 1
        if (fast >= FAST_LIMIT) return 'stop' // the noun is gone: never spin, fail closed
      } else fast = 0
    }
  } catch {
    return 'stop' // a hold never throws
  } finally {
    const q = questions.get(key)
    if (q !== undefined) {
      q.waiting -= 1
      // Nobody left to raise it, or a silent hold with no waiter (5.5).
      if (q.waiting === 0 && !outcomes.has(key) && (needsRaise.has(key) || q.silent)) forget($, key)
    }
  }
}

async function decidedElsewhere($: EngineInterface, key: string): Promise<Outcome | undefined> {
  const q = questions.get(key)
  if (q === undefined) return undefined
  const now = await $.clock.now().catch(() => q.since)
  let covered = q.kinds.length > 0
  for (const kind of q.kinds) {
    const end = q.ends[kind]
    const until = end === undefined ? 0 : await consentMs($, kind, !q.silent, end.test).catch(() => 0)
    if (end === undefined || !consentCovers(until, now, end.end)) {
      covered = false
      break
    }
  }
  if (covered) return 'resume'
  // R6: a stop from another copy settles a question in hold and tell mode alike.
  const st = parseStopped(await $.env.get('SPARE10_STOPPED').catch(() => undefined))
  if (st === undefined || st.at <= q.since || now >= st.windowEnd) return undefined
  const id = await $.session.id().catch(() => sid)
  return st.sessionId === id ? 'stop' : undefined
}

/** 4.5: the waiter's check. True when the question ended as again. */
async function dueCheck($: EngineInterface, key: string): Promise<boolean> {
  const q = questions.get(key)
  if (q === undefined || q.checking || outcomes.has(key)) return false
  q.checking = true // before the first await: one waiter at a time
  try {
    const now = await $.clock.now()
    const due = now >= q.due
    if (!due && now < q.nextCheck && (q.noted || now < q.noteAt)) return false
    q.nextCheck = now + CHECK_MS
    if (!q.silent && !(await $.spare10.auto().catch(() => q.auto))) {
      // The setting in force now says wait for the answer (1.3 item 6, B6).
      if (!q.noted && now >= q.noteAt) {
        if (!q.skip) {
          q.noted = true
          $.ui.log(notice.resetWaitingFor(namedOf(q))) // D0.2, byte for byte
          return false
        }
        // B43: the note names what opened or reset, so it senses. A throw: the catch logs it, the next check tries again.
        const s = await sense($)
        const gatingNow = await gatingOf($, s)
        const ended = endedFor(namedOf(q), s, gatingNow, true)
        if (ended.reset.length === 0 && ended.open.length === 0) {
          // B45: nothing of the question opened yet (a real trip beneath a test reading). Wait for its hold end.
          const mine = gatingNow.filter((k) => q.kinds.includes(k.kind))
          q.noteAt = Math.max(now + CHECK_MS, ...mine.map((k) => k.holdEnd))
          addEdge(q.noteAt)
          return false
        }
        q.noted = true
        // New work goes on only while no kind gates: a window that still gates holds new work too.
        $.ui.log(notice.resetWaitingFor(ended.reset, ended.open, gatingNow.length === 0))
      }
      return false
    }
    if (!due && now >= q.holdEnd) return false // past the reset, inside the margin: wait (4.8)
    const s = await sense($) // throws: nothing is released
    const gatingNow = await gatingOf($, s)
    // Before the due time only when no kind gates. A stop never holds an open kind (B44), so no kind
    // gating means the gate lets the held loops through (skip 4.3).
    if (!due && gatingNow.length > 0) return false
    if (gatingNow.length === 0 && resetTooRecent(s)) return false // a test window that ends near a real reset (4.8)
    if (outcomes.has(key)) return false // answered meanwhile
    settleAgain($, key, due ? 'reset' : 'quota', gatingNow, s)
    return true
  } catch (err) {
    $.ui.log(debugLine.checkFailed(String(err)), { to: 'debug' })
    return false
  } finally {
    q.checking = false
  }
}

/**
 * 4.8: a watched kind whose last real reading was in the reserve reset less than the 5-minute margin
 * ago. A release waits for it: the 60 s margin of a test window never applies at a real reset.
 */
const resetTooRecent = (s: Sensed): boolean => s.kinds.some((k) => inResetMargin(mem[k.kind].seed, k.reserve, s.now))

/**
 * Skip 4.4: which kinds of a question or a stop reset, and which are open now. A kind is named as reset
 * when it is neither open nor gating now. With no skip owner and no open kind, the D0.2 lists (every
 * named kind reset), so each notice keeps its D0.2 wording. `owner` with no sense: nothing is known.
 */
function endedFor(
  named: readonly Named[],
  s: { kinds: readonly KindSense[]; now: number } | undefined,
  gatingNow: readonly KindSense[],
  owner: boolean,
): Ended {
  if (s === undefined) return owner ? { reset: [], open: [] } : { reset: [...named], open: [] }
  const open = factsFrom(s.kinds.filter((k) => k.open && named.some((n) => n.kind === k.kind)), s.now)
  if (!owner && open.length === 0) return { reset: [...named], open: [] }
  const reset = named.filter(
    (n) => !open.some((f) => (f.kind ?? 'five_hour') === n.kind) && !gatingNow.some((k) => k.kind === n.kind),
  )
  return { reset, open }
}

/** 4.5: the question ends without an answer. Synchronous, writes nothing: every held loop decides afresh. */
function settleAgain($: EngineInterface, key: string, via: 'reset' | 'quota', gatingNow: readonly KindSense[], s: Sensed): void {
  if (outcomes.has(key)) return
  const q = questions.get(key)
  outcomes.set(key, 'again')
  needsRaise.delete(key)
  for (const resolve of outcomeWaits.get(key) ?? []) resolve('again') // withdraws this copy's dialog
  outcomeWaits.delete(key)
  if (openKey === key) openKey = undefined
  wakeAll()
  if (q !== undefined) {
    const ended = endedFor(namedOf(q), s, gatingNow, q.skip)
    if (!q.skip && ended.open.length === 0) {
      // D0.2, byte for byte
      if (via === 'quota') $.ui.log(notice.outOfReserve)
      else if (gatingNow.length === 0) $.ui.log(notice.resetContinues(namedOf(q)))
      else $.ui.log(notice.resetStillHeld(namedOf(q), factsFrom(gatingNow, s.now)))
    } else if (gatingNow.length === 0) {
      $.ui.log(ended.reset.length + ended.open.length > 0 ? notice.resetContinues(ended.reset, ended.open) : notice.outOfReserve)
    } else {
      $.ui.log(notice.resetStillHeld(ended.reset, factsFrom(gatingNow, s.now), ended.open))
    }
  }
  redraw($)
}

/** B40: the waiter logs its budget once per 10 minutes per question, so LC25 can measure a cycle. */
async function noteBudget($: EngineInterface, key: string, leftMs: number): Promise<void> {
  const q = questions.get(key)
  if (q === undefined) return
  const now = await $.clock.now()
  if (now - q.budgetLogAt < BUDGET_LOG_MS) return
  q.budgetLogAt = now
  $.ui.log(debugLine.budget(Math.round((now - q.since) / 60_000), Math.round(leftMs)), { to: 'debug' })
}

// ---- The question (4.3, 4.5, 4.6, 5.6) ----

/** A kind's hold end plus this is when it may be released: 0 at a skip start (B42), else the reset margin (4.8). */
const dueMargin = (k: KindSense): number => marginOf(k.skipAt !== null, k.test)

function ensureQuestion($: EngineInterface, opener: 'loop' | 'prompt', s: Sensed, a: Acted): string {
  const g = namedKinds(s, a)
  if (openKey !== undefined) {
    const open = questions.get(openKey)
    if (open !== undefined && joinable(outcomes.get(openKey), open.kinds, g.map((k) => k.kind))) {
      if (opener === 'loop') open.loops += 1
      return openKey // join (synchronous check: no race)
    }
    // A settled again, or a settled Resume that did not name a kind that gates now: a new question.
  }
  seq += 1
  const key = `${ENV}:${seq}`
  openKey = key
  const ends: Question['ends'] = {}
  for (const k of g) ends[k.kind] = { end: k.windowEnd, test: k.test, ...(k.skipAt === null ? {} : { skipAt: k.skipAt }) }
  const latestEnd = Math.max(...g.map((k) => k.windowEnd))
  const holdEnd = Math.max(...g.map((k) => k.holdEnd))
  const due = Math.max(...g.map((k) => k.holdEnd + dueMargin(k)))
  // B42: a skip owner only when a skip start is the hold end, and no kind of it is due later.
  const skip = g.some((k) => k.skipAt === holdEnd) && due === holdEnd
  const q: Question = {
    kinds: g.map((k) => k.kind),
    ends,
    latestEnd,
    stopEnd: Math.max(...g.map((k) => k.stopEnd)),
    holdEnd,
    due,
    skip,
    noteAt: skip ? holdEnd : latestEnd,
    nextCheck: s.now + CHECK_MS,
    budgetLogAt: s.now,
    silent: !s.attended,
    auto: s.cfg.autoResume,
    loops: opener === 'loop' ? 1 : 0,
    checking: false,
    since: s.now,
    mode: modeOf(s.cfg),
    opener,
    facts: factsFrom(g, s.now, skip),
    waiting: 0,
    handoffs: 0,
    noted: false,
  }
  questions.set(key, q)
  if (!q.silent) needsRaise.add(key) // the first waiter to loop raises it
  for (const k of g) addEdge(k.windowEnd)
  addEdge(q.holdEnd)
  addEdge(q.due)
  addEdge(q.stopEnd)
  addEdge(q.noteAt)
  redraw($)
  return key
}

function raise($: EngineInterface, key: string, r: Raiser): void {
  const q = questions.get(key)
  if (q === undefined || outcomes.has(key)) return // settled before this waiter got to it
  q.raiser = r
  const text = questionText(q.facts, q.opener, q.mode, q.auto)
  // The entry lives until this ask ends, never less: a question settled before its dialog reaches hook 5
  // must still find it there, so that hook 5 withdraws the dialog (4.3).
  const entry = { text, key }
  raising.push(entry)
  const ended = (): void => {
    const i = raising.indexOf(entry)
    if (i >= 0) raising.splice(i, 1)
  }
  try {
    void $.ui.ask(text, { options: [...QUESTION_OPTIONS], header: HEADER }).then(
      (answer) => {
        ended()
        void settle($, key, askVerdict(answer, RESUME_LABEL), 'dialog')
      },
      () => {
        ended()
        lost($, key, r)
      },
    )
  } catch {
    ended()
    void settle($, key, 'stop', 'could not ask')
  }
}

function lost($: EngineInterface, key: string, r: Raiser): void {
  const q = questions.get(key)
  if (q === undefined || outcomes.has(key)) return // withdrawn by spare10 itself
  if (r.signal.aborted) {
    // The raiser's dispatch went away and nobody answered.
    if (q.waiting === 0) return forget($, key) // nothing is held any more
    if (q.handoffs < HANDOFF_LIMIT) {
      q.handoffs += 1
      q.raiser = undefined
      needsRaise.add(key)
      $.ui.log(debugLine.handedOn(q.handoffs), { to: 'debug' })
      wakeAll() // a live waiter picks it up
      return
    }
  }
  void settle($, key, 'stop', 'dialog ended without an answer') // Esc, dismissed, time limit, no tool
}

function forget($: EngineInterface, key: string): void {
  questions.delete(key)
  needsRaise.delete(key)
  outcomeWaits.delete(key)
  if (openKey === key) openKey = undefined
  redraw($)
}

function takeRaising(text: string): string | undefined {
  const i = raising.findIndex((r) => r.text === text)
  return i < 0 ? undefined : raising.splice(i, 1)[0]?.key
}

const questionOf = (e: unknown): string =>
  (e as { questions?: Array<{ question?: string }> }).questions?.[0]?.question ?? ''

/**
 * Settles a question. For a Stop that this copy writes, it returns the record as written (merged, 3.2)
 * and its time for the reply. For a Stop after the skip start (B46), it also returns what opened.
 */
async function settle($: EngineInterface, key: string, outcome: Outcome, via: Via): Promise<Late> {
  if (outcomes.has(key)) return {}
  // Every synchronous cache first, so an event that arrives during the writes sees the decision.
  outcomes.set(key, outcome)
  needsRaise.delete(key)
  const q = questions.get(key)
  for (const resolve of outcomeWaits.get(key) ?? []) resolve(outcome) // withdraws this copy's dialog
  outcomeWaits.delete(key)
  if (outcome === 'resume' && q !== undefined) {
    for (const kind of q.kinds) {
      const end = q.ends[kind]
      if (end !== undefined) noteConsent(kind, end.end, end.test)
    }
  }
  wakeAll()
  let late: Late = {}
  try {
    if (via === 'elsewhere' || q === undefined) return {}
    const now = await $.clock.now()
    if (outcome === 'resume') {
      for (const kind of q.kinds) {
        const end = q.ends[kind]
        if (end !== undefined) await writeConsent($, kind, end.end, now, end.test) // each kind's own test flag
      }
      await clearStopped($)
      if (via !== 'command') {
        const open = q.kinds.filter((kind) => (q.ends[kind]?.end ?? 0) > now)
        $.ui.log(
          open.length > 0
            ? notice.continuing(q.facts.filter((f) => open.includes(f.kind ?? 'five_hour')))
            : notice.newWindowFor(q.kinds),
        )
      }
    } else if (!q.silent && (q.mode === 'hold' || via === 'command')) {
      late = await settleStop($, q, via, now)
    }
    if (openKey === key) openKey = undefined // the decision is readable in env now
    await $.spare10.poke({ from: ENV }) // wake the newest copy's waiters (3.6)
  } catch {
    // best effort: this copy's caches and outcomes already hold the decision
  } finally {
    // Closed only now: a crossing during the writes joins the settled question and gets its outcome.
    if (openKey === key) openKey = undefined
    redraw($)
  }
  return late
}

/**
 * A Stop here (skip 3.5, B46). When the question's time has passed (its hold end with autoResume on,
 * its skip start with it off), one sense gives the kinds that gate now (`late`) and the question's kinds
 * that are open now (`opened`). The kinds that gate are stopped as usual. When nothing gates, a kind of
 * the question is open, and no work waits for a resume prompt, nothing is written: such a stop would
 * never apply. A failed sense gives empty lists: the D0.2 write.
 */
async function settleStop($: EngineInterface, q: Question, via: Via, now: number): Promise<Late> {
  const auto = await $.spare10.auto().catch(() => autoNow) // the setting in force
  const work = q.loops > 0
  const passed = auto ? q.holdEnd <= now : q.skip && q.stopEnd <= now
  let sNow: Sensed | undefined
  let late: KindSense[] = []
  let opened: KindSense[] = []
  if (passed) {
    try {
      sNow = await sense($)
      const split = await splitOf($, sNow)
      late = split.gating
      opened = split.open.filter((k) => q.kinds.includes(k.kind))
    } catch {
      sNow = undefined
    }
  }
  const until = auto ? Math.max(q.holdEnd, ...late.map((k) => k.holdEnd)) : Math.max(q.stopEnd, ...late.map((k) => k.stopEnd))
  const ended = sNow === undefined || opened.length === 0 ? undefined : endedFor(namedOf(q), sNow, late, true)
  if (until <= now && ended !== undefined && !(auto && work)) {
    // B46 open: nothing is stopped. Held work is refused (the outcome is stop), new work passes.
    if (via === 'time limit') $.ui.log(notice.holdLimitLate(q.facts, ended, false))
    else if (via !== 'command') $.ui.log(notice.stoppedLate(q.facts, ended, false))
    return { ended }
  }
  const kinds = KINDS.filter((k) => q.kinds.includes(k) || late.some((l) => l.kind === k))
  const allTest = q.kinds.every((kind) => q.ends[kind]?.test === true) && late.every((k) => k.test)
  const skipStarts = [
    ...q.kinds.map((kind) => q.ends[kind]?.skipAt).filter((t): t is number => t !== undefined),
    ...late.map((k) => k.skipAt).filter((t): t is number => t !== null),
  ]
  const skip = skipTag(until, skipStarts, [q.due, ...late.map((k) => k.holdEnd + dueMargin(k))], auto)
  const written = await writeStopped($, { kinds, windowEnd: until, work, auto, test: allTest, skip }, now)
  // The texts follow the record as written: the merge can add work, kinds and a later end (3.2). For a
  // skip owner, a late kind's fresh facts replace the question's (under B45 it is now sensed on the real
  // basis). Else only the late kinds that the question does not name are added (D0.2).
  const fresh = factsFrom(late, now, written.skip === true)
  const facts = byKind(
    q.skip
      ? [...q.facts.filter((f) => !late.some((k) => k.kind === (f.kind ?? 'five_hour'))), ...fresh]
      : [...q.facts, ...fresh.filter((f) => !q.kinds.includes(f.kind ?? 'five_hour'))],
  )
  const u = untilFor(facts, written.windowEnd, written.kinds ?? kinds, written.skip === true, now)
  if (ended !== undefined && late.length === 0 && auto && work && until <= now) {
    // B46 soon: the stop is written with its passed until, and the next tick continues the work.
    if (via === 'time limit') $.ui.log(notice.holdLimitLate(facts, ended, true))
    else if (via !== 'command') $.ui.log(notice.stoppedLate(facts, ended, true))
    return { record: written, ended, until: u }
  }
  // A skip stop shows its end in both modes: with autoResume off it ends by time then (skip 1.3 item 6).
  // With autoResume off, an end that has already passed (the window reset while the question waited,
  // or the sense failed) is no help to the person: the D0.2 text with no time.
  const shows = written.skip === true && (auto || written.windowEnd > now)
  const a = shows ? { ...u, work: auto && written.work === true } : auto ? { ...u, work: written.work === true } : undefined
  if (via === 'time limit') $.ui.log(notice.holdLimit(facts, a))
  else if (via !== 'command') $.ui.log(notice.stopped(facts, a))
  return { record: written, until: u }
}

const byKind = (fs: readonly Facts[]): Facts[] =>
  [...fs].sort((a, b) => KINDS.indexOf(a.kind ?? 'five_hour') - KINDS.indexOf(b.kind ?? 'five_hour'))

/** This copy's open question, if it is not settled yet. */
const openQuestion = (): string | undefined => (openKey !== undefined && !outcomes.has(openKey) ? openKey : undefined)

// ---- Tell mode (5) ----

/** A loop is told when some gating kind lacks its key. The claim adds the key to every gating kind. */
function claimTold(gating: readonly KindSense[], key: string): boolean {
  let fresh = false
  for (const k of gating) {
    if (told[k.kind].windowEnd !== k.windowEnd) told[k.kind] = { windowEnd: k.windowEnd, keys: new Set() }
    if (told[k.kind].keys.has(key)) continue
    told[k.kind].keys.add(key)
    fresh = true
  }
  return fresh
}

function noteTold($: EngineInterface, s: Sensed, a: Acted, key: string): void {
  $.ui.log(debugLine.told(key), { to: 'debug' })
  const ks = namedKinds(s, a)
  if (ks.every((k) => toldNoticeFor[k.kind] === k.windowEnd)) return
  for (const k of ks) toldNoticeFor[k.kind] = k.windowEnd
  $.ui.log(notice.told(factsFrom(ks, s.now)))
  redraw($)
}

function noteUnattended($: EngineInterface, s: Sensed): void {
  const fresh = s.kinds.filter((k) => k.tripped && !k.open && unattendedNoteFor[k.kind] !== k.windowEnd)
  if (fresh.length > 0) {
    for (const k of fresh) unattendedNoteFor[k.kind] = k.windowEnd
    $.ui.log(debugLine.unattended(factsFrom(fresh, s.now), s.cfg.headless), { to: 'debug' }) // R9: every policy
  }
  const opened = s.kinds.filter((k) => k.open && openNoteFor[k.kind] !== k.windowEnd)
  if (opened.length > 0) {
    for (const k of opened) openNoteFor[k.kind] = k.windowEnd
    $.ui.log(debugLine.unattendedOpen(factsFrom(opened, s.now)), { to: 'debug' }) // skip 2.5: every policy lets it through
  }
}

// ---- Turn end and draft (4.7) ----

function endTurn($: EngineInterface, turnId: string, attendedNow: boolean): void {
  const before = refusedTurns.includes(turnId)
  if (!before) {
    refusedTurns.push(turnId)
    if (refusedTurns.length > 32) refusedTurns.shift()
  }
  if (!shouldAbortTurn(attendedNow, before)) return
  void $.turn.abort({ turnId }).catch((err: unknown) => {
    $.ui.log(debugLine.abortFailed(String(err)), { to: 'debug' })
  })
}

function restoreDraft($: EngineInterface, text: string): void {
  lastRestored = text
  try {
    $.clock.after(0, () => {
      void (async () => {
        const box = await $.prompt.read()
        if (box.text.trim() === '') await $.prompt.fill({ text })
      })().catch(() => undefined)
    })
  } catch {
    // cosmetic
  }
}

// ---- The reset clock (4.2, 4.3) ----

function startTicker($: EngineInterface, now: number): void {
  ticker?.cancel()
  tickGen += 1
  lastTick = now // a fresh chain counts as alive
  ticking = false // a tick that never settled no longer blocks the new chain
  armTick($, tickGen)
}

function armTick($: EngineInterface, gen: number): void {
  try {
    ticker = $.clock.after(TICK_MS, () => {
      void tick($, gen)
    })
  } catch {
    ticker = undefined // the watchdog tries again
  }
}

/**
 * The ticker's second clock, armed with it in session.start (4.2). A hook that refuses one timer
 * dispatch ends only that chain, so each clock re-arms the other: the watch re-arms a dead ticker,
 * and a tick re-arms a dead watch. An idle stopped session has no measure and no redraw that could.
 */
function startWatch($: EngineInterface, now: number): void {
  watch?.cancel()
  lastWatch = now // a fresh interval counts as alive
  try {
    watch = $.clock.every(WATCH_MS, () => {
      void $.clock.now().then(
        (t) => {
          lastWatch = t
          watchTicker($, t)
        },
        () => undefined,
      )
    })
  } catch {
    watch = undefined // the next tick tries again
  }
}

async function tick($: EngineInterface, gen: number): Promise<void> {
  if (gen !== tickGen) return
  armTick($, gen) // the next step first: a hung await below never ends the chain
  if (ticking) return // the last tick still runs: skip this one's work
  ticking = true
  try {
    const now = await $.clock.now()
    const seenUpTo = lastTick
    lastTick = now
    if (now - lastWatch > 3 * WATCH_MS) startWatch($, now) // the watch interval ended
    if (edges.some((t) => t > seenUpTo && t <= now)) redraw($) // consent, stop and question ends, test ends
    pruneEdges(now)
    if (dueQuestion(now)) wakeAll() // the waiters run their checks (4.5)
    await stopTick($, now)
  } catch (err) {
    $.ui.log(debugLine.checkFailed(String(err)), { to: 'debug' })
  } finally {
    ticking = false
  }
}

/** Re-arms a dead ticker. Called from the watch timer, session.measure and ui.render, which settle at once. */
function watchTicker($: EngineInterface, now: number): void {
  if (tickerWanted && now - lastTick > 3 * TICK_MS) startTicker($, now)
}

/** A time at which the badge can change. Each time once. When full, the nearest times stay. */
function addEdge(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0 || edges.includes(ms)) return
  edges.push(ms)
  if (edges.length <= EDGE_LIMIT) return
  pruneEdges(lastTick) // the ticker has passed these
  if (edges.length <= EDGE_LIMIT) return
  edges.sort((x, y) => x - y)
  edges.splice(EDGE_LIMIT) // drop the farthest
}

function pruneEdges(now: number): void {
  for (let i = edges.length - 1; i >= 0; i -= 1) if ((edges[i] ?? 0) <= now) edges.splice(i, 1)
}

/** At session.start: the ends another copy wrote, so this copy redraws at them. */
async function rebuildEdges($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  for (const kind of KINDS) addEdge(await consentMs($, kind, attended === true, false).catch(() => 0))
  const st = parseStopped(await $.env.get('SPARE10_STOPPED').catch(() => undefined))
  if (st !== undefined && st.sessionId === (await $.session.id().catch(() => sid))) {
    addEdge(st.windowEnd)
    addEdge(stopDue(st))
  }
  pruneEdges(now)
}

/** An open question of this copy whose waiters should run their check now. */
function dueQuestion(now: number): boolean {
  for (const [key, q] of questions) {
    if (outcomes.has(key)) continue
    if (now >= q.due || now >= q.nextCheck || (!q.noted && now >= q.noteAt)) return true
  }
  return false
}

// ---- The stop at the due time (4.6) ----

async function stopTick($: EngineInterface, now: number): Promise<void> {
  if (release !== undefined || taking || personHeld > 0) return // a release, a takeover or a person prompt is in flight
  const raw = await $.env.get('SPARE10_STOPPED')
  const r = parseStopped(raw)
  if (raw === undefined || r?.kinds === undefined || r.auto !== true || now < stopDue(r)) return // 0.1, no auto, not due
  const cfg = await settings($)
  const id = await $.session.id()
  const action = stopAction({
    record: r,
    now,
    sessionId: id,
    endedSid,
    autoResume: cfg.autoResume,
    enabled: cfg.enabled,
    attended: attended === true,
  })
  if (action === 'drop') return dropStop($, raw) // another conversation (4.7)
  if (action !== 'check') return
  if ((await $.spare10.poke({ from: ENV })) !== 'self') return // only the newest copy acts
  const s = await sense($)
  const gatingNow = await gatingOf($, s)
  if (gatingNow.length === 0 && resetTooRecent(s)) return // a test stop that ends near a real reset (4.8)
  if (release !== undefined || taking || personHeld > 0) return // checked again after the awaits
  const rel: Release = { raw, record: r, cancelled: false }
  release = rel
  try {
    // The extension is a release too: a person path that takes the stop over meanwhile cancels it.
    if (gatingNow.length > 0) return await extendStop($, rel, gatingNow, s)
    if (r.work === true && (await typingNow($, raw))) return // 4.6.2: wait up to 10 ticks
    if (rel.cancelled) return // the person path cleared it and logged
    if ((await $.env.get('SPARE10_STOPPED')) !== raw) return // a prompt, a command or a copy took it
    const ended = endedFor(namedStop(r), s, [], r.skip === true) // skip 4.5: what reset and what opened
    const idNow = await $.session.id() // read before the clear: no await after it but one
    await clearStopped($)
    redraw($)
    if (rel.cancelled) return // the person path logged
    if (r.work !== true) {
      $.ui.log(notice.resetStopOver(ended.reset, ended.open))
      return
    }
    if (idNow !== r.sessionId || idNow === endedSid) {
      $.ui.log(debugLine.resumeSkipped, { to: 'debug' }) // a /clear came meanwhile
      return
    }
    if (personHeld > 0) {
      handedOver = { record: r, at: now } // a prompt arrived during the clear: its takeover gives the note (4.6.3)
      return
    }
    $.ui.log(notice.resetResumes(ended.reset, ended.open))
    submitResume($, ended) // synchronous with the checks above
  } finally {
    release = undefined
  }
}

/**
 * B34: another kind gates at the due time. The stop now names it and lasts until its hold end. It runs
 * inside the ticker's release (4.6.3): a person path that takes the stop over meanwhile sets cancelled,
 * clears the value and logs, and then the extension never stands.
 */
async function extendStop($: EngineInterface, rel: Release, gatingNow: readonly KindSense[], s: Sensed): Promise<void> {
  const r = rel.record
  if ((await $.env.get('SPARE10_STOPPED')) !== rel.raw || rel.cancelled) return
  const kinds = gatingNow.map((k) => k.kind)
  const until = Math.max(...gatingNow.map((k) => k.holdEnd))
  const skip = skipTag(
    until,
    gatingNow.map((k) => k.skipAt).filter((t): t is number => t !== null),
    gatingNow.map((k) => k.holdEnd + dueMargin(k)),
    true,
  )
  // The test tag keeps the short margin only while every kind that gates now is a test reading.
  const { skip: _old, ...kept } = r
  const longer: StoppedRecord = {
    ...kept,
    kinds,
    windowEnd: until,
    test: r.test === true && gatingNow.every((k) => k.test),
    ...(skip ? { skip: true } : {}),
  }
  const value = formatStopped(longer)
  await $.env.set('SPARE10_STOPPED', value)
  if (rel.cancelled) {
    // A person path took it over during the write: its clear came first, so clear this write too.
    if ((await $.env.get('SPARE10_STOPPED')) === value) await clearStopped($)
    return
  }
  addEdge(until)
  addEdge(stopDue(longer))
  const ended = endedFor(namedStop(r), s, gatingNow, r.skip === true)
  const facts = factsFrom(gatingNow, s.now, skip)
  $.ui.log(notice.stopExtended(ended.reset, facts, untilPhrase(untilFor(facts, until, kinds, skip, s.now)), ended.open))
  redraw($)
}

async function dropStop($: EngineInterface, raw: string): Promise<void> {
  if ((await $.env.get('SPARE10_STOPPED')) !== raw) return
  await clearStopped($)
  $.ui.log(debugLine.droppedStop, { to: 'debug' })
  redraw($)
}

/**
 * 4.6.2: new text in the prompt box delays the resume prompt one tick, up to 10 ticks per stop. The
 * count belongs to the stop value it waits for, so a stop that ended another way (a takeover, a
 * command, another copy) leaves no count for the next stop.
 */
async function typingNow($: EngineInterface, raw: string): Promise<boolean> {
  if (deferFor !== raw) {
    deferFor = raw
    resumeDefers = 0
  }
  const text = (await $.prompt.read()).text
  if (text.trim() === '' || text === lastRestored || resumeDefers >= BOX_DEFER_LIMIT) return false
  resumeDefers += 1
  $.ui.log(debugLine.boxDefer(resumeDefers), { to: 'debug' })
  return true
}

/** 4.6.1: one attempt, never awaited in the tick. */
function submitResume($: EngineInterface, ended: Ended): void {
  try {
    void $.prompt.submit({ text: resumePrompt(ended.reset, ended.open) }).then(
      (out) => {
        if (out.drop !== undefined) resumeFailed($, out.drop) // another plugin's hook dropped it
      },
      (err: unknown) => resumeFailed($, err instanceof Error ? err.message : String(err)),
    )
  } catch (err) {
    resumeFailed($, err instanceof Error ? err.message : String(err))
  }
}

function resumeFailed($: EngineInterface, reason: string): void {
  $.ui.log(notice.resumeFailed(reason))
  redraw($)
}

/**
 * 4.6.3, B35: a person prompt or a command after the reset, or after the skip start, takes an overdue
 * stop over. `kinds`: a sense of now, so the notice can name what opened (skip 4.6).
 */
async function takeOverdueStop(
  $: EngineInterface,
  s: { cfg: Effective; now: number; attended: boolean; kinds?: readonly KindSense[] },
): Promise<Taken | undefined> {
  if (!(s.cfg.enabled && s.attended)) return undefined
  const at = s.kinds === undefined ? undefined : { kinds: s.kinds, now: s.now }
  const h = handedOver // the ticker cleared it while this prompt was in flight
  handedOver = undefined
  if (h !== undefined && s.now - h.at < CHECK_MS) return took($, h.record, at)
  const rel = release
  if (rel !== undefined) {
    // The ticker is releasing now: its checks read this, the last one synchronous with the submit.
    rel.cancelled = true
    if ((await $.env.get('SPARE10_STOPPED')) === rel.raw) await clearStopped($)
    return took($, rel.record, at)
  }
  if (taking) return undefined // another person path is taking it
  taking = true // synchronous: the ticker waits
  try {
    const raw = await $.env.get('SPARE10_STOPPED')
    const r = parseStopped(raw)
    const id = await $.session.id()
    if (!isOverdue(r, id, endedSid, s.now)) return undefined // an auto 0.2 record of this session, now >= until
    await clearStopped($)
    return took($, r, at)
  } finally {
    taking = false
  }
}

function took($: EngineInterface, record: StoppedRecord, s: { kinds: readonly KindSense[]; now: number } | undefined): Taken {
  const t: Taken = { record, ...endedFor(namedStop(record), s, [], record.skip === true) }
  $.ui.log(notice.stopTakenOver(t.reset, t.open))
  redraw($)
  return t
}

// ---- Badge (3.4, 7) ----

function redraw($: EngineInterface): void {
  if (base.badge) $.ui.invalidate('ui.render')
}

function syncPulse($: EngineInterface, wanted: boolean): void {
  if (wanted && pulse === undefined) {
    pulse = $.clock.every(PULSE_MS, () => {
      blink = !blink
      redraw($)
    })
  } else if (!wanted && pulse !== undefined) {
    pulse.cancel()
    pulse = undefined
    blink = true
  }
}

/** The phase and its inputs, with the same reads as the gate (3.1, 3.5). */
async function seen($: EngineInterface): Promise<Seen> {
  const cfg = await settings($)
  const now = await $.clock.now()
  const bases = await currentBases($, now)
  const kinds = sensesOf(cfg, bases, await spansFor($, cfg, bases), now)
  const tripped = kinds.some((k) => k.tripped)
  const att = await isAttended($)
  const consent: Partial<Record<Kind, number>> = {}
  const gating: KindSense[] = []
  const openKinds: KindSense[] = []
  for (const k of kinds) {
    const until = await consentMs($, k.kind, att, k.test)
    if (consentCovers(until, now, k.windowEnd)) consent[k.kind] = until
    else if (k.tripped && k.open) openKinds.push(k)
    else if (k.tripped) gating.push(k)
  }
  const stop = cfg.enabled && att ? await stoppedNow($, now) : undefined
  if (!(cfg.enabled && att)) sid = await $.session.id().catch(() => sid) // count this conversation's keys (3.6)
  const prefix = `${sid ?? ''}:`
  const toldKeys = new Set<string>()
  for (const k of gating) {
    const t = told[k.kind]
    if (t.windowEnd === k.windowEnd) for (const key of t.keys) if (key.startsWith(prefix)) toldKeys.add(key)
  }
  const open = openQuestion()
  const question = open === undefined ? undefined : questions.get(open)
  const phase = phaseOf({
    enabled: cfg.enabled,
    basis: bases.five_hour.basis,
    tripped,
    consented: cfg.enabled && tripped && gating.length === 0 && openKinds.length === 0,
    open: cfg.enabled && tripped && gating.length === 0 && openKinds.length > 0,
    stopped: stop !== undefined,
    asking: question !== undefined && !question.silent,
    told: tripped && toldKeys.size > 0,
    attended: att,
  })
  return {
    cfg,
    now,
    bases: { five_hour: bases.five_hour.basis, seven_day: bases.seven_day.basis },
    kinds,
    tripped,
    attended: att,
    open: openKinds,
    gating,
    consent,
    ...(stop === undefined ? {} : { stop }),
    ...(question === undefined ? {} : { question }),
    toldCount: toldKeys.size,
    phase,
  }
}

/**
 * 2.6: the clock at which a stop or an open question continues by itself. A skip stop shows its end in
 * both autoResume modes. The open row: the earliest reset among the open kinds, the reserve lost first.
 */
function untilOf(p: Seen): { until?: string } {
  if (p.phase === 'open') {
    const first = [...p.open].sort((a, b) => resetOf(a) - resetOf(b))[0]
    return first === undefined ? {} : { until: clockText(resetOf(first), first.kind, undefined, p.now) }
  }
  const st = p.stop
  if (p.phase === 'stopped' && st?.kinds !== undefined && ((st.auto === true && p.cfg.autoResume) || st.skip === true)) {
    return { until: atText(st.windowEnd, st.kinds, undefined, p.now) }
  }
  if (!p.cfg.autoResume) return {}
  const q = p.question
  if (p.phase === 'asking' && q !== undefined) return { until: atText(q.holdEnd, q.kinds, undefined, p.now) }
  return {}
}

/** The reset of an open kind (an open kind always has one). */
const resetOf = (k: KindSense): number => (k.basis.kind === 'none' ? Number.POSITIVE_INFINITY : (k.basis.resetsAtMs ?? Number.POSITIVE_INFINITY))

async function badgeNow($: EngineInterface): Promise<View> {
  try {
    const p = await seen($)
    watchTicker($, p.now)
    return badgeView(p.phase, { reserve: p.cfg.reserve, test: p.kinds.some((k) => k.test), mode: modeOf(p.cfg), blink, ...untilOf(p) })
  } catch {
    // The label of the reserve in force (SPARE10_RESERVE included), when the settings are readable.
    const cfg = await settings($).catch(() => undefined)
    return badgeView('waiting', { reserve: cfg?.reserve ?? base.reserve, test: false, mode: 'hold', blink })
  }
}

// ---- Start-up checks (B16, B28, B29, B37) ----

async function sessionChecks($: EngineInterface, eff: Effective): Promise<string[]> {
  const out: string[] = []
  const inProcess = (await $.env.get('CLAUDE_CODE_ENABLE_FUNCTION_HOOKS')) !== undefined
  const sources = [
    await $.settings.read({ source: 'user' }).catch(() => ({})),
    await $.settings.read({ source: 'project' }).catch(() => ({})),
    await $.settings.read({ source: 'local' }).catch(() => ({})),
    await $.settings.read({ source: 'flag' }).catch(() => ({})), // --settings <file>
    await $.settings.read({ source: 'policy' }).catch(() => ({})),
  ]
  if (flagOnlyInShell(inProcess, sources)) out.push(W_FLAG)
  const merged = await $.settings.read().catch(() => ({}))
  const limit = questionTimeout(merged, await $.env.get('CLAUDE_AFK_TIMEOUT_MS'))
  if (limit !== undefined) out.push(timeoutWarning(limit, eff.autoResume))
  const child = childHeadless(eff.headless, (await $.env.get('SPARE10_HEADLESS')) !== undefined)
  if (child !== undefined) await $.env.set('SPARE10_HEADLESS', child) // B16, B37
  return out
}

/** B31: a --bg session gets SPARE10 switches from the daemon's env or a settings file, never from its dispatch (9.3). */
async function bgWarnings($: EngineInterface): Promise<string[]> {
  if (!(await isBg($))) return []
  const set: Array<[string, string]> = []
  const onOff = await $.env.get('SPARE10')
  if (onOff !== undefined) set.push(['SPARE10', onOff])
  const reserve = await $.env.get('SPARE10_RESERVE')
  if (reserve !== undefined) set.push(['SPARE10_RESERVE', reserve])
  const weeklyReserve = await $.env.get('SPARE10_WEEKLY_RESERVE')
  if (weeklyReserve !== undefined) set.push(['SPARE10_WEEKLY_RESERVE', weeklyReserve])
  const lastMinutes = await $.env.get('SPARE10_LAST_MINUTES')
  if (lastMinutes !== undefined) set.push(['SPARE10_LAST_MINUTES', lastMinutes])
  const weeklyLastHours = await $.env.get('SPARE10_WEEKLY_LAST_HOURS')
  if (weeklyLastHours !== undefined) set.push(['SPARE10_WEEKLY_LAST_HOURS', weeklyLastHours])
  const pausePrompt = await $.env.get('SPARE10_PAUSE_PROMPT')
  if (pausePrompt !== undefined) set.push(['SPARE10_PAUSE_PROMPT', pausePrompt])
  const autoResume = await $.env.get('SPARE10_AUTO_RESUME')
  if (autoResume !== undefined) set.push(['SPARE10_AUTO_RESUME', autoResume])
  return set.length === 0 ? [] : [bgEnvWarning(set)]
}

// ---- /spare10 (2.7, 2.8, 2.9) ----

const tripOf = (reserve: number): number => Math.round((100 - reserve) * 10) / 10

async function statusText($: EngineInterface): Promise<string> {
  const p = await seen($)
  const childPolicy = (await $.env.get('SPARE10_HEADLESS').catch(() => undefined)) ?? p.cfg.headless
  const warnings = [...p.cfg.warnings, ...startWarnings]
  for (const k of p.kinds) {
    // R13: a consent that lies beyond this window is ignored, and /spare10 says so (B30).
    const raw =
      k.kind === 'seven_day'
        ? await $.env.get('SPARE10_WEEKLY_CONSENT').catch(() => undefined)
        : await $.env.get('SPARE10_CONSENT').catch(() => undefined)
    const c = parseConsent(raw)
    if (raw === undefined || c === undefined) continue
    const bound = k.basis.kind === 'none' ? p.now + windowMs(k.kind) + 60_000 : k.windowEnd + 60_000
    if (c.until > bound) warnings.push(consentWarning(raw, k.kind))
  }
  const five = p.bases.five_hour
  const week = p.bases.seven_day
  const q = p.question
  const st = p.stop
  const at =
    q !== undefined
      ? { ms: q.holdEnd, kinds: q.kinds, skip: q.skip }
      : st?.kinds !== undefined && (st.auto === true || st.skip === true)
        ? { ms: st.windowEnd, kinds: st.kinds, skip: st.skip === true }
        : undefined
  const weeklyConsent = p.consent.seven_day
  return statusReport({
    phase: p.phase,
    mode: modeOf(p.cfg),
    reserve: p.cfg.reserve,
    reserveFrom: p.cfg.from.reserve,
    pausePrompt: p.cfg.pausePrompt,
    attended: p.attended,
    headless: p.cfg.headless,
    headlessFrom: p.cfg.from.headless,
    childPolicy,
    enabled: p.cfg.enabled,
    enabledFrom: p.cfg.from.enabled,
    scope: p.cfg.scope,
    basis: five,
    ...(five.kind === 'none' ? {} : { facts: factsOf(five, p.cfg.reserve) }),
    now: p.now,
    ...(p.consent.five_hour === undefined ? {} : { consentUntil: p.consent.five_hour }),
    toldCount: p.toldCount,
    warnings,
    weekly: {
      reserve: p.cfg.weeklyReserve,
      from: p.cfg.from.weeklyReserve,
      basis: week,
      ...(weeklyConsent === undefined ? {} : { consentUntil: weeklyConsent }),
    },
    autoResume: { on: p.cfg.autoResume, from: p.cfg.from.autoResume },
    ...(at === undefined ? {} : { at }),
    ...(st === undefined ? {} : { work: st.work === true, autoStop: st.auto === true && p.cfg.autoResume, skipStop: st.skip === true }),
    tickerStale: tickerWanted && p.now - lastTick > STALE_TICK_MS,
    // This copy's spans: a command runs in the newest copy, so they are the spans in force (skip 2.7).
    spans: {
      lastMinutes: p.cfg.lastMinutes,
      lastMinutesFrom: p.cfg.from.lastMinutes,
      weeklyLastHours: p.cfg.weeklyLastHours,
      weeklyLastHoursFrom: p.cfg.from.weeklyLastHours,
    },
    // The open kinds, only while no kind gates: the asking line then says that new work goes on, and a
    // window that still gates would hold that new work.
    ...(p.open.length === 0 || p.gating.length > 0 ? {} : { open: factsFrom(p.open, p.now) }),
  })
}

async function resumeCommand($: EngineInterface): Promise<string> {
  const cfg = await settings($)
  if (!cfg.enabled || !(await isAttended($))) return resumeReply('off')
  const sNow = await sense($).catch(() => undefined) // skip 4.6: the takeover names what opened
  const now = sNow?.now ?? (await $.clock.now())
  const overdue = await takeOverdueStop($, { cfg, now, attended: true, ...(sNow === undefined ? {} : { kinds: sNow.kinds }) })
  if (overdue !== undefined) return resumeReply('overdue', undefined, overdue.reset, overdue.open)
  const open = openQuestion()
  if (open !== undefined) {
    const q = questions.get(open)
    await settle($, open, 'resume', 'command')
    return resumeReply('asking', q?.facts)
  }
  const s = sNow ?? (await sense($))
  const read = s.kinds.filter((k) => k.basis.kind !== 'none')
  if (read.length === 0) return resumeReply('none')
  if (!s.tripped) return resumeReply('below', factsFrom(read, s.now))
  const split = await splitOf($, s)
  const gating = split.gating
  if (gating.length === 0 && split.open.length > 0) return resumeReply('open', factsFrom(split.open, s.now)) // B44: nothing to resume
  if (gating.length === 0) return resumeReply('consented', factsFrom(s.kinds.filter((k) => k.tripped), s.now))
  const wasStopped = (await stoppedNow($, s.now)) !== undefined
  for (const k of gating) await writeConsent($, k.kind, k.windowEnd, s.now, k.test)
  await clearStopped($)
  redraw($)
  await $.spare10.poke({ from: ENV })
  return resumeReply(wasStopped ? 'stopped' : 'tripped', factsFrom(gating, s.now))
}

async function stopCommand($: EngineInterface): Promise<string> {
  const cfg = await settings($)
  if (!cfg.enabled || !(await isAttended($))) return stopReply('off')
  const sNow = await sense($).catch(() => undefined) // skip 4.6: the takeover names what opened
  const now = sNow?.now ?? (await $.clock.now())
  const overdue = await takeOverdueStop($, { cfg, now, attended: true, ...(sNow === undefined ? {} : { kinds: sNow.kinds }) })
  if (overdue !== undefined) {
    // No stop after a takeover (D0.2): a kind that gates asks at its next event, and an open kind needs none (B44).
    if (overdue.open.length > 0) return stopReply('overdue-open', overdue.open)
    if (overdue.record.skip === true && sNow === undefined) return stopReply('overdue-skip')
    return stopReply('overdue')
  }
  const open = openQuestion()
  if (open !== undefined) {
    const q = questions.get(open)
    const late = await settle($, open, 'stop', 'command') // sets stopped in tell mode too
    if (late.ended !== undefined) {
      // B46: the question's time had passed and a kind of it is open.
      return stopReply(late.record !== undefined ? 'asking-soon' : 'asking-open', undefined, undefined, undefined, undefined, late.ended)
    }
    const written = late.record
    if (written !== undefined) {
      // The reply follows the record as written (3.2): it promises to continue only work that the stop has.
      const cont = written.auto === true && written.work === true && written.kinds !== undefined
      return stopReply('asking', undefined, undefined, cont ? late.until : undefined)
    }
    const auto = await $.spare10.auto().catch(() => cfg.autoResume)
    const lead = q?.skip === true ? whenOf(q.facts).lead : undefined
    return stopReply(
      'asking',
      undefined,
      undefined,
      auto && q !== undefined && q.loops > 0 ? { at: atText(q.holdEnd, q.kinds, undefined, now), ...(lead === undefined ? {} : { lead }) } : undefined,
    )
  }
  const s = sNow ?? (await sense($))
  const trip = tripOf(cfg.reserve)
  const weeklyTrip = cfg.weeklyReserve > 0 ? tripOf(cfg.weeklyReserve) : undefined
  const read = s.kinds.filter((k) => k.basis.kind !== 'none')
  if (read.length === 0) return stopReply('none', undefined, trip, undefined, weeklyTrip)
  if (!s.tripped) return stopReply('below', factsFrom(read, s.now), trip, undefined, weeklyTrip)
  const trippedKinds = s.kinds.filter((k) => k.tripped)
  // The stop clears both consents, so every tripped kind that is not open gates after it: the stop
  // names them all, and the command never waits on a consent read (as 0.1). A stop never holds an open
  // kind (B44): with none left, it writes nothing and clears no consent.
  const ks = trippedKinds.filter((k) => !k.open)
  if (ks.length === 0) return stopReply('open', factsFrom(trippedKinds, s.now))
  const f = factsFrom(trippedKinds, s.now)
  const st = await stoppedNow($, s.now)
  if (st !== undefined) {
    const shows = st.kinds !== undefined && ((st.auto === true && cfg.autoResume) || st.skip === true)
    return stopReply('stopped', f, undefined, shows && st.kinds !== undefined ? { at: atText(st.windowEnd, st.kinds, undefined, s.now) } : undefined)
  }
  const auto = cfg.autoResume
  const kinds = ks.map((k) => k.kind)
  const until = auto ? Math.max(...ks.map((k) => k.holdEnd)) : Math.max(...ks.map((k) => k.stopEnd))
  const skip = skipTag(
    until,
    ks.map((k) => k.skipAt).filter((t): t is number => t !== null),
    ks.map((k) => k.holdEnd + dueMargin(k)),
    auto,
  )
  await clearConsent($)
  await writeStopped($, { kinds, windowEnd: until, work: false, auto, test: ks.every((k) => k.test), skip }, s.now)
  // A crossing during the writes saw no consent and no stop yet, so it opened a question that this
  // stop (stamped with the earlier now) cannot answer. Settle it as Stop here.
  const late = openQuestion()
  if (late !== undefined) await settle($, late, 'stop', 'command')
  redraw($)
  await $.spare10.poke({ from: ENV })
  // R4: tripped or consented, never armed. A skip stop shows its end in both modes (skip 1.3 item 6).
  const u = untilFor(factsFrom(ks, s.now, skip), until, kinds, skip, s.now)
  return stopReply('tripped', f, undefined, auto || skip ? { ...u, continues: auto } : undefined)
}

async function simulateCommand($: EngineInterface, words: readonly string[]): Promise<string> {
  const spec = parseSimulate(words)
  if (spec === undefined) return simulateReply('bad')
  if (spec === 'off') {
    test = {}
    testFromEnvDone = true
    await clearConsent($)
    await clearStopped($)
    redraw($)
    return simulateReply('off')
  }
  const cfg = await settings($)
  if (spec.kind === 'seven_day' && cfg.weeklyReserve <= 0) return simulateReply('weekly-off')
  const now = await $.clock.now()
  const live = limitOf((await $.session.usage().catch(() => undefined))?.rateLimits ?? [], spec.kind)
  const replaces = test[spec.kind] !== undefined
  const reading = testReading(spec.pct, spec.kind, live, now, spec.inMs)
  test[spec.kind] = reading
  testFromEnvDone = true
  if (replaces) {
    // A new test reading starts a new test: no answer given under the old one carries over (3.5).
    await clearConsent($)
    await clearStopped($)
  }
  redraw($)
  const reserve = reserveOf(cfg, spec.kind)
  const testBasis: Basis = { kind: 'test', ...reading }
  const span = spanOf(cfg, spec.kind) // this copy's spans: the newest copy's (a command runs there)
  const f: Facts = { ...factsOf(testBasis, reserve, undefined, spec.kind, now), test: true, ...(span > 0 ? { span } : {}) }
  return simulateReply('set', f, simulateOpens(testBasis, basis(live, mem[spec.kind], now, undefined, spec.kind), reserve, span, now, f))
}

/**
 * Skip 2.9: a forecast of when the test reading opens its reserve. Nothing for a span of 0 or a test
 * percentage below the trip point. 'real': the real reading is in the reserve too, and its own skip
 * start does not come first, so the test window does not open it (B45).
 */
function simulateOpens(
  t: Basis,
  real: Basis,
  reserve: number,
  span: number,
  now: number,
  f: Facts,
): { at: string; lead: string } | 'now' | 'real' | undefined {
  if (span <= 0 || !isTripped(t, reserve)) return undefined
  const start = skipStartOf(t, span)
  if (start === null) return undefined
  const realStart = skipStartOf(real, span)
  if (isTripped(real, reserve) && (realStart === null || realStart > Math.max(now, start))) return 'real'
  if (start <= now) return 'now'
  return { at: clockText(start, f.kind ?? 'five_hour', undefined, now), lead: leadText(f) ?? '' }
}

// ---- Registrations (10.9.6) ----

export const register: Register = (on, options) => {
  base = fromOptions(options)
  effective = undefined
  autoNow = base.autoResume
  spansNow = NO_SPANS // B47: 0 until this copy's first successful settings read

  // 1. The carrier a held dispatch parks on (4.4), and the setting in force (3.4). No .catch on engine.create.
  on('engine.create', async ($, e, next) => {
    const built = await next(e)
    return {
      ...built,
      spare10: {
        park: ({ waiter }: { waiter: string }) =>
          new Promise<string>((resolve) => {
            parked.get(waiter)?.('rearm') // free the previous carrier of this waiter
            parked.set(waiter, resolve)
          }),
        poke: ({ from }: { from: string }) => {
          wakeAll() // routes to the newest copy (gap-10 4.2)
          return Promise.resolve(from === ENV ? 'self' : 'other')
        },
        auto: () => Promise.resolve(autoNow), // noun calls route to the newest copy
        spans: () => Promise.resolve(spansNow), // B47: the spans in force, from the newest copy
      },
    }
  })

  // 2. The reset clock first, then attendance, settings, warnings, /spare10.
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    attended = e.isInteractive && e.surface !== null
    try {
      const eff = await settings($) // never rejects: it has a fallback
      tickerWanted = eff.enabled && (attended || eff.headless === 'wait')
      if (tickerWanted) {
        const now = await $.clock.now()
        startTicker($, now)
        startWatch($, now)
      }
      await rebuildEdges($) // consent ends and the stop's until and due, from the env
    } catch {
      // the watchdog re-arms it
    }
    try {
      sid = await $.session.id()
      const eff = await settings($)
      for (const w of eff.warnings) $.ui.log(w)
      await $.command
        .register({ name: 'spare10', description: COMMAND_DESCRIPTION, argumentHint: ARGUMENT_HINT, immediate: true })
        .catch(() => undefined)
      startWarnings = [
        ...(attended && eff.enabled ? await sessionChecks($, eff) : []),
        ...(await bgWarnings($).catch(() => [])),
      ]
      for (const w of startWarnings) $.ui.log(w)
    } catch {
      // never block the session
    }
    return r
  })

  // 2b. /clear and in-session /resume (3.6): no session.start follows, and the new id exists only after
  // this chain. Mark the ended id at once, then redraw now and twice more, so the badge re-derives with
  // the new id (D3). A finished -p run or an exit stops the ticker. Never throws, never waits.
  on('session.end', async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.reason === 'clear' || e.reason === 'resume') {
        endedSid = e.sessionId
        pastIds.add(e.sessionId)
        redraw($)
        for (const ms of [300, 1500]) {
          $.clock.after(ms, () => {
            redraw($)
            void restampConsent($).catch(() => undefined)
          })
        }
      } else if (e.reason === 'other' || e.reason === 'prompt_input_exit') {
        tickerWanted = false
        tickGen += 1
        ticker?.cancel()
        ticker = undefined
        watch?.cancel()
        watch = undefined
        pulse?.cancel()
        pulse = undefined
      }
    } catch {
      // cosmetic
    }
    return r
  })

  // 3. Blind count, seed writes, badge redraw, the ticker's watchdog (6.3, 6.4). It never settles or releases anything.
  on('session.measure', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      for (const kind of KINDS) mem[kind] = sawMeasure(mem[kind], e, kind, now)
      if (e.changed.includes('rateLimits')) {
        const five = limitOf(e.rateLimits, 'five_hour')
        const fiveSeed = five === undefined ? undefined : anchoredOf(five)
        if (fiveSeed !== undefined) await $.store.set('seed', fiveSeed).catch(() => undefined)
        const week = limitOf(e.rateLimits, 'seven_day')
        const weekSeed = week === undefined ? undefined : anchoredOf(week)
        if (weekSeed !== undefined) await $.store.set('seed-weekly', weekSeed).catch(() => undefined)
      }
      const cfg = await settings($)
      noteBasis(
        $,
        watchedKinds(cfg).map((kind) => {
          const live = limitOf(e.rateLimits, kind)
          const withTest = basis(live, mem[kind], now, test[kind], kind)
          const real = basis(live, mem[kind], now, undefined, kind)
          // This copy's spans: the badge only (skip 6.6).
          const v = viewOf(real, withTest, reserveOf(cfg, kind), spanOf(cfg, kind), now)
          return { kind, basis: v.basis, tripped: v.tripped, open: v.open }
        }),
      )
      watchTicker($, now)
    } catch {
      // the measure is for the badge, the seeds and the watchdog only
    }
    return next(e)
  })

  // 4. The gate for every loop's tool calls (4.3), in rounds (5.3).
  on('tool.call', async ($, e, next) => {
    if ((e.tool as string) === 'AskUserQuestion' || next.origin.plugin !== 'engine') return next(e) // 4.10
    let closed = false // after again: a failed sense refuses (B38)
    let resumed: readonly Kind[] = [] // one round only: a later round decides afresh on every kind
    let last: { s: Sensed; a: Acted } | undefined
    for (;;) {
      let s: Sensed
      try {
        s = await sense($)
      } catch {
        if (!closed || last === undefined) return next(e) // the sensor fails open
        return { deny: refusalText(last.s.attended ? 'stop' : 'headless', last.s, last.a) }
      }
      if (!s.tripped) return next(e)
      if (s.cfg.enabled && (s.attended || s.cfg.headless === 'wait')) HOLDING.add(e) // the actuator fails closed from here
      const a = await act($, s, { site: 'tool', agentId: e.agentId, resumed })
      const v = a.verdict
      if (v.kind === 'pass') return next(e)
      if (v.kind === 'refuse') {
        if (v.text === 'stop') markWork($)
        return { deny: refusalText(v.text, s, a) }
      }
      if (v.kind === 'tell') {
        const r = await next(e)
        if (r.deny !== undefined) return r // nothing rides a deny
        const key = `${sid ?? ''}:${e.agentId ?? 'main'}`
        if (!claimTold(namedKinds(s, a), key)) return r
        noteTold($, s, a, key)
        return { ...r, context: [...(r.context ?? []), tellText(s, a)] }
      }
      last = { s, a }
      const key = ensureQuestion($, 'loop', s, a)
      const out = await hold($, next.signal, key, () => next.budget.remainingMs)
      resumed = out === 'resume' ? (questions.get(key)?.kinds ?? []) : []
      if (out === 'resume') {
        closed = false
        continue
      }
      if (out === 'again') {
        closed = true
        continue
      }
      return { deny: refusalText(s.attended ? 'stop' : 'headless', s, a) }
    }
  }).catch(($, e, next) => {
    const a = afterFailure(next.called, HOLDING.has(e))
    if (a !== 'refuse') return next(e)
    return { deny: attended === false ? HEADLESS_GENERIC : STOP_GENERIC }
  })

  // 5. Withdraws this copy's dialog when its question is settled another way (4.3).
  on('tool.call', { tool: /^AskUserQuestion$/ }, async ($, e, next) => {
    if (next.origin.plugin !== NAME) return next(e)
    const key = takeRaising(questionOf(e)) // FIFO match on the question text
    if (key === undefined) return next(e)
    const done = outcomes.get(key)
    if (done !== undefined || !questions.has(key)) return { deny: withdrawnText(done) }
    const r = await Promise.race([next(e), outcomeOf(key).then((o) => ({ withdrawn: o }))])
    return 'withdrawn' in r ? { deny: withdrawnText(r.withdrawn) } : r
  })

  // 6. The gate for every loop's model requests (4.7), in rounds (5.3). No .catch: the body never throws after the decision.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) stepped.add(e.agentId)
    let closed = false // after again: a failed sense refuses (B38)
    let resumed: readonly Kind[] = [] // one round only
    let last: { s: Sensed; a: Acted } | undefined
    for (;;) {
      let r: { s: Sensed; a: Acted; out: Settled | 'aborted' }
      const s = await sense($).catch(() => undefined)
      if (s === undefined) {
        if (!closed || last === undefined) return yield* next(e) // the sensor fails open
        r = { ...last, out: 'stop' } // refuse with the text of the last round
      } else {
        if (!s.tripped) return yield* next(e)
        let a: Acted = { verdict: { kind: 'refuse', text: 'paused' }, stopped: false, gating: [] }
        let out: Settled | 'aborted' = 'stop'
        let key: string | undefined
        try {
          a = await act($, s, { site: 'step', agentId: e.agentId, resumed })
          if (a.verdict.kind === 'refuse' && a.verdict.text === 'paused') markWork($)
          if (a.verdict.kind === 'hold') {
            last = { s, a }
            key = ensureQuestion($, 'loop', s, a)
            out = await hold($, next.signal, key, () => next.budget.remainingMs)
          }
        } catch {
          out = 'stop' // a throwing step would send the request
        }
        const v = a.verdict
        if (v.kind === 'pass' || v.kind === 'tell') return yield* next(e)
        resumed = out === 'resume' && key !== undefined ? (questions.get(key)?.kinds ?? []) : []
        if (v.kind === 'hold' && out === 'resume') {
          closed = false
          continue
        }
        if (v.kind === 'hold' && out === 'again') {
          closed = true
          continue
        }
        r = { s, a, out }
      }
      // Refused, or held and not resumed: PAUSED attended, HEADLESS unattended (wait included).
      const text = refusalText(r.s.attended ? 'paused' : 'headless', r.s, r.a)
      yield { kind: 'text', index: 0, text }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      if (e.agentId === undefined && r.out !== 'aborted') endTurn($, e.turnId, r.s.attended)
      return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
    }
  })

  // 7. The person's prompts (4.7), in rounds (5.3).
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin?.kind // the kit sends a plugin prompt without an origin
    if (kind !== 'composer' && kind !== 'bridge') return next(e) // B11
    personHeld += 1 // before the first await (4.6.3)
    try {
      let wasStopped = false
      let personResume = false
      let closed = false
      let resumed: readonly Kind[] = [] // one round only
      let last: { s: Sensed; a: Acted } | undefined
      for (;;) {
        let s: Sensed
        try {
          s = await sense($)
        } catch {
          if (!closed || last === undefined) return next(e)
          if (kind === 'composer') restoreDraft($, e.text)
          return { drop: notStarted(factsFrom(namedKinds(last.s, last.a), last.s.now)) }
        }
        if (s.tripped && s.attended && s.cfg.enabled) HOLDING.add(e) // the actuator fails closed from here (0.1 order)
        const a = s.tripped ? await act($, s, { site: 'prompt', person: true, resumed }) : undefined
        wasStopped ||= a?.stopped === true
        if (a === undefined || a.verdict.kind !== 'hold') {
          const note =
            personResume && wasStopped && last !== undefined
              ? resumeContext(factsFrom(namedKinds(last.s, last.a), last.s.now)) // B9: a person's Resume cleared the stop
              : await takeOverdueStop($, s).then(
                  (t) => (t?.record.work === true ? resetContext(t.reset, t.open) : undefined),
                  () => undefined,
                )
          return note === undefined ? next(e) : next({ ...e, context: [...(e.context ?? []), note] })
        }
        last = { s, a }
        const key = ensureQuestion($, 'prompt', s, a)
        const out = await hold($, next.signal, key, () => next.budget.remainingMs)
        resumed = out === 'resume' ? (questions.get(key)?.kinds ?? []) : []
        if (out === 'resume') {
          personResume = true
          closed = false
          continue
        }
        if (out === 'again') {
          closed = true
          continue
        }
        if (out !== 'aborted' && kind === 'composer') restoreDraft($, e.text) // the last statement before return
        return { drop: notStarted(factsFrom(namedKinds(s, a), s.now)) }
      }
    } finally {
      personHeld -= 1
    }
  }).catch(($, e, next) => {
    const a = afterFailure(next.called, HOLDING.has(e))
    return a === 'refuse' ? { drop: NOT_STARTED_GENERIC } : next(e)
  })

  // 8. /spare10, /spare10 resume, /spare10 stop, /spare10 simulate (2.8, 2.9).
  on('command.run', { command: 'spare10' }, async ($, e) => {
    try {
      const words = e.args.trim().split(/\s+/).filter((w) => w !== '')
      const verb = words[0] ?? ''
      const word = verb.toLowerCase()
      if (word === '' || word === 'status') return { text: await statusText($) }
      if (word !== 'resume' && word !== 'stop' && word !== 'simulate') return { text: unknownVerb(verb) }
      if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return { text: notPerson(word) }
      if (word === 'resume') return { text: await resumeCommand($) }
      if (word === 'stop') return { text: await stopCommand($) }
      return { text: await simulateCommand($, words.slice(1)) }
    } catch (err) {
      return { text: commandFailed(err instanceof Error ? err.message : String(err)) }
    }
  })

  // 9. The footer badge (7.1), only with the badge option on.
  if (base.badge) {
    on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
      const engine = await next(e) // the engine's labels and any plugin beneath
      const v = await badgeNow($)
      syncPulse($, v.pulse)
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="row">
          {engine}
          <Box key="spare10">
            <Text {...(v.color === undefined ? {} : { color: v.color })}>{` ${v.text}`}</Text>
          </Box>
        </Box>
      )
    })
  }
}
