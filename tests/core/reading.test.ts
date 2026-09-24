import { test, expect } from 'claude-code/testing'
import type { SessionRateLimit } from 'claude-code'
import {
  BLIND_AFTER,
  FALLBACK_MS,
  KINDS,
  RESET_MARGIN_MS,
  TEST_MARGIN_MS,
  TEST_WINDOW_MS,
  WEEK_MS,
  WINDOW_MS,
  anchoredOf,
  asAnchored,
  basis,
  fiveHour,
  holdEndOf,
  inResetMargin,
  inWindow,
  initialMemory,
  isTripped,
  limitOf,
  newer,
  parseDuration,
  parseReset,
  parseSimulate,
  parseSimulateEnv,
  parseTestPct,
  pctOf,
  sawLive,
  sawMeasure,
  windowEndOf,
  windowMs,
} from '../../hooks/core/reading.ts'
import type { Basis, Memory } from '../../hooks/core/reading.ts'

const HOUR = 3_600_000
const T0 = Date.parse('2026-09-24T12:00:00Z')
const RESETS = '2026-09-24T15:00:00.000Z' // 3 h after T0
const R = Date.parse(RESETS)
const LATER = '2026-09-24T20:00:00.000Z'

const five = (percentUsed: number, resetsAt: string = RESETS): SessionRateLimit => ({ kind: 'five_hour', percentUsed, resetsAt })
const fiveNoReset = (percentUsed: number): SessionRateLimit => ({ kind: 'five_hour', percentUsed })
const week: SessionRateLimit = { kind: 'seven_day', percentUsed: 12, resetsAt: '2026-09-29T00:00:00.000Z' }
const seeded = (pct: number, resetsAtMs = R): Memory => ({ seed: { pct, resetsAtMs }, misses: 0 })

test('the constants are the design values', () => {
  expect(WINDOW_MS).toBe(5 * HOUR + 60_000)
  expect(BLIND_AFTER).toBe(2)
  expect(FALLBACK_MS).toBe(HOUR)
  expect(TEST_WINDOW_MS).toBe(5 * HOUR)
  expect(initialMemory()).toEqual({ misses: 0 })
  expect(fiveHour([week, five(40)])).toEqual(five(40))
  expect(fiveHour([week])).toBeUndefined()
  expect(parseReset(RESETS)).toBe(R)
  expect(parseReset('soon')).toBeNull()
  expect(parseReset(undefined)).toBeNull()
})

test('live wins over a higher remembered reading', () => {
  expect(basis(five(40), seeded(93), T0)).toEqual({ kind: 'live', pct: 40, resetsAtMs: R })
  const mem = sawLive(seeded(93), five(40))
  expect(basis(five(40), mem, T0)).toEqual({ kind: 'live', pct: 40, resetsAtMs: R })
})

test('a live reading without resetsAt is used as read and never remembered', () => {
  expect(basis(fiveNoReset(93), initialMemory(), T0)).toEqual({ kind: 'live', pct: 93, resetsAtMs: null })
  expect(anchoredOf(fiveNoReset(93))).toBeUndefined()
  const mem = sawLive(initialMemory(), fiveNoReset(93))
  expect(mem).toEqual({ misses: 0 })
  expect(basis(undefined, mem, T0)).toEqual({ kind: 'none', why: 'no-reading' })
  expect(sawLive(seeded(50), fiveNoReset(93)).seed).toEqual({ pct: 50, resetsAtMs: R })
})

test('a remembered reading counts while its window is open, never past one window', () => {
  const mem = sawLive(initialMemory(), five(93))
  expect(mem).toEqual({ seed: { pct: 93, resetsAtMs: R }, misses: 0 })
  expect(basis(undefined, mem, T0)).toEqual({ kind: 'seed', pct: 93, resetsAtMs: R })
  expect(basis(undefined, mem, R - 1)).toEqual({ kind: 'seed', pct: 93, resetsAtMs: R })
  expect(inWindow({ pct: 93, resetsAtMs: T0 + WINDOW_MS }, T0)).toBe(true)
  expect(inWindow({ pct: 93, resetsAtMs: T0 + WINDOW_MS + 1 }, T0)).toBe(false)
  expect(basis(undefined, seeded(93, T0 + 7 * HOUR), T0)).toEqual({ kind: 'none', why: 'no-reading' })
})

