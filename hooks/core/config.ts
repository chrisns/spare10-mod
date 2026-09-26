import type { PluginOptions, Settings as HostSettings } from 'claude-code'
import { KINDS, parseSimulateEnv } from './reading.ts'
import type { Kind } from './reading.ts'
import { badWarning, floorWarning, fmtPct } from './text.ts'

// Options, per-run env overrides, scope and the start-up checks (design section 8). No $ here.
// Precedence, highest first: SPARE10_* in the process env, pluginConfigs (managed, then --settings,
// then user), the manifest default. One normaliser per field, for the option and the env alike.

export type Headless = 'off' | 'prompt' | 'stop' | 'wait'
export type Scope = 'all' | 'opt-in'
export type Settings = {
  reserve: number
  weeklyReserve: number // 0: the weekly window is not watched
  lastMinutes: number // the 5-hour span: the reserve opens this many minutes before the reset. 0 is off
  weeklyLastHours: number // the weekly span, in hours. 0 is off
  resumeFloor: number // B48: the 5-hour floor in % left. A Resume at the reserve lasts until 100 - this. 0 is off
  weeklyResumeFloor: number // B48: the weekly floor. 0 is off
  pausePrompt: string | null
  autoResume: boolean
  headless: Headless
  scope: Scope
  badge: boolean
}
export type Source = 'option' | 'env'
/** Where a span comes from. 'unread': the env read failed, so the span is 0 (B47). */
export type SpanSource = Source | 'unread'
/** The spans in force (B47): the newest copy answers them through $.spare10.spans(). */
export type Spans = { lastMinutes: number; weeklyLastHours: number }
/** Both spans off: the guard holds until the reset. Every unknown gives this. */
export const NO_SPANS: Spans = Object.freeze({ lastMinutes: 0, weeklyLastHours: 0 })
export type Effective = Settings & {
  enabled: boolean
  from: {
    reserve: Source
    weeklyReserve: Source
    lastMinutes: SpanSource
    weeklyLastHours: SpanSource
    resumeFloor: Source
    weeklyResumeFloor: Source
    pausePrompt: Source
    autoResume: Source
    headless: Source
    enabled: 'scope' | 'SPARE10'
  }
  testPct?: number // from SPARE10_SIMULATE
  testKind?: Kind // only when SPARE10_SIMULATE names the weekly window
  testInMs?: number // only when SPARE10_SIMULATE has `in`
  warnings: string[] // B27 wording
}
export type EnvReads = {
  reserve?: string
  weeklyReserve?: string
  lastMinutes?: string
  weeklyLastHours?: string
  resumeFloor?: string
  weeklyResumeFloor?: string
  pausePrompt?: string
  autoResume?: string
  headless?: string
  onOff?: string
  simulate?: string
}

export const DEFAULTS: Settings = {
  reserve: 10,
  weeklyReserve: 10,
  lastMinutes: 20,
  weeklyLastHours: 8,
  resumeFloor: 5,
  weeklyResumeFloor: 5,
  pausePrompt: null,
  autoResume: true,
  headless: 'off',
  scope: 'all',
  badge: true,
}

const HEADLESS: readonly Headless[] = ['off', 'prompt', 'stop', 'wait']
const SCOPES: readonly Scope[] = ['all', 'opt-in']

const word = (raw: unknown): string | undefined => (typeof raw === 'string' ? raw.trim().toLowerCase() : undefined)

const numberOf = (raw: unknown): number =>
  typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : Number.NaN

/** 1 to 99, rounded to one decimal. A number or a numeric string. */
export function parseReserve(raw: unknown): number | undefined {
  const n = numberOf(raw)
  if (!Number.isFinite(n)) return undefined
  const r = Math.round(n * 10) / 10
  return r >= 1 && r <= 99 ? r : undefined
}

/** 0 (the weekly guard is off), or 1 to 99 rounded to one decimal. A number or a numeric string. */
export function parseWeeklyReserve(raw: unknown): number | undefined {
  const n = numberOf(raw)
  if (!Number.isFinite(n)) return undefined
  const r = Math.round(n * 10) / 10
  if (r === 0) return 0
  return r >= 1 && r <= 99 ? r : undefined
}

