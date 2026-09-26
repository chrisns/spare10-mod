import type { SessionRateLimit } from 'claude-code'
import { floorOf, reserveOf, spanOf, watchedKinds } from './config.ts'
import type { Effective, Spans } from './config.ts'
import {
  CHECK_MS,
  answers,
  answersQuestion,
  coveringConsent,
  decide,
  endOf,
  endedFloor,
  extendedReal,
  floorEnded,
  heldPast,
  holdsPast,
  joinReal,
  keyStage,
  mergeStopped,
  parseConsent,
  phaseOf,
  skipTag,
  stageKey,
} from './decide.ts'
import type { Answered, Consent, Holder, Mode, Phase, Site, StoppedRecord, Tomb, Verdict, Viewed } from './decide.ts'
import {
  FALLBACK_MS,
  KINDS,
  atPoint,
  basis,
  holdEndOf,
  inResetMargin,
  inWindow,
  isTripped,
  marginOf,
  parseReset,
  pctOf,
  pointOf,
  skipStartOf,
  viewOf,
  windowMs,
} from './reading.ts'
import type { Anchored, Basis, Kind, Memory, TestSpec } from './reading.ts'
import {
  atText,
  clockText,
  consentWarning,
  debugLine,
  factsOf,
  fmtPct,
  headlessText,
  leadText,
  notStarted,
  notice,
  pauseInstruction,
  pausedText,
  resumeReply,
  simulateReply,
  stopReply,
  stopText,
  untilFor,
  untilPhrase,
  whenOf,
} from './text.ts'
import type { Ended, Facts, Named, StatusInput } from './text.ts'

// The host-free steps of the gate (Codex design A14, 7.1), lifted from register.tsx without a change of
// logic. register.tsx and the Codex adapter both call them. No host here, and no module state: every
// function takes its state as arguments, and some update the objects they are given.

// ---- The sense of each kind (register.tsx 5.2) ----

/** One watched kind at now, as the gate sees it. */
export type KindSense = {
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
  realIn: boolean // TS1: the real reading, beneath any test reading, is tripped and not open
  realReset: number | null // TS1: the reset of the real reading, null when unknown
  floor: number // B48: the floor in force in %, 0 when none (also for an unattended run, B55)
  point: number | null // B48: pointOf(floor), null when floor is 0
  atFloor: boolean // B48: tripped, not open, and the view reading at or past point
  realPct: number | undefined // TS1, B52: the pct of the real basis
}

/** One sense: the settings, the time, every watched kind, and the attendance. */
export type Sensed = { cfg: Effective; now: number; kinds: KindSense[]; tripped: boolean; attended: boolean }

/** A decision: the verdict, and what it rests on. `holders`: TS1. */
export type Acted = { verdict: Verdict; stopped: boolean; gating: KindSense[]; holders: Holder[] }

/** The basis of each kind with the test reading, and without it (B45). */
export type Bases = Record<Kind, { basis: Basis; real: Basis }>

/** R11: one fallback window end per kind and episode. `windowEndFor` keeps it. */
export type FallbackEnds = Partial<Record<Kind, number>>

/** What the host remembers of each kind (reading.ts Memory). */
export type Mems = Readonly<Record<Kind, Memory>>

/** The window end that bounds consent and stopped. Without resetsAt, one fallback per kind and episode (R11). */
export function windowEndFor(kind: Kind, b: Basis, now: number, fallback: FallbackEnds): number {
  if (b.kind !== 'none' && b.resetsAtMs !== null) {
    delete fallback[kind]
    return b.resetsAtMs
  }
  const f = fallback[kind]
  if (f !== undefined && now < f) return f
  fallback[kind] = now + FALLBACK_MS
  return now + FALLBACK_MS
}

/**
 * Every watched kind at now. `edges`: the skip starts of the tripped kinds, the times at which the badge
 * can change (skip 4.1). `watched` defaults to the kinds of the settings.
 */
export function sensesOf(
  cfg: Effective,
  bases: Bases,
  spans: Spans,
  now: number,
  fallback: FallbackEnds,
  mems: Mems,
  watched: readonly Kind[] = watchedKinds(cfg),
): { kinds: KindSense[]; edges: number[] } {
  const edges: number[] = []
  const kinds = watched.map((kind): KindSense => {
    const reserve = reserveOf(cfg, kind)
    const span = spanOf(spans, kind)
    const real = bases[kind].real
    const v = viewOf(real, bases[kind].basis, reserve, span, now) // B41, B45
    const rv = viewOf(real, real, reserve, span, now) // TS1: the real reading alone
    const b = v.basis
    const windowEnd = windowEndFor(kind, b, now, fallback)
    if (v.tripped && v.skipAt !== null) edges.push(v.skipAt)
    const floor = floorOf(cfg, kind) // B48
    const point = floor > 0 ? pointOf(floor) : null
    return {
      kind,
      reserve,
      basis: b,
      tripped: v.tripped,
      windowEnd,
      holdEnd: v.skipAt ?? holdEndOf(b, mems[kind], now, kind),
      stopEnd: v.skipAt ?? windowEnd,
      span,
      skipAt: v.skipAt,
      open: v.open,
      test: b.kind === 'test',
      seed: b.kind === 'seed',
      realIn: rv.tripped && !rv.open,
      realReset: real.kind === 'none' ? null : real.resetsAtMs,
      floor,
      point,
      atFloor: v.tripped && !v.open && atPoint(b, point),
      realPct: real.kind === 'none' ? undefined : real.pct,
    }
  })
  return { kinds, edges }
}

/** B55: an unattended run never asks, so it has no floor in force: no stage and no floor names. */
export const noFloor = (k: KindSense): KindSense => ({ ...k, floor: 0, point: null, atFloor: false })

/** B48: the end point of a Resume on a kind: its floor point when it is at the reserve with a floor in force. */
export const resumeTo = (k: KindSense): number | undefined => (k.tripped && !k.open && !k.atFloor && k.point !== null ? k.point : undefined)

/** A question's end of one kind: the consent bound, the test flag, the skip start and the tier (B50). */
export type QuestionEnd = { end: number; test: boolean; skipAt?: number; to?: number } // to: the tier of a kind asked at the reserve (B50)

/** A consent of a question's kind: its bound, and its end point when it was asked at the reserve (B49). */
export const consentOfEnd = (end: QuestionEnd): Consent => ({ until: end.end, ...(end.to === undefined ? {} : { to: end.to }) })

/** TS1: a kind whose real reading gates now, as heldPast reads it. */
export const realHolder = (k: KindSense): Holder => ({ kind: k.kind, resetsAtMs: k.realReset })

/**
 * TS1: a command's view of the kinds whose real reading gates now. A command never waits on a consent
 * read, so a consented kind counts too: the stop is then kept, the safe side.
 */
export const commandHolders = (kinds: readonly KindSense[]): Holder[] => kinds.filter((k) => k.realIn).map(realHolder)

/** B50: a kind as the gate sees it: its view percentage and basis. */
export const viewedOf = (k: KindSense): Viewed => ({ kind: k.kind, pct: pctOf(k.basis) ?? 0, test: k.test })

/** The consent bound of a kind's real reading: the view window, or beneath a test reading the real reset (TS1). */
export const realBound = (k: KindSense, now: number): number => (k.test ? (k.realReset ?? now + FALLBACK_MS) : k.windowEnd)

/** Hold mode, or tell mode with a pause prompt. */
export const modeOf = (cfg: Pick<Effective, 'pausePrompt'>): Mode => (cfg.pausePrompt === null ? 'hold' : 'tell')

/** A test reading of a kind: `in` from now, else the live reset, else one window from now. */
export function testReading(pct: number, kind: Kind, live: SessionRateLimit | undefined, now: number, inMs?: number): Anchored {
  const liveReset = live === undefined ? null : parseReset(live.resetsAt)
  const resetsAtMs = inMs !== undefined ? now + inMs : (liveReset ?? now + windowMs(kind))
  return { pct, resetsAtMs }
}

/**
 * 4.8: a watched kind whose last real reading was in the reserve reset less than the 5-minute margin
 * ago. A release waits for it: the 60 s margin of a test window never applies at a real reset.
 */
export const resetTooRecent = (s: Pick<Sensed, 'kinds' | 'now'>, mems: Mems): boolean =>
  s.kinds.some((k) => inResetMargin(mems[k.kind].seed, k.reserve, s.now))


