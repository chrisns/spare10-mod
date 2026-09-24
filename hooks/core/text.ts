import type { Headless, Scope, Source } from './config.ts'
import type { Mode, Phase } from './decide.ts'
import type { Basis } from './reading.ts'

// Every user-facing and model-facing string (design section 2), verbatim. No $ here.
// Every text function takes the time zone through Facts.timeZone (the kit ignores TZ).
//
// The engine puts `spare10: ` in front of each transcript line ($.ui.log without `to`) and of each
// command.run reply (live check LC1, defect D1). So a notice, a warning or a reply never starts with
// `spare10: ` here. Texts the engine does not prefix keep it: model texts (STOP, PAUSED, HEADLESS, the
// pause instruction, the resume note), the drop reasons of prompt.submit, and debug lines.

export const VERSION: string = '0.1.0' // keep equal to .claude-plugin/plugin.json
export const HEADER: string = 'spare10'
export const QUESTION_OPTIONS: readonly [string, string] = ['Stop here', 'Resume']
export const RESUME_LABEL: string = 'Resume'
export const COMMAND_DESCRIPTION: string = 'Show the spare10 quota breaker, or resume or stop at the reserve.'
export const ARGUMENT_HINT: string = '[resume|stop]'
export const STOP_GENERIC: string = 'spare10: stopped at the quota reserve. Stop now and wait for the user. Do not call any further tools.'
export const NOT_STARTED_GENERIC: string = 'spare10: not started. spare10 could not ask you. Send the prompt again, or run /spare10 resume.'
export const W_FLAG: string =
  'function hooks are on only in this shell. Background sessions and pane teammates start without spare10. Put CLAUDE_CODE_ENABLE_FUNCTION_HOOKS in the env block of ~/.claude/settings.json.'

export type Facts = { used: number; left: number; resetsAtMs: number | null; reserve: number; timeZone?: string }

const round1 = (n: number): number => Math.round(n * 10) / 10

/** The figures of a basis that applies. A 'none' basis gives zero used and no reset. */
export function factsOf(b: Basis, reserve: number, timeZone?: string): Facts {
  const used = b.kind === 'none' ? 0 : round1(b.pct)
  return {
    used,
    left: round1(Math.max(0, 100 - used)),
    resetsAtMs: b.kind === 'none' ? null : b.resetsAtMs,
    reserve,
    ...(timeZone === undefined ? {} : { timeZone }),
  }
}

/** 91 is '91', 91.5 is '91.5', 91.54 is '91.5'. */
export const fmtPct = (n: number): string => String(round1(n) + 0)

/** HH:MM, 24-hour, in the given zone (local time when none). */
export function formatClock(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(ms))
}

/** '2 h 14 min', '14 min' or 'under 1 min'. */
export function fmtDuration(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000)
  if (min < 1) return 'under 1 min'
  if (min < 60) return `${min} min`
  return `${Math.floor(min / 60)} h ${min % 60} min`
}

const clockOf = (f: Facts): string => (f.resetsAtMs === null ? 'at an unknown time' : formatClock(f.resetsAtMs, f.timeZone))
const reserveOf = (f: Facts): string => `${fmtPct(f.reserve)}%`
const UNTIL_RESET = 'until the window resets' // only when a caller has no figures

/** {pf} */
export const personFacts = (f: Facts): string => `${fmtPct(f.used)}% used · ${fmtPct(f.left)}% left · resets ${clockOf(f)}`

/** {mf} */
export const modelFacts = (f: Facts): string =>
  `into your ${reserveOf(f)} reserve · ${fmtPct(f.left)}% of quota left · resets ${clockOf(f)}`

/** {until}: 'until 14:00', or 'for one hour' with no reset time. */
export const untilText = (f: Facts): string =>
  f.resetsAtMs === null ? 'for one hour' : `until ${formatClock(f.resetsAtMs, f.timeZone)}`

/** B2, and the tell-mode prompt wording. */
export function questionText(f: Facts, opener: 'loop' | 'prompt', mode: Mode): string {
  const head = `Your ${reserveOf(f)} reserve is reached: ${personFacts(f)}.`
  const ask = `Continue on the reserve ${untilText(f)}?`
  if (opener === 'loop') return `${head} All work is on hold. ${ask}`
  if (mode === 'tell') return `${head} spare10 holds your prompt. ${ask}`
  return `${head} spare10 holds your prompt and any other work. ${ask}`
}

/** B7 STOP: the deny text of a tool call. */
export const stopText = (f: Facts): string =>
  `spare10: the user stopped work at the quota reserve (${modelFacts(f)}). Stop now and wait for the user. Do not call any further tools.`

/** B7 PAUSED: the answer of a refused model request. */
export const pausedText = (f: Facts): string =>
  `spare10: work stopped at the quota reserve (${modelFacts(f)}). No model request was sent, so this task is not finished. Wait for the user.`

/** B15 HEADLESS. */
export const headlessText = (f: Facts, sessionId: string): string =>
  `spare10 stopped this unattended run at the quota reserve (${modelFacts(f)}). No further model requests were sent. To pick it up later: claude --resume ${sessionId}`

