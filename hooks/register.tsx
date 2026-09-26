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
  buried,
  bury,
  consentCounts,
  consentCovers,
  formatConsent,
  formatStopped,
  fullCovers,
  heldPast,
  isOverdue,
  joinableAt,
  noteSlot,
  parseConsent,
  parseStopped,
  shouldAbortTurn,
  slotList,
  stopAction,
  stopDue,
  unbury,
  withoutFloor,
} from './core/decide.ts'
import type { Answered, Consent, ConsentSlots, Holder, Outcome, Site, StoppedRecord, Tomb } from './core/decide.ts'
import {
  KINDS,
  anchoredOf,
  asAnchored,
  basis,
  initialMemory,
  isTripped,
  limitOf,
  newer,
  parseSimulate,
  sawLive,
  sawMeasure,
  viewOf,
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
  bgEnvWarning,
  commandFailed,
  debugLine,
  notPerson,
  notice,
  questionText,
  resetContext,
  resumeContext,
  resumePrompt,
  resumeReply,
  simulateReply,
  statusReport,
  stopReply,
  timeoutWarning,
  unknownVerb,
  withdrawnText,
} from './core/text.ts'
import type { Ended } from './core/text.ts'
import { badgeView } from './core/badge.ts'
import type { View } from './core/badge.ts'
import {
  againNotice,
  answeredOf,
  answersKind,
  checksStop,
  claimTold,
  commandHolders,
  consentBeyond,
  consentOfEnd,
  dueRelease,
  dueStep,
  dueWait,
  emptySplit,
  endedFor,
  extendNotice,
  extended,
  factsFrom,
  floorEndsOf,
  gatesAfter,
  handoverTakes,
  holdersFrom,
  modeOf,
  namedKinds,
  namedOf,
  namedStop,
  needsRealList,
  noFloor,
  notStartedFor,
  questionEdges,
  questionOf,
  raiseAtFloor,
  raisesInPlace,
  refusalText,
  resetTooRecent,
  resumeCase,
  resumeNotice,
  resumeReadReply,
  seenOf,
  seenSplit,
  sensedNote,
  sensesOf,
  simulateText,
  splitKind,
  statusInput,
  stopAskingIdle,
  stopAskingReply,
  stopCase,
  stopInForce,
  stopKept,
  stopKeptReply,
  stopNewer,
  stopNotice,
  stopOpenNotice,
  stopOverdueReply,
  stopPlan,
  stopRecordOf,
  stopTrippedReply,
  stopWriteOf,
  takenOf,
  takeoverSense,
  tellText,
  testReading,
  tickPlan,
  toldMainOf,
  toldNotice,
  unansweredGating,
  unansweredHolders,
  unattendedLines,
  untilOf,
  verdictOf,
  viewedOf,
  withRealEntries,
} from './core/flow.ts'
import type {
  Acted,
  Bases,
  KindSense,
  Late,
  QuestionCore,
  Seen,
  Sensed,
  Sourced,
  Split,
  StopSense,
  StopWrite,
  Taken,
  Told,
  Via,
} from './core/flow.ts'

// The only file that uses $ (design 10.9.6). Sense fails open, act fails closed (4.2). Every held
// dispatch parks on the re-armed $.spare10.park carrier (4.4). The first waiter raises the one question
// in its own dispatch, and a lost raiser hands it on (4.5). Decisions cross module copies in the env.
// 0.2: one basis, consent and told set per kind. A ticker that session.start arms continues held and
// stopped work at the reset (4 of the 0.2 design). The gates decide in rounds (5.3).
// Skip near the reset: a tripped kind in the last span before its reset is open. It never gates, and no
// stop holds it (B41, B44). While its skip start is ahead, that start is its hold end, with no margin (B42).
// The resume floor (floor B48 to B55): a Resume at the reserve consents only until the floor point. A
// consent to the floor applies while the reading is below its end point, and a gate path ends it for
// good when its own basis reaches that point (B52). Then the kind gates again: the second question.

type Ctx = { site: Site; agentId?: string; person?: boolean; resumed?: readonly Answered[] } // resumed: what the Resume that ended the last round answered (B50)
type Settled = Outcome | 'again' // again: ended without an answer (4.5)
type Raiser = { signal: AbortSignal }
type Question = QuestionCore & {
  budgetLogAt: number // the last B40 debug line
  checking: boolean // one waiter runs the check at a time
  waiting: number
  raiser?: Raiser
}
type Release = { raw: string; record: StoppedRecord; cancelled: boolean }
type Wake = { p: Promise<'woke'>; fire: () => void }

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
let consentCache: Partial<Record<Kind, ConsentSlots>> = {}
let testConsent: Partial<Record<Kind, ConsentSlots>> = {} // a Resume on a test reading: never in the env, cleared with the test reading
const tombs: Partial<Record<Kind, Tomb[]>> = {} // B52: the real consents to the floor that a gate of this copy ended
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
const told: Told = noKinds(() => ({ windowEnd: 0, keys: new Set<string>() }))
const toldNoticeFor: Record<Kind, string> = noKinds(() => '') // `${windowEnd}:${stage}` of the last B12 notice (B51)
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
  const resumeFloor = await $.env.get('SPARE10_RESUME_FLOOR')
  const weeklyResumeFloor = await $.env.get('SPARE10_WEEKLY_RESUME_FLOOR')
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
    ...(resumeFloor !== undefined && { resumeFloor }),
    ...(weeklyResumeFloor !== undefined && { weeklyResumeFloor }),
    ...(pausePrompt !== undefined && { pausePrompt }),
    ...(autoResume !== undefined && { autoResume }),
    ...(headless !== undefined && { headless }),
    ...(onOff !== undefined && { onOff }),
    ...(simulate !== undefined && { simulate }),
  }
}

