import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ToolCallResult } from 'claude-code'
import {
  LATER,
  MIN,
  OPENS,
  RESETS,
  T0,
  TICK,
  WEEK_NEAR,
  WEEK_NEAR_OPENS,
  WEEK_OPENS,
  WEEK_RESETS,
  bash,
  begin,
  cmd,
  consentRec,
  drain,
  pastDue,
  pastOpen,
  real5,
  step,
  stopRe,
  stopRec,
  typed,
  world,
} from '../helpers/world.ts'
import type { World } from '../helpers/world.ts'

// The resume floor at the gate (floor design B48 to B55, 2.2 to 2.4, 4.4 to 4.6), an independent set
// beside floor.test.ts. Written from the floor design, not from the code: every expected text is
// spelled out here from section 2, never taken from hooks/core/text.ts. The default world has the
// shipped floors (5 and 5) and the shipped spans (20 min and 8 h). Clocks are in the machine's zone,
// as the kit runs: the 5-hour window resets at RESETS, its reserve opens at OPENS. The weekly window
// resets at WEEK_RESETS, its reserve opens at WEEK_OPENS.

// Held waiters check on every tick for hours of mock time: allow more than the 5 s default.
const SLOW = { timeoutMs: 30_000 }

const R_MS = Date.parse(RESETS)
const O_MS = Date.parse(OPENS)
const WR_MS = Date.parse(WEEK_RESETS)
const WO_MS = Date.parse(WEEK_OPENS)

// ---- 2.1 placeholders ----

const hhmm = (ms: number): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
const wk = (ms: number): string => `${new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(ms)} ${hhmm(ms)}`
/** One decimal at most, no trailing .0. */
const n1 = (n: number): string => String(Math.round(n * 10) / 10)

const R5 = hhmm(R_MS) // the 5-hour reset
const O5 = hhmm(O_MS) // its skip start
const RW = wk(WR_MS) // the weekly reset
const OW = wk(WO_MS) // its skip start

/** {pf} of one kind. */
const pf = (used: number, reset: string): string => `${n1(used)}% used · ${n1(100 - used)}% left · resets ${reset}`
/** {pf} of two kinds, five_hour first. */
const both = (u5: number, uw: number): string => `5-hour window ${pf(u5, R5)}, weekly window ${pf(uw, RW)}`

// {lead}, {after} (the 0.2 and DS parts, unchanged) and {asks} (2.1).
const LEAD5 = '20 min before the reset'
const LEADW = '8 h before the weekly reset'
const LEAD_TEST = '20 min before the test window ends'
const loopAfter = (when: string): string =>
  `If you choose Stop here or do not answer, the work waits until ${when}. Then spare10 continues it, unless a reserve is still reached.`
const AFTER5 = loopAfter(`${O5}, ${LEAD5}`)
const AFTERW = loopAfter(`${OW}, ${LEADW}`)
const PROMPT_AFTER5 = `If you do not answer, all of it continues at ${O5}, ${LEAD5}, unless a reserve is still reached. Stop here gives your prompt back and pauses other work until ${O5}.`
const TELL_AFTER5 = `If you do not answer, your prompt goes in at ${O5}, ${LEAD5}, unless a reserve is still reached. Stop here gives it back to you.`
const ASKS5 = `Until ${O5}, spare10 asks you again at 95% used.`
const ASKSW = `Until ${OW}, spare10 asks you again at 95% used of the weekly window.`
const TELLS5 = `Until ${O5}, spare10 tells the agents to wind down at 95% used.`

// ---- 2.2 the questions ----

const first5 = (used: number): string =>
  `Your 10% reserve is reached: ${pf(used, R5)}. All work is on hold. Continue on the reserve until 95% used? ${ASKS5} ${AFTER5}`
const second5 = (used: number): string =>
  `Your 5% floor is reached: ${pf(used, R5)}. All work is on hold. Continue on the last ${n1(100 - used)}% until ${R5}? ${AFTER5}`
const firstPrompt5 = (used: number): string =>
  `Your 10% reserve is reached: ${pf(used, R5)}. spare10 holds your prompt and any other work. Continue on the reserve until 95% used? ${ASKS5} ${PROMPT_AFTER5}`
const secondPrompt5 = (used: number): string =>
  `Your 5% floor is reached: ${pf(used, R5)}. spare10 holds your prompt and any other work. Continue on the last ${n1(100 - used)}% until ${R5}? ${PROMPT_AFTER5}`
const firstTell5 = (used: number): string =>
  `Your 10% reserve is reached: ${pf(used, R5)}. spare10 holds your prompt. Continue on the reserve until 95% used? ${TELLS5} ${TELL_AFTER5}`
const secondTell5 = (used: number): string =>
  `Your 5% floor is reached: ${pf(used, R5)}. spare10 holds your prompt. Continue on the last ${n1(100 - used)}% until ${R5}? ${TELL_AFTER5}`
/** The 0.2 question: no floor in force. */
const plain5 = (used: number, reserve = 10): string =>
  `Your ${reserve}% reserve is reached: ${pf(used, R5)}. All work is on hold. Continue on the reserve until ${R5}? ${AFTER5}`
const firstW = (used: number): string =>
  `Your 10% weekly reserve is reached: ${pf(used, RW)}. All work is on hold. Continue on the weekly reserve until 95% used? ${ASKSW} ${AFTERW}`
const secondW = (used: number, floor = 5): string =>
  `Your ${floor}% weekly floor is reached: ${pf(used, RW)}. All work is on hold. Continue on the last ${n1(100 - used)}% of the weekly window until ${RW}? ${AFTERW}`

// ---- 2.3 texts the model reads ----

const mf5 = (used: number): string => `into your 10% reserve · ${n1(100 - used)}% of quota left · resets ${R5}`
const mfFloor5 = (used: number): string => `into your 5% floor · ${n1(100 - used)}% of quota left · resets ${R5}`
const STOP = (m: string): string =>
  `spare10: the user stopped work at the quota reserve (${m}). Stop now and wait for the user. Do not call any further tools.`
const PAUSED = (m: string): string =>
  `spare10: work stopped at the quota reserve (${m}). No model request was sent, so this task is not finished. Wait for the user.`
