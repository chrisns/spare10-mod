import type { EngineInterface, Register, Timer } from 'claude-code'
import { DEFAULTS, flagOnlyInShell, fromOptions, questionTimeout, withEnv } from './core/config.ts'
import type { Effective, EnvReads, Settings } from './core/config.ts'
import {
  afterFailure,
  askVerdict,
  consentCounts,
  consentCovers,
  decide,
  formatConsent,
  formatStopped,
  parseConsent,
  parseStopped,
  phaseOf,
  shouldAbortTurn,
} from './core/decide.ts'
import type { Mode, Outcome, Phase, Site, Verdict } from './core/decide.ts'
import {
  FALLBACK_MS,
  TEST_WINDOW_MS,
  WINDOW_MS,
  anchoredOf,
  asAnchored,
  basis,
  fiveHour,
  initialMemory,
  isTripped,
  newer,
  parseReset,
  parseTestPct,
  sawLive,
  sawMeasure,
} from './core/reading.ts'
import type { Anchored, Basis, Memory } from './core/reading.ts'
import {
  ARGUMENT_HINT,
  COMMAND_DESCRIPTION,
  HEADER,
  NOT_STARTED_GENERIC,
  QUESTION_OPTIONS,
  RESUME_LABEL,
  STOP_GENERIC,
  W_FLAG,
  bgEnvWarning,
  commandFailed,
  consentWarning,
  debugLine,
  factsOf,
  headlessText,
  notPerson,
  notStarted,
  notice,
  pauseInstruction,
  pausedText,
  questionText,
  resumeContext,
  resumeReply,
  simulateReply,
  statusReport,
  stopReply,
  stopText,
  timeoutWarning,
  unknownVerb,
  withdrawnText,
} from './core/text.ts'
import type { Facts } from './core/text.ts'
import { badgeView } from './core/badge.ts'
import type { View } from './core/badge.ts'

// The only file that uses $ (design 10.9.6). Sense fails open, act fails closed (4.2). Every held
// dispatch parks on the re-armed $.spare10.park carrier (4.4). The first waiter raises the one question
// in its own dispatch, and a lost raiser hands it on (4.5). Decisions cross module copies in the env.

type Ctx = { site: Site; agentId?: string; person?: boolean }
type Sensed = { cfg: Effective; now: number; basis: Basis; tripped: boolean; windowEnd: number; attended: boolean }
type Acted = { verdict: Verdict; stopped: boolean }
type Raiser = { signal: AbortSignal }
type Question = {
  windowEnd: number
  since: number
  mode: Mode
  opener: 'loop' | 'prompt'
  test: boolean // opened on a test reading: its Resume stays in this copy (3.5)
  facts: Facts
  waiting: number
  handoffs: number
  raiser?: Raiser
  noted: boolean
}
type Via = 'dialog' | 'command' | 'elsewhere' | 'could not ask' | 'dialog ended without an answer'
type Wake = { p: Promise<'woke'>; fire: () => void }
type Seen = Sensed & { consentUntil?: number; stopped: boolean; toldCount: number; phase: Phase }

const NAME = 'spare10'
const ENV = crypto.randomUUID() // this copy of the module
const HANDOFF_LIMIT = 5
const FAST_MS = 1000
const FAST_LIMIT = 3
const PULSE_MS = 1000