// One rule for both spans: 0 to max, rounded to one decimal. A number or a numeric string.
function parseSpan(raw: unknown, max: number): number | undefined {
  const n = numberOf(raw)
  if (!Number.isFinite(n)) return undefined
  const r = Math.round(n * 10) / 10 + 0 // + 0: never -0
  return r >= 0 && r <= max ? r : undefined
}

/** The 5-hour span in minutes: 0 (off) to 299, rounded to one decimal. */
export const parseLastMinutes = (raw: unknown): number | undefined => parseSpan(raw, 299)

/** The weekly span in hours: 0 (off) to 167, rounded to one decimal. */
export const parseWeeklyLastHours = (raw: unknown): number | undefined => parseSpan(raw, 167)

/** B48: a resume floor in % left: 0 (off) to 99, rounded to one decimal. A number or a numeric string. */
export const parseResumeFloor = (raw: unknown): number | undefined => parseSpan(raw, 99)

/**
 * B48, B54: the floor of a kind when it is above 0 and below that kind's reserve, else 0. No attendance
 * here: an unattended run has no floor in force either (B55), and the module applies that.
 */
export const floorOf = (s: Pick<Settings, 'reserve' | 'weeklyReserve' | 'resumeFloor' | 'weeklyResumeFloor'>, kind: Kind): number => {
  const floor = kind === 'seven_day' ? s.weeklyResumeFloor : s.resumeFloor
  const reserve = kind === 'seven_day' ? s.weeklyReserve : s.reserve
  return floor > 0 && floor < reserve ? floor : 0
}

/** A kind's span in ms (B41). 0 is off. */
export const spanOf = (s: Spans, kind: Kind): number =>
  Math.round(kind === 'seven_day' ? s.weeklyLastHours * 3_600_000 : s.lastMinutes * 60_000)

/** Blank or white space means stop and ask. Anything else is the instruction, verbatim. */
export const parsePausePrompt = (raw: unknown): string | null => (typeof raw === 'string' && raw.trim() !== '' ? raw : null)

export function parseHeadless(raw: unknown): Headless | undefined {
  const w = word(raw)
  return HEADLESS.find((h) => h === w)
}

export function parseScope(raw: unknown): Scope | undefined {
  const w = word(raw)
  return SCOPES.find((s) => s === w)
}

export function parseSwitch(raw: unknown): 'on' | 'off' | undefined {
  const w = word(raw)
  return w === 'on' || w === 'off' ? w : undefined
}

/** A boolean with no default arrives as "", so only an explicit false turns the badge off. */
export const parseBadge = (raw: unknown): boolean => raw !== false

/** As parseBadge: only an explicit false turns autoResume off. */
export const parseAutoResume = (raw: unknown): boolean => raw !== false

/** The eleven declared fields, defaults filled. Extra stored keys are ignored. */
export function fromOptions(options: PluginOptions): Settings {
  return {
    reserve: parseReserve(options['reserve']) ?? DEFAULTS.reserve,
    weeklyReserve: parseWeeklyReserve(options['weeklyReserve']) ?? DEFAULTS.weeklyReserve,
    lastMinutes: parseLastMinutes(options['lastMinutes']) ?? DEFAULTS.lastMinutes,
    weeklyLastHours: parseWeeklyLastHours(options['weeklyLastHours']) ?? DEFAULTS.weeklyLastHours,
    resumeFloor: parseResumeFloor(options['resumeFloor']) ?? DEFAULTS.resumeFloor,
    weeklyResumeFloor: parseResumeFloor(options['weeklyResumeFloor']) ?? DEFAULTS.weeklyResumeFloor,
    pausePrompt: parsePausePrompt(options['pausePrompt']),
    autoResume: parseAutoResume(options['autoResume']),
    headless: parseHeadless(options['headless']) ?? DEFAULTS.headless,
    scope: parseScope(options['scope']) ?? DEFAULTS.scope,
    badge: parseBadge(options['badge']),
  }
}