const PAUSE = 'Commit and stop.'
const TELL = { SPARE10_PAUSE_PROMPT: PAUSE }
const GUARD_TAIL = 'Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.'
const reserveTell = (used: number): string =>
  `spare10 budget guard. You have reached the safe usage limit for this session (${mf5(used)}). ${GUARD_TAIL}\n\nUser instructions: ${PAUSE}`
const floorTell = (used: number): string =>
  `spare10 budget guard. You have reached the floor of the quota reserve for this session (${mfFloor5(used)}). ${GUARD_TAIL}\n\nUser instructions: ${PAUSE}`
/** B12 of an unattended prompt policy with no pause prompt (0.2): no user instructions. */
const plainTell = (used: number): string =>
  `spare10 budget guard. You have reached the safe usage limit for this session (${mf5(used)}). ${GUARD_TAIL}`
const NOT_STARTED_FLOOR = `spare10: not started. This session is inside your 5% floor until ${R5}. Send the prompt again to be asked again, or run /spare10 resume.`
const NOT_STARTED_RESERVE = `spare10: not started. This session is inside your 10% reserve until ${R5}. Send the prompt again to be asked again, or run /spare10 resume.`
const floorNote = (used: number): string =>
  `spare10: earlier work stopped at the 5% quota floor. The user now chose to continue on the last ${n1(100 - used)}% until ${R5}. Follow their message.`
const HEADLESS = (used: number, sid = 'S1'): string =>
  `spare10 stopped this unattended run at the quota reserve (${mf5(used)}). No further model requests were sent. To pick it up later: claude --resume ${sid}`
const UNATTENDED = (used: number, policy: string): string => `spare10: unattended run inside the reserve (${pf(used, R5)}), policy ${policy}.`

// ---- 2.4 transcript notices, without the prefix that the engine adds ----

const CONT_FIRST5 = `continuing on your 10% reserve until 95% used. ${ASKS5}`
const CONT_SECOND5 = `continuing on your 5% floor. spare10 stays quiet until ${R5}.`
const CONT_PLAIN5 = `continuing on your 10% reserve. spare10 stays quiet until ${R5}.`
const CONT_FIRSTW = `continuing on your 10% weekly reserve until 95% used. ${ASKSW}`
const CONT_SECONDW = `continuing on your 5% weekly floor. spare10 stays quiet until ${RW}.`
const TOLD_RESERVE = 'your 10% reserve is reached. spare10 told the agents to wind down.'
const TOLD_FLOOR = 'your 5% floor is reached. spare10 told the agents to wind down.'
const STOPPED_FLOOR = `stopped at your 5% floor until ${O5}, ${LEAD5}. Then spare10 continues the work, unless a reserve is still reached. Type a prompt to be asked again, or run /spare10 resume.`
// DS: the open texts name the reserve, also past the floor (1.3 item 7).
const OPEN_EVENT = `the 5-hour window resets at ${R5}. Your 10% reserve is open until then`
const HELD_CONTINUES = `${OPEN_EVENT}. Held work continues.`
const STOP_CONTINUES = `${OPEN_EVENT}. spare10 continues the stopped work.`
const RESUME_PROMPT_OPEN =
  `The 5-hour window resets at ${R5}. Your 10% reserve is open until then, so the stop at the quota reserve is over. ` +
  'spare10 is set to continue the work when the reserve opens, so do not wait for the user. Continue the task from the point where it stopped. ' +
  'A subagent whose result says "spare10: work stopped" or "spare10: the user stopped work" did not finish. Run it again if you still need its result.'

// ---- 2.10 warnings ----

const floorWarning = (floor: string, reserve: string): string =>
  `the resume floor (${floor}%) is not below the reserve (${reserve}%), so it does nothing. Set it below the reserve, or to 0.`
const weeklyFloorWarning = (floor: string, reserve: string): string =>
  `the weekly resume floor (${floor}%) is not below the weekly reserve (${reserve}%), so it does nothing. Set it below the weekly reserve, or to 0.`

// ---- helpers ----

type Logs = Pick<World, 'logs'>
const transcript = (w: Logs): string[] => w.logs.filter((l) => l.to !== 'debug').map((l) => l.text)
const debug = (w: Logs): string[] => w.logs.filter((l) => l.to === 'debug').map((l) => l.text)
const count = (list: string[], text: string): number => list.filter((t) => t === text).length
const questions = (w: Pick<World, 'asked'>): string[] => w.asked.map((a) => a.question)
const ctx = (r: ToolCallResult): readonly string[] => r.context ?? []
const DIALOG = { header: 'spare10', labels: ['Stop here', 'Resume'] }

/** /spare10 as the person types it, one entry per line. */
const report = async ($: Engine): Promise<string[]> =>
  ((await $.command.run(cmd(''))).text ?? '').split('\n').map((l) => l.trimEnd())
const run = async ($: Engine, args: string): Promise<string | undefined> => (await $.command.run(cmd(args))).text

/** A Resume at 91% (the first question answered at once), then the answer hangs again. */
async function resumeAtReserve($: Engine, w: World): Promise<void> {
  w.answer = 'Resume'
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95))
  w.answer = 'hang'
}

// ---- both windows: the second question ----

test('5-hour: a Resume at 91% runs every loop to 94.9%, and at 95% one second question holds them all', async ($, on) => {
  const w = world(on, { pct: 91, agents: ['a1'] })
  await begin($, w)
  const held = [bash($), bash($, 'a1')]
  const req = drain($, step('a1', 'A1'))
  await w.clock.settle()
  expect(w.asked).toEqual([{ question: first5(91), ...DIALOG }])
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  w.release('Resume')
  expect((await Promise.all(held)).map((r) => r.result)).toEqual(['ran', 'ran'])
  expect((await req).text).toBe('hi')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95))
  expect(count(transcript(w), CONT_FIRST5)).toBe(1)
  for (const pct of [92, 94.9]) {
    w.pct = pct
    expect((await bash($)).result).toBe('ran')
    expect((await bash($, 'a1')).result).toBe('ran')
    expect((await drain($, step('a1', 'A2'))).text).toBe('hi')
  }
  expect(w.asked).toHaveLength(1)
  expect(w.ran).toHaveLength(6)
  expect(w.requests).toBe(3)

  w.pct = 95 // the floor point: 95.0 is at the floor
  const atFloor = [bash($), bash($, 'a1')]
  const floorReq = drain($, step(undefined, 'T2'))
  await w.clock.settle()
  expect(w.asked).toEqual([
    { question: first5(91), ...DIALOG },
    { question: second5(95), ...DIALOG },
  ])
  expect(w.ran).toHaveLength(6) // nothing ran past the floor
  expect(w.requests).toBe(3)
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // B52: the consent to the floor ended for good
  w.release('Resume')
  expect((await Promise.all(atFloor)).map((r) => r.result)).toEqual(['ran', 'ran'])
  expect((await floorReq).text).toBe('hi')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS)) // full: until the reset
  expect(count(transcript(w), CONT_SECOND5)).toBe(1)
  w.pct = 99.9
  expect((await bash($)).result).toBe('ran')
  expect((await bash($, 'a1')).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(w.asked).toHaveLength(2)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
})

