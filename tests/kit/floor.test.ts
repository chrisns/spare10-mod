import { test, expect } from 'claude-code/testing'
import type { Engine, ElementQuery, FoundElement } from 'claude-code/testing'
import type { PromptOrigin } from 'claude-code'
import {
  FLOOR_AT,
  MIN,
  OFF_OPENS,
  OFF_TICK,
  OPENS,
  RESETS,
  T0,
  TICK,
  WEEK_OPENS,
  WEEK_RESETS,
  bash,
  begin,
  clear,
  cmd,
  consentRec,
  drain,
  pastOpen,
  real5,
  real7,
  step,
  stopRec,
  typed,
  world,
} from '../helpers/world.ts'
import type { World } from '../helpers/world.ts'

// The resume floor through the engine (floor design B48 to B55, 7.3), in hold mode with the shipped
// floors (5 and 5) and the shipped spans (20 min and 8 h). Written from the floor design, not from the
// code: every expected text is spelled out here from section 2. Clocks are in the machine's zone, as the
// kit runs. The 5-hour window resets at RESETS (15:00 UTC), its reserve opens at OPENS (14:40 UTC). The
// weekly window resets at WEEK_RESETS (Mon 09:00 UTC), its reserve opens at WEEK_OPENS (Mon 01:00 UTC).

const SLOW = { timeoutMs: 30_000 }

const R_MS = Date.parse(RESETS)
const O_MS = Date.parse(OPENS)
const WR_MS = Date.parse(WEEK_RESETS)
const WO_MS = Date.parse(WEEK_OPENS)

// {clock} (D0.2 2.1): HH:MM, and for the weekly window the en-GB short weekday first.
const hhmm = (ms: number): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
const wk = (ms: number): string => `${new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(ms)} ${hhmm(ms)}`
// One decimal at most, no trailing .0.
const num = (n: number): string => String(Math.round(n * 10) / 10)

// {pf} and {mf} (D0.2 2.1, floor 2.3).
const pf = (used: number, reset = hhmm(R_MS)): string => `${num(used)}% used · ${num(100 - used)}% left · resets ${reset}`
const mfReserve = (used: number): string => `into your 10% reserve · ${num(100 - used)}% of quota left · resets ${hhmm(R_MS)}`
const mfFloor = (used: number): string => `into your 5% floor · ${num(100 - used)}% of quota left · resets ${hhmm(R_MS)}`

// The questions (floor 2.2).
const LEAD = '20 min before the reset'
const WEEK_LEAD = '8 h before the weekly reset'
const ASKS = `Until ${hhmm(O_MS)}, spare10 asks you again at 95% used.`
const LOOP_AFTER = (at = `${hhmm(O_MS)}, ${LEAD}`): string =>
  `If you choose Stop here or do not answer, the work waits until ${at}. Then spare10 continues it, unless a reserve is still reached.`
const PROMPT_AFTER = `If you do not answer, all of it continues at ${hhmm(O_MS)}, ${LEAD}, unless a reserve is still reached. Stop here gives your prompt back and pauses other work until ${hhmm(O_MS)}.`
const firstLoop = (used: number): string =>
  `Your 10% reserve is reached: ${pf(used)}. All work is on hold. Continue on the reserve until 95% used? ${ASKS} ${LOOP_AFTER()}`
const secondLoop = (used: number): string =>
  `Your 5% floor is reached: ${pf(used)}. All work is on hold. Continue on the last ${num(100 - used)}% until ${hhmm(R_MS)}? ${LOOP_AFTER()}`
const firstPrompt = (used: number): string =>
  `Your 10% reserve is reached: ${pf(used)}. spare10 holds your prompt and any other work. Continue on the reserve until 95% used? ${ASKS} ${PROMPT_AFTER}`
const secondPrompt = (used: number): string =>
  `Your 5% floor is reached: ${pf(used)}. spare10 holds your prompt and any other work. Continue on the last ${num(100 - used)}% until ${hhmm(R_MS)}? ${PROMPT_AFTER}`
// The D0.2 question: no floor in force.
const plainLoop = (used: number): string =>
  `Your 10% reserve is reached: ${pf(used)}. All work is on hold. Continue on the reserve until ${hhmm(R_MS)}? ${LOOP_AFTER()}`

// Text the model reads (floor 2.3).
const STOP = (m: string): string =>
  `spare10: the user stopped work at the quota reserve (${m}). Stop now and wait for the user. Do not call any further tools.`
const NOT_STARTED_FLOOR = `spare10: not started. This session is inside your 5% floor until ${hhmm(R_MS)}. Send the prompt again to be asked again, or run /spare10 resume.`

// Transcript notices (floor 2.4), without the engine's prefix.
const CONTINUING_FIRST = `continuing on your 10% reserve until 95% used. ${ASKS}`
const CONTINUING_SECOND = `continuing on your 5% floor. spare10 stays quiet until ${hhmm(R_MS)}.`
const OUT_OF_RESERVE = 'the quota is no longer in the reserve. Held work continues.'

// The report rows (floor 2.7).
const FLOOR_ROW = '  · resume floor   5%: after a Resume, spare10 asks again at 95% used (from /config)'
const WEEKLY_FLOOR_ROW = '  · weekly floor   5%: after a Resume, spare10 asks again at 95% used of the weekly window (from /config)'
const HELP_FLOOR = '/spare10 resume   continue on the reserve until the floor, or past the floor until the reset'
const HELP_02 = '/spare10 resume   continue on the reserve until the window resets'

type Logs = Pick<World, 'logs'>
const transcript = (w: Logs): string[] => w.logs.filter((l) => l.to !== 'debug').map((l) => l.text)
const questions = (w: World): string[] => w.asked.map((a) => a.question)