/** B12: spare10's template. Without user text there is no User instructions paragraph. */
export function pauseInstruction(f: Facts, pausePrompt: string | null): string {
  const head =
    `spare10 budget guard. You have reached the safe usage limit for this session (${modelFacts(f)}). ` +
    'Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.'
  return pausePrompt === null || pausePrompt.trim() === '' ? head : `${head}\n\nUser instructions: ${pausePrompt}`
}

/** B9: the hidden context of a resumed prompt in a stopped session. */
export const resumeContext = (f: Facts): string =>
  `spare10: earlier work stopped at the ${reserveOf(f)} quota reserve. The user now chose to continue on the reserve ${untilText(f)}. Follow their message.`

/** B10: the reason of a dropped prompt. */
export const notStarted = (f: Facts): string =>
  `spare10: not started. This session is inside your ${reserveOf(f)} reserve ${untilText(f)}. Send the prompt again to be asked again, or run /spare10 resume.`

/** The deny that withdraws this copy's dialog. */
export const withdrawnText = (outcome: string | undefined): string => `spare10: withdrawn (${outcome ?? 'closed'})`

/** B27 */
export function badWarning(name: 'SPARE10_RESERVE' | 'SPARE10_HEADLESS' | 'SPARE10', raw: string, used: string): string {
  if (name === 'SPARE10_RESERVE') return `SPARE10_RESERVE="${raw}" is not 1 to 99. spare10 uses ${used}.`
  if (name === 'SPARE10_HEADLESS') return `SPARE10_HEADLESS="${raw}" is not off, prompt or stop. spare10 uses ${used}.`
  return `SPARE10="${raw}" is not on or off. spare10 uses the scope option (${used}).`
}

/** B29 */
export const timeoutWarning = (name: string): string =>
  `questions here continue by themselves after a time limit (${name}). An unanswered spare10 question then counts as Stop here.`

/** B30 */
export const consentWarning = (raw: string): string =>
  `SPARE10_CONSENT="${raw}" names a time after this 5-hour window. spare10 ignores it.`

/** B31: SPARE10 switches in a --bg session come from the daemon or a settings file (9.3). */
export const bgEnvWarning = (set: ReadonlyArray<readonly [string, string]>): string =>
  `this background session has ${set.map(([name, raw]) => `${name}=${JSON.stringify(raw)}`).join(', ')}. ` +
  'A background session gets such values from the claude daemon or a settings file, not from your terminal.'

/** Transcript notices (B3, B4, B6, B12). The engine prefixes them with `spare10: `. */
export const notice = {
  continuing: (f: Facts): string => `continuing on your ${reserveOf(f)} reserve. spare10 stays quiet ${untilText(f)}.`,
  newWindow: 'held work continues on the new 5-hour window.',
  stopped: (f: Facts): string => `stopped at your ${reserveOf(f)} reserve. Type a prompt to be asked again, or run /spare10 resume.`,
  resetWaiting: 'the 5-hour window reset. Held work still waits for your answer.',
  told: (f: Facts): string => `your ${reserveOf(f)} reserve is reached. spare10 told the agents to wind down.`,
}

/** Debug lines (B12, B15, 4.5, 4.7, 10.9.6). The engine does not prefix them, so they keep `spare10: `. */
export const debugLine = {
  unattended: (f: Facts, policy: Headless): string =>
    `spare10: unattended run inside the reserve (${personFacts(f)}), policy ${policy}.`,
  told: (key: string): string => `spare10: told ${key}`,
  handedOn: (n: number): string => `spare10: the loop that asked went away. spare10 asks again (${n}).`,
  abortFailed: (err: string): string => `spare10: turn.abort failed: ${err}`,
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
}

const GLYPH: Record<Phase, string> = {
  off: '○',
  blind: '⚠',
  waiting: '⧗',
  armed: '●',
  consented: '⨯',
  stopped: '■',
  asking: '?',
  told: '⏸',
  reserve: '⚠',
  tripped: '⚠',
}

/** D4: the phase detail and every field value start in one column: two spaces, a mark, a space, this width. */
const LABEL_WIDTH = 15

function phaseLine(s: StatusInput): string {
  const until = s.consentUntil !== undefined ? `until ${formatClock(s.consentUntil, s.timeZone)}` : s.facts ? untilText(s.facts) : UNTIL_RESET
  const detail: Record<Phase, string> = {
    off: 'spare10 only watches in this run.',
    blind: 'Claude Code reports no 5-hour quota. spare10 lets all work through.',
    waiting: 'no reading yet. spare10 lets all work through.',
    armed: `spare10 steps in at ${fmtPct(100 - s.reserve)}% used.`,
    consented: `you chose to continue. spare10 is quiet ${until}.`,
    stopped: 'you chose Stop here. Type a prompt to be asked again, or run /spare10 resume.',
    asking: 'a question is open. Held work waits until you answer. If no dialog shows, run /spare10 resume or /spare10 stop.',
    told: `the wind-down went to ${s.toldCount} agent(s).`,
    reserve: `unattended run, policy ${s.headless}.`,
    tripped:
      s.mode === 'tell'
        ? 'spare10 tells each agent to wind down at its next step.'
        : 'spare10 holds the next step and asks you.',
  }
  const name = s.phase === 'reserve' ? 'tripped' : s.phase
  return `  ${GLYPH[s.phase]} ${name.padEnd(LABEL_WIDTH)}${detail[s.phase]}`
}