test('weekly: a Resume at 91% runs to 94.9%, and at 95% the weekly second question asks', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 91 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toEqual([{ question: firstW(91), ...DIALOG }])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(consentRec('S1', WEEK_RESETS, 95))
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // the 5-hour window is not in its reserve
  expect(count(transcript(w), CONT_FIRSTW)).toBe(1)
  w.weekPct = 94.9
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(w.asked).toHaveLength(1)

  w.weekPct = 95
  const again = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([firstW(91), secondW(95)])
  expect(w.ran).toEqual(['Bash:main', 'Bash:main'])
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBeUndefined()
  w.release('Resume')
  expect((await again).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(consentRec('S1', WEEK_RESETS))
  expect(count(transcript(w), CONT_SECONDW)).toBe(1)
  w.weekPct = 99
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(2)
})

test('two windows at their floors at once: one second question names both, and one Resume makes both full', async ($, on) => {
  const w = world(on, { pct: 96, weekPct: 97 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([
    `Your 5% floor and your 5% weekly floor are reached: ${both(96, 97)}. All work is on hold. ` +
      `Continue on the last 4% until ${R5} and the last 3% of the weekly window until ${RW}? ${AFTERW}`,
  ])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(consentRec('S1', WEEK_RESETS))
  expect(count(transcript(w), `continuing on your 5% floor and your 5% weekly floor. spare10 stays quiet until they reset (${R5} and ${RW}).`)).toBe(1)
  w.pct = 99
  w.weekPct = 99
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('floors per window: a weekly floor of 3 ends the weekly consent at 97% and leaves the 5-hour consent to 95%', async ($, on) => {
  const w = world(on, { pct: 91, weekPct: 92, env: { SPARE10_WEEKLY_RESUME_FLOOR: '3' } })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([
    `Your 10% reserve and your 10% weekly reserve are reached: ${both(91, 92)}. All work is on hold. ` +
      'Continue on the reserve until 95% used and the weekly reserve until 97% used? ' +
      `Until its reserve opens, spare10 asks you again at 95% used, or at 97% used of the weekly window. ${AFTERW}`,
  ])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95))
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(consentRec('S1', WEEK_RESETS, 97))
  expect(
    count(
      transcript(w),
      'continuing on your 10% reserve until 95% used and your 10% weekly reserve until 97% used. ' +
        'Until its reserve opens, spare10 asks you again at 95% used, or at 97% used of the weekly window.',
    ),
  ).toBe(1)
  // Past the 5-hour point on the weekly reading: the weekly consent still applies.
  w.pct = 94
  w.weekPct = 96
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)

  w.weekPct = 97
  const weekly = bash($)
  await w.clock.settle()
  expect(questions(w)[1]).toBe(secondW(97, 3)) // only the weekly window gates: the 5-hour consent applies at 94
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBeUndefined()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95))
  w.release('Resume')
  expect((await weekly).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(consentRec('S1', WEEK_RESETS))
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95))

  w.pct = 95
  const five = bash($)
  await w.clock.settle()
  expect(questions(w)[2]).toBe(second5(95))
  w.release('Resume')
  expect((await five).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
  expect(w.asked).toHaveLength(3)
})

test('two windows at different stages: the reserve until 95% used and the last 4% of the weekly window', async ($, on) => {
  const w = world(on, { pct: 91, weekPct: 96 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([
    `Your 10% reserve and your 5% weekly floor are reached: ${both(91, 96)}. All work is on hold. ` +
      `Continue on the reserve until 95% used and the last 4% of the weekly window until ${RW}? ${ASKS5} ${AFTERW}`,
  ])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95)) // each kind at its own tier
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(consentRec('S1', WEEK_RESETS))
  expect(count(transcript(w), `continuing on your 10% reserve until 95% used and your 5% weekly floor until ${RW}. ${ASKS5}`)).toBe(1)
  w.pct = 94.9
  w.weekPct = 99
  expect((await bash($)).result).toBe('ran')
  w.pct = 95
  const again = bash($)
  await w.clock.settle()
  expect(questions(w)[1]).toBe(second5(95)) // the weekly window has a full consent: only the 5-hour one asks
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(consentRec('S1', WEEK_RESETS))
  w.release('Stop here')
  expect((await again).deny).toBe(STOP(mfFloor5(95)))
  expect(w.asked).toHaveLength(2)
})

// ---- a reading that jumps past the floor ----

test('a reading that jumps from 89% to 96% asks only the second question, and its Resume lasts until the reset', async ($, on) => {
  const w = world(on, { pct: 89 })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  w.pct = 96
  const held = bash($)
  const req = drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(w.asked).toEqual([{ question: second5(96), ...DIALOG }])
  expect(w.ran).toEqual(['Bash:main'])
  expect(w.requests).toBe(0)
  w.release('Resume')
  expect((await held).result).toBe('ran')
  expect((await req).text).toBe('hi')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS)) // no end point: a second Resume is full
  expect(count(transcript(w), CONT_SECOND5)).toBe(1)
  expect(transcript(w).some((t) => t.includes('until 95% used'))).toBe(false)
  w.pct = 99.9
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('after a Resume at the reserve, a jump past the floor asks the second question with what is left now', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  w.pct = 97.5
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([first5(91), second5(97.5)])
  expect(questions(w)[1]).toContain('Continue on the last 2.5% until')
  expect(w.ran).toEqual(['Bash:main'])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
})