test('a remembered reading whose window reset gives window-reset, not a stale trip', () => {
  expect(basis(undefined, seeded(93), R)).toEqual({ kind: 'none', why: 'window-reset' })
  expect(basis(undefined, seeded(93), R + HOUR)).toEqual({ kind: 'none', why: 'window-reset' })
  expect(basis(five(93), initialMemory(), R)).toEqual({ kind: 'none', why: 'window-reset' })
  expect(basis(five(1, LATER), seeded(93), R + 1)).toEqual({ kind: 'live', pct: 1, resetsAtMs: Date.parse(LATER) })
})

test('newer prefers the later window, then the higher percentage', () => {
  const a = { pct: 93, resetsAtMs: R }
  const later = { pct: 1, resetsAtMs: Date.parse(LATER) }
  const higher = { pct: 95, resetsAtMs: R }
  expect(newer(a, later)).toEqual(later)
  expect(newer(later, a)).toEqual(later)
  expect(newer(a, higher)).toEqual(higher)
  expect(newer(higher, a)).toEqual(higher)
  expect(newer(undefined, a)).toEqual(a)
  expect(newer(a, undefined)).toEqual(a)
  expect(newer(undefined, undefined)).toBeUndefined()
  expect(sawLive(seeded(93), five(1, LATER)).seed).toEqual(later)
})

test('blind after two response-backed measures with no window, and a reading clears it', () => {
  let mem = seeded(93)
  mem = sawMeasure(mem, { rateLimits: [], changed: ['context', 'cost'] })
  expect(mem.misses).toBe(1)
  expect(basis(undefined, mem, T0).kind).toBe('seed')
  mem = sawMeasure(mem, { rateLimits: [week], changed: ['context', 'cost'] })
  expect(mem.misses).toBe(2)
  expect(basis(undefined, mem, T0)).toEqual({ kind: 'none', why: 'blind' })
  expect(isTripped(basis(undefined, mem, T0), 10)).toBe(false)
  expect(basis(five(50), mem, T0)).toEqual({ kind: 'live', pct: 50, resetsAtMs: R })
  mem = sawMeasure(mem, { rateLimits: [five(50)], changed: ['rateLimits', 'cost'] })
  expect(mem.misses).toBe(0)
  expect(basis(undefined, mem, T0)).toEqual({ kind: 'seed', pct: 93, resetsAtMs: R })
})

test('a measure without cost growth is not a miss', () => {
  const mem = initialMemory()
  expect(sawMeasure(mem, { rateLimits: [], changed: ['context'] })).toEqual(mem)
  expect(sawMeasure(mem, { rateLimits: [], changed: [] }).misses).toBe(0)
})

test('asAnchored rejects corrupt values', () => {
  expect(asAnchored({ pct: 93, resetsAtMs: R })).toEqual({ pct: 93, resetsAtMs: R })
  expect(asAnchored({ pct: 93, resetsAtMs: R, extra: 1 })).toEqual({ pct: 93, resetsAtMs: R })
  for (const bad of [undefined, null, 93, 'seed', [], { pct: '93', resetsAtMs: 'soon' }, { pct: 93 }, { pct: Number.NaN, resetsAtMs: R }, { pct: 93, resetsAtMs: Number.POSITIVE_INFINITY }]) {
    expect(asAnchored(bad)).toBeUndefined()
  }
})