// ---- Facts and texts (register.tsx 5.2, 5.4) ----

/**
 * The figures of some kinds, five_hour first. A hold end that is not the reset (a reading without a
 * reset time, or a skip start ahead) rides along for {at}. `owner`: a skip owner, whose kinds with a
 * skip start ahead carry their span for {lead} (skip 2.1). A kind at the floor carries its floor, so
 * the texts name it (B48). `toOf`: the end point of the consent that the text describes (floor 6.6).
 */
export function factsFrom(ks: readonly KindSense[], now: number, owner = false, toOf?: (k: KindSense) => number | undefined): Facts[] {
  return ks.map((k) => {
    const f = factsOf(k.basis, k.reserve, undefined, k.kind, now)
    const reset = k.basis.kind === 'none' ? undefined : k.basis.resetsAtMs
    const to = toOf?.(k)
    return {
      ...f,
      ...(reset !== undefined && k.holdEnd !== reset ? { holdEnd: k.holdEnd } : {}),
      ...(k.test ? { test: true } : {}),
      ...(owner && k.skipAt !== null ? { span: k.span } : {}),
      ...(k.atFloor ? { floor: k.floor } : {}),
      ...(to === undefined ? {} : { to }),
    }
  })
}

/** Floor 6.6: the end point now of a covering consent to the floor, for the texts of a consented kind. */
export const consentEnd =
  (consents: ReadonlyArray<{ k: KindSense; c: Consent }>) =>
  (k: KindSense): number | undefined => {
    const c = consents.find((x) => x.k.kind === k.kind)?.c
    return c?.to === undefined ? undefined : endOf(c.to, k.point)
  }

/** The kinds a text names: the gating kinds, else the tripped ones. */
export const namedKinds = (s: Pick<Sensed, 'kinds'>, a: Pick<Acted, 'gating'>): KindSense[] =>
  a.gating.length > 0 ? a.gating : s.kinds.filter((k) => k.tripped)

/** The model text of a refused tool or step. `sessionId`: the id that the headless text names. */
export function refusalText(kind: 'stop' | 'paused' | 'headless', s: Pick<Sensed, 'kinds' | 'now'>, a: Pick<Acted, 'gating'>, sessionId: string): string {
  const f = factsFrom(namedKinds(s, a), s.now)
  if (kind === 'stop') return stopText(f)
  if (kind === 'paused') return pausedText(f)
  return headlessText(f, sessionId)
}

/** The pause instruction of tell mode (5). */
export const tellText = (s: Pick<Sensed, 'kinds' | 'now' | 'cfg'>, a: Pick<Acted, 'gating'>): string =>
  pauseInstruction(factsFrom(namedKinds(s, a), s.now), s.cfg.pausePrompt)

/** The drop reason of a person prompt that spare10 did not start. */
export const notStartedFor = (s: Pick<Sensed, 'kinds' | 'now'>, a: Pick<Acted, 'gating'>): string => notStarted(factsFrom(namedKinds(s, a), s.now))

/**
 * The open question of a session, as the core builds and reads it (4.3, 4.5, 4.6, 5.6). A host adds its
 * own fields: the waiter count, the check flag and the raiser.
 */
export type QuestionCore = {
  kinds: Kind[] // the gating kinds when it opened, five_hour first
  ends: Partial<Record<Kind, QuestionEnd>> // consent bound, test flag, skip start and end point per kind
  latestEnd: number // the latest consent bound (the B6 note of a question that is not a skip owner)
  real: Holder[] // TS1: its kinds whose real reading gated when it opened, with their resets, for a Stop here whose sense fails
  stopEnd: number // the latest stop end of its kinds: the until of a Stop here with autoResume off
  holdEnd: number // the latest hold end of its kinds
  due: number // the latest hold end plus margin of its kinds
  skip: boolean // a skip owner: its hold end is a skip start, and no kind of it is due later (B42)
  noteAt: number // autoResume off: the time of the one note. B43 can move it later
  nextCheck: number // the next check before the due time
  silent: boolean // an unattended wait hold: no dialog, never raised
  auto: boolean // autoResume when it opened: the text only
  loops: number // tool and step waiters that joined (a Stop with loops has work)
  since: number
  mode: Mode
  opener: 'loop' | 'prompt'
  facts: Facts[]
  handoffs: number
  noted: boolean
}

/** The kinds of a question, with their basis, for {reset}. */
export const namedOf = (q: Pick<QuestionCore, 'kinds' | 'ends'>): Named[] => q.kinds.map((kind) => ({ kind, test: q.ends[kind]?.test === true }))

/** B50: what a Resume of this question answers per kind: its basis, and its end point when asked at the reserve. */
export const answeredOf = (q: Pick<QuestionCore, 'kinds' | 'ends'> | undefined): Answered[] =>
  q === undefined
    ? []
    : q.kinds.map((kind) => {
        const end = q.ends[kind]
        return { kind, test: end?.test === true, ...(end?.to === undefined ? {} : { to: end.to }) }
      })

/** The kinds of a stop, with its basis, for {reset}. A 0.1 value names the 5-hour window. */
export const namedStop = (r: StoppedRecord): Named[] => (r.kinds ?? ['five_hour']).map((kind) => ({ kind, test: r.test === true }))

/** Facts in KINDS order. */
export const byKind = (fs: readonly Facts[]): Facts[] =>
  [...fs].sort((a, b) => KINDS.indexOf(a.kind ?? 'five_hour') - KINDS.indexOf(b.kind ?? 'five_hour'))

// ---- The consent split and the holders (register.tsx 5.2, floor 4.2, TS1) ----

/** A consent of a kind and where it comes from. `raw`: the stored text, for a compare-and-set (B52). */
export type Sourced = { c: Consent; from: 'slot' | 'test' | 'env'; raw?: string }

/** Skip 3.3, floor 4.2: the tripped kinds with a consent that applies, those that gate and those that are open. */
export type Split = { gating: KindSense[]; open: KindSense[]; consented: Array<{ k: KindSense; c: Consent }> }

/** A split with no kind in it. */
export const emptySplit = (): Split => ({ gating: [], open: [], consented: [] })

/**
 * B52: the consents to the floor of a kind whose own basis has reached their end point end for good. A
 * real consent ends by the real reading, a test consent by the test reading. `unset`: the entries that
 * ended, which the host removes (a test or slot entry at once, a stored value by compare-and-set).
 * `tombs`: what to bury, in order: each ended real consent, and with `failed` (the stored read failed,
 * so `list` has only the slots) the window whose end point the real reading reached. Call it only for
 * a tripped kind that is not open.
 */
export function floorEndsOf(k: KindSense, list: readonly Sourced[], now: number, failed = false): { unset: Sourced[]; tombs: Tomb[] } {
  const unset: Sourced[] = []
  const tombs: Tomb[] = []
  for (const e of list) {
    if (e.c.to === undefined) continue
    const test = e.from === 'test'
    const pct = test ? pctOf(k.basis) : k.realPct
    const bound = test ? k.windowEnd : realBound(k, now)
    if (pct === undefined || !floorEnded(e.c, now, bound, pct, k.point)) continue
    unset.push(e)
    if (!test) tombs.push({ until: e.c.until, to: e.c.to }) // a test consent is never stored, so no tomb
  }
  if (failed && k.realPct !== undefined) tombs.push({ until: realBound(k, now), to: k.realPct })
  return { unset, tombs }
}

/**
 * One tripped kind into the split. An open kind whose only covering consent is a consent to the floor
 * is open (floor 1.3 item 7). `failed`: the consent read failed, and an unreadable consent is not consent.
 */
export function splitKind(out: Split, k: KindSense, list: readonly Sourced[], failed: boolean, now: number): void {
  const use = failed ? [] : list
  const c = coveringConsent(
    use.map((e) => e.c),
    now,
    k.windowEnd,
    pctOf(k.basis) ?? 0,
    k.point,
  )
  if (c !== undefined && !(k.open && c.to !== undefined)) {
    out.consented.push({ k, c })
    return
  }
  if (k.open) out.open.push(k)
  else out.gating.push(k)
}