test('a reading that passes the floor while the first question waits: its Resume runs nothing, and the second question follows', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const held = bash($)
  const req = drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(questions(w)).toEqual([first5(91)])
  w.pct = 96
  w.release('Resume') // the text the person read: the reserve until 95% used
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  expect(questions(w)).toEqual([first5(91), second5(96)])
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // written to 95, then ended at 96
  w.release('Resume')
  expect((await held).result).toBe('ran')
  expect((await req).text).toBe('hi')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
  expect(w.asked).toHaveLength(2)
})

test('a typed prompt asks the first and then the second question in the prompt wording', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const one = $.prompt.submit(typed('one'))
  await w.clock.settle()
  expect(w.asked).toEqual([{ question: firstPrompt5(91), ...DIALOG }])
  expect(w.prompts).toEqual([])
  w.release('Resume')
  expect(await one).toMatchObject({ text: 'one' })
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95))
  w.pct = 93
  expect(await $.prompt.submit(typed('mid'))).toMatchObject({ text: 'mid' })
  expect(w.asked).toHaveLength(1)
  w.pct = 96
  const two = $.prompt.submit(typed('two'))
  await w.clock.settle()
  expect(questions(w)).toEqual([firstPrompt5(91), secondPrompt5(96)])
  expect(w.prompts.map((p) => p.text)).toEqual(['one', 'mid'])
  w.release('Resume')
  expect(await two).toMatchObject({ text: 'two' })
  expect(w.prompts.map((p) => p.context)).toEqual([undefined, undefined, undefined]) // nothing was stopped: no note
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
})

test('a held prompt whose reading passes the floor while the first question waits never enters on that Resume', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(questions(w)).toEqual([firstPrompt5(91)])
  w.pct = 96
  w.release('Resume')
  await w.clock.settle()
  expect(w.prompts).toEqual([])
  expect(questions(w)).toEqual([firstPrompt5(91), secondPrompt5(96)])
  w.release('Resume')
  expect(await p).toMatchObject({ text: 'hello' })
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
})

test('another copy answers an open first question only with an end point at least as high as the question asks', async ($, on) => {
  const w = world(on, { pct: 92 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([first5(92)])
  w.env.set('SPARE10_CONSENT', consentRec('S1', RESETS, 93)) // a stale consent to a lower point
  w.cap() // the next carrier cycle reads the env
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.asked).toHaveLength(1)
  w.env.set('SPARE10_CONSENT', consentRec('S1', RESETS, 95)) // another copy's Resume at the reserve
  w.cap()
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  w.pct = 95 // and it ends at its point as this copy's own would
  const again = bash($)
  await w.clock.settle()
  expect(questions(w)[1]).toBe(second5(95))
  w.release('Stop here')
  expect((await again).deny).toBe(STOP(mfFloor5(95)))
})

// ---- a test reading ----

test('the test seam: simulate 91, Resume, simulate 96 raises in place, and the next call asks the second question', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  expect(await run($, 'simulate 91')).toBe(
    `test reading set to 91% used, resets ${R5}. It can only raise the real reading. The reserve opens at ${O5}, ${LEAD_TEST}. Run /spare10 simulate off to clear it.`,
  )
  const held = bash($)
  await w.clock.settle()
  const testAfter = loopAfter(`${O5}, ${LEAD_TEST}`)
  expect(questions(w)).toEqual([`Your 10% reserve is reached: ${pf(91, R5)}. All work is on hold. Continue on the reserve until 95% used? ${ASKS5} ${testAfter}`])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // a Resume on a test reading never goes into the env
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)

  expect(await run($, 'simulate 96')).toBe(
    `test reading raised to 96% used, resets ${R5}. Your earlier answers stay. It can only raise the real reading. This is past your 5% floor. The reserve opens at ${O5}, ${LEAD_TEST}. Run /spare10 simulate off to clear it.`,
  )
  const again = bash($)
  await w.clock.settle()
  expect(questions(w)[1]).toBe(`Your 5% floor is reached: ${pf(96, R5)}. All work is on hold. Continue on the last 4% until ${R5}? ${testAfter}`)
  expect(w.ran).toEqual(['Bash:main', 'Bash:main'])
  w.release('Resume')
  expect((await again).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(2)
})

test('a higher test reading past the point keeps a real consent to the floor from applying, and never ends it', SLOW, async ($, on) => {
  const w = world(on, { pct: 91, env: { SPARE10_CONSENT: consentRec('S1', RESETS, 95) } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran') // the real consent applies at 91
  const testEnd = T0 + 30 * MIN
  expect(await run($, 'simulate 96 in 30m')).toBe(
    `test reading set to 96% used, resets ${hhmm(testEnd)}. It can only raise the real reading. This is past your 5% floor. ` +
      'The real reading is also in the reserve, so the test window does not open it. A Resume on the test reading also lets real work use the reserve. ' +
      'Run /spare10 simulate off to clear it.',
  )
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(questions(w)[0]?.startsWith(`Your 5% floor is reached: ${pf(96, hhmm(testEnd))}. All work is on hold. Continue on the last 4% until ${hhmm(testEnd)}?`)).toBe(true)
  expect(w.ran).toEqual(['Bash:main'])
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95)) // a test reading never ends a real consent
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95))
  // The test window ends: the real reading (91) is below the point, so the real consent applies again.
  await w.clock.set(testEnd + TICK)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
  // The real reading reaches the point: the real consent ends, and spare10 asks the second question.
  w.pct = 95
  const real = bash($)
  await w.clock.settle()
  expect(questions(w)[1]).toBe(second5(95))
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  w.release('Resume')
  expect((await real).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
})

test('a Resume on a test question never passes a real reading at the floor (B50 item 1)', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  await run($, 'simulate 91')
  const held = bash($)
  const req = drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(await run($, 'simulate off')).toBe('test reading cleared. Consent and stop for this window are cleared too.')
  w.pct = 96 // the real reading, now past the floor
  w.release('Resume') // answers the test reading at the reserve
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  expect(questions(w)[1]).toBe(second5(96))
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  w.release('Resume')
  expect((await held).result).toBe('ran')
  expect((await req).text).toBe('hi')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
})

