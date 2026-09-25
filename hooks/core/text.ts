import type { Headless, Scope, Source, SpanSource } from './config.ts'
import type { Mode, Phase } from './decide.ts'
import type { Basis, Kind } from './reading.ts'

// Every user-facing and model-facing string (design section 2), verbatim. No $ here.
// Every text function takes the time zone through Facts.timeZone (the kit ignores TZ).
//
// The engine puts `spare10: ` in front of each transcript line ($.ui.log without `to`) and of each
// command.run reply (live check LC1, defect D1). So a notice, a warning or a reply never starts with
// `spare10: ` here. Texts the engine does not prefix keep it: model texts (STOP, PAUSED, HEADLESS, the
// pause instruction, the resume note), the drop reasons of prompt.submit, and debug lines.

export const VERSION: string = '0.2.0' // keep equal to .claude-plugin/plugin.json
export const HEADER: string = 'spare10'
export const QUESTION_OPTIONS: readonly [string, string] = ['Stop here', 'Resume']
export const RESUME_LABEL: string = 'Resume'
export const COMMAND_DESCRIPTION: string = 'Show the spare10 quota breaker, or resume or stop at the reserve.'
export const ARGUMENT_HINT: string = '[resume|stop]'
export const STOP_GENERIC: string = 'spare10: stopped at the quota reserve. Stop now and wait for the user. Do not call any further tools.'
export const NOT_STARTED_GENERIC: string = 'spare10: not started. spare10 could not ask you. Send the prompt again, or run /spare10 resume.'
export const HEADLESS_GENERIC: string = 'spare10 stopped this unattended run at the quota reserve. No further model requests were sent.'
export const W_FLAG: string =
  'function hooks are on only in this shell. Background sessions and pane teammates start without spare10. Put CLAUDE_CODE_ENABLE_FUNCTION_HOOKS in the env block of ~/.claude/settings.json.'

/**
 * The figures of one kind. No `kind`: five_hour. `now` feeds the date rule of a weekly clock (2.1).
 * `holdEnd`: the hold end when it is not the reset (3.1): a reading without a reset time, or a skip
 * start that is still ahead (skip 2.1), for {at}. `span`: the kind's span in ms, set only when a text
 * may name {lead} or {span} (a skip owner). `test`: a test reading, for {soon} and {lead}.
 */
export type Facts = {
  used: number
  left: number
  resetsAtMs: number | null
  reserve: number
  timeZone?: string
  kind?: Kind
  now?: number
  holdEnd?: number
  span?: number
  test?: boolean
}

/** A window that reset or ended, for {reset}. */
export type Named = { kind: Kind; test: boolean }

/** Which kinds of a question or a stop reset, and which are open now (skip 4.4). */
export type Ended = { reset: readonly Named[]; open: readonly Facts[] }

const round1 = (n: number): number => Math.round(n * 10) / 10

/** The figures of a basis that applies. A 'none' basis gives zero used and no reset. */
export function factsOf(b: Basis, reserve: number, timeZone?: string, kind?: Kind, now?: number): Facts {
  const used = b.kind === 'none' ? 0 : round1(b.pct)
  const weekly = kind === 'seven_day'
  return {
    used,
    left: round1(Math.max(0, 100 - used)),
    resetsAtMs: b.kind === 'none' ? null : b.resetsAtMs,
    reserve,
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(weekly ? { kind } : {}),
    ...(weekly && now !== undefined ? { now } : {}),
  }
}

/** 91 is '91', 91.5 is '91.5', 91.54 is '91.5'. */
export const fmtPct = (n: number): string => String(round1(n) + 0)

const part = (ms: number, opts: Intl.DateTimeFormatOptions, timeZone?: string): string =>
  new Intl.DateTimeFormat('en-GB', { ...opts, ...(timeZone === undefined ? {} : { timeZone }) }).format(new Date(ms))

/** HH:MM, 24-hour, in the given zone (local time when none). */
export function formatClock(ms: number, timeZone?: string): string {
  return part(ms, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, timeZone)
}

const DAY_MS = 86_400_000
// A fixed table: en-GB says 'Sept' in some runtimes and 'Sep' in others.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * {clock} (2.1): 'HH:MM' for the 5-hour window. 'ddd HH:MM' for the weekly window, and 'ddd D MMM HH:MM'
 * more than 6 days after now. Separate formatters, so no locale punctuation gets in.
 */
export function clockText(ms: number, kind: Kind, timeZone?: string, now?: number): string {
  const clock = formatClock(ms, timeZone)
  if (kind !== 'seven_day') return clock
  const weekday = part(ms, { weekday: 'short' }, timeZone)
  if (now === undefined || ms - now <= 6 * DAY_MS) return `${weekday} ${clock}`
  const month = MONTHS[Number(part(ms, { month: 'numeric' }, timeZone)) - 1] ?? ''
  return `${weekday} ${part(ms, { day: 'numeric' }, timeZone)} ${month} ${clock}`
}

