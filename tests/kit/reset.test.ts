import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import {
  HOUR,
  LATER,
  MARGIN,
  MIN,
  RESETS,
  SOON,
  T0,
  TEST_MARGIN,
  TICK,
  WEEK_RESETS,
  bash,
  begin,
  cmd,
  drain,
  pastDue,
  step,
  world,
} from '../helpers/world.ts'
import type { World } from '../helpers/world.ts'

// The reset clock through the engine, first half (0.2 design 8.3 reset.test.ts): an unanswered
// question continues at its due time, the margins, the fresh decision after again, a reading that
// leaves the reserve, and autoResume off. autoResume is on unless a test sets SPARE10_AUTO_RESUME.
// Every test calls begin, because the ticker exists only after session.start (4.9).
// The D0.2 reset path: spans off. Every world has spans: 'off' (skip design 7.4), so a question
// and a stop continue at the reset plus the margin. tests/kit/skip.test.ts runs the shipped spans.
// Every expected text is spelled out from design section 2 here, not taken from hooks/core/text.ts,
// so a drift in the texts or the reset logic fails a test.

const RESET_MS = Date.parse(RESETS)
const LATER_MS = Date.parse(LATER)
const WEEK_MS = Date.parse(WEEK_RESETS)
const SOON_MS = Date.parse(SOON)

// {clock}: HH:MM for the 5-hour window, `ddd HH:MM` for the weekly one, in the machine's zone (2.1)
const hhmm = (ms: number): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms))
const weekday = (ms: number): string => `${new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(new Date(ms))} ${hhmm(ms)}`
const AT = hhmm(RESET_MS)
const iso = (ms: number): string => new Date(ms).toISOString()

// {pf} and {mf} of one kind (2.1)
const num = (n: number): string => String(Math.round(n * 10) / 10)
const pf = (used: number, at: string): string => `${num(used)}% used · ${num(100 - used)}% left · resets ${at}`
const mf = (used: number, at: string): string => `into your 10% reserve · ${num(100 - used)}% of quota left · resets ${at}`

// The question (2.2): the loop wording, with the {after} part when autoResume is on.
const AFTER = (at: string): string => ` If you choose Stop here or do not answer, the work waits until ${at}. Then spare10 continues it, unless a reserve is still reached.`
const loopQuestion = (used: number, at = AT, auto = true): string =>
  `Your 10% reserve is reached: ${pf(used, at)}. All work is on hold. Continue on the reserve until ${at}?${auto ? AFTER(at) : ''}`
const weeklyLoopQuestion = (used: number, at: string): string =>
  `Your 10% weekly reserve is reached: ${pf(used, at)}. All work is on hold. Continue on the weekly reserve until ${at}?${AFTER(at)}`

// Text the model reads (2.3)
const STOP = (used: number, at = AT): string =>
  `spare10: the user stopped work at the quota reserve (${mf(used, at)}). Stop now and wait for the user. Do not call any further tools.`
const PAUSED = (used: number, at = AT): string =>
  `spare10: work stopped at the quota reserve (${mf(used, at)}). No model request was sent, so this task is not finished. Wait for the user.`

// Transcript notices (2.4), without the prefix that the engine adds
const RESET_CONTINUES = 'the 5-hour window reset. Held work continues.'
const TEST_CONTINUES = 'the test window ended. Held work continues.'
const OUT_OF_RESERVE = 'the quota is no longer in the reserve. Held work continues.'
const RESET_WAITING = 'the 5-hour window reset. Held work still waits for your answer.'
const stillHeld = (reset: string, rs: string): string => `${reset}, but ${rs} is reached. Held work still waits.`
const NEW_WINDOW = 'held work continues on the new 5-hour window.'
const STOPPED_OFF = 'stopped at your 10% reserve. Type a prompt to be asked again, or run /spare10 resume.'
const RESET_RESUMES = 'the 5-hour window reset. spare10 continues the stopped work.'
const RESET_STOP_OVER = 'the 5-hour window reset, and the stop is over. Type a prompt to continue.'
const CHECK_FAILED = 'spare10: the reset check did not run: ' // 2.5, then the error
const BAD_AUTO = 'SPARE10_AUTO_RESUME="maybe" is not on or off. spare10 uses on.' // B27

