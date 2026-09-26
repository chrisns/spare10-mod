import type { PluginOptions, SessionRateLimit } from 'claude-code'
import {
  DEFAULTS,
  parseHeadless,
  parseLastMinutes,
  parsePausePrompt,
  parseReserve,
  parseResumeFloor,
  parseScope,
  parseSwitch,
  parseWeeklyLastHours,
  parseWeeklyReserve,
} from './config.ts'
import type { Consent } from './decide.ts'
import { BLIND_AFTER, KINDS, parseSimulate, windowMs } from './reading.ts'
import type { Anchored, Kind } from './reading.ts'
import { HEADER, NOT_STARTED_GENERIC, QUESTION_OPTIONS, STOP_GENERIC, fmtDuration, fmtPct, untilText, yourReserves } from './text.ts'
import type { Facts } from './text.ts'

// The Codex-only pure rules and texts (Codex design 7.1). No $ here, and no Node API: the Codex broker and
// CLI (codex/src) call these functions. register.tsx never imports this file, so the Claude engine never
// loads it. Every text that a person or the model reads on Codex only is here (CX1 to CX47, but CX17,
// which is in text.ts). The broker puts `spare10: ` in front of each transcript line, warning and command
// reply (withPrefix, A12), so those texts never start with `spare10`. Model texts, drop reasons, CLI lines
// and debug lines keep their own `spare10: `.

// ---- Constants that the pure rules need. codex/src/timing.ts takes them from here (5.3). ----

/** How close to a trip or floor point counts as near (A19). */
export const NEAR_TRIP_POINTS = 5

/** Two resets this close are one window (3.6, A22): `resets_at` jitters by about 30 s. */
export const RESET_JITTER_MS = 600_000

/** The Luna rule needs a live read this young (A7). */
export const LIVE_LUNA_MAX_AGE_MS = 60_000

/** A live read this young is fresh for the hard stop (4.14, P1). */
export const HARD_STOP_MAX_AGE_MS = 60_000

// ---- Windows and readings (3.6) ----

