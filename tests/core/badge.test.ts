import { test, expect } from 'claude-code/testing'
import { badgeLabel, badgeView } from '../../hooks/core/badge.ts'
import type { Mode, Phase } from '../../hooks/core/decide.ts'

const view = (phase: Phase, over: { reserve?: number; test?: boolean; mode?: Mode; blink?: boolean; until?: string; to?: string } = {}) =>
  badgeView(phase, { reserve: 10, test: false, mode: 'hold', blink: true, ...over })

const LABELLED: Phase[] = ['off', 'waiting', 'armed', 'consented', 'open', 'stopped', 'asking', 'told', 'reserve']

test('shows a gray hourglass before the first reading', () => {
  expect(view('waiting')).toEqual({ text: '⧗ spare10', color: 'inactive', pulse: false })
})

test('shows a green marker while the reserve is untouched', () => {
  expect(view('armed')).toEqual({ text: '● spare10', color: 'success', pulse: false })
})

test('spells out a non-default reserve', () => {
  expect(badgeLabel(10, false)).toBe('spare10')
  expect(badgeLabel(40, false)).toBe('spare10 (40%)')
  expect(badgeLabel(12.5, false)).toBe('spare10 (12.5%)')
  for (const phase of LABELLED) {
    expect(view(phase, { reserve: 40 }).text).toContain('spare10 (40%)')
    expect(view(phase).text).not.toContain('(10%)')
  }
  expect(view('waiting', { reserve: 40 }).text).toBe('⧗ spare10 (40%)')
  expect(view('armed', { reserve: 40 }).text).toBe('● spare10 (40%)')
})

test('says what is about to happen, and pulses by swapping the glyph only', () => {
  const on = view('tripped', { blink: true })
  const off = view('tripped', { blink: false })
  expect(on).toEqual({ text: '⚠ Pausing at next step', color: 'warning', pulse: true })
  expect(off).toEqual({ text: '  Pausing at next step', color: 'warning', pulse: true })
  expect(on.text.length).toBe(off.text.length)
  const tellOn = view('tripped', { mode: 'tell', blink: true })
  const tellOff = view('tripped', { mode: 'tell', blink: false })
  expect(tellOn).toEqual({ text: '⚠ Winding down at next step', color: 'warning', pulse: true })
  expect(tellOff).toEqual({ text: '  Winding down at next step', color: 'warning', pulse: true })
  expect(tellOn.text.length).toBe(tellOff.text.length)
  for (const phase of ['off', 'blind', 'waiting', 'armed', 'consented', 'open', 'stopped', 'asking', 'told', 'reserve'] as Phase[]) {
    expect(view(phase).pulse).toBe(false)
    expect(view(phase, { blink: false })).toEqual(view(phase, { blink: true }))
  }
})

test('goes quiet but present once consented', () => {
  expect(view('consented')).toEqual({ text: '⨯ spare10', color: 'warning', pulse: false })
  expect(view('consented', { reserve: 99 }).text).toBe('⨯ spare10 (99%)')
})

test('shows the stop, asking and told rows with their own glyphs', () => {
  expect(view('stopped')).toEqual({ text: '■ spare10: stopped', color: 'warning', pulse: false })
  expect(view('asking')).toEqual({ text: '? spare10: waiting for you', color: 'warning', pulse: false })
  expect(view('told')).toEqual({ text: '⏸ spare10', color: 'warning', pulse: false })
  expect(view('told', { mode: 'tell' })).toEqual({ text: '⏸ spare10', color: 'warning', pulse: false })
})

test('an unattended session in the reserve does not pulse', () => {
  expect(view('reserve')).toEqual({ text: '⚠ spare10: in the reserve', color: 'warning', pulse: false })
})

test('leaves the blind warning plain', () => {
  const v = view('blind')
  expect(v).toEqual({ text: '⚠ spare10 quota unavailable', pulse: false })
  expect(v.color).toBeUndefined()
  expect(view('blind', { reserve: 40, test: true }).text).toBe('⚠ spare10 quota unavailable')
})

test('shows off in the inactive colour', () => {
  expect(view('off')).toEqual({ text: '○ spare10 off', color: 'inactive', pulse: false })
  expect(view('off', { reserve: 40 }).text).toBe('○ spare10 (40%) off')
})

test('labels a test reading', () => {
  expect(badgeLabel(10, true)).toBe('spare10 (test)')
  expect(badgeLabel(40, true)).toBe('spare10 (40%) (test)')
  expect(view('armed', { test: true }).text).toBe('● spare10 (test)')
  expect(view('stopped', { test: true }).text).toBe('■ spare10 (test): stopped')
  expect(view('asking', { reserve: 40, test: true }).text).toBe('? spare10 (40%) (test): waiting for you')
  for (const phase of LABELLED) expect(view(phase, { test: true }).text).toContain('(test)')
})

test('stopped shows until when given, and the 0.1 text without', () => {
  expect(view('stopped', { until: '15:00' })).toEqual({ text: '■ spare10: stopped until 15:00', color: 'warning', pulse: false })
  expect(view('stopped', { until: 'Mon 09:00', reserve: 40, test: true }).text).toBe('■ spare10 (40%) (test): stopped until Mon 09:00')
  expect(view('stopped')).toEqual({ text: '■ spare10: stopped', color: 'warning', pulse: false })
})

test('asking shows until when given', () => {
  expect(view('asking', { until: '15:00' })).toEqual({ text: '? spare10: waiting for you until 15:00', color: 'warning', pulse: false })
  expect(view('asking', { until: 'Thu 1 Oct 11:00' }).text).toBe('? spare10: waiting for you until Thu 1 Oct 11:00')
  expect(view('asking')).toEqual({ text: '? spare10: waiting for you', color: 'warning', pulse: false })
  // Every other row ignores until.
  for (const phase of ['off', 'blind', 'waiting', 'armed', 'consented', 'told', 'reserve', 'tripped'] as Phase[]) {
    expect(view(phase, { until: '15:00' })).toEqual(view(phase))
  }
})

test('open shows reserve open until the clock, and plain without it', () => {
  expect(view('open', { until: '16:40' })).toEqual({ text: '↻ spare10: reserve open until 16:40', color: 'warning', pulse: false })
  expect(view('open', { until: '14:22', test: true }).text).toBe('↻ spare10 (test): reserve open until 14:22')
  expect(view('open', { until: 'Mon 09:00', reserve: 40 }).text).toBe('↻ spare10 (40%): reserve open until Mon 09:00')
  expect(view('open')).toEqual({ text: '↻ spare10: reserve open', color: 'warning', pulse: false })
  expect(view('open', { blink: false, until: '16:40' })).toEqual(view('open', { blink: true, until: '16:40' }))
})

test('consented shows resumed until the end point, and the 0.2 row without one', () => {
  expect(view('consented', { to: '95' })).toEqual({ text: '⨯ spare10: resumed until 95% used', color: 'warning', pulse: false })
  expect(view('consented', { to: '97.5', test: true })).toEqual({ text: '⨯ spare10 (test): resumed until 97.5% used', color: 'warning', pulse: false })
  expect(view('consented', { to: '95', reserve: 15 })).toEqual({ text: '⨯ spare10 (15%): resumed until 95% used', color: 'warning', pulse: false })
  expect(view('consented')).toEqual({ text: '⨯ spare10', color: 'warning', pulse: false })
  // Only the consented row names it.
  expect(view('armed', { to: '95' }).text).toBe('● spare10')
})