/**
 * Skip 3.3: the tripped kinds, split. `lists` gives the consents of each tripped kind, in KINDS order,
 * once. A host ends the floor consents of a kind that is not open inside it (`floorEndsOf`), before the
 * kind is classified, as register.tsx does.
 */
export function splitFrom(kinds: readonly KindSense[], lists: (k: KindSense) => { list: readonly Sourced[]; failed: boolean }, now: number): Split {
  const out = emptySplit()
  for (const k of kinds) {
    if (!k.tripped) continue
    const r = lists(k)
    splitKind(out, k, r.list, r.failed, now)
  }
  return out
}

/** TS1: a kind whose real consent `holdersFrom` reads: its real reading gates beneath a test reading. */
export const needsRealList = (k: KindSense): boolean => k.realIn && k.test

/**
 * TS1: the kinds whose real reading gates now. A kind whose view is its real reading gates as the view
 * says, so it is in `gating`. Beneath a test reading, the real reading gates when it is tripped, not open
 * and no real consent applies on the real reading (B49). `realLists` gives the real consents of each
 * kind that `needsRealList` names, never a Resume on the test reading (3.5). A real reading without a
 * reset time takes the one-hour bound.
 */
export function holdersFrom(
  kinds: readonly KindSense[],
  gating: readonly KindSense[],
  realLists: (k: KindSense) => readonly Sourced[],
  now: number,
): Holder[] {
  const out: Holder[] = []
  for (const k of kinds) {
    if (!k.realIn) continue
    if (!k.test) {
      if (gating.some((g) => g.kind === k.kind)) out.push(realHolder(k))
      continue
    }
    const list = realLists(k)
    const bound = k.realReset ?? now + FALLBACK_MS
    const c = coveringConsent(
      list.map((e) => e.c),
      now,
      bound,
      k.realPct ?? 0,
      k.point,
    )
    if (c === undefined) out.push(realHolder(k))
  }
  return out
}

// ---- The verdict and the told keys (register.tsx 5.2, 5, B38, B50, B51) ----

/** B38, B50: the round after a Resume leaves out the kinds it answered, on its basis and below its end point. */
export const unansweredGating = (resumed: readonly Answered[], gating: readonly KindSense[]): KindSense[] =>
  gating.filter((k) => !answers(resumed, viewedOf(k)))

/** B50: the holders that a Resume did not answer. A kind the sense does not list reads as 0% on the real basis. */
export function unansweredHolders(s: Pick<Sensed, 'kinds'>, resumed: readonly Answered[], holders: readonly Holder[]): Holder[] {
  const viewOfKind = (kind: Kind): Viewed => {
    const k = s.kinds.find((x) => x.kind === kind)
    return k === undefined ? { kind, pct: 0, test: false } : viewedOf(k)
  }
  return holders.filter((h) => !answers(resumed, viewOfKind(h.kind)))
}

/** Decide row 3: tripped, and no kind gates. */
export const consentedOf = (s: Pick<Sensed, 'cfg' | 'tripped'>, gating: readonly KindSense[]): boolean =>
  s.cfg.enabled && s.tripped && gating.length === 0

/** Whether the stop matters to the verdict: guarded, attended and not consented. Else it is not read. */
export const checksStop = (s: Pick<Sensed, 'cfg' | 'tripped' | 'attended'>, gating: readonly KindSense[]): boolean =>
  s.cfg.enabled && s.attended && !consentedOf(s, gating)

/** The told keys of each kind in its window (5, B51). */
export type Told = Record<Kind, { windowEnd: number; keys: Set<string> }>

/** Told sets with no key. */
export const newTold = (): Told => ({ five_hour: { windowEnd: 0, keys: new Set<string>() }, seven_day: { windowEnd: 0, keys: new Set<string>() } })

/** B51: a loop's told key carries the stage of the kind: a second tell at the floor. */
export function toldHas(told: Told, k: KindSense, key: string): boolean {
  const t = told[k.kind]
  return t.windowEnd === k.windowEnd && t.keys.has(stageKey(key, k.atFloor))
}

/** Decide `mainTold`: every gating kind told the main loop of this session at its stage. */
export const toldMainOf = (told: Told, gating: readonly KindSense[], sessionId: string): boolean =>
  gating.length > 0 && gating.every((k) => toldHas(told, k, `${sessionId}:main`))

/**
 * The verdict (5.2) from what the host read: the gating kinds and the holders, both already without the
 * kinds a Resume answered (`unansweredGating`, `unansweredHolders`), whether a stop applies (read only
 * when `checksStop`), and `toldMain`. The host may still turn a hold or a refusal into a pass (the
 * engine fork rule G8 of the Claude host).
 */
export function verdictOf(i: {
  s: Sensed
  site: Site
  person: boolean
  gating: KindSense[]
  holders: Holder[]
  stopped: boolean
  toldMain: boolean
}): Acted {
  const { s, gating } = i
  const verdict = decide({
    site: i.site,
    tripped: s.tripped,
    enabled: s.cfg.enabled,
    consented: consentedOf(s, gating),
    attended: s.attended,
    headless: s.cfg.headless,
    mode: modeOf(s.cfg),
    person: i.person,
    stopped: i.stopped,
    mainTold: i.toldMain,
    seedOnly: gating.length > 0 && gating.every((k) => k.seed),
  })
  return { verdict, stopped: i.stopped, gating, holders: i.holders }
}

/**
 * A loop is told when some gating kind lacks its key of the kind's stage (B51). The claim adds the key
 * of its stage to every gating kind. So each loop is told once at the reserve and once at the floor.
 */
export function claimTold(told: Told, gating: readonly KindSense[], key: string): boolean {
  let fresh = false
  for (const k of gating) {
    if (told[k.kind].windowEnd !== k.windowEnd) told[k.kind] = { windowEnd: k.windowEnd, keys: new Set() }
    const staged = stageKey(key, k.atFloor)
    if (told[k.kind].keys.has(staged)) continue
    told[k.kind].keys.add(staged)
    fresh = true
  }
  return fresh
}

/** B51: the mark of the B12 notice per kind: its window and stage. */
export const toldMark = (k: KindSense): string => `${k.windowEnd}:${k.atFloor ? 'floor' : 'reserve'}`

/** B12, B51: the told notice, once per kind, window and stage. It updates `marks`. Undefined: shown already. */
export function toldNotice(s: Pick<Sensed, 'kinds' | 'now'>, a: Pick<Acted, 'gating'>, marks: Record<Kind, string>): string | undefined {
  const ks = namedKinds(s, a)
  if (ks.every((k) => marks[k.kind] === toldMark(k))) return undefined
  for (const k of ks) marks[k.kind] = toldMark(k)
  return notice.told(factsFrom(ks, s.now))
}

/** The window end of the last B15 debug line per kind, in the reserve and open (skip 2.5). */
export type UnattendedMarks = { reserve: Record<Kind, number>; open: Record<Kind, number> }

/** B15, skip 2.5: the debug lines of an unattended run, once per kind and window. It updates `marks`. */
export function unattendedLines(s: Pick<Sensed, 'kinds' | 'now' | 'cfg'>, marks: UnattendedMarks): string[] {
  const out: string[] = []
  const fresh = s.kinds.filter((k) => k.tripped && !k.open && marks.reserve[k.kind] !== k.windowEnd)
  if (fresh.length > 0) {
    for (const k of fresh) marks.reserve[k.kind] = k.windowEnd
    out.push(debugLine.unattended(factsFrom(fresh, s.now), s.cfg.headless)) // R9: every policy
  }
  const opened = s.kinds.filter((k) => k.open && marks.open[k.kind] !== k.windowEnd)
  if (opened.length > 0) {
    for (const k of opened) marks.open[k.kind] = k.windowEnd
    out.push(debugLine.unattendedOpen(factsFrom(opened, s.now))) // skip 2.5: every policy lets it through
  }
  return out
}

// ---- The question (register.tsx 4.3, 4.5, 4.6, 5.6) ----

/** A kind's hold end plus this is when it may be released: 0 at a skip start (B42), else the reset margin (4.8). */
export const dueMargin = (k: KindSense): number => marginOf(k.skipAt !== null, k.test)

/**
 * A new question on the kinds that `namedKinds` gives: per kind its consent bound, test flag, skip start
 * and tier (B48, B50), and the ends, the due time, the skip owner and the note time of them all.
 */
