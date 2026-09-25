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
  clear,
  cmd,
  drain,
  measure,
  pastDue,
  real5,
  step,
  stopRec,
  typed,
  world,
} from '../helpers/world.ts'
import type { World } from '../helpers/world.ts'

// The stop at the due time and what else ends it (design 0.2 B34, B35, B39, 4.2 to 4.8, 5.6, 5.7, and
// the second half of the 8.3 reset.test.ts table). Written from the spec: every expected text is built
// here from section 2, not from hooks/core/text.ts. autoResume is on unless a test says otherwise.
// The D0.2 reset path: spans off. Every world has spans: 'off' (skip design 7.4), so a question
// and a stop continue at the reset plus the margin. tests/kit/skip.test.ts runs the shipped spans.

const RESETS_MS = Date.parse(RESETS)
const SOON_MS = Date.parse(SOON)
const WEEK_MS = Date.parse(WEEK_RESETS)
const LATER_MS = Date.parse(LATER)
const DUE = RESETS_MS + MARGIN // the due time of a stop or question on the 5-hour window at RESETS

// {clock}: HH:MM in the machine's zone, and for the weekly window the en-GB short weekday first (2.1).
const clock = (ms: number): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
const weekday = (ms: number): string => `${new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(ms)} ${clock(ms)}`

const pf = (used: number, ms = RESETS_MS): string => `${used}% used · ${100 - used}% left · resets ${clock(ms)}`
const mf = (used: number, ms = RESETS_MS): string => `into your 10% reserve · ${100 - used}% of quota left · resets ${clock(ms)}`
const loopAfter = (at: string): string =>
  ` If you choose Stop here or do not answer, the work waits until ${at}. Then spare10 continues it, unless a reserve is still reached.`
const loopQuestion = (used = 93, ms = RESETS_MS, auto = true): string =>
  `Your 10% reserve is reached: ${pf(used, ms)}. All work is on hold. Continue on the reserve until ${clock(ms)}?` +
  (auto ? loopAfter(clock(ms)) : '')
const promptQuestion = (used = 93, ms = RESETS_MS): string =>
  `Your 10% reserve is reached: ${pf(used, ms)}. spare10 holds your prompt and any other work. Continue on the reserve until ${clock(ms)}? ` +
  `If you do not answer, all of it continues after ${clock(ms)}, unless a reserve is still reached. Stop here gives your prompt back and pauses other work until ${clock(ms)}.`
const weeklyQuestion = (used: number, ms: number): string =>
  `Your 10% weekly reserve is reached: ${used}% used · ${100 - used}% left · resets ${weekday(ms)}. All work is on hold. ` +
  `Continue on the weekly reserve until ${weekday(ms)}?` + loopAfter(weekday(ms))

// Text the model reads (2.3).
const STOP = (used = 93, ms = RESETS_MS): string =>
  `spare10: the user stopped work at the quota reserve (${mf(used, ms)}). Stop now and wait for the user. Do not call any further tools.`
const PAUSED = (used = 93, ms = RESETS_MS): string =>
  `spare10: work stopped at the quota reserve (${mf(used, ms)}). No model request was sent, so this task is not finished. Wait for the user.`
const notStarted = (ms = RESETS_MS): string =>
  `spare10: not started. This session is inside your 10% reserve until ${clock(ms)}. Send the prompt again to be asked again, or run /spare10 resume.`
const FIVE = 'the 5-hour window reset'
const WEEK = 'the weekly window reset'
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const resumePrompt = (reset = FIVE): string =>
  `${capital(reset)}, so the stop at the quota reserve is over. spare10 is set to continue the work at the reset, so do not wait for the user. ` +
  'Continue the task from the point where it stopped. A subagent whose result says "spare10: work stopped" or "spare10: the user stopped work" did not finish. ' +
  'Run it again if you still need its result.'
const resetNote = (reset = FIVE): string =>
  `spare10: earlier work stopped at the quota reserve. ${capital(reset)} since then, so the stop is over. The stopped task is not finished. ` +
  "After the user's message, continue it unless the user says otherwise."

// Transcript notices (2.4), without the engine's prefix.
const stoppedWork = (at: string): string =>
  `stopped at your 10% reserve until ${at}. Then spare10 continues the work, unless a reserve is still reached. Type a prompt to be asked again, or run /spare10 resume.`
const stoppedNoWork = (at: string): string =>
  `stopped at your 10% reserve until ${at}. Type a prompt to be asked again, or run /spare10 resume.`
const STOPPED_AUTO_OFF = 'stopped at your 10% reserve. Type a prompt to be asked again, or run /spare10 resume.'
const resetResumes = (reset = FIVE): string => `${reset}. spare10 continues the stopped work.`
const resetStopOver = (reset = FIVE): string => `${reset}, and the stop is over. Type a prompt to continue.`
const stopTakenOver = (reset = FIVE): string => `${reset}, and the stop is over.`
const resetContinues = (reset = FIVE): string => `${reset}. Held work continues.`
const RESET_WAITING = `${FIVE}. Held work still waits for your answer.`
const NEW_WINDOW = 'held work continues on the new 5-hour window.'
const resumeFailed = (reason: string): string => `could not continue the stopped work: ${reason}. Type a prompt to continue.`

// Debug lines (2.5), with their own prefix.
const DROPPED = 'spare10: a stop of another conversation ended at its reset. spare10 dropped it.'
const SKIPPED = 'spare10: the conversation changed before the resume prompt. spare10 sent nothing.'
const boxDefer = (n: number): string => `spare10: the prompt box has text. The resume prompt waits (${n} of 10).`

// Command replies (2.8) and report lines (2.7), white space folded.
const STOP_OVERDUE = 'the stop ended at the reset. spare10 will not continue the stopped work.'
const RESUME_OVERDUE = `${FIVE}, and the stop is over. Type a prompt to continue.`
const stopTripped = (at: string): string =>
  `stopped at the reserve until ${at}. Then spare10 continues any stopped work. Type a prompt to be asked again, or run /spare10 resume.`
const RESUMED_STOPPED = `resumed. You can use the reserve until ${clock(RESETS_MS)}. Type a prompt to continue.`
const NOTHING_TO_STOP = 'nothing to stop. spare10 steps in at 90% used, or at 90% used of the weekly window.'
const TICKER_WARNING = '⚠ spare10 cannot check the reset in this session. Type a prompt to continue after the reset.'
const askingLine = (at: string): string =>
  `? asking a question is open. Held work waits until you answer, or until ${at}. If no dialog shows, run /spare10 resume or /spare10 stop.`
// autoResume off keeps the 0.1 asking line, as the 0.1 code words it (the code is the baseline).
const ASKING_LINE_OFF = '? asking a question is open. Held work waits until you answer. If no dialog shows, run /spare10 resume or /spare10 stop.'
const stoppedLineWork = (at: string): string =>
  `■ stopped you chose Stop here. spare10 continues the work after ${at}. Type a prompt to be asked again, or run /spare10 resume.`
const stoppedLineNoWork = (at: string): string =>
  `■ stopped you chose Stop here, until ${at}. Type a prompt to be asked again, or run /spare10 resume.`
const AUTO_OFF = { SPARE10_AUTO_RESUME: 'off' }

type Logs = Pick<World, 'logs'>
const transcript = (w: Logs): string[] => w.logs.filter((l) => l.to !== 'debug').map((l) => l.text)
const debug = (w: Logs): string[] => w.logs.filter((l) => l.to === 'debug').map((l) => l.text)
const count = (list: string[], text: string): number => list.filter((t) => t === text).length
const RESET_NOTICES = [resetResumes(), resetStopOver(), resetResumes(WEEK), resetStopOver(WEEK)]