/**
 * The kinds spare10 acts on, five_hour first: the weekly window only while its reserve is above 0.
 * `present` (Codex design 4.15): the kinds the host reports a window for. Claude passes none: both.
 */
export const watchedKinds = (s: Pick<Settings, 'weeklyReserve'>, present: readonly Kind[] = KINDS): Kind[] =>
  KINDS.filter((k) => present.includes(k) && (k === 'five_hour' || s.weeklyReserve > 0))

export const reserveOf = (s: Pick<Settings, 'reserve' | 'weeklyReserve'>, kind: Kind): number =>
  kind === 'seven_day' ? s.weeklyReserve : s.reserve

/** B37: the SPARE10_HEADLESS a guarded session sets for its children, when the variable is not set. */
export const childHeadless = (headless: Headless, envSet: boolean): 'stop' | undefined =>
  !envSet && (headless === 'off' || headless === 'wait') ? 'stop' : undefined

/**
 * The per-run env over the options. A bad value is ignored with a B27 warning, never fatal.
 * `o.simulateKind` (Codex design 4.15): the kind of a SPARE10_SIMULATE with no kind word, the weekly
 * window on a host that reports no 5-hour window. Claude passes none: the 5-hour window.
 */
export function withEnv(base: Settings, env: EnvReads, o: { simulateKind?: Kind } = {}): Effective {
  const warnings: string[] = []
  const out: Effective = {
    ...base,
    enabled: base.scope === 'all',
    from: {
      reserve: 'option',
      weeklyReserve: 'option',
      lastMinutes: 'option',
      weeklyLastHours: 'option',
      resumeFloor: 'option',
      weeklyResumeFloor: 'option',
      pausePrompt: 'option',
      autoResume: 'option',
      headless: 'option',
      enabled: 'scope',
    },
    warnings,
  }
  if (env.reserve !== undefined) {
    const r = parseReserve(env.reserve)
    if (r === undefined) warnings.push(badWarning('SPARE10_RESERVE', env.reserve, fmtPct(base.reserve)))
    else {
      out.reserve = r
      out.from.reserve = 'env'
    }
  }
  if (env.weeklyReserve !== undefined) {
    const r = parseWeeklyReserve(env.weeklyReserve)
    if (r === undefined) warnings.push(badWarning('SPARE10_WEEKLY_RESERVE', env.weeklyReserve, fmtPct(base.weeklyReserve)))
    else {
      out.weeklyReserve = r
      out.from.weeklyReserve = 'env'
    }
  }
  if (env.lastMinutes !== undefined) {
    const m = parseLastMinutes(env.lastMinutes)
    if (m === undefined) warnings.push(badWarning('SPARE10_LAST_MINUTES', env.lastMinutes, fmtPct(base.lastMinutes)))
    else {
      out.lastMinutes = m
      out.from.lastMinutes = 'env'
    }
  }
  if (env.weeklyLastHours !== undefined) {
    const h = parseWeeklyLastHours(env.weeklyLastHours)
    if (h === undefined) warnings.push(badWarning('SPARE10_WEEKLY_LAST_HOURS', env.weeklyLastHours, fmtPct(base.weeklyLastHours)))
    else {
      out.weeklyLastHours = h
      out.from.weeklyLastHours = 'env'
    }
  }
  if (env.resumeFloor !== undefined) {
    const f = parseResumeFloor(env.resumeFloor)
    if (f === undefined) warnings.push(badWarning('SPARE10_RESUME_FLOOR', env.resumeFloor, fmtPct(base.resumeFloor)))
    else {
      out.resumeFloor = f
      out.from.resumeFloor = 'env'
    }
  }
  if (env.weeklyResumeFloor !== undefined) {
    const f = parseResumeFloor(env.weeklyResumeFloor)
    if (f === undefined) warnings.push(badWarning('SPARE10_WEEKLY_RESUME_FLOOR', env.weeklyResumeFloor, fmtPct(base.weeklyResumeFloor)))
    else {
      out.weeklyResumeFloor = f
      out.from.weeklyResumeFloor = 'env'
    }
  }
  if (env.pausePrompt !== undefined) {
    // Set but empty is meaningful: `SPARE10_PAUSE_PROMPT= claude` forces stop-and-ask for this run.
    out.pausePrompt = parsePausePrompt(env.pausePrompt)
    out.from.pausePrompt = 'env'
  }
  if (env.autoResume !== undefined) {
    const a = parseSwitch(env.autoResume)
    if (a === undefined) warnings.push(badWarning('SPARE10_AUTO_RESUME', env.autoResume, base.autoResume ? 'on' : 'off'))
    else {
      out.autoResume = a === 'on'
      out.from.autoResume = 'env'
    }
  }
  if (env.headless !== undefined) {
    const h = parseHeadless(env.headless)
    if (h === undefined) warnings.push(badWarning('SPARE10_HEADLESS', env.headless, base.headless))
    else {
      out.headless = h
      out.from.headless = 'env'
    }
  }
  if (env.onOff !== undefined) {
    const s = parseSwitch(env.onOff)
    if (s === undefined) warnings.push(badWarning('SPARE10', env.onOff, base.scope))
    else {
      out.enabled = s === 'on'
      out.from.enabled = 'SPARE10'
    }
  }
  const spec = parseSimulateEnv(env.simulate, o.simulateKind)
  if (spec !== undefined) {
    out.testPct = spec.pct
    if (spec.kind !== 'five_hour') out.testKind = spec.kind
    if (spec.inMs !== undefined) out.testInMs = spec.inMs
  }
  // B54: a floor above 0 at or above its reserve does nothing. The weekly one only while it is watched.
  if (out.resumeFloor > 0 && out.resumeFloor >= out.reserve) warnings.push(floorWarning('five_hour', out.resumeFloor, out.reserve))
  if (out.weeklyReserve > 0 && out.weeklyResumeFloor > 0 && out.weeklyResumeFloor >= out.weeklyReserve) {
    warnings.push(floorWarning('seven_day', out.weeklyResumeFloor, out.weeklyReserve))
  }
  return out
}