export function questionOf(opener: 'loop' | 'prompt', s: Sensed, a: Pick<Acted, 'gating' | 'holders'>, now: number): QuestionCore {
  const g = namedKinds(s, a)
  const ends: QuestionCore['ends'] = {}
  for (const k of g) {
    const to = resumeTo(k) // B48, B50: the tier of the question per kind
    ends[k.kind] = { end: k.windowEnd, test: k.test, ...(k.skipAt === null ? {} : { skipAt: k.skipAt }), ...(to === undefined ? {} : { to }) }
  }
  const latestEnd = Math.max(...g.map((k) => k.windowEnd))
  const real = a.holders.filter((h) => g.some((k) => k.kind === h.kind))
  const holdEnd = Math.max(...g.map((k) => k.holdEnd))
  const due = Math.max(...g.map((k) => k.holdEnd + dueMargin(k)))
  // B42: a skip owner only when a skip start is the hold end, and no kind of it is due later.
  const skip = g.some((k) => k.skipAt === holdEnd) && due === holdEnd
  return {
    kinds: g.map((k) => k.kind),
    ends,
    latestEnd,
    real,
    stopEnd: Math.max(...g.map((k) => k.stopEnd)),
    holdEnd,
    due,
    skip,
    noteAt: skip ? holdEnd : latestEnd,
    nextCheck: now + CHECK_MS,
    silent: !s.attended,
    auto: s.cfg.autoResume,
    loops: opener === 'loop' ? 1 : 0,
    since: now,
    mode: modeOf(s.cfg),
    opener,
    facts: factsFrom(g, now, skip, resumeTo),
    handoffs: 0,
    noted: false,
  }
}

/** The times at which a new question can change the badge: each consent bound, its hold end, due, stop end and note time. */
export const questionEdges = (q: QuestionCore): number[] => [
  ...q.kinds.map((kind) => q.ends[kind]?.end ?? 0),
  q.holdEnd,
  q.due,
  q.stopEnd,
  q.noteAt,
]

/** The B9 notice of a Resume: what continues, or a new window when every consent bound has passed. */
export function resumeNotice(q: Pick<QuestionCore, 'kinds' | 'ends' | 'facts' | 'mode'>, now: number): string {
  const open = q.kinds.filter((kind) => (q.ends[kind]?.end ?? 0) > now)
  return open.length > 0
    ? notice.continuing(
        q.facts.filter((f) => open.includes(f.kind ?? 'five_hour')),
        q.mode,
      )
    : notice.newWindowFor(q.kinds)
}

// ---- Stops (register.tsx 5.7, 3.2, skip 3.5, B34, B46, TS1) ----

/** The skip starts that are still ahead of some kinds. */
export const skipStarts = (ks: readonly KindSense[]): number[] => ks.map((k) => k.skipAt).filter((t): t is number => t !== null)

/**
 * B34: an auto stop extended to the kinds that gate now, until their latest hold end. The test tag keeps
 * the short margin only while every kind that gates now is a test reading. TS1: each kind whose real
 * reading gates now (`holders`) gets a real entry with its current reset, the window it gates in. Any
 * other kind that still gates keeps its entry while that window lasts (`extendedReal`).
 */
export function extended(r: StoppedRecord, gatingNow: readonly KindSense[], holders: readonly Holder[], now: number): StoppedRecord {
  const until = Math.max(...gatingNow.map((k) => k.holdEnd))
  const skip = skipTag(until, skipStarts(gatingNow), gatingNow.map((k) => k.holdEnd + dueMargin(k)), true)
  const { skip: _old, real: _real, ...kept } = r
  const kinds = gatingNow.map((k) => k.kind)
  const real = extendedReal(r.real, holders, kinds, now)
  return {
    ...kept,
    kinds,
    windowEnd: until,
    test: r.test === true && gatingNow.every((k) => k.test),
    ...(skip ? { skip: true } : {}),
    ...(real.length > 0 ? { real } : {}),
  }
}

/**
 * TS1: a stop held past its until, as the badge, /spare10 and the stop reply show it. An auto stop gets
 * the record that the ticker writes at its next tick (B34). A stop made with autoResume off lasts until
 * the stop end of its kinds that keep it: their skip start, or else the consent bound. With no such kind
 * among the kinds that gate (a Resume on a test reading over the real one), the record as it is.
 */
export function stillHeld(st: StoppedRecord, gating: readonly KindSense[], holders: readonly Holder[], now: number): StoppedRecord {
  const mine = gating.filter((k) => holders.some((h) => h.kind === k.kind && holdsPast(st, h)))
  if (mine.length === 0) return st
  if (st.auto === true) return extended(st, gating, holders, now)
  const until = Math.max(...mine.map((k) => k.stopEnd))
  const skip = skipTag(until, skipStarts(mine), [], false)
  const { skip: _old, ...kept } = st
  return { ...kept, windowEnd: until, ...(skip ? { skip: true } : {}) }
}

/**
 * The stop of this conversation that applies now, if any. `gating`: the kinds that gate now. `holders`:
 * the kinds whose real reading gates now. A stop past its until that one of them keeps applies too (TS1:
 * `holdsPast`), with the end it will have. A stop of an ended conversation (`endedSid`) no longer counts.
 */
export function stopInForce(
  st: StoppedRecord | undefined,
  sessionId: string,
  endedSid: string | undefined,
  now: number,
  gating: readonly KindSense[],
  holders: readonly Holder[],
): StoppedRecord | undefined {
  if (st === undefined || st.sessionId !== sessionId || st.sessionId === endedSid) return undefined
  if (now < st.windowEnd) return st
  return heldPast(st, holders) ? stillHeld(st, gating, holders, now) : undefined
}

/** A new stop to write. `real` (TS1): the kinds whose real reading gates at the stop, with their resets now. */
export type StopWrite = { kinds: Kind[]; windowEnd: number; work: boolean; auto: boolean; test: boolean; skip: boolean; real: readonly Holder[] }

/** 5.7: the 0.2 record, merged with an earlier stop of this session (3.2). Only the real entries of `kinds` are kept. */
export function stopRecordOf(prev: StoppedRecord | undefined, n: StopWrite, sessionId: string, now: number): StoppedRecord {
  const { skip, real: realNow, ...rest } = n
  const real = realNow.filter((h) => n.kinds.includes(h.kind))
  return mergeStopped(prev, { ...rest, ...(skip ? { skip: true } : {}), ...(real.length > 0 ? { real } : {}), sessionId, at: now }, now)
}

/**
 * Skip 4.4: which kinds of a question or a stop reset, and which are open now. A kind is named as reset
 * when it is neither open nor gating now. With no skip owner and no open kind, the D0.2 lists (every
 * named kind reset), so each notice keeps its D0.2 wording. `owner` with no sense: nothing is known.
 */
export function endedFor(
  named: readonly Named[],
  s: { kinds: readonly KindSense[]; now: number } | undefined,
  gatingNow: readonly KindSense[],
  owner: boolean,
): Ended {
  if (s === undefined) return owner ? { reset: [], open: [] } : { reset: [...named], open: [] }
  const open = factsFrom(
    s.kinds.filter((k) => k.open && named.some((n) => n.kind === k.kind)),
    s.now,
  )
  if (!owner && open.length === 0) return { reset: [...named], open: [] }
  const reset = named.filter((n) => !open.some((f) => (f.kind ?? 'five_hour') === n.kind) && !gatingNow.some((k) => k.kind === n.kind))
  return { reset, open }
}

/** How a question settles. */
export type Via = 'dialog' | 'command' | 'elsewhere' | 'could not ask' | 'dialog ended without an answer' | 'reset' | 'quota' | 'time limit'

/** A settle's result for a Stop (B46): the record as written, what opened, and the until for the reply. */
export type Late = { record?: StoppedRecord; ended?: Ended; until?: { at: string; lead?: string } }

/** A sense at a Stop here: the kinds, the split and the holders of now. */
export type StopSense = { s: Sensed; split: Split; holders: readonly Holder[] }

/** What a Stop here writes. 'open' (B46 open): nothing, because nothing gates and a kind of the question is open. */
export type StopPlan =
  | { kind: 'open'; until: number; ended: Ended }
  | { kind: 'write'; until: number; ended?: Ended; late: KindSense[]; record: StopWrite }

