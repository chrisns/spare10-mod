import type { PluginOptions, Settings as HostSettings } from 'claude-code'
import { parseSimulateEnv } from './reading.ts'
import type { Kind } from './reading.ts'
import { badWarning, fmtPct } from './text.ts'

// Options, per-run env overrides, scope and the start-up checks (design section 8). No $ here.
// Precedence, highest first: SPARE10_* in the process env, pluginConfigs (managed, then --settings,
// then user), the manifest default. One normaliser per field, for the option and the env alike.

export type Headless = 'off' | 'prompt' | 'stop' | 'wait'
export type Scope = 'all' | 'opt-in'
export type Settings = {
  reserve: number
  weeklyReserve: number // 0: the weekly window is not watched
  pausePrompt: string | null
  autoResume: boolean
  headless: Headless
  scope: Scope
  badge: boolean
}
export type Source = 'option' | 'env'
export type Effective = Settings & {
  enabled: boolean
  from: { reserve: Source; weeklyReserve: Source; pausePrompt: Source; autoResume: Source; headless: Source; enabled: 'scope' | 'SPARE10' }
  testPct?: number // from SPARE10_SIMULATE
  testKind?: Kind // only when SPARE10_SIMULATE names the weekly window
  testInMs?: number // only when SPARE10_SIMULATE has `in`
  warnings: string[] // B27 wording
}
export type EnvReads = {
  reserve?: string
  weeklyReserve?: string
  pausePrompt?: string
  autoResume?: string
  headless?: string
  onOff?: string
  simulate?: string
}

export const DEFAULTS: Settings = {
  reserve: 10,
  weeklyReserve: 10,
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

/** The seven declared fields, defaults filled. Extra stored keys are ignored. */
export function fromOptions(options: PluginOptions): Settings {
  return {
    reserve: parseReserve(options['reserve']) ?? DEFAULTS.reserve,
    weeklyReserve: parseWeeklyReserve(options['weeklyReserve']) ?? DEFAULTS.weeklyReserve,
    pausePrompt: parsePausePrompt(options['pausePrompt']),
    autoResume: parseAutoResume(options['autoResume']),
    headless: parseHeadless(options['headless']) ?? DEFAULTS.headless,
    scope: parseScope(options['scope']) ?? DEFAULTS.scope,
    badge: parseBadge(options['badge']),
  }
}

/** The kinds spare10 acts on, five_hour first: the weekly window only while its reserve is above 0. */
export const watchedKinds = (s: Pick<Settings, 'weeklyReserve'>): Kind[] =>
  s.weeklyReserve > 0 ? ['five_hour', 'seven_day'] : ['five_hour']

export const reserveOf = (s: Pick<Settings, 'reserve' | 'weeklyReserve'>, kind: Kind): number =>
  kind === 'seven_day' ? s.weeklyReserve : s.reserve

/** B37: the SPARE10_HEADLESS a guarded session sets for its children, when the variable is not set. */
export const childHeadless = (headless: Headless, envSet: boolean): 'stop' | undefined =>
  !envSet && (headless === 'off' || headless === 'wait') ? 'stop' : undefined

/** The per-run env over the options. A bad value is ignored with a B27 warning, never fatal. */
export function withEnv(base: Settings, env: EnvReads): Effective {
  const warnings: string[] = []
  const out: Effective = {
    ...base,
    enabled: base.scope === 'all',
    from: { reserve: 'option', weeklyReserve: 'option', pausePrompt: 'option', autoResume: 'option', headless: 'option', enabled: 'scope' },
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
  const spec = parseSimulateEnv(env.simulate)
  if (spec !== undefined) {
    out.testPct = spec.pct
    if (spec.kind !== 'five_hour') out.testKind = spec.kind
    if (spec.inMs !== undefined) out.testInMs = spec.inMs
  }
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