test('a full Resume on a test reading at the floor never passes the real reading beneath it (B50 item 1)', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  await run($, 'simulate 96')
  const held = bash($)
  const req = drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(questions(w)[0]?.startsWith(`Your 5% floor is reached: ${pf(96, R5)}.`)).toBe(true)
  await run($, 'simulate off') // the question stays open
  w.pct = 96 // the real reading is at the floor too, and nobody answered it
  w.release('Resume') // a full Resume, on the test basis
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  expect(questions(w)[1]).toBe(second5(96))
  w.release('Resume')
  expect((await held).result).toBe('ran')
  expect((await req).text).toBe('hi')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
})

test('a Resume on a test reading at the reserve never passes a real reading below its end point on another basis', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  await run($, 'simulate 91')
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await run($, 'simulate off')
  w.pct = 93 // real, at the reserve, below 95: only the basis tells it apart
  w.release('Resume')
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(questions(w)[1]).toBe(first5(93))
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95))
})

// ---- 0 = off, and a floor at or above the reserve ----

test('SPARE10_RESUME_FLOOR=0 gives the 0.2 question, a Resume until the reset, and no second question', async ($, on) => {
  const w = world(on, { pct: 91, env: { SPARE10_RESUME_FLOOR: '0' } })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toEqual([{ question: plain5(91), ...DIALOG }])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
  expect(count(transcript(w), CONT_PLAIN5)).toBe(1)
  for (const pct of [95, 96, 99.9]) {
    w.pct = pct
    expect((await bash($)).result).toBe('ran')
    expect((await drain($, step())).text).toBe('hi')
  }
  expect(w.asked).toHaveLength(1)
  expect(await report($)).toContain('  · resume floor   off. A Resume lasts until the reset (from SPARE10_RESUME_FLOOR)')
  expect(transcript(w).some((t) => t.includes('resume floor'))).toBe(false) // 0 is off, not a floor that does nothing
})

test('the weekly floor off keeps the 5-hour floor: one question, a consent to 95% and a full weekly consent', async ($, on) => {
  const w = world(on, { pct: 91, weekPct: 92, env: { SPARE10_WEEKLY_RESUME_FLOOR: '0' } })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([
    `Your 10% reserve and your 10% weekly reserve are reached: ${both(91, 92)}. All work is on hold. ` +
      `Continue on the reserve until 95% used and the weekly reserve until ${RW}? ${ASKS5} ${AFTERW}`,
  ])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95))
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(consentRec('S1', WEEK_RESETS))
  w.weekPct = 99
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
  w.pct = 95
  const five = bash($)
  await w.clock.settle()
  expect(questions(w)[1]).toBe(second5(95))
  w.release('Resume')
  expect((await five).result).toBe('ran')
  const lines = await report($)
  expect(lines).toContain('  · resume floor   5%: after a Resume, spare10 asks again at 95% used (from /config)')
  expect(lines).toContain('  · weekly floor   off. A Resume lasts until the weekly reset (from SPARE10_WEEKLY_RESUME_FLOOR)')
})

test('a floor equal to the reserve does nothing: one warning at the start, the 0.2 question and a Resume until the reset', async ($, on) => {
  const warning = floorWarning('10', '10')
  const w = world(on, { pct: 50, env: { SPARE10_RESUME_FLOOR: '10' } })
  await begin($, w)
  expect(count(transcript(w), warning)).toBe(1)
  const lines = await report($)
  expect(lines).toContain(`  ⚠ ${warning}`)
  expect(lines).toContain('  · resume floor   10% does nothing, because it is not below the reserve (from SPARE10_RESUME_FLOOR)')
  w.pct = 91
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([plain5(91)])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
  w.pct = 97
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
  expect(count(transcript(w), warning)).toBe(1) // at the start only
})

test('a floor above the reserve does nothing either', async ($, on) => {
  const w = world(on, { pct: 96, env: { SPARE10_RESUME_FLOOR: '12' } })
  await begin($, w)
  expect(count(transcript(w), floorWarning('12', '10'))).toBe(1)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([plain5(96)]) // no floor in force: the 0.2 question at 96
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
})

test('with a reserve of 5 the default floor of 5 does nothing and warns', async ($, on) => {
  const w = world(on, { pct: 95, env: { SPARE10_RESERVE: '5' } })
  await begin($, w)
  const warning = floorWarning('5', '5')
  expect(count(transcript(w), warning)).toBe(1)
  expect(await report($)).toContain('  · resume floor   5% does nothing, because it is not below the reserve (from /config)')
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([plain5(95, 5)])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
  w.pct = 99
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('a floor just below the reserve is in force: 9.9% puts the floor point at 90.1% used', async ($, on) => {
  const w = world(on, { pct: 90, env: { SPARE10_RESUME_FLOOR: '9.9' } })
  await begin($, w)
  expect(transcript(w).some((t) => t.includes('resume floor'))).toBe(false)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([
    `Your 10% reserve is reached: ${pf(90, R5)}. All work is on hold. Continue on the reserve until 90.1% used? ` +
      `Until ${O5}, spare10 asks you again at 90.1% used. ${AFTER5}`,
  ])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 90.1))
  w.pct = 90.1
  const again = bash($)
  await w.clock.settle()
  expect(questions(w)[1]).toBe(`Your 9.9% floor is reached: ${pf(90.1, R5)}. All work is on hold. Continue on the last 9.9% until ${R5}? ${AFTER5}`)
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  w.release('Resume')
  expect((await again).result).toBe('ran')
})

test('a weekly floor at or above the weekly reserve does nothing and warns, and the 5-hour floor still applies', async ($, on) => {
  const w = world(on, { pct: 91, weekPct: 92, env: { SPARE10_WEEKLY_RESUME_FLOOR: '15' } })
  await begin($, w)
  expect(count(transcript(w), weeklyFloorWarning('15', '10'))).toBe(1)
  expect(transcript(w).some((t) => t.startsWith('the resume floor'))).toBe(false)
  expect(await report($)).toContain('  · weekly floor   15% does nothing, because it is not below the weekly reserve (from SPARE10_WEEKLY_RESUME_FLOOR)')
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([
    `Your 10% reserve and your 10% weekly reserve are reached: ${both(91, 92)}. All work is on hold. ` +
      `Continue on the reserve until 95% used and the weekly reserve until ${RW}? ${ASKS5} ${AFTERW}`,
  ])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95))
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(consentRec('S1', WEEK_RESETS))
  w.weekPct = 99
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('a weekly floor above the weekly reserve says nothing while the weekly window is not watched', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 97, env: { SPARE10_WEEKLY_RESERVE: '0', SPARE10_WEEKLY_RESUME_FLOOR: '15' } })
  await begin($, w)
  expect(transcript(w).some((t) => t.includes('weekly resume floor'))).toBe(false)
  const lines = await report($)
  expect(lines.some((l) => l.includes('weekly floor'))).toBe(false)
  expect(lines).toContain('  · resume floor   5%: after a Resume, spare10 asks again at 95% used (from /config)')
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
})