type Rec = { sid: string; until: number; at: number; tags: string[] }
/** SPARE10_STOPPED split into its fields, the tags as a sorted list (3.2 gives no tag order). */
function rec(w: World): Rec | undefined {
  const v = w.env.get('SPARE10_STOPPED')
  if (v === undefined) return undefined
  const [sid = '', until = '', at = '', ...tags] = v.split(' ')
  return { sid, until: Number(until), at: Number(at), tags: tags.join(' ').split(',').sort() }
}
const want = (sid: string, until: number, at: number, tags: string): Rec => ({ sid, until, at, tags: tags.split(',').sort() })

/** The /spare10 report, one entry per line with runs of white space folded. */
async function status($: Engine): Promise<string[]> {
  const r = await $.command.run(cmd(''))
  return (r.text ?? '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
}

/** The footer badge text as drawn (with its leading space). */
async function badgeOf($: Engine): Promise<string> {
  const ui = await $.ui.mount({ plugin: 'spare10', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  const t = await ui.find({ type: 'Text', text: /spare10/ })
  await ui.unmount()
  return t?.text ?? ''
}

/** A held main tool call answered Stop here at the current time: the stop has work and auto. */
async function loopStop($: Engine, w: World, used = 93, ms = RESETS_MS, auto = true): Promise<void> {
  const held = bash($)
  await w.clock.settle()
  expect(w.asked.map((a) => a.question).at(-1)).toBe(loopQuestion(used, ms, auto))
  const at = w.clock.now()
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(used, ms))
  await w.clock.settle()
  expect(rec(w)).toEqual(want('S1', ms, at, auto ? 'five_hour,work,auto' : 'five_hour,work'))
}

// ---- B34: the stop at its due time ----

test('Stop here then the reset: one resume prompt, the stop cleared, the notice', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  expect(count(transcript(w), stoppedWork(clock(RESETS_MS)))).toBe(1)
  expect(await badgeOf($)).toBe(` ■ spare10: stopped until ${clock(RESETS_MS)}`)
  await w.clock.set(DUE - 1) // past the reset, inside the margin: nothing yet
  expect(w.submitted).toEqual([])
  expect(rec(w)?.sid).toBe('S1')
  expect(transcript(w).filter((t) => RESET_NOTICES.includes(t))).toEqual([])
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([resumePrompt()])
  expect(w.prompts.map((p) => p.text)).toEqual([resumePrompt()])
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(count(transcript(w), resetResumes())).toBe(1)
  expect(w.env.has('SPARE10_CONSENT')).toBe(false) // the release writes no consent
  expect(await badgeOf($)).not.toContain('stopped')
})

test('a second tick after the release sends nothing', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([resumePrompt()])
  await w.clock.advance(20 * TICK)
  expect(w.submitted).toEqual([resumePrompt()])
  expect(count(transcript(w), resetResumes())).toBe(1)
  expect((await bash($)).result).toBe('ran') // the new window is below the trip point
})

test('a loop Stop, then a prompt question answered with Esc: the reset sends one resume prompt', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  await w.clock.advance(MIN)
  w.answer = 'dismiss' // Esc on the prompt's dialog counts as Stop here (B5)
  expect(await $.prompt.submit(typed('carry on'))).toEqual({ drop: notStarted() })
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(), promptQuestion()])
  // The merge rule keeps the work of the earlier loop Stop (3.2): the later Stop gives the time.
  expect(rec(w)).toEqual(want('S1', RESETS_MS, T0 + MIN, 'five_hour,work,auto'))
  // The notice follows the merged record: it says that spare10 continues the work (2.4).
  expect(count(transcript(w), stoppedWork(clock(RESETS_MS)))).toBe(2)
  expect(count(transcript(w), stoppedNoWork(clock(RESETS_MS)))).toBe(0)
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([resumePrompt()])
  expect(count(transcript(w), resetResumes())).toBe(1)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
})

test('Stop here on a prompt question of an idle session: the stop ends at the reset, nothing is sent, and the notice says to type', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([promptQuestion()])
  w.release('Stop here')
  expect(await p).toEqual({ drop: notStarted() })
  await w.clock.advance(1000)
  expect(w.fills).toEqual(['hello'])
  expect(rec(w)).toEqual(want('S1', RESETS_MS, T0, 'five_hour,auto')) // no loop was held: no work
  expect(count(transcript(w), stoppedNoWork(clock(RESETS_MS)))).toBe(1)
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([])
  expect(w.prompts).toEqual([])
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(count(transcript(w), resetStopOver())).toBe(1)
  expect(count(transcript(w), resetResumes())).toBe(0)
})

test('/spare10 stop, then a refused step, then the reset: one resume prompt', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93 })
  await begin($, w)
  expect((await $.command.run(cmd('stop'))).text).toBe(stopTripped(clock(RESETS_MS)))
  await w.clock.settle()
  expect(rec(w)).toEqual(want('S1', RESETS_MS, T0, 'five_hour,auto'))
  const refused = await drain($, step(undefined, 'T1'))
  expect(refused.text).toBe(PAUSED())
  await w.clock.settle()
  expect(w.requests).toBe(0)
  expect(rec(w)).toEqual(want('S1', RESETS_MS, T0, 'five_hour,work,auto')) // markWork (5.7)
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([resumePrompt()])
  expect(count(transcript(w), resetResumes())).toBe(1)
})

for (const offset of [0, 500, 1000, 1500, 2500]) {
  test(`markWork does not bring back a stop that /spare10 resume cleared (envGetDelayMs on SPARE10_STOPPED, resume ${offset} ms after the step)`, async ($, on) => {
    const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
    await begin($, w)
    expect((await $.command.run(cmd('stop'))).text).toBe(stopTripped(clock(RESETS_MS)))
    await w.clock.settle()
    w.envGetDelayMs = { SPARE10_STOPPED: 1000 }
    const refused = drain($, step(undefined, 'T1'))
    if (offset > 0) await w.clock.advance(offset)
    else await w.clock.settle()
    const reply = $.command.run(cmd('resume'))
    for (let i = 0; i < 20; i += 1) await w.clock.advance(500)
    expect((await refused).text).toBe(PAUSED())
    expect((await reply).text).toBe(RESUMED_STOPPED)
    await w.clock.advance(5000)
    expect(w.env.has('SPARE10_STOPPED')).toBe(false)
    expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
    w.envGetDelayMs = {}
    expect((await bash($)).result).toBe('ran')
    await pastDue(w, RESETS)
    expect(w.submitted).toEqual([])
    expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  })
}

test('a stop past its reset with the weekly window in the reserve is extended until the weekly reset', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93, resetsAt: SOON, weekPct: 50, weekResetsAt: RESETS })
  await begin($, w)
  await loopStop($, w, 93, SOON_MS)
  w.weekPct = 95 // the weekly window reaches its reserve while the 5-hour stop lasts
  await pastDue(w, SOON)
  expect(w.submitted).toEqual([])
  expect(rec(w)).toEqual(want('S1', RESETS_MS, T0, 'seven_day,work,auto')) // at, work and auto stay
  expect(count(transcript(w), `${FIVE}, but your 10% weekly reserve is reached. The stop lasts until ${weekday(RESETS_MS)}.`)).toBe(1)
  expect(transcript(w).filter((t) => RESET_NOTICES.includes(t))).toEqual([])
  expect(await badgeOf($)).toBe(` ■ spare10: stopped until ${weekday(RESETS_MS)}`)
  expect((await bash($)).deny).toContain('spare10: the user stopped work at the quota reserve (into your 10% weekly reserve')
  await w.clock.set(RESETS_MS + MARGIN - 1)
  expect(w.submitted).toEqual([])
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([resumePrompt(WEEK)])
  expect(count(transcript(w), resetResumes(WEEK))).toBe(1)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
})