/**
 * A Stop here (skip 3.5, B46). The sense gives the kinds whose real reading gates now (TS1: the `real`
 * tag). When the question's time has passed (its hold end with autoResume on, its skip start with it
 * off), it also gives the kinds that gate now (`late`) and the question's kinds that are open now. The
 * kinds that gate are stopped as usual. When nothing gates, a kind of the question is open, and no work
 * waits for a resume prompt, nothing is written: such a stop would never apply. No sense (it failed):
 * the D0.2 write, with the real kinds of the question when it opened. `auto`: the setting in force.
 */
export function stopPlan(q: QuestionCore, now: number, auto: boolean, sNow?: StopSense): StopPlan {
  const work = q.loops > 0
  const passed = auto ? q.holdEnd <= now : q.skip && q.stopEnd <= now
  const real = sNow === undefined ? q.real : sNow.holders // fail closed: the question's real kinds when the sense fails
  const late = sNow !== undefined && passed ? sNow.split.gating : []
  const opened = sNow !== undefined && passed ? sNow.split.open.filter((k) => q.kinds.includes(k.kind)) : []
  const until = auto ? Math.max(q.holdEnd, ...late.map((k) => k.holdEnd)) : Math.max(q.stopEnd, ...late.map((k) => k.stopEnd))
  const ended = sNow === undefined || opened.length === 0 ? undefined : endedFor(namedOf(q), sNow.s, late, true)
  if (until <= now && ended !== undefined && !(auto && work)) return { kind: 'open', until, ended }
  const kinds = KINDS.filter((k) => q.kinds.includes(k) || late.some((l) => l.kind === k))
  const allTest = q.kinds.every((kind) => q.ends[kind]?.test === true) && late.every((k) => k.test)
  const starts = [
    ...q.kinds.map((kind) => q.ends[kind]?.skipAt).filter((t): t is number => t !== undefined),
    ...late.map((k) => k.skipAt).filter((t): t is number => t !== null),
  ]
  const skip = skipTag(until, starts, [q.due, ...late.map((k) => k.holdEnd + dueMargin(k))], auto)
  return { kind: 'write', until, ...(ended === undefined ? {} : { ended }), late, record: { kinds, windowEnd: until, work, auto, test: allTest, skip, real } }
}

/** B46 open: the transcript line of a Stop here that writes nothing. None for a command. */
export function stopOpenNotice(q: Pick<QuestionCore, 'facts'>, ended: Ended, via: Via): string | undefined {
  if (via === 'time limit') return notice.holdLimitLate(q.facts, ended, false)
  if (via !== 'command') return notice.stoppedLate(q.facts, ended, false)
  return undefined
}

/**
 * The transcript line of a Stop here that wrote `written`, and the settle's result. The texts follow the
 * record as written: the merge can add work, kinds and a later end (3.2). For a skip owner, a late kind's
 * fresh facts replace the question's (under B45 it is now sensed on the real basis). Else only the late
 * kinds that the question does not name are added (D0.2). No text for a command.
 */
export function stopNotice(
  q: QuestionCore,
  plan: Extract<StopPlan, { kind: 'write' }>,
  written: StoppedRecord,
  via: Via,
  now: number,
  auto: boolean,
): { text?: string; late: Late } {
  const work = q.loops > 0
  const late = plan.late
  const fresh = factsFrom(late, now, written.skip === true)
  const facts = byKind(
    q.skip
      ? [...q.facts.filter((f) => !late.some((k) => k.kind === (f.kind ?? 'five_hour'))), ...fresh]
      : [...q.facts, ...fresh.filter((f) => !q.kinds.includes(f.kind ?? 'five_hour'))],
  )
  const u = untilFor(facts, written.windowEnd, written.kinds ?? plan.record.kinds, written.skip === true, now)
  const text = (limit: string, stopped: string): { text?: string } => (via === 'time limit' ? { text: limit } : via !== 'command' ? { text: stopped } : {})
  const ended = plan.ended
  if (ended !== undefined && late.length === 0 && auto && work && plan.until <= now) {
    // B46 soon: the stop is written with its passed until, and the next tick continues the work.
    return { ...text(notice.holdLimitLate(facts, ended, true), notice.stoppedLate(facts, ended, true)), late: { record: written, ended, until: u } }
  }
  // A skip stop shows its end in both modes: with autoResume off it ends by time then (skip 1.3 item 6).
  // With autoResume off, an end that has already passed (the window reset while the question waited,
  // or the sense failed) is no help to the person: the D0.2 text with no time.
  const shows = written.skip === true && (auto || written.windowEnd > now)
  const a = shows ? { ...u, work: auto && written.work === true } : auto ? { ...u, work: written.work === true } : undefined
  return { ...text(notice.holdLimit(facts, a), notice.stopped(facts, a)), late: { record: written, until: u } }
}

/** B34: the transcript line of an auto stop that the ticker extended to `longer`. */
export function extendNotice(r: StoppedRecord, longer: StoppedRecord, gatingNow: readonly KindSense[], s: Pick<Sensed, 'kinds' | 'now'>): string {
  const skip = longer.skip === true
  const ended = endedFor(namedStop(r), s, gatingNow, r.skip === true)
  const facts = factsFrom(gatingNow, s.now, skip)
  return notice.stopExtended(ended.reset, facts, untilPhrase(untilFor(facts, longer.windowEnd, longer.kinds ?? [], skip, s.now)), ended.open)
}

/** takeOverdueStop's result (skip 4.6): the stop that was taken over, and what reset and what opened. */
export type Taken = { record: StoppedRecord } & Ended

/** A stop taken over. `s`: a sense of now, so the notice can name what opened. None: nothing is known. */
export const takenOf = (record: StoppedRecord, s: { kinds: readonly KindSense[]; now: number } | undefined): Taken => ({
  record,
  ...endedFor(namedStop(record), s, [], record.skip === true),
})

/** 4.6.3: a stop that the ticker cleared while a person prompt was in flight, and when. */
export type HandedOver = { record: StoppedRecord; at: number }

/**
 * 4.6.3: the prompt takes a handed-over stop over when the hand-over came less than a check period ago
 * and no kind of the stop still holds it (TS1).
 */
export const handoverTakes = (h: HandedOver | undefined, now: number, holders: readonly Holder[]): h is HandedOver =>
  h !== undefined && now - h.at < CHECK_MS && !heldPast(h.record, holders)

// ---- The waits (register.tsx 4.5, 4.6, 4.8, B43) ----

/**
 * 4.5: a waiter's check has nothing to do yet: the question is not due, the next check has not come, and
 * the note is done or not yet due. Else the host moves `nextCheck` on by CHECK_MS and asks `dueStep`.
 */
export const dueWait = (q: Pick<QuestionCore, 'due' | 'nextCheck' | 'noted' | 'noteAt'>, now: number): boolean =>
  !(now >= q.due) && now < q.nextCheck && (q.noted || now < q.noteAt)

/**
 * 4.5, B6, B43: the waiter's check after `dueWait`. `auto`: the autoResume setting in force (a silent
 * question never reads it: pass true). With it off, a question waits for the answer: 'note' writes the
 * D0.2 note, 'noteSensed' (a skip owner) senses first and asks `sensedNote`. Past the reset, inside the
 * margin: 'wait'. Else 'check': sense, and ask `dueRelease`.
 */
export function dueStep(
  q: Pick<QuestionCore, 'due' | 'silent' | 'noted' | 'noteAt' | 'skip' | 'holdEnd'>,
  now: number,
  auto: boolean,
): 'wait' | 'note' | 'noteSensed' | 'check' {
  const due = now >= q.due
  if (!q.silent && !auto) {
    // The setting in force now says wait for the answer (1.3 item 6, B6).
    if (!q.noted && now >= q.noteAt) return q.skip ? 'noteSensed' : 'note'
    return 'wait'
  }
  if (!due && now >= q.holdEnd) return 'wait' // past the reset, inside the margin: wait (4.8)
  return 'check'
}

/**
 * B43: the note of a skip owner names what opened or reset. `text`: the note, and the question is noted.
 * `noteAt`: nothing of the question opened yet (a real trip beneath a test reading, B45), so the note
 * waits for the hold end of its kinds that gate.
 */