function readingValue(s: StatusInput): string {
  const b = s.basis
  if (b.kind === 'none') {
    if (b.why === 'blind') return 'none: Claude Code reports no quota (blind)'
    return b.why === 'window-reset' ? 'none: the window reset' : 'none: no reading yet'
  }
  const f = s.facts ?? factsOf(b, s.reserve, s.timeZone)
  const src = b.kind === 'live' ? 'live' : b.kind === 'seed' ? 'seed from another session' : 'test reading'
  // D2: {pf} already says `resets HH:MM`, so the time left is in brackets, not a second `resets`.
  const left = b.resetsAtMs === null ? '' : ` (in ${fmtDuration(b.resetsAtMs - s.now)})`
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

/**
 * B22: what /spare10 prints. The engine puts `spare10: ` in front of the reply, so the first line
 * reads `spare10: version 0.1.0` (a deviation from B22's `spare10 {VERSION}`, defect D1).
 */
export function statusReport(s: StatusInput): string {
  const consent = s.consentUntil === undefined ? 'none' : `until ${formatClock(s.consentUntil, s.timeZone)} (you chose to continue)`
  const lines = [
    `version ${VERSION}`,
    '',
    phaseLine(s),
    field('reserve', `${fmtPct(s.reserve)}% of the 5-hour window (${fromText(s.reserveFrom, 'SPARE10_RESERVE')})`),
    field('at the reserve', actionValue(s)),
    field('reading', readingValue(s)),
    field('consent', consent),
    field('guarded', guardedValue(s)),
    s.attended
      ? field('claude -p', `runs started here: ${s.childPolicy}`)
      : field('unattended', `${s.headless} (${fromText(s.headlessFrom, 'SPARE10_HEADLESS')})`),
    ...s.warnings.map((w) => `  ⚠ ${w}`),
    '',
    '/spare10 resume   continue on the reserve until the window resets',
    '/spare10 stop     stop at the reserve now',
  ]
  return lines.join('\n')
}

export type ReplyCase = 'asking' | 'stopped' | 'tripped' | 'consented' | 'below' | 'none' | 'off'

// The replies of /spare10 (B23 to B26, 12.1). The engine prefixes each reply with `spare10: `.

/** B23 ('tripped' is "tripped, not stopped"). */
export function resumeReply(c: ReplyCase, f?: Facts): string {
  const until = f === undefined ? UNTIL_RESET : untilText(f)
  switch (c) {
    case 'asking':
      return `resumed. Held work continues on the reserve ${until}.`
    case 'stopped':
      return `resumed. You can use the reserve ${until}. Type a prompt to continue.`
    case 'tripped':
      return `you can use the reserve ${until}.`
    case 'consented':
      return `already resumed ${until}.`
    case 'below':
      if (f !== undefined) return `nothing to resume. ${personFacts(f)}.`
      return 'nothing to resume. There is no 5-hour reading yet.'
    case 'none':
      return 'nothing to resume. There is no 5-hour reading yet.'
    case 'off':
      return 'this run is not guarded. Nothing changed.'
  }
}

/** B24 ('tripped' covers consented). */
export function stopReply(c: Exclude<ReplyCase, 'consented'>, f?: Facts, trip?: number): string {
  switch (c) {
    case 'asking':
      return 'stopped. Held work is refused.'
    case 'tripped':
      return 'stopped at the reserve. Type a prompt to be asked again, or run /spare10 resume.'
    case 'stopped':
      return 'already stopped.'
    case 'below':
    case 'none':
      return `nothing to stop. spare10 steps in at ${fmtPct(trip ?? 100 - (f?.reserve ?? 10))}% used.`
    case 'off':
      return 'this run is not guarded. Nothing changed.'
  }
}

/** B25 */
export const notPerson = (verb: string): string => `only you can run /spare10 ${verb}. Nothing changed.`

/** B25 */
export const unknownVerb = (verb: string): string =>
  `unknown command "${verb}". Use /spare10, /spare10 resume or /spare10 stop.`

/** Section 12.1 */
export function simulateReply(kind: 'set' | 'off' | 'bad', f?: Facts): string {
  if (kind === 'off') return 'test reading cleared. Consent and stop for this window are cleared too.'
  if (kind === 'bad' || f === undefined) return '/spare10 simulate takes a percentage from 0 to 100, or off.'
  return `test reading set to ${fmtPct(f.used)}% used, resets ${clockOf(f)}. It can only raise the real reading. Run /spare10 simulate off to clear it.`
}

/** A /spare10 that threw. */
export const commandFailed = (message: string): string => `/spare10 failed: ${message}`
