import type { SessionRateLimit } from 'claude-code'

// The reading rule of the gate (design section 6), as pure functions. No $ here: register.tsx feeds
// in what $.session.usage(), session.measure, $.store and the clock said. 0.2: one rule per kind.

/** A window as SessionRateLimit.kind names it. Texts say 5-hour and weekly. */
export type Kind = 'five_hour' | 'seven_day'

/** The watched kinds, five_hour first. */
export const KINDS: readonly Kind[] = ['five_hour', 'seven_day']

/** A reading with the window it belongs to. */
export type Anchored = { pct: number; resetsAtMs: number }

/** What this copy of the module remembers of one kind: the newest reading with a reset, the blind count, and the first sight of a reading without a reset. */
export type Memory = { seed?: Anchored; misses: number; noReset?: { since: number; pct: number } }

export type Basis =
  | { kind: 'live' | 'seed' | 'test'; pct: number; resetsAtMs: number | null }
  | { kind: 'none'; why: 'no-reading' | 'window-reset' | 'blind' }

/** One five-hour window plus a minute of clock slack: no reset is further away than this. */
export const WINDOW_MS = 5 * 3_600_000 + 60_000

/** The weekly window. */
export const WEEK_MS = 7 * 24 * 3_600_000

/** A release waits this long after a real reset (4.8). */
export const RESET_MARGIN_MS = 300_000

/** A release waits this long after the end of a test window (4.8). */
export const TEST_MARGIN_MS = 60_000

/** Two response-backed measures with no window: one can be a turn that ended just past a reset. */
export const BLIND_AFTER = 2

/** spare10's one-hour fallback when a reading has no reset time. It bounds consent and stopped only. */
export const FALLBACK_MS = 3_600_000

/** The window of a test reading that has no live reset to borrow. */
export const TEST_WINDOW_MS = 5 * 3_600_000

/** The length of a window: 5 h or 7 d. */
export const windowMs = (kind: Kind): number => (kind === 'seven_day' ? WEEK_MS : 5 * 3_600_000)

const kindOfLimit = (live: SessionRateLimit): Kind => (live.kind === 'seven_day' ? 'seven_day' : 'five_hour')

export const initialMemory = (): Memory => ({ misses: 0 })

export const limitOf = (list: readonly SessionRateLimit[], kind: Kind): SessionRateLimit | undefined =>
  list.find((r) => r.kind === kind)

export const fiveHour = (list: readonly SessionRateLimit[]): SessionRateLimit | undefined => limitOf(list, 'five_hour')

export function parseReset(iso: string | undefined): number | null {
  if (iso === undefined) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/** A live reading as something to remember. A reading without a reset time is never remembered. */
export function anchoredOf(live: SessionRateLimit): Anchored | undefined {
  const resetsAtMs = parseReset(live.resetsAt)
  return resetsAtMs === null ? undefined : { pct: live.percentUsed, resetsAtMs }
}

/** A remembered reading counts while its window is open, and never for longer than one window of its kind. */
export const inWindow = (r: Anchored, now: number, kind: Kind = 'five_hour'): boolean =>
  now < r.resetsAtMs && r.resetsAtMs - now <= windowMs(kind) + 60_000

/** The later window wins, then the higher percentage. */
export function newer(a: Anchored | undefined, b: Anchored | undefined): Anchored | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  if (a.resetsAtMs !== b.resetsAtMs) return a.resetsAtMs > b.resetsAtMs ? a : b
  return b.pct > a.pct ? b : a
}

/** What the gate decides on at `now`: live, then blind, then the remembered reading, then none. */
export function basis(live: SessionRateLimit | undefined, mem: Memory, now: number, test?: Anchored, kind: Kind = 'five_hour'): Basis {
  const b = realBasis(live, mem, now, kind)
  if (test === undefined || !inWindow(test, now, kind)) return b
  if (b.kind === 'none' || test.pct > b.pct) return { kind: 'test', pct: test.pct, resetsAtMs: test.resetsAtMs }
  return b
}