async function run($: Engine, args: string, kind: PromptOrigin['kind'] = 'composer'): Promise<string | undefined> {
  return (await $.command.run(cmd(args, kind))).text
}

async function report($: Engine): Promise<string[]> {
  return ((await run($, '')) ?? '').split('\n')
}
const phaseLine = (lines: string[]): string | undefined => lines[2]
const row = (lines: string[], label: string): string | undefined => lines.find((l) => l.startsWith(`  · ${label.padEnd(15)}`))

type Ui = { find: (q: ElementQuery) => Promise<FoundElement | undefined> }
type Shown = { text: string | undefined; color: unknown }

/** The badge as drawn: the text of the Box keyed spare10 (with its leading space) and its Text's colour. */
async function badgeOf($: Engine): Promise<Shown> {
  const ui = await $.ui.mount({ plugin: 'spare10', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  const found: Ui = ui
  const box = await found.find({ key: 'spare10' })
  const inner = (box?.children ?? []).find((c): c is { type: string; props?: Record<string, unknown> } =>
    typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'Text')
  await ui.unmount()
  return { text: box?.text, color: inner?.props?.color }
}

/** A Resume at the reserve (91% by default): a held main call, answered Resume. */
async function resumeAtReserve($: Engine, w: World, used = 91): Promise<void> {
  w.pct = used
  const held = bash($)
  await w.clock.settle()
  expect(questions(w).at(-1)).toBe(firstLoop(used))
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, FLOOR_AT))
}

// ---- B48 to B50, B52: the owner's example ----

test('the owner example: Resume at 91% continues to 95%, and at 95% spare10 holds and asks the second question', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  expect(transcript(w)).toContain(CONTINUING_FIRST)
  w.pct = 92
  expect((await bash($)).result).toBe('ran')
  w.pct = 94.9
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
  w.pct = 95
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([firstLoop(91), secondLoop(95)])
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // B52: ended for good, unset by compare-and-set
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
  expect(transcript(w)).toContain(CONTINUING_SECOND)
  w.pct = 99
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(2)
  expect(w.ran).toHaveLength(5)
})

test('a model request holds at the floor after a Resume at the reserve', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const held = drain($, step())
  await w.clock.settle()
  expect(questions(w)).toEqual([firstLoop(91)])
  w.pct = 96 // before the round after the Resume
  w.release('Resume')
  await w.clock.settle()
  expect(questions(w)).toEqual([firstLoop(91), secondLoop(96)])
  expect(w.requests).toBe(0)
  w.release('Resume')
  expect((await held).text).toBe('hi')
  expect(w.requests).toBe(1)
})

test('a prompt holds at the floor after a Resume at the reserve', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const p = $.prompt.submit(typed('go on'))
  await w.clock.settle()
  expect(questions(w)).toEqual([firstPrompt(91)])
  w.pct = 96
  w.release('Resume')
  await w.clock.settle()
  expect(questions(w)).toEqual([firstPrompt(91), secondPrompt(96)])
  expect(w.prompts).toEqual([])
  w.release('Resume')
  expect(await p).toMatchObject({ text: 'go on' })
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]?.context).toBeUndefined() // not stopped: no note
})

test('a call at the floor joins an open step question in its loop wording', async ($, on) => {
  const w = world(on, { pct: 96 })
  await begin($, w)
  const s = drain($, step())
  await w.clock.settle()
  const p = $.prompt.submit(typed('and this'))
  await w.clock.settle()
  expect(questions(w)).toEqual([secondLoop(96)])
  w.release('Resume')
  expect((await s).text).toBe('hi')
  expect(await p).toMatchObject({ text: 'and this' })
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
})

/** A Resume at 91, then a held call at 96 answered Stop here: returns its deny. */
async function stopAtSecond($: Engine, w: World): Promise<string | undefined> {
  await resumeAtReserve($, w)
  w.pct = 96
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([firstLoop(91), secondLoop(96)])
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // since the second question opened
  w.release('Stop here')
  const r = await held
  await w.clock.settle()
  return r.deny
}

test('Stop here at the second question stops as today and names the floor', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  expect(await stopAtSecond($, w)).toBe(STOP(mfFloor(96)))
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OPENS, T0, `five_hour,work,auto,skip,${real5(RESETS)}`))
  expect(transcript(w)).toContain(
    `stopped at your 5% floor until ${hhmm(O_MS)}, ${LEAD}. Then spare10 continues the work, unless a reserve is still reached. Type a prompt to be asked again, or run /spare10 resume.`,
  )
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(await badgeOf($)).toEqual({ text: ` ■ spare10: stopped until ${hhmm(O_MS)}`, color: 'warning' })
})

test('a stop keeps holding when the reading falls below the floor point', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await stopAtSecond($, w)
  w.pct = 92
  expect((await bash($)).deny).toBe(STOP(mfReserve(92)))
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
  expect(w.ran).toEqual(['Bash:main'])
})

test('a consent to the floor ends for good: a fall in the window never brings it back', SLOW, async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  w.pct = 96
  const first = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([firstLoop(91), secondLoop(96)])
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  w.pct = 92 // a fall in the window: the ended consent never applies again
  await w.clock.advance(3 * MIN) // the waiter checks the quota each minute
  expect(transcript(w)).not.toContain(OUT_OF_RESERVE)
  const joiner = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(2) // the new call joins the open question
  w.release('Stop here')
  expect((await first).deny).toBe(STOP(mfFloor(96)))
  expect((await joiner).deny).toBe(STOP(mfReserve(92)))
  await w.clock.settle()
  expect((await bash($)).deny).toBe(STOP(mfReserve(92))) // the stop
  const p = $.prompt.submit(typed('what now'))
  await w.clock.settle()
  expect(questions(w)[2]).toBe(firstPrompt(92)) // asked, not a pass
  w.release('Stop here')
  expect(await p).toMatchObject({ drop: expect.stringContaining('spare10: not started.') })
  expect(w.ran).toEqual(['Bash:main'])
  expect(w.prompts).toEqual([])
})

