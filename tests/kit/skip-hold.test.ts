import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ToolCallResult } from 'claude-code'
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
  pastOpen,
  real5,
  real7,
  step,
  stopRec,
  typed,
  world02 as world,
} from '../helpers/world.ts'
import type { World } from '../helpers/world.ts'

// The 0.2 texts: floors off (world02). The floor tests: floor*.test.ts.
// Skip near the reset for held work and questions, through the engine (skip design B41 to B46, 2.2 to
// 2.7, 3.5, 4.2 to 4.6). An independent set beside tests/kit/skip.test.ts: attended with autoResume on
// and off, both kinds, a kind with no reset time, test windows, tell mode and unattended wait at the
// skip start. Every expected text is spelled out here from skip design section 2 and D0.2 section 2,
// not taken from hooks/core/text.ts, so a drift in the texts or in the skip rules fails a test.
// The world runs the shipped spans (20 min, 8 h). Every test calls begin: the ticker exists only then.

const RESET_MS = Date.parse(RESETS)
const OPENS_MS = Date.parse(OPENS) // RESETS minus 20 min
const WEEK_MS = Date.parse(WEEK_RESETS)
const WEEK_OPENS_MS = Date.parse(WEEK_OPENS) // WEEK_RESETS minus 8 h
const NEAR_MS = Date.parse(WEEK_NEAR) // a weekly reset 9 h after T0
const NEAR_OPENS_MS = Date.parse(WEEK_NEAR_OPENS) // its skip start, 1 h after T0
const OFF_MS = Date.parse(OFF_TICK) // a reset 15 s off the tick grid
const OFF_OPENS_MS = Date.parse(OFF_OPENS)

// {clock} (D0.2 2.1): HH:MM for the 5-hour window, `ddd HH:MM` for the weekly one (all under 6 days here),
// in the machine's zone as the kit runs.
const hhmm = (ms: number): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
const wk = (ms: number): string => `${new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(ms)} ${hhmm(ms)}`
const AT = hhmm(RESET_MS) // the 5-hour reset clock
const AT_OPEN = hhmm(OPENS_MS) // the 5-hour skip start clock
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

// {pf} and {mf} of one kind (D0.2 2.1)
const num = (n: number): string => String(Math.round(n * 10) / 10)
const pf = (used: number, at: string): string => `${num(used)}% used · ${num(100 - used)}% left · resets ${at}`
const mf5 = (used: number, at: string): string => `into your 10% reserve · ${num(100 - used)}% of quota left · resets ${at}`

// {lead} (skip 2.1)
const LEAD = '20 min before the reset'
const WEEK_LEAD = '8 h before the weekly reset'
const TEST_LEAD = '20 min before the test window ends'
const WEEK_TEST_LEAD = '8 h before the weekly test window ends'
const R5 = 'your 10% reserve'
const RW = 'your 10% weekly reserve'

// The question (D0.2 2.2, skip 2.2). `after` is empty with autoResume off.
const skipAfter = (at: string, lead: string): string =>
  ` If you choose Stop here or do not answer, the work waits until ${at}, ${lead}. Then spare10 continues it, unless a reserve is still reached.`
const plainAfter = (at: string): string =>
  ` If you choose Stop here or do not answer, the work waits until ${at}. Then spare10 continues it, unless a reserve is still reached.`
const loop5 = (used: number, reset: string, after = ''): string =>
  `Your 10% reserve is reached: ${pf(used, reset)}. All work is on hold. Continue on the reserve until ${reset}?${after}`
const loopW = (used: number, reset: string, after = ''): string =>
  `Your 10% weekly reserve is reached: ${pf(used, reset)}. All work is on hold. Continue on the weekly reserve until ${reset}?${after}`
const loopBoth = (used5: number, reset5: string, usedW: number, resetW: string, after: string): string =>
  `Your 10% reserve and your 10% weekly reserve are reached: 5-hour window ${pf(used5, reset5)}, weekly window ${pf(usedW, resetW)}. ` +
  `All work is on hold. Continue on both reserves until they reset (${reset5} and ${resetW})?${after}`
const promptHold5 = (used: number, reset: string, at: string, lead: string): string =>
  `Your 10% reserve is reached: ${pf(used, reset)}. spare10 holds your prompt and any other work. Continue on the reserve until ${reset}? ` +
  `If you do not answer, all of it continues at ${at}, ${lead}, unless a reserve is still reached. Stop here gives your prompt back and pauses other work until ${at}.`
const promptTell5 = (used: number, reset: string, at: string, lead: string): string =>
  `Your 10% reserve is reached: ${pf(used, reset)}. spare10 holds your prompt. Continue on the reserve until ${reset}? ` +
  `If you do not answer, your prompt goes in at ${at}, ${lead}, unless a reserve is still reached. Stop here gives it back to you.`

// Text the model reads (D0.2 2.3, skip 2.3)
const STOP = (mf: string): string =>
  `spare10: the user stopped work at the quota reserve (${mf}). Stop now and wait for the user. Do not call any further tools.`
const PAUSED = (mf: string): string =>
  `spare10: work stopped at the quota reserve (${mf}). No model request was sent, so this task is not finished. Wait for the user.`
const STOP_LEAD = 'spare10: the user stopped work at the quota reserve ('
const NOT_STARTED = `spare10: not started. This session is inside your 10% reserve until ${AT}. Send the prompt again to be asked again, or run /spare10 resume.`
const resumePrompt = (event: string): string =>
  `${capital(event)}, so the stop at the quota reserve is over. spare10 is set to continue the work when the reserve opens, so do not wait for the user. ` +
  'Continue the task from the point where it stopped. A subagent whose result says "spare10: work stopped" or "spare10: the user stopped work" did not finish. ' +
  'Run it again if you still need its result.'