test('the test reading only ever raises the basis', () => {
  const t = (pct: number, resetsAtMs = R) => ({ pct, resetsAtMs })
  expect(basis(five(95), initialMemory(), T0, t(90))).toEqual({ kind: 'live', pct: 95, resetsAtMs: R })
  expect(basis(five(95), initialMemory(), T0, t(95))).toEqual({ kind: 'live', pct: 95, resetsAtMs: R })
  expect(basis(five(40), initialMemory(), T0, t(95))).toEqual({ kind: 'test', pct: 95, resetsAtMs: R })
  expect(basis(undefined, seeded(40), T0, t(95))).toEqual({ kind: 'test', pct: 95, resetsAtMs: R })
  const none = basis(undefined, initialMemory(), T0, t(95, T0 + TEST_WINDOW_MS))
  expect(none).toEqual({ kind: 'test', pct: 95, resetsAtMs: T0 + TEST_WINDOW_MS })
  const blind: Memory = { misses: 2 }
  expect(basis(undefined, blind, T0, t(95)).kind).toBe('test')
  expect(basis(five(40), initialMemory(), R, t(95))).toEqual({ kind: 'none', why: 'window-reset' })
  expect(basis(five(40, LATER), initialMemory(), R + 1, t(95))).toEqual({ kind: 'live', pct: 40, resetsAtMs: Date.parse(LATER) })
})

test('inResetMargin: a real reading in the reserve that reset less than 5 minutes ago (4.8)', () => {
  const seed = { pct: 93, resetsAtMs: R }
  expect(inResetMargin(seed, 10, R - 1)).toBe(false) // not reset yet: the gate still sees the reading
  expect(inResetMargin(seed, 10, R)).toBe(true)
  expect(inResetMargin(seed, 10, R + RESET_MARGIN_MS - 1)).toBe(true)
  expect(inResetMargin(seed, 10, R + RESET_MARGIN_MS)).toBe(false) // the margin has passed
  expect(inResetMargin({ pct: 89.9, resetsAtMs: R }, 10, R + 1)).toBe(false) // below the reserve at its last reading
  expect(inResetMargin({ pct: 85, resetsAtMs: R }, 15, R + 1)).toBe(true) // the reserve of the kind
  expect(inResetMargin(undefined, 10, R + 1)).toBe(false)
  expect(TEST_MARGIN_MS).toBeLessThan(RESET_MARGIN_MS) // so a test window that ends near a real reset waits for this
})

test('isTripped trips at the first point of the reserve', () => {
  const live = (pct: number): Basis => ({ kind: 'live', pct, resetsAtMs: R })
  expect(isTripped(live(89.9), 10)).toBe(false)
  expect(isTripped(live(90), 10)).toBe(true)
  expect(isTripped(live(100), 10)).toBe(true)
  expect(isTripped(live(59.9), 40)).toBe(false)
  expect(isTripped(live(60), 40)).toBe(true)
  expect(isTripped(live(89.3), 10.6)).toBe(false)
  expect(isTripped(live(89.4), 10.6)).toBe(true)
  expect(isTripped({ kind: 'seed', pct: 93, resetsAtMs: R }, 10)).toBe(true)
  expect(isTripped({ kind: 'test', pct: 95, resetsAtMs: null }, 10)).toBe(true)
  expect(isTripped({ kind: 'none', why: 'no-reading' }, 10)).toBe(false)
  expect(pctOf(live(91.5))).toBe(91.5)
  expect(pctOf({ kind: 'none', why: 'blind' })).toBeUndefined()
})

test('windowEndOf falls back to one hour without resetsAt', () => {
  expect(windowEndOf({ kind: 'live', pct: 93, resetsAtMs: R }, T0)).toBe(R)
  expect(windowEndOf({ kind: 'live', pct: 93, resetsAtMs: null }, T0)).toBe(T0 + HOUR)
  expect(windowEndOf({ kind: 'none', why: 'no-reading' }, T0)).toBe(T0 + HOUR)
})

test('parseTestPct takes 0 to 100 with one decimal at most', () => {
  expect(parseTestPct('95')).toBe(95)
  expect(parseTestPct(' 91.55 ')).toBe(91.6)
  expect(parseTestPct('0')).toBe(0)
  expect(parseTestPct('100')).toBe(100)
  for (const junk of [undefined, '', ' ', 'abc', '100.1', '-1', 'off', '95%']) {
    expect(parseTestPct(junk)).toBeUndefined()
  }
})