test('a reading past the point and back with no gate event between keeps the consent', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  w.pct = 96 // no call
  expect(row(await report($), 'consent')).toBe('  · consent        ended at 95% used (you chose to continue until then)')
  w.pct = 92
  expect(row(await report($), 'consent')).toBe(`  · consent        until 95% used or ${hhmm(R_MS)} (you chose to continue)`)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('a first trip past the floor asks the second question at once, and its Resume lasts until the reset', async ($, on) => {
  const w = world(on, { pct: 96, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(questions(w)).toEqual([secondLoop(96)])
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
  w.pct = 99
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('a reading that passes the floor while the first question waits: Resume gives the second question at once, and no call runs between', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([firstLoop(91)])
  w.pct = 96
  w.release('Resume') // the tier of the text the person read: to the floor
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(questions(w)).toEqual([firstLoop(91), secondLoop(96)])
  expect(transcript(w)).toContain(CONTINUING_FIRST) // the consent to the floor was written
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // and ended at once: its point is behind
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
})

test('a joiner during the writes of a Resume at the reserve does not pass the floor (envSetDelayMs)', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const first = bash($)
  await w.clock.settle()
  w.envSetDelayMs = 1000 // the Resume's writes stay in flight
  w.release('Resume')
  w.pct = 96
  const joiner = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([firstLoop(91), secondLoop(96)]) // the joiner never takes the first Resume
  expect(w.ran).toEqual([])
  for (let i = 0; i < 6; i += 1) await w.clock.advance(1000)
  expect(w.ran).toEqual([])
  w.release('Resume')
  expect((await first).result).toBe('ran')
  expect((await joiner).result).toBe('ran')
  for (let i = 0; i < 6; i += 1) await w.clock.advance(1000)
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
  expect(w.asked).toHaveLength(2)
})

test('the round after a Resume at the reserve passes each held gate while the reading is below the floor', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const tool = bash($)
  await w.clock.settle()
  const request = drain($, step())
  const prompt = $.prompt.submit(typed('carry on'))
  await w.clock.settle()
  expect(questions(w)).toEqual([firstLoop(93)]) // one question: the step and the prompt join it
  w.release('Resume')
  expect((await tool).result).toBe('ran')
  expect((await request).text).toBe('hi')
  expect(await prompt).toMatchObject({ text: 'carry on' })
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.requests).toBe(1)
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, FLOOR_AT))
})

// ---- B21: the badge, and B22: the report ----

test('the badge shows resumed until 95% used, and the plain consented row after the second Resume', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10: resumed until 95% used', color: 'warning' })
  w.pct = 95
  const held = bash($)
  await w.clock.settle()
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10', color: 'warning' })
})

test('/spare10 shows the floor rows, the consent to the floor, the consent that ended, and the consented phase line', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  let lines = await report($)
  expect(lines).toContain(FLOOR_ROW)
  expect(lines).toContain(WEEKLY_FLOOR_ROW)
  expect(lines.indexOf(FLOOR_ROW)).toBe(lines.findIndex((l) => l.startsWith('  · weekly opens')) + 1)
  expect(lines.at(-2)).toBe(HELP_FLOOR)
  expect(row(lines, 'consent')).toBe('  · consent        none')
  await resumeAtReserve($, w)
  lines = await report($)
  expect(phaseLine(lines)).toBe(`  ⨯ consented      you chose to continue. ${ASKS}`)
  expect(row(lines, 'consent')).toBe(`  · consent        until 95% used or ${hhmm(R_MS)} (you chose to continue)`)
  w.pct = 96
  lines = await report($)
  expect(phaseLine(lines)).toBe('  ⚠ tripped        spare10 holds the next step and asks you.')
  expect(row(lines, 'consent')).toBe('  · consent        ended at 95% used (you chose to continue until then)')
})

// ---- Both windows (B48, B54) ----

test('the weekly floor: a Resume at 91% weekly asks again at 95% weekly, with the weekly wording', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 91 })
  await begin($, w)
  const first = bash($)
  await w.clock.settle()
  const weekAfter = LOOP_AFTER(`${wk(WO_MS)}, ${WEEK_LEAD}`)
  expect(questions(w)).toEqual([
    `Your 10% weekly reserve is reached: ${pf(91, wk(WR_MS))}. All work is on hold. Continue on the weekly reserve until 95% used? ` +
      `Until ${wk(WO_MS)}, spare10 asks you again at 95% used of the weekly window. ${weekAfter}`,
  ])
  w.release('Resume')
  expect((await first).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(consentRec('S1', WEEK_RESETS, FLOOR_AT))
  expect(transcript(w)).toContain(
    `continuing on your 10% weekly reserve until 95% used. Until ${wk(WO_MS)}, spare10 asks you again at 95% used of the weekly window.`,
  )
  w.weekPct = 94
  expect((await bash($)).result).toBe('ran')
  w.weekPct = 95
  const second = bash($)
  await w.clock.settle()
  expect(questions(w)[1]).toBe(
    `Your 5% weekly floor is reached: ${pf(95, wk(WR_MS))}. All work is on hold. Continue on the last 5% of the weekly window until ${wk(WR_MS)}? ${weekAfter}`,
  )
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBeUndefined()
  w.release('Resume')
  expect((await second).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(consentRec('S1', WEEK_RESETS))
})