// {event} parts of an open kind (skip 2.1): {soon}, then `{Rs} {is} open until then`
const open5 = (reset = AT): string => `the 5-hour window resets at ${reset}. Your 10% reserve is open until then`
const openW = (reset: string): string => `the weekly window resets at ${reset}. Your 10% weekly reserve is open until then`
const openT = (reset: string): string => `the test window ends at ${reset}. Your 10% reserve is open until then`
const openWT = (reset: string): string => `the weekly test window ends at ${reset}. Your 10% weekly reserve is open until then`

// Transcript notices (skip 2.4), without the engine prefix
const continues = (event: string): string => `${event}. Held work continues.`
const resumes = (event: string): string => `${event}. spare10 continues the stopped work.`
const waitingFor = (event: string): string => `${event}, but held work still waits for your answer. New work goes on with no question.`
const stoppedSkipWork = (rs: string, at: string, lead: string): string =>
  `stopped at ${rs} until ${at}, ${lead}. Then spare10 continues the work, unless a reserve is still reached. Type a prompt to be asked again, or run /spare10 resume.`
const stoppedSkip = (rs: string, at: string, lead: string): string =>
  `stopped at ${rs} until ${at}, ${lead}. Type a prompt to be asked again, or run /spare10 resume.`
const stoppedLateOpen = (event: string): string => `stopped. Held work is refused. ${capital(event)}, so new work goes on with no question.`

// Command replies (skip 2.8)
const askingSkipReply = (at: string, lead: string): string => `stopped. Held work is refused. spare10 continues it at ${at}, ${lead}.`
const askingSoonReply = (event: string): string =>
  `stopped. Held work is refused. ${capital(event)}, so spare10 continues it soon, unless a reserve is still reached.`

// Debug lines (D0.2 2.5, skip 2.5)
const UNATTENDED_WAIT = (pfText: string): string => `spare10: unattended run inside the reserve (${pfText}), policy wait.`
const UNATTENDED_OPEN = (pfText: string): string =>
  `spare10: unattended run inside the reserve (${pfText}), but the reset is near. spare10 lets it through.`

// Tell mode (D0.2 2.3, 2.4)
const PAUSE = 'Commit and stop.'
const TELL = { SPARE10_PAUSE_PROMPT: PAUSE }
const INSTR = (mf: string): string =>
  `spare10 budget guard. You have reached the safe usage limit for this session (${mf}). ` +
  'Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.' +
  `\n\nUser instructions: ${PAUSE}`
const TOLD_NOTICE = 'your 10% reserve is reached. spare10 told the agents to wind down.'

const AUTO_OFF = { SPARE10_AUTO_RESUME: 'off' }
const WAIT = { SPARE10_HEADLESS: 'wait' }

// Held waiters check on every tick for hours of mock time: allow more than the 5 s default.
const SLOW = { timeoutMs: 20_000 }

type Logged = Pick<World, 'logs'>
const debug = (w: Logged): string[] => w.logs.filter((l) => l.to === 'debug').map((l) => l.text)
const transcript = (w: Logged): string[] => w.logs.filter((l) => l.to !== 'debug').map((l) => l.text)
const count = (list: string[], text: string): number => list.filter((t) => t === text).length
const heldNotices = (w: Logged): string[] => transcript(w).filter((t) => t.includes('Held work') || t.includes('held work'))
const ctx = (r: ToolCallResult): readonly string[] => r.context ?? []
const toldLines = (w: Logged): string[] => debug(w).filter((t) => t.startsWith('spare10: told '))
const questions = (w: World): string[] => w.asked.map((a) => a.question)

/** The /spare10 report, one entry per line with runs of white space folded. */
async function report($: Engine): Promise<string[]> {
  const r = await $.command.run(cmd(''))
  return (r.text ?? '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
}

/** The footer badge text as drawn, trimmed. Mounted only for the read, so no pulse runs across a move. */
async function badgeText($: Engine): Promise<string> {
  const ui = await $.ui.mount({ plugin: 'spare10', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  const t = await ui.find({ type: 'Text', text: /spare10/ })
  await ui.unmount()
  return (t?.text ?? '').trim()
}

const untilOf = (raw: string | undefined): number => Number(raw?.split(' ')[1])
const tagsOf = (raw: string | undefined): string[] => (raw?.split(' ')[3] ?? '').split(',').filter((t) => t !== '').sort()

/** Neither consent variable is set: a skip start writes no consent (3.4). */
const noConsent = (w: World): void => {
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBeUndefined()
}

// ---- B41, B42: autoResume on, the 5-hour window ----

test('a held call, a held subagent call and a held step continue on the tick at the skip start, with no margin', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, agents: ['a1', 'a2'] })
  await begin($, w)
  const held = [bash($), bash($, 'a1')]
  const req = drain($, step('a2', 'T2'))
  await w.clock.settle()
  expect(questions(w)).toEqual([loop5(93, AT, skipAfter(AT_OPEN, LEAD))])
  await w.clock.set(OPENS_MS - TICK)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  expect(w.dialogAborted).toBe('no')
  // While asking: the badge and the report give the skip start, not the reset (skip 2.6, 2.7).
  expect(await badgeText($)).toBe(`? spare10: waiting for you until ${AT_OPEN}`)
  expect(await report($)).toContain(
    `? asking a question is open. Held work waits until you answer, or until ${AT_OPEN}. If no dialog shows, run /spare10 resume or /spare10 stop.`,
  )
  // The tick at the skip start releases: the margin is 0 (B42).
  await w.clock.set(OPENS_MS)
  await w.clock.settle()
  const out = await Promise.all(held)
  expect(out.map((r) => r.result)).toEqual(['ran', 'ran'])
  expect((await req).text).toBe('hi')
  expect([...w.ran].sort()).toEqual(['Bash:a1', 'Bash:main'])
  expect(w.requests).toBe(1)
  expect(w.dialogAborted).not.toBe('no')
  await w.clock.settle()
  expect(count(transcript(w), continues(open5()))).toBe(1)
  expect(transcript(w)).not.toContain('the 5-hour window reset. Held work continues.')
  noConsent(w)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect(w.submitted).toEqual([])
  // The phase is open now: new work passes with no question.
  expect(await badgeText($)).toBe(`↻ spare10: reserve open until ${AT}`)
  expect(await report($)).toContain(`↻ open the reset is near. Your 10% reserve is open until ${AT}, so spare10 lets all work through.`)
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step('a2', 'T3'))).text).toBe('hi')
  expect(w.asked).toHaveLength(1)
})