/**
 * B47: the settings after a failed env read. The D0.2 fallback (the options only), with both spans 0
 * from 'unread': an unknown span keeps the guard on until the reset. The floors keep their options: for a
 * floor, the guarded side is a floor in force (floor 1.3 item 9).
 */
export function unreadEnv(base: Settings): Effective {
  const out = withEnv(base, {})
  out.lastMinutes = 0
  out.weeklyLastHours = 0
  out.from.lastMinutes = 'unread'
  out.from.weeklyLastHours = 'unread'
  return out
}

function hasFlag(s: HostSettings | null | undefined): boolean {
  if (typeof s !== 'object' || s === null) return false
  const env = s['env']
  if (typeof env !== 'object' || env === null) return false
  return (env as Record<string, unknown>)['CLAUDE_CODE_ENABLE_FUNCTION_HOOKS'] !== undefined
}

/** B28: the process has the flag and no settings source (user, project, local, flag, policy) does. `flag` is `--settings`. */
export const flagOnlyInShell = (inProcess: boolean, sources: readonly HostSettings[]): boolean =>
  inProcess && !sources.some((s) => hasFlag(s))

/** B29: the first of a positive askUserQuestionTimeout in the merged settings, a set CLAUDE_AFK_TIMEOUT_MS. */
export function questionTimeout(
  merged: HostSettings,
  afk: string | undefined,
): 'askUserQuestionTimeout' | 'CLAUDE_AFK_TIMEOUT_MS' | undefined {
  const t = typeof merged === 'object' && merged !== null ? merged['askUserQuestionTimeout'] : undefined
  if (typeof t === 'number' && Number.isFinite(t) && t > 0) return 'askUserQuestionTimeout'
  if (afk !== undefined) return 'CLAUDE_AFK_TIMEOUT_MS'
  return undefined
}