// Held waiters check on every tick for hours of mock time: allow more than the 5 s default.
const SLOW = { timeoutMs: 20_000 }

type Logged = { logs: Array<{ text: string; to?: string }> }
const debug = (w: Logged): string[] => w.logs.filter((l) => l.to === 'debug').map((l) => l.text)
const transcript = (w: Logged): string[] => w.logs.filter((l) => l.to !== 'debug').map((l) => l.text)
const count = (list: string[], text: string): number => list.filter((t) => t === text).length

// /spare10 as the person types it, one entry per line of the report
const report = async ($: Engine): Promise<string[]> =>
  ((await $.command.run(cmd(''))).text ?? '').split('\n').map((l) => l.trimEnd())

/** The tags of a 0.2 SPARE10_STOPPED value, sorted (3.2: the list order is not the point). */
const tagsOf = (raw: string | undefined): string[] => (raw?.split(' ')[3] ?? '').split(',').filter((t) => t !== '').sort()
/** The until field of a SPARE10_STOPPED value. */
const untilOf = (raw: string | undefined): number => Number(raw?.split(' ')[1])

/** Neither consent variable is set: the reset writes no consent (B33). */
const noConsent = (w: World): void => {
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBeUndefined()
}

// ---- B33: an unanswered question continues at its due time ----

test('an unanswered question continues after the margin: the dialog is withdrawn and three loops run', SLOW, async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93, agents: ['a1', 'a2'] })
  await begin($, w)
  const held = [bash($), bash($, 'a1')]
  const req = drain($, step('a2', 'T2'))
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(93)])
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  await pastDue(w, RESETS)
  await w.clock.settle()
  const out = await Promise.all(held)
  expect(out.map((r) => r.result)).toEqual(['ran', 'ran'])
  expect(out.map((r) => r.deny)).toEqual([undefined, undefined])
  expect((await req).text).toBe('hi')
  expect([...w.ran].sort()).toEqual(['Bash:a1', 'Bash:main'])
  expect(w.requests).toBe(1)
  expect(w.dialogAborted).not.toBe('no') // the dialog is withdrawn
  expect(w.asked).toHaveLength(1) // nothing gates now: no new question
  await w.clock.settle()
  expect(count(transcript(w), RESET_CONTINUES)).toBe(1)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect(w.submitted).toEqual([]) // a question releases its loops in place, never with a prompt
})

test('the reset writes no consent', SLOW, async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93 })
  await begin($, w)
  // Released before the reset, while RESETS is still ahead: a consent written here would be visible.
  const first = bash($)
  await w.clock.settle()
  await w.clock.advance(10 * MIN)
  w.pct = 50 // a limit-reset grant
  await w.clock.advance(MIN)
  await w.clock.settle()
  expect((await first).result).toBe('ran')
  noConsent(w)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  // The same window in the reserve again: no consent in memory either, so it asks again.
  w.pct = 93
  const second = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
  expect(w.ran).toEqual(['Bash:main'])
  // Released at the reset: still no consent, and no Resume notice.
  await pastDue(w, RESETS)
  await w.clock.settle()
  expect((await second).result).toBe('ran')
  noConsent(w)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect(transcript(w).filter((t) => t.startsWith('continuing on'))).toEqual([])
  expect(transcript(w).filter((t) => t.startsWith('held work continues on the new'))).toEqual([])
  expect((await report($)).find((l) => l.startsWith('  · consent '))).toBe('  · consent        none')
})