test('a prompt question in hold mode lets the prompt in at the skip start, with the other held work', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, agents: ['a1'] })
  await begin($, w)
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(questions(w)).toEqual([promptHold5(93, AT, AT_OPEN, LEAD)])
  const held = bash($, 'a1')
  await w.clock.settle()
  expect(w.asked).toHaveLength(1) // other work joins the open question
  await w.clock.set(OPENS_MS - TICK)
  await w.clock.settle()
  expect(w.prompts).toEqual([])
  expect(w.ran).toEqual([])
  await pastOpen(w)
  await w.clock.settle()
  expect(await p).toMatchObject({ text: 'hello' })
  expect((await held).result).toBe('ran')
  expect(w.prompts.map((e) => e.text)).toEqual(['hello'])
  expect(w.prompts.map((e) => e.context)).toEqual([undefined]) // no stop was taken over: no note
  expect(w.dialogAborted).not.toBe('no')
  expect(w.asked).toHaveLength(1)
  expect(count(transcript(w), continues(open5()))).toBe(1)
  noConsent(w)
  expect(w.fills).toEqual([])
})

test('a crossing 2 minutes before the skip start still asks, and the question goes away at the skip start', SLOW, async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  await w.clock.set(OPENS_MS - 2 * MIN)
  w.pct = 93
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loop5(93, AT, skipAfter(AT_OPEN, LEAD))]) // 4.8: not suppressed
  expect(w.ran).toEqual([])
  await pastOpen(w)
  await w.clock.settle()
  expect((await held).result).toBe('ran')
  expect(w.dialogAborted).not.toBe('no')
  expect(count(transcript(w), continues(open5()))).toBe(1)
  noConsent(w)
})

test('a seed inside the skip window lets the first call through with no question', async ($, on) => {
  const w = world(on, { store: { seed: { pct: 95, resetsAtMs: RESET_MS } } }) // no live reading
  await begin($, w)
  await w.clock.set(OPENS_MS + 5 * MIN)
  expect((await bash($)).result).toBe('ran') // a seed has a reset time, so it has a skip start (3.6)
  expect(w.asked).toEqual([])
  expect(await badgeText($)).toBe(`↻ spare10: reserve open until ${AT}`)
})

test('a Resume before the skip start stays consented in the skip window', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  await pastOpen(w)
  await w.clock.settle()
  const lines = await report($)
  expect(lines).toContain(`⨯ consented you chose to continue. spare10 is quiet until ${AT}.`)
  expect(lines.filter((l) => l.startsWith('↻ open'))).toEqual([])
  expect(heldNotices(w)).toEqual([])
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

// ---- Both kinds ----

test('a weekly question continues at the weekly skip start, 8 h before the weekly reset', SLOW, async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 92, weekResetsAt: WEEK_NEAR, agents: ['a1'] })
  await begin($, w)
  const held = bash($)
  const req = drain($, step('a1', 'T1'))
  await w.clock.settle()
  expect(questions(w)).toEqual([loopW(92, wk(NEAR_MS), skipAfter(wk(NEAR_OPENS_MS), WEEK_LEAD))])
  await w.clock.set(NEAR_OPENS_MS - TICK)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  await pastOpen(w, WEEK_NEAR_OPENS)
  await w.clock.settle()
  expect((await held).result).toBe('ran')
  expect((await req).text).toBe('hi')
  expect(count(transcript(w), continues(openW(wk(NEAR_MS))))).toBe(1)
  noConsent(w)
  expect(await badgeText($)).toBe(`↻ spare10: reserve open until ${wk(NEAR_MS)}`)
  expect(await report($)).toContain(
    `↻ open the reset is near. Your 10% weekly reserve is open until ${wk(NEAR_MS)}, so spare10 lets all work through.`,
  )
  expect((await bash($, 'a1')).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('a question on both kinds waits for the later skip start and names both open reserves', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 92, weekResetsAt: WEEK_NEAR })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  // {at}: the later hold end, the 5-hour skip start, in the weekday form. The owner is the 5-hour kind.
  expect(questions(w)).toEqual([loopBoth(93, AT, 92, wk(NEAR_MS), skipAfter(wk(OPENS_MS), LEAD))])
  // The weekly window opens first. The 5-hour window still gates, so nothing moves.
  await pastOpen(w, WEEK_NEAR_OPENS)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.dialogAborted).toBe('no')
  expect(w.asked).toHaveLength(1)
  expect(heldNotices(w)).toEqual([])
  await w.clock.set(OPENS_MS - TICK)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  await pastOpen(w)
  await w.clock.settle()
  expect((await held).result).toBe('ran')
  const event = `the 5-hour window resets at ${AT}, and the weekly window resets at ${wk(NEAR_MS)}. Your 10% reserve and your 10% weekly reserve are open until then`
  expect(count(transcript(w), continues(event))).toBe(1)
  noConsent(w)
  // The badge gives the earliest reset among the open kinds (skip 2.6).
  expect(await badgeText($)).toBe(`↻ spare10: reserve open until ${AT}`)
  expect(await report($)).toContain(
    `↻ open the reset is near. Your 10% reserve and your 10% weekly reserve are open until they reset (${AT} and ${wk(NEAR_MS)}), so spare10 lets all work through.`,
  )
})