// ---- the skip window wins ----

test('inside the skip window nothing gates past the floor', SLOW, async ($, on) => {
  const w = world(on, { pct: 96 })
  await begin($, w)
  await w.clock.set(O_MS + 5 * MIN)
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(await $.prompt.submit(typed('hello'))).toMatchObject({ text: 'hello' })
  expect(w.asked).toEqual([])
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
})

test('inside the skip window a consent to the floor past its point holds nothing, and no gate ends it', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_CONSENT: consentRec('S1', RESETS, 95) } })
  await begin($, w)
  await w.clock.set(O_MS + 5 * MIN)
  w.pct = 97 // past the point only inside the skip window
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  await w.clock.settle()
  expect(w.asked).toEqual([])
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95)) // splitOf ends no consent of an open kind
})

test('a Resume at the reserve, then the skip start: the reading passes the floor with no second question', SLOW, async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  await pastOpen(w)
  w.pct = 97
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(await $.prompt.submit(typed('hello'))).toMatchObject({ text: 'hello' })
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95)) // an open kind ends no consent
})

test('a second question that nobody answers continues at the skip start, and no consent is written', SLOW, async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  w.pct = 96
  const held = bash($)
  const req = drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(questions(w)).toEqual([first5(91), second5(96)])
  await w.clock.set(O_MS - TICK)
  expect(w.ran).toEqual(['Bash:main'])
  expect(w.requests).toBe(0)
  await pastOpen(w)
  expect((await held).result).toBe('ran')
  expect((await req).text).toBe('hi')
  await w.clock.settle()
  expect(count(transcript(w), HELD_CONTINUES)).toBe(1)
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect(w.asked).toHaveLength(2)
})

test('the weekly skip start wins over the weekly floor', SLOW, async ($, on) => {
  const WN_MS = Date.parse(WEEK_NEAR)
  const WNO_MS = Date.parse(WEEK_NEAR_OPENS)
  const w = world(on, { pct: 50, weekPct: 91, weekResetsAt: WEEK_NEAR })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([
    `Your 10% weekly reserve is reached: ${pf(91, wk(WN_MS))}. All work is on hold. Continue on the weekly reserve until 95% used? ` +
      `Until ${wk(WNO_MS)}, spare10 asks you again at 95% used of the weekly window. ${loopAfter(`${wk(WNO_MS)}, ${LEADW}`)}`,
  ])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(consentRec('S1', WEEK_NEAR, 95))
  await pastOpen(w, WEEK_NEAR_OPENS)
  w.weekPct = 97
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(consentRec('S1', WEEK_NEAR, 95))
})

// ---- Stop here at the second question, and autoResume ----

/** A Resume at 91%, then at 96% a held main call and main step: the second question is open. */
async function atSecondQuestion($: Engine, w: World): Promise<{ held: Promise<ToolCallResult>; req: Promise<{ text: string }> }> {
  await resumeAtReserve($, w)
  w.pct = 96
  const held = bash($)
  const req = drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(questions(w)).toEqual([first5(91), second5(96)])
  return { held, req }
}

test('Stop here at the second question stops as today and names the floor, and a fall below the point still refuses', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const { held, req } = await atSecondQuestion($, w)
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(mfFloor5(96)))
  expect((await req).text).toBe(PAUSED(mfFloor5(96)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OPENS, T0, `five_hour,work,auto,skip,${real5(RESETS)}`))
  expect(count(transcript(w), STOPPED_FLOOR)).toBe(1)
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(w.ran).toEqual(['Bash:main'])
  expect(w.requests).toBe(0)
  // The reading falls below the point: the stop still refuses, and the consent to the floor stays ended.
  w.pct = 92
  expect((await bash($)).deny).toBe(STOP(mf5(92)))
  expect(w.asked).toHaveLength(2)
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(questions(w)[2]).toBe(firstPrompt5(92)) // the first question again, not a pass
  w.release('Stop here')
  expect(await p).toEqual({ drop: NOT_STARTED_RESERVE })
  expect(w.prompts).toEqual([])
})

test('with autoResume on a stop at the second question continues at the skip start', SLOW, async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const { held } = await atSecondQuestion($, w)
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(mfFloor5(96)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OPENS, T0, `five_hour,work,auto,skip,${real5(RESETS)}`))
  await w.clock.set(O_MS - TICK)
  expect(w.submitted).toEqual([])
  await pastOpen(w)
  await w.clock.settle()
  expect(count(transcript(w), STOP_CONTINUES)).toBe(1)
  expect(w.submitted).toEqual([RESUME_PROMPT_OPEN])
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  w.pct = 97
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(2)
})

test('with the spans off a stop at the second question continues at the reset', SLOW, async ($, on) => {
  const w = world(on, { pct: 91, spans: 'off' })
  await begin($, w)
  const held91 = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([
    `Your 10% reserve is reached: ${pf(91, R5)}. All work is on hold. Continue on the reserve until 95% used? At 95% used, spare10 asks you again. ${loopAfter(R5)}`,
  ])
  w.release('Resume')
  expect((await held91).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95))
  expect(count(transcript(w), 'continuing on your 10% reserve until 95% used. At 95% used, spare10 asks you again.')).toBe(1)
  w.pct = 96
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)[1]).toBe(`Your 5% floor is reached: ${pf(96, R5)}. All work is on hold. Continue on the last 4% until ${R5}? ${loopAfter(R5)}`)
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(mfFloor5(96)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', RESETS, T0, 'five_hour,work,auto'))
  expect(
    count(transcript(w), `stopped at your 5% floor until ${R5}. Then spare10 continues the work, unless a reserve is still reached. Type a prompt to be asked again, or run /spare10 resume.`),
  ).toBe(1)
  // The window resets: the new window is below the reserve, and the stopped work continues.
  w.pct = 3
  w.resetsAt = LATER
  await pastDue(w, RESETS)
  await w.clock.settle()
  expect(w.submitted).toHaveLength(1)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(2)
})