test('a question still waits one tick before the 5-minute margin', SLOW, async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93, agents: ['a1'] })
  await begin($, w)
  const held = [bash($), bash($, 'a1')]
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  // Past the reset, inside the margin: neither the ticker nor a carrier cycle releases anything (4.8).
  await w.clock.set(RESET_MS + TICK)
  w.cap()
  await w.clock.settle()
  expect(w.ran).toEqual([])
  await w.clock.set(RESET_MS + MARGIN - TICK)
  w.cap()
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.dialogAborted).toBe('no')
  expect(transcript(w).filter((t) => t.includes('Held work'))).toEqual([])
  // One tick on is the due time.
  await pastDue(w, RESETS)
  await w.clock.settle()
  expect((await Promise.all(held)).map((r) => r.result)).toEqual(['ran', 'ran'])
  expect(count(transcript(w), RESET_CONTINUES)).toBe(1)
})

test('a test reading in 2m continues held work after its 60 s margin', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 50 })
  await begin($, w)
  const ends = T0 + 2 * MIN
  const set = (await $.command.run(cmd('simulate 95 in 2m'))).text
  expect(set).toBe(`test reading set to 95% used, resets ${hhmm(ends)}. It can only raise the real reading. Run /spare10 simulate off to clear it.`)
  const held = bash($)
  const req = drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(95, hhmm(ends))])
  // The test window ended, and its 60 s margin has not passed yet.
  await w.clock.set(ends + TEST_MARGIN - TICK)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  expect(w.dialogAborted).toBe('no')
  await pastDue(w, iso(ends), TEST_MARGIN)
  await w.clock.settle()
  expect((await held).result).toBe('ran')
  expect((await req).text).toBe('hi')
  expect(w.requests).toBe(1)
  expect(w.dialogAborted).not.toBe('no')
  expect(w.asked).toHaveLength(1) // the real reading of 50 does not gate
  await w.clock.settle()
  expect(count(transcript(w), TEST_CONTINUES)).toBe(1)
  noConsent(w)
})

test('a test reading over a real trip does not shorten the real hold', SLOW, async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93 })
  await begin($, w)
  const ends = T0 + 2 * MIN
  await $.command.run(cmd('simulate 95 in 2m'))
  const held = bash($)
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(95, hhmm(ends))]) // the test reading raised the basis
  // At the test due time the question ends, the real reading still gates, and a new question holds the call.
  await pastDue(w, iso(ends), TEST_MARGIN)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.dialogAborted).not.toBe('no')
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(95, hhmm(ends)), loopQuestion(93)])
  expect(count(transcript(w), stillHeld('the test window ended', 'your 10% reserve'))).toBe(1)
  expect(transcript(w)).not.toContain(TEST_CONTINUES)
  noConsent(w)
  // Still held one tick before the real due time, released after it.
  await w.clock.set(RESET_MS + MARGIN - TICK)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  await pastDue(w, RESETS)
  await w.clock.settle()
  expect((await held).result).toBe('ran')
  expect(count(transcript(w), RESET_CONTINUES)).toBe(1)
  expect(w.asked).toHaveLength(2)
})

// ---- B33, B38: at the due time every held loop decides afresh ----

test('at the 5-hour reset with the weekly window in the reserve: a new weekly question holds every loop, and no call reaches core in between', SLOW, async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93, weekPct: 80, agents: ['a1'] })
  await begin($, w)
  const held = [bash($), bash($, 'a1')]
  const req = drain($, step('a1', 'T1'))
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(93)]) // the weekly window is not in the reserve yet
  await w.clock.advance(HOUR)
  w.weekPct = 92 // it trips while the question waits: that question does not name it (1.3 item 2)
  await pastDue(w, RESETS)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  expect(w.dialogAborted).not.toBe('no') // the 5-hour dialog is withdrawn
  const week = weekday(WEEK_MS)
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(93), weeklyLoopQuestion(92, week)])
  expect(count(transcript(w), stillHeld('the 5-hour window reset', 'your 10% weekly reserve'))).toBe(1)
  expect(transcript(w)).not.toContain(RESET_CONTINUES)
  noConsent(w)
  // The weekly question is answered: every loop runs, on a weekly consent only.
  w.release('Resume')
  expect((await Promise.all(held)).map((r) => r.result)).toEqual(['ran', 'ran'])
  expect((await req).text).toBe('hi')
  expect([...w.ran].sort()).toEqual(['Bash:a1', 'Bash:main'])
  expect(w.requests).toBe(1)
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(`S1 ${WEEK_RESETS}`)
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(w.asked).toHaveLength(2)
})