test('a weekly trip still holds inside the 5-hour skip window: the question waits for the weekly skip start, and a Resume consents both', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 92, agents: ['a1'] })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  // The weekly skip start (Mon 01:00) is the later hold end: the weekly kind owns the time and the lead.
  expect(questions(w)).toEqual([loopBoth(93, AT, 92, wk(WEEK_MS), skipAfter(wk(WEEK_OPENS_MS), WEEK_LEAD))])
  await pastOpen(w)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.dialogAborted).toBe('no')
  expect(heldNotices(w)).toEqual([])
  // New work in the 5-hour skip window still meets the weekly guard.
  await w.clock.set(OPENS_MS + 5 * MIN)
  const late = bash($, 'a1')
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.asked).toHaveLength(1)
  w.release('Resume')
  expect((await held).result).toBe('ran')
  expect((await late).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(`S1 ${WEEK_RESETS}`)
})

// ---- A kind with no reset time: never open (B41 fail safe) ----

test('a weekly reading without a reset time holds inside the 5-hour skip window, with the D0.2 wording', async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 92, weekResetsAt: null })
  await begin($, w)
  await w.clock.set(OPENS_MS + 5 * MIN) // the 5-hour reserve is open
  const held = bash($)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.asked).toHaveLength(1)
  const q = questions(w)[0] ?? ''
  // Only the weekly kind gates, and it has no skip start: no lead.
  expect(q.startsWith(`Your 10% weekly reserve is reached: ${pf(92, 'at an unknown time')}. All work is on hold. Continue on the weekly reserve for one hour?`)).toBe(true)
  expect(q).toContain(' If you choose Stop here or do not answer, the work waits until ')
  expect(q.endsWith('. Then spare10 continues it, unless a reserve is still reached.')).toBe(true)
  expect(q).not.toContain('before the')
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

test('a 5-hour reading without a reset time keeps its margin past the weekly skip start, and the notice names both', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: null, weekPct: 92, weekResetsAt: WEEK_NEAR })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  const hold = T0 + 5 * HOUR // first sight plus one window (D0.2 3.1)
  const q = questions(w)[0] ?? ''
  expect(w.asked).toHaveLength(1)
  expect(
    q.startsWith(
      `Your 10% reserve and your 10% weekly reserve are reached: 5-hour window ${pf(93, 'at an unknown time')}, weekly window ${pf(92, wk(NEAR_MS))}. All work is on hold.`,
    ),
  ).toBe(true)
  // Not a skip owner: the 5-hour estimate is the later hold end, so the D0.2 after part (B42).
  expect(q.endsWith(plainAfter(wk(hold)))).toBe(true)
  expect(q).not.toContain('before the')
  await pastOpen(w, WEEK_NEAR_OPENS)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.dialogAborted).toBe('no')
  expect(w.asked).toHaveLength(1)
  // The weekly skip start takes no margin away from the 5-hour kind.
  await w.clock.set(hold + MARGIN - TICK)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.dialogAborted).toBe('no')
  expect(heldNotices(w)).toEqual([])
  await w.clock.set(hold + MARGIN + TICK)
  await w.clock.settle()
  expect((await held).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
  const event = `the 5-hour window reset. The weekly window resets at ${wk(NEAR_MS)}. Your 10% weekly reserve is open until then`
  expect(count(transcript(w), continues(event))).toBe(1)
  noConsent(w)
})

// ---- Stop here, autoResume on (B42, B46) ----

test('a weekly Stop here ends at the weekly skip start with one open resume prompt', SLOW, async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 92, weekResetsAt: WEEK_NEAR })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopW(92, wk(NEAR_MS), skipAfter(wk(NEAR_OPENS_MS), WEEK_LEAD))])
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(`into your 10% weekly reserve · 8% of weekly quota left · resets ${wk(NEAR_MS)}`))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', WEEK_NEAR_OPENS, T0, `seven_day,work,auto,skip,${real7(WEEK_NEAR)}`))
  expect(count(transcript(w), stoppedSkipWork(RW, wk(NEAR_OPENS_MS), WEEK_LEAD))).toBe(1)
  expect(await badgeText($)).toBe(`■ spare10: stopped until ${wk(NEAR_OPENS_MS)}`)
  expect(await report($)).toContain(
    `■ stopped you chose Stop here. spare10 continues the work at ${wk(NEAR_OPENS_MS)}. Type a prompt to be asked again, or run /spare10 resume.`,
  )
  await w.clock.set(NEAR_OPENS_MS - TICK)
  expect(w.submitted).toEqual([])
  await pastOpen(w, WEEK_NEAR_OPENS)
  await w.clock.settle()
  expect(w.submitted).toEqual([resumePrompt(openW(wk(NEAR_MS)))])
  expect(count(transcript(w), resumes(openW(wk(NEAR_MS))))).toBe(1)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  noConsent(w)
  await w.clock.advance(10 * TICK)
  expect(w.submitted).toHaveLength(1)
  expect((await bash($)).result).toBe('ran')
})