let base: Settings = DEFAULTS // register()
let effective: Promise<Effective> | undefined // register() resets it
let attended: boolean | undefined // session.start, else lazily
let sid: string | undefined // session.start, refreshed by stoppedNow, writeStopped, writeConsent, and act on a tell or headless verdict
let endedSid: string | undefined // the id the last /clear or /resume ended: its stop no longer counts (D3)
const pastIds = new Set<string>() // ids that /clear or /resume ended in this process: their consent is this process's
let bgKind: boolean | undefined // CLAUDE_CODE_SESSION_KIND=bg, read once
let mem: Memory = initialMemory()
let seedLoaded = false
let test: Anchored | undefined
let testFromEnvDone = false
let consentCache: number | undefined
let testConsent: number | undefined // a Resume on a test reading: never in the env, cleared with the test reading
let consentEpoch = 0
let fallbackEnd: number | undefined // R11: one fallback window end per episode
let startWarnings: string[] = []
let seq = 0
let openKey: string | undefined
const questions = new Map<string, Question>()
const outcomes = new Map<string, Outcome>()
const outcomeWaits = new Map<string, Array<(o: Outcome) => void>>()
const needsRaise = new Set<string>()
const raising: Array<{ text: string; key: string }> = [] // one entry per $.ui.ask in flight, until that ask ends
const parked = new Map<string, (why: string) => void>()
let wake = newWake()
const stepped = new Set<string>()
const refusedTurns: string[] = []
const HOLDING = new WeakSet<object>()
let told: { windowEnd: number; keys: Set<string> } = { windowEnd: 0, keys: new Set() }
let toldNoticeFor = 0 // window end of the last B12 notice
let unattendedNoteFor = 0 // window end of the last B15 debug line
let edgeTimer: Timer | undefined
let pulse: Timer | undefined
let blink = true
let viewKey = ''

// ---- Settings (8.2) ----

function settings($: EngineInterface): Promise<Effective> {
  effective ??= readEnv($).then(
    (env) => withEnv(base, env),
    () => {
      effective = undefined // a failed read is tried again at the next event
      return withEnv(base, {})
    },
  )
  return effective
}

