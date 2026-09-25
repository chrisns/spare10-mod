import { test, expect } from 'claude-code/testing'
import type { Engine, ElementQuery, FoundElement } from 'claude-code/testing'
import type { PromptOrigin } from 'claude-code'
import {
  HOUR,
  MARGIN,
  MIN,
  OFF_OPENS,
  OFF_TICK,
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
  drain,
  pastDue,
  pastOpen,
  step,
  stopRec,
  typed,
  world,
} from '../helpers/world.ts'
import type { World } from '../helpers/world.ts'

// Skip near the reset, independent kit tests for stops, the resume prompt at the skip start, consent,
// the commands (/spare10, resume, stop, simulate) and the badge rows in and out of the skip window.
// Written from the skip design (DESIGN-0.2-skip.md, B41 to B47, sections 2 to 4), not from the code:
// every expected text is spelled out here from section 2, and every record from 3.5. The world has the
// shipped spans (20 min, 8 h). autoResume is on unless a test sets SPARE10_AUTO_RESUME=off. Clocks are
// in the machine's zone, as the kit runs.

const SLOW = { timeoutMs: 30_000 }
const AUTO_OFF = { SPARE10_AUTO_RESUME: 'off' }

const R_MS = Date.parse(RESETS) // the 5-hour reset
const O_MS = Date.parse(OPENS) // its skip start: R minus 20 min
const WR_MS = Date.parse(WEEK_RESETS) // Mon 09:00 UTC
const WO_MS = Date.parse(WEEK_OPENS) // its skip start: WR minus 8 h
const WN_MS = Date.parse(WEEK_NEAR) // a weekly reset 9 h after T0
const WNO_MS = Date.parse(WEEK_NEAR_OPENS) // its skip start, 1 h after T0
const OT_MS = Date.parse(OFF_TICK) // a reset 15 s off the tick grid
const OO_MS = Date.parse(OFF_OPENS) // its skip start, 15 s off the tick grid

// {clock} (D0.2 2.1): HH:MM, and for the weekly window the en-GB short weekday first.
const hhmm = (ms: number): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
const wk = (ms: number): string => `${new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(ms)} ${hhmm(ms)}`
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

// {lead} (skip 2.1).
const LEAD = '20 min before the reset'
const WEEK_LEAD = '8 h before the weekly reset'
const testLead = (span = '20 min'): string => `${span} before the test window ends`

// {pf} and {mf} (D0.2 2.1). STOP and PAUSED keep the reset clock (skip 2.3).
const pf = (used: number, ms = R_MS): string => `${used}% used · ${100 - used}% left · resets ${hhmm(ms)}`
const pfW = (used: number, ms = WR_MS): string => `${used}% used · ${100 - used}% left · resets ${wk(ms)}`
const mf = (used: number, ms = R_MS): string => `into your 10% reserve · ${100 - used}% of quota left · resets ${hhmm(ms)}`
const mfW = (used: number, ms = WR_MS): string =>
  `into your 10% weekly reserve · ${100 - used}% of weekly quota left · resets ${wk(ms)}`

// The question (skip 2.2).
const loopAfter = (at: string): string =>
  ` If you choose Stop here or do not answer, the work waits until ${at}. Then spare10 continues it, unless a reserve is still reached.`
const loopQ = (used: number, ms = R_MS, after = ''): string =>
  `Your 10% reserve is reached: ${pf(used, ms)}. All work is on hold. Continue on the reserve until ${hhmm(ms)}?${after}`
const weekLoopQ = (used: number, ms = WR_MS, after = ''): string =>
  `Your 10% weekly reserve is reached: ${pfW(used, ms)}. All work is on hold. Continue on the weekly reserve until ${wk(ms)}?${after}`
const holdPromptQ = (used: number, ms: number, at: string): string =>
  `Your 10% reserve is reached: ${pf(used, ms)}. spare10 holds your prompt and any other work. Continue on the reserve until ${hhmm(ms)}? ` +
  `If you do not answer, all of it continues at ${at}, unless a reserve is still reached. Stop here gives your prompt back and pauses other work until ${at.split(',')[0]}.`

// Text the model reads (skip 2.3, D0.2 2.3).
const STOP = (m: string): string =>
  `spare10: the user stopped work at the quota reserve (${m}). Stop now and wait for the user. Do not call any further tools.`
const PAUSED = (m: string): string =>
  `spare10: work stopped at the quota reserve (${m}). No model request was sent, so this task is not finished. Wait for the user.`
const TAIL =
  'Continue the task from the point where it stopped. A subagent whose result says "spare10: work stopped" or "spare10: the user stopped work" did not finish. ' +
  'Run it again if you still need its result.'
const resumeOpen = (event: string): string =>
  `${capital(event)}, so the stop at the quota reserve is over. spare10 is set to continue the work when the reserve opens, so do not wait for the user. ${TAIL}`
const resumeReset = (reset: string): string =>
  `${capital(reset)}, so the stop at the quota reserve is over. spare10 is set to continue the work at the reset, so do not wait for the user. ${TAIL}`

// {event} (skip 2.1): {soon} of the open kinds, then who is open until then.
const ev5 = (ms = R_MS): string => `the 5-hour window resets at ${hhmm(ms)}. Your 10% reserve is open until then`
const evW = (ms: number): string => `the weekly window resets at ${wk(ms)}. Your 10% weekly reserve is open until then`
const evT = (ms: number): string => `the test window ends at ${hhmm(ms)}. Your 10% reserve is open until then`

// Transcript notices (skip 2.4, D0.2 2.4), without the engine's prefix.
const stoppedSkipWork = (rs: string, until: string): string =>
  `stopped at ${rs} until ${until}. Then spare10 continues the work, unless a reserve is still reached. Type a prompt to be asked again, or run /spare10 resume.`
const stoppedSkip = (rs: string, until: string): string =>
  `stopped at ${rs} until ${until}. Type a prompt to be asked again, or run /spare10 resume.`
const resetResumes = (event: string): string => `${event}. spare10 continues the stopped work.`
const resetStopOver = (event: string): string => `${event}, and the stop is over. Type a prompt to continue.`
const stoppedLateOpen = (event: string): string => `stopped. Held work is refused. ${capital(event)}, so new work goes on with no question.`
const resetWaitingForOpen = (event: string): string =>
  `${event}, but held work still waits for your answer. New work goes on with no question.`
const CONTINUING = `continuing on your 10% reserve. spare10 stays quiet until ${hhmm(R_MS)}.`
const RS5 = 'your 10% reserve'
const RSW = 'your 10% weekly reserve'

// Command replies (skip 2.8, D0.2 2.8).
const resumeOpenReply = (rs: string, quiet: string): string => `nothing to resume. The reset is near, so ${rs} is open ${quiet}.`
const stopOpenReply = (rs: string, quiet: string): string =>
  `nothing to stop. The reset is near, so ${rs} is open ${quiet}. To keep a reserve until the reset, set its Open reserve option to 0 in /config.`
const stopTrippedAuto = (until: string): string =>
  `stopped at the reserve until ${until}. Then spare10 continues any stopped work. Type a prompt to be asked again, or run /spare10 resume.`
const stopTrippedOff = (until: string): string =>
  `stopped at the reserve until ${until}. Type a prompt to be asked again, or run /spare10 resume.`