test('a Stop on a test window continues 60 s after the test window ends', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 50 })
  await begin($, w)
  expect((await $.command.run(cmd('simulate 95 in 2m'))).text).toContain('test reading set to 95% used')
  const end = T0 + 2 * MIN
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  w.release('Stop here')
  expect((await held).deny).toContain('spare10: the user stopped work at the quota reserve (')
  await w.clock.settle()
  expect(rec(w)).toEqual(want('S1', end, T0, 'five_hour,work,auto,test'))
  await w.clock.set(end + TEST_MARGIN - 1)
  expect(w.submitted).toEqual([])
  await pastDue(w, new Date(end).toISOString(), TEST_MARGIN)
  expect(w.submitted).toEqual([resumePrompt('the test window ended')])
  expect(count(transcript(w), resetResumes('the test window ended'))).toBe(1)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
})

test('a real trip under a test-window stop extends the stop until the real reset', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 50 })
  await begin($, w)
  expect((await $.command.run(cmd('simulate 95 in 2m'))).text).toContain('test reading set to 95% used')
  const end = T0 + 2 * MIN
  const held = bash($)
  await w.clock.settle()
  w.release('Stop here')
  expect((await held).deny).toContain('spare10: the user stopped work at the quota reserve (')
  await w.clock.settle()
  w.pct = 93 // the real reading reaches the reserve under the test reading
  await pastDue(w, new Date(end).toISOString(), TEST_MARGIN)
  expect(w.submitted).toEqual([])
  const r = rec(w)
  expect([r?.sid, r?.until, r?.at]).toEqual(['S1', RESETS_MS, T0])
  expect(r?.tags.filter((t) => t !== 'test')).toEqual(['auto', 'five_hour', 'work'])
  expect(count(transcript(w), `the test window ended, but your 10% reserve is reached. The stop lasts until ${clock(RESETS_MS)}.`)).toBe(1)
  expect((await bash($)).deny).toBe(STOP())
  // Now it rests on a real window: nothing is released before the 5-minute margin (section 0, 4.8).
  await w.clock.set(DUE - 1)
  expect(w.submitted).toEqual([])
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([resumePrompt()])
})

test('a stop with the auto tag sends nothing when autoResume is off now', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93, env: { ...AUTO_OFF, SPARE10_STOPPED: stopRec('S1', RESETS_MS, T0 - MIN, 'five_hour,work,auto') } })
  await begin($, w)
  expect(await badgeOf($)).toBe(' ■ spare10: stopped') // the clock shows only while autoResume is on (2.6)
  expect((await bash($)).deny).toBe(STOP())
  await pastDue(w, RESETS)
  await w.clock.advance(10 * TICK)
  expect(w.submitted).toEqual([])
  expect(transcript(w).filter((t) => RESET_NOTICES.includes(t))).toEqual([])
  expect((await bash($)).result).toBe('ran')
})

test('/exit ends a stopped conversation for good: nothing is sent at the reset', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'S1', resume: { id: 'S1' } })
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([])
  expect(transcript(w).filter((t) => RESET_NOTICES.includes(t))).toEqual([])
})

// ---- B35: the person takes the release over ----

test('a person prompt after the reset and before the tick takes the release over with the reset note', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  await w.clock.set(RESETS_MS + MIN)
  expect(await $.prompt.submit(typed('what next'))).toMatchObject({ text: 'what next' })
  expect(w.prompts.map((p) => p.context)).toEqual([[resetNote()]])
  await w.clock.settle()
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(count(transcript(w), stopTakenOver())).toBe(1)
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([])
  expect(count(transcript(w), resetResumes())).toBe(0)
  expect(w.asked).toHaveLength(1)
})

test('a person prompt that arrives while the tick releases (envGetDelayMs): no resume prompt, and the prompt carries the note', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  await w.clock.set(DUE - 1)
  w.envGetDelayMs = { SPARE10_STOPPED: 1000 }
  await w.clock.advance(1) // the tick at the due time reads the stop
  await w.clock.advance(1000) // and goes on to its release
  const p = $.prompt.submit(typed('what next'))
  for (let i = 0; i < 10; i += 1) await w.clock.advance(500)
  expect(await p).toMatchObject({ text: 'what next' })
  expect(w.prompts.map((e) => e.context)).toEqual([[resetNote()]])
  await w.clock.advance(10 * TICK)
  expect(w.submitted).toEqual([])
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(count(transcript(w), stopTakenOver())).toBe(1)
  expect(count(transcript(w), resetResumes())).toBe(0)
})

test('a person prompt that arrives while the tick clears the stop (envSetDelayMs): no resume prompt, and the prompt carries the note', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  await w.clock.set(DUE - 1)
  w.envSetDelayMs = 1000
  await w.clock.advance(1) // the tick at the due time is in its clear
  const p = $.prompt.submit(typed('what next'))
  for (let i = 0; i < 10; i += 1) await w.clock.advance(500)
  expect(await p).toMatchObject({ text: 'what next' })
  expect(w.prompts.map((e) => e.context)).toEqual([[resetNote()]])
  await w.clock.advance(10 * TICK)
  expect(w.submitted).toEqual([])
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(count(transcript(w), stopTakenOver())).toBe(1)
  expect(count(transcript(w), resetResumes())).toBe(0)
})

test('a person prompt whose sense outlasts the tick clearing the stop (usageDelayMs): the tick hands it over, no resume prompt, and the prompt carries the note', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  await w.clock.set(DUE - 1)
  w.envSetDelayMs = 1000
  await w.clock.advance(1) // the tick at the due time is in its clear
  w.usageDelayMs = 2000 // the prompt enters now, and its sense ends after the clear
  const p = $.prompt.submit(typed('what next'))
  await w.clock.advance(1000) // the clear ends while the prompt is still in flight: the tick hands the stop over (4.6.3)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(w.submitted).toEqual([])
  for (let i = 0; i < 4; i += 1) await w.clock.advance(500)
  expect(await p).toMatchObject({ text: 'what next' })
  expect(w.prompts.map((e) => e.context)).toEqual([[resetNote()]])
  w.usageDelayMs = 0
  await w.clock.advance(10 * TICK)
  expect(w.submitted).toEqual([])
  expect(count(transcript(w), stopTakenOver())).toBe(1)
  expect(count(transcript(w), resetResumes())).toBe(0)
})

test('a person prompt after the reset takes over a stop with no work: no note, and nothing is sent', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93 })
  await begin($, w)
  expect((await $.command.run(cmd('stop'))).text).toBe(stopTripped(clock(RESETS_MS)))
  await w.clock.settle()
  await w.clock.set(RESETS_MS + MIN)
  expect(await $.prompt.submit(typed('what next'))).toMatchObject({ text: 'what next' })
  expect(w.prompts.map((e) => e.context)).toEqual([undefined])
  await w.clock.settle()
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(count(transcript(w), stopTakenOver())).toBe(1)
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([])
  expect(transcript(w).filter((t) => RESET_NOTICES.includes(t))).toEqual([])
})

test('a prompt nobody typed after the reset does not take the release over', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  await w.clock.set(RESETS_MS + MIN)
  expect(await $.prompt.submit(typed('task done', 'task-notification'))).toMatchObject({ text: 'task done' })
  expect(w.prompts.map((e) => e.context)).toEqual([undefined])
  await w.clock.settle()
  expect(count(transcript(w), stopTakenOver())).toBe(0)
  expect(rec(w)?.sid).toBe('S1')
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([resumePrompt()])
  expect(count(transcript(w), resetResumes())).toBe(1)
})