test('autoResume off: both questions have no after part, and Stop here at the second stops until the skip start', async ($, on) => {
  const w = world(on, { pct: 91, env: { SPARE10_AUTO_RESUME: 'off' } })
  await begin($, w)
  const held91 = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([`Your 10% reserve is reached: ${pf(91, R5)}. All work is on hold. Continue on the reserve until 95% used? ${ASKS5}`])
  w.release('Resume')
  expect((await held91).result).toBe('ran')
  await w.clock.settle()
  w.pct = 96
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)[1]).toBe(`Your 5% floor is reached: ${pf(96, R5)}. All work is on hold. Continue on the last 4% until ${R5}?`)
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(mfFloor5(96)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stopRe('S1'))
  // DS 2.4: with autoResume off a stop lasts until the skip start, and nothing continues by itself.
  expect(count(transcript(w), `stopped at your 5% floor until ${O5}, ${LEAD5}. Type a prompt to be asked again, or run /spare10 resume.`)).toBe(1)
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
})

test('Stop here at the first question, then the floor while stopped: a prompt asks the second question, and its Resume carries the floor note', async ($, on) => {
  const w = world(on, { pct: 91, answer: 'Stop here' })
  await begin($, w)
  expect((await bash($)).deny).toBe(STOP(mf5(91)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stopRe('S1'))
  w.pct = 96
  expect((await bash($)).deny).toBe(STOP(mfFloor5(96)))
  expect(w.asked).toHaveLength(1)
  w.answer = 'hang'
  const p = $.prompt.submit(typed('go on'))
  await w.clock.settle()
  expect(questions(w)).toEqual([first5(91), secondPrompt5(96)])
  w.release('Resume')
  expect(await p).toMatchObject({ text: 'go on' })
  expect(w.prompts.map((e) => e.context)).toEqual([[floorNote(96)]])
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  w.pct = 98
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(2)
})

// ---- tell mode (B51) ----

test('tell mode: main and a subagent are told at the reserve and again at the floor, once each', async ($, on) => {
  const w = world(on, { pct: 91, env: TELL, agents: ['a1'] })
  await begin($, w)
  expect(ctx(await bash($))).toEqual([reserveTell(91)])
  expect(ctx(await bash($, 'a1'))).toEqual([reserveTell(91)])
  expect(ctx(await bash($))).toEqual([])
  expect(ctx(await bash($, 'a1'))).toEqual([])
  expect(count(transcript(w), TOLD_RESERVE)).toBe(1)
  w.pct = 93
  expect(ctx(await bash($))).toEqual([])
  w.pct = 95
  expect(ctx(await bash($, 'a1'))).toEqual([floorTell(95)])
  expect(ctx(await bash($))).toEqual([floorTell(95)])
  expect(ctx(await bash($))).toEqual([])
  expect(ctx(await bash($, 'a1'))).toEqual([])
  w.pct = 98
  expect(ctx(await bash($))).toEqual([])
  expect(ctx(await bash($, 'a1'))).toEqual([])
  expect(count(transcript(w), TOLD_RESERVE)).toBe(1)
  expect(count(transcript(w), TOLD_FLOOR)).toBe(1)
  expect(w.ran).toHaveLength(11) // tell mode never holds a loop
  expect(w.asked).toEqual([])
  expect(w.parkCalls).toBe(0)
})

test('tell mode: a Resume on the first prompt question holds the tells back until the floor', async ($, on) => {
  const w = world(on, { pct: 91, env: TELL, agents: ['a1'] })
  await begin($, w)
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(w.asked).toEqual([{ question: firstTell5(91), ...DIALOG }])
  w.release('Resume')
  expect(await p).toMatchObject({ text: 'hello' })
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95))
  expect(count(transcript(w), `continuing on your 10% reserve until 95% used. ${TELLS5}`)).toBe(1)
  w.pct = 93
  expect(ctx(await bash($))).toEqual([])
  expect(ctx(await bash($, 'a1'))).toEqual([])
  w.pct = 95
  expect(ctx(await bash($))).toEqual([floorTell(95)])
  expect(ctx(await bash($, 'a1'))).toEqual([floorTell(95)])
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(count(transcript(w), TOLD_FLOOR)).toBe(1)
  expect(count(transcript(w), TOLD_RESERVE)).toBe(0)
  expect(w.asked).toHaveLength(1)
})

test('tell mode: a prompt at the floor before main is told there asks the second question, and Stop here gives it back', async ($, on) => {
  const w = world(on, { pct: 91, env: TELL })
  await begin($, w)
  expect(ctx(await bash($))).toEqual([reserveTell(91)])
  expect(await $.prompt.submit(typed('first'))).toMatchObject({ text: 'first' }) // main is told at the reserve
  w.pct = 96
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(w.asked).toEqual([{ question: secondTell5(96), ...DIALOG }])
  w.release('Stop here')
  expect(await p).toEqual({ drop: NOT_STARTED_FLOOR })
  await w.clock.settle()
  expect(w.fills).toEqual(['hello'])
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined() // tell mode writes no stop
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  // Main is told at the floor on its next tool result, and then a prompt enters.
  expect(ctx(await bash($))).toEqual([floorTell(96)])
  expect(await $.prompt.submit(typed('next'))).toMatchObject({ text: 'next' })
  expect(w.prompts.map((e) => e.text)).toEqual(['first', 'next'])
  expect(w.asked).toHaveLength(1)
})

test('tell mode: a Resume on the second prompt question consents until the reset, and no loop is told', async ($, on) => {
  const w = world(on, { pct: 96, env: TELL, agents: ['a1'] })
  await begin($, w)
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(questions(w)).toEqual([secondTell5(96)])
  w.release('Resume')
  expect(await p).toMatchObject({ text: 'hello' })
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS))
  expect(count(transcript(w), CONT_SECOND5)).toBe(1)
  w.pct = 99
  for (const id of [undefined, 'a1', undefined]) expect(ctx(await bash($, id))).toEqual([])
  expect(count(transcript(w), TOLD_FLOOR)).toBe(0)
  expect(count(transcript(w), TOLD_RESERVE)).toBe(0)
})