/** One window of a Codex rate limit snapshot: the app-server form (camelCase) or the rollout form (snake_case). */
export type CodexWindow = {
  usedPercent?: number
  used_percent?: number
  windowDurationMins?: number | null
  window_minutes?: number | null
  resetsAt?: number | string | null
  resets_at?: number | string | null
}
export type CodexCredits = { hasCredits?: boolean; has_credits?: boolean; unlimited?: boolean; balance?: string | null }
export type CodexSnapshot = {
  limitId?: string | null
  limit_id?: string | null
  primary?: CodexWindow | null
  secondary?: CodexWindow | null
  credits?: CodexCredits | null
  rateLimitReachedType?: unknown
  rate_limit_reached_type?: unknown
  spendControlReached?: boolean | null
  spend_control_reached?: boolean | null
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A window's kind by its minutes, never by its slot: 285 to 315 is five_hour, 9576 to 10584 is seven_day. */
export const kindOfMinutes = (mins: number | null | undefined): Kind | undefined => {
  if (!finite(mins)) return undefined
  if (mins >= 285 && mins <= 315) return 'five_hour'
  if (mins >= 9576 && mins <= 10584) return 'seven_day'
  return undefined
}

const limitIdOf = (s: CodexSnapshot): string | null | undefined => (s.limitId !== undefined ? s.limitId : s.limit_id)

/** The ordinary plan bucket: limit id "codex", or none (an old rollout). A `premium` or other bucket is not. */
export function isCodexBucket(s: CodexSnapshot): boolean {
  const id = limitIdOf(s)
  return id === undefined || id === null || id === 'codex'
}

const pctOfWindow = (w: CodexWindow): number | undefined => {
  const p = w.usedPercent ?? w.used_percent
  return finite(p) ? p : undefined
}

/** The windows of a snapshot: each slot that holds an object with a percentage. */
const windowsOf = (s: CodexSnapshot): CodexWindow[] =>
  [s.primary, s.secondary].filter((w): w is CodexWindow => isObject(w) && pctOfWindow(w) !== undefined)

/** An observation: a codex-bucket snapshot with at least one window of any length. The 429 marker has none. */
export const isObservation = (s: CodexSnapshot): boolean => isCodexBucket(s) && windowsOf(s).length > 0

/** `resets_at` as an ISO time: unix seconds (a number or a digit string), or an RFC 3339 string. */
function resetIso(r: number | string | null | undefined): string | undefined {
  if (finite(r)) return r > 0 ? new Date(r * 1000).toISOString() : undefined
  if (typeof r !== 'string' || r.trim() === '') return undefined
  const t = r.trim()
  if (/^\d+$/.test(t)) return resetIso(Number(t))
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

/**
 * The codex bucket as core readings: one per watched kind, in KINDS order. Each window is classified by
 * its minutes. The percentage is rounded to one decimal. Two windows of one kind: the higher one counts.
 */
export function codexLimits(s: CodexSnapshot): SessionRateLimit[] {
  if (!isCodexBucket(s)) return []
  const out: SessionRateLimit[] = []
  for (const kind of KINDS) {
    const mine = windowsOf(s).filter((w) => kindOfMinutes(w.windowDurationMins ?? w.window_minutes) === kind)
    const best = mine.sort((a, b) => (pctOfWindow(b) ?? 0) - (pctOfWindow(a) ?? 0))[0]
    if (best === undefined) continue
    const resetsAt = resetIso(best.resetsAt ?? best.resets_at)
    const percentUsed = Math.round((pctOfWindow(best) ?? 0) * 10) / 10 + 0
    out.push(resetsAt === undefined ? { kind, percentUsed } : { kind, percentUsed, resetsAt })
  }
  return out
}

/** What a session knows of the kinds the host reports: the present kinds, and per kind the count of observations in a row that omit it. */
export type Presence = { present: Kind[]; count: Partial<Record<Kind, number>> }

/** Before any observation, both kinds are present. */
export const initialPresence = (): Presence => ({ present: [...KINDS], count: {} })

/**
 * The present kinds after one more response-backed snapshot (3.6). A snapshot that is not an observation
 * changes nothing. A kind becomes absent only after BLIND_AFTER observations in a row omit it, and never
 * while its seed is inside its window. A kind that an observation has is present at once.
 */
export function nextPresence(prev: Presence, obs: CodexSnapshot, seedInWindow: (k: Kind) => boolean): Presence {
  if (!isObservation(obs)) return prev
  const has = new Set(codexLimits(obs).map((l) => l.kind))
  const count: Partial<Record<Kind, number>> = {}
  const present: Kind[] = []
  for (const k of KINDS) {
    const n = has.has(k) ? 0 : (prev.count[k] ?? 0) + 1
    count[k] = n
    if (n < BLIND_AFTER || seedInWindow(k)) present.push(k)
  }
  return { present, count }
}

// A slot that holds any window object: only a snapshot whose slots are both empty has no window at all.
const hasAnyWindow = (s: CodexSnapshot): boolean => isObject(s.primary) || isObject(s.secondary)

// A live read names its bucket: the daemon sends every key of a RateLimitSnapshot, with null for no value.
const namesBucket = (s: CodexSnapshot): boolean => 'limitId' in s || 'limit_id' in s

/**
 * Blind (Codex): the last BLIND_AFTER good live reads, oldest first, all have a codex bucket with no window
 * at all. A good read with no codex bucket (null, or an object that names no bucket) is no such read, and it
 * breaks the row: blindness lets all work through, so only a codex bucket may make it.
 */
export function blindFrom(liveReads: ReadonlyArray<CodexSnapshot | null | undefined>): boolean {
  if (liveReads.length < BLIND_AFTER) return false
  return liveReads.slice(-BLIND_AFTER).every((s) => isObject(s) && namesBucket(s) && isCodexBucket(s) && !hasAnyWindow(s))
}

/**
 * The seed of a kind from two anchored readings with their observation times (3.6). The newer
 * observation wins, not the later reset: `resets_at` jitters, and a reset credit moves a window. At the
 * same time, two resets within RESET_JITTER_MS are one window (the higher percentage wins), else the
 * later window wins.
 */
export function pickSeed(a: (Anchored & { at: number }) | undefined, b: (Anchored & { at: number }) | undefined): Anchored | undefined {
  const pick = ((): (Anchored & { at: number }) | undefined => {
    if (a === undefined) return b
    if (b === undefined) return a
    if (a.at !== b.at) return a.at > b.at ? a : b
    if (Math.abs(a.resetsAtMs - b.resetsAtMs) <= RESET_JITTER_MS) return b.pct > a.pct ? b : a
    return b.resetsAtMs > a.resetsAtMs ? b : a
  })()
  return pick === undefined ? undefined : { pct: pick.pct, resetsAtMs: pick.resetsAtMs }
}

/** Credits that can pay past 100% (A23): unlimited, or a balance. */
export const usableCredits = (c: CodexCredits | null | undefined): boolean =>
  isObject(c) && (c.unlimited === true || (c.hasCredits ?? c.has_credits) === true)

/** Near a trip point (A19): at or above the trip point, or a floor point, minus NEAR_TRIP_POINTS. */
export const nearTrip = (pct: number | undefined, trip: number, floorPoint?: number): boolean =>
  pct !== undefined && (pct >= trip - NEAR_TRIP_POINTS || (floorPoint !== undefined && pct >= floorPoint - NEAR_TRIP_POINTS))

/** A22: a real consent is void when the kind's current window ends more than RESET_JITTER_MS after the consent's end. */
export const voidedByReset = (c: Consent, windowEnd: number): boolean => windowEnd - c.until > RESET_JITTER_MS

// ---- Rollout lines ----

function jsonLine(line: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(line)
    return isObject(v) ? v : undefined
  } catch {
    return undefined
  }
}

const payloadOf = (o: Record<string, unknown>): Record<string, unknown> | undefined => (isObject(o['payload']) ? o['payload'] : undefined)

/** A rollout `token_count` event with rate limits: its time and its snapshot (of any bucket). Else undefined. */
export function tokenCountOf(line: string): { at: number; snapshot: CodexSnapshot } | undefined {
  if (!line.includes('"token_count"')) return undefined
  const o = jsonLine(line)
  const p = o === undefined ? undefined : payloadOf(o)
  if (o === undefined || p === undefined || o['type'] !== 'event_msg' || p['type'] !== 'token_count') return undefined
  const rl = p['rate_limits']
  if (!isObject(rl)) return undefined
  const at = typeof o['timestamp'] === 'string' ? Date.parse(o['timestamp']) : Number.NaN
  return Number.isFinite(at) ? { at, snapshot: rl as CodexSnapshot } : undefined
}

/** The first line of a rollout: its `session_meta` originator and source. Else undefined. */
export function sessionMetaOf(line: string): { type: 'session_meta'; originator?: string; source?: unknown } | undefined {
  if (!line.includes('"session_meta"')) return undefined
  const o = jsonLine(line)
  const p = o === undefined ? undefined : payloadOf(o)
  if (o === undefined || p === undefined || o['type'] !== 'session_meta') return undefined
  const originator = typeof p['originator'] === 'string' ? p['originator'] : undefined
  return {
    type: 'session_meta',
    ...(originator === undefined ? {} : { originator }),
    ...(p['source'] === undefined ? {} : { source: p['source'] }),
  }
}

/** The end of a turn in a rollout: `turn_aborted` or `task_complete`, with `started_at` in unix seconds (null when absent). */
export function turnEndOf(line: string): { turnId: string; how: 'aborted' | 'complete'; startedAt?: number | null } | undefined {
  if (!line.includes('"turn_aborted"') && !line.includes('"task_complete"')) return undefined
  const o = jsonLine(line)
  const p = o === undefined ? undefined : payloadOf(o)
  if (o === undefined || p === undefined || o['type'] !== 'event_msg') return undefined
  const how = p['type'] === 'turn_aborted' ? 'aborted' : p['type'] === 'task_complete' ? 'complete' : undefined
  const turnId = p['turn_id']
  if (how === undefined || typeof turnId !== 'string' || turnId === '') return undefined
  return { turnId, how, startedAt: finite(p['started_at']) ? p['started_at'] : null }
}

/** P1 (CX9): the sandbox and approval facts of a `turn_context`, and the roots it lets the agent write. */
export type TurnContextFacts = { sandbox?: string; profile?: string; approval?: string; reviewer?: string; roots: string[] }

const SPECIAL_ROOTS: Record<string, string> = { root: '/', slash_tmp: '/tmp' }

/** P1 (CX9): a rollout `turn_context` line as facts. The writable roots come from the permission profile. */
export function turnContextOf(line: string): TurnContextFacts | undefined {
  if (!line.includes('"turn_context"')) return undefined
  const o = jsonLine(line)
  const p = o === undefined ? undefined : payloadOf(o)
  if (o === undefined || p === undefined || o['type'] !== 'turn_context') return undefined
  const typeOf = (v: unknown): string | undefined => (isObject(v) && typeof v['type'] === 'string' ? v['type'] : undefined)
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  const roots: string[] = []
  const profile = isObject(p['permission_profile']) ? p['permission_profile'] : undefined
  const fsPolicy = profile !== undefined && isObject(profile['file_system']) ? profile['file_system'] : undefined
  const entries = fsPolicy !== undefined && Array.isArray(fsPolicy['entries']) ? fsPolicy['entries'] : []
  for (const e of entries) {
    if (!isObject(e) || e['access'] !== 'write' || !isObject(e['path'])) continue
    const path = e['path']
    if (path['type'] === 'path' && typeof path['path'] === 'string') roots.push(path['path'])
    const kind = path['type'] === 'special' && isObject(path['value']) ? path['value']['kind'] : undefined
    if (typeof kind === 'string' && SPECIAL_ROOTS[kind] !== undefined) roots.push(SPECIAL_ROOTS[kind])
  }
  const out: TurnContextFacts = { roots }
  const sandbox = typeOf(p['sandbox_policy'])
  const prof = typeOf(profile)
  const approval = str(p['approval_policy'])
  const reviewer = str(p['approvals_reviewer'])
  if (sandbox !== undefined) out.sandbox = sandbox
  if (prof !== undefined) out.profile = prof
  if (approval !== undefined) out.approval = approval
  if (reviewer !== undefined) out.reviewer = reviewer
  return out
}

// ---- Live reads (route A) ----

/** A good live read, as live.json keeps it. `codex` is the snapshot of the codex bucket. */
export type LiveRead = {
  at: number
  route: 'daemon' | 'app-server'
  codex?: CodexSnapshot
  allowed?: boolean | null
  reached?: string | null
  spendControl?: boolean | null
  credits?: CodexCredits | null
}

/** An `account/rateLimits/read` result (GetAccountRateLimitsResponse) as a live read, or the error it names. */
export function liveOf(result: unknown, at: number, route: 'daemon' | 'app-server'): LiveRead | { error: string } {
  if (!isObject(result)) return { error: 'the reply is not an object' }
  if (isObject(result['error'])) return { error: typeof result['error']['message'] === 'string' ? result['error']['message'] : 'the reply is an error' }
  const byId = isObject(result['rateLimitsByLimitId']) ? result['rateLimitsByLimitId'] : undefined
  const single = isObject(result['rateLimits']) ? (result['rateLimits'] as CodexSnapshot) : undefined
  if (byId === undefined && single === undefined) return { error: typeof result['message'] === 'string' ? result['message'] : 'the reply has no rate limits' }
  const listed = byId !== undefined && isObject(byId['codex']) ? (byId['codex'] as CodexSnapshot) : undefined
  const codex = listed ?? (single !== undefined && isCodexBucket(single) ? single : undefined)
  const allowed = result['ordinaryUsageAllowed']
  const reached = codex?.rateLimitReachedType
  const spend = codex?.spendControlReached
  const credits = codex?.credits
  return {
    at,
    route,
    ...(codex === undefined ? {} : { codex }),
    allowed: typeof allowed === 'boolean' ? allowed : null,
    reached: typeof reached === 'string' ? reached : null,
    spendControl: typeof spend === 'boolean' ? spend : null,
    credits: typeof credits === 'object' && credits !== null ? credits : null,
  }
}

const isReserveModel = (model: string | undefined): boolean => model !== undefined && /^gpt-reserve$/i.test(model)

/**
 * A7, Luna Reserve: a step on the `gpt-reserve` model passes while the newest live read says that
 * ordinary usage is not allowed, or while no live read younger than LIVE_LUNA_MAX_AGE_MS exists.
 */
export const offQuota = (model: string | undefined, live: LiveRead | undefined, now: number): boolean =>
  isReserveModel(model) && (live === undefined || now - live.at >= LIVE_LUNA_MAX_AGE_MS || live.allowed === false)

/** P1 (4.14): Codex refuses ordinary usage and no credits can pay. `workspace`: a workspace limit or spend control. `credits`: the usable balance. */
export type HardStop = { stop: boolean; workspace?: string; credits?: string }

/**
 * P1 (4.14). A fresh live read: `allowed === false` and no usable credits. A workspace type or spend
 * control counts only with `allowed === false`. With no fresh live read, the rollout arm: a kind of the
 * newest codex reading at 100% or more with no usable credits, while its reset is ahead and the line is
 * younger than one window of that kind.
 */
export function hardStopOf(i: { live?: LiveRead; newestRollout?: { snapshot: CodexSnapshot; at: number }; now: number }): HardStop {
  const live = i.live !== undefined && i.now - i.live.at < HARD_STOP_MAX_AGE_MS ? i.live : undefined
  if (live !== undefined) {
    const paid = usableCredits(live.credits)
    const out: HardStop = { stop: live.allowed === false && !paid }
    if (live.allowed === false) {
      if (typeof live.reached === 'string' && live.reached.startsWith('workspace_')) out.workspace = live.reached
      else if (live.spendControl === true) out.workspace = 'spend control'
    }
    const balance = live.credits?.balance
    if (paid && typeof balance === 'string') out.credits = balance
    return out
  }
  const r = i.newestRollout
  if (r === undefined || !isCodexBucket(r.snapshot)) return { stop: false }
  const paid = usableCredits(r.snapshot.credits)
  const full = codexLimits(r.snapshot).some((l) => {
    const reset = l.resetsAt === undefined ? Number.NaN : Date.parse(l.resetsAt)
    const kind: Kind = l.kind === 'seven_day' ? 'seven_day' : 'five_hour'
    return l.percentUsed >= 100 && reset > i.now && i.now - r.at < windowMs(kind)
  })
  const out: HardStop = { stop: full && !paid }
  const balance = r.snapshot.credits?.balance
  if (paid && typeof balance === 'string') out.credits = balance
  return out
}

// ---- Attendance and host (3.9, 3.10) ----

export type HostKind = 'daemon' | 'app-server' | 'exec' | 'tui' | 'unknown'

// Top-level and TUI options of codex that take their value as the next word.
const VALUE_FLAGS = new Set([
  '-c',
  '--config',
  '-m',
  '--model',
  '-p',
  '--profile',
  '-s',
  '--sandbox',
  '-a',
  '--ask-for-approval',
  '-i',
  '--image',
  '-C',
  '--cd',
  '--add-dir',
  '--local-provider',
  '--enable',
  '--disable',
  '--remote',
  '--remote-auth-token-env',
])

/**
 * The kind of the host process from its command line (`ps -o args=`). `app-server` that listens on a
 * socket (`--listen unix://...`, `ws://...`) or runs as the managed daemon: daemon. `app-server` on
 * stdio: app-server (desktop, IDE, SDK). `exec`, `e` or `review`: exec. Any other command: the TUI. An
 * empty line (no `ps`): unknown.
 */
export function hostKindOf(parentArgs: string): HostKind {
  const words = parentArgs.trim().split(/\s+/).filter((w) => w !== '')
  if (words.length === 0) return 'unknown'
  // The program is the first word whose file name starts with codex: its path can hold spaces.
  const program = words.findIndex((w) => /^codex/i.test(w.slice(w.lastIndexOf('/') + 1)))
  for (let i = (program < 0 ? 0 : program) + 1; i < words.length; i += 1) {
    const w = words[i] ?? ''
    if (w === '--') return 'tui'
    if (w.startsWith('-')) {
      if (!w.includes('=') && VALUE_FLAGS.has(w)) i += 1
      continue
    }
    if (w === 'exec' || w === 'e' || w === 'review') return 'exec'
    if (w !== 'app-server') return 'tui'
    const rest = words.slice(i + 1)
    if (rest.includes('--managed-daemon')) return 'daemon'
    const at = rest.findIndex((r) => r === '--listen' || r.startsWith('--listen='))
    const url = at < 0 ? '' : (rest[at] ?? '').startsWith('--listen=') ? (rest[at] ?? '').slice('--listen='.length) : (rest[at + 1] ?? '')
    return /^(unix|ws|wss):\/\//i.test(url) ? 'daemon' : 'app-server'
  }
  return 'tui'
}

/** The originators of the Codex apps that nobody watches (3.10). */
export const UNATTENDED_ORIGINATORS: readonly string[] = ['codex_exec', 'codex_sdk_ts', 'Codex Desktop', 'codex_vscode']

/**
 * 3.10, A21: whether a person watches this thread. An exec host never. A thread with no rollout (an
 * ephemeral thread) on a TUI or the daemon, unless approval is `never`. With no session_meta: the TUI
 * only. Source `exec`: never. The TUI's originator or source `cli`: yes. On the daemon, an originator
 * that no known unattended app uses counts as attended (fail closed) and warns (CX43).
 */
export function attendedFrom(i: {
  meta?: { type?: string; originator?: string; source?: unknown }
  transcriptNull: boolean
  mode?: string
  hostKind: HostKind
}): { attended: boolean; warnOriginator?: string } {
  if (i.hostKind === 'exec') return { attended: false }
  if (i.transcriptNull) return { attended: i.mode !== 'bypassPermissions' && (i.hostKind === 'tui' || i.hostKind === 'daemon') }
  const m = i.meta
  if (m === undefined || (m.type !== undefined && m.type !== 'session_meta')) return { attended: i.hostKind === 'tui' }
  if (m.source === 'exec') return { attended: false }
  if (m.originator === 'codex-tui' || m.source === 'cli') return { attended: true }
  if (i.hostKind === 'daemon' && (m.originator === undefined || !UNATTENDED_ORIGINATORS.includes(m.originator))) {
    return { attended: true, warnOriginator: m.originator ?? 'an unknown app' }
  }
  return { attended: false }
}

/** P1 (CX9): the agent can send prompts for the person, or write spare10's files, in this turn. */
export function unsafeMode(tc: TurnContextFacts | undefined, dataDir: string): boolean {
  if (tc === undefined) return false
  if (tc.sandbox === 'danger-full-access' || tc.sandbox === 'external-sandbox') return true
  if (tc.profile === 'disabled') return true
  if (tc.reviewer === 'auto_review' && (tc.approval === 'on-request' || tc.approval === 'untrusted')) return true
  return tc.roots.some((r) => within(dataDir, r))
}

// macOS keeps /tmp and /var under /private: compare both forms.
const bare = (p: string): string => {
  const t = p.replace(/\/+$/, '')
  return t.startsWith('/private/') ? t.slice('/private'.length) : t === '' ? '/' : t
}
const within = (path: string, root: string): boolean => {
  const p = bare(path)
  const r = bare(root)
  return r === '/' || p === r || p.startsWith(`${r}/`)
}

// ---- Commands and options (2.8, 5.1) ----

export type OptionName =
  | 'reserve'
  | 'weeklyReserve'
  | 'lastMinutes'
  | 'weeklyLastHours'
  | 'resumeFloor'
  | 'weeklyResumeFloor'
  | 'pausePrompt'
  | 'autoResume'
  | 'headless'
  | 'scope'

/** 5.1: a boolean as it is, "on" is true and "off" is false. Anything else is bad. */
export function parseAutoResumeOption(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw
  const s = parseSwitch(raw)
  return s === undefined ? undefined : s === 'on'
}

/** 5.1: any text. A blank text is no pause prompt (null). A value that is not text is bad. */
const parsePauseOption = (raw: unknown): string | null | undefined => (typeof raw === 'string' ? parsePausePrompt(raw) : undefined)

/** The ten options of config.json (5.1): the variable that wins over each, its range text and its file parser. */
export const OPTIONS: ReadonlyArray<{
  name: OptionName
  env: string
  range: string
  parse: (raw: unknown) => string | number | boolean | null | undefined
}> = [
  { name: 'reserve', env: 'SPARE10_RESERVE', range: '1 to 99', parse: parseReserve },
  { name: 'weeklyReserve', env: 'SPARE10_WEEKLY_RESERVE', range: '0, or 1 to 99', parse: parseWeeklyReserve },
  { name: 'lastMinutes', env: 'SPARE10_LAST_MINUTES', range: '0 to 299', parse: parseLastMinutes },
  { name: 'weeklyLastHours', env: 'SPARE10_WEEKLY_LAST_HOURS', range: '0 to 167', parse: parseWeeklyLastHours },
  { name: 'resumeFloor', env: 'SPARE10_RESUME_FLOOR', range: '0 to 99', parse: parseResumeFloor },
  { name: 'weeklyResumeFloor', env: 'SPARE10_WEEKLY_RESUME_FLOOR', range: '0 to 99', parse: parseResumeFloor },
  { name: 'pausePrompt', env: 'SPARE10_PAUSE_PROMPT', range: 'any text', parse: parsePauseOption },
  { name: 'autoResume', env: 'SPARE10_AUTO_RESUME', range: 'on or off', parse: parseAutoResumeOption },
  { name: 'headless', env: 'SPARE10_HEADLESS', range: 'off, prompt, stop or wait', parse: parseHeadless },
  { name: 'scope', env: 'SPARE10', range: 'all or opt-in', parse: parseScope },
]

/** The option of a name, in any case. */
export const optionOf = (name: string): (typeof OPTIONS)[number] | undefined => OPTIONS.find((o) => o.name.toLowerCase() === name.toLowerCase())

/** An option value as the texts show it: 15, on, wait, an empty text, or a quoted pause prompt. */
export function optionText(name: OptionName, value: string | number | boolean | null | undefined): string {
  if (name === 'autoResume') return value === false ? 'off' : 'on'
  if (name === 'pausePrompt') return typeof value === 'string' && value.trim() !== '' ? JSON.stringify(value) : 'an empty text'
  if (typeof value === 'number') return fmtPct(value)
  return String(value ?? '')
}

/** The default of an option, as optionText shows it. */
export const defaultText = (name: OptionName): string => optionText(name, DEFAULTS[name])

/**
 * config.json as plugin options (5.2). Each known key goes through its file parser. A bad value warns
 * (CX11) and is left out, so fromOptions gives its default. Unknown keys are ignored. A value that is
 * not a JSON object gives no options and the CX12 warning: the caller then keeps each reserve until the
 * reset (spans 0).
 */
export function configOptions(path: string, raw: unknown): { options: PluginOptions; warnings: string[] } {
  if (!isObject(raw)) return { options: {}, warnings: [codexText.configUnread(path, 'it is not a JSON object')] }
  const options: Record<string, string | number | boolean> = {}
  const warnings: string[] = []
  for (const o of OPTIONS) {
    if (!Object.prototype.hasOwnProperty.call(raw, o.name) || raw[o.name] === undefined) continue
    const v = o.parse(raw[o.name])
    if (v === undefined) warnings.push(codexText.configBad(path, o.name, raw[o.name], o.range, defaultText(o.name)))
    else options[o.name] = v === null ? '' : v
  }
  return { options, warnings }
}

/** The typed words of `spare10 set <option> <value>` as the stored JSON value (5.1). */
export function parseSetValue(name: OptionName, raw: string): { ok: true; value: string | number | boolean } | { ok: false } {
  if (name === 'pausePrompt') return raw.trim() === '' ? { ok: false } : { ok: true, value: raw }
  const o = OPTIONS.find((x) => x.name === name)
  const v = o?.parse(raw)
  if (v === undefined || v === null) return { ok: false }
  return { ok: true, value: v }
}

export type Command =
  | { verb: 'status' | 'help' | 'resume' | 'stop' | 'simulate' | 'set'; words: string[]; rest: string }
  | { verb: 'unknown'; word: string }
  | { verb: 'unknownOption'; word: string }

/** The largest prompt that is a bad simulate command, in words (2.8). */
const SIMULATE_MAX_WORDS = 6

/**
 * 2.8: a typed prompt as a spare10 command, or undefined for an ordinary prompt. Only the exact forms
 * are commands: the whole prompt is one line, and its first word is spare10 in any case. For `set`,
 * `words` is the option name and the value words, and `rest` is the value, verbatim.
 */
export function parseCommand(prompt: string): Command | undefined {
  const text = prompt.trim()
  if (/[\r\n]/.test(text)) return undefined
  const words = text.split(/\s+/).filter((w) => w !== '')
  if ((words[0] ?? '').toLowerCase() !== 'spare10') return undefined
  if (words.length === 1) return { verb: 'status', words: [], rest: '' }
  const verb = (words[1] ?? '').toLowerCase()
  const after = (n: number): string => {
    // The text after the first n words, verbatim.
    let rest = text
    for (let i = 0; i < n; i += 1) rest = rest.replace(/^\S+\s*/, '')
    return rest
  }
  if (verb === 'simulate') {
    const args = words.slice(2)
    if (parseSimulate(args) !== undefined || words.length <= SIMULATE_MAX_WORDS) return { verb: 'simulate', words: args, rest: after(2) }
    return undefined
  }
  if (verb === 'set') {
    if (words.length === 2) return { verb: 'set', words: [], rest: '' }
    const o = optionOf(words[2] ?? '')
    if (o !== undefined) return { verb: 'set', words: [o.name, ...words.slice(3)], rest: after(3) }
    return words.length === 3 ? { verb: 'unknownOption', word: words[2] ?? '' } : undefined
  }
  if (words.length !== 2) return undefined
  if (verb === 'status' || verb === 'help' || verb === 'resume' || verb === 'stop') return { verb, words: [], rest: '' }
  return { verb: 'unknown', word: words[1] ?? '' }
}

/** Only the person, in the root thread, may run these (2.8): resume, stop, simulate and a set that changes an option. */
export const rootOnly = (c: Command): boolean =>
  c.verb === 'resume' || c.verb === 'stop' || c.verb === 'simulate' || (c.verb === 'set' && c.words.length > 0)

// ---- The question (2.2) ----

/** The elicitation form of 2.2: one enum field, Stop here first and the default. CX46 names the credit balance. */
export function elicitParams(message: string, credits?: string): { message: string; requestedSchema: object } {
  return {
    message: credits === undefined ? message : `${message} ${codexText.creditsQuestion(credits)}`,
    requestedSchema: {
      type: 'object',
      required: ['choice'],
      properties: {
        choice: {
          type: 'string',
          title: HEADER,
          oneOf: [
            { const: 'stop', title: QUESTION_OPTIONS[0] },
            { const: 'resume', title: QUESTION_OPTIONS[1] },
          ],
          default: 'stop',
        },
      },
    },
  }
}

export type Answer = 'resume' | 'stop' | 'cancel' | 'decline'

/**
 * 2.2: an elicitation result. `accept` with `resume` is Resume, any other accept is Stop here. `cancel`
 * is for the caller to read (Esc, or the step went away). `decline`, an error (`failed`) or a reply of
 * any other shape: no question could show. It is never read as the person's answer.
 */
export function answerOf(result: unknown, failed: boolean): Answer {
  if (failed || !isObject(result)) return 'decline'
  const action = result['action']
  if (action === 'accept') return isObject(result['content']) && result['content']['choice'] === 'resume' ? 'resume' : 'stop'
  if (action === 'cancel') return 'cancel'
  return 'decline'
}

// ---- The gate answer (3.3, 4.4) ----

export type GateSite = 'start' | 'prompt' | 'tool' | 'step' | 'compact' | 'spawn' | 'stop' | 'interrupt'
export type GateResult = { kind: 'pass'; context?: string } | { kind: 'deny'; text: string } | { kind: 'block'; text: string } | { kind: 'end'; text?: string }

const EVENT: Partial<Record<GateSite, string>> = { prompt: 'UserPromptSubmit', tool: 'PreToolUse', step: 'PostToolUse' }

/**
 * The gate answer text of 3.3, for every site and result. A refusal at a site that cannot refuse in its
 * own way takes the closest refusal of that site (fail closed): a prompt is blocked, a tool is denied,
 * a step gets the text as context, and Stop and PreCompact end the turn. SessionStart, SubagentStart and
 * Interrupt cannot refuse, so they pass. `systemMessage` (the prefixed transcript lines) rides any answer.
 */
export function render(site: GateSite, r: GateResult, systemMessage?: string): string {
  const out = ((): Record<string, unknown> | undefined => {
    const event = EVENT[site]
    if (r.kind === 'pass') {
      if (r.context === undefined || r.context === '' || event === undefined) return undefined
      return { hookSpecificOutput: { hookEventName: event, additionalContext: r.context } }
    }
    const text = r.text
    if (site === 'prompt') return { decision: 'block', reason: text ?? NOT_STARTED_GENERIC }
    if (site === 'tool') {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: text ?? STOP_GENERIC } }
    }
    if (site === 'step') return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text ?? STOP_GENERIC } }
    if (site === 'stop' || site === 'compact') return text === undefined || text === '' ? { continue: false } : { continue: false, stopReason: text }
    return undefined
  })()
  const withMessage = systemMessage === undefined || systemMessage === '' ? out : { ...(out ?? {}), systemMessage }
  return withMessage === undefined ? '' : JSON.stringify(withMessage)
}