export function sensedNote(
  q: Pick<QuestionCore, 'kinds' | 'ends'>,
  s: Pick<Sensed, 'kinds' | 'now'>,
  gatingNow: readonly KindSense[],
  now: number,
): { text: string } | { noteAt: number } {
  const ended = endedFor(namedOf(q), s, gatingNow, true)
  if (ended.reset.length === 0 && ended.open.length === 0) {
    const mine = gatingNow.filter((k) => q.kinds.includes(k.kind))
    return { noteAt: Math.max(now + CHECK_MS, ...mine.map((k) => k.holdEnd)) }
  }
  // New work goes on only while no kind gates: a window that still gates holds new work too.
  return { text: notice.resetWaitingFor(ended.reset, ended.open, gatingNow.length === 0) }
}

/**
 * 4.5: whether a check releases the held work, and why. Before the due time only when no kind gates. A
 * stop never holds an open kind (B44), so no kind gating means the gate lets the held loops through (skip
 * 4.3). `tooRecent` (`resetTooRecent`): a test window that ends near a real reset waits (4.8).
 */
export function dueRelease(q: Pick<QuestionCore, 'due'>, now: number, gatingNow: readonly KindSense[], tooRecent: boolean): 'reset' | 'quota' | undefined {
  const due = now >= q.due
  if (!due && gatingNow.length > 0) return undefined
  if (gatingNow.length === 0 && tooRecent) return undefined
  return due ? 'reset' : 'quota'
}

/** 4.5: the transcript line of a question that ends without an answer. The D0.2 texts byte for byte. */
export function againNotice(
  q: Pick<QuestionCore, 'kinds' | 'ends' | 'skip'>,
  via: 'reset' | 'quota',
  gatingNow: readonly KindSense[],
  s: Pick<Sensed, 'kinds' | 'now'>,
): string {
  const ended = endedFor(namedOf(q), s, gatingNow, q.skip)
  if (!q.skip && ended.open.length === 0) {
    if (via === 'quota') return notice.outOfReserve
    if (gatingNow.length === 0) return notice.resetContinues(namedOf(q))
    return notice.resetStillHeld(namedOf(q), factsFrom(gatingNow, s.now))
  }
  if (gatingNow.length === 0) return ended.reset.length + ended.open.length > 0 ? notice.resetContinues(ended.reset, ended.open) : notice.outOfReserve
  return notice.resetStillHeld(ended.reset, factsFrom(gatingNow, s.now), ended.open)
}

/**
 * 4.6: what the ticker does with an auto stop past its due time. 'skip': nothing gates, but a real reset
 * came less than the margin ago (4.8). 'extend': a kind still gates (B34). 'end': the stop ends.
 */
export const tickPlan = (gatingNow: readonly KindSense[], tooRecent: boolean): 'skip' | 'extend' | 'end' =>
  gatingNow.length === 0 && tooRecent ? 'skip' : gatingNow.length > 0 ? 'extend' : 'end'

/** B50 item 3: a consent answers a question's kind at a matching tier. A consent to the floor never answers a kind asked at the floor. */
export const answersKind = (end: QuestionEnd | undefined, list: readonly Sourced[], now: number): boolean =>
  end !== undefined && list.some((e) => answersQuestion(e.c, end, now))

/** R6: a stop newer than the question and still in force settles it as Stop here, when it is of this session. */
export const stopNewer = (st: StoppedRecord | undefined, q: Pick<QuestionCore, 'since'>, now: number): st is StoppedRecord =>
  st !== undefined && st.at > q.since && now < st.windowEnd

// ---- Commands (register.tsx 2.7, 2.8, 2.9, 4.6, B23 to B26, B44, B46, B50, B53) ----

/** The trip point of a reserve, on the one-decimal grid. */
export const tripOf = (reserve: number): number => Math.round((100 - reserve) * 10) / 10

/**
 * What a command's takeover knows of now (skip 4.6, TS1): the kinds, and the kinds whose real reading
 * gates (`commandHolders`). With no sense nothing is known, and the takeover follows 4.6.
 */
export function takeoverSense(sNow: Pick<Sensed, 'kinds'> | undefined): { kinds?: readonly KindSense[]; holders: readonly Holder[] } {
  if (sNow === undefined) return { holders: [] }
  return { kinds: sNow.kinds, holders: commandHolders(sNow.kinds) }
}

/**
 * B50 item 4: resume on an open question raises a kind to a full Resume when the fresh sense of that
 * kind is at the floor, on the question's basis and in the question's window. Its facts then follow the
 * fresh sense, for the reply and the B9 note. Else the question's tier stands. It updates `q`.
 */
export function raiseAtFloor(q: Pick<QuestionCore, 'ends' | 'facts' | 'skip'>, sNow: Pick<Sensed, 'kinds' | 'now'>): void {
  for (const k of sNow.kinds) {
    const end = q.ends[k.kind]
    if (end?.to === undefined || !k.atFloor || k.test !== end.test || Math.abs(k.windowEnd - end.end) > 60_000) continue
    const { to: _to, ...full } = end
    q.ends[k.kind] = full
    q.facts = byKind([...q.facts.filter((f) => (f.kind ?? 'five_hour') !== k.kind), ...factsFrom([k], sNow.now, q.skip)])
  }
}

/** B23: the reply of resume from the reading alone: no reading, or below every reserve. Undefined: split next. */
export function resumeReadReply(s: Pick<Sensed, 'kinds' | 'now' | 'tripped'>): string | undefined {
  const read = s.kinds.filter((k) => k.basis.kind !== 'none')
  if (read.length === 0) return resumeReply('none')
  if (!s.tripped) return resumeReply('below', factsFrom(read, s.now))
  return undefined
}

/**
 * B23, B44, floor 2.8: resume after the split. A reply when nothing gates: an open kind has nothing to
 * resume, and a consented kind is already resumed. Else the consents to write, each gating kind at its
 * tier now (floor 1.3 item 2: before the floor to the floor, past it until the reset), and the facts of
 * the reply ('stopped' when a stop applied, else 'tripped').
 */
export function resumeCase(
  s: Pick<Sensed, 'now'>,
  split: Split,
  mode: Mode,
): { reply: string } | { gating: KindSense[]; write: Array<{ kind: Kind; c: Consent; test: boolean }>; facts: Facts[] } {
  const gating = split.gating
  if (gating.length === 0 && split.open.length > 0) return { reply: resumeReply('open', factsFrom(split.open, s.now)) } // B44: nothing to resume
  if (gating.length === 0) {
    // Floor 2.8: the facts come from the consents that cover each kind, never from the stage. The floor
    // form names the tripped kinds that are not open. With no consent to the floor, the 0.2 form names them all.
    const shut = split.consented.filter((x) => !x.k.open)
    const named = shut.some((x) => x.c.to !== undefined) ? shut : split.consented
    return {
      reply: resumeReply(
        'consented',
        factsFrom(
          named.map((x) => x.k),
          s.now,
          false,
          consentEnd(named),
        ),
        undefined,
        undefined,
        mode,
      ),
    }
  }
  const write = gating.map((k) => {
    const to = resumeTo(k)
    return { kind: k.kind, c: { until: k.windowEnd, ...(to === undefined ? {} : { to }) }, test: k.test }
  })
  return { gating, write, facts: factsFrom(gating, s.now, false, resumeTo) }
}

/** The kinds that gate after a stop: tripped and not open. Unknown (false) when the sense failed. */
export const gatesAfter = (sNow: Pick<Sensed, 'kinds'> | undefined): boolean => sNow?.kinds.some((k) => k.tripped && !k.open) === true

/**
 * B24: the reply of a stop that took an overdue stop over while no kind gates (D0.2). An open kind needs
 * no stop (B44). The reply names a reset or an open reserve only when one came.
 */
export function stopOverdueReply(t: Ended): string {
  if (t.open.length > 0) return stopReply('overdue-open', t.open)
  if (t.reset.length > 0) return stopReply('overdue')
  return stopReply('overdue-skip')
}

/**
 * B24, B46: the reply of a stop on an open question, from its settle. It follows the record as written
 * (3.2): it promises to continue only work that the stop has. Undefined: the settle wrote nothing, and
 * `stopAskingIdle` gives the reply.
 */