test('a loop Stop, then Esc on a prompt question: the merged stop keeps the skip start, and one resume prompt comes', SLOW, async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(mf5(93, AT)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OPENS, T0, `five_hour,work,auto,skip,${real5(RESETS)}`))
  expect(count(transcript(w), stoppedSkipWork(R5, AT_OPEN, LEAD))).toBe(1)
  await w.clock.advance(MIN)
  w.answer = 'dismiss' // Esc counts as Stop here
  expect(await $.prompt.submit(typed('carry on'))).toEqual({ drop: NOT_STARTED })
  await w.clock.settle()
  expect(questions(w)).toEqual([loop5(93, AT, skipAfter(AT_OPEN, LEAD)), promptHold5(93, AT, AT_OPEN, LEAD)])
  // The later stop gives the time, the work of the loop stop stays, and so does the skip tag (3.5).
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OPENS, T0 + MIN, `five_hour,work,auto,skip,${real5(RESETS)}`))
  expect(count(transcript(w), stoppedSkipWork(R5, AT_OPEN, LEAD))).toBe(2)
  await w.clock.set(OPENS_MS - TICK)
  expect(w.submitted).toEqual([])
  await pastOpen(w)
  await w.clock.settle()
  expect(w.submitted).toEqual([resumePrompt(open5())])
  expect(count(transcript(w), resumes(open5()))).toBe(1)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect((await bash($)).result).toBe('ran')
})

test('/spare10 stop on the open question before the skip start: the skip reply, a skip stop, one resume prompt', SLOW, async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  await w.clock.advance(10 * MIN)
  expect((await $.command.run(cmd('stop'))).text).toBe(askingSkipReply(AT_OPEN, LEAD))
  expect((await held).deny).toBe(STOP(mf5(93, AT)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OPENS, T0 + 10 * MIN, `five_hour,work,auto,skip,${real5(RESETS)}`))
  expect(await badgeText($)).toBe(`■ spare10: stopped until ${AT_OPEN}`)
  expect(await report($)).toContain(
    `■ stopped you chose Stop here. spare10 continues the work at ${AT_OPEN}. Type a prompt to be asked again, or run /spare10 resume.`,
  )
  await w.clock.set(OPENS_MS - TICK)
  expect(w.submitted).toEqual([])
  await pastOpen(w)
  await w.clock.settle()
  expect(w.submitted).toEqual([resumePrompt(open5())])
  expect(count(transcript(w), resumes(open5()))).toBe(1)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
})

test('/spare10 stop on the open question after the skip start and before the check: continues soon, at the next tick', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: OFF_TICK })
  await begin($, w)
  const reset = hhmm(OFF_MS)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loop5(93, reset, skipAfter(hhmm(OFF_OPENS_MS), LEAD))])
  await w.clock.set(OFF_OPENS_MS + 5000) // past the skip start, 10 s before the next tick
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.dialogAborted).toBe('no')
  const at = w.clock.now()
  expect((await $.command.run(cmd('stop'))).text).toBe(askingSoonReply(open5(reset))) // B46, no past time
  expect((await held).deny).toBe(STOP(mf5(93, reset)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OFF_OPENS, at, 'five_hour,work,auto,skip'))
  expect(w.submitted).toEqual([])
  await w.clock.advance(TICK)
  await w.clock.settle()
  expect(w.submitted).toEqual([resumePrompt(open5(reset))])
  expect(count(transcript(w), resumes(open5(reset)))).toBe(1)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect((await bash($)).result).toBe('ran')
})

test('Stop here after the skip start while the weekly window gates now: the weekly kind is stopped until its skip start', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: OFF_TICK, weekPct: 50 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loop5(93, hhmm(OFF_MS), skipAfter(hhmm(OFF_OPENS_MS), LEAD))])
  await w.clock.advance(HOUR)
  w.weekPct = 92 // the weekly window trips while the 5-hour question waits
  await w.clock.set(OFF_OPENS_MS + 5000)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.dialogAborted).toBe('no')
  w.release('Stop here')
  expect((await held).deny?.startsWith(STOP_LEAD)).toBe(true)
  await w.clock.settle()
  // B46: a kind that gates at that moment is stopped as usual, until its hold end.
  const raw = w.env.get('SPARE10_STOPPED')
  expect(untilOf(raw)).toBe(WEEK_OPENS_MS)
  expect(tagsOf(raw)).toEqual(expect.arrayContaining(['seven_day', 'work', 'auto', 'skip']))
  const notice = transcript(w).find((t) => t.startsWith('stopped at '))
  expect(notice).toContain(`until ${wk(WEEK_OPENS_MS)}, ${WEEK_LEAD}. Then spare10 continues the work, unless a reserve is still reached.`)
  expect(transcript(w).filter((t) => t.includes(' soon'))).toEqual([])
  await w.clock.advance(3 * TICK)
  await w.clock.settle()
  expect(w.submitted).toEqual([])
  expect((await bash($)).deny?.startsWith(STOP_LEAD)).toBe(true)
})

// ---- autoResume off (B43, B46) ----

