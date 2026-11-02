import { test, expect } from 'claude-code/testing'
import { WEEK_MS } from '../../hooks/core/reading.ts'
import { dayStartOf, nextMidnight, nextPace, paceCeilingAt, paceEnd, parseWeeklyPace } from '../../hooks/core/pace.ts'

// A week with no daylight saving change in any zone: Monday 9 Nov to Monday 16 Nov 2026, local time.
const at = (day: number, hour = 0): number => new Date(2026, 10, 9 + day, hour).getTime()
const RESET = at(7)
const FRI10 = parseWeeklyPace('Fri:10') ?? []

test('parseWeeklyPace: checkpoints, blank, and junk', () => {
  expect(parseWeeklyPace('Fri:10')).toEqual([{ day: 4, left: 10 }])
  expect(parseWeeklyPace(' wed : 45 , FRIDAY:10% ')).toEqual([
    { day: 2, left: 45 },
    { day: 4, left: 10 },
  ])
  expect(parseWeeklyPace('')).toEqual([])
  expect(parseWeeklyPace('   ')).toEqual([])
  expect(parseWeeklyPace('Fri:0')).toBeUndefined()
  expect(parseWeeklyPace('Fri:100')).toBeUndefined()
  expect(parseWeeklyPace('Funday:10')).toBeUndefined()
  expect(parseWeeklyPace('Fri')).toBeUndefined()
  expect(parseWeeklyPace('Fri:10,Wed:45')).toBeUndefined() // days must rise
  expect(parseWeeklyPace('Wed:10,Fri:45')).toBeUndefined() // % left must not rise
  expect(parseWeeklyPace('Fri:10,Fri:5')).toBeUndefined()
  expect(parseWeeklyPace(10)).toBeUndefined()
})

test('paceCeilingAt: Fri:10 steps 18% a day, at the end of each local day', () => {
  expect(paceCeilingAt(FRI10, RESET, at(0, 0), WEEK_MS)).toBe(18)
  expect(paceCeilingAt(FRI10, RESET, at(0, 14), WEEK_MS)).toBe(18)
  expect(paceCeilingAt(FRI10, RESET, at(1, 0), WEEK_MS)).toBe(36)
  expect(paceCeilingAt(FRI10, RESET, at(2, 23), WEEK_MS)).toBe(54)
  expect(paceCeilingAt(FRI10, RESET, at(3, 12), WEEK_MS)).toBe(72)
  expect(paceCeilingAt(FRI10, RESET, at(4, 12), WEEK_MS)).toBe(90)
})

test('paceCeilingAt: no pace after the last checkpoint, with no pace, or with no reset', () => {
  expect(paceCeilingAt(FRI10, RESET, at(5, 0), WEEK_MS)).toBeNull() // Saturday
  expect(paceCeilingAt(FRI10, RESET, at(6, 12), WEEK_MS)).toBeNull()
  expect(paceCeilingAt([], RESET, at(0, 12), WEEK_MS)).toBeNull()
  expect(paceCeilingAt(FRI10, null, at(0, 12), WEEK_MS)).toBeNull()
})

test('paceCeilingAt: two checkpoints interpolate between them', () => {
  const two = parseWeeklyPace('Wed:55,Fri:10') ?? []
  expect(paceCeilingAt(two, RESET, at(0, 5), WEEK_MS)).toBe(15) // 45% over 3 days
  expect(paceCeilingAt(two, RESET, at(2, 5), WEEK_MS)).toBe(45)
  expect(paceCeilingAt(two, RESET, at(3, 5), WEEK_MS)).toBe(67.5) // 45 more over 2 days
  expect(paceCeilingAt(two, RESET, at(4, 5), WEEK_MS)).toBe(90)
})