// ---- 0.2: the weekly window, the hold end and the test seam ----

const DAY = 24 * HOUR
const WEEK_RESETS = '2026-09-28T09:00:00.000Z' // Mon, 3 d 21 h after T0
const W = Date.parse(WEEK_RESETS)
const weekly = (percentUsed: number, resetsAt: string = WEEK_RESETS): SessionRateLimit => ({ kind: 'seven_day', percentUsed, resetsAt })
const weeklyNoReset = (percentUsed: number): SessionRateLimit => ({ kind: 'seven_day', percentUsed })

test('the 0.2 constants are the design values', () => {
  expect(KINDS).toEqual(['five_hour', 'seven_day'])
  expect(WEEK_MS).toBe(7 * DAY)
  expect(RESET_MARGIN_MS).toBe(5 * 60_000)
  expect(TEST_MARGIN_MS).toBe(60_000)
  expect(windowMs('five_hour')).toBe(5 * HOUR)
  expect(windowMs('seven_day')).toBe(7 * DAY)
  expect(windowMs('five_hour') + 60_000).toBe(WINDOW_MS)
})

test('limitOf finds each kind, fiveHour stays', () => {
  const list = [weekly(61), five(42), { kind: 'spend_limit', percentUsed: 5 }]
  expect(limitOf(list, 'five_hour')).toEqual(five(42))
  expect(limitOf(list, 'seven_day')).toEqual(weekly(61))
  expect(fiveHour(list)).toEqual(five(42))
  expect(limitOf([five(42)], 'seven_day')).toBeUndefined()
  expect(limitOf([], 'five_hour')).toBeUndefined()
})

test('each kind has its own basis from one list', () => {
  const list = [five(50), weekly(93)]
  const b5 = basis(limitOf(list, 'five_hour'), initialMemory(), T0, undefined, 'five_hour')
  const b7 = basis(limitOf(list, 'seven_day'), initialMemory(), T0, undefined, 'seven_day')
  expect(b5).toEqual({ kind: 'live', pct: 50, resetsAtMs: R })
  expect(b7).toEqual({ kind: 'live', pct: 93, resetsAtMs: W })
  expect(isTripped(b5, 10)).toBe(false)
  expect(isTripped(b7, 10)).toBe(true)
  expect(basis(limitOf(list, 'five_hour'), initialMemory(), T0)).toEqual(b5) // no kind: five_hour
})

test('a weekly seed counts for up to seven days and a minute', () => {
  expect(inWindow({ pct: 93, resetsAtMs: T0 + 7 * DAY + 60_000 }, T0, 'seven_day')).toBe(true)
  expect(inWindow({ pct: 93, resetsAtMs: T0 + 7 * DAY + 60_001 }, T0, 'seven_day')).toBe(false)
  expect(inWindow({ pct: 93, resetsAtMs: T0 + 2 * DAY }, T0, 'seven_day')).toBe(true)
  expect(inWindow({ pct: 93, resetsAtMs: T0 + 2 * DAY }, T0)).toBe(false) // five_hour: too far
  expect(inWindow({ pct: 93, resetsAtMs: T0 }, T0, 'seven_day')).toBe(false)
  const mem = sawLive(initialMemory(), weekly(93))
  expect(mem).toEqual({ seed: { pct: 93, resetsAtMs: W }, misses: 0 })
  expect(basis(undefined, mem, T0, undefined, 'seven_day')).toEqual({ kind: 'seed', pct: 93, resetsAtMs: W })
  expect(basis(undefined, mem, W, undefined, 'seven_day')).toEqual({ kind: 'none', why: 'window-reset' })
})