// ---- Attendance (9.1) ----

async function isAttended($: EngineInterface): Promise<boolean> {
  if (attended !== undefined) return attended
  attended = (await $.session.surfaces()).includes('terminal')
  return attended
}

// ---- Reading (6, 3.1 of 0.2) ----

/** A test reading of a kind (flow.ts testReading). Its end is a time at which the badge can change. */
function testReadingAt(pct: number, kind: Kind, live: SessionRateLimit | undefined, now: number, inMs?: number): Anchored {
  const reading = testReading(pct, kind, live, now, inMs)
  addEdge(reading.resetsAtMs)
  return reading
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
      test[kind] = testReadingAt(cfg.testPct, kind, limitOf(limits, kind), now, cfg.testInMs)
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

/** Every watched kind at now (flow.ts sensesOf). The skip starts of tripped kinds are badge edges (skip 4.1). */
function sensesNow(cfg: Effective, bases: Bases, spans: Spans, now: number): KindSense[] {
  const r = sensesOf(cfg, bases, spans, now, fallbackEnd, mem)
  for (const t of r.edges) addEdge(t) // the ticker redraws at the skip start
  return r.kinds
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

/**
 * The consents of a kind (floor 4.2): this copy's slots, the test slots on a test basis, and an env value
 * that belongs to this process (3.5, 9.3) with its raw text. A clear during the read gives the slots only.
 * An env value that a tomb of this copy buries is no consent, and it goes by compare-and-set (B52).
 */
async function consentsOf($: EngineInterface, kind: Kind, attendedNow: boolean, testBasis: boolean): Promise<Sourced[]> {
  const epoch = consentEpoch
  // Two branches, so each $.env.get keeps a literal name.
  const raw = kind === 'seven_day' ? await $.env.get('SPARE10_WEEKLY_CONSENT') : await $.env.get('SPARE10_CONSENT')
  const read = parseConsent(raw)
  const dead = read !== undefined && buried(tombs[kind], read)
  if (dead) void unsetIfSame($, kind, raw).catch(() => undefined)
  const c = dead ? undefined : read
  const counts =
    c !== undefined &&
    consentCounts(c.sessionId, {
      attended: attendedNow,
      bg: attendedNow && c.sessionId === undefined ? await isBg($) : false,
      ids: attendedNow && c.sessionId !== undefined ? [...pastIds, await $.session.id()] : [],
    })
  if (epoch !== consentEpoch) return slotsOf(kind, false) // a clear ran meanwhile: this read is stale
  const env: Sourced[] = counts ? [{ c: { until: c.until, ...(c.to === undefined ? {} : { to: c.to }) }, from: 'env', ...(raw === undefined ? {} : { raw }) }] : []
  return [...slotsOf(kind, testBasis), ...env]
}

/** This copy's consents of a kind as they are now: the slots, and the test slots on a test basis. */
const slotsOf = (kind: Kind, testBasis: boolean): Sourced[] => [
  ...slotList(consentCache[kind]).map((x): Sourced => ({ c: x, from: 'slot' })),
  ...(testBasis ? slotList(testConsent[kind]).map((x): Sourced => ({ c: x, from: 'test' })) : []),
]

/** A Resume of this copy. A new real consent to the floor lifts the tombs that bury it (B52). */
function noteConsent(kind: Kind, c: Consent, isTest: boolean): void {
  if (isTest) {
    testConsent[kind] = noteSlot(testConsent[kind], c)
    return
  }
  consentCache[kind] = noteSlot(consentCache[kind], c)
  if (c.to !== undefined) tombs[kind] = unbury(tombs[kind], c)
}

/**
 * A Resume's consent of one kind. A consent to the floor never replaces a full value of this process
 * for the same window in the env (floor 3.3): the stronger tier stays. `noted`: the caller noted the
 * consent in this copy's slots when it decided (settle), so a split that ended it since stays ended.
 */
async function writeConsent($: EngineInterface, kind: Kind, c: Consent, now: number, isTest: boolean, noted = false): Promise<void> {
  if (c.until <= now) return // never for a window that has ended (R10)
  if (!noted) noteConsent(kind, c, isTest)
  addEdge(c.until)
  if (isTest) return // a Resume on a test reading never carries into real use (3.5)
  sid = await $.session.id() // stamped: only this process honours it in an attended session (9.3)
  if (buried(tombs[kind], c)) return // B52: a split ended it since the Resume
  const value = formatConsent(sid, c.until, c.to)
  if (kind === 'seven_day') {
    if (c.to !== undefined && fullCovers(parseConsent(await $.env.get('SPARE10_WEEKLY_CONSENT')), [...pastIds, sid], c.until, now)) return
    await $.env.set('SPARE10_WEEKLY_CONSENT', value)
  } else {
    if (c.to !== undefined && fullCovers(parseConsent(await $.env.get('SPARE10_CONSENT')), [...pastIds, sid], c.until, now)) return
    await $.env.set('SPARE10_CONSENT', value)
  }
  // B52: a split that ended this consent to the floor while it was written (the reading passed its point
  // meanwhile) removed its slot and buried it. The late write must not bring it back: unset it by
  // compare-and-set. A split that ends it after this check finds the value in its sweep.
  if (c.to !== undefined && (buried(tombs[kind], c) || !holdsConsent(consentCache[kind], c, now))) await unsetIfSame($, kind, value)
}

/** This copy's slots still hold a consent at least as strong as `c` for its window: `c` did not end. */
const holdsConsent = (slots: ConsentSlots | undefined, c: Consent, now: number): boolean =>
  slotList(slots).some((x) => consentCovers(x.until, now, c.until) && (x.to === undefined || x.to >= (c.to ?? 0)))

/**
 * B52: the consents to the floor of a tripped, not open kind whose own basis has reached their end point
 * end for good (flow.ts floorEndsOf). This copy's slots go at once (synchronously). A real consent also
 * gets a tomb at once, and a sweep unsets the env value that the tomb buries, fire and forget. `failed`:
 * the env read failed, so `list` has only the slots. Never throws.
 */
function endFloors($: EngineInterface, k: KindSense, list: readonly Sourced[], now: number, failed = false): void {
  const ends = floorEndsOf(k, list, now, failed)
  for (const e of ends.unset) {
    if (e.from === 'test') testConsent[k.kind] = withoutFloor(testConsent[k.kind]) // never in the env, so no tomb
    else if (e.from === 'slot') consentCache[k.kind] = withoutFloor(consentCache[k.kind])
  }
  for (const t of ends.tombs) tombs[k.kind] = bury(tombs[k.kind], t, now)
  if (ends.tombs.length > 0) void sweep($, k.kind).catch(() => undefined)
}

/** B52: unsets the env value of a kind that a tomb of this copy buries. It reads the value first. */
async function sweep($: EngineInterface, kind: Kind): Promise<void> {
  const raw = kind === 'seven_day' ? await $.env.get('SPARE10_WEEKLY_CONSENT') : await $.env.get('SPARE10_CONSENT')
  const c = parseConsent(raw)
  if (c !== undefined && buried(tombs[kind], c)) await unsetIfSame($, kind, raw)
}

/** B52: unsets a consent value only while it still holds the raw text that the split read. */
async function unsetIfSame($: EngineInterface, kind: Kind, raw: string | undefined): Promise<void> {
  if (raw === undefined) return
  // Two branches, so each $.env call keeps a literal name.
  if (kind === 'seven_day') {
    if ((await $.env.get('SPARE10_WEEKLY_CONSENT')) === raw) await $.env.set('SPARE10_WEEKLY_CONSENT', undefined)
  } else if ((await $.env.get('SPARE10_CONSENT')) === raw) await $.env.set('SPARE10_CONSENT', undefined)
}

async function clearConsent($: EngineInterface): Promise<void> {
  consentEpoch += 1
  consentCache = {}
  testConsent = {}
  await Promise.all([$.env.set('SPARE10_CONSENT', undefined), $.env.set('SPARE10_WEEKLY_CONSENT', undefined)])
}

/**
 * After /clear or /resume: a consent stamped with an ended id of this process takes the new id, with its
 * end point. Each write goes only over the raw value read first (floor 3.3): a consent that a gate ended
 * or a second Resume replaced meanwhile stays as it is now. A consent that a tomb buries is never
 * written again, and a gate that buries it during the write unsets the new value (B52).
 */
async function restampConsent($: EngineInterface): Promise<void> {
  const epoch = consentEpoch
  const fiveRaw = await $.env.get('SPARE10_CONSENT')
  const weekRaw = await $.env.get('SPARE10_WEEKLY_CONSENT')
  const five = parseConsent(fiveRaw)
  const week = parseConsent(weekRaw)
  const ended = (c: typeof five): c is { until: number; sessionId: string; to?: number } =>
    c?.sessionId !== undefined && pastIds.has(c.sessionId)
  if (!ended(five) && !ended(week)) return
  const id = await $.session.id()
  if (epoch !== consentEpoch) return // cleared meanwhile
  if (ended(five) && id !== five.sessionId && (await $.env.get('SPARE10_CONSENT')) === fiveRaw && !buried(tombs.five_hour, five)) {
    const value = formatConsent(id, five.until, five.to)
    await $.env.set('SPARE10_CONSENT', value)
    if (buried(tombs.five_hour, five)) await unsetIfSame($, 'five_hour', value)
  }
  if (ended(week) && id !== week.sessionId && (await $.env.get('SPARE10_WEEKLY_CONSENT')) === weekRaw && !buried(tombs.seven_day, week)) {
    const value = formatConsent(id, week.until, week.to)
    await $.env.set('SPARE10_WEEKLY_CONSENT', value)
    if (buried(tombs.seven_day, week)) await unsetIfSame($, 'seven_day', value)
  }
}

/**
 * The stop of this conversation that applies now, if any. `gating`: the kinds that gate now. `holders`:
 * the kinds whose real reading gates now. A stop past its until that one of them keeps applies too (TS1:
 * `holdsPast`), with the end it will have.
 */
async function stoppedNow(
  $: EngineInterface,
  now: number,
  gating: readonly KindSense[],
  holders: readonly Holder[],
): Promise<StoppedRecord | undefined> {
  sid = await $.session.id()
  const st = parseStopped(await $.env.get('SPARE10_STOPPED'))
  // A stop of the conversation that /clear or /resume ended no longer counts, also before the engine
  // answers the new id (D3).
  return stopInForce(st, sid, endedSid, now, gating, holders)
}

/**
 * 5.7: the 0.2 record, merged with an earlier stop of this session (3.2). Returns what it wrote, for the
 * texts. `real` (TS1): the kinds whose real reading gates at the stop, each with the reset of its real
 * reading now. Only those of `kinds` are kept.
 */
async function writeStopped($: EngineInterface, n: StopWrite, now: number): Promise<StoppedRecord> {
  sid = await $.session.id() // R3: a fresh id, a /clear may have run since the last read
  const prev = parseStopped(await $.env.get('SPARE10_STOPPED').catch(() => undefined))
  const r = stopRecordOf(prev, n, sid, now)
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
  const kinds = sensesNow(cfg, bases, await spansFor($, cfg, bases), now)
  noteBasis($, kinds)
  const tripped = kinds.some((k) => k.tripped)
  const att = tripped ? await isAttended($) : attended === true
  return { cfg, now, kinds: att ? kinds : kinds.map(noFloor), tripped, attended: att } // B55
}

/**
 * Skip 3.3: the tripped kinds, split into those with a consent that applies (B49), those that gate and
 * those that are open. An open kind whose only covering consent is a consent to the floor is open (floor
 * 1.3 item 7). B52: a consent to the floor of a kind that is not open ends for good when its own basis
 * reaches its end point, also when the env read fails. Never throws: an unreadable consent is not consent.
 */
async function splitOf($: EngineInterface, s: { kinds: readonly KindSense[]; now: number; attended: boolean }): Promise<Split> {
  const out = emptySplit()
  for (const k of s.kinds) {
    if (!k.tripped) continue
    const read = await consentsOf($, k.kind, s.attended, k.test).then(
      (list) => ({ list, failed: false }),
      () => ({ list: slotsOf(k.kind, k.test), failed: true }),
    )
    if (!k.open) endFloors($, k, read.list, s.now, read.failed) // B52: sync slots and tombs, void env
    splitKind(out, k, read.list, read.failed, s.now) // unreadable: not consented
  }
  return out
}

/** The watched kinds that gate: tripped, not consented and not open. Never throws. */
async function gatingOf($: EngineInterface, s: Sensed): Promise<KindSense[]> {
  return (await splitOf($, s)).gating
}

/**
 * TS1: the kinds whose real reading gates now. A kind whose view is its real reading gates as the view
 * says, so it is in `gating`. Beneath a test reading, the real reading gates when it is tripped, not open
 * and no real consent applies on the real reading (B49): one read of the real consent, never a Resume on
 * the test reading (3.5). A real reading without a reset time takes the one-hour bound. It only reads:
 * the next split ends a real consent to the floor (B52). Never throws: an unreadable consent is not consent.
 */
async function holdersOf(
  $: EngineInterface,
  s: { kinds: readonly KindSense[]; now: number; attended: boolean },
  gating: readonly KindSense[],
): Promise<Holder[]> {
  const lists: Partial<Record<Kind, Sourced[]>> = {}
  for (const k of s.kinds) {
    if (needsRealList(k)) lists[k.kind] = await consentsOf($, k.kind, s.attended, false).catch((): Sourced[] => [])
  }
  return holdersFrom(s.kinds, gating, (k) => lists[k.kind] ?? [], s.now)
}

async function act($: EngineInterface, s: Sensed, ctx: Ctx): Promise<Acted> {
  // The round after a Resume leaves out the kinds it answered: only a kind the dialog did not name asks
  // again (B38). B50: only on the Resume's basis and below its end point, so no step passes the floor.
  const resumed = ctx.resumed ?? []
  const gating = s.cfg.enabled ? unansweredGating(resumed, await gatingOf($, s)) : []
  // TS1: the kinds whose real reading gates. They keep a stop past its end, and a Stop here names them.
  const holders = s.cfg.enabled ? unansweredHolders(s, resumed, await holdersOf($, s, gating)) : []
  const stopped = checksStop(s, gating) ? (await stoppedNow($, s.now, gating, holders).catch(() => undefined)) !== undefined : false
  const toldMain = toldMainOf(told, gating, sid ?? '')
  let { verdict } = verdictOf({ s, site: ctx.site, person: ctx.person === true, gating, holders, stopped, toldMain })
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
  return { verdict, stopped, gating, holders }
}

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
    // B50 item 3: a consent answers a kind at a matching tier. A consent to the floor never answers a kind asked at the floor.
    const list = end === undefined ? [] : await consentsOf($, kind, !q.silent, end.test).catch((): Sourced[] => [])
    if (!answersKind(end, list, now)) {
      covered = false
      break
    }
  }
  if (covered) return 'resume'
  // R6: a stop from another copy settles a question in hold and tell mode alike.
  const st = parseStopped(await $.env.get('SPARE10_STOPPED').catch(() => undefined))
  if (!stopNewer(st, q, now)) return undefined
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
    if (dueWait(q, now)) return false
    q.nextCheck = now + CHECK_MS
    // The setting in force: a silent question never reads it.
    const step = dueStep(q, now, q.silent || (await $.spare10.auto().catch(() => q.auto)))
    if (step === 'note') {
      q.noted = true
      $.ui.log(notice.resetWaitingFor(namedOf(q))) // D0.2, byte for byte
      return false
    }
    if (step === 'noteSensed') {
      // B43: the note names what opened or reset, so it senses. A throw: the catch logs it, the next check tries again.
      const s = await sense($)
      const n = sensedNote(q, s, await gatingOf($, s), now)
      if ('noteAt' in n) {
        q.noteAt = n.noteAt // B45: nothing of the question opened yet. Wait for its hold end.
        addEdge(q.noteAt)
        return false
      }
      q.noted = true
      $.ui.log(n.text)
      return false
    }
    if (step === 'wait') return false
    const s = await sense($) // throws: nothing is released
    const gatingNow = await gatingOf($, s)
    const via = dueRelease(q, now, gatingNow, resetTooRecent(s, mem))
    if (via === undefined) return false
    if (outcomes.has(key)) return false // answered meanwhile
    settleAgain($, key, via, gatingNow, s)
    return true
  } catch (err) {
    $.ui.log(debugLine.checkFailed(String(err)), { to: 'debug' })
    return false
  } finally {
    q.checking = false
  }
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
  if (q !== undefined) $.ui.log(againNotice(q, via, gatingNow, s))
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