const stopAskingSkip = (until: string): string => `stopped. Held work is refused. spare10 continues it at ${until}.`
const stopAskingSoon = (event: string): string =>
  `stopped. Held work is refused. ${capital(event)}, so spare10 continues it soon, unless a reserve is still reached.`
const alreadyStopped = (at: string): string => `already stopped until ${at}.`
const RESUMED_STOPPED = `resumed. You can use the reserve until ${hhmm(R_MS)}. Type a prompt to continue.`
const ALREADY_RESUMED = `already resumed until ${hhmm(R_MS)}.`
const simSet = (what: string, at: string, extra = ''): string =>
  `test reading set to ${what}, resets ${at}. It can only raise the real reading.${extra} Run /spare10 simulate off to clear it.`

// The /spare10 report (skip 2.7, D0.2 2.7): rows and phase lines as drawn, labels padded to 15.
const ROW_OPENS = (v: string): string => `  · reserve opens  ${v}`
const ROW_WEEK_OPENS = (v: string): string => `  · weekly opens   ${v}`
const phaseOpen = (rs: string, isAre: string, quiet: string): string =>
  `  ↻ open           the reset is near. ${capital(rs)} ${isAre} open ${quiet}, so spare10 lets all work through.`
const phaseStoppedWork = (at: string): string =>
  `  ■ stopped        you chose Stop here. spare10 continues the work at ${at}. Type a prompt to be asked again, or run /spare10 resume.`
const phaseStoppedWorkD02 = (at: string): string =>
  `  ■ stopped        you chose Stop here. spare10 continues the work after ${at}. Type a prompt to be asked again, or run /spare10 resume.`
const phaseStoppedIdle = (at: string): string =>
  `  ■ stopped        you chose Stop here, until ${at}. Type a prompt to be asked again, or run /spare10 resume.`
const phaseAsking = (at: string): string =>
  `  ? asking         a question is open. Held work waits until you answer, or until ${at}. If no dialog shows, run /spare10 resume or /spare10 stop.`
const PHASE_ASKING_OFF =
  '  ? asking         a question is open. Held work waits until you answer. If no dialog shows, run /spare10 resume or /spare10 stop.'
const phaseAskingOffOpen = (rs: string, quiet: string): string =>
  `  ? asking         a question is open. Held work waits until you answer. ${capital(rs)} is open ${quiet}, so new work goes on. If no dialog shows, run /spare10 resume or /spare10 stop.`
const PHASE_CONSENTED = `  ⨯ consented      you chose to continue. spare10 is quiet until ${hhmm(R_MS)}.`
const PHASE_TRIPPED_HOLD = '  ⚠ tripped        spare10 holds the next step and asks you.'

type Logs = Pick<World, 'logs'>
const transcript = (w: Logs): string[] => w.logs.filter((l) => l.to !== 'debug').map((l) => l.text)
const count = (list: string[], text: string): number => list.filter((t) => t === text).length
const questions = (w: World): string[] => w.asked.map((a) => a.question)

async function run($: Engine, args: string, kind: PromptOrigin['kind'] = 'composer'): Promise<string | undefined> {
  return (await $.command.run(cmd(args, kind))).text
}

async function report($: Engine): Promise<string[]> {
  return ((await run($, '')) ?? '').split('\n')
}
const phaseLine = (lines: string[]): string | undefined => lines[2]
const row = (lines: string[], label: string): string | undefined => lines.find((l) => l.startsWith(`  · ${label} `))

type Ui = { find: (q: ElementQuery) => Promise<FoundElement | undefined> }
type Shown = { text: string | undefined; color: unknown }

function mountBadge($: Engine) {
  return $.ui.mount({ plugin: 'spare10', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
}

/** The badge as drawn: the text of the Box keyed spare10 (with its leading space) and its Text's colour. */
async function drawn(ui: Ui): Promise<Shown> {
  const box = await ui.find({ key: 'spare10' })
  const inner = (box?.children ?? []).find((c): c is { type: string; props?: Record<string, unknown> } =>
    typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'Text')
  return { text: box?.text, color: inner?.props?.color }
}

/** Mounts the badge, reads it and unmounts it again, so no pulse runs across a clock move. */
async function badgeOf($: Engine): Promise<Shown> {
  const ui = await mountBadge($)
  const shown = await drawn(ui)
  await ui.unmount()
  return shown
}
const warn = (text: string): Shown => ({ text, color: 'warning' })

/** A held main Bash call answered Stop here at once: returns the deny text. */
async function loopStop($: Engine, w: World): Promise<string | undefined> {
  const held = bash($)
  await w.clock.settle()
  w.release('Stop here')
  const r = await held
  await w.clock.settle()
  return r.deny
}

// ---- Stops with autoResume on: the skip start is the stop's end (B42, 3.5, 4.2) ----

test('Stop here on a held loop: the stop lasts until the skip start with its lead, and that tick sends one resume prompt with the open wording', SLOW, async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ(93, R_MS, loopAfter(`${hhmm(O_MS)}, ${LEAD}`))])
  // asking, autoResume on: the badge and the report name the skip start (2.6, 2.7)
  expect(await badgeOf($)).toEqual(warn(` ? spare10: waiting for you until ${hhmm(O_MS)}`))
  expect(phaseLine(await report($))).toBe(phaseAsking(hhmm(O_MS)))
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(mf(93)))
  await w.clock.settle()
  // 3.5: the until is the skip start, the tags in the order kinds, work, auto, test, skip
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', O_MS, T0, 'five_hour,work,auto,skip'))
  expect(count(transcript(w), stoppedSkipWork(RS5, `${hhmm(O_MS)}, ${LEAD}`))).toBe(1)
  expect(await badgeOf($)).toEqual(warn(` ■ spare10: stopped until ${hhmm(O_MS)}`))
  expect(phaseLine(await report($))).toBe(phaseStoppedWork(hhmm(O_MS)))
  expect(await run($, 'stop')).toBe(alreadyStopped(hhmm(O_MS)))
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', O_MS, T0, 'five_hour,work,auto,skip'))
  await w.clock.set(O_MS - 1)
  expect(w.submitted).toEqual([])
  expect((await bash($)).deny).toBe(STOP(mf(93))) // the stop still holds before the skip start
  await w.clock.set(O_MS) // the tick at the skip start: no margin (B42)
  expect(w.submitted).toEqual([resumeOpen(ev5())])
  expect(count(transcript(w), resetResumes(ev5()))).toBe(1)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(w.env.has('SPARE10_CONSENT')).toBe(false) // no consent at a skip start (3.4)
  expect(await badgeOf($)).toEqual(warn(` ↻ spare10: reserve open until ${hhmm(R_MS)}`))
  expect((await bash($)).result).toBe('ran')
  await pastDue(w, RESETS)
  expect(w.submitted).toHaveLength(1) // one resume prompt in all
  expect(w.asked).toHaveLength(1)
})

