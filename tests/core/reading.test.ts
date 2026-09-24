import { test, expect } from 'claude-code/testing'
import type { SessionRateLimit } from 'claude-code'
import {
  BLIND_AFTER,
  FALLBACK_MS,
  TEST_WINDOW_MS,
  WINDOW_MS,
  anchoredOf,
  asAnchored,
  basis,
  fiveHour,
  inWindow,
  initialMemory,
  isTripped,
  newer,
  parseReset,
  parseTestPct,
  pctOf,
  sawLive,
  sawMeasure,
  windowEndOf,
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