function ensureQuestion($: EngineInterface, opener: 'loop' | 'prompt', s: Sensed, a: Acted): string {
  const g = namedKinds(s, a)
  if (openKey !== undefined) {
    const open = questions.get(openKey)
    if (open !== undefined && joinableAt(outcomes.get(openKey), answeredOf(open), g.map(viewedOf))) {
      if (opener === 'loop') open.loops += 1
      return openKey // join (synchronous check: no race)
    }
    // A settled again, or a settled Resume that does not answer a kind that gates now (B50): a new question.
  }
  seq += 1
  const key = `${ENV}:${seq}`
  openKey = key
  const q: Question = { ...questionOf(opener, s, a, s.now), budgetLogAt: s.now, checking: false, waiting: 0 }
  questions.set(key, q)
  if (!q.silent) needsRaise.add(key) // the first waiter to loop raises it
  for (const t of questionEdges(q)) addEdge(t)
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

const askedText = (e: unknown): string =>
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
      if (end !== undefined) noteConsent(kind, consentOfEnd(end), end.test) // B49: each kind at its tier
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
        if (end !== undefined) await writeConsent($, kind, consentOfEnd(end), now, end.test, true) // each kind's own test flag, noted above
      }
      await clearStopped($)
      if (via !== 'command') $.ui.log(resumeNotice(q, now))
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
 * A Stop here (skip 3.5, B46). One sense gives the kinds whose real reading gates now (TS1: the `real`
 * tag). When the question's time has passed (its hold end with autoResume on, its skip start with it
 * off), it also gives the kinds that gate now (`late`) and the question's kinds that are open now
 * (`opened`). The kinds that gate are stopped as usual. When nothing gates, a kind of the question is
 * open, and no work waits for a resume prompt, nothing is written: such a stop would never apply. A
 * failed sense gives empty lists: the D0.2 write, with the real kinds of the question when it opened.
 */