export function stopAskingReply(late: Late): string | undefined {
  if (late.ended !== undefined) {
    // B46: the question's time had passed and a kind of it is open.
    return stopReply(late.record !== undefined ? 'asking-soon' : 'asking-open', undefined, undefined, undefined, undefined, late.ended)
  }
  const written = late.record
  if (written === undefined) return undefined
  const cont = written.auto === true && written.work === true && written.kinds !== undefined
  return stopReply('asking', undefined, undefined, cont ? late.until : undefined)
}

/** B24: the reply of a stop on an open question whose settle wrote nothing (tell mode). `auto`: the setting in force. */
export function stopAskingIdle(q: Pick<QuestionCore, 'skip' | 'facts' | 'loops' | 'holdEnd' | 'kinds'> | undefined, auto: boolean, now: number): string {
  const lead = q?.skip === true ? whenOf(q.facts).lead : undefined
  return stopReply(
    'asking',
    undefined,
    undefined,
    auto && q !== undefined && q.loops > 0 ? { at: atText(q.holdEnd, q.kinds, undefined, now), ...(lead === undefined ? {} : { lead }) } : undefined,
  )
}

/**
 * B24: stop with no open question. A reply when nothing can be stopped: no reading, below every reserve,
 * or every tripped kind open (B44: a stop never holds an open kind). Else `ks`, the kinds that gate after
 * the stop (the stop clears every consent, so each tripped kind that is not open), the facts of every
 * tripped kind, and `real` (TS1: each kind of `ks` whose real reading is in the reserve).
 */
export function stopCase(
  s: Pick<Sensed, 'kinds' | 'now' | 'tripped'>,
  cfg: Pick<Effective, 'reserve' | 'weeklyReserve'>,
): { reply: string } | { ks: KindSense[]; facts: Facts[]; real: Holder[] } {
  const trip = tripOf(cfg.reserve)
  const weeklyTrip = cfg.weeklyReserve > 0 ? tripOf(cfg.weeklyReserve) : undefined
  const read = s.kinds.filter((k) => k.basis.kind !== 'none')
  if (read.length === 0) return { reply: stopReply('none', undefined, trip, undefined, weeklyTrip) }
  if (!s.tripped) return { reply: stopReply('below', factsFrom(read, s.now), trip, undefined, weeklyTrip) }
  const trippedKinds = s.kinds.filter((k) => k.tripped)
  const ks = trippedKinds.filter((k) => !k.open)
  if (ks.length === 0) return { reply: stopReply('open', factsFrom(trippedKinds, s.now)) }
  return { ks, facts: factsFrom(trippedKinds, s.now), real: ks.filter((k) => k.realIn).map(realHolder) }
}

/** A stop in force that names each kind that gates now stays as it is. */
export const stopKept = (st: StoppedRecord | undefined, ks: readonly KindSense[]): st is StoppedRecord =>
  st !== undefined && ks.every((k) => (st.kinds ?? ['five_hour']).includes(k.kind))

/** B24: the reply of a stop over a stop that stays. R4: its end shows when spare10 ends it by itself. */
export function stopKeptReply(st: StoppedRecord, facts: readonly Facts[], autoResume: boolean, now: number): string {
  const shows = st.kinds !== undefined && ((st.auto === true && autoResume) || st.skip === true)
  return stopReply('stopped', facts, undefined, shows && st.kinds !== undefined ? { at: atText(st.windowEnd, st.kinds, undefined, now) } : undefined)
}

/** The stop that a stop command writes over `ks`. `work`: the work of a stop it took over (3.2). */
export function stopWriteOf(ks: readonly KindSense[], auto: boolean, work: boolean): StopWrite {
  const until = auto ? Math.max(...ks.map((k) => k.holdEnd)) : Math.max(...ks.map((k) => k.stopEnd))
  const skip = skipTag(
    until,
    ks.map((k) => k.skipAt).filter((t): t is number => t !== null),
    ks.map((k) => k.holdEnd + dueMargin(k)),
    auto,
  )
  return {
    kinds: ks.map((k) => k.kind),
    windowEnd: until,
    work,
    auto,
    test: ks.every((k) => k.test),
    skip,
    real: ks.filter((k) => k.realIn).map(realHolder),
  }
}

/**
 * B24, R4: the reply of a stop that wrote `written`: tripped or consented, never armed. A skip stop shows
 * its end in both modes (skip 1.3 item 6). The reply follows the record as written: a merge with a stop
 * in force can keep its later end (3.2).
 */
export function stopTrippedReply(ks: readonly KindSense[], facts: readonly Facts[], written: StoppedRecord, auto: boolean, now: number): string {
  const wSkip = written.skip === true
  const u = untilFor(
    factsFrom(ks, now, wSkip),
    written.windowEnd,
    written.kinds ?? ks.map((k) => k.kind),
    wSkip,
    now,
  )
  return stopReply('tripped', facts, undefined, auto || wSkip ? { ...u, continues: auto } : undefined)
}

/**
 * TS1: a stop in force that names each kind that gates now gets the real entries of this moment, so that
 * it holds past its end while such a kind gates in this window. Only a stop that can hold past its end
 * carries them (`formatStopped`): undefined for any other.
 */
export function withRealEntries(r: StoppedRecord | undefined, realNow: readonly Holder[], now: number): StoppedRecord | undefined {
  if (r?.kinds === undefined || !(r.skip === true || r.test === true)) return undefined
  const kinds = r.kinds
  return {
    ...r,
    real: joinReal(
      r.real,
      realNow.filter((h) => kinds.includes(h.kind)),
      now,
    ),
  }
}

/** B53: a strictly higher value without `in`, in the window of the test reading, raises it in place. */
export const raisesInPlace = (old: Anchored, spec: TestSpec, now: number): boolean =>
  inWindow(old, now, spec.kind) && spec.inMs === undefined && spec.pct > old.pct

/**
 * Skip 2.9: a forecast of when the test reading opens its reserve. Nothing for a span of 0 or a test
 * percentage below the trip point. 'real': the real reading is in the reserve too, and its own skip
 * start does not come first, so the test window does not open it (B45).
 */
