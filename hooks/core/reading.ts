import type { SessionRateLimit } from 'claude-code'

// The reading rule of the gate (design section 6), as pure functions. No $ here: register.tsx feeds
// in what $.session.usage(), session.measure, $.store and the clock said.

/** A five-hour reading with the window it belongs to. */
export type Anchored = { pct: number; resetsAtMs: number }

/** What this copy of the module remembers: the newest reading with a reset, and the blind count. */
export type Memory = { seed?: Anchored; misses: number }

export type Basis =
  | { kind: 'live' | 'seed' | 'test'; pct: number; resetsAtMs: number | null }
  | { kind: 'none'; why: 'no-reading' | 'window-reset' | 'blind' }

/** One five-hour window plus a minute of clock slack: no reset is further away than this. */
export const WINDOW_MS = 5 * 3_600_000 + 60_000

/** Two response-backed measures with no window: one can be a turn that ended just past a reset. */
export const BLIND_AFTER = 2

/** spare10's one-hour fallback when a reading has no reset time. It bounds consent and stopped only. */
export const FALLBACK_MS = 3_600_000

/** The window of a test reading that has no live reset to borrow. */
export const TEST_WINDOW_MS = 5 * 3_600_000

export const initialMemory = (): Memory => ({ misses: 0 })

export const fiveHour = (list: readonly SessionRateLimit[]): SessionRateLimit | undefined =>
  list.find((r) => r.kind === 'five_hour')

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

/** A remembered reading counts while its window is open, and never for longer than one window. */
export const inWindow = (r: Anchored, now: number): boolean => now < r.resetsAtMs && r.resetsAtMs - now <= WINDOW_MS

/** The later window wins, then the higher percentage. */
export function newer(a: Anchored | undefined, b: Anchored | undefined): Anchored | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  if (a.resetsAtMs !== b.resetsAtMs) return a.resetsAtMs > b.resetsAtMs ? a : b
  return b.pct > a.pct ? b : a
}

/** What the gate decides on at `now`: live, then blind, then the remembered reading, then none. */
export function basis(live: SessionRateLimit | undefined, mem: Memory, now: number, test?: Anchored): Basis {
  const b = realBasis(live, mem, now)
  if (test === undefined || !inWindow(test, now)) return b
  if (b.kind === 'none' || test.pct > b.pct) return { kind: 'test', pct: test.pct, resetsAtMs: test.resetsAtMs }
  return b
}

function realBasis(live: SessionRateLimit | undefined, mem: Memory, now: number): Basis {
  if (live !== undefined) {
    // Live always wins over anything remembered, never max(live, remembered).
    const resetsAtMs = parseReset(live.resetsAt)
    if (resetsAtMs !== null && now >= resetsAtMs) return { kind: 'none', why: 'window-reset' }
    return { kind: 'live', pct: live.percentUsed, resetsAtMs }
  }
  if (mem.misses >= BLIND_AFTER) return { kind: 'none', why: 'blind' }
  if (mem.seed !== undefined && inWindow(mem.seed, now)) return { kind: 'seed', ...mem.seed }
  const expired = mem.seed !== undefined && now >= mem.seed.resetsAtMs
  return { kind: 'none', why: expired ? 'window-reset' : 'no-reading' }
}

/** A live five-hour reading arrived (a gate read or a measure). */
export function sawLive(mem: Memory, live: SessionRateLimit): Memory {
  const seed = newer(mem.seed, anchoredOf(live))
  return seed === undefined ? { misses: 0 } : { seed, misses: 0 }
}

/**
 * A session.measure arrived. `cost` in `changed` means a billed response completed. If the engine
 * still lists no five_hour window, that response carried none: one miss.
 */
export function sawMeasure(mem: Memory, e: { rateLimits: readonly SessionRateLimit[]; changed: readonly string[] }): Memory {
  const live = fiveHour(e.rateLimits)
  if (live !== undefined) return sawLive(mem, live)
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

// The trip point on the one-decimal grid, so 100 - 10.6 is 89.4 and not 89.40000000000001.
const tripAt = (reserve: number): number => Math.round((100 - reserve) * 10) / 10

/** The first point of the reserve trips: reserve 10 trips at 90.0 and passes at 89.9. */
export const isTripped = (b: Basis, reserve: number): boolean => b.kind !== 'none' && b.pct >= tripAt(reserve)

export const pctOf = (b: Basis): number | undefined => (b.kind === 'none' ? undefined : b.pct)

/** The window end that bounds consent and stopped. Never a release time for held work. */
export const windowEndOf = (b: Basis, now: number): number =>
  b.kind !== 'none' && b.resetsAtMs !== null ? b.resetsAtMs : now + FALLBACK_MS

/** SPARE10_SIMULATE and /spare10 simulate: 0 to 100, rounded to one decimal. Junk is none. */
export function parseTestPct(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw.trim())
  if (!Number.isFinite(n)) return undefined
  const r = Math.round(n * 10) / 10
  return r >= 0 && r <= 100 ? r : undefined
}