export type RefuseMode = 'interrupt' | 'hold' | 'deny'

/**
 * 4.4: how a refused tool or step refuses. A held stop holds. A hosted attended thread is interrupted.
 * An attended auto stop that continues at the reset holds. A thread and turn that already got a deny
 * holds. Else one deny. Unattended runs take the last two rows. The prompt, compact and start sites
 * choose before this.
 */
export function refuseModeOf(i: { attended: boolean; noDialog: boolean; hosted: boolean; autoStop: boolean; autoResume: boolean; deniedThisTurn: boolean }): RefuseMode {
  if (i.noDialog) return 'hold'
  if (i.attended && i.hosted) return 'interrupt'
  if (i.attended && i.autoStop && i.autoResume) return 'hold'
  if (i.deniedThisTurn) return 'hold'
  return 'deny'
}

/** A12: the prefix that the Claude engine adds, added by the broker. Each line that has text gets it. */
export const withPrefix = (text: string): string =>
  text
    .split('\n')
    .map((l) => (l === '' ? l : `spare10: ${l}`))
    .join('\n')

// ---- Texts (CX1 to CX47) and debug lines ----

/** CX5 {Rs} and {quiet}: five_hour first, as the core texts read a list of Facts. */
const byWindow = (f: Facts | readonly Facts[]): Facts[] =>
  (Array.isArray(f) ? [...(f as readonly Facts[])] : [f as Facts]).sort((a, b) => Number(a.kind === 'seven_day') - Number(b.kind === 'seven_day'))