async function settleStop($: EngineInterface, q: Question, via: Via, now: number): Promise<Late> {
  const auto = await $.spare10.auto().catch(() => autoNow) // the setting in force
  let sNow: StopSense | undefined
  try {
    const sensed = await sense($)
    const split = await splitOf($, sensed)
    sNow = { s: sensed, split, holders: await holdersOf($, sensed, split.gating) }
  } catch {
    sNow = undefined // fail closed: the question's real kinds (flow.ts stopPlan)
  }
  const plan = stopPlan(q, now, auto, sNow)
  if (plan.kind === 'open') {
    // B46 open: nothing is stopped. Held work is refused (the outcome is stop), new work passes.
    const text = stopOpenNotice(q, plan.ended, via)
    if (text !== undefined) $.ui.log(text)
    return { ended: plan.ended }
  }
  const written = await writeStopped($, plan.record, now)
  const n = stopNotice(q, plan, written, via, now, auto)
  if (n.text !== undefined) $.ui.log(n.text)
  return n.late
}

/** This copy's open question, if it is not settled yet. */
const openQuestion = (): string | undefined => (openKey !== undefined && !outcomes.has(openKey) ? openKey : undefined)

// ---- Tell mode (5) ----

function noteTold($: EngineInterface, s: Sensed, a: Acted, key: string): void {
  $.ui.log(debugLine.told(key), { to: 'debug' })
  const text = toldNotice(s, a, toldNoticeFor)
  if (text === undefined) return
  $.ui.log(text)
  redraw($)
}