test('a weekly seed never feeds the 5-hour basis', () => {
  const week = sawLive(initialMemory(), weekly(93))
  // Seeds live per kind (mem[kind]), and a seed further off than one 5-hour window never counts as one.
  expect(basis(undefined, week, T0)).toEqual({ kind: 'none', why: 'no-reading' })
  expect(basis(undefined, week, T0, undefined, 'five_hour')).toEqual({ kind: 'none', why: 'no-reading' })
  const five93 = sawMeasure(initialMemory(), { rateLimits: [weekly(93), five(40)], changed: ['rateLimits'] }, 'five_hour')
  expect(five93.seed).toEqual({ pct: 40, resetsAtMs: R })
  const week93 = sawMeasure(initialMemory(), { rateLimits: [weekly(93), five(40)], changed: ['rateLimits'] }, 'seven_day')
  expect(week93.seed).toEqual({ pct: 93, resetsAtMs: W })
})

test('blind is per kind', () => {
  let m5 = initialMemory()
  let m7 = initialMemory()
  for (let i = 0; i < 2; i += 1) {
    const e = { rateLimits: [five(50)], changed: ['context', 'cost'] }
    m5 = sawMeasure(m5, e, 'five_hour', T0)
    m7 = sawMeasure(m7, e, 'seven_day', T0)
  }
  expect(m5.misses).toBe(0)
  expect(m7.misses).toBe(2)
  expect(basis(undefined, m7, T0, undefined, 'seven_day')).toEqual({ kind: 'none', why: 'blind' })
  expect(basis(five(50), m5, T0, undefined, 'five_hour')).toEqual({ kind: 'live', pct: 50, resetsAtMs: R })
  m7 = sawMeasure(m7, { rateLimits: [weekly(61)], changed: ['rateLimits', 'cost'] }, 'seven_day', T0)
  expect(m7.misses).toBe(0)
  expect(sawMeasure(m7, { rateLimits: [five(50)], changed: ['context'] }, 'seven_day')).toEqual(m7) // no cost: no miss
})

test('holdEndOf is the reset time, and never the one-hour fallback', () => {
  const mem = initialMemory()
  expect(holdEndOf({ kind: 'live', pct: 93, resetsAtMs: R }, mem, T0)).toBe(R)
  expect(holdEndOf({ kind: 'seed', pct: 93, resetsAtMs: R }, mem, T0, 'five_hour')).toBe(R)
  expect(holdEndOf({ kind: 'test', pct: 95, resetsAtMs: T0 + 120_000 }, mem, T0)).toBe(T0 + 120_000)
  expect(holdEndOf({ kind: 'live', pct: 93, resetsAtMs: W }, mem, T0, 'seven_day')).toBe(W)
  expect(holdEndOf({ kind: 'live', pct: 93, resetsAtMs: null }, mem, T0)).toBe(T0 + 5 * HOUR)
  expect(holdEndOf({ kind: 'live', pct: 93, resetsAtMs: null }, mem, T0)).not.toBe(windowEndOf({ kind: 'live', pct: 93, resetsAtMs: null }, T0))
  expect(holdEndOf({ kind: 'live', pct: 93, resetsAtMs: null }, mem, T0, 'seven_day')).toBe(T0 + 7 * DAY)
  expect(holdEndOf({ kind: 'none', why: 'no-reading' }, mem, T0)).toBe(T0 + 5 * HOUR)
  expect(holdEndOf({ kind: 'none', why: 'blind' }, mem, T0, 'seven_day')).toBe(T0 + 7 * DAY)
})

test('without resetsAt the hold end is the first sight plus the window length', () => {
  const seen = sawLive(initialMemory(), fiveNoReset(93), T0)
  expect(seen).toEqual({ misses: 0, noReset: { since: T0, pct: 93 } })
  const b = basis(fiveNoReset(93), seen, T0 + HOUR)
  expect(b).toEqual({ kind: 'live', pct: 93, resetsAtMs: null })
  // Later reads do not move the first sight, so the hold end never slides with now.
  const later = sawLive(seen, fiveNoReset(93), T0 + 2 * HOUR)
  expect(later.noReset).toEqual({ since: T0, pct: 93 })
  expect(holdEndOf(b, later, T0 + 2 * HOUR)).toBe(T0 + 5 * HOUR)
  const week = sawLive(initialMemory(), weeklyNoReset(95), T0)
  expect(holdEndOf(basis(weeklyNoReset(95), week, T0 + DAY, undefined, 'seven_day'), week, T0 + DAY, 'seven_day')).toBe(T0 + 7 * DAY)
  // A reading with a reset time ends the first sight.
  expect(sawLive(later, five(93), T0 + 3 * HOUR)).toEqual({ seed: { pct: 93, resetsAtMs: R }, misses: 0 })
  // Without now, nothing is tracked (the 0.1 call).
  expect(sawLive(initialMemory(), fiveNoReset(93))).toEqual({ misses: 0 })
  expect(sawMeasure(initialMemory(), { rateLimits: [fiveNoReset(93)], changed: ['rateLimits'] }, 'five_hour', T0).noReset).toEqual({ since: T0, pct: 93 })
})