const envList = (set: ReadonlyArray<readonly [string, string]>): string => set.map(([name, raw]) => `${name}=${JSON.stringify(raw)}`).join(', ')

const HELP_WIDTH = 18

/**
 * The Codex-only texts. Transcript lines, warnings and command replies have no prefix: the broker adds
 * it (withPrefix). CX3, CX4, CX5, CX35, CX36, CX39, CX41 and CX44 keep their own `spare10: `. CX1 and
 * CX2 are the static hook status messages of codex/hooks.json.
 */
export const codexText = {
  /** CX1: the status message of the four gating hooks. */
  statusHold: 'spare10 checks the quota reserve. Esc stops a held step.',
  /** CX2: the status message of SessionStart. */
  statusStart: 'spare10 reads the quota.',
  /** CX3: the stopReason of a gate that ends the turn under a stop. */
  turnEnds: 'spare10: the turn ends here, because work stopped at the quota reserve.',
  /** CX41: the stopReason of a Stop gate at a hold verdict. */
  turnEndsHold: 'spare10: the turn ends here, because the quota reserve is reached. spare10 asks at your next prompt.',
  /** CX4: the context of a steered command that spare10 lets through. */
  steerNote: 'spare10: the last user line was a command for the spare10 plugin, and spare10 handled it. Ignore that line.',
  /** CX39: before B34, B9 or B35 when spare10 interrupted a turn of the stop. */
  interruptedNote: 'spare10: the note that the user interrupted the previous turn is not right. spare10 interrupted it at the quota reserve.',
  /** CX5: the drop reason of a prompt question that could not show. */
  notStartedNoDialog: (f: Facts | readonly Facts[]): string => {
    const fs = byWindow(f)
    return `spare10: not started. This session is inside ${yourReserves(fs)} ${untilText(fs)}, and Codex cannot show the spare10 question here. Run spare10 resume, then send the prompt again.`
  },
  /** CX6 (auto) and CX7: an attended session that the daemon does not host. */
  noDaemon: (auto: boolean): string =>
    auto
      ? 'this session does not run on the Codex daemon, so spare10 cannot end a turn or start one. After Stop here, spare10 holds the work in place until the stop ends. Press Esc to end the turn.'
      : 'this session does not run on the Codex daemon, so spare10 cannot end a turn or start one. After Stop here, each running loop gets one more model request to read the stop, and then waits.',
  /** CX8: approval never, so no form can show. */
  approvalNever:
    'Codex runs with approval never here, so spare10 cannot show its question. At a reserve, spare10 holds the work instead. Press Esc to stop it, or run !spare10 resume to continue (spare10 help says how).',
  /** CX9 (P1): the agent can act for the person. */
  unsafe:
    "the agent can send prompts for you in this mode, or write spare10's files. So spare10 cannot tell your spare10 resume from one that the agent sends. Run Codex with a sandbox that keeps ~/.codex read-only to keep that choice yours.",
  /** CX10 (P1): SPARE10 variables in the env of the daemon. */
  daemonEnv: (set: ReadonlyArray<readonly [string, string]>): string =>
    `this session runs on the Codex daemon, which has ${envList(set)}. A daemon session gets such values from the environment of the daemon when it started, not from your terminal. To change them, restart the Codex daemon, or run codex --no-daemon.`,
  /** CX11: a bad value in config.json. */
  configBad: (path: string, name: string, raw: unknown, range: string, used: string): string =>
    `${path} sets ${name} to ${JSON.stringify(raw) ?? String(raw)}, which is not ${range}. spare10 uses ${used}.`,
  /** CX12: config.json exists but does not parse. */
  configUnread: (path: string, err: string): string =>
    `cannot read ${path} (${err}). spare10 uses the default options, and keeps each reserve until the reset.`,
  /** CX13: only a weekly window, and the weekly reserve is 0. */
  weeklyOnlyOff: 'Codex reports only a weekly window, and the weekly reserve is 0. So spare10 watches no window.',
  /** CX40: only a weekly window, with a weekly open span. */
  weeklyOnlyOpen: (hours: number): string =>
    `Codex reports only a weekly window here. In the last ${fmtPct(hours)} h before the weekly reset, spare10 lets all work through. To keep the weekly reserve until the reset, run spare10 set weeklyLastHours 0.`,
  /** CX42: scope opt-in on the daemon, and no SPARE10 in the env. */
  optInDaemon:
    'scope is set to opt-in, and this session runs on the Codex daemon, so spare10 only watches here. To guard a session, run codex --no-daemon with SPARE10=on, or run spare10 set scope all.',
  /** CX43: an unknown app started this session on the daemon. */
  originator: (name: string): string =>
    `this session was started by ${name}, not by the Codex TUI. spare10 treats it as attended. If ${name} cannot show the spare10 question, spare10 holds the work at the reserve.`,
  /** CX14 (P1, report only): a hard stop. */
  hardStop: 'Codex reports that your included usage is used up. spare10 asks nothing, and continues no work, until Codex allows usage again. Work on Luna Reserve goes through.',
  /** CX15 (P1, report only): a workspace limit. */
  workspaceLimit: (type: string): string => `Codex reports a workspace limit (${type}). spare10 continues no work until Codex allows it.`,
  /** CX16 (report only): a watched kind at 100% or more, and credits are usable. */
  credits: (balance: string): string => `past 100% used, Codex spends your credits. The balance is ${balance}.`,
  /** CX46: appended to the question. */
  creditsQuestion: (balance: string): string => `Past 100% used, Codex spends your credits. The balance is ${balance}.`,
  /** CX18: a held prompt of a broker whose host is gone. */
  promptLost: 'Codex stopped while spare10 held your prompt, so Codex dropped it. Send it again.',
  /** CX19: once per data dir, how to run a command during a turn. */
  cliHint: (launcher: string, dir: string): string =>
    `to run a spare10 command during a turn, type !${launcher} status in the prompt. For the short form !spare10 status, add export PATH="${dir}:$PATH" to ~/.zshrc or ~/.bashrc, then start a new Codex session.`,
  /** CX20, CX21, CX22: the report row `daemon`. */
  daemonRow: (hosted: boolean, auto: boolean): string =>
    hosted
      ? 'yes. spare10 can end a turn and start one.'
      : auto
        ? 'no. After Stop here, spare10 holds the work in place.'
        : 'no. After Stop here, each running loop gets one more model request.',
  /** CX45: the CLI row `daemon` with no session. */
  daemonReach: (found: boolean): string => (found ? 'reachable' : 'not found'),
  /** CX47: the CLI row `broker`. */
  brokerRow: (running: boolean): string => (running ? 'running' : 'not running: spare10 does not guard this session now.'),
  /** CX23: the report row `live read`. */
  liveRow: (i: { agoMs?: number; error?: string }): string =>
    i.agoMs !== undefined ? `from the Codex daemon, ${fmtDuration(i.agoMs)} ago` : i.error !== undefined ? `none: ${i.error}` : 'none yet',
  /** CX25: a help line. */
  helpSet: `${'spare10 set'.padEnd(HELP_WIDTH)}change an option, such as spare10 set reserve 15`,
  /** CX26: a help line. */
  helpAnytime: `${'!spare10 status'.padEnd(HELP_WIDTH)}run a command during a turn (see spare10 help)`,
  /** CX27 */
  setOk: (name: string, value: string, old: string): string => `${name} is now ${value}. It was ${old}. It applies from the next step.`,
  /** CX28 */
  setDefault: (name: string, value: string): string => `${name} is back to its default, ${value}. It applies from the next step.`,
  /** CX29: appended to CX27 or CX28, so it starts with a space. */
  setEnvWins: (env: string): string => ` ${env} is set here, and it wins over the option. On the Codex daemon, restart the daemon to clear it.`,
  /** CX30 */
  setBad: (name: string, range: string): string => `${name} takes ${range}. Nothing changed.`,
  /** CX31 */
  setUnknown: (name: string): string =>
    `unknown option "${name}". The options are reserve, weeklyReserve, lastMinutes, weeklyLastHours, resumeFloor, weeklyResumeFloor, pausePrompt, autoResume, headless and scope.`,
  /** CX32 */
  setFailed: (path: string, err: string): string => `could not write ${path}: ${err}. Nothing changed.`,
  /** CX33: rows of [name, value, source]. */
  setList: (path: string, rows: ReadonlyArray<readonly [string, string, string]>): string =>
    [
      `options, from ${path}:`,
      ...rows.map(([name, value, source]) => `  · ${name.padEnd(HELP_WIDTH)}${value} (${source})`),
      'Change one with spare10 set <option> <value>, or spare10 set <option> default.',
    ].join('\n'),
  /** CX34: `spare10 help`. `dir` is the folder of the launcher. */
  help: (dir: string): string =>
    [
      'commands, typed as the whole prompt:',
      `${'spare10'.padEnd(HELP_WIDTH)}show the status`,
      `${'spare10 resume'.padEnd(HELP_WIDTH)}continue on the reserve`,
      `${'spare10 stop'.padEnd(HELP_WIDTH)}stop at the reserve now`,
      `${'spare10 simulate'.padEnd(HELP_WIDTH)}set a test reading, such as spare10 simulate 92`,
      `${'spare10 set'.padEnd(HELP_WIDTH)}show or change the options`,
      'During a turn, run them as !spare10 ... in the prompt. This needs the spare10 folder on your PATH:',
      `add export PATH="${dir}:$PATH" to ~/.zshrc or ~/.bashrc, then start a new Codex session.`,
      'Codex gives the output of a ! command to the model.',
    ].join('\n'),
  /** CX44: the CLI line from `!`. */
  cliDone: (verb: string): string => `spare10: ${verb} done. The details show in the Codex transcript.`,
  /** CX35: the agent ran the CLI. */
  cliSandbox: (verb: string): string => `spare10: run this as !spare10 ${verb} in the Codex prompt. The agent cannot run it.`,
  /** CX36: no session named. Rows of [id, cwd, phase]. */
  cliNoSession: (verb: string, rows: ReadonlyArray<readonly [string, string, string]>): string =>
    [
      `spare10: name the session. Run this as !spare10 ${verb} in the Codex prompt, or add --session <id>. Sessions of the last 24 h:`,
      ...rows.map(([id, cwd, phase]) => `  · ${id}  ${cwd}  ${phase}`),
    ].join('\n'),
  /** CX37 */
  cliUsage:
    'usage: spare10 [status [--full]|help|resume|stop|simulate <words>|set [<option> [<value>]]] [--session <id>] [--codex-home <dir>] [--data <dir>]',
  /** CX38 (P1): the CLI row `hooks`. */
  hooksRow: (trusted: number, total: number): string =>
    trusted >= total ? `all ${total} trusted` : `${trusted} of ${total} trusted. Start codex and trust the spare10 hooks, or run /hooks.`,
}