async function readEnv($: EngineInterface): Promise<EnvReads> {
  const reserve = await $.env.get('SPARE10_RESERVE')
  const pausePrompt = await $.env.get('SPARE10_PAUSE_PROMPT')
  const headless = await $.env.get('SPARE10_HEADLESS')
  const onOff = await $.env.get('SPARE10')
  const simulate = await $.env.get('SPARE10_SIMULATE')
  return {
    ...(reserve !== undefined && { reserve }),
    ...(pausePrompt !== undefined && { pausePrompt }),
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

// ---- Reading (6) ----

async function currentBasis($: EngineInterface, now: number): Promise<Basis> {
  if (!seedLoaded) {
    seedLoaded = true
    const stored = asAnchored(await $.store.get('seed').catch(() => undefined))
    if (stored !== undefined) mem = { ...mem, seed: newer(mem.seed, stored) }
  }
  const live = fiveHour((await $.session.usage()).rateLimits)
  if (live !== undefined) mem = sawLive(mem, live)
  if (!testFromEnvDone) {
    testFromEnvDone = true
    const pct = (await settings($)).testPct
    if (pct !== undefined) test = { pct, resetsAtMs: (live === undefined ? null : parseReset(live.resetsAt)) ?? now + TEST_WINDOW_MS }
  }
  return basis(live, mem, now, test)
}

/** The window end that bounds consent and stopped. Without resetsAt, one fallback per episode (R11). */
function windowEndFor(b: Basis, now: number): number {
  if (b.kind !== 'none' && b.resetsAtMs !== null) {
    fallbackEnd = undefined
    return b.resetsAtMs
  }
  if (fallbackEnd === undefined || now >= fallbackEnd) fallbackEnd = now + FALLBACK_MS
  return fallbackEnd
}

function noteBasis($: EngineInterface, b: Basis, tripped: boolean): void {
  // The reset is in the key too: a new window at the same figure starts a new told set (5.1).
  const key = `${b.kind}:${b.kind === 'none' ? b.why : `${b.pct}:${b.resetsAtMs}`}:${tripped}`
  if (key === viewKey) return
  viewKey = key
  redraw($)
}

// ---- Consent and stopped (3.5, 3.2) ----

async function isBg($: EngineInterface): Promise<boolean> {
  bgKind ??= (await $.env.get('CLAUDE_CODE_SESSION_KIND')) === 'bg'
  return bgKind
}

/** The consent end in force: this copy's caches, and an env value that belongs to this process (3.5, 9.3). */
async function consentMs($: EngineInterface, attendedNow: boolean, testBasis: boolean): Promise<number> {
  const epoch = consentEpoch
  const c = parseConsent(await $.env.get('SPARE10_CONSENT'))
  const counts =
    c !== undefined &&
    consentCounts(c.sessionId, {
      attended: attendedNow,
      bg: attendedNow && c.sessionId === undefined ? await isBg($) : false,
      ids: attendedNow && c.sessionId !== undefined ? [...pastIds, await $.session.id()] : [],
    })
  if (epoch !== consentEpoch) return consentCache ?? 0 // a clear ran meanwhile: this read is stale
  return Math.max(consentCache ?? 0, testBasis ? (testConsent ?? 0) : 0, counts ? c.until : 0)
}

function noteConsent(until: number, test: boolean): void {
  if (test) testConsent = Math.max(testConsent ?? 0, until)
  else consentCache = Math.max(consentCache ?? 0, until)
}

async function writeConsent($: EngineInterface, until: number, now: number, test: boolean): Promise<void> {
  if (until <= now) return // never for a window that has ended (R10)
  noteConsent(until, test)
  if (test) return // a Resume on a test reading never carries into real use (3.5)
  sid = await $.session.id() // stamped: only this process honours it in an attended session (9.3)
  await $.env.set('SPARE10_CONSENT', formatConsent(sid, until))
}

async function clearConsent($: EngineInterface): Promise<void> {
  consentEpoch += 1
  consentCache = undefined
  testConsent = undefined
  await $.env.set('SPARE10_CONSENT', undefined)
}

/** After /clear or /resume: a consent stamped with an ended id of this process takes the new id. */
async function restampConsent($: EngineInterface): Promise<void> {
  const epoch = consentEpoch
  const c = parseConsent(await $.env.get('SPARE10_CONSENT'))
  if (c?.sessionId === undefined || !pastIds.has(c.sessionId)) return
  const id = await $.session.id()
  if (id === c.sessionId || epoch !== consentEpoch) return // not switched yet, or cleared meanwhile
  await $.env.set('SPARE10_CONSENT', formatConsent(id, c.until))
}

async function stoppedNow($: EngineInterface, now: number): Promise<boolean> {
  sid = await $.session.id()
  const st = parseStopped(await $.env.get('SPARE10_STOPPED'))
  // A stop of the conversation that /clear or /resume ended no longer counts, also before the engine
  // answers the new id (D3).
  return st !== undefined && st.sessionId === sid && st.sessionId !== endedSid && now < st.windowEnd
}

async function writeStopped($: EngineInterface, windowEnd: number, now: number): Promise<void> {
  sid = await $.session.id() // R3: a fresh id, a /clear may have run since the last read
  await $.env.set('SPARE10_STOPPED', formatStopped({ sessionId: sid, windowEnd, at: now }))
}

async function clearStopped($: EngineInterface): Promise<void> {
  await $.env.set('SPARE10_STOPPED', undefined)
}

async function listed($: EngineInterface, agentId: string): Promise<boolean> {
  return (await $.agent.list()).some((a) => a.id === agentId)
}

// ---- The decision (4.2) ----

async function sense($: EngineInterface): Promise<Sensed> {
  const cfg = await settings($)
  const now = await $.clock.now()
  const b = await currentBasis($, now)
  const tripped = isTripped(b, cfg.reserve)
  noteBasis($, b, tripped)
  const windowEnd = windowEndFor(b, now)
  return { cfg, now, basis: b, tripped, windowEnd, attended: tripped ? await isAttended($) : attended === true }
}

async function act($: EngineInterface, s: Sensed, ctx: Ctx): Promise<Acted> {
  const mode = modeOf(s.cfg)
  const consentEnd = await consentMs($, s.attended, s.basis.kind === 'test').catch(() => 0)
  const consented = s.cfg.enabled && consentCovers(consentEnd, s.now, s.windowEnd)
  const stopped = s.cfg.enabled && s.attended && !consented ? await stoppedNow($, s.now).catch(() => false) : false
  const mainTold = told.windowEnd === s.windowEnd && told.keys.has(`${sid ?? ''}:main`)
  let verdict = decide({
    site: ctx.site,
    tripped: s.tripped,
    enabled: s.cfg.enabled,
    consented,
    attended: s.attended,
    headless: s.cfg.headless,
    mode,
    person: ctx.person === true,
    stopped,
    mainTold,
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
  if (verdict.kind === 'tell' || (verdict.kind === 'refuse' && verdict.text === 'headless')) {
    sid = await $.session.id().catch(() => sid)
  }
  if (s.cfg.enabled && !s.attended) noteUnattended($, s) // B15 debug line, once per window (R2: enabled runs only)
  return { verdict, stopped }
}

const factsFrom = (s: Sensed): Facts => factsOf(s.basis, s.cfg.reserve)

function refusalText(kind: 'stop' | 'paused' | 'headless', s: Sensed): string {
  if (kind === 'stop') return stopText(factsFrom(s))
  if (kind === 'paused') return pausedText(factsFrom(s))
  return headlessText(factsFrom(s), sid ?? '')
}

const tellText = (s: Sensed): string => pauseInstruction(factsFrom(s), s.cfg.pausePrompt)

// ---- The hold (4.4) ----

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

function outcomeOf(key: string): Promise<Outcome> {
  const o = outcomes.get(key)
  if (o !== undefined) return Promise.resolve(o)
  return new Promise((resolve) => outcomeWaits.set(key, [...(outcomeWaits.get(key) ?? []), resolve]))
}

async function hold($: EngineInterface, signal: AbortSignal, key: string): Promise<Outcome | 'aborted'> {
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
      if (needsRaise.has(key)) {
        needsRaise.delete(key)
        raise($, key, { signal }) // this waiter raises the dialog (4.5)
      }
      const d = await decidedElsewhere($, key)
      if (d !== undefined) {
        void settle($, key, d, 'elsewhere')
        return d
      }
      // A hand-off or a close that came while this waiter read the env: act on it now, not after a carrier cycle.
      if (outcomes.has(key) || signal.aborted || needsRaise.has(key) || !questions.has(key)) continue
      const t0 = performance.now()
      const r = await Promise.race([
        $.spare10.park({ waiter }).then(
          () => 'woke' as const,
          () => 'rejected' as const,
        ),
        wake.p,
        aborted,
      ])
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
      if (q.waiting === 0 && needsRaise.has(key) && !outcomes.has(key)) forget($, key) // nobody left to raise it
    }
  }
}

async function decidedElsewhere($: EngineInterface, key: string): Promise<Outcome | undefined> {
  const q = questions.get(key)
  if (q === undefined) return undefined
  const now = await $.clock.now().catch(() => q.since)
  if (consentCovers(await consentMs($, true, q.test).catch(() => 0), now, q.windowEnd)) return 'resume'
  // R6: a stop from another copy settles a question in hold and tell mode alike.
  const st = parseStopped(await $.env.get('SPARE10_STOPPED').catch(() => undefined))
  if (st === undefined || st.at <= q.since || now >= st.windowEnd) return undefined
  const id = await $.session.id().catch(() => sid)
  return st.sessionId === id ? 'stop' : undefined
}

// ---- The question (4.3, 4.5, 4.6) ----

function ensureQuestion($: EngineInterface, opener: 'loop' | 'prompt', s: Sensed): string {
  if (openKey !== undefined) return openKey // join (synchronous check: no race)
  seq += 1
  const key = `${ENV}:${seq}`
  openKey = key
  questions.set(key, {
    windowEnd: s.windowEnd,
    since: s.now,
    mode: modeOf(s.cfg),
    opener,
    test: s.basis.kind === 'test',
    facts: factsFrom(s),
    waiting: 0,
    handoffs: 0,
    noted: false,
  })
  needsRaise.add(key) // the first waiter to loop raises it
  scheduleEdge($, s.windowEnd, s.now)
  redraw($)
  return key
}

function raise($: EngineInterface, key: string, r: Raiser): void {
  const q = questions.get(key)
  if (q === undefined || outcomes.has(key)) return // settled before this waiter got to it
  q.raiser = r
  const text = questionText(q.facts, q.opener, q.mode)
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

async function settle($: EngineInterface, key: string, outcome: Outcome, via: Via): Promise<void> {
  if (outcomes.has(key)) return
  // Every synchronous cache first, so an event that arrives during the writes sees the decision.
  outcomes.set(key, outcome)
  needsRaise.delete(key)
  const q = questions.get(key)
  for (const resolve of outcomeWaits.get(key) ?? []) resolve(outcome) // withdraws this copy's dialog
  outcomeWaits.delete(key)
  if (outcome === 'resume' && q !== undefined) noteConsent(q.windowEnd, q.test)
  wakeAll()
  try {
    if (via === 'elsewhere' || q === undefined) return
    const now = await $.clock.now()
    if (outcome === 'resume') {
      await writeConsent($, q.windowEnd, now, q.test)
      await clearStopped($)
      if (via !== 'command') $.ui.log(q.windowEnd > now ? notice.continuing(q.facts) : notice.newWindow)
    } else if (q.mode === 'hold' || via === 'command') {
      await writeStopped($, q.windowEnd, now)
      if (via !== 'command') $.ui.log(notice.stopped(q.facts))
    }
    if (openKey === key) openKey = undefined // the decision is readable in env now
    scheduleEdge($, q.windowEnd, now)
    await $.spare10.poke({ from: ENV }) // wake the newest copy's waiters (3.6)
  } catch {
    // best effort: this copy's caches and outcomes already hold the decision
  } finally {
    // Closed only now: a crossing during the writes joins the settled question and gets its outcome.
    if (openKey === key) openKey = undefined
    redraw($)
  }
}

/** This copy's open question, if it is not settled yet. */
const openQuestion = (): string | undefined => (openKey !== undefined && !outcomes.has(openKey) ? openKey : undefined)

// ---- Tell mode (5) ----

function claimTold(windowEnd: number, key: string): boolean {
  if (told.windowEnd !== windowEnd) told = { windowEnd, keys: new Set() }
  if (told.keys.has(key)) return false
  told.keys.add(key)
  return true
}

function noteTold($: EngineInterface, s: Sensed, key: string): void {
  $.ui.log(debugLine.told(key), { to: 'debug' })
  if (toldNoticeFor === s.windowEnd) return
  toldNoticeFor = s.windowEnd
  $.ui.log(notice.told(factsFrom(s)))
  redraw($)
}

function noteUnattended($: EngineInterface, s: Sensed): void {
  if (unattendedNoteFor === s.windowEnd) return
  unattendedNoteFor = s.windowEnd
  $.ui.log(debugLine.unattended(factsFrom(s), s.cfg.headless), { to: 'debug' }) // R9: every policy
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

// ---- Edge timer, badge (3.4, 7) ----

function scheduleEdge($: EngineInterface, at: number, now: number): void {
  try {
    edgeTimer?.cancel()
    edgeTimer = $.clock.after(Math.max(0, at - now), () => {
      edge($, at)
    })
  } catch {
    // cosmetic
  }
}

function edge($: EngineInterface, at: number): void {
  edgeTimer = undefined
  redraw($)
  const open = openQuestion()
  const q = open === undefined ? undefined : questions.get(open)
  if (q !== undefined && q.windowEnd <= at && !q.noted) {
    q.noted = true
    $.ui.log(notice.resetWaiting) // B6: the question still waits
  }
}

async function rearmEdge($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const consent = await consentMs($, attended === true, false).catch(() => 0)
  const st = parseStopped(await $.env.get('SPARE10_STOPPED').catch(() => undefined))
  const ends = [consent, st?.windowEnd ?? 0].filter((t) => t > now)
  if (ends.length > 0) scheduleEdge($, Math.min(...ends), now)
}

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

/** The phase and its inputs, with the same reads as the gate (3.1). */
async function seen($: EngineInterface): Promise<Seen> {
  const cfg = await settings($)
  const now = await $.clock.now()
  const b = await currentBasis($, now)
  const tripped = isTripped(b, cfg.reserve)
  const windowEnd = windowEndFor(b, now)
  const att = await isAttended($)
  const consent = await consentMs($, att, b.kind === 'test')
  const covers = consentCovers(consent, now, windowEnd)
  const stopped = cfg.enabled && att ? await stoppedNow($, now) : false
  if (!(cfg.enabled && att)) sid = await $.session.id().catch(() => sid) // count this conversation's keys (3.6)
  const prefix = `${sid ?? ''}:`
  const toldCount = told.windowEnd === windowEnd ? [...told.keys].filter((k) => k.startsWith(prefix)).length : 0
  const phase = phaseOf({
    enabled: cfg.enabled,
    basis: b,
    tripped,
    consented: cfg.enabled && covers,
    stopped,
    asking: openQuestion() !== undefined,
    told: tripped && toldCount > 0,
    attended: att,
  })
  return {
    cfg,
    now,
    basis: b,
    tripped,
    windowEnd,
    attended: att,
    ...(covers ? { consentUntil: consent } : {}),
    stopped,
    toldCount,
    phase,
  }
}

async function badgeNow($: EngineInterface): Promise<View> {
  try {
    const p = await seen($)
    return badgeView(p.phase, { reserve: p.cfg.reserve, test: p.basis.kind === 'test', mode: modeOf(p.cfg), blink })
  } catch {
    // The label of the reserve in force (SPARE10_RESERVE included), when the settings are readable.
    const cfg = await settings($).catch(() => undefined)
    return badgeView('waiting', { reserve: cfg?.reserve ?? base.reserve, test: false, mode: 'hold', blink })
  }
}

// ---- Start-up checks (B16, B28, B29) ----

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
  if (limit !== undefined) out.push(timeoutWarning(limit))
  if (eff.headless === 'off' && (await $.env.get('SPARE10_HEADLESS')) === undefined) await $.env.set('SPARE10_HEADLESS', 'stop') // B16
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
  const pausePrompt = await $.env.get('SPARE10_PAUSE_PROMPT')
  if (pausePrompt !== undefined) set.push(['SPARE10_PAUSE_PROMPT', pausePrompt])
  return set.length === 0 ? [] : [bgEnvWarning(set)]
}

// ---- /spare10 (2.8, 12.1) ----

const tripOf = (reserve: number): number => Math.round((100 - reserve) * 10) / 10

async function statusText($: EngineInterface): Promise<string> {
  const p = await seen($)
  const childPolicy = (await $.env.get('SPARE10_HEADLESS').catch(() => undefined)) ?? p.cfg.headless
  const warnings = [...p.cfg.warnings, ...startWarnings]
  const raw = await $.env.get('SPARE10_CONSENT').catch(() => undefined)
  const c = parseConsent(raw)
  if (raw !== undefined && c !== undefined) {
    // R13: a consent that lies beyond this window is ignored, and /spare10 says so (B30).
    const bound = p.basis.kind === 'none' ? p.now + WINDOW_MS : p.windowEnd + 60_000
    if (c.until > bound) warnings.push(consentWarning(raw))
  }
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
    basis: p.basis,
    ...(p.basis.kind === 'none' ? {} : { facts: factsOf(p.basis, p.cfg.reserve) }),
    now: p.now,
    ...(p.consentUntil === undefined ? {} : { consentUntil: p.consentUntil }),
    toldCount: p.toldCount,
    warnings,
  })
}

async function resumeCommand($: EngineInterface): Promise<string> {
  const cfg = await settings($)
  if (!cfg.enabled || !(await isAttended($))) return resumeReply('off')
  const open = openQuestion()
  if (open !== undefined) {
    const q = questions.get(open)
    await settle($, open, 'resume', 'command')
    return resumeReply('asking', q?.facts)
  }
  const now = await $.clock.now()
  const b = await currentBasis($, now)
  if (b.kind === 'none') return resumeReply('none')
  const f = factsOf(b, cfg.reserve)
  if (!isTripped(b, cfg.reserve)) return resumeReply('below', f)
  const windowEnd = windowEndFor(b, now)
  if (consentCovers(await consentMs($, true, b.kind === 'test'), now, windowEnd)) return resumeReply('consented', f)
  const wasStopped = await stoppedNow($, now)
  await writeConsent($, windowEnd, now, b.kind === 'test')
  await clearStopped($)
  scheduleEdge($, windowEnd, now)
  redraw($)
  await $.spare10.poke({ from: ENV })
  return resumeReply(wasStopped ? 'stopped' : 'tripped', f)
}

async function stopCommand($: EngineInterface): Promise<string> {
  const cfg = await settings($)
  if (!cfg.enabled || !(await isAttended($))) return stopReply('off')
  const open = openQuestion()
  if (open !== undefined) {
    await settle($, open, 'stop', 'command') // sets stopped in tell mode too
    return stopReply('asking')
  }
  const now = await $.clock.now()
  const b = await currentBasis($, now)
  const trip = tripOf(cfg.reserve)
  if (b.kind === 'none') return stopReply('none', undefined, trip)
  const f = factsOf(b, cfg.reserve)
  if (!isTripped(b, cfg.reserve)) return stopReply('below', f, trip)
  if (await stoppedNow($, now)) return stopReply('stopped', f)
  const windowEnd = windowEndFor(b, now)
  await clearConsent($)
  await writeStopped($, windowEnd, now)
  // A crossing during the writes saw no consent and no stop yet, so it opened a question that this
  // stop (stamped with the earlier now) cannot answer. Settle it as Stop here.
  const late = openQuestion()
  if (late !== undefined) await settle($, late, 'stop', 'command')
  scheduleEdge($, windowEnd, now)
  redraw($)
  await $.spare10.poke({ from: ENV })
  return stopReply('tripped', f) // R4: tripped or consented, never armed
}

async function simulateCommand($: EngineInterface, arg: string | undefined): Promise<string> {
  if (arg === undefined) return simulateReply('bad')
  if (arg.toLowerCase() === 'off') {
    test = undefined
    testFromEnvDone = true
    await clearConsent($)
    await clearStopped($)
    redraw($)
    return simulateReply('off')
  }
  const pct = parseTestPct(arg)
  if (pct === undefined) return simulateReply('bad')
  const cfg = await settings($)
  const now = await $.clock.now()
  const live = fiveHour((await $.session.usage().catch(() => undefined))?.rateLimits ?? [])
  const replaces = test !== undefined
  test = { pct, resetsAtMs: (live === undefined ? null : parseReset(live.resetsAt)) ?? now + TEST_WINDOW_MS }
  testFromEnvDone = true
  if (replaces) {
    // A new test reading starts a new test: no answer given under the old one carries over (3.5).
    await clearConsent($)
    await clearStopped($)
  }
  redraw($)
  return simulateReply('set', factsOf({ kind: 'test', ...test }, cfg.reserve))
}

// ---- Registrations (10.9.6) ----

export const register: Register = (on, options) => {
  base = fromOptions(options)
  effective = undefined

  // 1. The carrier a held dispatch parks on (4.4). No .catch on engine.create.
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
      },
    }
  })

  // 2. Attendance, settings, warnings, /spare10, the edge timer.
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      attended = e.isInteractive && e.surface !== null
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
      await rearmEdge($)
    } catch {
      // never block the session
    }
    return r
  })

  // 2b. /clear and in-session /resume (3.6): no session.start follows, and the new id exists only after
  // this chain. Mark the ended id at once, then redraw now and twice more, so the badge re-derives with
  // the new id (D3). Never throws, never waits: the whole end has one 1.5 s bound.
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
      }
    } catch {
      // cosmetic
    }
    return r
  })

  // 3. Blind count, seed write, badge redraw (6.3, 6.4). It never settles or releases anything.
  on('session.measure', async ($, e, next) => {
    try {
      mem = sawMeasure(mem, e)
      const live = fiveHour(e.rateLimits)
      const anchored = live === undefined ? undefined : anchoredOf(live)
      if (anchored !== undefined && e.changed.includes('rateLimits')) await $.store.set('seed', anchored).catch(() => undefined)
      const cfg = await settings($)
      const now = await $.clock.now()
      const b = basis(live, mem, now, test)
      noteBasis($, b, isTripped(b, cfg.reserve))
    } catch {
      // the measure is for the badge and the seed only
    }
    return next(e)
  })

  // 4. The gate for every loop's tool calls (4.3).
  on('tool.call', async ($, e, next) => {
    if ((e.tool as string) === 'AskUserQuestion' || next.origin.plugin !== 'engine') return next(e) // 4.10
    let s: Sensed
    try {
      s = await sense($)
    } catch {
      return next(e) // the sensor fails open
    }
    if (!s.tripped) return next(e)
    if (s.attended && s.cfg.enabled) HOLDING.add(e) // the actuator fails closed from here
    const { verdict: v } = await act($, s, { site: 'tool', agentId: e.agentId })
    if (v.kind === 'pass') return next(e)
    if (v.kind === 'refuse') return { deny: refusalText(v.text, s) }
    if (v.kind === 'tell') {
      const r = await next(e)
      if (r.deny !== undefined) return r // nothing rides a deny
      if (!claimTold(s.windowEnd, `${sid ?? ''}:${e.agentId ?? 'main'}`)) return r
      noteTold($, s, `${sid ?? ''}:${e.agentId ?? 'main'}`)
      return { ...r, context: [...(r.context ?? []), tellText(s)] }
    }
    const out = await hold($, next.signal, ensureQuestion($, 'loop', s))
    return out === 'resume' ? next(e) : { deny: refusalText('stop', s) }
  }).catch(($, e, next) => {
    const a = afterFailure(next.called, HOLDING.has(e))
    return a === 'refuse' ? { deny: STOP_GENERIC } : next(e)
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

  // 6. The gate for every loop's model requests (4.7). No .catch: the body never throws after the decision.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) stepped.add(e.agentId)
    let s: Sensed
    try {
      s = await sense($)
    } catch {
      return yield* next(e) // the sensor fails open
    }
    if (!s.tripped) return yield* next(e)
    let v: Verdict = { kind: 'refuse', text: 'paused' }
    let out: Outcome | 'aborted' = 'stop'
    try {
      v = (await act($, s, { site: 'step', agentId: e.agentId })).verdict
      if (v.kind === 'hold') out = await hold($, next.signal, ensureQuestion($, 'loop', s))
    } catch {
      out = 'stop' // a throwing step would send the request
    }
    if (v.kind === 'pass' || v.kind === 'tell' || out === 'resume') return yield* next(e)
    const text = v.kind === 'refuse' && v.text === 'headless' ? refusalText('headless', s) : refusalText('paused', s)
    yield { kind: 'text', index: 0, text }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    if (e.agentId === undefined && out !== 'aborted') endTurn($, e.turnId, s.attended)
    return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
  })

  // 7. The person's prompts (4.7).
  on('prompt.submit', async ($, e, next) => {
    const person = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!person) return next(e) // B11
    let s: Sensed
    try {
      s = await sense($)
    } catch {
      return next(e)
    }
    if (!s.tripped) return next(e)
    if (s.attended && s.cfg.enabled) HOLDING.add(e)
    const { verdict: v, stopped } = await act($, s, { site: 'prompt', person: true })
    if (v.kind !== 'hold') return next(e)
    const out = await hold($, next.signal, ensureQuestion($, 'prompt', s))
    if (out === 'resume') {
      return stopped ? next({ ...e, context: [...(e.context ?? []), resumeContext(factsFrom(s))] }) : next(e)
    }
    if (out !== 'aborted' && e.origin.kind === 'composer') restoreDraft($, e.text) // the last statement before return
    return { drop: notStarted(factsFrom(s)) }
  }).catch(($, e, next) => {
    const a = afterFailure(next.called, HOLDING.has(e))
    return a === 'refuse' ? { drop: NOT_STARTED_GENERIC } : next(e)
  })

  // 8. /spare10, /spare10 resume, /spare10 stop, /spare10 simulate (2.8, 12.1).
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
      return { text: await simulateCommand($, words[1]) }
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
