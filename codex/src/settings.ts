import { statSync } from 'node:fs'
import { join } from 'node:path'
import { codexDebug, codexText, configOptions, shownPath } from '../../hooks/core/codex.ts'
import type { HostKind, OptionName } from '../../hooks/core/codex.ts'
import { DEFAULTS, fromOptions, withEnv } from '../../hooks/core/config.ts'
import type { Effective, EnvReads } from '../../hooks/core/config.ts'
import type { Kind } from '../../hooks/core/reading.ts'
import { readJson, withLock, writeJson } from './files.ts'
import type { Log } from './log.ts'
import type { Env, Paths } from './paths.ts'

// The settings of a broker and of the CLI (Codex design 5.1, 5.2). The ten Claude options live in
// <data dir>/config.json, which `spare10 set` writes under config.lock. Precedence, highest first (A15): a
// SPARE10_* variable of the broker env, then config.json, then the default. The core parsers and withEnv
// do all the work: this file only reads the file and the env.

/** The variables of withEnv (5.2): the field of EnvReads and its name. */
export const ENV_NAMES: ReadonlyArray<readonly [keyof EnvReads, string]> = [
  ['reserve', 'SPARE10_RESERVE'],
  ['weeklyReserve', 'SPARE10_WEEKLY_RESERVE'],
  ['lastMinutes', 'SPARE10_LAST_MINUTES'],
  ['weeklyLastHours', 'SPARE10_WEEKLY_LAST_HOURS'],
  ['resumeFloor', 'SPARE10_RESUME_FLOOR'],
  ['weeklyResumeFloor', 'SPARE10_WEEKLY_RESUME_FLOOR'],
  ['pausePrompt', 'SPARE10_PAUSE_PROMPT'],
  ['autoResume', 'SPARE10_AUTO_RESUME'],
  ['headless', 'SPARE10_HEADLESS'],
  ['onOff', 'SPARE10'],
  ['simulate', 'SPARE10_SIMULATE'],
]

/** The EnvReads of the eleven names in `env`. A set but empty value counts, as on Claude. */
export function envReadsOf(env: Env): EnvReads {
  const out: EnvReads = {}
  for (const [field, name] of ENV_NAMES) {
    const v = env[name]
    if (v !== undefined) out[field] = v
  }
  return out
}

/** A host that runs one launch only: SPARE10_SIMULATE there is for this run (4.18). On a shared host it would give every new session a test reading. */
export const ownsSimulate = (hostKind: HostKind | undefined): boolean => hostKind === undefined || hostKind === 'exec' || hostKind === 'tui'

/** The file of the options. */
export const configPath = (paths: Pick<Paths, 'data'>): string => join(paths.data, 'config.json')

/** config.json as JSON: `{}` when it is absent, else the parsed value, or the error text when it does not read or parse. */
export function readConfig(path: string): { raw: unknown } | { error: string } {
  try {
    const raw = readJson<unknown>(path)
    return { raw: raw === undefined ? {} : raw }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export type SettingsDeps = {
  /** `home`: the CX11 and CX12 warnings show config.json as `~/...` under it. */
  paths: Pick<Paths, 'data' | 'home'>
  log: Log
  /** The broker env (env_vars), or the CLI env. It is read once. */
  env: Env
  /** B37, 3.10: the `child` value of the parent session of a nested run, else undefined. Asked only when SPARE10_HEADLESS is not set. */
  parentChild: () => 'stop' | undefined
  /** A8: the kind of a SPARE10_SIMULATE with no kind word: seven_day when the 5-hour window is absent. */
  simulateKind: () => Kind
  /** 4.18: SPARE10_SIMULATE counts only on an exec or tui host. None (the CLI) counts it. */
  hostKind?: HostKind
}

export type SettingsSource = { get(): Effective; path: string }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A short mark of the file: its inode, size and mtime, or `-` when it is absent. */
function markOf(path: string): string {
  try {
    const st = statSync(path)
    return `${st.ino}:${st.size}:${st.mtimeMs}`
  } catch (e) {
    const code = (e as { code?: unknown }).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? '-' : `error:${String(code)}`
  }
}

/** The settings in force (5.2). The result is cached until config.json, the parent's child policy or the simulate kind changes. */
export function createSettings(d: SettingsDeps): SettingsSource {
  const path = configPath(d.paths)
  const shown = shownPath(path, d.paths.home) // the path as CX11 and CX12 show it
  const base = envReadsOf(d.env)
  if (base.simulate !== undefined && !ownsSimulate(d.hostKind)) {
    delete base.simulate
    d.log.debug(codexDebug.simulateIgnored)
  }
  let cache: { key: string; eff: Effective } | undefined

  const parentChild = (): 'stop' | undefined => {
    if (base.headless !== undefined) return undefined
    try {
      return d.parentChild()
    } catch (e) {
      d.log.debug(codexDebug.readFailed('the parent session', e instanceof Error ? e.message : String(e)))
      return undefined
    }
  }

  const build = (child: 'stop' | undefined, simulateKind: Kind): Effective => {
    const env: EnvReads = base.headless === undefined && child !== undefined ? { ...base, headless: child } : { ...base }
    const read = readConfig(path)
    if ('raw' in read && isObject(read.raw)) {
      const { options, warnings } = configOptions(shown, read.raw) // CX11 for each bad value
      const eff = withEnv(fromOptions(options), env, { simulateKind })
      eff.warnings = [...warnings, ...eff.warnings]
      return eff
    }
    // 5.2: config.json does not read, does not parse, or is not an object. The defaults and the env, and
    // each span that no variable sets becomes 0, so each reserve holds until the reset (CX12).
    const cx12 = 'error' in read ? codexText.configUnread(shown, read.error) : configOptions(shown, read.raw).warnings[0]
    const eff = withEnv(DEFAULTS, env, { simulateKind })
    if (eff.from.lastMinutes !== 'env') {
      eff.lastMinutes = 0
      eff.from.lastMinutes = 'unread'
    }
    if (eff.from.weeklyLastHours !== 'env') {
      eff.weeklyLastHours = 0
      eff.from.weeklyLastHours = 'unread'
    }
    eff.warnings = [...(cx12 === undefined ? [] : [cx12]), ...eff.warnings]
    return eff
  }

  return {
    path,
    get() {
      const child = parentChild()
      const simulateKind = d.simulateKind()
      const key = `${markOf(path)}|${child ?? ''}|${simulateKind}`
      if (cache?.key !== key) cache = { key, eff: build(child, simulateKind) }
      return structuredClone(cache.eff)
    },
  }
}

/**
 * `spare10 set <option> <value>` and `spare10 set <option> default` (5.1): writes one key of config.json
 * under config.lock, by rename. `value` undefined removes the key. A config.json that does not parse is
 * not overwritten: the call throws, and the command says that nothing changed (CX32). The result is the
 * old value of the key (undefined when it had none).
 */
export function setOption(
  paths: Pick<Paths, 'data'>,
  owner: string,
  name: OptionName,
  value: string | number | boolean | undefined,
): { old: unknown } {
  const path = configPath(paths)
  return withLock(join(paths.data, 'config.lock'), owner, () => {
    const read = readJson<unknown>(path)
    const raw = read === undefined ? {} : read
    if (!isObject(raw)) throw new Error('it is not a JSON object')
    const next = { ...raw }
    const old = next[name]
    if (value === undefined) delete next[name]
    else next[name] = value
    writeJson(path, next)
    return { old }
  })
}
