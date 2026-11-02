// The weekday pace (weeklyPace option), as pure functions. No $ here.
// A pace is a list of checkpoints: the percent of the weekly quota that must be left at the end of a weekday.
// The pace line falls straight from the weekly reset (100% left) through each checkpoint. The ceiling of a
// day is the line at the end of that local day, so it steps once at each local midnight.

export type Checkpoint = { day: number; left: number } // day: 0 is Monday, 6 is Sunday. left: % left, 1 to 99
/** The usage at a moment: from there, the line runs to the last checkpoint (the rebase after a Resume). */
export type Anchor = { atMs: number; pct: number }

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

/**
 * `Fri:10` or `Wed:45,Fri:10`. A blank value is no pace (an empty list). Days must rise and the percent left
 * must not rise. Anything else is undefined, and the caller warns.
 */
export function parseWeeklyPace(raw: unknown): Checkpoint[] | undefined {
  if (typeof raw !== 'string') return undefined
  if (raw.trim() === '') return []
  const out: Checkpoint[] = []
  for (const part of raw.split(',')) {
    const m = /^\s*([a-z]{3})[a-z]*\s*:\s*(\d+(?:\.\d)?)\s*%?\s*$/i.exec(part)
    if (m === null) return undefined
    const day = DAYS.indexOf((m[1] ?? '').toLowerCase())
    const left = Number(m[2])
    if (day < 0 || !(left >= 1 && left <= 99)) return undefined
    const prev = out[out.length - 1]
    if (prev !== undefined && (day <= prev.day || left > prev.left)) return undefined
    out.push({ day, left })
  }
  return out
}

/** The local midnight at or before `ms`. Date does the daylight saving arithmetic. */
export function dayStartOf(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** The next local midnight after `ms`. */
export function nextMidnight(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

const weekdayOf = (ms: number): number => (new Date(ms).getDay() + 6) % 7 // 0 is Monday

/** The end of the first local weekday `day` at or after `startMs`: the time of a checkpoint. */
function checkpointTime(day: number, startMs: number): number {
  let t = dayStartOf(startMs)
  for (let i = 0; i < 8 && weekdayOf(t) !== day; i += 1) t = nextMidnight(t)
  return nextMidnight(t)
}

/** The end of the last checkpoint, in ms. Null with no pace. */
export function paceEnd(cps: readonly Checkpoint[], resetMs: number, weekMs: number): number | null {
  const last = cps[cps.length - 1]
  return last === undefined ? null : checkpointTime(last.day, resetMs - weekMs)
}

const clamp = (n: number): number => Math.round(n * 10) / 10

/**
 * The most that may be used at `now`, in % used: the pace line at the end of the current local day.
 * Null when there is no pace, no known reset, or now is past the last checkpoint (the weekend). With an
 * anchor, the line also runs from the anchor to the last checkpoint, and the higher of the two counts.
 */
export function paceCeilingAt(
  cps: readonly Checkpoint[],
  resetMs: number | null,
  now: number,
  weekMs: number,
  anchor?: Anchor,
): number | null {
  const last = cps[cps.length - 1]
  if (last === undefined || resetMs === null) return null
  const start = resetMs - weekMs
  const dayEnd = nextMidnight(now)
  const finalAt = checkpointTime(last.day, start)
  if (now >= finalAt) return null
  const target = 100 - last.left
  const points: Array<{ t: number; used: number }> = [{ t: start, used: 0 }]
  for (const c of cps) points.push({ t: checkpointTime(c.day, start), used: 100 - c.left })
  const at = Math.min(dayEnd, finalAt)
  let base = target
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]
    const b = points[i]
    if (a === undefined || b === undefined) continue
    if (at <= b.t) {
      base = b.t === a.t ? b.used : a.used + ((b.used - a.used) * (at - a.t)) / (b.t - a.t)
      break
    }
  }
  let ceiling = base
  if (anchor !== undefined && anchor.atMs <= now && anchor.pct < target && finalAt > anchor.atMs) {
    const rebased = anchor.pct + ((target - anchor.pct) * (at - anchor.atMs)) / (finalAt - anchor.atMs)
    ceiling = Math.max(ceiling, rebased)
  }
  return clamp(Math.min(ceiling, target))
}

/** What the rebase remembers: the local day of the last first reading, and the anchor it started, if any. */
export type PaceState = { day: number; anchor?: Anchor }

/**
 * The rebase (day-scoped Resume): the first reading of a local day decides. When it is above the ceiling of
 * the day before, it starts a new anchor, and the line runs from it to the last checkpoint. A reading later
 * in the day never starts one, so crossing the line in a day still holds. An anchor never outlives its week.
 */
export function nextPace(
  cps: readonly Checkpoint[],
  resetMs: number | null,
  now: number,
  weekMs: number,
  pct: number,
  state: PaceState | undefined,
): PaceState | undefined {
  if (resetMs === null || now < resetMs - weekMs) return state
  const start = resetMs - weekMs
  const kept = state?.anchor !== undefined && state.anchor.atMs >= start && state.anchor.atMs <= now ? state.anchor : undefined
  const today = dayStartOf(now)
  if (state !== undefined && state.day >= today) return kept === state.anchor ? state : { day: state.day, ...(kept === undefined ? {} : { anchor: kept }) }
  // Above the ceiling of the day before: a person who went on past it with a Resume. The first day has no day before.
  const before = today - 1
  const line = before < start ? null : paceCeilingAt(cps, resetMs, before, weekMs)
  if (line !== null && pct > line) return { day: today, anchor: { atMs: now, pct } }
  return { day: today, ...(kept === undefined ? {} : { anchor: kept }) }
}