test('a prompt question open in a stopped session: the reset lets the prompt in with the note, and no resume prompt comes', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  const p = $.prompt.submit(typed('carry on'))
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(), promptQuestion()])
  await w.clock.set(DUE - 1)
  expect(w.prompts).toEqual([])
  expect(w.submitted).toEqual([])
  await pastDue(w, RESETS)
  expect(await p).toMatchObject({ text: 'carry on' })
  expect(w.prompts.map((e) => e.context)).toEqual([[resetNote()]])
  expect(w.dialogAborted).not.toBe('no') // the dialog is withdrawn
  await w.clock.advance(10 * TICK)
  expect(w.submitted).toEqual([])
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  expect(count(transcript(w), stopTakenOver())).toBe(1)
  expect(count(transcript(w), resetResumes())).toBe(0)
})

test('a prompt question open in a stopped session whose check is slow (envGetDelayMs on SPARE10_CONSENT): the tick still sends nothing', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  const p = $.prompt.submit(typed('carry on'))
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
  await w.clock.set(DUE - 1)
  // The held prompt reads consent before its check, so at the due tick it is still in flight (personHeld).
  w.envGetDelayMs = { SPARE10_CONSENT: 20_000 }
  await pastDue(w, RESETS)
  await w.clock.advance(MIN)
  expect(await p).toMatchObject({ text: 'carry on' })
  expect(w.prompts.map((e) => e.context)).toEqual([[resetNote()]])
  await w.clock.advance(10 * TICK)
  expect(w.submitted).toEqual([])
  expect(count(transcript(w), stopTakenOver())).toBe(1)
  expect(count(transcript(w), resetResumes())).toBe(0)
})

for (const verb of ['stop', 'resume'] as const) {
  test(`/spare10 ${verb} while the tick releases (envGetDelayMs): no resume prompt, and the overdue reply`, async ($, on) => {
    const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
    await begin($, w)
    await loopStop($, w)
    await w.clock.set(DUE - 1)
    w.envGetDelayMs = { SPARE10_STOPPED: 1000 }
    await w.clock.advance(1) // the tick at the due time reads the stop
    await w.clock.advance(1000) // and goes on to its release
    const reply = $.command.run(cmd(verb))
    for (let i = 0; i < 10; i += 1) await w.clock.advance(500)
    expect((await reply).text).toBe(verb === 'stop' ? STOP_OVERDUE : RESUME_OVERDUE)
    await w.clock.advance(10 * TICK)
    expect(w.submitted).toEqual([])
    expect(w.env.has('SPARE10_STOPPED')).toBe(false)
    expect(w.env.has('SPARE10_CONSENT')).toBe(false)
    expect(count(transcript(w), stopTakenOver())).toBe(1)
    expect(count(transcript(w), resetResumes())).toBe(0)
  })
}

test('/spare10 stop after the reset and before the tick: no resume prompt, and the reply says so', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  await w.clock.set(RESETS_MS + MIN)
  expect((await $.command.run(cmd('stop'))).text).toBe(STOP_OVERDUE)
  await w.clock.settle()
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(count(transcript(w), stopTakenOver())).toBe(1)
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([])
  expect(count(transcript(w), resetResumes())).toBe(0)
  expect((await $.command.run(cmd('stop'))).text).toBe(NOTHING_TO_STOP)
})

test('/spare10 resume after the reset and before the tick: the stop is cleared, no resume prompt', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  await w.clock.set(RESETS_MS + MIN)
  expect((await $.command.run(cmd('resume'))).text).toBe(RESUME_OVERDUE)
  await w.clock.settle()
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  expect(count(transcript(w), stopTakenOver())).toBe(1)
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([])
  expect(count(transcript(w), resetResumes())).toBe(0)
})

// ---- 4.7, B39: /clear and /resume ----

test('/clear before the reset: the old stop is dropped, and nothing is sent', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  await clear($, w, 'S2')
  await w.clock.set(DUE - 1)
  expect(rec(w)?.sid).toBe('S1') // kept until its due time
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([])
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(count(debug(w), DROPPED)).toBe(1)
  expect(transcript(w).filter((t) => RESET_NOTICES.includes(t))).toEqual([])
})

test('/clear during the release (envGetDelayMs): no resume prompt', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  await w.clock.set(DUE - 1)
  w.envGetDelayMs = { SPARE10_STOPPED: 1000 }
  await w.clock.advance(1) // the tick at the due time reads the stop
  await w.clock.advance(1000) // and goes on to its release
  await clear($, w, 'S2')
  for (let i = 0; i < 10; i += 1) await w.clock.advance(500)
  await w.clock.advance(10 * TICK)
  expect(w.submitted).toEqual([])
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(count(debug(w), SKIPPED) + count(debug(w), DROPPED)).toBe(1)
  expect(count(transcript(w), resetResumes())).toBe(0)
})

test('/resume back to a cleared conversation before the due time: the stop applies again and continues', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  await clear($, w, 'S2')
  await w.clock.advance(MIN)
  await clear($, w, 'S1', 'resume') // back to the stopped conversation
  expect((await bash($)).deny).toBe(STOP())
  expect(w.asked).toHaveLength(1)
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([resumePrompt()])
  expect(count(transcript(w), resetResumes())).toBe(1)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(count(debug(w), DROPPED)).toBe(0)
})

// ---- 4.6.2: the person at the terminal ----

test('text in the prompt box delays the resume prompt for up to ten ticks', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  w.box = 'half typed'
  await w.clock.set(DUE + 9 * TICK) // ten ticks from the due time on
  expect(w.submitted).toEqual([])
  expect(debug(w).filter((t) => t.startsWith('spare10: the prompt box has text.'))).toEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(boxDefer),
  )
  expect(rec(w)?.sid).toBe('S1')
  await w.clock.advance(TICK) // then it goes anyway
  expect(w.submitted).toEqual([resumePrompt()])
  expect(count(transcript(w), resetResumes())).toBe(1)
  expect(w.box).toBe('half typed') // the box is left alone
})

test('text in the prompt box that the person clears lets the resume prompt go at the next tick', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  w.box = 'half typed'
  await w.clock.set(DUE + 2 * TICK)
  expect(w.submitted).toEqual([])
  w.box = ''
  await w.clock.advance(TICK)
  expect(w.submitted).toEqual([resumePrompt()])
})

test('the draft that Stop here restored does not delay the resume prompt', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  const p = $.prompt.submit(typed('carry on'))
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(), promptQuestion()])
  w.release('Stop here')
  expect(await p).toEqual({ drop: notStarted() })
  await w.clock.advance(1000)
  expect(w.fills).toEqual(['carry on'])
  expect(w.box).toBe('carry on')
  expect(rec(w)?.tags).toEqual(['auto', 'five_hour', 'work'])
  await w.clock.set(DUE + 1)
  expect(w.submitted).toEqual([resumePrompt()])
  expect(debug(w).filter((t) => t.startsWith('spare10: the prompt box has text.'))).toEqual([])
})

// ---- stops that never continue ----

test('a stop without the auto tag is never continued', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93, env: { SPARE10_STOPPED: stopRec('S1', RESETS_MS, T0 - MIN, 'five_hour,work') } })
  await begin($, w)
  expect(await badgeOf($)).toBe(' ■ spare10: stopped')
  expect((await bash($)).deny).toBe(STOP())
  await pastDue(w, RESETS)
  await w.clock.advance(10 * TICK)
  expect(w.submitted).toEqual([])
  expect(transcript(w).filter((t) => RESET_NOTICES.includes(t) || t === stopTakenOver())).toEqual([])
  expect((await bash($)).result).toBe('ran') // it ended by time at its until
})

test('a dropped resume prompt logs the failure', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93, submitDrop: 'another plugin dropped it' })
  await begin($, w)
  await loopStop($, w)
  await pastDue(w, RESETS)
  await w.clock.settle()
  expect(w.submitted).toEqual([resumePrompt()])
  expect(w.prompts).toEqual([])
  expect(count(transcript(w), resumeFailed('another plugin dropped it'))).toBe(1)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false) // the window reset: the person can type
  await w.clock.advance(10 * TICK)
  expect(w.submitted).toEqual([resumePrompt()]) // one attempt
})