test('a sense that fails at the due time releases nothing, and the next check releases', SLOW, async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93, agents: ['a1'] })
  await begin($, w)
  const held = [bash($), bash($, 'a1')]
  await w.clock.settle()
  await w.clock.set(RESET_MS + MARGIN - TICK)
  await w.clock.settle()
  w.usageFails = true
  await w.clock.advance(2 * TICK) // the due time, and one tick more
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.dialogAborted).toBe('no')
  expect(debug(w).some((t) => t.startsWith(CHECK_FAILED))).toBe(true)
  expect(transcript(w)).not.toContain(RESET_CONTINUES)
  w.usageFails = false
  await w.clock.advance(TICK)
  await w.clock.settle()
  expect((await Promise.all(held)).map((r) => r.result)).toEqual(['ran', 'ran'])
  expect(w.dialogAborted).not.toBe('no')
  expect(count(transcript(w), RESET_CONTINUES)).toBe(1)
  noConsent(w)
})

test('a sense that fails in the round after again refuses the call', SLOW, async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93, agents: ['a1'] })
  await begin($, w)
  const held = bash($)
  const req = drain($, step('a1', 'T1'))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await w.clock.set(RESET_MS + MARGIN - TICK)
  await w.clock.settle()
  w.usageFailsAfter = 1 // the due-time check reads, then every read after it fails
  await w.clock.advance(TICK)
  await w.clock.settle()
  // Nobody answered, so the loops fail closed with the text of their last round (B38, 5.3).
  expect((await held).deny).toBe(STOP(93))
  expect((await req).text).toBe(PAUSED(93))
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  expect(w.dialogAborted).not.toBe('no')
  noConsent(w)
})

test('a reading that leaves the reserve before the due time releases held work within a minute', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93, agents: ['a1'] })
  await begin($, w)
  const held = bash($)
  const req = drain($, step('a1', 'T1'))
  await w.clock.settle()
  await w.clock.advance(10 * MIN)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  w.pct = 40 // a limit-reset grant: the same window, out of the reserve
  await w.clock.advance(MIN)
  await w.clock.settle()
  expect((await held).result).toBe('ran')
  expect((await req).text).toBe('hi')
  expect(w.requests).toBe(1)
  expect(w.dialogAborted).not.toBe('no')
  expect(w.asked).toHaveLength(1)
  await w.clock.settle()
  expect(count(transcript(w), OUT_OF_RESERVE)).toBe(1)
  expect(transcript(w)).not.toContain(RESET_CONTINUES)
  noConsent(w)
})

test('without resetsAt a hold ends one window after the first sight, not at the one-hour fallback', SLOW, async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93, resetsAt: null })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  // Past the one-hour fallback and its margin: still held.
  await w.clock.set(T0 + HOUR + MARGIN + TICK)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.dialogAborted).toBe('no')
  // One tick before the hold end (first sight plus 5 h) plus the margin: still held.
  await w.clock.set(T0 + 5 * HOUR + MARGIN - TICK)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  await w.clock.set(T0 + 5 * HOUR + MARGIN + TICK)
  await w.clock.settle()
  expect((await held).result).toBe('ran')
  expect(w.dialogAborted).not.toBe('no')
  expect(w.asked).toHaveLength(1) // the unchanged figure is stale one window after its first sight (3.1)
  noConsent(w)
})

// ---- autoResume off (0.1 behaviour) ----