test('a floor per window: a 5-hour floor of 8 never ends a weekly consent to 95', async ($, on) => {
  const weekly = consentRec('S1', WEEK_RESETS, FLOOR_AT)
  const w = world(on, { pct: 93, weekPct: 93, answer: 'Resume', env: { SPARE10_RESUME_FLOOR: '8', SPARE10_WEEKLY_CONSENT: weekly } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  // Only the 5-hour window asks, at its floor: point 92.
  expect(questions(w)).toEqual([
    `Your 8% floor is reached: ${pf(93)}. All work is on hold. Continue on the last 7% until ${hhmm(R_MS)}? ${LOOP_AFTER()}`,
  ])
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(weekly) // the weekly consent still applies
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('two windows at the reserve: one question, each kind gets its end point', async ($, on) => {
  const w = world(on, { pct: 91, weekPct: 92, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(questions(w)).toEqual([
    `Your 10% reserve and your 10% weekly reserve are reached: 5-hour window ${pf(91)}, weekly window ${pf(92, wk(WR_MS))}. All work is on hold. ` +
      'Continue on both reserves until 95% used? Until its reserve opens, spare10 asks you again at 95% used of either window. ' +
      LOOP_AFTER(`${wk(WO_MS)}, ${WEEK_LEAD}`),
  ])
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, FLOOR_AT))
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(consentRec('S1', WEEK_RESETS, FLOOR_AT))
  expect(transcript(w)).toContain(
    'continuing on your 10% reserve until 95% used and your 10% weekly reserve until 95% used. Until its reserve opens, spare10 asks you again at 95% used of either window.',
  )
})

test('two windows at different stages: the reserve until 95% used and the last 4% of the weekly window', async ($, on) => {
  const w = world(on, { pct: 91, weekPct: 96, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(questions(w)).toEqual([
    `Your 10% reserve and your 5% weekly floor are reached: 5-hour window ${pf(91)}, weekly window ${pf(96, wk(WR_MS))}. All work is on hold. ` +
      `Continue on the reserve until 95% used and the last 4% of the weekly window until ${wk(WR_MS)}? ${ASKS} ` +
      LOOP_AFTER(`${wk(WO_MS)}, ${WEEK_LEAD}`),
  ])
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, FLOOR_AT))
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(consentRec('S1', WEEK_RESETS))
  expect(transcript(w)).toContain(`continuing on your 10% reserve until 95% used and your 5% weekly floor until ${wk(WR_MS)}. ${ASKS}`)
})

// ---- 3.3: the consent value ----

test('a 0.2 consent value is full: no second question in its window', async ($, on) => {
  const w = world(on, { pct: 96, env: { SPARE10_CONSENT: `S1 ${RESETS}` } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  w.pct = 93
  expect(await run($, 'resume')).toBe(`already resumed until ${hhmm(R_MS)}.`)
  expect(w.asked).toEqual([])
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
})

test('a consent to the floor in the env counts after a reload, and ends at its point', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_CONSENT: consentRec('S1', RESETS, FLOOR_AT) } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  w.pct = 95
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([secondLoop(95)])
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

test('a junk end point makes the consent unreadable, so spare10 asks', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_CONSENT: `S1 ${RESETS} to:abc` } })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([firstLoop(93)])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, FLOOR_AT))
})

const MOVED: Array<{ name: string; floor: string; runsAt: number; holdsAt: number; question: (used: number) => string }> = [
  {
    name: 'a floor lowered after a Resume keeps the Resume end point',
    floor: '3',
    runsAt: 94.9,
    holdsAt: 95,
    question: (used) =>
      `Your 10% reserve is reached: ${pf(used)}. All work is on hold. Continue on the reserve until 97% used? Until ${hhmm(O_MS)}, spare10 asks you again at 97% used. ${LOOP_AFTER()}`,
  },
  {
    name: 'a floor raised after a Resume ends it earlier',
    floor: '8',
    runsAt: 91.9,
    holdsAt: 92,
    question: (used) => `Your 8% floor is reached: ${pf(used)}. All work is on hold. Continue on the last ${num(100 - used)}% until ${hhmm(R_MS)}? ${LOOP_AFTER()}`,
  },
]
for (const c of MOVED) {
  test(`${c.name} (SPARE10_RESUME_FLOOR=${c.floor})`, async ($, on) => {
    const w = world(on, { pct: c.runsAt, env: { SPARE10_RESUME_FLOOR: c.floor, SPARE10_CONSENT: consentRec('S1', RESETS, FLOOR_AT) } })
    await begin($, w)
    expect((await bash($)).result).toBe('ran')
    w.pct = c.holdsAt
    const held = bash($)
    await w.clock.settle()
    expect(questions(w)).toEqual([c.question(c.holdsAt)])
    w.release('Stop here')
    await held
  })
}

// ---- 5: options and variables ----