function realBasis(live: SessionRateLimit | undefined, mem: Memory, now: number, kind: Kind): Basis {
  if (live !== undefined) {
    // Live always wins over anything remembered, never max(live, remembered).
    const resetsAtMs = parseReset(live.resetsAt)
    if (resetsAtMs !== null && now >= resetsAtMs) return { kind: 'none', why: 'window-reset' }
    // Without a reset time, a figure unchanged for one window since its first sight is stale (3.1).
    const n = mem.noReset
    if (resetsAtMs === null && n !== undefined && now >= n.since + windowMs(kind) && live.percentUsed === n.pct) {
      return { kind: 'none', why: 'window-reset' }
    }
    return { kind: 'live', pct: live.percentUsed, resetsAtMs }
  }
  if (mem.misses >= BLIND_AFTER) return { kind: 'none', why: 'blind' }
  if (mem.seed !== undefined && inWindow(mem.seed, now, kind)) return { kind: 'seed', ...mem.seed }
  const expired = mem.seed !== undefined && now >= mem.seed.resetsAtMs
  return { kind: 'none', why: expired ? 'window-reset' : 'no-reading' }
}

/** A live reading arrived (a gate read or a measure). With `now`, it also tracks the first sight of a reading without a reset. */
export function sawLive(mem: Memory, live: SessionRateLimit, now?: number): Memory {
  const seed = newer(mem.seed, anchoredOf(live))
  const noReset = now === undefined ? mem.noReset : firstSight(mem.noReset, live, now)
  return { ...(seed === undefined ? {} : { seed }), misses: 0, ...(noReset === undefined ? {} : { noReset }) }
}

// A fall means a new window, and so does a new figure one window after the first sight. A rise keeps it.
function firstSight(n: Memory['noReset'], live: SessionRateLimit, now: number): Memory['noReset'] {
  if (parseReset(live.resetsAt) !== null) return undefined
  const pct = live.percentUsed
  if (n === undefined || pct < n.pct) return { since: now, pct }
  if (pct === n.pct) return n
  if (now >= n.since + windowMs(kindOfLimit(live))) return { since: now, pct }
  return { since: n.since, pct }
}

/**
 * A session.measure arrived. `cost` in `changed` means a billed response completed. If the engine
 * still lists no window of this kind, that response carried none: one miss.
 */
export function sawMeasure(
  mem: Memory,
  e: { rateLimits: readonly SessionRateLimit[]; changed: readonly string[] },
  kind: Kind = 'five_hour',
  now?: number,
): Memory {
  const live = limitOf(e.rateLimits, kind)
  if (live !== undefined) return sawLive(mem, live, now)
  if (!e.changed.includes('cost')) return mem
  return { ...mem, misses: mem.misses + 1 }
}

/** A value read back from $.store, validated. Anything else is no seed. */
export function asAnchored(v: unknown): Anchored | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const { pct, resetsAtMs } = v as Record<string, unknown>
  return typeof pct === 'number' && Number.isFinite(pct) && typeof resetsAtMs === 'number' && Number.isFinite(resetsAtMs)
    ? { pct, resetsAtMs }
    : undefined
}

/** B48: the floor point, 100 - floor on the one-decimal grid: 95 for 5, 97.5 for 2.5, 89.4 for 10.6. */
export const pointOf = (floor: number): number => Math.round((100 - floor) * 10) / 10

// The trip point on the one-decimal grid, so 100 - 10.6 is 89.4 and not 89.40000000000001.
const tripAt = (reserve: number): number => pointOf(reserve)

/** The first point of the reserve trips: reserve 10 trips at 90.0 and passes at 89.9. */
export const isTripped = (b: Basis, reserve: number): boolean => b.kind !== 'none' && b.pct >= tripAt(reserve)

/** B48: a basis at or past a floor point. None with no point, and never for a none basis. */
export const atPoint = (b: Basis, point: number | null): boolean => point !== null && b.kind !== 'none' && b.pct >= point

/**
 * 4.8: the last real reading of a kind was in the reserve, and its window reset less than
 * RESET_MARGIN_MS ago. The local clock may run ahead of the server, so spare10 releases nothing by
 * itself yet, also when a test window ends first.
 */
export const inResetMargin = (seed: Anchored | undefined, reserve: number, now: number): boolean =>
  seed !== undefined && seed.resetsAtMs <= now && now - seed.resetsAtMs < RESET_MARGIN_MS && seed.pct >= tripAt(reserve)

export const pctOf = (b: Basis): number | undefined => (b.kind === 'none' ? undefined : b.pct)

/** The window end that bounds consent and stopped. Never a release time for held work. */
export const windowEndOf = (b: Basis, now: number): number =>
  b.kind !== 'none' && b.resetsAtMs !== null ? b.resetsAtMs : now + FALLBACK_MS

/** The hold end (3.1): the reset time, else the first sight plus one window. Never the one-hour fallback. */
export function holdEndOf(b: Basis, mem: Memory, now: number, kind: Kind = 'five_hour'): number {
  if (b.kind === 'none') return now + windowMs(kind)
  if (b.resetsAtMs !== null) return b.resetsAtMs
  return (mem.noReset?.since ?? now) + windowMs(kind)
}