test('Stop here on a prompt question: a stop with no work until the skip start, and there it ends with the open notice and nothing sent', SLOW, async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(questions(w)).toEqual([holdPromptQ(93, R_MS, `${hhmm(O_MS)}, ${LEAD}`)])
  w.release('Stop here')
  expect((await p).drop).toBeDefined()
  await w.clock.advance(1000)
  expect(w.fills).toEqual(['hello'])
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', O_MS, T0, 'five_hour,auto,skip'))
  expect(count(transcript(w), stoppedSkip(RS5, `${hhmm(O_MS)}, ${LEAD}`))).toBe(1)
  expect(phaseLine(await report($))).toBe(phaseStoppedIdle(hhmm(O_MS)))
  expect(await badgeOf($)).toEqual(warn(` ■ spare10: stopped until ${hhmm(O_MS)}`))
  await w.clock.set(O_MS - 1)
  expect(count(transcript(w), resetStopOver(ev5()))).toBe(0)
  await pastOpen(w)
  expect(w.submitted).toEqual([])
  expect(w.prompts).toEqual([])
  expect(count(transcript(w), resetStopOver(ev5()))).toBe(1)
  expect(count(transcript(w), resetResumes(ev5()))).toBe(0)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(await $.prompt.submit(typed('again'))).toMatchObject({ text: 'again' })
  expect(w.prompts.map((e) => e.context)).toEqual([undefined]) // released already: no takeover note
  expect(w.asked).toHaveLength(1)
})

test('/spare10 stop while tripped stops until the skip start, a refused step adds work, and the skip start sends the open resume prompt', SLOW, async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  expect(await run($, 'stop')).toBe(stopTrippedAuto(`${hhmm(O_MS)}, ${LEAD}`))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', O_MS, T0, 'five_hour,auto,skip'))
  expect(phaseLine(await report($))).toBe(phaseStoppedIdle(hhmm(O_MS)))
  const refused = await drain($, step(undefined, 'T1'))
  expect(refused.text).toBe(PAUSED(mf(93)))
  await w.clock.settle()
  expect(w.requests).toBe(0)
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', O_MS, T0, 'five_hour,work,auto,skip'))
  expect(phaseLine(await report($))).toBe(phaseStoppedWork(hhmm(O_MS)))
  await w.clock.set(O_MS)
  expect(w.submitted).toEqual([resumeOpen(ev5())])
  expect(count(transcript(w), resetResumes(ev5()))).toBe(1)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
})

test('/spare10 stop on the open loop question before the skip start names it with the lead, and the skip start continues the work', SLOW, async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(await run($, 'stop')).toBe(stopAskingSkip(`${hhmm(O_MS)}, ${LEAD}`))
  expect((await held).deny).toBe(STOP(mf(93)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', O_MS, T0, 'five_hour,work,auto,skip'))
  await pastOpen(w)
  expect(w.submitted).toEqual([resumeOpen(ev5())])
  expect(count(transcript(w), resetResumes(ev5()))).toBe(1)
})

test('a weekly Stop here lasts until the weekly skip start, and that tick sends the resume prompt with the weekly open wording', SLOW, async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 92, weekResetsAt: WEEK_NEAR })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([weekLoopQ(92, WN_MS, loopAfter(`${wk(WNO_MS)}, ${WEEK_LEAD}`))])
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(mfW(92, WN_MS)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', WNO_MS, T0, 'seven_day,work,auto,skip'))
  expect(count(transcript(w), stoppedSkipWork(RSW, `${wk(WNO_MS)}, ${WEEK_LEAD}`))).toBe(1)
  expect(await badgeOf($)).toEqual(warn(` ■ spare10: stopped until ${wk(WNO_MS)}`))
  await w.clock.set(WNO_MS - 1)
  expect(w.submitted).toEqual([])
  await w.clock.set(WNO_MS)
  expect(w.submitted).toEqual([resumeOpen(evW(WN_MS))])
  expect(count(transcript(w), resetResumes(evW(WN_MS)))).toBe(1)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(await badgeOf($)).toEqual(warn(` ↻ spare10: reserve open until ${wk(WN_MS)}`))
  expect((await bash($)).result).toBe('ran')
})

test('/spare10 stop on a weekly question inside the 5-hour skip window stops the weekly window until its skip start, and the 5-hour reset releases nothing', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 92 })
  await begin($, w)
  const at = O_MS + 5 * MIN
  await w.clock.set(at)
  const held = bash($)
  await w.clock.settle()
  // Each window has its own skip window: the weekly trip still gates (B41).
  expect(questions(w)).toEqual([weekLoopQ(92, WR_MS, loopAfter(`${wk(WO_MS)}, ${WEEK_LEAD}`))])
  expect(await run($, 'stop')).toBe(stopAskingSkip(`${wk(WO_MS)}, ${WEEK_LEAD}`))
  expect((await held).deny).toBe(STOP(mfW(92)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', WO_MS, at, 'seven_day,work,auto,skip'))
  expect(await badgeOf($)).toEqual(warn(` ■ spare10: stopped until ${wk(WO_MS)}`))
  expect(phaseLine(await report($))).toBe(phaseStoppedWork(wk(WO_MS)))
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([])
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', WO_MS, at, 'seven_day,work,auto,skip'))
  expect((await bash($)).deny).toBe(STOP(mfW(92)))
  expect(w.asked).toHaveLength(1)
})

test('a stop whose owner is not a skip start keeps the D0.2 margin, and its release names the reset window and the open one', SLOW, async ($, on) => {
  // The weekly window has no span and resets 2 min before the 5-hour skip start: its due (reset plus
  // 5 min) lies after the 5-hour skip start, so the question and the stop are no skip owner (B42).
  const W38 = Date.parse('2026-09-24T14:38:00.000Z')
  const w = world(on, {
    pct: 93,
    weekPct: 92,
    weekResetsAt: new Date(W38).toISOString(),
    env: { SPARE10_WEEKLY_LAST_HOURS: '0' },
  })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([
    `Your 10% reserve and your 10% weekly reserve are reached: 5-hour window ${pf(93)}, weekly window ${pfW(92, W38)}. All work is on hold. ` +
      `Continue on both reserves until they reset (${hhmm(R_MS)} and ${wk(W38)})?` +
      loopAfter(wk(O_MS)),
  ])
  // asking: the badge shows the question's hold end, without the margin (2.6)
  expect(await badgeOf($)).toEqual(warn(` ? spare10: waiting for you until ${wk(O_MS)}`))
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(`${mf(93)}, and ${mfW(92, W38)}`))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', O_MS, T0, 'five_hour,seven_day,work,auto')) // no skip tag
  expect(count(transcript(w), stoppedSkipWork(`${RS5} and ${RSW}`, wk(O_MS)))).toBe(1)
  expect(await badgeOf($)).toEqual(warn(` ■ spare10: stopped until ${wk(O_MS)}`))
  expect(phaseLine(await report($))).toBe(phaseStoppedWorkD02(wk(O_MS)))
  await w.clock.set(O_MS + MIN)
  expect((await bash($)).result).toBe('ran') // the stop is over by time, the 5-hour window is open
  await w.clock.set(O_MS + MARGIN - 1)
  expect(w.submitted).toEqual([]) // the margin stands
  await w.clock.set(O_MS + MARGIN)
  const event = `the weekly window reset. ${capital(ev5())}`
  expect(w.submitted).toEqual([resumeOpen(event)])
  expect(count(transcript(w), resetResumes(event))).toBe(1)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
})