test('SPARE10_RESUME_FLOOR=0 gives the 0.2 question and a Resume until the reset', async ($, on) => {
  const w = world(on, { pct: 91, answer: 'Resume', env: { SPARE10_RESUME_FLOOR: '0' } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(questions(w)).toEqual([plainLoop(91)])
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
  expect(transcript(w)).toContain(`continuing on your 10% reserve. spare10 stays quiet until ${hhmm(R_MS)}.`)
  const lines = await report($)
  expect(row(lines, 'resume floor')).toBe('  · resume floor   off. A Resume lasts until the reset (from SPARE10_RESUME_FLOOR)')
  expect(row(lines, 'weekly floor')).toBe(WEEKLY_FLOOR_ROW) // floors are per window
  expect(lines.at(-2)).toBe(HELP_FLOOR) // the weekly floor is still in force
  w.pct = 99
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('a floor at or above the reserve does nothing and warns', async ($, on) => {
  const w = world(on, { pct: 91, weekPct: 50, env: { SPARE10_RESUME_FLOOR: '10', SPARE10_WEEKLY_RESUME_FLOOR: '0' } })
  await begin($, w)
  const warning = 'the resume floor (10%) is not below the reserve (10%), so it does nothing. Set it below the reserve, or to 0.'
  expect(transcript(w).filter((t) => t === warning)).toHaveLength(1)
  const lines = await report($)
  expect(row(lines, 'resume floor')).toBe('  · resume floor   10% does nothing, because it is not below the reserve (from SPARE10_RESUME_FLOOR)')
  expect(lines).toContain(`  ⚠ ${warning}`)
  expect(lines.at(-2)).toBe(HELP_02)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([plainLoop(91)])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
})

test('a bad SPARE10_RESUME_FLOOR warns and keeps 5', async ($, on) => {
  const w = world(on, { pct: 91, env: { SPARE10_RESUME_FLOOR: 'lots' } })
  await begin($, w)
  expect(transcript(w)).toContain('SPARE10_RESUME_FLOOR="lots" is not 0 to 99. spare10 uses 5.')
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([firstLoop(91)])
  expect(row(await report($), 'resume floor')).toBe(FLOOR_ROW)
  w.release('Stop here')
  await held
})

test('a --bg session names the floor variables that it got from the daemon', async ($, on) => {
  const w = world(on, { pct: 50, env: { CLAUDE_CODE_SESSION_KIND: 'bg', SPARE10_RESUME_FLOOR: '3', SPARE10_WEEKLY_RESUME_FLOOR: '0' } })
  await begin($, w)
  const warning =
    'this background session has SPARE10_RESUME_FLOOR="3", SPARE10_WEEKLY_RESUME_FLOOR="0". ' +
    'A background session gets such values from the claude daemon or a settings file, not from your terminal.'
  expect(transcript(w).filter((t) => t === warning)).toHaveLength(1)
})

// ---- Skip wins (DS B41) ----

test('the second question with autoResume on continues at the skip start (skip wins)', SLOW, async ($, on) => {
  const w = world(on, { pct: 96 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([secondLoop(96)])
  await pastOpen(w)
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w)).toContain(`the 5-hour window resets at ${hhmm(R_MS)}. Your 10% reserve is open until then. Held work continues.`)
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect((await bash($)).result).toBe('ran')
})

test('inside the skip window a consent to the floor at its point holds nothing', SLOW, async ($, on) => {
  const w = world(on, { pct: 96, env: { SPARE10_CONSENT: consentRec('S1', RESETS, FLOOR_AT) } })
  await begin($, w)
  await w.clock.set(O_MS + 5 * MIN)
  expect((await bash($)).result).toBe('ran')
  expect(await drain($, step())).toMatchObject({ text: 'hi' })
  expect(w.asked).toEqual([])
})

test('inside the skip window a kind with only a consent to the floor is open, not consented', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_CONSENT: consentRec('S1', RESETS, FLOOR_AT) } })
  await begin($, w)
  await w.clock.set(O_MS + 5 * MIN)
  expect(await badgeOf($)).toEqual({ text: ` ↻ spare10: reserve open until ${hhmm(R_MS)}`, color: 'warning' })
  expect(phaseLine(await report($))).toBe(
    `  ↻ open           the reset is near. Your 10% reserve is open until ${hhmm(R_MS)}, so spare10 lets all work through.`,
  )
  expect(await run($, 'resume')).toBe(`nothing to resume. The reset is near, so your 10% reserve is open until ${hhmm(R_MS)}.`)
  expect((await bash($)).result).toBe('ran')
})

test('/spare10 resume names only the windows that are not open while a consent to the floor applies (2.8)', SLOW, async ($, on) => {
  const w = world(on, {
    pct: 93,
    weekPct: 93,
    env: { SPARE10_CONSENT: `S1 ${RESETS}`, SPARE10_WEEKLY_CONSENT: consentRec('S1', WEEK_RESETS, FLOOR_AT) },
  })
  await begin($, w)
  await w.clock.set(O_MS + 5 * MIN) // the 5-hour reserve is open, and its full consent still covers it
  expect(await run($, 'resume')).toBe(
    `already resumed until 95% used of the weekly window. Until ${wk(WO_MS)}, spare10 asks you again at 95% used of the weekly window.`,
  )
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
})

// ---- B10, B9 at the floor ----

test('the prompt question at the floor: Stop here gives the prompt back with the floor reason', async ($, on) => {
  const w = world(on, { pct: 96, answer: 'Stop here' })
  await begin($, w)
  expect(await $.prompt.submit(typed('carry on'))).toEqual({ drop: NOT_STARTED_FLOOR })
  await w.clock.settle()
  expect(questions(w)).toEqual([secondPrompt(96)])
  expect(w.box).toBe('carry on')
  expect(w.prompts).toEqual([])
})

test('a Resume on a prompt question at the floor in a stopped session carries the floor note', async ($, on) => {
  const w = world(on, { pct: 96, answer: 'Stop here' })
  await begin($, w)
  expect((await bash($)).deny).toBe(STOP(mfFloor(96)))
  await w.clock.settle()
  w.answer = 'Resume'
  expect(await $.prompt.submit(typed('go'))).toMatchObject({ text: 'go' })
  expect(questions(w)).toEqual([secondLoop(96), secondPrompt(96)])
  expect(w.prompts.map((p) => p.context)).toEqual([
    [`spare10: earlier work stopped at the 5% quota floor. The user now chose to continue on the last 4% until ${hhmm(R_MS)}. Follow their message.`],
  ])
})

test('a Resume on a prompt question at the reserve in a stopped session carries the note with the end point', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Stop here' })
  await begin($, w)
  expect((await bash($)).deny).toBe(STOP(mfReserve(93)))
  await w.clock.settle()
  w.answer = 'Resume'
  expect(await $.prompt.submit(typed('go'))).toMatchObject({ text: 'go' })
  expect(w.prompts.map((p) => p.context)).toEqual([
    ['spare10: earlier work stopped at the 10% quota reserve. The user now chose to continue on the reserve until 95% used. Follow their message.'],
  ])
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, FLOOR_AT))
})