test('a reading without resetsAt goes stale one window after its first sight, while its figure is unchanged', () => {
  const seen = sawLive(initialMemory(), fiveNoReset(93), T0)
  expect(basis(fiveNoReset(93), seen, T0 + 5 * HOUR - 1)).toEqual({ kind: 'live', pct: 93, resetsAtMs: null })
  const stale = sawLive(seen, fiveNoReset(93), T0 + 5 * HOUR)
  expect(basis(fiveNoReset(93), stale, T0 + 5 * HOUR)).toEqual({ kind: 'none', why: 'window-reset' })
  expect(isTripped(basis(fiveNoReset(93), stale, T0 + 5 * HOUR), 10)).toBe(false)
  // A new figure after that point starts a new first sight, and the reading counts again.
  const fresh = sawLive(stale, fiveNoReset(94), T0 + 6 * HOUR)
  expect(fresh.noReset).toEqual({ since: T0 + 6 * HOUR, pct: 94 })
  expect(basis(fiveNoReset(94), fresh, T0 + 6 * HOUR)).toEqual({ kind: 'live', pct: 94, resetsAtMs: null })
  // The weekly window goes stale after seven days.
  const week = sawLive(initialMemory(), weeklyNoReset(95), T0)
  expect(basis(weeklyNoReset(95), week, T0 + 6 * DAY, undefined, 'seven_day')).toEqual({ kind: 'live', pct: 95, resetsAtMs: null })
  expect(basis(weeklyNoReset(95), week, T0 + 7 * DAY, undefined, 'seven_day')).toEqual({ kind: 'none', why: 'window-reset' })
})

test('a fall in the figure starts a new first sight, a rise keeps it', () => {
  const seen = sawLive(initialMemory(), fiveNoReset(93), T0)
  const rise = sawLive(seen, fiveNoReset(96), T0 + HOUR)
  expect(rise.noReset).toEqual({ since: T0, pct: 96 })
  const fall = sawLive(rise, fiveNoReset(4), T0 + 2 * HOUR)
  expect(fall.noReset).toEqual({ since: T0 + 2 * HOUR, pct: 4 })
  const same = sawLive(fall, fiveNoReset(4), T0 + 3 * HOUR)
  expect(same.noReset).toEqual({ since: T0 + 2 * HOUR, pct: 4 })
  expect(holdEndOf(basis(fiveNoReset(96), rise, T0 + HOUR), rise, T0 + HOUR)).toBe(T0 + 5 * HOUR)
  expect(holdEndOf(basis(fiveNoReset(4), fall, T0 + 2 * HOUR), fall, T0 + 2 * HOUR)).toBe(T0 + 7 * HOUR)
})

test('a weekly test reading counts for its own window length', () => {
  const t = { pct: 95, resetsAtMs: T0 + 7 * DAY }
  expect(basis(undefined, initialMemory(), T0, t, 'seven_day')).toEqual({ kind: 'test', pct: 95, resetsAtMs: T0 + 7 * DAY })
  expect(basis(undefined, initialMemory(), T0, t, 'five_hour')).toEqual({ kind: 'none', why: 'no-reading' })
  expect(basis(weekly(97), initialMemory(), T0, t, 'seven_day')).toEqual({ kind: 'live', pct: 97, resetsAtMs: W })
})

