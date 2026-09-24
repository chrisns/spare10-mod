import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import {
  HOUR,
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
  step,
  stopRec,
  typed,
  world,
} from '../helpers/world.ts'
import type { World } from '../helpers/world.ts'

// The stop at the due time and what else ends it (design 0.2 B34, B35, B39, 4.2 to 4.8, 5.6, 5.7, and
// the second half of the 8.3 reset.test.ts table). Written from the spec: every expected text is built
// here from section 2, not from hooks/core/text.ts. autoResume is on unless a test says otherwise.

const RESETS_MS = Date.parse(RESETS)
const SOON_MS = Date.parse(SOON)
const WEEK_MS = Date.parse(WEEK_RESETS)
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
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93 })
  await begin($, w)
  await loopStop($, w)
  await w.clock.advance(MIN)
  w.answer = 'dismiss' // Esc on the prompt's dialog counts as Stop here (B5)
  expect(await $.prompt.submit(typed('carry on'))).toEqual({ drop: notStarted() })
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(), promptQuestion()])
  // The merge rule keeps the work of the earlier loop Stop (3.2): the later Stop gives the time.
  expect(rec(w)).toEqual(want('S1', RESETS_MS, T0 + MIN, 'five_hour,work,auto'))
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([resumePrompt()])
  expect(count(transcript(w), resetResumes())).toBe(1)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
})

test('Stop here on a prompt question of an idle session: the stop ends at the reset, nothing is sent, and the notice says to type', async ($, on) => {
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93 })
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
    const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93, resetsAt: SOON, weekPct: 50, weekResetsAt: RESETS })
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
  const w = world(on, { pct: 50 })
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
  const w = world(on, { pct: 50 })
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
  const w = world(on, { pct: 93, env: { ...AUTO_OFF, SPARE10_STOPPED: stopRec('S1', RESETS_MS, T0 - MIN, 'five_hour,work,auto') } })
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
  const w = world(on, { pct: 93 })
  await begin($, w)
  await loopStop($, w)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'S1', resume: { id: 'S1' } })
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([])
  expect(transcript(w).filter((t) => RESET_NOTICES.includes(t))).toEqual([])
})

// ---- B35: the person takes the release over ----

test('a person prompt after the reset and before the tick takes the release over with the reset note', async ($, on) => {
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93 })
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
    const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93, env: { SPARE10_STOPPED: stopRec('S1', RESETS_MS, T0 - MIN, 'five_hour,work') } })
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
  const w = world(on, { pct: 93, submitDrop: 'another plugin dropped it' })
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
  const w = world(on, { pct: 93, env: { SPARE10_STOPPED: legacy } })
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
  const w = world(on, { pct: 93, env: AUTO_OFF })
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
  const w = world(on, { pct: 93, env: AUTO_OFF })
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
  const w = world(on, { pct: 93, env: AUTO_OFF })
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
  const w = world(on, { pct: 50, env: { SPARE10_AUTO_RESUME: 'maybe' } })
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
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93, env: { SPARE10_STOPPED: stopRec('S1', RESETS_MS, T0 - MIN, 'five_hour,work,auto') } })
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
  const w = world(on, { pct: 93, env: { SPARE10_CONSENT: `S1 ${RESETS}` } })
  await begin($, w)
  await w.clock.set(RESETS_MS - 2 * MIN)
  const ui = await $.ui.mount({ plugin: 'spare10', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect((await ui.find({ type: 'Text', text: /spare10/ }))?.text).toBe(' ⨯ spare10')
  await w.clock.set(RESETS_MS + TICK)
  expect((await ui.find({ type: 'Text', text: /spare10/ }))?.text).not.toBe(' ⨯ spare10')
  await ui.unmount()
})

test('the stopped badge names the clock of the reset', async ($, on) => {
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 50, weekPct: 95 })
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
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93 })
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
  const w = world(on, { pct: 93, resetsAt: null })
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

test('a refused clock.after leaves no ticker: /spare10 warns, and the next measure re-arms it', async ($, on) => {
  const w = world(on, { pct: 50, afterRefusals: 1 }) // the ticker's first timer never runs
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
  const w = world(on, { pct: 93, envGetFails: ['SPARE10_STOPPED', 'SPARE10_CONSENT', 'SPARE10_WEEKLY_CONSENT'] })
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