test('merge: a skip Stop on a prompt question over a stop whose due is later drops the skip tag, so the margin stands', SLOW, async ($, on) => {
  const W38 = Date.parse('2026-09-24T14:38:00.000Z')
  const w = world(on, {
    pct: 93,
    weekPct: 92,
    weekResetsAt: new Date(W38).toISOString(),
    env: { SPARE10_WEEKLY_LAST_HOURS: '0' },
  })
  await begin($, w)
  expect(await loopStop($, w)).toBe(STOP(`${mf(93)}, and ${mfW(92, W38)}`))
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', O_MS, T0, 'five_hour,seven_day,work,auto'))
  const at = O_MS - MIN // the weekly window reset at 14:38, the stop still applies
  await w.clock.set(at)
  const p = $.prompt.submit(typed('carry on'))
  await w.clock.settle()
  expect(questions(w).at(-1)).toBe(holdPromptQ(93, R_MS, `${hhmm(O_MS)}, ${LEAD}`)) // a skip owner on its own
  w.release('Stop here')
  expect((await p).drop).toBeDefined()
  await w.clock.settle()
  // 3.5 mergeStopped: a tie on until gives the new record, but its skip tag needs the earlier due to
  // lie at or before its end, and the earlier due is 5 min later.
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', O_MS, at, 'five_hour,seven_day,work,auto'))
  await w.clock.set(O_MS + MARGIN - 1)
  expect(w.submitted).toEqual([])
  await w.clock.set(O_MS + MARGIN)
  const event = `the weekly window reset. ${capital(ev5())}`
  expect(w.submitted).toEqual([resumeOpen(event)])
  expect(count(transcript(w), resetResumes(event))).toBe(1)
})

test('merge: /spare10 stop, then a Stop on a prompt question: both end at the skip start, so the merged stop keeps the skip tag', SLOW, async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  expect(await run($, 'stop')).toBe(stopTrippedAuto(`${hhmm(O_MS)}, ${LEAD}`))
  await w.clock.settle()
  await w.clock.set(T0 + MIN)
  const p = $.prompt.submit(typed('carry on'))
  await w.clock.settle()
  expect(questions(w)).toEqual([holdPromptQ(93, R_MS, `${hhmm(O_MS)}, ${LEAD}`)])
  w.release('Stop here')
  expect((await p).drop).toBeDefined()
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', O_MS, T0 + MIN, 'five_hour,auto,skip'))
  expect(await badgeOf($)).toEqual(warn(` ■ spare10: stopped until ${hhmm(O_MS)}`))
  await w.clock.set(O_MS - 1)
  expect(count(transcript(w), resetStopOver(ev5()))).toBe(0)
  await w.clock.set(O_MS)
  expect(count(transcript(w), resetStopOver(ev5()))).toBe(1)
  expect(w.submitted).toEqual([])
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
})

test('a test window over a real trip: the test stop is extended to the real skip start with the empty-event notice, and continues there', SLOW, async ($, on) => {
  const w = world(on, { pct: 92 })
  await begin($, w)
  const end = T0 + 22 * MIN
  const start = T0 + 2 * MIN
  expect(await run($, 'simulate 95 in 22m')).toBe(
    simSet('95% used', hhmm(end), ' The real reading is also in the reserve, so the test window does not open it.'),
  )
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ(95, end, loopAfter(`${hhmm(start)}, ${testLead()}`))])
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(mf(95, end)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', start, T0, 'five_hour,work,auto,test,skip'))
  await w.clock.set(start)
  // B45: the real trip beneath is not open, so the kind is sensed on the real basis and gates.
  expect(w.submitted).toEqual([])
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', O_MS, T0, 'five_hour,work,auto,skip'))
  expect(count(transcript(w), `your 10% reserve is reached. The stop lasts until ${hhmm(O_MS)}, ${LEAD}.`)).toBe(1)
  expect((await bash($)).deny).toBe(STOP(mf(92)))
  await w.clock.set(O_MS - 1)
  expect(w.submitted).toEqual([])
  await w.clock.set(O_MS)
  expect(w.submitted).toEqual([resumeOpen(ev5())])
  expect(count(transcript(w), resetResumes(ev5()))).toBe(1)
  expect(w.asked).toHaveLength(1)
})

const TEST_SPANS: Array<{ name: string; env: Record<string, string>; span: string; startMs: number }> = [
  { name: 'the default span', env: {}, span: '20 min', startMs: T0 + 2 * MIN },
  { name: 'SPARE10_LAST_MINUTES=2.5', env: { SPARE10_LAST_MINUTES: '2.5' }, span: '2.5 min', startMs: T0 + 19.5 * MIN },
]
for (const c of TEST_SPANS) {
  test(`Stop here on a test window in 22m (${c.name}): the stop keeps the test tag with the skip tag, and the open resume prompt names the test window`, SLOW, async ($, on) => {
    const w = world(on, { pct: 50, env: c.env })
    await begin($, w)
    const end = T0 + 22 * MIN
    const lead = testLead(c.span)
    expect(await run($, 'simulate 95 in 22m')).toBe(simSet('95% used', hhmm(end), ` The reserve opens at ${hhmm(c.startMs)}, ${lead}.`))
    const held = bash($)
    await w.clock.settle()
    expect(questions(w)).toEqual([loopQ(95, end, loopAfter(`${hhmm(c.startMs)}, ${lead}`))])
    expect(await badgeOf($)).toEqual(warn(` ? spare10 (test): waiting for you until ${hhmm(c.startMs)}`))
    expect(phaseLine(await report($))).toBe(phaseAsking(hhmm(c.startMs)))
    w.release('Stop here')
    expect((await held).deny).toBe(STOP(mf(95, end)))
    await w.clock.settle()
    expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', c.startMs, T0, 'five_hour,work,auto,test,skip'))
    expect(count(transcript(w), stoppedSkipWork(RS5, `${hhmm(c.startMs)}, ${lead}`))).toBe(1)
    expect(await badgeOf($)).toEqual(warn(` ■ spare10 (test): stopped until ${hhmm(c.startMs)}`))
    await w.clock.set(c.startMs - 1)
    expect(w.submitted).toEqual([])
    await w.clock.set(c.startMs) // a test skip start has no margin either (B45)
    expect(w.submitted).toEqual([resumeOpen(evT(end))])
    expect(count(transcript(w), resetResumes(evT(end)))).toBe(1)
    expect(await badgeOf($)).toEqual(warn(` ↻ spare10 (test): reserve open until ${hhmm(end)}`))
    expect((await bash($)).result).toBe('ran')
  })
}

// ---- B46: a Stop after the skip start ----

test('/spare10 stop on the question after its skip start and before the check (autoResume on): the soon reply, no past time, one resume prompt at the next tick', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: OFF_TICK })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ(93, OT_MS, loopAfter(`${hhmm(OO_MS)}, ${LEAD}`))])
  const at = OO_MS + 5000
  await w.clock.set(at) // past the skip start, before the tick that would continue the question
  expect(w.dialogAborted).toBe('no')
  expect(await run($, 'stop')).toBe(stopAskingSoon(ev5(OT_MS)))
  expect((await held).deny).toBe(STOP(mf(93, OT_MS)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OO_MS, at, 'five_hour,work,auto,skip'))
  expect(w.submitted).toEqual([])
  await w.clock.advance(TICK)
  expect(w.submitted).toEqual([resumeOpen(ev5(OT_MS))])
  expect(count(transcript(w), resetResumes(ev5(OT_MS)))).toBe(1)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  await w.clock.advance(4 * TICK)
  expect(w.submitted).toHaveLength(1)
  expect(w.asked).toHaveLength(1)
})