test('paceCeilingAt: a rebase runs from the anchor to the last checkpoint and never lowers the line', () => {
  // 60% used at Tuesday 00:00: 30% over Tue to Fri is 7.5% a day.
  const anchor = { atMs: at(1), pct: 60 }
  expect(paceCeilingAt(FRI10, RESET, at(1, 8), WEEK_MS, anchor)).toBe(67.5)
  expect(paceCeilingAt(FRI10, RESET, at(2, 8), WEEK_MS, anchor)).toBe(75)
  expect(paceCeilingAt(FRI10, RESET, at(4, 8), WEEK_MS, anchor)).toBe(90)
  // Under the line, an anchor changes nothing.
  expect(paceCeilingAt(FRI10, RESET, at(1, 8), WEEK_MS, { atMs: at(1), pct: 10 })).toBe(36)
  // An anchor in the future is ignored.
  expect(paceCeilingAt(FRI10, RESET, at(0, 8), WEEK_MS, anchor)).toBe(18)
})

test('paceEnd is the end of the last checkpoint day', () => {
  expect(paceEnd(FRI10, RESET, WEEK_MS)).toBe(at(5))
  expect(paceEnd([], RESET, WEEK_MS)).toBeNull()
})

test('a reset in the middle of a week: the first matching weekday comes at or after the start', () => {
  const reset = at(9, 14) // Wednesday 14:00, so the week began on the Wednesday before
  const wedFri = parseWeeklyPace('Fri:10') ?? []
  expect(paceEnd(wedFri, reset, WEEK_MS)).toBe(at(5)) // the Friday after Wed 2 Nov
  expect(paceCeilingAt(wedFri, reset, at(2, 15), WEEK_MS)).not.toBeNull()
})

test('dayStartOf and nextMidnight are local midnights', () => {
  expect(dayStartOf(at(2, 15))).toBe(at(2))
  expect(nextMidnight(at(2, 15))).toBe(at(3))
  expect(nextMidnight(at(2))).toBe(at(3))
})

test('nextPace: the first reading of a day decides, and a later reading never rebases', () => {
  const T = at(1, 0) + 300_000
  // Monday: no day before, so no anchor even above the line.
  expect(nextPace(FRI10, RESET, at(0, 14), WEEK_MS, 19, undefined)).toEqual({ day: at(0) })
  // Tuesday 00:05 at 60%: above Monday's ceiling (18), so it anchors.
  expect(nextPace(FRI10, RESET, T, WEEK_MS, 60, undefined)).toEqual({ day: at(1), anchor: { atMs: T, pct: 60 } })
  // Tuesday's first reading on pace: no anchor, and a later reading above yesterday's line does not start one.
  const onPace = nextPace(FRI10, RESET, at(1, 9), WEEK_MS, 18, undefined)
  expect(onPace).toEqual({ day: at(1) })
  expect(nextPace(FRI10, RESET, at(1, 16), WEEK_MS, 50, onPace)).toEqual({ day: at(1) })
  // A second reading the same day keeps the anchor.
  const first = nextPace(FRI10, RESET, T, WEEK_MS, 60, undefined)
  expect(nextPace(FRI10, RESET, at(1, 16), WEEK_MS, 70, first)).toBe(first)
  // The next day starting above the line anchors again. A first reading on pace keeps the anchor.
  expect(nextPace(FRI10, RESET, at(2, 1), WEEK_MS, 80, first)).toEqual({ day: at(2), anchor: { atMs: at(2, 1), pct: 80 } })
  expect(nextPace(FRI10, RESET, at(2, 1), WEEK_MS, 30, first)).toEqual({ day: at(2), anchor: first?.anchor })
  // An anchor from the last week is dropped. No reset: nothing changes.
  expect(nextPace(FRI10, RESET, at(1, 9), WEEK_MS, 10, { day: at(-3), anchor: { atMs: at(-3), pct: 70 } })).toEqual({ day: at(1) })
  expect(nextPace(FRI10, null, at(1, 9), WEEK_MS, 90, undefined)).toBeUndefined()
})