// ---- Beyond 7.3: the test seam (B53), the command tiers (B50), tell mode (B51) and unattended runs (B55) ----

test('the test seam: simulate 91, Resume, simulate 96 asks the second question', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  const opens = `The reserve opens at ${hhmm(O_MS)}, 20 min before the test window ends.`
  expect(await run($, 'simulate 91')).toBe(
    `test reading set to 91% used, resets ${hhmm(R_MS)}. It can only raise the real reading. ${opens} Run /spare10 simulate off to clear it.`,
  )
  const first = bash($)
  await w.clock.settle()
  expect(questions(w)[0]).toBe(
    `Your 10% reserve is reached: ${pf(91)}. All work is on hold. Continue on the reserve until 95% used? ${ASKS} ` +
      LOOP_AFTER(`${hhmm(O_MS)}, 20 min before the test window ends`),
  )
  w.release('Resume')
  expect((await first).result).toBe('ran')
  await w.clock.settle()
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10 (test): resumed until 95% used', color: 'warning' })
  expect(await run($, 'simulate 96')).toBe(
    `test reading raised to 96% used, resets ${hhmm(R_MS)}. Your earlier answers stay. It can only raise the real reading. This is past your 5% floor. ${opens} Run /spare10 simulate off to clear it.`,
  )
  const second = bash($)
  await w.clock.settle()
  expect(questions(w)[1]).toBe(
    `Your 5% floor is reached: ${pf(96)}. All work is on hold. Continue on the last 4% until ${hhmm(R_MS)}? ` +
      LOOP_AFTER(`${hhmm(O_MS)}, 20 min before the test window ends`),
  )
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // a test consent never reaches the env
  w.release('Resume')
  expect((await second).result).toBe('ran')
  await w.clock.settle()
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10 (test)', color: 'warning' })
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
})

test('simulate raises in place only upward and without in: the same value, a lower value or in starts a new test', async ($, on) => {
  const w = world(on, { pct: 50, answer: 'Resume' })
  await begin($, w)
  await run($, 'simulate 95')
  expect((await bash($)).result).toBe('ran') // the second question at 95: a full test consent
  const consent = `  · consent        until ${hhmm(R_MS)} (you chose to continue)`
  expect(row(await report($), 'consent')).toBe(consent)
  expect(await run($, 'simulate 96')).toStartWith('test reading raised to 96% used')
  expect(row(await report($), 'consent')).toBe(consent)
  expect(await run($, 'simulate 96')).toStartWith('test reading set to 96% used') // the same value: a new test
  expect(row(await report($), 'consent')).toBe('  · consent        none')
  expect((await bash($)).result).toBe('ran')
  expect(row(await report($), 'consent')).toBe(consent)
  expect(await run($, 'simulate 94')).toStartWith('test reading set to 94% used') // a lower value: a new test
  expect(row(await report($), 'consent')).toBe('  · consent        none')
  expect((await bash($)).result).toBe('ran')
  expect(await run($, 'simulate 97 in 1h')).toStartWith('test reading set to 97% used') // with in: a new test
  expect(row(await report($), 'consent')).toBe('  · consent        none')
  expect(w.asked).toHaveLength(3)
})

test('/spare10 resume before the floor consents to the floor, past the floor until the reset', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  expect(await run($, 'resume')).toBe(`you can use the reserve until 95% used. ${ASKS}`)
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, FLOOR_AT))
  w.pct = 93
  expect(await run($, 'resume')).toBe(`already resumed until 95% used. ${ASKS}`)
  expect((await bash($)).result).toBe('ran')
  w.pct = 96
  expect(await run($, 'resume')).toBe(`you can use the last 4% until ${hhmm(R_MS)}.`)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
  expect(await run($, 'resume')).toBe(`already resumed until ${hhmm(R_MS)}.`)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
})

test('/spare10 resume on an open first question whose reading passed the floor consents until the reset', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([firstLoop(91)])
  w.pct = 96
  expect(await run($, 'resume')).toBe(`resumed. Held work continues on the last 4% until ${hhmm(R_MS)}.`)
  expect((await held).result).toBe('ran') // no second question
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
})

test('/spare10 resume on an open first question below the floor replies with the end point', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(await run($, 'resume')).toBe(`resumed. Held work continues on the reserve until 95% used. ${ASKS}`)
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, FLOOR_AT))
})