test('Stop here on a prompt question after its skip start (autoResume on, no work): nothing is written, the open late notice, and new work goes on', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: OFF_TICK })
  await begin($, w)
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(questions(w)).toEqual([holdPromptQ(93, OT_MS, `${hhmm(OO_MS)}, ${LEAD}`)])
  await w.clock.set(OO_MS + 5000)
  w.release('Stop here')
  expect((await p).drop).toBeDefined()
  await w.clock.advance(1000)
  expect(w.fills).toEqual(['hello'])
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(count(transcript(w), stoppedLateOpen(ev5(OT_MS)))).toBe(1)
  expect((await bash($)).result).toBe('ran')
  await w.clock.advance(4 * TICK)
  expect(w.submitted).toEqual([])
  expect(count(transcript(w), resetStopOver(ev5(OT_MS)))).toBe(0)
  expect(w.asked).toHaveLength(1)
})

test('Stop here after the skip start while the weekly window gates: the weekly kind is stopped as usual until its own skip start (B46)', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: OFF_TICK, weekPct: 50 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ(93, OT_MS, loopAfter(`${hhmm(OO_MS)}, ${LEAD}`))])
  await w.clock.set(T0 + MIN)
  w.weekPct = 92 // the weekly window reaches its reserve while the question is open
  const at = OO_MS + 5000
  await w.clock.set(at)
  expect(w.dialogAborted).toBe('no')
  w.release('Stop here')
  expect((await held).deny).toContain('spare10: the user stopped work at the quota reserve (')
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toMatch(new RegExp(`^S1 ${WO_MS} ${at} (five_hour,)?seven_day,work,auto,skip$`))
  expect(transcript(w).some((t) => t.startsWith('stopped at ') && t.includes(` until ${wk(WO_MS)}, ${WEEK_LEAD}. Then spare10 continues the work`))).toBe(true)
  await w.clock.advance(4 * TICK)
  expect(w.submitted).toEqual([])
  expect((await bash($)).deny).toBe(STOP(mfW(92)))
  expect(w.asked).toHaveLength(1)
})

test('a person prompt after a no-work skip stop ends and before the tick takes it over: the open notice, no note, and nothing is sent', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: OFF_TICK })
  await begin($, w)
  expect(await run($, 'stop')).toBe(stopTrippedAuto(`${hhmm(OO_MS)}, ${LEAD}`))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OO_MS, T0, 'five_hour,auto,skip'))
  await w.clock.set(OO_MS + 5000)
  expect(await $.prompt.submit(typed('what next'))).toMatchObject({ text: 'what next' })
  expect(w.prompts.map((e) => e.context)).toEqual([undefined])
  await w.clock.settle()
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(count(transcript(w), `${ev5(OT_MS)}, and the stop is over.`)).toBe(1)
  await w.clock.advance(4 * TICK)
  expect(w.submitted).toEqual([])
  expect(count(transcript(w), resetStopOver(ev5(OT_MS)))).toBe(0)
  expect(w.asked).toEqual([])
})

test('an auto skip stop with autoResume now off still shows its end, ends by time at the skip start, and sends nothing', SLOW, async ($, on) => {
  const value = stopRec('S1', O_MS, T0 - MIN, 'five_hour,work,auto,skip')
  const w = world(on, { pct: 93, env: { ...AUTO_OFF, SPARE10_STOPPED: value } })
  await begin($, w)
  expect(await badgeOf($)).toEqual(warn(` ■ spare10: stopped until ${hhmm(O_MS)}`)) // the skip tag shows the time in either mode
  expect(phaseLine(await report($))).toBe(phaseStoppedIdle(hhmm(O_MS)))
  expect(await run($, 'stop')).toBe(alreadyStopped(hhmm(O_MS)))
  expect((await bash($)).deny).toBe(STOP(mf(93)))
  const before = transcript(w).length
  await pastOpen(w)
  await w.clock.advance(4 * TICK)
  expect(w.submitted).toEqual([])
  expect(transcript(w)).toHaveLength(before)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
})

for (const verb of ['stop', 'resume'] as const) {
  test(`/spare10 ${verb} after a skip stop's end with no reading: the takeover says the stop is over with no event, and nothing is sent`, SLOW, async ($, on) => {
    const w = world(on, { pct: 93, resetsAt: OFF_TICK })
    await begin($, w)
    expect(await loopStop($, w)).toBe(STOP(mf(93, OT_MS)))
    expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OO_MS, T0, 'five_hour,work,auto,skip'))
    await w.clock.set(OO_MS + 5000) // overdue, before the tick that would release it
    expect(w.submitted).toEqual([])
    w.usageFails = true // the command's sense fails (4.6)
    expect(await run($, verb)).toBe(
      verb === 'stop' ? 'the stop is over. spare10 will not continue the stopped work.' : 'the stop is over. Type a prompt to continue.',
    )
    await w.clock.settle()
    expect(w.env.has('SPARE10_STOPPED')).toBe(false)
    expect(count(transcript(w), 'the stop is over.')).toBe(1) // stopTakenOver, empty event (2.4)
    w.usageFails = false
    await w.clock.advance(4 * TICK)
    expect(w.submitted).toEqual([])
    expect(count(transcript(w), resetResumes(ev5(OT_MS)))).toBe(0)
    expect((await bash($)).result).toBe('ran')
  })
}

// ---- Stops with autoResume off: the stop end (B43) ----

test('autoResume off: Stop here on a held loop stops until the skip start without auto, and the next prompt after it goes in with no question and no note', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, env: AUTO_OFF })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ(93)]) // no {after} with autoResume off
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(mf(93)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', O_MS, T0, 'five_hour,work,skip'))
  expect(count(transcript(w), stoppedSkip(RS5, `${hhmm(O_MS)}, ${LEAD}`))).toBe(1)
  // 1.3 item 6: a stop whose until is a skip start shows its end in both modes.
  expect(await badgeOf($)).toEqual(warn(` ■ spare10: stopped until ${hhmm(O_MS)}`))
  expect(phaseLine(await report($))).toBe(phaseStoppedIdle(hhmm(O_MS)))
  expect(await run($, 'stop')).toBe(alreadyStopped(hhmm(O_MS)))
  await w.clock.set(O_MS - 1)
  expect((await bash($)).deny).toBe(STOP(mf(93)))
  const before = transcript(w).length
  await w.clock.set(O_MS + MIN)
  expect(transcript(w)).toHaveLength(before) // nothing is logged at the stop end
  expect(w.submitted).toEqual([])
  expect(await $.prompt.submit(typed('go on'))).toMatchObject({ text: 'go on' })
  expect(w.prompts.map((e) => e.context)).toEqual([undefined])
  expect(w.asked).toHaveLength(1)
  expect(transcript(w)).toHaveLength(before)
  expect(await badgeOf($)).toEqual(warn(` ↻ spare10: reserve open until ${hhmm(R_MS)}`))
})

test('autoResume off: /spare10 stop while tripped stops until the skip start, and the ticker redraws the badge from stopped to open there', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, env: AUTO_OFF })
  await begin($, w)
  expect(await run($, 'stop')).toBe(stopTrippedOff(`${hhmm(O_MS)}, ${LEAD}`))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', O_MS, T0, 'five_hour,skip'))
  expect(await run($, 'stop')).toBe(alreadyStopped(hhmm(O_MS)))
  await w.clock.set(O_MS - TICK)
  const ui = await mountBadge($)
  expect(await drawn(ui)).toEqual(warn(` ■ spare10: stopped until ${hhmm(O_MS)}`))
  const invalidations = w.invalidations
  await w.clock.advance(2 * TICK) // the stop end is an edge (4.1)
  expect(w.invalidations).toBeGreaterThan(invalidations)
  expect(await drawn(ui)).toEqual(warn(` ↻ spare10: reserve open until ${hhmm(R_MS)}`))
  await ui.unmount()
  expect(w.submitted).toEqual([])
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
})