test('tell mode: after a Stop here at the floor question the ended consent stays ended, and a fall asks the first question', async ($, on) => {
  const w = world(on, { pct: 91, env: TELL })
  await begin($, w)
  const first = $.prompt.submit(typed('one'))
  await w.clock.settle()
  w.release('Resume')
  expect(await first).toMatchObject({ text: 'one' })
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95))
  w.pct = 96
  const second = $.prompt.submit(typed('two'))
  await w.clock.settle()
  expect(questions(w)).toEqual([firstTell5(91), secondTell5(96)])
  w.release('Stop here')
  expect(await second).toEqual({ drop: NOT_STARTED_FLOOR })
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  w.pct = 92
  const third = $.prompt.submit(typed('three'))
  await w.clock.settle()
  expect(questions(w)[2]).toBe(firstTell5(92))
  w.release('Stop here')
  expect(await third).toEqual({ drop: NOT_STARTED_RESERVE })
  expect(w.prompts.map((e) => e.text)).toEqual(['one'])
})

// ---- unattended runs (B55) ----

test('-p stop at the floor: HEADLESS names the reserve, never the floor', async ($, on) => {
  const w = world(on, { pct: 96, surfaces: [], env: { SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  expect((await bash($)).deny).toBe(HEADLESS(96))
  expect((await drain($, step(undefined, 'T1'))).text).toBe(HEADLESS(96))
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  expect(w.asked).toEqual([])
  expect(debug(w)).toContain(UNATTENDED(96, 'stop'))
  expect(transcript(w).some((t) => t.includes('floor'))).toBe(false)
})

test('-p off lets every loop pass the floor', async ($, on) => {
  const w = world(on, { pct: 96, surfaces: [], agents: ['a1'] })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect((await bash($, 'a1')).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  w.pct = 99
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
})

test('-p prompt tells each loop once per window, also past the floor', async ($, on) => {
  const w = world(on, { pct: 91, surfaces: [], agents: ['a1'], env: { SPARE10_HEADLESS: 'prompt' } })
  await begin($, w)
  expect(ctx(await bash($))).toEqual([plainTell(91)])
  expect(ctx(await bash($, 'a1'))).toEqual([plainTell(91)])
  w.pct = 96
  expect(ctx(await bash($))).toEqual([])
  expect(ctx(await bash($, 'a1'))).toEqual([])
  w.pct = 99
  expect(ctx(await bash($))).toEqual([])
  expect(w.ran).toHaveLength(5)
  expect(w.asked).toEqual([])
  expect(transcript(w).some((t) => t.includes('floor'))).toBe(false)
})

test('-p stop with an inherited consent to the floor runs to its point, then refuses and unsets the value', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop', SPARE10_CONSENT: consentRec('S0', RESETS, 95) } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  w.pct = 94.9
  expect((await drain($, step())).text).toBe('hi')
  w.pct = 95
  expect((await bash($)).deny).toBe(HEADLESS(95))
  expect((await drain($, step(undefined, 'T2'))).text).toBe(HEADLESS(95))
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // B52 in the child's own env
  w.pct = 93 // a fall does not bring it back
  expect((await bash($)).deny).toBe(HEADLESS(93))
  expect(w.asked).toEqual([])
})

test('-p stop with an inherited full consent runs past the floor', async ($, on) => {
  const w = world(on, { pct: 97, surfaces: [], env: { SPARE10_HEADLESS: 'stop', SPARE10_CONSENT: consentRec('S0', RESETS) } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S0', RESETS))
  expect(w.asked).toEqual([])
})

test('-p wait with an inherited consent to the floor holds from its point and continues at the skip start', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'wait', SPARE10_CONSENT: consentRec('S0', RESETS, 95) } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  w.pct = 95
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toEqual([]) // no dialog: nobody can answer
  expect(w.ran).toEqual(['Bash:main'])
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  await w.clock.set(O_MS - TICK)
  expect(w.ran).toEqual(['Bash:main'])
  await pastOpen(w)
  expect((await held).result).toBe('ran')
  expect(w.asked).toEqual([])
})

test('/spare10 in an unattended run says the floors do nothing there', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 50, surfaces: [] })
  await begin($, w)
  const lines = await report($)
  expect(lines).toContain('  · resume floor   5%: this run is unattended and never asks, so the floor does nothing (from /config)')
  expect(lines).toContain('  · weekly floor   5%: this run is unattended and never asks, so the floor does nothing (from /config)')
})

// ---- the consent value at the gate (3.3) ----

for (const tail of ['to:abc', 'to:0', 'to:100', 'to:95.55', 'to:95 x']) {
  test(`a consent value with a junk end point (${tail}) is no consent, so spare10 asks`, async ($, on) => {
    const w = world(on, { pct: 93, env: { SPARE10_CONSENT: `${consentRec('S1', RESETS)} ${tail}` } })
    await begin($, w)
    const held = bash($)
    await w.clock.settle()
    expect(questions(w)).toEqual([first5(93)])
    expect(w.ran).toEqual([])
    w.release('Stop here')
    expect((await held).deny).toBe(STOP(mf5(93)))
  })
}

test('an end point after a bare time is no consent, so spare10 asks', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_CONSENT: `${RESETS} to:95` } })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([first5(93)])
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(mf5(93)))
})

test('a bare time from 0.2 is a full consent: work runs past the floor', async ($, on) => {
  const w = world(on, { pct: 97, env: { SPARE10_CONSENT: RESETS } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(w.asked).toEqual([])
})

test('a consent to 97.5 lets work run at 97.4% and asks the second question at 97.5%', async ($, on) => {
  const w = world(on, { pct: 96, env: { SPARE10_RESUME_FLOOR: '2.5', SPARE10_CONSENT: consentRec('S1', RESETS, 97.5) } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  w.pct = 97.4
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  w.pct = 97.5
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([
    `Your 2.5% floor is reached: ${pf(97.5, R5)}. All work is on hold. Continue on the last 2.5% until ${R5}? ${AFTER5}`,
  ])
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  w.release('Resume')
  expect((await held).result).toBe('ran')
})
