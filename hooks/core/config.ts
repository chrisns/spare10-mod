import type { PluginOptions, Settings as HostSettings } from 'claude-code'
import { parseTestPct } from './reading.ts'
import { badWarning, fmtPct } from './text.ts'

// Options, per-run env overrides, scope and the start-up checks (design section 8). No $ here.
// Precedence, highest first: SPARE10_* in the process env, pluginConfigs (managed, then --settings,
// then user), the manifest default. One normaliser per field, for the option and the env alike.

export type Headless = 'off' | 'prompt' | 'stop'
export type Scope = 'all' | 'opt-in'
export type Settings = { reserve: number; pausePrompt: string | null; headless: Headless; scope: Scope; badge: boolean }
export type Source = 'option' | 'env'
export type Effective = Settings & {
  enabled: boolean
  from: { reserve: Source; pausePrompt: Source; headless: Source; enabled: 'scope' | 'SPARE10' }
  testPct?: number // from SPARE10_SIMULATE
  warnings: string[] // B27 wording
}
export type EnvReads = { reserve?: string; pausePrompt?: string; headless?: string; onOff?: string; simulate?: string }

export const DEFAULTS: Settings = { reserve: 10, pausePrompt: null, headless: 'off', scope: 'all', badge: true }

const HEADLESS: readonly Headless[] = ['off', 'prompt', 'stop']
const SCOPES: readonly Scope[] = ['all', 'opt-in']

const word = (raw: unknown): string | undefined => (typeof raw === 'string' ? raw.trim().toLowerCase() : undefined)

/** 1 to 99, rounded to one decimal. A number or a numeric string. */
export function parseReserve(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : Number.NaN
  if (!Number.isFinite(n)) return undefined
  const r = Math.round(n * 10) / 10
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

/** The five declared fields, defaults filled. Extra stored keys are ignored. */
export function fromOptions(options: PluginOptions): Settings {
  return {
    reserve: parseReserve(options['reserve']) ?? DEFAULTS.reserve,
    pausePrompt: parsePausePrompt(options['pausePrompt']),
    headless: parseHeadless(options['headless']) ?? DEFAULTS.headless,
    scope: parseScope(options['scope']) ?? DEFAULTS.scope,
    badge: parseBadge(options['badge']),
  }
}

/** The per-run env over the options. A bad value is ignored with a B27 warning, never fatal. */
export function withEnv(base: Settings, env: EnvReads): Effective {
  const warnings: string[] = []
  const out: Effective = {
    ...base,
    enabled: base.scope === 'all',
    from: { reserve: 'option', pausePrompt: 'option', headless: 'option', enabled: 'scope' },
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
  if (env.pausePrompt !== undefined) {
    // Set but empty is meaningful: `SPARE10_PAUSE_PROMPT= claude` forces stop-and-ask for this run.
    out.pausePrompt = parsePausePrompt(env.pausePrompt)
    out.from.pausePrompt = 'env'
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
  const testPct = parseTestPct(env.simulate)
  if (testPct !== undefined) out.testPct = testPct
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