function noteUnattended($: EngineInterface, s: Sensed): void {
  for (const line of unattendedLines(s, { reserve: unattendedNoteFor, open: openNoteFor })) $.ui.log(line, { to: 'debug' })
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
  for (const kind of KINDS) {
    for (const e of await consentsOf($, kind, attended === true, false).catch((): Sourced[] => [])) addEdge(e.c.until)
  }
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
    if (!dueWait(q, now)) return true
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
  const plan = tickPlan(gatingNow, resetTooRecent(s, mem))
  if (plan === 'skip') return // a test stop that ends near a real reset (4.8)
  const holders = plan === 'extend' ? await holdersOf($, s, gatingNow) : [] // TS1: the real tag of an extension
  if (release !== undefined || taking || personHeld > 0) return // checked again after the awaits
  const rel: Release = { raw, record: r, cancelled: false }
  release = rel
  try {
    // The extension is a release too: a person path that takes the stop over meanwhile cancels it.
    if (plan === 'extend') return await extendStop($, rel, gatingNow, holders, s)
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
async function extendStop(
  $: EngineInterface,
  rel: Release,
  gatingNow: readonly KindSense[],
  holders: readonly Holder[],
  s: Sensed,
): Promise<void> {
  const r = rel.record
  if ((await $.env.get('SPARE10_STOPPED')) !== rel.raw || rel.cancelled) return
  const longer = extended(r, gatingNow, holders, s.now)
  const until = longer.windowEnd
  const value = formatStopped(longer)
  await $.env.set('SPARE10_STOPPED', value)
  if (rel.cancelled) {
    // A person path took it over during the write: its clear came first, so clear this write too.
    if ((await $.env.get('SPARE10_STOPPED')) === value) await clearStopped($)
    return
  }
  addEdge(until)
  addEdge(stopDue(longer))
  $.ui.log(extendNotice(r, longer, gatingNow, s))
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
 * stop over. `kinds`: a sense of now, so the notice can name what opened (skip 4.6). `holders`: the
 * kinds whose real reading gates now. A stop that one of them keeps (TS1: `heldPast`) is never taken
 * over: it still holds, and the ticker extends an auto stop. Nothing then says that the stop is over,
 * also when the ticker cleared it on an older sense (`handedOver`) or is writing its release or
 * extension now (`release`). `quiet`: the caller writes a new stop at once (/spare10 stop while a kind
 * gates), so no notice says that the stop is over.
 */
async function takeOverdueStop(
  $: EngineInterface,
  s: { cfg: Effective; now: number; attended: boolean; kinds?: readonly KindSense[]; holders: readonly Holder[]; quiet?: boolean },
): Promise<Taken | undefined> {
  if (!(s.cfg.enabled && s.attended)) return undefined
  const at = s.kinds === undefined ? undefined : { kinds: s.kinds, now: s.now }
  const quiet = s.quiet === true
  const h = handedOver // the ticker cleared it while this prompt was in flight
  handedOver = undefined
  if (handoverTakes(h, s.now, s.holders)) return took($, h.record, at, quiet)
  const rel = release
  if (rel !== undefined) {
    if (heldPast(rel.record, s.holders)) return undefined // TS1: the ticker extends it, or its kind still holds it
    // The ticker is releasing now: its checks read this, the last one synchronous with the submit.
    rel.cancelled = true
    if ((await $.env.get('SPARE10_STOPPED')) === rel.raw) await clearStopped($)
    return took($, rel.record, at, quiet)
  }
  if (taking) return undefined // another person path is taking it
  taking = true // synchronous: the ticker waits
  try {
    const raw = await $.env.get('SPARE10_STOPPED')
    const r = parseStopped(raw)
    const id = await $.session.id()
    if (!isOverdue(r, id, endedSid, s.now, s.holders)) return undefined // an auto 0.2 record of this session, now >= until, not held (TS1)
    await clearStopped($)
    return took($, r, at, quiet)
  } finally {
    taking = false
  }
}

function took($: EngineInterface, record: StoppedRecord, s: { kinds: readonly KindSense[]; now: number } | undefined, quiet: boolean): Taken {
  const t: Taken = takenOf(record, s)
  if (!quiet) $.ui.log(notice.stopTakenOver(t.reset, t.open))
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
  const sensed = sensesNow(cfg, bases, await spansFor($, cfg, bases), now)
  const tripped = sensed.some((k) => k.tripped)
  const att = await isAttended($)
  const kinds = att ? sensed : sensed.map(noFloor) // B55
  const lists: Partial<Record<Kind, Consent[]>> = {}
  for (const k of kinds) lists[k.kind] = (await consentsOf($, k.kind, att, k.test)).map((e) => e.c)
  // As splitOf classifies (floor 4.2), but it only reads: it never ends a consent (B52).
  const split = seenSplit(kinds, (k) => lists[k.kind] ?? [], now)
  const holders = cfg.enabled && att ? await holdersOf($, { kinds, now, attended: att }, split.gating) : [] // TS1
  const stop = cfg.enabled && att ? await stoppedNow($, now, split.gating, holders) : undefined
  if (!(cfg.enabled && att)) sid = await $.session.id().catch(() => sid) // count this conversation's keys (3.6)
  const open = openQuestion()
  const question = open === undefined ? undefined : questions.get(open)
  return seenOf({ cfg, now, bases, kinds, tripped, attended: att, split, stop, question, told, sessionId: sid ?? '' })
}

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
  const resumeFloor = await $.env.get('SPARE10_RESUME_FLOOR')
  if (resumeFloor !== undefined) set.push(['SPARE10_RESUME_FLOOR', resumeFloor])
  const weeklyResumeFloor = await $.env.get('SPARE10_WEEKLY_RESUME_FLOOR')
  if (weeklyResumeFloor !== undefined) set.push(['SPARE10_WEEKLY_RESUME_FLOOR', weeklyResumeFloor])
  const pausePrompt = await $.env.get('SPARE10_PAUSE_PROMPT')
  if (pausePrompt !== undefined) set.push(['SPARE10_PAUSE_PROMPT', pausePrompt])
  const autoResume = await $.env.get('SPARE10_AUTO_RESUME')
  if (autoResume !== undefined) set.push(['SPARE10_AUTO_RESUME', autoResume])
  return set.length === 0 ? [] : [bgEnvWarning(set)]
}

// ---- /spare10 (2.7, 2.8, 2.9) ----

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
    const w = consentBeyond(k, raw, p.now)
    if (w !== undefined) warnings.push(w)
  }
  return statusReport(statusInput(p, { childPolicy, warnings, tickerStale: tickerWanted && p.now - lastTick > STALE_TICK_MS }))
}