test('autoResume off: one note at the skip start, new work passes, and a later Stop here refuses the held work and writes nothing', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, agents: ['a1', 'a2'], env: AUTO_OFF })
  await begin($, w)
  const held = bash($)
  const req = drain($, step('a1', 'T1'))
  await w.clock.settle()
  expect(questions(w)).toEqual([loop5(93, AT)]) // no after part with autoResume off
  await w.clock.set(OPENS_MS - TICK)
  await w.clock.settle()
  expect(heldNotices(w)).toEqual([])
  await pastOpen(w)
  await w.clock.settle()
  expect(count(transcript(w), waitingFor(open5()))).toBe(1)
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  expect(w.dialogAborted).toBe('no')
  // New crossings in the skip window pass with no question.
  await w.clock.advance(2 * MIN)
  expect((await bash($, 'a2')).result).toBe('ran')
  expect((await drain($, step('a2', 'T2'))).text).toBe('hi')
  expect(w.asked).toHaveLength(1)
  expect(await report($)).toContain(
    `? asking a question is open. Held work waits until you answer. Your 10% reserve is open until ${AT}, so new work goes on. If no dialog shows, run /spare10 resume or /spare10 stop.`,
  )
  await w.clock.advance(5 * MIN)
  expect(count(transcript(w), waitingFor(open5()))).toBe(1) // one note only
  // B46 open: nothing is written, held work is refused, new work goes on.
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(mf5(93, AT)))
  expect((await req).text).toBe(PAUSED(mf5(93, AT)))
  await w.clock.settle()
  expect(count(transcript(w), stoppedLateOpen(open5()))).toBe(1)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  noConsent(w)
  expect(w.submitted).toEqual([])
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('autoResume off: Stop here ends at the skip start, nothing is logged or sent, and the next prompt goes in with no question', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, env: AUTO_OFF })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loop5(93, AT)])
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(mf5(93, AT)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OPENS, T0, `five_hour,work,skip,${real5(RESETS)}`)) // the stop end, no auto
  expect(count(transcript(w), stoppedSkip(R5, AT_OPEN, LEAD))).toBe(1)
  // A skip stop shows its end in both modes (skip 1.3 item 6).
  expect(await badgeText($)).toBe(`■ spare10: stopped until ${AT_OPEN}`)
  expect(await report($)).toContain(`■ stopped you chose Stop here, until ${AT_OPEN}. Type a prompt to be asked again, or run /spare10 resume.`)
  await w.clock.advance(HOUR)
  expect((await drain($, step(undefined, 'T1'))).text).toBe(PAUSED(mf5(93, AT))) // the stop holds before its end
  await w.clock.settle()
  const logged = transcript(w).length
  await pastOpen(w)
  await w.clock.advance(3 * TICK)
  await w.clock.settle()
  expect(transcript(w)).toHaveLength(logged)
  expect(w.submitted).toEqual([])
  expect(await $.prompt.submit(typed('go on'))).toMatchObject({ text: 'go on' })
  expect(w.prompts.map((e) => e.context)).toEqual([undefined])
  expect(w.asked).toHaveLength(1)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w)).toHaveLength(logged)
  expect(await badgeText($)).toBe(`↻ spare10: reserve open until ${AT}`)
})

test('autoResume off: a test window over a real reading below the reserve gives one note at its skip start, and a late Resume writes no consent', SLOW, async ($, on) => {
  const w = world(on, { pct: 50, agents: ['a1'], env: AUTO_OFF })
  await begin($, w)
  const end = T0 + 22 * MIN
  const start = T0 + 2 * MIN
  expect((await $.command.run(cmd('simulate 95 in 22m'))).text).toBe(
    `test reading set to 95% used, resets ${hhmm(end)}. It can only raise the real reading. The reserve opens at ${hhmm(start)}, ${TEST_LEAD}. Run /spare10 simulate off to clear it.`,
  )
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loop5(95, hhmm(end))])
  await w.clock.set(start - TICK)
  await w.clock.settle()
  expect(heldNotices(w)).toEqual([])
  await w.clock.set(start + TICK)
  await w.clock.settle()
  expect(count(transcript(w), waitingFor(openT(hhmm(end))))).toBe(1)
  expect(w.ran).toEqual([])
  expect(w.dialogAborted).toBe('no')
  expect((await bash($, 'a1')).result).toBe('ran') // new work passes
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  noConsent(w) // a Resume on a test reading never goes into the env
  expect(w.asked).toHaveLength(1)
})

// ---- Test windows (B45) ----

test('a Stop here on a test window in 22m continues 2 minutes later with the open resume prompt', SLOW, async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  const end = T0 + 22 * MIN
  const start = T0 + 2 * MIN
  await $.command.run(cmd('simulate 95 in 22m'))
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loop5(95, hhmm(end), skipAfter(hhmm(start), TEST_LEAD))])
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(mf5(95, hhmm(end))))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', start, T0, 'five_hour,work,auto,test,skip'))
  expect(count(transcript(w), stoppedSkipWork(R5, hhmm(start), TEST_LEAD))).toBe(1)
  expect(await badgeText($)).toBe(`■ spare10 (test): stopped until ${hhmm(start)}`)
  await w.clock.set(start - TICK)
  expect(w.submitted).toEqual([])
  await w.clock.set(start) // the tick at the test skip start: no margin, also with the test tag
  await w.clock.settle()
  expect(w.submitted).toEqual([resumePrompt(openT(hhmm(end)))])
  expect(count(transcript(w), resumes(openT(hhmm(end))))).toBe(1)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(await badgeText($)).toBe(`↻ spare10 (test): reserve open until ${hhmm(end)}`)
  expect((await bash($)).result).toBe('ran')
})