test('a 0.1 stop value is never continued', async ($, on) => {
  const legacy = `S1 ${RESETS_MS} ${T0 - MIN}`
  const w = world(on, { spans: 'off', pct: 93, env: { SPARE10_STOPPED: legacy } })
  await begin($, w)
  expect(await badgeOf($)).toBe(' ■ spare10: stopped')
  expect((await bash($)).deny).toBe(STOP())
  await pastDue(w, RESETS)
  await w.clock.advance(10 * TICK)
  expect(w.submitted).toEqual([])
  expect(w.env.get('SPARE10_STOPPED')).toBe(legacy) // the ticker leaves it alone
  expect(transcript(w).filter((t) => RESET_NOTICES.includes(t) || t === stopTakenOver())).toEqual([])
  expect((await bash($)).result).toBe('ran')
})

// ---- autoResume off ----

test('autoResume off: the question waits past the reset, B6 once, and a later answer applies', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93, env: AUTO_OFF })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(93, RESETS_MS, false)])
  await pastDue(w, RESETS)
  await w.clock.advance(10 * MIN)
  expect(w.ran).toEqual([])
  expect(w.dialogAborted).toBe('no')
  expect(count(transcript(w), RESET_WAITING)).toBe(1)
  expect(w.submitted).toEqual([])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w)).toContain(NEW_WINDOW)
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
})

test('autoResume off: a Stop here sends nothing at the reset', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93, env: AUTO_OFF })
  await begin($, w)
  await loopStop($, w, 93, RESETS_MS, false)
  expect(count(transcript(w), STOPPED_AUTO_OFF)).toBe(1)
  expect(await badgeOf($)).toBe(' ■ spare10: stopped')
  await pastDue(w, RESETS)
  await w.clock.advance(10 * TICK)
  expect(w.submitted).toEqual([])
  expect(transcript(w).filter((t) => RESET_NOTICES.includes(t) || t === stopTakenOver())).toEqual([])
  expect((await bash($)).result).toBe('ran')
})

test('SPARE10_AUTO_RESUME=off switches it off for the run', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93, env: AUTO_OFF })
  await begin($, w)
  expect(await status($)).toContain('· at the reset wait for your answer (from SPARE10_AUTO_RESUME)')
  const held = bash($)
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(93, RESETS_MS, false)])
  expect(await status($)).toContain(ASKING_LINE_OFF)
  expect(await badgeOf($)).toBe(' ? spare10: waiting for you')
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

test('a bad SPARE10_AUTO_RESUME warns once, and autoResume stays on', async ($, on) => {
  const warning = 'SPARE10_AUTO_RESUME="maybe" is not on or off. spare10 uses on.'
  const w = world(on, { spans: 'off', pct: 50, env: { SPARE10_AUTO_RESUME: 'maybe' } })
  await begin($, w)
  expect(count(transcript(w), warning)).toBe(1)
  const lines = await status($)
  expect(lines).toContain(`⚠ ${warning}`)
  expect(lines).toContain('· at the reset continue by itself (from /config)')
  expect((await bash($)).result).toBe('ran')
  expect(count(transcript(w), warning)).toBe(1)
})

// ---- redraws, badge and report ----

test('the ticker redraws a stopped badge at its end', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  await w.clock.set(RESETS_MS - 2 * MIN)
  const ui = await $.ui.mount({ plugin: 'spare10', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect((await ui.find({ type: 'Text', text: /spare10/ }))?.text).toBe(` ■ spare10: stopped until ${clock(RESETS_MS)}`)
  await w.clock.set(RESETS_MS + TICK) // across the stop's end, before its due time
  expect((await ui.find({ type: 'Text', text: /spare10/ }))?.text).not.toContain('stopped')
  await ui.unmount()
})

test('a fresh module redraws at a stop end it finds in the env', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93, env: { SPARE10_STOPPED: stopRec('S1', RESETS_MS, T0 - MIN, 'five_hour,work,auto') } })
  await begin($, w)
  await w.clock.set(RESETS_MS - 2 * MIN)
  const ui = await $.ui.mount({ plugin: 'spare10', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect((await ui.find({ type: 'Text', text: /spare10/ }))?.text).toBe(` ■ spare10: stopped until ${clock(RESETS_MS)}`)
  await w.clock.set(RESETS_MS + TICK)
  expect((await ui.find({ type: 'Text', text: /spare10/ }))?.text).not.toContain('stopped')
  await ui.unmount()
  await pastDue(w, RESETS) // a stop another copy wrote continues here too
  expect(w.submitted).toEqual([resumePrompt()])
})

test('a fresh module redraws at a consent end it finds in the env', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93, env: { SPARE10_CONSENT: `S1 ${RESETS}` } })
  await begin($, w)
  await w.clock.set(RESETS_MS - 2 * MIN)
  const ui = await $.ui.mount({ plugin: 'spare10', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect((await ui.find({ type: 'Text', text: /spare10/ }))?.text).toBe(' ⨯ spare10')
  await w.clock.set(RESETS_MS + TICK)
  expect((await ui.find({ type: 'Text', text: /spare10/ }))?.text).not.toBe(' ⨯ spare10')
  await ui.unmount()
})

test('the stopped badge names the clock of the reset', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(await badgeOf($)).toBe(` ? spare10: waiting for you until ${clock(RESETS_MS)}`)
  w.release('Stop here')
  expect((await held).deny).toBe(STOP())
  await w.clock.settle()
  expect(await badgeOf($)).toBe(` ■ spare10: stopped until ${clock(RESETS_MS)}`)
})

test('the stopped badge names a weekday for the weekly window', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 50, weekPct: 95 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([weeklyQuestion(95, WEEK_MS)])
  expect(await badgeOf($)).toBe(` ? spare10: waiting for you until ${weekday(WEEK_MS)}`)
  w.release('Stop here')
  expect((await held).deny).toContain('spare10: the user stopped work at the quota reserve (into your 10% weekly reserve')
  await w.clock.settle()
  expect(rec(w)).toEqual(want('S1', WEEK_MS, T0, 'seven_day,work,auto'))
  expect(await badgeOf($)).toBe(` ■ spare10: stopped until ${weekday(WEEK_MS)}`)
})

test('/spare10 shows when an open question and a stop continue', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(await status($)).toContain(askingLine(clock(RESETS_MS)))
  w.release('Stop here')
  expect((await held).deny).toBe(STOP())
  await w.clock.settle()
  expect(await status($)).toContain(stoppedLineWork(clock(RESETS_MS)))
})

test('/spare10 shows a stop with no work, and the work a refused step adds', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93 })
  await begin($, w)
  expect((await $.command.run(cmd('stop'))).text).toBe(stopTripped(clock(RESETS_MS)))
  await w.clock.settle()
  expect(await status($)).toContain(stoppedLineNoWork(clock(RESETS_MS)))
  expect((await drain($, step(undefined, 'T1'))).text).toBe(PAUSED())
  await w.clock.settle()
  expect(await status($)).toContain(stoppedLineWork(clock(RESETS_MS)))
})

// ---- 3.1: a reading without resetsAt ----

test('without resetsAt a hold ends one window after the first sight, not at the one-hour fallback', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93, resetsAt: null })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  const end = T0 + 5 * HOUR // first sight at T0, plus the window length
  expect(w.asked.map((a) => a.question)).toEqual([
    'Your 10% reserve is reached: 93% used · 7% left · resets at an unknown time. All work is on hold. Continue on the reserve for one hour?' +
      loopAfter(clock(end)),
  ])
  await w.clock.set(T0 + HOUR + 2 * TICK) // past the one-hour consent fallback
  expect(w.ran).toEqual([])
  await w.clock.set(end + MARGIN - 1) // past the hold end, inside the margin
  expect(w.ran).toEqual([])
  await w.clock.set(end + MARGIN + TICK)
  expect((await held).result).toBe('ran')
  expect(w.ran).toEqual(['Bash:main'])
  await w.clock.settle()
  expect(count(transcript(w), resetContinues())).toBe(1)
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
})