async function resumeCommand($: EngineInterface): Promise<string> {
  const cfg = await settings($)
  if (!cfg.enabled || !(await isAttended($))) return resumeReply('off')
  const sNow = await sense($).catch(() => undefined) // skip 4.6: the takeover names what opened
  const now = sNow?.now ?? (await $.clock.now())
  const overdue = await takeOverdueStop($, { cfg, now, attended: true, ...takeoverSense(sNow) })
  if (overdue !== undefined) return resumeReply('overdue', undefined, overdue.reset, overdue.open)
  const open = openQuestion()
  if (open !== undefined) {
    const q = questions.get(open)
    if (q !== undefined && sNow !== undefined) raiseAtFloor(q, sNow)
    await settle($, open, 'resume', 'command')
    return resumeReply('asking', q?.facts, undefined, undefined, q?.mode)
  }
  const s = sNow ?? (await sense($))
  const mode = modeOf(cfg)
  const early = resumeReadReply(s)
  if (early !== undefined) return early
  const c = resumeCase(s, await splitOf($, s), mode)
  if ('reply' in c) return c.reply
  const wasStopped = (await stoppedNow($, s.now, c.gating, commandHolders(s.kinds))) !== undefined // TS1: also a stop that a kind of it still holds
  // The command follows the reading now (floor 1.3 item 2): before the floor to the floor, past it until the reset.
  for (const w of c.write) await writeConsent($, w.kind, w.c, s.now, w.test)
  await clearStopped($)
  redraw($)
  await $.spare10.poke({ from: ENV })
  return resumeReply(wasStopped ? 'stopped' : 'tripped', c.facts, undefined, undefined, mode)
}