test('another copy consent to the floor never answers a second question, a full one does', async ($, on) => {
  const w = world(on, { pct: 96 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([secondLoop(96)])
  w.env.set('SPARE10_CONSENT', consentRec('S1', RESETS, FLOOR_AT)) // another copy's Resume at the reserve
  w.cap() // the next carrier cycle
  await w.clock.settle()
  expect(w.ran).toEqual([]) // still held: it does not answer a kind asked at the floor
  w.env.set('SPARE10_CONSENT', consentRec('S1', RESETS)) // another copy's second Resume
  w.cap()
  expect((await held).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

const TELL = { SPARE10_PAUSE_PROMPT: 'Say done and stop.' }
const tellText = (m: string, floor: boolean): string =>
  `spare10 budget guard. You have reached ${floor ? 'the floor of the quota reserve' : 'the safe usage limit'} for this session (${m}). ` +
  'Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.\n\nUser instructions: Say done and stop.'

test('tell mode: each loop is told at the reserve and again at the floor', async ($, on) => {
  const w = world(on, { pct: 91, agents: ['a1'], env: TELL })
  await begin($, w)
  expect((await bash($)).context).toEqual([tellText(mfReserve(91), false)])
  expect((await bash($, 'a1')).context).toEqual([tellText(mfReserve(91), false)])
  expect((await bash($)).context).toBeUndefined() // once per loop and stage
  expect(await badgeOf($)).toEqual({ text: ' ⏸ spare10', color: 'warning' })
  w.pct = 95
  // B51: the told phase counts the loops told at the stage now. Before the first tell at the floor, the
  // badge and the report show the tripped row again.
  expect((await badgeOf($)).text?.trim().endsWith('Winding down at next step')).toBe(true)
  expect(phaseLine(await report($))).toBe('  ⚠ tripped        spare10 tells each agent to wind down at its next step.')
  expect((await bash($)).context).toEqual([tellText(mfFloor(95), true)])
  expect((await bash($, 'a1')).context).toEqual([tellText(mfFloor(95), true)])
  expect((await bash($)).context).toBeUndefined()
  await w.clock.settle()
  expect(transcript(w).filter((t) => t.includes('told the agents'))).toEqual([
    'your 10% reserve is reached. spare10 told the agents to wind down.',
    'your 5% floor is reached. spare10 told the agents to wind down.',
  ])
  expect(w.asked).toEqual([])
})

test('tell mode: a Resume at the reserve holds the tells back until the floor, and a prompt at the floor asks the second question', async ($, on) => {
  const w = world(on, { pct: 91, env: TELL, answer: 'Resume' })
  await begin($, w)
  expect(await $.prompt.submit(typed('go'))).toMatchObject({ text: 'go' })
  expect(questions(w)).toEqual([
    `Your 10% reserve is reached: ${pf(91)}. spare10 holds your prompt. Continue on the reserve until 95% used? ` +
      `Until ${hhmm(O_MS)}, spare10 tells the agents to wind down at 95% used. If you do not answer, your prompt goes in at ${hhmm(O_MS)}, ${LEAD}, unless a reserve is still reached. Stop here gives it back to you.`,
  ])
  await w.clock.settle()
  expect(transcript(w)).toContain(`continuing on your 10% reserve until 95% used. Until ${hhmm(O_MS)}, spare10 tells the agents to wind down at 95% used.`)
  w.pct = 93
  expect((await bash($)).context).toBeUndefined() // consented: no tell
  w.pct = 96
  w.answer = 'Stop here'
  expect(await $.prompt.submit(typed('more'))).toEqual({
    drop: `spare10: not started. This session is inside your 5% floor until ${hhmm(R_MS)}. Send the prompt again to be asked again, or run /spare10 resume.`,
  })
  expect(questions(w)[1]).toBe(
    `Your 5% floor is reached: ${pf(96)}. spare10 holds your prompt. Continue on the last 4% until ${hhmm(R_MS)}? ` +
      `If you do not answer, your prompt goes in at ${hhmm(O_MS)}, ${LEAD}, unless a reserve is still reached. Stop here gives it back to you.`,
  )
  expect((await bash($)).context).toEqual([tellText(mfFloor(96), true)])
  // The consent to the floor ended for good: after a fall, a prompt asks the first question again.
  w.pct = 92
  expect(await $.prompt.submit(typed('again'))).toMatchObject({ drop: expect.stringContaining('spare10: not started.') })
  expect(w.asked).toHaveLength(3)
})

test('-p with an inherited consent to the floor runs to its point, then its policy applies', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop', SPARE10_CONSENT: consentRec('S0', RESETS, FLOOR_AT) } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  w.pct = 95
  const out = await drain($, step())
  expect(out.text).toBe(
    `spare10 stopped this unattended run at the quota reserve (${mfReserve(95)}). No further model requests were sent. To pick it up later: claude --resume S1`,
  )
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // ended in the child's own env
  expect(w.asked).toEqual([])
  const lines = await report($)
  expect(row(lines, 'resume floor')).toBe('  · resume floor   5%: this run is unattended and never asks, so the floor does nothing (from /config)')
})

test('-p prompt: each loop is told once per window, also past the floor', async ($, on) => {
  const w = world(on, { pct: 91, surfaces: [], env: { SPARE10_HEADLESS: 'prompt' } })
  await begin($, w)
  const told = (await bash($)).context
  expect(told).toHaveLength(1)
  expect(told?.[0]).toStartWith('spare10 budget guard. You have reached the safe usage limit for this session (into your 10% reserve')
  w.pct = 96
  expect((await bash($)).context).toBeUndefined()
})

// ---- Beyond 7.3: the env value (3.3), TS1 and a stop extension (4.6) with the shipped floors ----

test('/clear keeps a consent to the floor with its end point, and moves its stamp', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  await clear($, w, 'S2')
  w.pct = 93
  expect((await bash($)).result).toBe('ran') // the ended id is this process's: its consent counts
  await w.clock.advance(1500) // the redraws after /clear restamp the value
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S2', RESETS, FLOOR_AT))
  w.pct = 95
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([firstLoop(91), secondLoop(95)])
  w.release('Stop here')
  await held
})

test('a late write of a consent to the floor never replaces a full value', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  w.env.set('SPARE10_CONSENT', consentRec('S1', RESETS)) // another copy's second Resume, before this one's write
  w.release('Resume') // at once: no carrier cycle between
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS)) // the stronger tier stays
  w.pct = 96
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('a real consent to the floor survives a Stop here on a test reading, and the stop releases on it', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_CONSENT: consentRec('S1', RESETS, FLOOR_AT) } })
  await begin($, w)
  const end = T0 + 22 * MIN
  const start = T0 + 2 * MIN
  await run($, 'simulate 97 in 22m')
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([
    `Your 5% floor is reached: ${pf(97, hhmm(end))}. All work is on hold. Continue on the last 3% until ${hhmm(end)}? ` +
      LOOP_AFTER(`${hhmm(start)}, 20 min before the test window ends`),
  ])
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(`into your 5% floor · 3% of quota left · resets ${hhmm(end)}`))
  await w.clock.settle()
  // The real reading (93) is below the point of the real consent: no real tag, and the consent stays.
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', start, T0, 'five_hour,work,auto,test,skip'))
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, FLOOR_AT))
  await pastOpen(w, new Date(start).toISOString())
  expect(w.env.has('SPARE10_STOPPED')).toBe(false) // released on the real consent: no extension
  expect(w.submitted).toHaveLength(1)
  expect(transcript(w).filter((t) => t.includes('The stop lasts until'))).toEqual([])
  expect(w.asked).toHaveLength(1)
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, FLOOR_AT))
})