// ---- 4.2: arming the ticker, and the watchdog ----

test('a refused clock.after and a refused watch period leave no ticker: /spare10 warns, and the next measure re-arms it', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 50, afterRefusals: 1, everyRefusals: 1 }) // the ticker's first timer and the watch never run
  await begin($, w)
  await w.clock.advance(2 * MIN)
  expect(await status($)).toContain(TICKER_WARNING)
  await $.session.measure(measure(50))
  await w.clock.advance(5 * MIN)
  expect(await status($)).not.toContain(TICKER_WARNING)
  // The re-armed ticker releases a held question at its due time (in the kit nothing else wakes it).
  w.pct = 93
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await pastDue(w, RESETS)
  expect((await held).result).toBe('ran')
})

test('session.start arms the ticker even when a start-up read fails (envGetFails)', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93, envGetFails: ['SPARE10_STOPPED', 'SPARE10_CONSENT', 'SPARE10_WEEKLY_CONSENT'] })
  await begin($, w)
  w.envGetFails = []
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await pastDue(w, RESETS) // no measure, no badge, no /spare10: only the ticker wakes the waiter
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(count(transcript(w), resetContinues())).toBe(1)
  expect(await status($)).not.toContain(TICKER_WARNING)
})

// ---- 3.2: a Stop after an earlier stop's reset, and the texts of the merged stop ----

test('Stop here on a prompt question inside the margin keeps the work of the earlier loop Stop, and the reset continues it', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  await w.clock.set(RESETS_MS - 2 * MIN)
  const p = $.prompt.submit(typed('carry on'))
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(), promptQuestion()])
  await w.clock.set(RESETS_MS + MIN) // past the stop's until, inside the margin: the dialog is still up
  expect(w.dialogAborted).toBe('no')
  w.release('Stop here')
  expect(await p).toEqual({ drop: notStarted() })
  await w.clock.settle()
  // The earlier stop is past its until, but nobody released it: its work stays (3.2).
  expect(rec(w)).toEqual(want('S1', RESETS_MS, RESETS_MS + MIN, 'five_hour,work,auto'))
  expect(count(transcript(w), stoppedWork(clock(RESETS_MS)))).toBe(2)
  expect(count(transcript(w), stoppedNoWork(clock(RESETS_MS)))).toBe(0)
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([resumePrompt()])
  expect(count(transcript(w), resetResumes())).toBe(1)
  expect(count(transcript(w), resetStopOver())).toBe(0)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
})

test('Stop here on a prompt question that names the weekly window too, after the 5-hour stop ended: the work stays, and the weekly reset continues it', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93, weekPct: 50, weekResetsAt: LATER })
  await begin($, w)
  await loopStop($, w)
  w.weekPct = 95 // another session reaches the weekly reserve while the 5-hour stop lasts
  await w.clock.set(RESETS_MS - 2 * MIN)
  const p = $.prompt.submit(typed('carry on'))
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
  await w.clock.set(RESETS_MS + 10 * MIN) // the 5-hour stop is past its due time: the held prompt keeps the ticker away
  expect(rec(w)).toEqual(want('S1', RESETS_MS, T0, 'five_hour,work,auto'))
  w.release('Stop here')
  expect(typeof ((await p) as { drop?: unknown }).drop).toBe('string') // not started: the prompt goes back
  await w.clock.settle()
  expect(rec(w)).toEqual(want('S1', LATER_MS, RESETS_MS + 10 * MIN, 'five_hour,seven_day,work,auto'))
  expect(count(transcript(w), stoppedWork(weekday(LATER_MS)).replace('your 10% reserve', 'your 10% reserve and your 10% weekly reserve'))).toBe(1)
  await pastDue(w, LATER)
  expect(w.submitted).toEqual([resumePrompt('the 5-hour and weekly windows reset')])
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
})

test('Stop here after the named window reset, while another window gates now: the stop names it and lasts until its reset', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93, weekPct: 50, weekResetsAt: LATER })
  await begin($, w)
  await w.clock.set(RESETS_MS - 2 * MIN)
  const p = $.prompt.submit(typed('carry on'))
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([promptQuestion()])
  await w.clock.set(RESETS_MS + MIN) // the 5-hour window reset, inside the margin
  w.weekPct = 95 // the weekly window, which the dialog does not name, gates now
  w.release('Stop here')
  expect(await p).toEqual({ drop: notStarted() })
  await w.clock.settle()
  // Not written already over: the stop also names the weekly window, until its reset.
  expect(rec(w)).toEqual(want('S1', LATER_MS, RESETS_MS + MIN, 'five_hour,seven_day,auto'))
  expect(count(transcript(w), `stopped at your 10% reserve and your 10% weekly reserve until ${weekday(LATER_MS)}. Type a prompt to be asked again, or run /spare10 resume.`)).toBe(1)
  w.answer = 'Stop here'
  expect((await bash($)).deny).toContain('spare10: the user stopped work at the quota reserve (into your 10% weekly reserve')
  expect(w.asked).toHaveLength(1) // refused as stopped: no new question
})

test('a prompt question in a weekly stop: the Stop notice gives the end and the work of the merged stop', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 50, weekPct: 92 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  w.release('Stop here')
  expect((await held).deny).toContain('into your 10% weekly reserve')
  await w.clock.settle()
  expect(rec(w)).toEqual(want('S1', WEEK_MS, T0, 'seven_day,work,auto'))
  w.weekPct = 50 // a limit-reset grant: the weekly window leaves its reserve, and the stop still applies
  w.pct = 93
  w.answer = 'dismiss'
  expect(await $.prompt.submit(typed('carry on'))).toEqual({ drop: notStarted() })
  await w.clock.settle()
  expect(w.asked.map((a) => a.question).at(-1)).toBe(promptQuestion())
  expect(rec(w)).toEqual(want('S1', WEEK_MS, T0, 'five_hour,seven_day,work,auto'))
  expect(count(transcript(w), stoppedWork(weekday(WEEK_MS)))).toBe(1)
  expect(count(transcript(w), stoppedNoWork(clock(RESETS_MS)))).toBe(0)
})

test('a loop that joins a prompt question counts as work: Stop here keeps it, and the reset continues it', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93, agents: ['a1'] })
  await begin($, w)
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([promptQuestion()])
  const sub = bash($, 'a1') // a background agent's call joins the open question
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  w.release('Stop here')
  expect(await p).toEqual({ drop: notStarted() })
  expect((await sub).deny).toBe(STOP())
  await w.clock.settle()
  expect(rec(w)).toEqual(want('S1', RESETS_MS, T0, 'five_hour,work,auto'))
  expect(count(transcript(w), stoppedWork(clock(RESETS_MS)))).toBe(1)
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([resumePrompt()])
})

// ---- 4.8: the margin after a real reset, also for a test reading ----

test('simulate 95 on a real reading in the reserve borrows its reset: an unanswered question waits the 5-minute margin, not 60 s', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93 })
  await begin($, w)
  expect((await $.command.run(cmd('simulate 95'))).text).toContain(`test reading set to 95% used, resets ${clock(RESETS_MS)}`)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await w.clock.set(RESETS_MS + TEST_MARGIN + TICK) // the test margin has passed, the real one has not
  expect(w.ran).toEqual([])
  await w.clock.set(DUE - 1)
  expect(w.ran).toEqual([])
  expect(w.dialogAborted).toBe('no')
  await pastDue(w, RESETS)
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(count(transcript(w), resetContinues('the test window ended'))).toBe(1)
})