test('parseDuration reads s, m, h, d and refuses under 10 s', () => {
  expect(parseDuration('10s')).toBe(10_000)
  expect(parseDuration('90s')).toBe(90_000)
  expect(parseDuration('2m')).toBe(120_000)
  expect(parseDuration('2M')).toBe(120_000)
  expect(parseDuration('3h')).toBe(3 * HOUR)
  expect(parseDuration('1d')).toBe(DAY)
  expect(parseDuration('1D')).toBe(DAY)
  for (const junk of ['9s', '0m', '', 'm', '2', '2 m', '2min', '-2m', '1.5h', '2w', 'in', '9'.repeat(400) + 'd']) {
    expect(parseDuration(junk)).toBeUndefined()
  }
})

test('parseSimulate reads off, a percentage, a kind word and in, and caps in at the window length', () => {
  expect(parseSimulate(['off'])).toBe('off')
  expect(parseSimulate(['OFF'])).toBe('off')
  expect(parseSimulate(['95'])).toEqual({ pct: 95, kind: 'five_hour' })
  expect(parseSimulate(['91.55'])).toEqual({ pct: 91.6, kind: 'five_hour' })
  for (const w of ['5h', '5H', '5-hour', 'five_hour', 'FIVE_HOUR']) expect(parseSimulate(['95', w])).toEqual({ pct: 95, kind: 'five_hour' })
  for (const w of ['weekly', 'Weekly', '7d', '7D', 'seven_day']) expect(parseSimulate(['95', w])).toEqual({ pct: 95, kind: 'seven_day' })
  expect(parseSimulate(['95', 'in', '2m'])).toEqual({ pct: 95, kind: 'five_hour', inMs: 120_000 })
  expect(parseSimulate(['95', 'weekly', 'in', '2m'])).toEqual({ pct: 95, kind: 'seven_day', inMs: 120_000 })
  expect(parseSimulate(['95', 'in', '2m', 'weekly'])).toEqual({ pct: 95, kind: 'seven_day', inMs: 120_000 }) // either order
  expect(parseSimulate(['95', 'IN', '10S'])).toEqual({ pct: 95, kind: 'five_hour', inMs: 10_000 })
  expect(parseSimulate(['95', 'in', '6h'])).toEqual({ pct: 95, kind: 'five_hour', inMs: 5 * HOUR }) // capped
  expect(parseSimulate(['95', '5h', 'in', '2d'])).toEqual({ pct: 95, kind: 'five_hour', inMs: 5 * HOUR })
  expect(parseSimulate(['95', 'weekly', 'in', '9d'])).toEqual({ pct: 95, kind: 'seven_day', inMs: 7 * DAY })
  expect(parseSimulate(['95', 'weekly', 'in', '3d'])).toEqual({ pct: 95, kind: 'seven_day', inMs: 3 * DAY })
  const junk = [
    [],
    ['abc'],
    ['101'],
    ['-1'],
    ['off', 'weekly'],
    ['weekly', '95'],
    ['in', '2m', '95'],
    ['95', 'monthly'],
    ['95', 'weekly', '5h'],
    ['95', 'weekly', 'weekly'],
    ['95', 'in'],
    ['95', 'in', '5s'],
    ['95', 'in', 'soon'],
    ['95', 'in', '2m', 'in', '3m'],
    ['95', '2m'],
    ['95', 'constructor'],
    ['95', '__proto__'],
  ]
  for (const words of junk) expect(parseSimulate(words)).toBeUndefined()
})

test('parseSimulateEnv splits on white space, and off or junk is no test reading', () => {
  expect(parseSimulateEnv('95')).toEqual({ pct: 95, kind: 'five_hour' })
  expect(parseSimulateEnv(' 95\tweekly  in 2m ')).toEqual({ pct: 95, kind: 'seven_day', inMs: 120_000 })
  expect(parseSimulateEnv('95 in 2m')).toEqual({ pct: 95, kind: 'five_hour', inMs: 120_000 })
  for (const junk of [undefined, '', ' ', 'off', 'abc', '95 later', '95%']) expect(parseSimulateEnv(junk)).toBeUndefined()
})