export function simulateOpens(
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

/**
 * 2.9, B53, floor 2.9: the reply of a test reading that is now set. `spans`: the spans of the host that
 * runs the command. `mem`: what the host remembers of the kind, for the real reading beneath.
 */
export function simulateText(i: {
  spec: TestSpec
  reading: Anchored
  inPlace: boolean
  cfg: Pick<Effective, 'reserve' | 'weeklyReserve' | 'resumeFloor' | 'weeklyResumeFloor'>
  spans: Spans
  live: SessionRateLimit | undefined
  mem: Memory
  now: number
}): string {
  const { spec, now } = i
  const reserve = reserveOf(i.cfg, spec.kind)
  const testBasis: Basis = { kind: 'test', ...i.reading }
  const span = spanOf(i.spans, spec.kind)
  const f: Facts = { ...factsOf(testBasis, reserve, undefined, spec.kind, now), test: true, ...(span > 0 ? { span } : {}) }
  const realBasis = basis(i.live, i.mem, now, undefined, spec.kind)
  const opens = simulateOpens(testBasis, realBasis, reserve, span, now, f)
  // Floor 2.9: past the floor of the kind, unless open at once. The real reading in the reserve beneath.
  const floor = floorOf(i.cfg, spec.kind)
  const pastFloor = floor > 0 && spec.pct >= pointOf(floor) && opens !== 'now' ? floor : undefined
  const rv = viewOf(realBasis, realBasis, reserve, span, now)
  const realIn = rv.tripped && !rv.open && (pctOf(realBasis) ?? 100) < spec.pct
  return simulateReply(i.inPlace ? 'raised' : 'set', f, opens, pastFloor, realIn)
}

// ---- The report (register.tsx 2.6, 2.7, 3.1, 3.5) ----

/** The phase and its inputs, with the same reads as the gate. */
export type Seen = {
  cfg: Effective
  now: number
  bases: Record<Kind, Basis> // with the test reading, for the reading rows
  kinds: KindSense[]
  tripped: boolean
  attended: boolean
  open: KindSense[] // tripped, not consented, and open (skip 3.3)
  gating: KindSense[] // tripped, not consented, and not open (skip 3.3)
  consent: Partial<Record<Kind, Consent>> // the consent in force of each kind (full first)
  ended: Partial<Record<Kind, Consent>> // a consent to the floor whose end point the view reading reached (B52, not yet ended by a gate)
  stop?: StoppedRecord // the stop that applies
  question?: QuestionCore // the open question
  toldCount: number
  phase: Phase
}

/** The report's view of the consents, as the split classifies them (floor 4.2), but it only reads: it never ends a consent (B52). */
export type SeenSplit = Pick<Seen, 'consent' | 'ended' | 'gating' | 'open'>

/** Every kind of the report with its consents (`lists`, the consents of each kind). */
export function seenSplit(kinds: readonly KindSense[], lists: (k: KindSense) => readonly Consent[], now: number): SeenSplit {
  const out: SeenSplit = { consent: {}, ended: {}, gating: [], open: [] }
  for (const k of kinds) {
    const list = lists(k)
    const pct = pctOf(k.basis) ?? 0
    const c = coveringConsent(list, now, k.windowEnd, pct, k.point)
    if (c !== undefined && !(k.open && c.to !== undefined)) {
      out.consent[k.kind] = c
      continue
    }
    const e = endedFloor(list, now, k.windowEnd, pct, k.point)
    if (e !== undefined) out.ended[k.kind] = e
    if (k.tripped && k.open) out.open.push(k)
    else if (k.tripped) out.gating.push(k)
  }
  return out
}

/**
 * The report's view: the split, the stop, the open question and the told loops of this session. B51:
 * the loops told at the kind's current stage, so at the floor the tripped row shows until the first tell there.
 */
export function seenOf(i: {
  cfg: Effective
  now: number
  bases: Bases
  kinds: KindSense[]
  tripped: boolean
  attended: boolean
  split: SeenSplit
  stop: StoppedRecord | undefined
  question: (QuestionCore & { silent: boolean }) | undefined
  told: Told
  sessionId: string
}): Seen {
  const { cfg, tripped, split, stop, question } = i
  const prefix = `${i.sessionId}:`
  const toldKeys = new Set<string>()
  for (const k of split.gating) {
    const t = i.told[k.kind]
    if (t.windowEnd !== k.windowEnd) continue
    for (const key of t.keys) {
      const ks = keyStage(key)
      if (key.startsWith(prefix) && ks.atFloor === k.atFloor) toldKeys.add(ks.base)
    }
  }
  const phase = phaseOf({
    enabled: cfg.enabled,
    basis: i.bases.five_hour.basis,
    tripped,
    consented: cfg.enabled && tripped && split.gating.length === 0 && split.open.length === 0,
    open: cfg.enabled && tripped && split.gating.length === 0 && split.open.length > 0,
    stopped: stop !== undefined,
    asking: question !== undefined && !question.silent,
    told: tripped && toldKeys.size > 0,
    attended: i.attended,
  })
  return {
    cfg,
    now: i.now,
    bases: { five_hour: i.bases.five_hour.basis, seven_day: i.bases.seven_day.basis },
    kinds: i.kinds,
    tripped,
    attended: i.attended,
    open: split.open,
    gating: split.gating,
    consent: split.consent,
    ended: split.ended,
    ...(stop === undefined ? {} : { stop }),
    ...(question === undefined ? {} : { question }),
    toldCount: toldKeys.size,
    phase,
  }
}

/** The reset of an open kind (an open kind always has one). */
export const resetOf = (k: KindSense): number => (k.basis.kind === 'none' ? Number.POSITIVE_INFINITY : (k.basis.resetsAtMs ?? Number.POSITIVE_INFINITY))

/**
 * 2.6: the clock at which a stop or an open question continues by itself. A skip stop shows its end in
 * both autoResume modes. The open row: the earliest reset among the open kinds, the reserve lost first.
 * Floor 2.6: the consented row names the end point now of the covered, not open kind nearest to it.
 */
export function untilOf(p: Seen): { until?: string; to?: string } {
  if (p.phase === 'consented') {
    let best: { d: number; to: number } | undefined
    for (const k of p.kinds) {
      const c = p.consent[k.kind]
      if (!k.tripped || k.open || c?.to === undefined) continue
      const end = endOf(c.to, k.point)
      const d = end - (pctOf(k.basis) ?? 0)
      if (best === undefined || d < best.d) best = { d, to: end }
    }
    return best === undefined ? {} : { to: fmtPct(best.to) }
  }
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

/** R13, B30: a consent value that lies beyond the window of its kind is ignored, and the report says so. */
export function consentBeyond(k: KindSense, raw: string | undefined, now: number): string | undefined {
  const c = parseConsent(raw)
  if (raw === undefined || c === undefined) return undefined
  const bound = k.basis.kind === 'none' ? now + windowMs(k.kind) + 60_000 : k.windowEnd + 60_000
  return c.until > bound ? consentWarning(raw, k.kind) : undefined
}

/**
 * 2.7: the report's input from the view. `childPolicy`: the unattended policy that children get.
 * `warnings`: every warning the report lists. `tickerStale`: the reset clock is wanted and its last step
 * is more than 90 s old.
 */
export function statusInput(p: Seen, i: { childPolicy: string; warnings: string[]; tickerStale: boolean }): StatusInput {
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
  // Floor 2.7: the consent rows name the end point now of a consent to the floor, or where one ended.
  const rowOf = (kind: Kind): { consentUntil?: number; consentTo?: number; consentEnded?: boolean } => {
    const k = p.kinds.find((x) => x.kind === kind)
    const point = k?.point ?? null
    const c = p.consent[kind]
    if (c !== undefined) return { consentUntil: c.until, ...(c.to === undefined ? {} : { consentTo: endOf(c.to, point) }) }
    const e = p.ended[kind]
    return e?.to === undefined || k === undefined || !k.tripped || k.open ? {} : { consentTo: endOf(e.to, point), consentEnded: true }
  }
  const consented = p.kinds.filter((k) => k.tripped && !k.open && p.consent[k.kind] !== undefined)
  const consentedFacts = factsFrom(
    consented,
    p.now,
    false,
    consentEnd(consented.map((k) => ({ k, c: p.consent[k.kind] ?? { until: 0 } }))),
  )
  return {
    phase: p.phase,
    mode: modeOf(p.cfg),
    reserve: p.cfg.reserve,
    reserveFrom: p.cfg.from.reserve,
    pausePrompt: p.cfg.pausePrompt,
    attended: p.attended,
    headless: p.cfg.headless,
    headlessFrom: p.cfg.from.headless,
    childPolicy: i.childPolicy,
    enabled: p.cfg.enabled,
    enabledFrom: p.cfg.from.enabled,
    scope: p.cfg.scope,
    basis: five,
    ...(five.kind === 'none' ? {} : { facts: factsOf(five, p.cfg.reserve) }),
    now: p.now,
    ...rowOf('five_hour'),
    toldCount: p.toldCount,
    warnings: i.warnings,
    weekly: {
      reserve: p.cfg.weeklyReserve,
      from: p.cfg.from.weeklyReserve,
      basis: week,
      ...rowOf('seven_day'),
    },
    autoResume: { on: p.cfg.autoResume, from: p.cfg.from.autoResume },
    ...(at === undefined ? {} : { at }),
    ...(st === undefined ? {} : { work: st.work === true, autoStop: st.auto === true && p.cfg.autoResume, skipStop: st.skip === true }),
    tickerStale: i.tickerStale,
    // The spans of the host that runs the report: a command runs in the newest copy, so they are the spans in force (skip 2.7).
    spans: {
      lastMinutes: p.cfg.lastMinutes,
      lastMinutesFrom: p.cfg.from.lastMinutes,
      weeklyLastHours: p.cfg.weeklyLastHours,
      weeklyLastHoursFrom: p.cfg.from.weeklyLastHours,
    },
    // The open kinds, only while no kind gates: the asking line then says that new work goes on, and a
    // window that still gates would hold that new work.
    ...(p.open.length === 0 || p.gating.length > 0 ? {} : { open: factsFrom(p.open, p.now) }),
    floors: {
      resumeFloor: p.cfg.resumeFloor,
      resumeFloorFrom: p.cfg.from.resumeFloor,
      weeklyResumeFloor: p.cfg.weeklyResumeFloor,
      weeklyResumeFloorFrom: p.cfg.from.weeklyResumeFloor,
    },
    ...(consentedFacts.length === 0 ? {} : { consented: consentedFacts }),
  }
}