test('a Stop on a test reading that borrowed the reset of a real reading in the reserve continues after the 5-minute margin', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93 })
  await begin($, w)
  expect((await $.command.run(cmd('simulate 95'))).text).toContain(`test reading set to 95% used, resets ${clock(RESETS_MS)}`)
  const held = bash($)
  await w.clock.settle()
  w.release('Stop here')
  expect((await held).deny).toContain('spare10: the user stopped work at the quota reserve (')
  await w.clock.settle()
  expect(rec(w)).toEqual(want('S1', RESETS_MS, T0, `five_hour,work,auto,test,${real5(RESETS)}`))
  await w.clock.set(RESETS_MS + TEST_MARGIN + TICK)
  expect(w.submitted).toEqual([])
  await w.clock.set(DUE - 1)
  expect(w.submitted).toEqual([])
  expect(rec(w)?.sid).toBe('S1')
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([resumePrompt('the test window ended')])
})

test('Stop here on a real 5-hour trip plus a weekly test window: no test tag, and the release waits the 5-minute margin', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93 })
  await begin($, w)
  expect((await $.command.run(cmd('simulate 95 weekly in 2m'))).text).toContain('test reading set to 95% used of the weekly window')
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  w.release('Stop here')
  expect((await held).deny).toContain('spare10: the user stopped work at the quota reserve (')
  await w.clock.settle()
  expect(rec(w)).toEqual(want('S1', RESETS_MS, T0, 'five_hour,seven_day,work,auto')) // a real kind: no test tag
  await w.clock.set(RESETS_MS + MARGIN - TICK)
  expect(w.submitted).toEqual([])
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([resumePrompt('the 5-hour and weekly windows reset')])
})

test('/spare10 stop on a real 5-hour trip plus a weekly test window: no test tag, and the release waits the 5-minute margin', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93 })
  await begin($, w)
  expect((await $.command.run(cmd('simulate 95 weekly in 2m'))).text).toContain('test reading set to 95% used of the weekly window')
  expect((await $.command.run(cmd('stop'))).text).toBe(stopTripped(weekday(RESETS_MS)))
  await w.clock.settle()
  expect(rec(w)).toEqual(want('S1', RESETS_MS, T0, 'five_hour,seven_day,auto'))
  expect((await drain($, step(undefined, 'T1'))).text).toContain('spare10: work stopped at the quota reserve (')
  await w.clock.settle()
  expect(rec(w)).toEqual(want('S1', RESETS_MS, T0, 'five_hour,seven_day,work,auto'))
  await w.clock.set(RESETS_MS + MARGIN - TICK)
  expect(w.submitted).toEqual([])
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([resumePrompt('the 5-hour and weekly windows reset')])
})

// ---- 4.6: the extension, and the person paths against the ticker ----

test('an extension over two gating kinds lasts until the later reset, and refuses after the earlier one', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, { spans: 'off', pct: 50, weekPct: 50, weekResetsAt: LATER })
  await begin($, w)
  expect((await $.command.run(cmd('simulate 95 in 2m'))).text).toContain('test reading set to 95% used')
  const end = T0 + 2 * MIN
  const held = bash($)
  await w.clock.settle()
  w.release('Stop here')
  expect((await held).deny).toContain('spare10: the user stopped work at the quota reserve (')
  await w.clock.settle()
  expect(rec(w)).toEqual(want('S1', end, T0, 'five_hour,work,auto,test'))
  w.pct = 93 // both real windows reach their reserve under the test reading
  w.weekPct = 92
  await pastDue(w, new Date(end).toISOString(), TEST_MARGIN)
  expect(w.submitted).toEqual([])
  expect(rec(w)).toEqual(want('S1', LATER_MS, T0, 'five_hour,seven_day,work,auto'))
  expect(
    count(transcript(w), `the test window ended, but your 10% reserve and your 10% weekly reserve are reached. The stop lasts until ${weekday(LATER_MS)}.`),
  ).toBe(1)
  await w.clock.set(RESETS_MS + MIN) // the 5-hour window reset: the weekly window still gates
  w.answer = 'Stop here'
  expect((await bash($)).deny).toBe(
    `spare10: the user stopped work at the quota reserve (into your 10% weekly reserve · 8% of weekly quota left · resets ${weekday(LATER_MS)}). Stop now and wait for the user. Do not call any further tools.`,
  )
  expect(w.asked).toHaveLength(1) // refused as stopped: no new question
})

for (const verb of ['resume', 'stop'] as const) {
  for (const offset of [500, 1500]) {
    const outcome = verb === 'resume' ? 'the stop stays over' : 'the extension never stands, and a new stop holds the weekly window'
    test(`/spare10 ${verb} while the tick extends the stop (envGetDelayMs, ${offset} ms after the due tick): ${outcome}`, async ($, on) => {
      const w = world(on, { floors: 'off', spans: 'off', pct: 93, weekPct: 50, weekResetsAt: LATER })
      await begin($, w)
      await loopStop($, w)
      w.weekPct = 95 // at the due time the weekly window gates: the tick extends the stop
      await w.clock.set(DUE - 1)
      w.envGetDelayMs = { SPARE10_STOPPED: 1000 }
      await w.clock.advance(1) // the tick at the due time reads the stop
      await w.clock.advance(offset) // 500: before its extension starts. 1500: during its extension's read
      const reply = $.command.run(cmd(verb))
      for (let i = 0; i < 10; i += 1) await w.clock.advance(500)
      if (verb === 'resume') {
        expect((await reply).text).toBe(RESUME_OVERDUE)
        w.envGetDelayMs = {}
        await w.clock.advance(10 * TICK)
        expect(w.env.has('SPARE10_STOPPED')).toBe(false) // the person was told the stop is over: it is
        expect(count(transcript(w), stopTakenOver())).toBe(1)
      } else {
        // The weekly window gates now, so /spare10 stop takes the old stop over and stops the weekly
        // window. The new stop keeps the work of the old one, and no notice says that a stop is over.
        const at = DUE + offset // the command's sense
        expect((await reply).text).toBe(
          `stopped at the reserve until ${weekday(LATER_MS)}. Then spare10 continues any stopped work. Type a prompt to be asked again, or run /spare10 resume.`,
        )
        w.envGetDelayMs = {}
        await w.clock.advance(10 * TICK)
        expect(rec(w)).toEqual(want('S1', LATER_MS, at, 'seven_day,work,auto'))
        expect(count(transcript(w), stopTakenOver())).toBe(0)
      }
      expect(transcript(w).filter((t) => t.includes('The stop lasts until'))).toEqual([])
      expect(w.submitted).toEqual([])
    })
  }
}

test('/spare10 resume during the extension read: the extension is never written, so a call meanwhile gets a new question, not a refusal', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93, weekPct: 50, weekResetsAt: LATER })
  await begin($, w)
  await loopStop($, w)
  w.weekPct = 95
  await w.clock.set(DUE - 1)
  w.envGetDelayMs = { SPARE10_STOPPED: 1000 }
  await w.clock.advance(1) // the tick at the due time reads the stop
  await w.clock.advance(1500) // the extension's read is in flight
  const reply = $.command.run(cmd('resume'))
  await w.clock.advance(700) // the extension's read has returned, and the command's clear has not landed yet
  const call = bash($)
  for (let i = 0; i < 10; i += 1) await w.clock.advance(500)
  expect((await reply).text).toBe(RESUME_OVERDUE)
  expect(w.asked).toHaveLength(2) // the weekly window gates, and nothing is stopped: a new question
  expect(w.ran).toEqual([])
  w.envGetDelayMs = {}
  w.release('Resume')
  expect((await call).result).toBe('ran')
  expect(transcript(w).filter((t) => t.includes('The stop lasts until'))).toEqual([])
})