test('autoResume off: /spare10 stop inside the 5-hour skip window with the weekly window in the reserve stops until the weekly skip start', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 92, env: AUTO_OFF })
  await begin($, w)
  const at = O_MS + 5 * MIN
  await w.clock.set(at)
  expect(await run($, 'stop')).toBe(stopTrippedOff(`${wk(WO_MS)}, ${WEEK_LEAD}`))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', WO_MS, at, 'seven_day,skip'))
  expect(await badgeOf($)).toEqual(warn(` ■ spare10: stopped until ${wk(WO_MS)}`))
  expect((await bash($)).deny).toBe(STOP(mfW(92)))
  expect(w.asked).toEqual([])
})

// ---- B44: a stop never holds an open kind ----

test('a stop until the reset holds nothing while every tripped kind is open, and holds again when the weekly window gates', SLOW, async ($, on) => {
  const value = stopRec('S1', R_MS, T0 - MIN, 'five_hour,work')
  const w = world(on, { pct: 93, env: { SPARE10_STOPPED: value } })
  await begin($, w)
  expect((await bash($)).deny).toBe(STOP(mf(93))) // the 5-hour kind gates: the stop applies
  await w.clock.set(O_MS + MIN)
  expect((await bash($)).result).toBe('ran')
  await drain($, step(undefined, 'T1'))
  expect(w.requests).toBe(1)
  expect(await badgeOf($)).toEqual(warn(` ↻ spare10: reserve open until ${hhmm(R_MS)}`)) // open before stopped
  expect(phaseLine(await report($))).toBe(phaseOpen(RS5, 'is', `until ${hhmm(R_MS)}`))
  expect(await $.prompt.submit(typed('hi'))).toMatchObject({ text: 'hi' })
  expect(w.env.get('SPARE10_STOPPED')).toBe(value)
  w.weekPct = 92 // another kind gates: the stop is not per kind, so it holds everything again
  const refused = await bash($)
  expect(refused.deny).toContain('spare10: the user stopped work at the quota reserve (')
  expect(refused.deny).toContain('into your 10% weekly reserve')
  expect(w.asked).toEqual([])
})

test('an auto stop until the reset: nothing held in the skip window, and the D0.2 release after the reset (R-S13)', SLOW, async ($, on) => {
  const value = stopRec('S1', R_MS, T0 - MIN, 'five_hour,work,auto')
  const w = world(on, { pct: 93, env: { SPARE10_STOPPED: value } })
  await begin($, w)
  expect((await bash($)).deny).toBe(STOP(mf(93)))
  await w.clock.set(O_MS + MIN)
  expect((await bash($)).result).toBe('ran')
  expect(await $.prompt.submit(typed('hi'))).toMatchObject({ text: 'hi' })
  expect(w.prompts.map((e) => e.context)).toEqual([undefined]) // not overdue: no takeover
  expect(w.env.get('SPARE10_STOPPED')).toBe(value)
  await w.clock.set(R_MS + MARGIN - 1)
  expect(w.submitted).toEqual([])
  await pastDue(w, RESETS)
  expect(w.submitted).toEqual([resumeReset('the 5-hour window reset')])
  expect(count(transcript(w), resetResumes('the 5-hour window reset'))).toBe(1)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
})

test('/spare10 stop and resume inside the skip window: nothing to do, nothing written, and work runs with no question', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  await w.clock.set(O_MS + MIN)
  w.pct = 93 // a crossing inside the skip window
  expect(await run($, 'resume')).toBe(resumeOpenReply(RS5, `until ${hhmm(R_MS)}`))
  expect(await run($, 'stop')).toBe(stopOpenReply(RS5, `until ${hhmm(R_MS)}`))
  await w.clock.settle()
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect((await bash($)).result).toBe('ran')
  await drain($, step(undefined, 'T1'))
  expect(w.requests).toBe(1)
  expect(w.asked).toEqual([])
  expect(phaseLine(await report($))).toBe(phaseOpen(RS5, 'is', `until ${hhmm(R_MS)}`))
})

// ---- Consent (3.4) ----