// ---- Skip near the reset (B41, B42, B45) ----

/** The skip start of a basis: its reset minus the span. Null when the span is 0 or the reset is unknown. */
export function skipStartOf(b: Basis, spanMs: number): number | null {
  if (!(spanMs > 0) || b.kind === 'none' || b.resetsAtMs === null) return null
  return b.resetsAtMs - spanMs
}

/** One kind at now: the basis it rests on, whether it is tripped, its skip start while ahead, and whether it is open. */
export type KindView = { basis: Basis; tripped: boolean; skipAt: number | null; open: boolean }

/**
 * One kind at now (B41, B45). A kind is open when it is tripped and its skip start has come. A kind
 * without a reset time is never open (fail safe). A test reading in its skip window yields to a real
 * trip that is not open, so a test reading never releases a real hold.
 */
export function viewOf(real: Basis, withTest: Basis, reserve: number, spanMs: number, now: number): KindView {
  const one = (b: Basis): KindView => {
    const tripped = isTripped(b, reserve)
    const start = skipStartOf(b, spanMs)
    return { basis: b, tripped, skipAt: start !== null && now < start ? start : null, open: tripped && start !== null && now >= start }
  }
  const v = one(withTest)
  if (withTest.kind !== 'test' || !v.open) return v
  const r = one(real)
  return r.tripped && !r.open ? r : v
}

/** The release margin (4.7): 0 at a skip start, 60 s after a test window, 5 min after a real reset. */
export const marginOf = (skip: boolean, test: boolean): number => (skip ? 0 : test ? TEST_MARGIN_MS : RESET_MARGIN_MS)

/** SPARE10_SIMULATE and /spare10 simulate: 0 to 100, rounded to one decimal. Junk is none. */
export function parseTestPct(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw.trim())
  if (!Number.isFinite(n)) return undefined
  const r = Math.round(n * 10) / 10
  return r >= 0 && r <= 100 ? r : undefined
}

/** A test reading: its percentage, its kind, and when set, the time to its reset. */
export type TestSpec = { pct: number; kind: Kind; inMs?: number }

const UNIT_MS = new Map<string, number>([
  ['s', 1_000],
  ['m', 60_000],
  ['h', 3_600_000],
  ['d', 86_400_000],
])

/** `90s`, `2m`, `3h` or `1d`, any case. Under 10 s is none. */
export function parseDuration(word: string): number | undefined {
  const m = /^(\d+)([smhd])$/i.exec(word.trim())
  if (m === null) return undefined
  const ms = Number(m[1]) * (UNIT_MS.get((m[2] ?? '').toLowerCase()) ?? Number.NaN)
  return Number.isFinite(ms) && ms >= 10_000 ? ms : undefined
}

const KIND_WORDS = new Map<string, Kind>([
  ['5h', 'five_hour'],
  ['5-hour', 'five_hour'],
  ['five_hour', 'five_hour'],
  ['weekly', 'seven_day'],
  ['7d', 'seven_day'],
  ['seven_day', 'seven_day'],
])

/** The 2.9 grammar: `off`, or a percentage, then a kind word and `in {n}{s|m|h|d}` in either order. */
export function parseSimulate(words: readonly string[]): TestSpec | 'off' | undefined {
  const [first, ...rest] = words
  if (first === undefined) return undefined
  if (first.toLowerCase() === 'off') return rest.length === 0 ? 'off' : undefined
  const pct = parseTestPct(first)
  if (pct === undefined) return undefined
  let kind: Kind | undefined
  let inMs: number | undefined
  for (let i = 0; i < rest.length; i += 1) {
    const w = (rest[i] ?? '').toLowerCase()
    const k = KIND_WORDS.get(w)
    if (k !== undefined && kind === undefined) {
      kind = k
      continue
    }
    const d = w === 'in' && inMs === undefined ? parseDuration(rest[i + 1] ?? '') : undefined
    if (d === undefined) return undefined
    inMs = d
    i += 1
  }
  const k = kind ?? 'five_hour'
  return inMs === undefined ? { pct, kind: k } : { pct, kind: k, inMs: Math.min(inMs, windowMs(k)) }
}

/** SPARE10_SIMULATE: the same words, split on white space. `off` and junk are no test reading. */
export function parseSimulateEnv(raw: string | undefined): TestSpec | undefined {
  const spec = parseSimulate((raw ?? '').trim().split(/\s+/).filter((w) => w !== ''))
  return spec === 'off' ? undefined : spec
}