for (const who of ['stop', 'resume', 'prompt'] as const) {
  test(`${who === 'prompt' ? 'a person prompt' : `/spare10 ${who}`} that starts after the due tick's first read and before its release: no resume prompt, one takeover`, async ($, on) => {
    const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
    await begin($, w)
    await loopStop($, w)
    await w.clock.set(DUE - 1)
    w.envGetDelayMs = { SPARE10_STOPPED: 1000 }
    await w.clock.advance(1) // the tick at the due time passed its first check and reads the stop
    await w.clock.advance(500) // its read is still in flight: the person path starts now
    const p = who === 'prompt' ? $.prompt.submit(typed('what next')) : $.command.run(cmd(who))
    for (let i = 0; i < 10; i += 1) await w.clock.advance(500)
    const out = await p
    if (who === 'prompt') {
      expect(out).toMatchObject({ text: 'what next' })
      expect(w.prompts.map((e) => e.context)).toEqual([[resetNote()]])
    } else expect((out as { text?: string }).text).toBe(who === 'stop' ? STOP_OVERDUE : RESUME_OVERDUE)
    w.envGetDelayMs = {}
    await w.clock.advance(10 * TICK)
    expect(w.submitted).toEqual([])
    expect(w.env.has('SPARE10_STOPPED')).toBe(false)
    expect(count(transcript(w), stopTakenOver())).toBe(1)
    expect(count(transcript(w), resetResumes())).toBe(0)
  })
}

test('/clear during the release before the engine answers the new id (D3): no resume prompt, and the debug line', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  await w.clock.set(DUE - 1)
  w.envGetDelayMs = { SPARE10_STOPPED: 1000 }
  await w.clock.advance(1) // the tick at the due time reads the stop
  await w.clock.advance(1000) // and goes on to its release: its second read is in flight
  // /clear ends S1, and session.id still answers S1: w.sessionId stays (D3).
  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
  for (let i = 0; i < 10; i += 1) await w.clock.advance(500)
  await w.clock.advance(10 * TICK)
  expect(w.submitted).toEqual([])
  expect(count(debug(w), SKIPPED)).toBe(1)
  expect(count(transcript(w), resetResumes())).toBe(0)
})

test('markWork does not bring back a stop that another copy cleared while it reads (envGetDelayMs)', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93 })
  await begin($, w)
  expect((await $.command.run(cmd('stop'))).text).toBe(stopTripped(clock(RESETS_MS)))
  await w.clock.settle()
  w.envGetDelayMs = { SPARE10_STOPPED: 1000 }
  const refused = drain($, step(undefined, 'T1'))
  await w.clock.advance(1500) // the step is refused, and markWork's first read is in flight
  // Another copy (after a reload) takes a Resume: it writes the world's env, and this copy's epoch stays.
  w.env.delete('SPARE10_STOPPED')
  w.env.set('SPARE10_CONSENT', `S1 ${RESETS}`)
  for (let i = 0; i < 10; i += 1) await w.clock.advance(500)
  expect((await refused).text).toBe(PAUSED())
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  w.envGetDelayMs = {}
  expect((await bash($)).result).toBe('ran')
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([])
})

// ---- 4.2: the watch timer, 4.6.2: the typing defers ----

test('a refused tick in an idle stopped session: the watch timer re-arms the ticker, and the resume prompt still comes', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  w.afterRefusals = 1 // the next tick's timer never runs: that chain ends
  await w.clock.advance(10 * MIN) // no turn, no measure, no badge, no /spare10
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([resumePrompt()])
  expect(count(transcript(w), resetResumes())).toBe(1)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
})

test('a refused first tick: the watch timer that session.start arms re-arms the ticker, and a held question still continues', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 93, afterRefusals: 1 }) // the ticker's first timer never runs
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await pastDue(w, RESETS) // no measure, no badge, no /spare10: only the ticker wakes the waiter in the kit
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(count(transcript(w), resetContinues())).toBe(1)
})

test('a refused watch period: the ticker re-arms the watch, and a refused tick after that is still healed', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93, everyRefusals: 1 }) // the watch interval ends at its first period
  await begin($, w)
  await loopStop($, w)
  await w.clock.advance(20 * MIN) // the ticker sees the watch is dead and starts it again
  w.afterRefusals = 1 // now the tick chain ends too
  await w.clock.advance(20 * MIN)
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([resumePrompt()])
})

test('a stop that ended another way leaves no typing defers: the next stop gets all ten', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  const defers = (): string[] => debug(w).filter((t) => t.startsWith('spare10: the prompt box has text.'))
  await loopStop($, w)
  w.box = 'half typed'
  await w.clock.set(DUE + 3 * TICK) // four defers
  expect(defers()).toEqual([1, 2, 3, 4].map(boxDefer))
  w.box = ''
  expect(await $.prompt.submit(typed('half typed'))).toMatchObject({ text: 'half typed' }) // B35 takes the release over
  await w.clock.settle()
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(w.submitted).toEqual([])
  // A new window in the reserve, and a second Stop here.
  w.resetsAt = LATER
  const held = bash($)
  await w.clock.settle()
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(93, LATER_MS))
  await w.clock.settle()
  expect(rec(w)?.until).toBe(LATER_MS)
  w.box = 'new draft'
  await w.clock.set(LATER_MS + MARGIN + 9 * TICK) // ten ticks from the due time on
  expect(defers()).toEqual([1, 2, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(boxDefer))
  expect(w.submitted).toEqual([])
  await w.clock.advance(TICK)
  expect(w.submitted).toEqual([resumePrompt()])
})

test('a prompt box that holds only white space does not delay the resume prompt', async ($, on) => {
  const w = world(on, { floors: 'off', spans: 'off', pct: 93 })
  await begin($, w)
  await loopStop($, w)
  w.box = ' \n'
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([resumePrompt()])
  expect(debug(w).filter((t) => t.startsWith('spare10: the prompt box has text.'))).toEqual([])
})

// ---- 4.3: the redraw edges ----

test('a full edge list holds each time once: a later edge stays beside many copies of a nearer one', async ($, on) => {
  const w = world(on, { spans: 'off', pct: 50, weekPct: 50 })
  await begin($, w)
  for (let i = 0; i < 70; i += 1) {
    expect((await $.command.run(cmd('simulate 95 in 5m'))).text).toContain('test reading set to 95% used, resets') // the same end each time
  }
  expect((await $.command.run(cmd('simulate 95 weekly in 10m'))).text).toContain('test reading set to 95% used of the weekly window')
  await w.clock.set(T0 + 10 * MIN - 1)
  const before = w.invalidations
  await w.clock.set(T0 + 10 * MIN + TICK) // across the end of the weekly test window
  expect(w.invalidations).toBeGreaterThan(before)
})

for (const far of ['many copies of one far edge', 'many far edges'] as const) {
  test(`a full edge list keeps the nearest edge (${far}): the ticker redraws at a test window end`, async ($, on) => {
    const w = world(on, { spans: 'off', pct: 50, weekPct: 50 })
    await begin($, w)
    for (let i = 0; i < 70; i += 1) {
      const args = far === 'many far edges' ? `simulate 95 weekly in ${10 + i}m` : 'simulate 95 weekly' // the live weekly reset each time
      expect((await $.command.run(cmd(args))).text).toContain('test reading set to 95% used of the weekly window')
    }
    expect((await $.command.run(cmd('simulate 95 in 2m'))).text).toContain('test reading set to 95% used, resets')
    await w.clock.set(T0 + 2 * MIN - 1)
    const before = w.invalidations
    await w.clock.set(T0 + 2 * MIN + TICK) // across the end of the 5-hour test window
    expect(w.invalidations).toBeGreaterThan(before)
  })
}