test('a Resume before the skip start consents until the reset: the skip start changes nothing, and /spare10 stop inside the window keeps the consent', SLOW, async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(count(transcript(w), CONTINUING)).toBe(1)
  const before = transcript(w).length
  await pastOpen(w)
  expect(transcript(w)).toHaveLength(before) // no notice at the skip start
  expect(w.submitted).toEqual([])
  expect(await badgeOf($)).toEqual(warn(' ⨯ spare10')) // every tripped kind consented: still consented
  expect(phaseLine(await report($))).toBe(PHASE_CONSENTED)
  expect(await run($, 'resume')).toBe(ALREADY_RESUMED)
  expect(await run($, 'stop')).toBe(stopOpenReply(RS5, `until ${hhmm(R_MS)}`))
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`) // B44: clears no consent
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect((await bash($)).result).toBe('ran')
})

test('/spare10 resume on a skip stop before the skip start consents until the reset, and the skip start sends nothing', SLOW, async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  expect(await loopStop($, w)).toBe(STOP(mf(93)))
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', O_MS, T0, 'five_hour,work,auto,skip'))
  await w.clock.set(O_MS - 10 * MIN)
  expect(await run($, 'resume')).toBe(RESUMED_STOPPED)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect((await bash($)).result).toBe('ran')
  await pastOpen(w)
  expect(w.submitted).toEqual([])
  expect(count(transcript(w), resetResumes(ev5()))).toBe(0)
  expect(await badgeOf($)).toEqual(warn(' ⨯ spare10'))
})

test('/spare10 resume inside the 5-hour skip window with the weekly window in the reserve consents the weekly window only', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 92 })
  await begin($, w)
  await w.clock.set(O_MS + 5 * MIN)
  expect(await run($, 'resume')).toBe(`you can use the weekly reserve until ${wk(WR_MS)}.`)
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(`S1 ${WEEK_RESETS}`)
  expect(w.env.has('SPARE10_CONSENT')).toBe(false) // an open kind gets no consent
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  expect(await badgeOf($)).toEqual(warn(` ↻ spare10: reserve open until ${hhmm(R_MS)}`))
  expect(phaseLine(await report($))).toBe(phaseOpen(RS5, 'is', `until ${hhmm(R_MS)}`))
})

test('autoResume off: the question stays past the skip start, the badge keeps asking, the report says new work goes on, and a late Resume consents until the reset', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, env: AUTO_OFF })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ(93)])
  expect(await badgeOf($)).toEqual(warn(' ? spare10: waiting for you'))
  expect(phaseLine(await report($))).toBe(PHASE_ASKING_OFF)
  await pastOpen(w)
  await w.clock.advance(2 * TICK)
  expect(count(transcript(w), resetWaitingForOpen(ev5()))).toBe(1) // B43: one note
  expect(w.dialogAborted).toBe('no')
  expect(await badgeOf($)).toEqual(warn(' ? spare10: waiting for you'))
  expect(phaseLine(await report($))).toBe(phaseAskingOffOpen(RS5, `until ${hhmm(R_MS)}`))
  expect((await bash($, undefined, 'new')).result).toBe('ran') // a new crossing passes with no question
  expect(w.asked).toHaveLength(1)
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(count(transcript(w), CONTINUING)).toBe(1)
  expect(await badgeOf($)).toEqual(warn(' ⨯ spare10'))
  expect(row(await report($), 'consent')).toBe(`  · consent        until ${hhmm(R_MS)} (you chose to continue)`)
  expect(w.submitted).toEqual([])
})

test('autoResume off: /spare10 resume on the question after its skip start answers the question and consents until the reset (4.2)', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, env: AUTO_OFF })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  await pastOpen(w)
  expect(w.dialogAborted).toBe('no')
  // The report tells the person to run /spare10 resume when no dialog shows, so the open question
  // comes before the open reply of 2.8.
  expect(await run($, 'resume')).toBe(`resumed. Held work continues on the reserve until ${hhmm(R_MS)}.`)
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(w.submitted).toEqual([])
})

// ---- The badge rows in and out of the skip window (2.6) and the open phase line (2.7) ----

type Case = {
  name: string
  opts: Parameters<typeof world>[1]
  at: number
  simulate?: string
  badge: string | RegExp
  phase: string
  runs: boolean
}

const TRIPPED = /^ [⚠ ] Pausing at next step$/
const CASES: Case[] = [
  { name: 'a 5-hour trip before its skip start', opts: { pct: 93 }, at: O_MS - MIN, badge: TRIPPED, phase: PHASE_TRIPPED_HOLD, runs: false },
  {
    name: 'a 5-hour trip at its skip start',
    opts: { pct: 93 },
    at: O_MS,
    badge: ` ↻ spare10: reserve open until ${hhmm(R_MS)}`,
    phase: phaseOpen(RS5, 'is', `until ${hhmm(R_MS)}`),
    runs: true,
  },
  {
    name: 'SPARE10_LAST_MINUTES=0 inside the old skip window',
    opts: { pct: 93, env: { SPARE10_LAST_MINUTES: '0' } },
    at: O_MS + MIN,
    badge: TRIPPED,
    phase: PHASE_TRIPPED_HOLD,
    runs: false,
  },
  { name: 'a reading without a reset time', opts: { pct: 93, resetsAt: null }, at: O_MS + MIN, badge: TRIPPED, phase: PHASE_TRIPPED_HOLD, runs: false },
  {
    name: 'the 5-hour window open and the weekly window in its reserve',
    opts: { pct: 93, weekPct: 92 },
    at: O_MS + MIN,
    badge: TRIPPED,
    phase: PHASE_TRIPPED_HOLD,
    runs: false,
  },
  {
    name: 'a weekly trip in its own skip window',
    opts: { pct: 50, weekPct: 92, weekResetsAt: WEEK_NEAR },
    at: WNO_MS + MIN,
    badge: ` ↻ spare10: reserve open until ${wk(WN_MS)}`,
    phase: phaseOpen(RSW, 'is', `until ${wk(WN_MS)}`),
    runs: true,
  },
  {
    name: 'both windows open: the earliest reset',
    opts: { pct: 93, weekPct: 92, weekResetsAt: WEEK_NEAR },
    at: O_MS + MIN,
    badge: ` ↻ spare10: reserve open until ${hhmm(R_MS)}`,
    phase: phaseOpen(`${RS5} and ${RSW}`, 'are', `until they reset (${hhmm(R_MS)} and ${wk(WN_MS)})`),
    runs: true,
  },
  {
    name: 'a test window shorter than the span',
    opts: { pct: 50 },
    at: T0,
    simulate: 'simulate 95 in 10m',
    badge: ` ↻ spare10 (test): reserve open until ${hhmm(T0 + 10 * MIN)}`,
    phase: phaseOpen(RS5, 'is', `until ${hhmm(T0 + 10 * MIN)}`),
    runs: true,
  },
]

for (const c of CASES) {
  test(`the badge and the phase line: ${c.name}`, SLOW, async ($, on) => {
    const w = world(on, c.opts)
    await begin($, w)
    if (c.at > T0) await w.clock.set(c.at)
    if (c.simulate !== undefined) await run($, c.simulate)
    const shown = await badgeOf($)
    if (typeof c.badge === 'string') expect(shown).toEqual(warn(c.badge))
    else {
      expect(shown.text).toMatch(c.badge)
      expect(shown.color).toBe('warning')
    }
    expect(phaseLine(await report($))).toBe(c.phase)
    if (c.runs) {
      expect((await bash($)).result).toBe('ran')
      expect(w.asked).toEqual([])
    }
  })
}

test('tell mode: the ticker redraws a told badge to the open row at the skip start, and nothing is told there', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_PAUSE_PROMPT: 'Commit and stop.' }, agents: ['a2'] })
  await begin($, w)
  const told = await bash($)
  expect(told.result).toBe('ran')
  expect(told.context?.length).toBe(1) // main is told once before the skip start
  await w.clock.set(O_MS - TICK)
  const ui = await mountBadge($)
  expect(await drawn(ui)).toEqual(warn(' ⏸ spare10'))
  const invalidations = w.invalidations
  await w.clock.advance(2 * TICK) // the skip start is an edge (4.1)
  expect(w.invalidations).toBeGreaterThan(invalidations)
  expect(await drawn(ui)).toEqual(warn(` ↻ spare10: reserve open until ${hhmm(R_MS)}`))
  await ui.unmount()
  const sub = await bash($, 'a2')
  expect(sub.result).toBe('ran')
  expect(sub.context ?? []).toEqual([]) // nothing is told in the skip window (3.6)
  expect(w.asked).toEqual([])
})

// ---- /spare10 report rows (2.7) ----

test('/spare10 shows the two open rows after the weekly reserve, from /config by default, attended and unattended', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  const lines = await report($)
  const i = lines.findIndex((l) => l.startsWith('  · weekly reserve '))
  expect(i).toBeGreaterThan(0)
  expect(lines[i + 1]).toBe(ROW_OPENS('in the last 20 min of the 5-hour window (from /config)'))
  expect(lines[i + 2]).toBe(ROW_WEEK_OPENS('in the last 8 h of the weekly window (from /config)'))
  w.surfaces = []
  const unattended = await report($)
  expect(row(unattended, 'reserve opens')).toBe(ROW_OPENS('in the last 20 min of the 5-hour window (from /config)'))
  expect(row(unattended, 'weekly opens')).toBe(ROW_WEEK_OPENS('in the last 8 h of the weekly window (from /config)'))
})

for (const c of [
  {
    env: { SPARE10_LAST_MINUTES: '2.5', SPARE10_WEEKLY_LAST_HOURS: '0' },
    five: 'in the last 2.5 min of the 5-hour window (from SPARE10_LAST_MINUTES)',
    week: 'only at the reset (from SPARE10_WEEKLY_LAST_HOURS)',
  },
  {
    env: { SPARE10_LAST_MINUTES: '0', SPARE10_WEEKLY_LAST_HOURS: '12.5' },
    five: 'only at the reset (from SPARE10_LAST_MINUTES)',
    week: 'in the last 12.5 h of the weekly window (from SPARE10_WEEKLY_LAST_HOURS)',
  },
  {
    env: { SPARE10_LAST_MINUTES: '299', SPARE10_WEEKLY_LAST_HOURS: '167' },
    five: 'in the last 299 min of the 5-hour window (from SPARE10_LAST_MINUTES)',
    week: 'in the last 167 h of the weekly window (from SPARE10_WEEKLY_LAST_HOURS)',
  },
]) {
  test(`/spare10 names the env as the source of the open rows (${JSON.stringify(c.env)})`, async ($, on) => {
    const w = world(on, { pct: 50, env: c.env })
    await begin($, w)
    const lines = await report($)
    expect(row(lines, 'reserve opens')).toBe(ROW_OPENS(c.five))
    expect(row(lines, 'weekly opens')).toBe(ROW_WEEK_OPENS(c.week))
    expect(transcript(w).filter((t) => t.includes('SPARE10_LAST_MINUTES') || t.includes('SPARE10_WEEKLY_LAST_HOURS'))).toEqual([])
  })
}

for (const c of [
  { name: 'SPARE10_LAST_MINUTES', raw: '300', warning: 'SPARE10_LAST_MINUTES="300" is not 0 to 299. spare10 uses 20.' },
  { name: 'SPARE10_LAST_MINUTES', raw: '-1', warning: 'SPARE10_LAST_MINUTES="-1" is not 0 to 299. spare10 uses 20.' },
  { name: 'SPARE10_WEEKLY_LAST_HOURS', raw: '168', warning: 'SPARE10_WEEKLY_LAST_HOURS="168" is not 0 to 167. spare10 uses 8.' },
  { name: 'SPARE10_WEEKLY_LAST_HOURS', raw: 'soon', warning: 'SPARE10_WEEKLY_LAST_HOURS="soon" is not 0 to 167. spare10 uses 8.' },
]) {
  test(`a bad ${c.name} (${c.raw}) warns once and keeps the option (B27)`, async ($, on) => {
    const w = world(on, { pct: 50, env: { [c.name]: c.raw } })
    await begin($, w)
    expect(count(transcript(w), c.warning)).toBe(1)
    const lines = await report($)
    expect(lines).toContain(`  ⚠ ${c.warning}`)
    expect(row(lines, 'reserve opens')).toBe(ROW_OPENS('in the last 20 min of the 5-hour window (from /config)'))
    expect(row(lines, 'weekly opens')).toBe(ROW_WEEK_OPENS('in the last 8 h of the weekly window (from /config)'))
  })
}

test('/spare10 leaves the weekly open row out when the weekly guard is off', async ($, on) => {
  const w = world(on, { pct: 50, env: { SPARE10_WEEKLY_RESERVE: '0' } })
  await begin($, w)
  const lines = await report($)
  expect(row(lines, 'reserve opens')).toBe(ROW_OPENS('in the last 20 min of the 5-hour window (from /config)'))
  expect(row(lines, 'weekly opens')).toBeUndefined()
})

test('a failed read of one span variable sets both spans to 0: the rows say so, and the question keeps the reset time', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, envGetFails: ['SPARE10_WEEKLY_LAST_HOURS'] })
  await begin($, w)
  const lines = await report($)
  expect(row(lines, 'reserve opens')).toBe(ROW_OPENS('only at the reset (spare10 could not read the env)'))
  expect(row(lines, 'weekly opens')).toBe(ROW_WEEK_OPENS('only at the reset (spare10 could not read the env)'))
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ(93, R_MS, loopAfter(hhmm(R_MS)))])
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(mf(93)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', R_MS, T0, 'five_hour,work,auto'))
  await pastOpen(w)
  expect(w.submitted).toEqual([])
  expect((await bash($)).deny).toBe(STOP(mf(93))) // the guard stays on (B47)
})

// ---- /spare10 simulate (2.9) ----

type Sim = { name: string; opts: Parameters<typeof world>[1]; at?: number; args: string; reply: () => string }
const SIMS: Sim[] = [
  {
    name: 'a test window of exactly the span is open at once',
    opts: { pct: 50 },
    args: 'simulate 95 in 20m',
    reply: () => simSet('95% used', hhmm(T0 + 20 * MIN), ' The test window ends within 20 min, so the reserve is open at once.'),
  },
  {
    name: 'the trip point itself says when the reserve opens',
    opts: { pct: 50 },
    args: 'simulate 90 in 22m',
    reply: () => simSet('90% used', hhmm(T0 + 22 * MIN), ` The reserve opens at ${hhmm(T0 + 2 * MIN)}, ${testLead()}.`),
  },
  {
    name: 'a percentage below the trip point adds nothing',
    opts: { pct: 50 },
    args: 'simulate 89 in 22m',
    reply: () => simSet('89% used', hhmm(T0 + 22 * MIN)),
  },
  {
    name: 'SPARE10_LAST_MINUTES=0 adds nothing',
    opts: { pct: 50, env: { SPARE10_LAST_MINUTES: '0' } },
    args: 'simulate 95 in 22m',
    reply: () => simSet('95% used', hhmm(T0 + 22 * MIN)),
  },
  {
    name: 'a real trip that is open by itself does not keep the test window from opening',
    opts: { pct: 92 },
    at: O_MS + MIN,
    args: 'simulate 95 in 22m',
    reply: () => simSet('95% used', hhmm(O_MS + 23 * MIN), ` The reserve opens at ${hhmm(O_MS + 3 * MIN)}, ${testLead()}.`),
  },
  {
    name: 'a weekly test window of 8 h is open at once',
    opts: { pct: 50 },
    args: 'simulate 95 weekly in 8h',
    reply: () =>
      simSet(
        '95% used of the weekly window',
        wk(T0 + 8 * HOUR),
        ' The weekly test window ends within 8 h, so the weekly reserve is open at once.',
      ),
  },
  {
    name: 'a weekly test window over a real weekly trip',
    opts: { pct: 50, weekPct: 92 },
    args: 'simulate 95 weekly in 482m',
    reply: () =>
      simSet(
        '95% used of the weekly window',
        wk(T0 + 482 * MIN),
        ' The real weekly reading is also in the weekly reserve, so the weekly test window does not open it.',
      ),
  },
  {
    name: 'SPARE10_WEEKLY_LAST_HOURS=0 adds nothing for the weekly window',
    opts: { pct: 50, env: { SPARE10_WEEKLY_LAST_HOURS: '0' } },
    args: 'simulate 95 weekly in 482m',
    reply: () => simSet('95% used of the weekly window', wk(T0 + 482 * MIN)),
  },
  {
    name: 'a bad value names the new example',
    opts: { pct: 50 },
    args: 'simulate soon',
    reply: () =>
      '/spare10 simulate takes a percentage from 0 to 100, or off. Add weekly for the weekly window, and in 22m for a test window that resets in 22 minutes.',
  },
]

for (const c of SIMS) {
  test(`/spare10 simulate: ${c.name}`, async ($, on) => {
    const w = world(on, c.opts)
    await begin($, w)
    if (c.at !== undefined) await w.clock.set(c.at)
    expect(await run($, c.args)).toBe(c.reply())
  })
}

test('simulate 95 in 10m is open at once: /spare10 stop and resume say the reserve is open until the test reset, and nothing is written', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  const end = T0 + 10 * MIN
  expect(await run($, 'simulate 95 in 10m')).toBe(
    simSet('95% used', hhmm(end), ' The test window ends within 20 min, so the reserve is open at once.'),
  )
  expect((await bash($)).result).toBe('ran')
  expect(await run($, 'stop')).toBe(stopOpenReply(RS5, `until ${hhmm(end)}`))
  expect(await run($, 'resume')).toBe(resumeOpenReply(RS5, `until ${hhmm(end)}`))
  await w.clock.settle()
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
})