test('a Stop here on a test window over a real trip is extended until the real skip start, then continues', SLOW, async ($, on) => {
  const w = world(on, { pct: 92 })
  await begin($, w)
  const end = T0 + 22 * MIN
  const start = T0 + 2 * MIN
  expect((await $.command.run(cmd('simulate 95 in 22m'))).text).toBe(
    `test reading set to 95% used, resets ${hhmm(end)}. It can only raise the real reading. The real reading is also in the reserve, so the test window does not open it. A Resume on the test reading also lets real work use the reserve. Run /spare10 simulate off to clear it.`,
  )
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loop5(95, hhmm(end), skipAfter(hhmm(start), TEST_LEAD))])
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(mf5(95, hhmm(end))))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', start, T0, `five_hour,work,auto,test,skip,${real5(RESETS)}`))
  // At the test skip start the real reading gates: the stop is extended on the real basis (B45, 4.5).
  await w.clock.set(start + TICK)
  await w.clock.settle()
  expect(w.submitted).toEqual([])
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OPENS, T0, `five_hour,work,auto,skip,${real5(RESETS)}`))
  expect(count(transcript(w), `your 10% reserve is reached. The stop lasts until ${AT_OPEN}, ${LEAD}.`)).toBe(1)
  expect(transcript(w).filter((t) => t.endsWith('spare10 continues the stopped work.'))).toEqual([])
  await w.clock.set(T0 + HOUR)
  expect((await bash($)).deny).toBe(STOP(mf5(92, AT)))
  await w.clock.set(OPENS_MS - TICK)
  expect(w.submitted).toEqual([])
  await pastOpen(w)
  await w.clock.settle()
  expect(w.submitted).toEqual([resumePrompt(open5())])
  expect(count(transcript(w), resumes(open5()))).toBe(1)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
})

test('a test window over a real trip without a reset time opens nothing: the real reading asks with the D0.2 wording', SLOW, async ($, on) => {
  const w = world(on, { pct: 92, resetsAt: null })
  await begin($, w)
  const end = T0 + 10 * MIN
  expect((await $.command.run(cmd('simulate 95 in 10m'))).text).toBe(
    `test reading set to 95% used, resets ${hhmm(end)}. It can only raise the real reading. The real reading is also in the reserve, so the test window does not open it. A Resume on the test reading also lets real work use the reserve. Run /spare10 simulate off to clear it.`,
  )
  const held = bash($)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(questions(w)).toEqual([
    `Your 10% reserve is reached: ${pf(92, 'at an unknown time')}. All work is on hold. Continue on the reserve for one hour?${plainAfter(hhmm(T0 + 5 * HOUR))}`,
  ])
  await w.clock.set(T0 + 15 * MIN) // past the test window: the real reading still gates
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.dialogAborted).toBe('no')
  expect(heldNotices(w)).toEqual([])
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

test('a weekly test window in 482m opens the weekly reserve 2 minutes later for a held step', SLOW, async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 50, agents: ['a1'] })
  await begin($, w)
  const end = T0 + 482 * MIN
  const start = T0 + 2 * MIN
  expect((await $.command.run(cmd('simulate 95 weekly in 482m'))).text).toBe(
    `test reading set to 95% used of the weekly window, resets ${wk(end)}. It can only raise the real reading. The weekly reserve opens at ${wk(start)}, ${WEEK_TEST_LEAD}. Run /spare10 simulate off to clear it.`,
  )
  const req = drain($, step('a1', 'T1'))
  await w.clock.settle()
  expect(questions(w)).toEqual([loopW(95, wk(end), skipAfter(wk(start), WEEK_TEST_LEAD))])
  await w.clock.set(start - TICK)
  await w.clock.settle()
  expect(w.requests).toBe(0)
  await w.clock.set(start)
  await w.clock.settle()
  expect((await req).text).toBe('hi')
  expect(count(transcript(w), continues(openWT(wk(end))))).toBe(1)
  noConsent(w)
})

// ---- Tell mode (3.6, 4.2) ----

test('tell mode: a loop told before the skip start is not told to go on, and inside the skip window nobody is told', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, env: TELL, agents: ['a1', 'a2'] })
  await begin($, w)
  const first = await bash($)
  expect(first.result).toBe('ran')
  expect(ctx(first)).toEqual([INSTR(mf5(93, AT))])
  expect(toldLines(w)).toEqual(['spare10: told S1:main'])
  expect(count(transcript(w), TOLD_NOTICE)).toBe(1)
  await pastOpen(w)
  await w.clock.settle()
  expect(w.submitted).toEqual([]) // R-S7: no message at the skip start
  const a1 = await bash($, 'a1')
  expect(a1.result).toBe('ran')
  expect(ctx(a1)).toEqual([])
  expect(ctx(await bash($))).toEqual([])
  expect((await drain($, step('a2', 'T2'))).text).toBe('hi')
  expect(ctx(await bash($, 'a2'))).toEqual([])
  expect(toldLines(w)).toEqual(['spare10: told S1:main'])
  expect(count(transcript(w), TOLD_NOTICE)).toBe(1)
  expect(await $.prompt.submit(typed('next'))).toMatchObject({ text: 'next' })
  expect(w.prompts.map((e) => e.context)).toEqual([undefined])
  expect(w.asked).toEqual([])
  expect(await badgeText($)).toBe(`↻ spare10: reserve open until ${AT}`)
  expect(await report($)).toContain(`↻ open the reset is near. Your 10% reserve is open until ${AT}, so spare10 lets all work through.`)
})