/**
 * /spare10 stop over a stop in force that names each kind that gates now: the stop stays as it is, but it
 * gets the real entries of this moment (TS1), so that it holds past its end while such a kind gates in
 * this window. A real reading that reached the reserve after the stop, or a value from before the real
 * tag, otherwise has none. Only a stop that can hold past its end carries them (`formatStopped`).
 * Writes only over the value it read.
 */
async function addRealEntries($: EngineInterface, realNow: readonly Holder[], now: number): Promise<void> {
  if (realNow.length === 0) return
  const raw = await $.env.get('SPARE10_STOPPED')
  const next = withRealEntries(parseStopped(raw), realNow, now)
  if (raw === undefined || next === undefined) return
  const value = formatStopped(next)
  if (value === raw || (await $.env.get('SPARE10_STOPPED')) !== raw) return
  await $.env.set('SPARE10_STOPPED', value)
}

async function stopCommand($: EngineInterface): Promise<string> {
  const cfg = await settings($)
  if (!cfg.enabled || !(await isAttended($))) return stopReply('off')
  const sNow = await sense($).catch(() => undefined) // skip 4.6: the takeover names what opened
  const now = sNow?.now ?? (await $.clock.now())
  // The kinds that gate after the stop: tripped and not open (see stopCase). Unknown when the sense failed.
  const after = gatesAfter(sNow)
  const overdue = await takeOverdueStop($, { cfg, now, attended: true, ...takeoverSense(sNow), quiet: after })
  if (overdue !== undefined && !after) return stopOverdueReply(overdue) // no stop after a takeover when no kind gates (D0.2)
  // A kind still gates: the person's stop never ends with the takeover. A new stop follows, and it keeps
  // the work of the stop it took over, as a merge with that stop would (3.2).
  const carried = overdue?.record.work === true
  const open = openQuestion()
  if (open !== undefined) {
    const q = questions.get(open)
    const late = await settle($, open, 'stop', 'command') // sets stopped in tell mode too
    const reply = stopAskingReply(late)
    if (reply !== undefined) return reply
    const auto = await $.spare10.auto().catch(() => cfg.autoResume)
    return stopAskingIdle(q, auto, now)
  }
  const s = sNow ?? (await sense($))
  // The stop clears both consents, so every tripped kind that is not open gates after it: the stop
  // names them all, and the command never waits on a consent read (as 0.1). A stop never holds an open
  // kind (B44): with none left, it writes nothing and clears no consent.
  const c = stopCase(s, cfg)
  if ('reply' in c) return c.reply
  const st = await stoppedNow($, s.now, c.ks, commandHolders(s.kinds)) // TS1: also a stop that a kind of it still holds
  // A stop in force that names each kind that gates now stays. One that does not gets a merged stop.
  if (stopKept(st, c.ks)) {
    await addRealEntries($, c.real, s.now)
    return stopKeptReply(st, c.facts, cfg.autoResume, s.now)
  }
  await clearConsent($)
  const written = await writeStopped($, stopWriteOf(c.ks, cfg.autoResume, carried), s.now)
  // A crossing during the writes saw no consent and no stop yet, so it opened a question that this
  // stop (stamped with the earlier now) cannot answer. Settle it as Stop here.
  const late = openQuestion()
  if (late !== undefined) await settle($, late, 'stop', 'command')
  redraw($)
  await $.spare10.poke({ from: ENV })
  return stopTrippedReply(c.ks, c.facts, written, cfg.autoResume, s.now)
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
  const old = test[spec.kind]
  // B53: a strictly higher value without `in`, in the window of the test reading, raises it in place:
  // the test window, the consent and the stop stay. So a consent to the floor ends at its point.
  const inPlace = old !== undefined && raisesInPlace(old, spec, now)
  const replaces = old !== undefined && !inPlace
  const reading = inPlace ? { pct: spec.pct, resetsAtMs: old.resetsAtMs } : testReadingAt(spec.pct, spec.kind, live, now, spec.inMs)
  test[spec.kind] = reading
  testFromEnvDone = true
  if (replaces) {
    // A new test reading starts a new test: no answer given under the old one carries over (3.5).
    await clearConsent($)
    await clearStopped($)
  }
  redraw($)
  // This copy's spans: the newest copy's (a command runs there).
  return simulateText({ spec, reading, inPlace, cfg, spans: cfg, live, mem: mem[spec.kind], now })
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
    let resumed: readonly Answered[] = [] // one round only: a later round decides afresh on every kind
    let last: { s: Sensed; a: Acted } | undefined
    for (;;) {
      let s: Sensed
      try {
        s = await sense($)
      } catch {
        if (!closed || last === undefined) return next(e) // the sensor fails open
        return { deny: refusalText(last.s.attended ? 'stop' : 'headless', last.s, last.a, sid ?? '') }
      }
      if (!s.tripped) return next(e)
      if (s.cfg.enabled && (s.attended || s.cfg.headless === 'wait')) HOLDING.add(e) // the actuator fails closed from here
      const a = await act($, s, { site: 'tool', agentId: e.agentId, resumed })
      const v = a.verdict
      if (v.kind === 'pass') return next(e)
      if (v.kind === 'refuse') {
        if (v.text === 'stop') markWork($)
        return { deny: refusalText(v.text, s, a, sid ?? '') }
      }
      if (v.kind === 'tell') {
        const r = await next(e)
        if (r.deny !== undefined) return r // nothing rides a deny
        const key = `${sid ?? ''}:${e.agentId ?? 'main'}`
        if (!claimTold(told, namedKinds(s, a), key)) return r
        noteTold($, s, a, key)
        return { ...r, context: [...(r.context ?? []), tellText(s, a)] }
      }
      last = { s, a }
      const key = ensureQuestion($, 'loop', s, a)
      const out = await hold($, next.signal, key, () => next.budget.remainingMs)
      resumed = out === 'resume' ? answeredOf(questions.get(key)) : []
      if (out === 'resume') {
        closed = false
        continue
      }
      if (out === 'again') {
        closed = true
        continue
      }
      return { deny: refusalText(s.attended ? 'stop' : 'headless', s, a, sid ?? '') }
    }
  }).catch(($, e, next) => {
    const a = afterFailure(next.called, HOLDING.has(e))
    if (a !== 'refuse') return next(e)
    return { deny: attended === false ? HEADLESS_GENERIC : STOP_GENERIC }
  })

  // 5. Withdraws this copy's dialog when its question is settled another way (4.3).
  on('tool.call', { tool: /^AskUserQuestion$/ }, async ($, e, next) => {
    if (next.origin.plugin !== NAME) return next(e)
    const key = takeRaising(askedText(e)) // FIFO match on the question text
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
    let resumed: readonly Answered[] = [] // one round only
    let last: { s: Sensed; a: Acted } | undefined
    for (;;) {
      let r: { s: Sensed; a: Acted; out: Settled | 'aborted' }
      const s = await sense($).catch(() => undefined)
      if (s === undefined) {
        if (!closed || last === undefined) return yield* next(e) // the sensor fails open
        r = { ...last, out: 'stop' } // refuse with the text of the last round
      } else {
        if (!s.tripped) return yield* next(e)
        let a: Acted = { verdict: { kind: 'refuse', text: 'paused' }, stopped: false, gating: [], holders: [] }
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
        resumed = out === 'resume' && key !== undefined ? answeredOf(questions.get(key)) : []
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
      const text = refusalText(r.s.attended ? 'paused' : 'headless', r.s, r.a, sid ?? '')
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
      let resumed: readonly Answered[] = [] // one round only
      let last: { s: Sensed; a: Acted } | undefined
      let lastKey: string | undefined // B50 item 5: the question whose Resume the B9 note describes
      for (;;) {
        let s: Sensed
        try {
          s = await sense($)
        } catch {
          if (!closed || last === undefined) return next(e)
          if (kind === 'composer') restoreDraft($, e.text)
          return { drop: notStartedFor(last.s, last.a) }
        }
        if (s.tripped && s.attended && s.cfg.enabled) HOLDING.add(e) // the actuator fails closed from here (0.1 order)
        const a = s.tripped ? await act($, s, { site: 'prompt', person: true, resumed }) : undefined
        wasStopped ||= a?.stopped === true
        if (a === undefined || a.verdict.kind !== 'hold') {
          const note =
            personResume && wasStopped && last !== undefined
              ? resumeContext((lastKey === undefined ? undefined : questions.get(lastKey)?.facts) ?? factsFrom(namedKinds(last.s, last.a), last.s.now)) // B9: a person's Resume cleared the stop
              : await takeOverdueStop($, { ...s, holders: a?.holders ?? [] }).then(
                  (t) => (t?.record.work === true ? resetContext(t.reset, t.open) : undefined),
                  () => undefined,
                )
          return note === undefined ? next(e) : next({ ...e, context: [...(e.context ?? []), note] })
        }
        last = { s, a }
        const key = ensureQuestion($, 'prompt', s, a)
        lastKey = key
        const out = await hold($, next.signal, key, () => next.budget.remainingMs)
        resumed = out === 'resume' ? answeredOf(questions.get(key)) : []
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
        return { drop: notStartedFor(s, a) }
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