test('autoResume off: the question waits past the reset, B6 once, and a stop sends nothing', SLOW, async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93, env: { SPARE10_AUTO_RESUME: 'off' } })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(93, AT, false)])
  await pastDue(w, RESETS)
  await w.clock.advance(3 * TICK)
  w.cap() // a carrier cycle as well
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.dialogAborted).toBe('no')
  expect(count(transcript(w), RESET_WAITING)).toBe(1)
  expect(transcript(w)).not.toContain(RESET_CONTINUES)
  w.release('Resume') // a later answer applies as 0.1
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w)).toContain(NEW_WINDOW)
  noConsent(w) // R10: no consent for a window that ended
  expect(count(transcript(w), RESET_WAITING)).toBe(1)
  // A stop in the next window, with work: it ends by time and sends nothing.
  w.resetsAt = LATER
  expect((await $.command.run(cmd('stop'))).text).toBe('stopped at the reserve. Type a prompt to be asked again, or run /spare10 resume.') // 0.1 (2.8)
  await w.clock.settle()
  expect((await bash($)).deny).toBe(STOP(93, hhmm(LATER_MS)))
  await w.clock.settle()
  const raw = w.env.get('SPARE10_STOPPED')
  expect(raw?.startsWith('S1 ')).toBe(true)
  expect(tagsOf(raw)).not.toContain('auto')
  expect(tagsOf(raw)).toContain('five_hour')
  await pastDue(w, LATER)
  await w.clock.advance(3 * TICK)
  await w.clock.settle()
  expect(w.submitted).toEqual([])
  expect(w.prompts).toEqual([])
  expect(transcript(w)).not.toContain('the 5-hour window reset. spare10 continues the stopped work.')
  expect(transcript(w).filter((t) => t.includes('and the stop is over'))).toEqual([])
})

test('SPARE10_AUTO_RESUME=off switches it off for the run', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93, answer: 'Stop here', env: { SPARE10_AUTO_RESUME: 'off' } })
  await begin($, w)
  await w.clock.settle()
  expect(transcript(w).filter((t) => t.startsWith('SPARE10_AUTO_RESUME='))).toEqual([])
  expect(await report($)).toContain('  · at the reset   wait for your answer (from SPARE10_AUTO_RESUME)')
  // Stop here means stop: no auto tag, the stop lasts until the consent bound, and the notice has no until.
  expect((await bash($)).deny).toBe(STOP(93))
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(93, AT, false)])
  await w.clock.settle()
  const raw = w.env.get('SPARE10_STOPPED')
  expect(raw?.startsWith(`S1 ${RESET_MS} ${T0} `)).toBe(true)
  expect(untilOf(raw)).toBe(RESET_MS)
  expect(tagsOf(raw)).toEqual(['five_hour', 'work'])
  expect(transcript(w)).toContain(STOPPED_OFF)
  await pastDue(w, RESETS)
  await w.clock.advance(3 * TICK)
  await w.clock.settle()
  expect(w.submitted).toEqual([])
  expect(transcript(w)).not.toContain(RESET_RESUMES)
  expect(transcript(w)).not.toContain(RESET_STOP_OVER)
})

test('a bad SPARE10_AUTO_RESUME value warns, and autoResume stays on', SLOW, async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93, env: { SPARE10_AUTO_RESUME: 'maybe' } })
  await begin($, w)
  await w.clock.settle()
  expect(count(transcript(w), BAD_AUTO)).toBe(1)
  const lines = await report($)
  expect(lines).toContain(`  ⚠ ${BAD_AUTO}`)
  expect(lines).toContain('  · at the reset   continue by itself (from /config)')
  const held = bash($)
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(93)])
  await pastDue(w, RESETS)
  await w.clock.settle()
  expect((await held).result).toBe('ran')
  expect(count(transcript(w), RESET_CONTINUES)).toBe(1)
})

test('a question that names both windows stays up until the later due time', SLOW, async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93, resetsAt: SOON, weekPct: 92, weekResetsAt: RESETS })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.asked[0]?.question).toContain('Continue on both reserves until they reset')
  await w.clock.set(SOON_MS + MARGIN + 2 * TICK) // past the 5-hour due time: the weekly window still gates
  expect(w.ran).toEqual([])
  expect(w.dialogAborted).toBe('no') // not withdrawn and asked again
  expect(w.asked).toHaveLength(1)
  expect(transcript(w).some((t) => t.endsWith('Held work still waits.'))).toBe(false)
  await w.clock.set(RESET_MS + MARGIN - 1)
  expect(w.ran).toEqual([])
  await pastDue(w, RESETS)
  expect((await held).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
  noConsent(w)
})