test('a Stop here over a test window writes the real tag when the real reading is past its consent point', async ($, on) => {
  const w = world(on, { pct: 96, env: { SPARE10_CONSENT: consentRec('S1', RESETS, FLOOR_AT) } })
  await begin($, w)
  await run($, 'simulate 97 in 22m')
  const held = bash($)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // the real reading ended it (B52)
  w.release('Stop here')
  await held
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', T0 + 2 * MIN, T0, `five_hour,work,auto,test,skip,${real5(RESETS)}`))
})

test('a 5-hour stop extends to a weekly kind at its floor, and a weekly fall still refuses', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 93, env: { SPARE10_WEEKLY_CONSENT: consentRec('S1', WEEK_RESETS, FLOOR_AT) } })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([firstLoop(93)]) // the weekly consent applies: only the 5-hour window asks
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(mfReserve(93)))
  await w.clock.settle()
  w.weekPct = 96
  await pastOpen(w)
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', WEEK_OPENS, T0, `seven_day,work,auto,skip,${real7(WEEK_RESETS)}`))
  expect(transcript(w).some((t) => t.includes(`your 5% weekly floor is reached. The stop lasts until ${wk(WO_MS)}, ${WEEK_LEAD}.`))).toBe(true)
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBeUndefined()
  expect(w.submitted).toEqual([])
  w.weekPct = 92
  expect((await bash($)).deny).toBe(STOP(`into your 10% weekly reserve · 8% of weekly quota left · resets ${wk(WR_MS)}`))
  expect(w.asked).toHaveLength(1)
})

// ---- B46 and the takeover at the second question (floor design 7.4) ----

test('a late Stop here at a second question (B46) names the floor, and the work continues soon', SLOW, async ($, on) => {
  const w = world(on, { pct: 96, resetsAt: OFF_TICK })
  await begin($, w)
  const off = Date.parse(OFF_TICK)
  const offOpens = Date.parse(OFF_OPENS)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([
    `Your 5% floor is reached: ${pf(96, hhmm(off))}. All work is on hold. Continue on the last 4% until ${hhmm(off)}? ${LOOP_AFTER(`${hhmm(offOpens)}, ${LEAD}`)}`,
  ])
  const answeredAt = offOpens + 5000
  await w.clock.set(answeredAt) // past the skip start, before the tick that would release it
  expect(w.ran).toEqual([])
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(`into your 5% floor · 4% of quota left · resets ${hhmm(off)}`))
  await w.clock.settle()
  expect(transcript(w)).toContain(
    `stopped at your 5% floor. The 5-hour window resets at ${hhmm(off)}. Your 10% reserve is open until then, so spare10 continues the work soon, unless a reserve is still reached.`,
  )
  expect(transcript(w).some((t) => t.includes(`until ${hhmm(offOpens)}`))).toBe(false) // no past time
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OFF_OPENS, answeredAt, 'five_hour,work,auto,skip'))
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  expect(w.submitted).toEqual([])
  await w.clock.advance(TICK) // the next tick continues the stopped work
  await w.clock.settle()
  expect(w.submitted).toHaveLength(1)
  expect((await bash($)).result).toBe('ran') // skip wins over the floor
  expect(w.asked).toHaveLength(1)
})

test('a person prompt after the skip start takes over a stop at the second question with the open note, and asks nothing', SLOW, async ($, on) => {
  const w = world(on, { pct: 96, resetsAt: OFF_TICK, answer: 'Stop here' })
  await begin($, w)
  const off = Date.parse(OFF_TICK)
  const offOpens = Date.parse(OFF_OPENS)
  expect((await bash($)).deny).toBe(STOP(`into your 5% floor · 4% of quota left · resets ${hhmm(off)}`))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OFF_OPENS, T0, `five_hour,work,auto,skip,${real5(OFF_TICK)}`))
  expect(transcript(w)).toContain(
    `stopped at your 5% floor until ${hhmm(offOpens)}, ${LEAD}. Then spare10 continues the work, unless a reserve is still reached. Type a prompt to be asked again, or run /spare10 resume.`,
  )
  await w.clock.set(offOpens + 5000) // past the skip start, before the tick that would release it
  expect(await $.prompt.submit(typed('go on'))).toMatchObject({ text: 'go on' })
  const event = `the 5-hour window resets at ${hhmm(off)}. Your 10% reserve is open until then`
  expect(w.prompts.map((p) => p.context)).toEqual([
    [
      `spare10: earlier work stopped at the quota reserve. The 5-hour window resets at ${hhmm(off)}. Your 10% reserve is open until then, so the stop is over. ` +
        "The stopped task is not finished. After the user's message, continue it unless the user says otherwise.",
    ],
  ])
  await w.clock.settle()
  expect(transcript(w)).toContain(`${event}, and the stop is over.`)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  await w.clock.advance(3 * TICK)
  expect(w.submitted).toEqual([]) // no resume prompt after the next tick
  expect((await bash($)).result).toBe('ran') // skip wins over the floor: no second question
  expect(w.asked).toHaveLength(1)
})