/** Debug lines of the broker log. They keep their own `spare10: `. */
export const codexDebug = {
  gateError: (e: string): string => `spare10: the gate failed: ${e}`,
  interruptFailed: (e: string): string => `spare10: turn/interrupt failed: ${e}`,
  startFailed: (e: string): string => `spare10: turn/start failed: ${e}`,
  liveFailed: (route: string, e: string): string => `spare10: the live read (${route}) failed: ${e}`,
  simulateIgnored: 'spare10: SPARE10_SIMULATE ignored on a shared host.',
  dropped: (n: number): string => `spare10: ${n} held call(s) dropped.`,
  swept: (n: number): string => `spare10: the stop sweep interrupted ${n} turn(s).`,
  recovery: (n: number): string => `spare10: recovery of ${n} held call(s).`,
  /** A best-effort read of the adapter failed: the step goes on without it. */
  readFailed: (what: string, e: string): string => `spare10: could not read ${what}: ${e}`,
  /** A best-effort write of the adapter failed: the next step tries again. */
  writeFailed: (what: string, e: string): string => `spare10: could not write ${what}: ${e}`,
  /** A waiter of the Wake source threw. The other waiters still wake. */
  wakeFailed: (e: string): string => `spare10: a wake waiter failed: ${e}`,
  /** fs.watch of a session folder failed. The 1 s poll still wakes the waiters. */
  watchFailed: (dir: string, e: string): string => `spare10: the watch of ${dir} failed, and the poll goes on: ${e}`,
  /** The MCP server read a line that is not a JSON-RPC message. It ignores the line. */
  mcpBadLine: (e: string): string => `spare10: an MCP input line was ignored: ${e}`,
  /** The MCP server could not encode a message. It sends nothing. */
  mcpBadOut: (e: string): string => `spare10: an MCP message could not be sent: ${e}`,
  /** A write to the MCP output failed. The server shuts down. */
  mcpOutputFailed: (e: string): string => `spare10: the MCP output failed: ${e}`,
  /** The MCP server shuts down, with this many calls still open. */
  mcpClosed: (why: string, open: number): string => `spare10: the MCP server shuts down (${why}), with ${open} open call(s).`,
  /** Codex cancelled a gate call. It gets no answer. */
  cancelled: (id: string): string => `spare10: Codex cancelled the call ${id}.`,
  /** The background work of a broker starts. `guard`: SPARE10_CODEX_TEST reached it (D10), so no path under ~/.codex can open. */
  boot: (version: string, guard: boolean): string => `spare10: the broker ${version} starts, and the test guard is ${guard ? 'on' : 'off'}.`,
}