test('tell mode: a crossing inside the skip window tells nobody, and a prompt goes in with no question', async ($, on) => {
  const w = world(on, { pct: 50, env: TELL, agents: ['a1'] })
  await begin($, w)
  await w.clock.set(OPENS_MS + 5 * MIN)
  w.pct = 93
  const main = await bash($)
  expect(main.result).toBe('ran')
  expect(ctx(main)).toEqual([])
  expect(ctx(await bash($, 'a1'))).toEqual([])
  expect(await $.prompt.submit(typed('go'))).toMatchObject({ text: 'go' })
  expect(w.prompts.map((e) => e.context)).toEqual([undefined])
  expect(toldLines(w)).toEqual([])
  expect(count(transcript(w), TOLD_NOTICE)).toBe(0)
  expect(w.asked).toEqual([])
})

test('tell mode: an unanswered prompt question lets the prompt in at the skip start', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, env: TELL })
  await begin($, w)
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(questions(w)).toEqual([promptTell5(93, AT, AT_OPEN, LEAD)])
  await w.clock.set(OPENS_MS - TICK)
  await w.clock.settle()
  expect(w.prompts).toEqual([])
  await pastOpen(w)
  await w.clock.settle()
  expect(await p).toMatchObject({ text: 'hello' })
  expect(w.prompts.map((e) => e.text)).toEqual(['hello'])
  expect(w.prompts.map((e) => e.context)).toEqual([undefined])
  expect(w.dialogAborted).not.toBe('no')
  expect(count(transcript(w), continues(open5()))).toBe(1)
  expect(toldLines(w)).toEqual([])
  noConsent(w)
})

// ---- Unattended wait (4.2) ----

for (const [label, env] of [
  ['', WAIT],
  [' (autoResume off)', { ...WAIT, ...AUTO_OFF }],
] as const) {
  test(`-p wait holds a call and a step until the skip start and continues there with no margin${label}`, SLOW, async ($, on) => {
    const w = world(on, { pct: 93, surfaces: [], agents: ['a1'], env })
    await begin($, w)
    const held = [bash($), bash($, 'a1')]
    const req = drain($, step(undefined, 'T1'))
    await w.clock.settle()
    expect(w.asked).toEqual([])
    expect(w.ran).toEqual([])
    expect(w.requests).toBe(0)
    expect(w.parkCalls).toBeGreaterThan(0)
    expect(count(debug(w), UNATTENDED_WAIT(pf(93, AT)))).toBe(1)
    expect(await report($)).toContain(`⚠ tripped unattended run, policy wait. Held work continues at ${AT_OPEN}.`)
    await w.clock.set(OPENS_MS - TICK)
    await w.clock.settle()
    expect(w.ran).toEqual([])
    expect(w.requests).toBe(0)
    await pastOpen(w)
    await w.clock.settle()
    const out = await Promise.all(held)
    expect(out.map((r) => r.result)).toEqual(['ran', 'ran'])
    expect((await req).text).toBe('hi')
    expect(w.requests).toBe(1)
    await w.clock.settle()
    expect(count(transcript(w), continues(open5()))).toBe(1)
    noConsent(w)
    expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
    expect(w.asked).toEqual([])
    // New work passes: the open line once, and no second policy line.
    expect((await bash($)).result).toBe('ran')
    expect((await bash($, 'a1')).result).toBe('ran')
    expect(count(debug(w), UNATTENDED_OPEN(pf(93, AT)))).toBe(1)
    expect(count(debug(w), UNATTENDED_WAIT(pf(93, AT)))).toBe(1)
  })
}

test('-p wait with SPARE10_SIMULATE="95 weekly in 482m" continues 2 minutes after the first gated event', SLOW, async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 50, surfaces: [], env: { ...WAIT, SPARE10_SIMULATE: '95 weekly in 482m' } })
  await begin($, w)
  const end = T0 + 482 * MIN // `in` counts from the first gated event
  const start = T0 + 2 * MIN
  const held = bash($)
  const req = drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  expect(w.asked).toEqual([])
  expect(debug(w)).toContain(UNATTENDED_WAIT(pf(95, wk(end))))
  await w.clock.set(start - TICK)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  await w.clock.set(start + TICK)
  await w.clock.settle()
  expect((await held).result).toBe('ran')
  expect((await req).text).toBe('hi')
  await w.clock.settle()
  expect(count(transcript(w), continues(openWT(wk(end))))).toBe(1)
  noConsent(w)
})

test('-p wait: a weekly reading without a reset time keeps the hold past the 5-hour skip start', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 92, weekResetsAt: null, surfaces: [], env: WAIT })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  await pastOpen(w)
  await w.clock.advance(3 * TICK)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(transcript(w).filter((t) => t.endsWith('Held work continues.'))).toEqual([])
  // Only when the weekly window leaves the reserve does the hold end.
  w.weekPct = 50
  await w.clock.advance(2 * MIN)
  await w.clock.settle()
  expect((await held).result).toBe('ran')
  expect(w.asked).toEqual([])
})

for (const policy of ['wait', 'stop'] as const) {
  test(`-p ${policy}: a crossing inside the skip window passes with the open debug line once`, async ($, on) => {
    const w = world(on, { pct: 50, surfaces: [], env: { SPARE10_HEADLESS: policy } })
    await begin($, w)
    await w.clock.set(OPENS_MS + 5 * MIN)
    w.pct = 93
    expect((await bash($)).result).toBe('ran')
    expect((await drain($, step(undefined, 'T1'))).text).toBe('hi')
    expect((await bash($)).result).toBe('ran')
    expect(w.requests).toBe(1)
    expect(w.parkCalls).toBe(0)
    expect(w.asked).toEqual([])
    await w.clock.settle()
    expect(count(debug(w), UNATTENDED_OPEN(pf(93, AT)))).toBe(1)
    expect(debug(w).filter((t) => t.endsWith(`policy ${policy}.`))).toEqual([])
  })
}