/** '3 d 21 h', '2 h 14 min', '14 min' or 'under 1 min'. */
export function fmtDuration(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000)
  if (min < 1) return 'under 1 min'
  if (min < 60) return `${min} min`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} h ${min % 60} min`
  return `${Math.floor(hours / 24)} d ${hours % 24} h`
}

/** {at}: the clock of a hold end, with the weekday form when the kinds name the weekly window. */
export const atText = (ms: number, kinds: readonly Kind[], timeZone?: string, now?: number): string =>
  clockText(ms, kinds.includes('seven_day') ? 'seven_day' : 'five_hour', timeZone, now)

const oneReset = (n: Named): string => {
  if (n.kind === 'seven_day') return n.test ? 'the weekly test window ended' : 'the weekly window reset'
  return n.test ? 'the test window ended' : 'the 5-hour window reset'
}

const cap = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** {reset}, five_hour first. No window named: the 5-hour window (a 0.1 stop). */
export function resetText(named: readonly Named[], capital = false): string {
  const five = named.find((n) => n.kind === 'five_hour')
  const week = named.find((n) => n.kind === 'seven_day')
  let text: string
  if (five === undefined || week === undefined) text = oneReset(five ?? week ?? { kind: 'five_hour', test: false })
  else if (five.test && week.test) text = 'the test windows ended'
  else if (!five.test && !week.test) text = 'the 5-hour and weekly windows reset'
  else text = `${oneReset(five)} and ${oneReset(week)}`
  return capital ? cap(text) : text
}

/** The armed detail: 'spare10 steps in at 90% used.', with the weekly trip point when it is watched. */
export const stepsIn = (reserve: number, weeklyReserve?: number): string =>
  weeklyReserve === undefined || weeklyReserve <= 0
    ? `spare10 steps in at ${fmtPct(100 - reserve)}% used.`
    : `spare10 steps in at ${fmtPct(100 - reserve)}% used, or at ${fmtPct(100 - weeklyReserve)}% used of the weekly window.`

// ---- Placeholders of 2.1. A list of Facts reads five_hour first. ----

const kindOf = (f: Facts): Kind => f.kind ?? 'five_hour'
const isWeekly = (f: Facts): boolean => kindOf(f) === 'seven_day'
const isList = (f: Facts | readonly Facts[]): f is readonly Facts[] => Array.isArray(f)
const listOf = (f: Facts | readonly Facts[]): Facts[] =>
  (isList(f) ? [...f] : [f]).sort((a, b) => Number(isWeekly(a)) - Number(isWeekly(b)))
const onlyOf = (fs: readonly Facts[]): Facts | undefined => (fs.length === 1 ? fs[0] : undefined)

const clockOf = (f: Facts): string =>
  f.resetsAtMs === null ? 'at an unknown time' : clockText(f.resetsAtMs, kindOf(f), f.timeZone, f.now)
const reserveOf = (f: Facts): string => `${fmtPct(f.reserve)}%`
const UNTIL_RESET = 'until the window resets' // only when a caller has no figures

/** {R} */
const reserveName = (f: Facts): string => `${reserveOf(f)} ${isWeekly(f) ? 'weekly reserve' : 'reserve'}`
/** {Rs} */
const yourReserves = (fs: readonly Facts[]): string => fs.map((f) => `your ${reserveName(f)}`).join(' and ')
/** {is} */
const isAre = (fs: readonly Facts[]): string => (fs.length > 1 ? 'are' : 'is')
/** {Rq} */
const quotaReserve = (fs: readonly Facts[]): string => {
  const f = onlyOf(fs)
  if (f === undefined) return 'quota reserves'
  return `${reserveOf(f)} ${isWeekly(f) ? 'weekly quota reserve' : 'quota reserve'}`
}
/** {names} */
const windowNames = (kinds: readonly Kind[]): string => {
  const five = kinds.includes('five_hour')
  const week = kinds.includes('seven_day')
  if (five && week) return '5-hour and weekly windows'
  return week ? 'weekly window' : '5-hour window'
}

const onePerson = (f: Facts): string => `${fmtPct(f.used)}% used · ${fmtPct(f.left)}% left · resets ${clockOf(f)}`

/** {pf} */
export function personFacts(f: Facts | readonly Facts[]): string {
  const fs = listOf(f)
  const one = onlyOf(fs)
  if (one !== undefined) return onePerson(one)
  return fs.map((x) => `${isWeekly(x) ? 'weekly' : '5-hour'} window ${onePerson(x)}`).join(', ')
}

const oneModel = (f: Facts): string =>
  `into your ${reserveName(f)} · ${fmtPct(f.left)}% of ${isWeekly(f) ? 'weekly quota' : 'quota'} left · resets ${clockOf(f)}`

/** {mf} */
export const modelFacts = (f: Facts | readonly Facts[]): string => listOf(f).map(oneModel).join(', and ')

/** {quiet}: 'until 14:00', 'for one hour' with no reset time, or 'until they reset (15:00 and Mon 09:00)'. */
export function untilText(f: Facts | readonly Facts[]): string {
  const fs = listOf(f)
  const one = onlyOf(fs)
  if (one !== undefined) return one.resetsAtMs === null ? 'for one hour' : `until ${clockOf(one)}`
  const clocks = fs.map((x) => (x.resetsAtMs === null ? 'an unknown time' : clockOf(x)))
  return `until they reset (${clocks.join(' and ')})`
}

/** {use} */
const useText = (fs: readonly Facts[]): string => {
  const one = onlyOf(fs)
  if (one === undefined) return `both reserves ${untilText(fs)}`
  return `${isWeekly(one) ? 'the weekly reserve' : 'the reserve'} ${untilText(one)}`
}

// ---- Skip near the reset: the placeholders of skip 2.1 ----

/** The hold end of one kind: a given hold end, else its skip start when it has a span, else its reset. */
const timeOf = (f: Facts): number | null =>
  f.holdEnd ?? (f.span !== undefined && f.resetsAtMs !== null ? f.resetsAtMs - f.span : f.resetsAtMs)

/** {span}: '20 min' for the 5-hour window, '8 h' for the weekly window. */
export function spanText(f: Facts): string {
  const ms = f.span ?? 0
  return isWeekly(f) ? `${fmtPct(ms / 3_600_000)} h` : `${fmtPct(ms / 60_000)} min`
}

/** {lead}: where a skip start lies, such as '20 min before the reset'. Undefined without a span. */
export function leadText(f: Facts): string | undefined {
  if (f.span === undefined) return undefined
  const end = isWeekly(f)
    ? f.test === true
      ? 'the weekly test window ends'
      : 'the weekly reset'
    : f.test === true
      ? 'the test window ends'
      : 'the reset'
  return `${spanText(f)} before ${end}`
}

const oneSoon = (f: Facts): string => {
  const clock = clockOf(f)
  if (isWeekly(f)) return f.test === true ? `the weekly test window ends at ${clock}` : `the weekly window resets at ${clock}`
  return f.test === true ? `the test window ends at ${clock}` : `the 5-hour window resets at ${clock}`
}

/** {soon}: when the open windows reset, five_hour first, joined with ', and '. Always the reset clock. */
export const soonText = (open: Facts | readonly Facts[]): string => listOf(open).map(oneSoon).join(', and ')

/** {event}: the windows that reset, then the open ones and their reserves. '' when both lists are empty. */
export function eventText(named: readonly Named[], open: Facts | readonly Facts[]): string {
  const fs = listOf(open)
  const parts: string[] = []
  if (named.length > 0) parts.push(resetText(named))
  if (fs.length > 0) parts.push(soonText(fs), `${yourReserves(fs)} ${isAre(fs)} open until then`)
  return parts.map((p, i) => (i === 0 ? p : cap(p))).join('. ')
}

// The D0.2 {reset} while no kind is open (4.4), else {event}.
const eventOr = (named: readonly Named[], open: readonly Facts[]): string =>
  open.length === 0 ? resetText(named) : eventText(named, open)

/** {at} of a list of Facts: the latest hold end, and the owner's {lead} when the owner has a span. */
export function whenOf(f: Facts | readonly Facts[]): { at: string; lead?: string } {
  const fs = listOf(f)
  const times = fs.map(timeOf).filter((t): t is number => t !== null)
  if (times.length === 0) return { at: 'the reset' }
  const latest = Math.max(...times)
  const at = atText(latest, fs.map(kindOf), fs[0]?.timeZone, fs.find((x) => x.now !== undefined)?.now)
  const owner = fs.find((x) => x.span !== undefined && timeOf(x) === latest)
  const lead = owner === undefined ? undefined : leadText(owner)
  return lead === undefined ? { at } : { at, lead }
}

/**
 * {at} of a stop's until, and the {lead} of the kind whose skip start it is. The lead only when `skip`
 * (a skip owner) and a kind with a span has its skip start at `ms`.
 */
export function untilFor(
  f: Facts | readonly Facts[],
  ms: number,
  kinds: readonly Kind[],
  skip: boolean,
  now?: number,
): { at: string; lead?: string } {
  const fs = listOf(f)
  const at = atText(ms, kinds, fs[0]?.timeZone, now ?? fs.find((x) => x.now !== undefined)?.now)
  if (!skip) return { at }
  const owner = fs.find((x) => x.span !== undefined && x.resetsAtMs !== null && x.resetsAtMs - x.span === ms)
  const lead = owner === undefined ? undefined : leadText(owner)
  return lead === undefined ? { at } : { at, lead }
}

/** '16:20', or '16:20, 20 min before the reset' with a lead. */
export const untilPhrase = (u: { at: string; lead?: string }): string => (u.lead === undefined ? u.at : `${u.at}, ${u.lead}`)

/**
 * B2, and the tell-mode prompt wording. With `auto`, what Stop here and no answer mean (2.2). A skip
 * owner's question names where its time lies (skip 2.2), and says `at`, not `after`: there is no margin.
 */
export function questionText(f: Facts | readonly Facts[], opener: 'loop' | 'prompt', mode: Mode, auto = false): string {
  const fs = listOf(f)
  const head = `${cap(yourReserves(fs))} ${isAre(fs)} reached: ${personFacts(fs)}.`
  const ask = `Continue on ${useText(fs)}?`
  const hold = opener === 'loop' ? 'All work is on hold.' : mode === 'tell' ? 'spare10 holds your prompt.' : 'spare10 holds your prompt and any other work.'
  if (!auto) return `${head} ${hold} ${ask}`
  const { at, lead } = whenOf(fs)
  if (lead !== undefined) {
    const when = `${at}, ${lead}`
    const after =
      opener === 'loop'
        ? `If you choose Stop here or do not answer, the work waits until ${when}. Then spare10 continues it, unless a reserve is still reached.`
        : mode === 'tell'
          ? `If you do not answer, your prompt goes in at ${when}, unless a reserve is still reached. Stop here gives it back to you.`
          : `If you do not answer, all of it continues at ${when}, unless a reserve is still reached. Stop here gives your prompt back and pauses other work until ${at}.`
    return `${head} ${hold} ${ask} ${after}`
  }
  const after =
    opener === 'loop'
      ? `If you choose Stop here or do not answer, the work waits until ${at}. Then spare10 continues it, unless a reserve is still reached.`
      : mode === 'tell'
        ? `If you do not answer, your prompt goes in after ${at}, unless a reserve is still reached. Stop here gives it back to you.`
        : `If you do not answer, all of it continues after ${at}, unless a reserve is still reached. Stop here gives your prompt back and pauses other work until ${at}.`
  return `${head} ${hold} ${ask} ${after}`
}

/** B7 STOP: the deny text of a tool call. */
export const stopText = (f: Facts | readonly Facts[]): string =>
  `spare10: the user stopped work at the quota reserve (${modelFacts(f)}). Stop now and wait for the user. Do not call any further tools.`

/** B7 PAUSED: the answer of a refused model request. */
export const pausedText = (f: Facts | readonly Facts[]): string =>
  `spare10: work stopped at the quota reserve (${modelFacts(f)}). No model request was sent, so this task is not finished. Wait for the user.`

/** B15 HEADLESS. */
export const headlessText = (f: Facts | readonly Facts[], sessionId: string): string =>
  `spare10 stopped this unattended run at the quota reserve (${modelFacts(f)}). No further model requests were sent. To pick it up later: claude --resume ${sessionId}`

/** B12: spare10's template. Without user text there is no User instructions paragraph. */
export function pauseInstruction(f: Facts | readonly Facts[], pausePrompt: string | null): string {
  const head =
    `spare10 budget guard. You have reached the safe usage limit for this session (${modelFacts(f)}). ` +
    'Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.'
  return pausePrompt === null || pausePrompt.trim() === '' ? head : `${head}\n\nUser instructions: ${pausePrompt}`
}

/** B9: the hidden context of a resumed prompt in a stopped session. */
export function resumeContext(f: Facts | readonly Facts[]): string {
  const fs = listOf(f)
  return `spare10: earlier work stopped at the ${quotaReserve(fs)}. The user now chose to continue on ${useText(fs)}. Follow their message.`
}

/** B10: the reason of a dropped prompt. */
export function notStarted(f: Facts | readonly Facts[]): string {
  const fs = listOf(f)
  return `spare10: not started. This session is inside ${yourReserves(fs)} ${untilText(fs)}. Send the prompt again to be asked again, or run /spare10 resume.`
}

/** B35: the hidden context of a person prompt that ends a stop with work after the reset, or after the reserve opened. */
export function resetContext(named: readonly Named[], open: readonly Facts[] = []): string {
  const tail = "The stopped task is not finished. After the user's message, continue it unless the user says otherwise."
  if (open.length === 0) return `spare10: earlier work stopped at the quota reserve. ${resetText(named, true)} since then, so the stop is over. ${tail}`
  return `spare10: earlier work stopped at the quota reserve. ${cap(eventText(named, open))}, so the stop is over. ${tail}`
}

const RESUME_TAIL =
  'Continue the task from the point where it stopped. A subagent whose result says "spare10: work stopped" or "spare10: the user stopped work" did not finish. ' +
  'Run it again if you still need its result.'

/** B34: the plugin prompt at the reset, or when the reserve opens. The engine frames it, so it has no prefix. */
export function resumePrompt(named: readonly Named[], open: readonly Facts[] = []): string {
  if (open.length === 0) {
    return `${resetText(named, true)}, so the stop at the quota reserve is over. spare10 is set to continue the work at the reset, so do not wait for the user. ${RESUME_TAIL}`
  }
  return `${cap(eventText(named, open))}, so the stop at the quota reserve is over. spare10 is set to continue the work when the reserve opens, so do not wait for the user. ${RESUME_TAIL}`
}

/** The deny that withdraws this copy's dialog. */
export const withdrawnText = (outcome: string | undefined): string => `spare10: withdrawn (${outcome ?? 'closed'})`

/** B27 */
export function badWarning(
  name:
    | 'SPARE10_RESERVE'
    | 'SPARE10_WEEKLY_RESERVE'
    | 'SPARE10_LAST_MINUTES'
    | 'SPARE10_WEEKLY_LAST_HOURS'
    | 'SPARE10_AUTO_RESUME'
    | 'SPARE10_HEADLESS'
    | 'SPARE10',
  raw: string,
  used: string,
): string {
  if (name === 'SPARE10_RESERVE') return `SPARE10_RESERVE="${raw}" is not 1 to 99. spare10 uses ${used}.`
  if (name === 'SPARE10_WEEKLY_RESERVE') return `SPARE10_WEEKLY_RESERVE="${raw}" is not 0 or 1 to 99. spare10 uses ${used}.`
  if (name === 'SPARE10_LAST_MINUTES') return `SPARE10_LAST_MINUTES="${raw}" is not 0 to 299. spare10 uses ${used}.`
  if (name === 'SPARE10_WEEKLY_LAST_HOURS') return `SPARE10_WEEKLY_LAST_HOURS="${raw}" is not 0 to 167. spare10 uses ${used}.`
  if (name === 'SPARE10_AUTO_RESUME') return `SPARE10_AUTO_RESUME="${raw}" is not on or off. spare10 uses ${used}.`
  if (name === 'SPARE10_HEADLESS') return `SPARE10_HEADLESS="${raw}" is not off, prompt, stop or wait. spare10 uses ${used}.`
  return `SPARE10="${raw}" is not on or off. spare10 uses the scope option (${used}).`
}

/** B29 */
export const timeoutWarning = (name: string, auto = false): string =>
  auto
    ? `questions here continue by themselves after a time limit (${name}). An unanswered spare10 question then counts as Stop here, and spare10 continues the work at the time that the question names.`
    : `questions here continue by themselves after a time limit (${name}). An unanswered spare10 question then counts as Stop here.`

/** B30 */
export const consentWarning = (raw: string, kind: Kind = 'five_hour'): string =>
  kind === 'seven_day'
    ? `SPARE10_WEEKLY_CONSENT="${raw}" names a time after this weekly window. spare10 ignores it.`
    : `SPARE10_CONSENT="${raw}" names a time after this 5-hour window. spare10 ignores it.`

/** B31: SPARE10 switches in a --bg session come from the daemon or a settings file (9.3). */
export const bgEnvWarning = (set: ReadonlyArray<readonly [string, string]>): string =>
  `this background session has ${set.map(([name, raw]) => `${name}=${JSON.stringify(raw)}`).join(', ')}. ` +
  'A background session gets such values from the claude daemon or a settings file, not from your terminal.'

/** A stop's time: {at}, or {at} and the owner's {lead}, and whether spare10 continues the work then. */
type AutoAt = { at: string; work: boolean; lead?: string }

/**
 * Transcript notices (B3, B4, B6, B12, 2.4). The engine prefixes them with `spare10: `. Each reset
 * notice takes an optional list of open kinds (skip 2.4): with none, it is the D0.2 text.
 */
export const notice = {
  continuing: (f: Facts | readonly Facts[]): string => {
    const fs = listOf(f)
    return `continuing on ${yourReserves(fs)}. spare10 stays quiet ${untilText(fs)}.`
  },
  newWindow: 'held work continues on the new 5-hour window.',
  newWindowFor: (kinds: readonly Kind[]): string => `held work continues on the new ${windowNames(kinds)}.`,
  stopped: (f: Facts | readonly Facts[], auto?: AutoAt): string => {
    const rs = yourReserves(listOf(f))
    const again = 'Type a prompt to be asked again, or run /spare10 resume.'
    if (auto === undefined) return `stopped at ${rs}. ${again}`
    if (!auto.work) return `stopped at ${rs} until ${untilPhrase(auto)}. ${again}`
    return `stopped at ${rs} until ${untilPhrase(auto)}. Then spare10 continues the work, unless a reserve is still reached. ${again}`
  },
  holdLimit: (f: Facts | readonly Facts[], auto?: AutoAt): string => {
    const rs = yourReserves(listOf(f))
    const again = 'Type a prompt to be asked again, or run /spare10 resume.'
    if (auto === undefined) return `the hold reached its time limit. The work is stopped at ${rs}. ${again}`
    if (!auto.work) return `the hold reached its time limit. The work is stopped at ${rs} until ${untilPhrase(auto)}. ${again}`
    return `the hold reached its time limit. The work is stopped at ${rs} until ${untilPhrase(auto)}. Then spare10 continues it, unless a reserve is still reached.`
  },
  /** B46: Stop here after the skip start. soon: the next tick continues the work. Else nothing is stopped. */
  stoppedLate: (f: Facts | readonly Facts[], e: Ended, soon: boolean): string => {
    const ev = cap(eventText(e.reset, e.open))
    if (soon) return `stopped at ${yourReserves(listOf(f))}. ${ev}, so spare10 continues the work soon, unless a reserve is still reached.`
    return `stopped. Held work is refused. ${ev}, so new work goes on with no question.`
  },
  /** B46 through the B40 time limit. */
  holdLimitLate: (f: Facts | readonly Facts[], e: Ended, soon: boolean): string => {
    const ev = cap(eventText(e.reset, e.open))
    if (soon) {
      return `the hold reached its time limit. The work is stopped at ${yourReserves(listOf(f))}. ${ev}, so spare10 continues it soon, unless a reserve is still reached.`
    }
    return `the hold reached its time limit. Held work is refused. ${ev}, so new work goes on with no question.`
  },
  resetWaiting: 'the 5-hour window reset. Held work still waits for your answer.',
  /** `newWork`: no kind gates now, so new work goes on. False while another window still holds new work. */
  resetWaitingFor: (named: readonly Named[], open: readonly Facts[] = [], newWork = open.length > 0): string =>
    open.length === 0
      ? `${resetText(named)}. Held work still waits for your answer.`
      : `${eventText(named, open)}, but held work still waits for your answer.${newWork ? ' New work goes on with no question.' : ''}`,
  told: (f: Facts | readonly Facts[]): string => {
    const fs = listOf(f)
    return `${yourReserves(fs)} ${isAre(fs)} reached. spare10 told the agents to wind down.`
  },
  resetContinues: (named: readonly Named[], open: readonly Facts[] = []): string => `${eventOr(named, open)}. Held work continues.`,
  resetStillHeld: (named: readonly Named[], still: readonly Facts[], open: readonly Facts[] = []): string => {
    const fs = listOf(still)
    const tail = `${yourReserves(fs)} ${isAre(fs)} reached. Held work still waits.`
    return named.length === 0 && open.length === 0 ? tail : `${eventOr(named, open)}, but ${tail}`
  },
  outOfReserve: 'the quota is no longer in the reserve. Held work continues.',
  resetResumes: (named: readonly Named[], open: readonly Facts[] = []): string => `${eventOr(named, open)}. spare10 continues the stopped work.`,
  resetStopOver: (named: readonly Named[], open: readonly Facts[] = []): string =>
    `${eventOr(named, open)}, and the stop is over. Type a prompt to continue.`,
  stopTakenOver: (named: readonly Named[], open: readonly Facts[] = []): string =>
    named.length === 0 && open.length === 0 ? 'the stop is over.' : `${eventOr(named, open)}, and the stop is over.`,
  stopExtended: (named: readonly Named[], still: readonly Facts[], at: string, open: readonly Facts[] = []): string => {
    const fs = listOf(still)
    const tail = `${yourReserves(fs)} ${isAre(fs)} reached. The stop lasts until ${at}.`
    return named.length === 0 && open.length === 0 ? tail : `${eventOr(named, open)}, but ${tail}`
  },
  resumeFailed: (reason: string): string => `could not continue the stopped work: ${reason}. Type a prompt to continue.`,
}

/** Debug lines (B12, B15, 2.5, 4.5, 4.7, 10.9.6). The engine does not prefix them, so they keep `spare10: `. */
export const debugLine = {
  unattended: (f: Facts | readonly Facts[], policy: Headless): string =>
    `spare10: unattended run inside the reserve (${personFacts(f)}), policy ${policy}.`,
  unattendedOpen: (f: Facts | readonly Facts[]): string =>
    `spare10: unattended run inside the reserve (${personFacts(f)}), but the reset is near. spare10 lets it through.`,
  told: (key: string): string => `spare10: told ${key}`,
  handedOn: (n: number): string => `spare10: the loop that asked went away. spare10 asks again (${n}).`,
  abortFailed: (err: string): string => `spare10: turn.abort failed: ${err}`,
  droppedStop: 'spare10: a stop of another conversation ended at its reset. spare10 dropped it.',
  resumeSkipped: 'spare10: the conversation changed before the resume prompt. spare10 sent nothing.',
  boxDefer: (n: number): string => `spare10: the prompt box has text. The resume prompt waits (${n} of 10).`,
  budget: (min: number, ms: number): string => `spare10: held ${min} min. Budget left ${ms} ms.`,
  checkFailed: (err: string): string => `spare10: the reset check did not run: ${err}`,
}

export type StatusInput = {
  phase: Phase
  mode: Mode
  reserve: number
  reserveFrom: Source
  pausePrompt: string | null
  attended: boolean
  headless: Headless
  headlessFrom: Source
  childPolicy: string // live SPARE10_HEADLESS, else the option
  enabled: boolean
  enabledFrom: 'scope' | 'SPARE10'
  scope: Scope
  basis: Basis
  facts?: Facts // facts when basis is not 'none'
  now: number
  consentUntil?: number // only when it covers this window
  toldCount: number
  warnings: string[]
  timeZone?: string
  // 0.2. Every field below is optional: absent gives the 0.1 report.
  weekly?: { reserve: number; from: Source; basis: Basis; facts?: Facts; consentUntil?: number } | 'off' // reserve 0 is off too
  autoResume?: { on: boolean; from: Source }
  at?: { ms: number; kinds: readonly Kind[]; skip?: boolean } // when an open question or a stop continues. skip: a skip start ('at', not 'after')
  work?: boolean // the stop has work
  autoStop?: boolean // the stop has auto, and autoResume is on
  tickerStale?: boolean // the reset clock is wanted and its last step is more than 90 s old
  // Skip near the reset. Absent: no rows and the D0.2 lines.
  spans?: { lastMinutes: number; lastMinutesFrom: SpanSource; weeklyLastHours: number; weeklyLastHoursFrom: SpanSource }
  open?: readonly Facts[] // the open kinds: the open phase line, and the asking line
  skipStop?: boolean // the stop that applies has the skip tag
}

const GLYPH: Record<Phase, string> = {
  off: '○',
  blind: '⚠',
  waiting: '⧗',
  armed: '●',
  consented: '⨯',
  open: '↻',
  stopped: '■',
  asking: '?',
  told: '⏸',
  reserve: '⚠',
  tripped: '⚠',
}

/** D4: the phase detail and every field value start in one column: two spaces, a mark, a space, this width. */
const LABEL_WIDTH = 15

type Weekly = Exclude<StatusInput['weekly'], 'off' | undefined>

/** The weekly window when it is watched. */
const watchedWeekly = (s: StatusInput): Weekly | undefined =>
  s.weekly !== undefined && s.weekly !== 'off' && s.weekly.reserve > 0 ? s.weekly : undefined

/** The consented part of the consented phase line: {quiet} of the consented kinds. */
function quietOf(s: StatusInput): string {
  const ends: Array<[number, Kind]> = []
  if (s.consentUntil !== undefined) ends.push([s.consentUntil, 'five_hour'])
  const w = watchedWeekly(s)
  if (w?.consentUntil !== undefined) ends.push([w.consentUntil, 'seven_day'])
  const clocks = ends.map(([ms, kind]) => clockText(ms, kind, s.timeZone, s.now))
  if (clocks.length === 1) return `until ${clocks[0] ?? ''}`
  if (clocks.length > 1) return `until they reset (${clocks.join(' and ')})`
  return s.facts ? untilText(s.facts) : UNTIL_RESET
}

function phaseLine(s: StatusInput): string {
  const at = s.at === undefined ? undefined : atText(s.at.ms, s.at.kinds, s.timeZone, s.now)
  const again = 'Type a prompt to be asked again, or run /spare10 resume.'
  const open = s.open === undefined ? [] : listOf(s.open)
  const openRs = open.length === 0 ? '' : `${cap(yourReserves(open))} ${isAre(open)} open ${untilText(open)}`
  const stopped =
    at === undefined
      ? `you chose Stop here. ${again}`
      : s.skipStop === true
        ? s.work === true && s.autoStop === true
          ? `you chose Stop here. spare10 continues the work at ${at}. ${again}`
          : `you chose Stop here, until ${at}. ${again}`
        : s.autoStop !== true
          ? `you chose Stop here. ${again}`
          : s.work === true
            ? `you chose Stop here. spare10 continues the work after ${at}. ${again}`
            : `you chose Stop here, until ${at}. ${again}`
  const openNote = openRs === '' ? '' : ` ${openRs}, so new work goes on.`
  const asking =
    at === undefined || s.autoResume?.on !== true
      ? `a question is open. Held work waits until you answer.${openNote} If no dialog shows, run /spare10 resume or /spare10 stop.`
      : `a question is open. Held work waits until you answer, or until ${at}.${openNote} If no dialog shows, run /spare10 resume or /spare10 stop.`
  const detail: Record<Phase, string> = {
    off: 'spare10 only watches in this run.',
    blind: 'Claude Code reports no 5-hour quota. spare10 lets all work through.',
    waiting: 'no reading yet. spare10 lets all work through.',
    armed: stepsIn(s.reserve, watchedWeekly(s)?.reserve),
    consented: `you chose to continue. spare10 is quiet ${quietOf(s)}.`,
    open: openRs === '' ? 'the reset is near, so spare10 lets all work through.' : `the reset is near. ${openRs}, so spare10 lets all work through.`,
    stopped,
    asking,
    told: `the wind-down went to ${s.toldCount} agent(s).`,
    reserve:
      s.headless === 'wait' && at !== undefined
        ? `unattended run, policy wait. Held work continues ${s.at?.skip === true ? 'at' : 'after'} ${at}.`
        : `unattended run, policy ${s.headless}.`,
    tripped:
      s.mode === 'tell'
        ? 'spare10 tells each agent to wind down at its next step.'
        : 'spare10 holds the next step and asks you.',
  }
  const name = s.phase === 'reserve' ? 'tripped' : s.phase
  return `  ${GLYPH[s.phase]} ${name.padEnd(LABEL_WIDTH)}${detail[s.phase]}`
}

function readingValue(b: Basis, f: Facts, now: number): string {
  if (b.kind === 'none') {
    if (b.why === 'blind') return 'none: Claude Code reports no quota (blind)'
    return b.why === 'window-reset' ? 'none: the window reset' : 'none: no reading yet'
  }
  const src = b.kind === 'live' ? 'live' : b.kind === 'seed' ? 'seed from another session' : 'test reading'
  // D2: {pf} already says `resets HH:MM`, so the time left is in brackets, not a second `resets`.
  const left = b.resetsAtMs === null ? '' : ` (in ${fmtDuration(b.resetsAtMs - now)})`
  return `${src} · ${personFacts(f)}${left}`
}

function guardedValue(s: StatusInput): string {
  if (!s.enabled) {
    return s.enabledFrom === 'SPARE10' ? 'no: SPARE10=off. spare10 only watches.' : 'no: scope opt-in. Start with SPARE10=on to guard a run.'
  }
  if (!s.attended) return 'no: this session is unattended.'
  return s.enabledFrom === 'SPARE10' ? 'yes (SPARE10=on)' : 'yes (scope all)'
}

function actionValue(s: StatusInput): string {
  if (!s.attended) return `unattended policy ${s.headless}`
  return s.mode === 'tell' ? `tell every agent: ${JSON.stringify(s.pausePrompt ?? '')}` : 'stop and ask you'
}

const field = (label: string, value: string): string => `  · ${label.padEnd(LABEL_WIDTH)}${value}`
const fromText = (from: Source, env: string): string => (from === 'env' ? `from ${env}` : 'from /config')
const spanFrom = (from: SpanSource, env: string): string => (from === 'unread' ? 'spare10 could not read the env' : fromText(from, env))

/** Skip 2.7: the `reserve opens` row, and the `weekly opens` row while the weekly window is watched. */
function spanRows(s: StatusInput): string[] {
  const sp = s.spans
  if (sp === undefined) return []
  const five =
    sp.lastMinutes > 0
      ? `in the last ${fmtPct(sp.lastMinutes)} min of the 5-hour window (${spanFrom(sp.lastMinutesFrom, 'SPARE10_LAST_MINUTES')})`
      : `only at the reset (${spanFrom(sp.lastMinutesFrom, 'SPARE10_LAST_MINUTES')})`
  const rows = [field('reserve opens', five)]
  if (watchedWeekly(s) !== undefined) {
    const week =
      sp.weeklyLastHours > 0
        ? `in the last ${fmtPct(sp.weeklyLastHours)} h of the weekly window (${spanFrom(sp.weeklyLastHoursFrom, 'SPARE10_WEEKLY_LAST_HOURS')})`
        : `only at the reset (${spanFrom(sp.weeklyLastHoursFrom, 'SPARE10_WEEKLY_LAST_HOURS')})`
    rows.push(field('weekly opens', week))
  }
  return rows
}

/** 2.7: the weekly rows, or the one off row, or nothing for a 0.1 input. */
function weeklyRows(s: StatusInput): { reserve: string[]; reading: string[]; consent: string[] } {
  const none = { reserve: [], reading: [], consent: [] }
  if (s.weekly === undefined) return none
  const w = watchedWeekly(s)
  if (w === undefined) {
    const from = s.weekly === 'off' ? 'option' : s.weekly.from
    return { ...none, reserve: [field('weekly reserve', `off. spare10 does not watch the weekly window (${fromText(from, 'SPARE10_WEEKLY_RESERVE')})`)] }
  }
  const f = w.facts ?? factsOf(w.basis, w.reserve, s.timeZone, 'seven_day', s.now)
  const consent =
    w.consentUntil === undefined ? 'none' : `until ${clockText(w.consentUntil, 'seven_day', s.timeZone, s.now)} (you chose to continue)`
  return {
    reserve: [field('weekly reserve', `${fmtPct(w.reserve)}% of the weekly window (${fromText(w.from, 'SPARE10_WEEKLY_RESERVE')})`)],
    reading: [field('weekly reading', readingValue(w.basis, f, s.now))],
    consent: [field('weekly consent', consent)],
  }
}

// The warning of 2.7 when the reset clock does not run.
const TICKER_WARNING = 'spare10 cannot check the reset in this session. Type a prompt to continue after the reset.'

/**
 * B22: what /spare10 prints. The engine puts `spare10: ` in front of the reply, so the first line
 * reads `spare10: version 0.2.0` (a deviation from B22's `spare10 {VERSION}`, defect D1).
 */
export function statusReport(s: StatusInput): string {
  const consent = s.consentUntil === undefined ? 'none' : `until ${formatClock(s.consentUntil, s.timeZone)} (you chose to continue)`
  const weekly = weeklyRows(s)
  const atReset =
    s.autoResume === undefined || !s.attended
      ? []
      : [field('at the reset', `${s.autoResume.on ? 'continue by itself' : 'wait for your answer'} (${fromText(s.autoResume.from, 'SPARE10_AUTO_RESUME')})`)]
  const lines = [
    `version ${VERSION}`,
    '',
    phaseLine(s),
    field('reserve', `${fmtPct(s.reserve)}% of the 5-hour window (${fromText(s.reserveFrom, 'SPARE10_RESERVE')})`),
    ...weekly.reserve,
    ...spanRows(s),
    field('at the reserve', actionValue(s)),
    ...atReset,
    field('reading', readingValue(s.basis, s.facts ?? factsOf(s.basis, s.reserve, s.timeZone), s.now)),
    ...weekly.reading,
    field('consent', consent),
    ...weekly.consent,
    field('guarded', guardedValue(s)),
    s.attended
      ? field('claude -p', `runs started here: ${s.childPolicy}`)
      : field('unattended', `${s.headless} (${fromText(s.headlessFrom, 'SPARE10_HEADLESS')})`),
    ...(s.tickerStale === true ? [`  ⚠ ${TICKER_WARNING}`] : []),
    ...s.warnings.map((w) => `  ⚠ ${w}`),
    '',
    '/spare10 resume   continue on the reserve until the window resets',
    '/spare10 stop     stop at the reserve now',
  ]
  return lines.join('\n')
}

export type ReplyCase = 'asking' | 'stopped' | 'tripped' | 'consented' | 'below' | 'none' | 'off'

// The replies of /spare10 (B23 to B26, 12.1, 2.8). The engine prefixes each reply with `spare10: `.

/** {Rs} {is} open {quiet} of the open kinds, for the open replies (skip 2.8). */
const openText = (fs: readonly Facts[]): string =>
  fs.length === 0 ? 'the reserve is open' : `${yourReserves(fs)} ${isAre(fs)} open ${untilText(fs)}`

/**
 * B23 ('tripped' is "tripped, not stopped"). 'overdue': a stop past its end that nobody released yet,
 * with the windows that reset and the open ones. 'open': no kind gates and some kind is open (`f`: the
 * open kinds).
 */
export function resumeReply(
  c: ReplyCase | 'overdue' | 'open',
  f?: Facts | readonly Facts[],
  named?: readonly Named[],
  open?: readonly Facts[],
): string {
  const fs = f === undefined ? [] : listOf(f)
  const use = fs.length === 0 ? `the reserve ${UNTIL_RESET}` : useText(fs)
  switch (c) {
    case 'asking':
      return `resumed. Held work continues on ${use}.`
    case 'stopped':
      return `resumed. You can use ${use}. Type a prompt to continue.`
    case 'overdue': {
      const ev = eventText(named ?? [], open ?? [])
      return ev === '' ? 'the stop is over. Type a prompt to continue.' : `${ev}, and the stop is over. Type a prompt to continue.`
    }
    case 'open':
      return `nothing to resume. The reset is near, so ${openText(fs)}.`
    case 'tripped':
      return `you can use ${use}.`
    case 'consented':
      return `already resumed ${fs.length === 0 ? UNTIL_RESET : untilText(fs)}.`
    case 'below':
      if (fs.length > 0) return `nothing to resume. ${personFacts(fs)}.`
      return 'nothing to resume. There is no 5-hour reading yet.'
    case 'none':
      return 'nothing to resume. There is no 5-hour reading yet.'
    case 'off':
      return 'this run is not guarded. Nothing changed.'
  }
}

/**
 * B24 ('tripped' covers consented). `auto`: the time the stop ends, {at} and for a skip owner {lead}.
 * `continues` (default true): autoResume is on, so spare10 continues the stopped work then.
 * `weeklyTrip`: the weekly window is watched. `ended`: the windows of a Stop here after the skip start
 * (B46). 'open' and 'overdue-open' take the open kinds as `f`.
 */
export function stopReply(
  c:
    | Exclude<ReplyCase, 'consented'>
    | 'overdue'
    | 'overdue-open'
    | 'overdue-skip'
    | 'open'
    | 'asking-soon'
    | 'asking-open',
  f?: Facts | readonly Facts[],
  trip?: number,
  auto?: { at: string; lead?: string; continues?: boolean },
  weeklyTrip?: number,
  ended?: Ended,
): string {
  const again = 'Type a prompt to be asked again, or run /spare10 resume.'
  const fs = f === undefined ? [] : listOf(f)
  const ev = cap(eventText(ended?.reset ?? [], ended?.open ?? []))
  switch (c) {
    case 'asking':
      if (auto === undefined) return 'stopped. Held work is refused.'
      return auto.lead === undefined
        ? `stopped. Held work is refused. spare10 continues it after ${auto.at}.`
        : `stopped. Held work is refused. spare10 continues it at ${untilPhrase(auto)}.`
    case 'asking-soon':
      return `stopped. Held work is refused. ${ev}, so spare10 continues it soon, unless a reserve is still reached.`
    case 'asking-open':
      return `stopped. Held work is refused. ${ev}, so new work goes on with no question.`
    case 'tripped':
      if (auto === undefined) return `stopped at the reserve. ${again}`
      return auto.continues === false
        ? `stopped at the reserve until ${untilPhrase(auto)}. ${again}`
        : `stopped at the reserve until ${untilPhrase(auto)}. Then spare10 continues any stopped work. ${again}`
    case 'stopped':
      return auto === undefined ? 'already stopped.' : `already stopped until ${auto.at}.`
    case 'overdue':
      return 'the stop ended at the reset. spare10 will not continue the stopped work.'
    case 'overdue-open':
      return `the stop is over, because the reset is near. ${cap(openText(fs))}. spare10 will not continue the stopped work.`
    case 'overdue-skip':
      return 'the stop is over. spare10 will not continue the stopped work.'
    case 'open':
      return `nothing to stop. The reset is near, so ${openText(fs)}. To keep a reserve until the reset, set its Open reserve option to 0 in /config.`
    case 'below':
    case 'none': {
      const at = fmtPct(trip ?? 100 - ((f === undefined ? undefined : listOf(f)[0])?.reserve ?? 10))
      if (weeklyTrip === undefined) return `nothing to stop. spare10 steps in at ${at}% used.`
      return `nothing to stop. spare10 steps in at ${at}% used, or at ${fmtPct(weeklyTrip)}% used of the weekly window.`
    }
    case 'off':
      return 'this run is not guarded. Nothing changed.'
  }
}

/** B25 */
export const notPerson = (verb: string): string => `only you can run /spare10 ${verb}. Nothing changed.`

/** B25 */
export const unknownVerb = (verb: string): string =>
  `unknown command "${verb}". Use /spare10, /spare10 resume or /spare10 stop.`

/**
 * Section 12.1, 2.9. `opens` (skip 2.9), for a test reading at or above the trip point with a span:
 * when its reserve opens ({at} and {lead}), 'now' when it is open at once (`f.span` gives {span}), or
 * 'real' when the real reading beneath is in the reserve too and keeps the hold (B45).
 */
export function simulateReply(kind: 'set' | 'off' | 'bad' | 'weekly-off', f?: Facts, opens?: { at: string; lead: string } | 'now' | 'real'): string {
  if (kind === 'off') return 'test reading cleared. Consent and stop for this window are cleared too.'
  if (kind === 'weekly-off') return 'the weekly reserve is 0, so spare10 does not watch the weekly window. Nothing changed.'
  if (kind === 'bad' || f === undefined) {
    return '/spare10 simulate takes a percentage from 0 to 100, or off. Add weekly for the weekly window, and in 22m for a test window that resets in 22 minutes.'
  }
  const weekly = isWeekly(f)
  const of = weekly ? ' of the weekly window' : ''
  let opensText = ''
  if (opens === 'real') {
    opensText = weekly
      ? ' The real weekly reading is also in the weekly reserve, so the weekly test window does not open it.'
      : ' The real reading is also in the reserve, so the test window does not open it.'
  } else if (opens === 'now') {
    opensText = weekly
      ? ` The weekly test window ends within ${spanText(f)}, so the weekly reserve is open at once.`
      : ` The test window ends within ${spanText(f)}, so the reserve is open at once.`
  } else if (opens !== undefined) {
    opensText = ` The ${weekly ? 'weekly reserve' : 'reserve'} opens at ${opens.at}, ${opens.lead}.`
  }
  return `test reading set to ${fmtPct(f.used)}% used${of}, resets ${clockOf(f)}. It can only raise the real reading.${opensText} Run /spare10 simulate off to clear it.`
}

/** A /spare10 that threw. */
export const commandFailed = (message: string): string => `/spare10 failed: ${message}`
