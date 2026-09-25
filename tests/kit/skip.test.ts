import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import {
  HOUR,
  LATE,
  MARGIN,
  MIN,
  OFF_OPENS,
  OFF_TICK,
  OPENS,
  RESETS,
  SKIP,
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
  newerCopy,
  pastDue,
  pastOpen,
  step,
  stopRec,
  typed,
  world,
} from '../helpers/world.ts'
import type { World } from '../helpers/world.ts'

// Skip near the reset through the engine (skip design B41 to B47, 7.3). The world has the shipped
// spans: the last 20 minutes of the 5-hour window and the last 8 hours of the weekly window open the
// reserve. Every expected text is spelled out from skip design section 2 here, not taken from
// hooks/core/text.ts, so a drift in the texts or the rules fails a test. Clocks are in the machine's
// zone, as the kit runs.

const R_MS = Date.parse(RESETS)
const O_MS = Date.parse(OPENS)
const WEEK_MS = Date.parse(WEEK_RESETS)
const WEEK_O_MS = Date.parse(WEEK_OPENS)
const at = (iso: string): number => Date.parse(iso)

// {clock} (2.1): HH:MM for the 5-hour window, `ddd HH:MM` for the weekly window.
const hhmm = (ms: number): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms))
const wk = (ms: number): string => `${new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(new Date(ms))} ${hhmm(ms)}`
const num = (n: number): string => String(Math.round(n * 10) / 10)
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

// {pf} and {mf} of one kind.
const pf = (used: number, clock: string): string => `${num(used)}% used · ${num(100 - used)}% left · resets ${clock}`
const mf = (used: number, clock: string, weekly = false): string =>
  `into your 10% ${weekly ? 'weekly ' : ''}reserve · ${num(100 - used)}% of ${weekly ? 'weekly ' : ''}quota left · resets ${clock}`

// {lead} (2.1)
const LEAD = '20 min before the reset'
const TEST_LEAD = '20 min before the test window ends'
const WEEK_LEAD = '8 h before the weekly reset'
const WEEK_TEST_LEAD = '8 h before the weekly test window ends'

// The question (2.2). `when` is `{at}` or `{at}, {lead}`.
const loopQ = (used: number, reset: string, when: string): string =>
  `Your 10% reserve is reached: ${pf(used, reset)}. All work is on hold. Continue on the reserve until ${reset}? ` +
  `If you choose Stop here or do not answer, the work waits until ${when}. Then spare10 continues it, unless a reserve is still reached.`
const weeklyLoopQ = (used: number, reset: string, when: string): string =>
  `Your 10% weekly reserve is reached: ${pf(used, reset)}. All work is on hold. Continue on the weekly reserve until ${reset}? ` +
  `If you choose Stop here or do not answer, the work waits until ${when}. Then spare10 continues it, unless a reserve is still reached.`
const loopQOff = (used: number, reset: string): string =>
  `Your 10% reserve is reached: ${pf(used, reset)}. All work is on hold. Continue on the reserve until ${reset}?` // autoResume off
const promptQ = (used: number, reset: string, when: string, until: string): string =>
  `Your 10% reserve is reached: ${pf(used, reset)}. spare10 holds your prompt and any other work. Continue on the reserve until ${reset}? ` +
  `If you do not answer, all of it continues at ${when}, unless a reserve is still reached. Stop here gives your prompt back and pauses other work until ${until}.`

// {event} parts (2.1)
const open5 = (reset: string): string => `the 5-hour window resets at ${reset}. Your 10% reserve is open until then`
const openTest = (reset: string): string => `the test window ends at ${reset}. Your 10% reserve is open until then`
const openWeek = (reset: string): string => `the weekly window resets at ${reset}. Your 10% weekly reserve is open until then`
const openWeekTest = (reset: string): string => `the weekly test window ends at ${reset}. Your 10% weekly reserve is open until then`

// Transcript notices (2.4), without the prefix that the engine adds.
const continues = (ev: string): string => `${ev}. Held work continues.`
const resumes = (ev: string): string => `${ev}. spare10 continues the stopped work.`
const stopOver = (ev: string): string => `${ev}, and the stop is over. Type a prompt to continue.`
const takenOver = (ev: string): string => `${ev}, and the stop is over.`
const waitingFor = (ev: string): string => `${ev}, but held work still waits for your answer. New work goes on with no question.`
const AGAIN = 'Type a prompt to be asked again, or run /spare10 resume.'
const stoppedSkip = (until: string, work: boolean): string =>
  `stopped at your 10% reserve until ${until}.${work ? ' Then spare10 continues the work, unless a reserve is still reached.' : ''} ${AGAIN}`
const lateSoon = (ev: string): string => `stopped at your 10% reserve. ${cap(ev)}, so spare10 continues the work soon, unless a reserve is still reached.`
const lateOpen = (ev: string): string => `stopped. Held work is refused. ${cap(ev)}, so new work goes on with no question.`

// Texts the model reads (2.3)
const STOP = (used: number, reset: string, weekly = false): string =>
  `spare10: the user stopped work at the quota reserve (${mf(used, reset, weekly)}). Stop now and wait for the user. Do not call any further tools.`
const resumePromptOpen = (ev: string): string =>
  `${cap(ev)}, so the stop at the quota reserve is over. spare10 is set to continue the work when the reserve opens, so do not wait for the user. ` +
  'Continue the task from the point where it stopped. A subagent whose result says "spare10: work stopped" or "spare10: the user stopped work" did not finish. ' +
  'Run it again if you still need its result.'
const resetNoteOpen = (ev: string): string =>
  `spare10: earlier work stopped at the quota reserve. ${cap(ev)}, so the stop is over. The stopped task is not finished. After the user's message, continue it unless the user says otherwise.`

// Held waiters check on every tick for hours of mock time: allow more than the 5 s default.
const SLOW = { timeoutMs: 20_000 }
const AUTO_OFF = { SPARE10_AUTO_RESUME: 'off' }

type Logged = Pick<World, 'logs'>
const transcript = (w: Logged): string[] => w.logs.filter((l) => l.to !== 'debug').map((l) => l.text)
const debug = (w: Logged): string[] => w.logs.filter((l) => l.to === 'debug').map((l) => l.text)
const count = (list: string[], text: string): number => list.filter((t) => t === text).length
const questions = (w: Pick<World, 'asked'>): string[] => w.asked.map((a) => a.question)
const envOf = (w: World): Record<string, string> => Object.fromEntries(w.env)

/** /spare10 as the person types it, one entry per line, with runs of white space kept. */
const report = async ($: Engine): Promise<string[]> => ((await $.command.run(cmd(''))).text ?? '').split('\n')
const run = async ($: Engine, args: string): Promise<string | undefined> => (await $.command.run(cmd(args))).text

/** The badge as the terminal draws it. Mount only after a long move (a tripped badge pulses). */
async function badgeText($: Engine): Promise<string> {
  const ui = await $.ui.mount({ plugin: 'spare10', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  const t = await ui.find({ type: 'Text', text: /spare10|Pausing|Winding/ })
  await ui.unmount()
  return t?.text ?? ''
}

// ---- B41, B42: the owner's rule ----

test('the owner example: at 14:00 with 92% used spare10 asks, at 16:25 with 93% used work runs with no question', SLOW, async ($, on) => {
  const w = world(on, { pct: 92, resetsAt: LATE })
  await w.clock.set(at('2026-09-24T14:00:00.000Z'))
  await begin($, w)
  const skipStart = at(LATE) - SKIP // 16:20
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ(92, hhmm(at(LATE)), `${hhmm(skipStart)}, ${LEAD}`)])
  await w.clock.set(skipStart - TICK)
  expect(w.ran).toEqual([])
  await pastOpen(w, new Date(skipStart).toISOString())
  expect((await held).result).toBe('ran') // at 16:20, with no margin
  w.pct = 93
  await w.clock.set(at('2026-09-24T16:25:00.000Z'))
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1) // one question in all
})

test('an unanswered question continues at the skip start with no margin', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, agents: ['a1'] })
  await begin($, w)
  const held = [bash($), bash($, 'a1')]
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ(93, hhmm(R_MS), `${hhmm(O_MS)}, ${LEAD}`)])
  await w.clock.set(O_MS - TICK)
  expect(w.ran).toEqual([])
  await pastOpen(w)
  const out = await Promise.all(held)
  expect(out.map((r) => r.result)).toEqual(['ran', 'ran'])
  expect(w.dialogAborted).not.toBe('no') // the dialog is withdrawn
  await w.clock.settle()
  expect(count(transcript(w), continues(open5(hhmm(R_MS))))).toBe(1)
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // no consent at a skip start
  expect(w.submitted).toEqual([])
  expect(w.asked).toHaveLength(1)
})

test('a crossing inside the skip window passes with no question', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  await w.clock.set(at('2026-09-24T14:45:00.000Z'))
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(await $.prompt.submit(typed('hello'))).toMatchObject({ text: 'hello' })
  expect(w.asked).toEqual([])
  expect(transcript(w).some((t) => t.includes('told the agents'))).toBe(false)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
})

test('nothing asks twice in the skip window', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Stop here' })
  await begin($, w)
  expect((await bash($)).deny).toBe(STOP(93, hhmm(R_MS)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OPENS, T0, 'five_hour,work,auto,skip'))
  await pastOpen(w)
  await w.clock.settle()
  for (let i = 0; i < 5; i += 1) {
    await w.clock.advance(MIN)
    expect((await bash($)).result).toBe('ran')
    expect(await $.prompt.submit(typed(`go ${i}`))).toMatchObject({ text: `go ${i}` })
  }
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(count(transcript(w), resumes(open5(hhmm(R_MS))))).toBe(1)
  expect(transcript(w).some((t) => t.endsWith('Held work continues.'))).toBe(false)
  expect(w.submitted).toEqual([resumePromptOpen(open5(hhmm(R_MS)))])
})

test('the badge shows reserve open until the reset, and the ticker redraws it at the skip start', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  await report($) // one read: the skip start becomes an edge of the ticker
  await w.clock.set(O_MS - 1000)
  const before = w.invalidations
  await w.clock.advance(1000 + TICK) // no event: only the edge at the skip start can redraw
  expect(w.invalidations).toBeGreaterThan(before)
  expect(await badgeText($)).toBe(` ↻ spare10: reserve open until ${hhmm(R_MS)}`)
})

test('/spare10 shows the open phase line and the reserve opens rows', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  await pastOpen(w)
  const lines = await report($)
  expect(lines[2]).toBe(`  ↻ open           the reset is near. Your 10% reserve is open until ${hhmm(R_MS)}, so spare10 lets all work through.`)
  expect(lines).toContain('  · reserve opens  in the last 20 min of the 5-hour window (from /config)')
  expect(lines).toContain('  · weekly opens   in the last 8 h of the weekly window (from /config)')
})

test('a weekly trip still gates inside the last 20 minutes of the 5-hour window', async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 92 })
  await begin($, w)
  await w.clock.set(at('2026-09-24T14:45:00.000Z'))
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([weeklyLoopQ(92, wk(WEEK_MS), `${wk(WEEK_O_MS)}, ${WEEK_LEAD}`)])
  expect(w.ran).toEqual([])
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

test('a weekly trip opens at its own skip start', SLOW, async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 92, weekResetsAt: WEEK_NEAR })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([weeklyLoopQ(92, wk(at(WEEK_NEAR)), `${wk(at(WEEK_NEAR_OPENS))}, ${WEEK_LEAD}`)])
  await w.clock.set(at(WEEK_NEAR_OPENS) - TICK)
  expect(w.ran).toEqual([])
  await pastOpen(w, WEEK_NEAR_OPENS)
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w)).toContain(continues(openWeek(wk(at(WEEK_NEAR)))))
})

test('at the 5-hour skip start with the weekly window in the reserve: a new weekly question holds every loop', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 85, agents: ['a1'] })
  await begin($, w)
  const held = [bash($), bash($, 'a1')]
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ(93, hhmm(R_MS), `${hhmm(O_MS)}, ${LEAD}`)])
  w.weekPct = 92
  await w.clock.set(O_MS - TICK)
  await pastOpen(w)
  await w.clock.settle()
  expect(transcript(w)).toContain(`${open5(hhmm(R_MS))}, but your 10% weekly reserve is reached. Held work still waits.`)
  expect(questions(w)).toEqual([
    loopQ(93, hhmm(R_MS), `${hhmm(O_MS)}, ${LEAD}`),
    weeklyLoopQ(92, wk(WEEK_MS), `${wk(WEEK_O_MS)}, ${WEEK_LEAD}`),
  ])
  expect(w.ran).toEqual([]) // no call reaches core in between
  w.release('Resume')
  expect((await Promise.all(held)).map((r) => r.result)).toEqual(['ran', 'ran'])
})

// B47: a newer copy of spare10 (after an option change) answers the spans in force.
test('a newer copy with the span at 0: the question does not continue at the old skip start', { ...SLOW, plugins: [newerCopy] }, async ($, on) => {
  const w = world(on, { pct: 93, env: { NEWER_COPY_SPANS: '20 8' } })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ(93, hhmm(R_MS), `${hhmm(O_MS)}, ${LEAD}`)])
  w.env.set('NEWER_COPY_SPANS', '0 0') // the owner set the options to 0: the newest copy answers them
  await pastOpen(w)
  await w.clock.settle()
  expect(transcript(w)).toContain('your 10% reserve is reached. Held work still waits.')
  expect(questions(w)).toEqual([loopQ(93, hhmm(R_MS), `${hhmm(O_MS)}, ${LEAD}`), loopQ(93, hhmm(R_MS), hhmm(R_MS))])
  expect(w.ran).toEqual([])
  await pastDue(w, RESETS)
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w)).toContain('the 5-hour window reset. Held work continues.')
})

test('a failed env read uses spans of 0', async ($, on) => {
  const w = world(on, { pct: 93, envGetFails: ['SPARE10_LAST_MINUTES'] })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ(93, hhmm(R_MS), hhmm(R_MS))]) // the D0.2 wording: the guard holds until the reset
  const lines = await report($)
  expect(lines).toContain('  · reserve opens  only at the reset (spare10 could not read the env)')
  expect(lines).toContain('  · weekly opens   only at the reset (spare10 could not read the env)')
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

// ---- B42, B46: Stop here and the stop ----

test('Stop here, then the skip start: one resume prompt with the open wording', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Stop here' })
  await begin($, w)
  expect((await bash($)).deny).toBe(STOP(93, hhmm(R_MS)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OPENS, T0, 'five_hour,work,auto,skip'))
  expect(transcript(w)).toContain(stoppedSkip(`${hhmm(O_MS)}, ${LEAD}`, true))
  expect(await badgeText($)).toBe(` ■ spare10: stopped until ${hhmm(O_MS)}`)
  await w.clock.set(O_MS - TICK)
  expect(w.submitted).toEqual([])
  await pastOpen(w)
  await w.clock.settle()
  expect(count(transcript(w), resumes(open5(hhmm(R_MS))))).toBe(1)
  expect(w.submitted).toEqual([resumePromptOpen(open5(hhmm(R_MS)))])
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  await w.clock.advance(5 * MIN)
  expect(w.submitted).toHaveLength(1)
})

test('Stop here on a prompt question: the stop ends at the skip start, nothing is sent', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Stop here' })
  await begin($, w)
  expect(await $.prompt.submit(typed('hello'))).toHaveProperty('drop')
  expect(questions(w)).toEqual([promptQ(93, hhmm(R_MS), `${hhmm(O_MS)}, ${LEAD}`, hhmm(O_MS))])
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OPENS, T0, 'five_hour,auto,skip'))
  expect(transcript(w)).toContain(stoppedSkip(`${hhmm(O_MS)}, ${LEAD}`, false))
  await pastOpen(w)
  await w.clock.settle()
  expect(transcript(w)).toContain(stopOver(open5(hhmm(R_MS))))
  expect(w.submitted).toEqual([])
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
})

test('Stop here after the skip start and before the check (autoResume on): no past time, one resume prompt', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: OFF_TICK })
  await begin($, w)
  const off = at(OFF_TICK)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ(93, hhmm(off), `${hhmm(at(OFF_OPENS))}, ${LEAD}`)])
  const answeredAt = at(OFF_OPENS) + 5000
  await w.clock.set(answeredAt) // past the skip start, before the tick that would release it
  expect(w.ran).toEqual([])
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(93, hhmm(off)))
  await w.clock.settle()
  expect(transcript(w)).toContain(lateSoon(open5(hhmm(off))))
  expect(transcript(w).some((t) => t.includes(`until ${hhmm(at(OFF_OPENS))}`))).toBe(false) // no past time
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OFF_OPENS, answeredAt, 'five_hour,work,auto,skip'))
  expect(w.submitted).toEqual([])
  await w.clock.advance(TICK) // the next tick
  await w.clock.settle()
  expect(w.submitted).toEqual([resumePromptOpen(open5(hhmm(off)))])
  await w.clock.advance(3 * TICK)
  expect(w.submitted).toHaveLength(1)
})

test('a person prompt after the skip start and before the tick takes the stop over with the open note', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: OFF_TICK, answer: 'Stop here' })
  await begin($, w)
  const off = at(OFF_TICK)
  expect((await bash($)).deny).toBe(STOP(93, hhmm(off)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OFF_OPENS, T0, 'five_hour,work,auto,skip'))
  await w.clock.set(at(OFF_OPENS) + 5000)
  expect(await $.prompt.submit(typed('go on'))).toMatchObject({ text: 'go on' })
  expect(w.prompts.map((p) => p.context)).toEqual([[resetNoteOpen(open5(hhmm(off)))]])
  await w.clock.settle()
  expect(transcript(w)).toContain(takenOver(open5(hhmm(off))))
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  await w.clock.advance(3 * TICK)
  expect(w.submitted).toEqual([]) // no resume prompt after the next tick
  expect(w.asked).toHaveLength(1)
})

test('a prompt question open in a stopped session: at the skip start the prompt goes in with the note, and no resume prompt comes', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Stop here' })
  await begin($, w)
  expect((await bash($)).deny).toBe(STOP(93, hhmm(R_MS)))
  await w.clock.settle()
  w.answer = 'hang'
  await w.clock.advance(MIN)
  const p = $.prompt.submit(typed('go on')) // the stop holds a person prompt: it asks
  await w.clock.settle()
  expect(questions(w)).toHaveLength(2)
  expect(questions(w)[1]).toBe(promptQ(93, hhmm(R_MS), `${hhmm(O_MS)}, ${LEAD}`, hhmm(O_MS)))
  await pastOpen(w)
  expect(await p).toMatchObject({ text: 'go on' })
  expect(w.prompts.map((e) => e.context)).toEqual([[resetNoteOpen(open5(hhmm(R_MS)))]])
  await w.clock.settle()
  expect(transcript(w)).toContain(takenOver(open5(hhmm(R_MS))))
  await w.clock.advance(3 * TICK)
  expect(w.submitted).toEqual([])
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
})

test('/spare10 resume after the skip start and before the tick: the open overdue reply, no resume prompt', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: OFF_TICK, answer: 'Stop here' })
  await begin($, w)
  const off = at(OFF_TICK)
  expect((await bash($)).deny).toBe(STOP(93, hhmm(off)))
  await w.clock.settle()
  await w.clock.set(at(OFF_OPENS) + 5000)
  expect(await run($, 'resume')).toBe(stopOver(open5(hhmm(off))))
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  await w.clock.advance(3 * TICK)
  expect(w.submitted).toEqual([])
  expect((await bash($)).result).toBe('ran')
})

test('/spare10 stop after the skip start and before the tick: the stop is over, no resume prompt, the next call runs', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: OFF_TICK, answer: 'Stop here' })
  await begin($, w)
  const off = at(OFF_TICK)
  expect((await bash($)).deny).toBe(STOP(93, hhmm(off)))
  await w.clock.settle()
  await w.clock.set(at(OFF_OPENS) + 5000)
  expect(await run($, 'stop')).toBe(
    `the stop is over, because the reset is near. Your 10% reserve is open until ${hhmm(off)}. spare10 will not continue the stopped work.`,
  )
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined() // cleared, and no new record
  await w.clock.advance(3 * TICK)
  expect(w.submitted).toEqual([])
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('a stop that another kind still gates at the skip start is extended until that kind\'s hold end', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 85, answer: 'Stop here' })
  await begin($, w)
  expect((await bash($)).deny).toBe(STOP(93, hhmm(R_MS)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OPENS, T0, 'five_hour,work,auto,skip'))
  w.weekPct = 92
  await pastOpen(w)
  await w.clock.settle()
  expect(transcript(w)).toContain(
    `${open5(hhmm(R_MS))}, but your 10% weekly reserve is reached. The stop lasts until ${wk(WEEK_O_MS)}, ${WEEK_LEAD}.`,
  )
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', WEEK_OPENS, T0, 'seven_day,work,auto,skip'))
  expect(w.submitted).toEqual([])
  expect((await bash($)).deny).toBe(STOP(92, wk(WEEK_MS), true))
})

// ---- B43: autoResume off near the reset ----

test('autoResume off: the question stays past the skip start with one note, new work passes, and a late Resume consents until the reset', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, env: AUTO_OFF })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQOff(93, hhmm(R_MS))])
  await pastOpen(w)
  await w.clock.advance(3 * MIN)
  await w.clock.settle()
  expect(count(transcript(w), waitingFor(open5(hhmm(R_MS))))).toBe(1)
  expect(w.asked).toHaveLength(1) // the dialog stays
  expect(w.ran).toEqual([]) // held work still waits
  expect((await bash($, undefined, 'new')).result).toBe('ran') // new work passes with no question
  expect(w.ran).toEqual(['Bash:main'])
  const lines = await report($)
  expect(lines[2]).toBe(
    `  ? asking         a question is open. Held work waits until you answer. Your 10% reserve is open until ${hhmm(R_MS)}, so new work goes on. If no dialog shows, run /spare10 resume or /spare10 stop.`,
  )
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`) // a Resume consents until the reset
  expect(w.asked).toHaveLength(1)
})

test('autoResume off: when the weekly window gates at the 5-hour skip start, neither the note nor the report says that new work goes on', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 85, env: AUTO_OFF })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQOff(93, hhmm(R_MS))])
  w.weekPct = 92 // the weekly window reaches its reserve while the question waits
  await pastOpen(w)
  await w.clock.advance(3 * MIN)
  await w.clock.settle()
  const notes = transcript(w).filter((t) => t.includes('waits for your answer'))
  expect(notes).toEqual([`${open5(hhmm(R_MS))}, but held work still waits for your answer.`]) // one note, no new-work sentence
  expect((await report($))[2]).toBe(
    '  ? asking         a question is open. Held work waits until you answer. If no dialog shows, run /spare10 resume or /spare10 stop.',
  )
  const next = bash($, undefined, 'new')
  await w.clock.settle()
  expect(w.ran).toEqual([]) // the weekly window holds new work: it joins the open question
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(93, hhmm(R_MS)))
  expect((await next).deny).toBeDefined()
})

test('autoResume off: Stop here ends at the skip start, and the next prompt goes in with no question', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, env: AUTO_OFF, answer: 'Stop here' })
  await begin($, w)
  expect((await bash($)).deny).toBe(STOP(93, hhmm(R_MS)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OPENS, T0, 'five_hour,work,skip'))
  expect(transcript(w)).toContain(stoppedSkip(`${hhmm(O_MS)}, ${LEAD}`, false))
  expect(await badgeText($)).toBe(` ■ spare10: stopped until ${hhmm(O_MS)}`) // a skip stop shows its end with autoResume off too
  expect((await report($))[2]).toBe(`  ■ stopped        you chose Stop here, until ${hhmm(O_MS)}. ${AGAIN}`)
  await w.clock.set(at('2026-09-24T14:41:00.000Z'))
  expect(await $.prompt.submit(typed('go on'))).toMatchObject({ text: 'go on' })
  expect(w.prompts.map((p) => p.context)).toEqual([undefined]) // no note: nothing continues without the person
  await w.clock.advance(3 * TICK)
  expect(w.submitted).toEqual([])
  expect(w.asked).toHaveLength(1)
})

test('autoResume off: Stop here after the skip start refuses the held work, writes nothing, and says new work goes on', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, env: AUTO_OFF })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  await pastOpen(w)
  await w.clock.settle()
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(93, hhmm(R_MS)))
  await w.clock.settle()
  expect(transcript(w)).toContain(lateOpen(open5(hhmm(R_MS))))
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('autoResume off: /spare10 stop on a question after its skip start writes nothing and says new work goes on', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, env: AUTO_OFF })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  await pastOpen(w)
  await w.clock.settle()
  expect(await run($, 'stop')).toBe(lateOpen(open5(hhmm(R_MS))))
  expect((await held).deny).toBe(STOP(93, hhmm(R_MS)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect((await bash($)).result).toBe('ran')
})

test('autoResume off, a test reading over a real trip: Stop here after the test skip start stops until the real skip start', SLOW, async ($, on) => {
  const w = world(on, { pct: 92, env: AUTO_OFF })
  await begin($, w)
  expect(await run($, 'simulate 95 in 22m')).toBe(
    `test reading set to 95% used, resets ${hhmm(T0 + 22 * MIN)}. It can only raise the real reading. The real reading is also in the reserve, so the test window does not open it. Run /spare10 simulate off to clear it.`,
  )
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQOff(95, hhmm(T0 + 22 * MIN))])
  await w.clock.set(T0 + 2 * MIN + TICK)
  await w.clock.settle()
  expect(transcript(w).filter((t) => t.includes('waits for your answer'))).toEqual([]) // no note at the test skip start
  await w.clock.set(T0 + 3 * MIN)
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(95, hhmm(T0 + 22 * MIN)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OPENS, T0 + 3 * MIN, 'five_hour,work,skip')) // the real kind, no test tag
  expect(transcript(w)).toContain(stoppedSkip(`${hhmm(O_MS)}, ${LEAD}`, false))
  expect((await bash($)).deny).toBe(STOP(92, hhmm(R_MS))) // refused on the real reading, no new question
  expect(w.asked).toHaveLength(1)
})

test('autoResume off, a test reading over a real trip: the note waits for the real skip start', SLOW, async ($, on) => {
  const w = world(on, { pct: 92, env: AUTO_OFF })
  await begin($, w)
  await run($, 'simulate 95 in 22m')
  const held = bash($)
  await w.clock.settle()
  await w.clock.set(O_MS - TICK)
  expect(transcript(w).filter((t) => t.includes('waits for your answer'))).toEqual([])
  await pastOpen(w)
  await w.clock.advance(2 * MIN)
  await w.clock.settle()
  expect(transcript(w).filter((t) => t.includes('waits for your answer'))).toEqual([waitingFor(open5(hhmm(R_MS)))])
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

test('autoResume off: Stop here after the test window ended names no time that has passed', SLOW, async ($, on) => {
  const w = world(on, { pct: 50, env: AUTO_OFF })
  await begin($, w)
  const end = T0 + 22 * MIN
  await run($, 'simulate 95 in 22m')
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQOff(95, hhmm(end))])
  await w.clock.set(end + 3 * MIN) // past the skip start and the end of the test window, with no answer
  await w.clock.settle()
  expect(count(transcript(w), waitingFor(openTest(hhmm(end))))).toBe(1) // the one note at the skip start
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(95, hhmm(end)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', T0 + 2 * MIN, end + 3 * MIN, 'five_hour,work,test,skip'))
  expect(transcript(w)).toContain(`stopped at your 10% reserve. ${AGAIN}`) // the D0.2 text: the stop already ended by time
  expect(transcript(w).filter((t) => t.startsWith('stopped at your 10% reserve until'))).toEqual([])
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

// ---- B44: no stop while the reserve is open ----

test('/spare10 stop inside the skip window stops nothing and says the reserve is open', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  await w.clock.set(at('2026-09-24T14:45:00.000Z'))
  const env = envOf(w)
  expect(await run($, 'stop')).toBe(
    `nothing to stop. The reset is near, so your 10% reserve is open until ${hhmm(R_MS)}. To keep a reserve until the reset, set its Open reserve option to 0 in /config.`,
  )
  expect(envOf(w)).toEqual(env) // no env writes
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
})

test('/spare10 stop inside the skip window keeps a consent', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_CONSENT: `S1 ${RESETS}` } })
  await begin($, w)
  await w.clock.set(at('2026-09-24T14:45:00.000Z'))
  expect(await run($, 'stop')).toStartWith('nothing to stop. The reset is near')
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
})

test('/spare10 stop inside the 5-hour skip window with the weekly window in the reserve stops the weekly window only', async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 92 })
  await begin($, w)
  const now = at('2026-09-24T14:45:00.000Z')
  await w.clock.set(now)
  expect(await run($, 'stop')).toBe(
    `stopped at the reserve until ${wk(WEEK_O_MS)}, ${WEEK_LEAD}. Then spare10 continues any stopped work. ${AGAIN}`,
  )
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', WEEK_OPENS, now, 'seven_day,auto,skip'))
  expect((await bash($)).deny).toBe(STOP(92, wk(WEEK_MS), true))
})

// The skip design is split here: B44 and 2.8 stop only the kinds that gate, 3.5 the tripped kinds that
// are not open. The code follows 3.5, the side that keeps the quota: the person asked to stop, and a
// weekly consent is not a reason to spend the weekly reserve after that.
test('/spare10 stop inside the 5-hour skip window with a weekly consent stops the weekly window and clears the consent', async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 92, env: { SPARE10_WEEKLY_CONSENT: `S1 ${WEEK_RESETS}` } })
  await begin($, w)
  const now = at('2026-09-24T14:45:00.000Z')
  await w.clock.set(now)
  expect((await bash($)).result).toBe('ran') // the 5-hour window is open, the weekly window consented
  expect(await run($, 'stop')).toBe(
    `stopped at the reserve until ${wk(WEEK_O_MS)}, ${WEEK_LEAD}. Then spare10 continues any stopped work. ${AGAIN}`,
  )
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', WEEK_OPENS, now, 'seven_day,auto,skip'))
  expect(w.env.has('SPARE10_WEEKLY_CONSENT')).toBe(false)
  expect((await bash($)).deny).toBe(STOP(92, wk(WEEK_MS), true))
})

test('a 0.1 stop value inside the skip window holds nothing', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_STOPPED: `S1 ${R_MS} ${T0}` } })
  await begin($, w)
  expect((await bash($)).deny).toBe(STOP(93, hhmm(R_MS))) // before the skip start it stops, as in 0.1
  await w.clock.set(at('2026-09-24T14:45:00.000Z'))
  expect((await bash($)).result).toBe('ran')
  expect(await $.prompt.submit(typed('go on'))).toMatchObject({ text: 'go on' })
  await w.clock.advance(5 * MIN)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  expect(w.submitted).toEqual([])
})

test('/spare10 resume inside the skip window says the reserve is open and writes nothing', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  await w.clock.set(at('2026-09-24T14:45:00.000Z'))
  const env = envOf(w)
  expect(await run($, 'resume')).toBe(`nothing to resume. The reset is near, so your 10% reserve is open until ${hhmm(R_MS)}.`)
  expect(envOf(w)).toEqual(env)
})

// ---- B41: a reading without a reset time keeps the guard ----

test('a reading without resetsAt keeps the guard', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: null })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  const end = T0 + 5 * HOUR // the first sight plus one window
  expect(questions(w)).toEqual([
    `Your 10% reserve is reached: ${num(93)}% used · 7% left · resets at an unknown time. All work is on hold. Continue on the reserve for one hour? ` +
      `If you choose Stop here or do not answer, the work waits until ${hhmm(end)}. Then spare10 continues it, unless a reserve is still reached.`,
  ])
  await w.clock.set(T0 + 4 * HOUR + 40 * MIN + TICK)
  expect(w.ran).toEqual([])
  await w.clock.set(end + MARGIN - TICK)
  expect(w.ran).toEqual([])
  await w.clock.set(end + MARGIN + TICK)
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w)).toContain('the 5-hour window reset. Held work continues.')
})

test('a reading without resetsAt asked late keeps the D0.2 notice', SLOW, async ($, on) => {
  const w = world(on, { pct: 50, resetsAt: null })
  await begin($, w)
  expect((await bash($)).result).toBe('ran') // the first sight at T0
  await w.clock.set(T0 + 4 * HOUR + 30 * MIN)
  w.pct = 93 // a rise keeps the first sight
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)[0]).toContain(`the work waits until ${hhmm(T0 + 5 * HOUR)}. Then`)
  await pastDue(w, new Date(T0 + 5 * HOUR).toISOString())
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w)).toContain('the 5-hour window reset. Held work continues.')
})

test('a kind whose due lies after another kind\'s skip start keeps its margin', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Stop here', env: { SPARE10_WEEKLY_LAST_HOURS: '0' } })
  await begin($, w)
  const testEnd = O_MS - 30_000 // a weekly test window that ends 30 s before the 5-hour skip start
  expect(await run($, `simulate 95 weekly in ${(testEnd - T0) / 1000}s`)).toStartWith('test reading set to 95% used of the weekly window')
  expect((await bash($)).deny).toBe(
    `spare10: the user stopped work at the quota reserve (${mf(93, hhmm(R_MS))}, and ${mf(95, wk(testEnd), true)}). Stop now and wait for the user. Do not call any further tools.`,
  )
  // The D0.2 wording: the weekly test window is due 60 s after its end, after the 5-hour skip start.
  expect(questions(w)[0]).toEndWith(`the work waits until ${wk(O_MS)}. Then spare10 continues it, unless a reserve is still reached.`)
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OPENS, T0, 'five_hour,seven_day,work,auto')) // no skip tag
  await w.clock.set(O_MS + MARGIN - TICK)
  expect(w.submitted).toEqual([])
  await w.clock.set(O_MS + MARGIN + TICK) // released at its end plus the margin
  await w.clock.settle()
  expect(w.submitted).toHaveLength(1)
  expect(transcript(w)).toContain(resumes(`the weekly window reset. ${cap(open5(hhmm(R_MS)))}`))
})

// ---- B45: test readings near the reset ----

test('a test reading in 22m opens 2 minutes later, with no margin', SLOW, async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  const end = T0 + 22 * MIN
  expect(await run($, 'simulate 95 in 22m')).toBe(
    `test reading set to 95% used, resets ${hhmm(end)}. It can only raise the real reading. The reserve opens at ${hhmm(T0 + 2 * MIN)}, ${TEST_LEAD}. Run /spare10 simulate off to clear it.`,
  )
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ(95, hhmm(end), `${hhmm(T0 + 2 * MIN)}, ${TEST_LEAD}`)])
  await w.clock.set(T0 + 2 * MIN - TICK)
  expect(w.ran).toEqual([])
  await w.clock.set(T0 + 2 * MIN + TICK)
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w)).toContain(continues(openTest(hhmm(end))))
  expect(await badgeText($)).toBe(` ↻ spare10 (test): reserve open until ${hhmm(end)}`)
})

test('a test reading in 22m over a real trip opens nothing: a new question holds until the real skip start', SLOW, async ($, on) => {
  const w = world(on, { pct: 92 })
  await begin($, w)
  const end = T0 + 22 * MIN
  expect(await run($, 'simulate 95 in 22m')).toBe(
    `test reading set to 95% used, resets ${hhmm(end)}. It can only raise the real reading. The real reading is also in the reserve, so the test window does not open it. Run /spare10 simulate off to clear it.`,
  )
  const held = bash($)
  await w.clock.settle()
  await w.clock.set(T0 + 2 * MIN + TICK)
  await w.clock.settle()
  expect(transcript(w)).toContain('your 10% reserve is reached. Held work still waits.')
  expect(questions(w)).toEqual([
    loopQ(95, hhmm(end), `${hhmm(T0 + 2 * MIN)}, ${TEST_LEAD}`),
    loopQ(92, hhmm(R_MS), `${hhmm(O_MS)}, ${LEAD}`),
  ])
  expect(w.ran).toEqual([])
  await w.clock.set(O_MS - TICK)
  expect(w.ran).toEqual([])
  await pastOpen(w)
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w)).toContain(continues(open5(hhmm(R_MS))))
})

test('simulate 95 in 10m is open at once, and the reply says so', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  const end = T0 + 10 * MIN
  expect(await run($, 'simulate 95 in 10m')).toBe(
    `test reading set to 95% used, resets ${hhmm(end)}. It can only raise the real reading. The test window ends within 20 min, so the reserve is open at once. Run /spare10 simulate off to clear it.`,
  )
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  expect(await badgeText($)).toBe(` ↻ spare10 (test): reserve open until ${hhmm(end)}`)
})

test('simulate 95 weekly in 482m opens the weekly reserve 2 minutes later', SLOW, async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 50 })
  await begin($, w)
  const end = T0 + 482 * MIN
  expect(await run($, 'simulate 95 weekly in 482m')).toBe(
    `test reading set to 95% used of the weekly window, resets ${wk(end)}. It can only raise the real reading. The weekly reserve opens at ${wk(T0 + 2 * MIN)}, ${WEEK_TEST_LEAD}. Run /spare10 simulate off to clear it.`,
  )
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([weeklyLoopQ(95, wk(end), `${wk(T0 + 2 * MIN)}, ${WEEK_TEST_LEAD}`)])
  await w.clock.set(T0 + 2 * MIN - TICK)
  expect(w.ran).toEqual([])
  await w.clock.set(T0 + 2 * MIN + TICK)
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w)).toContain(continues(openWeekTest(wk(end))))
})

// ---- 5.2: the options and the env ----

test('SPARE10_LAST_MINUTES=0 keeps the D0.2 timing', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_LAST_MINUTES: '0' } })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ(93, hhmm(R_MS), hhmm(R_MS))])
  expect(await report($)).toContain('  · reserve opens  only at the reset (from SPARE10_LAST_MINUTES)')
  await pastOpen(w)
  expect(w.ran).toEqual([])
  await w.clock.set(R_MS + MARGIN - TICK)
  expect(w.ran).toEqual([])
  await pastDue(w, RESETS)
  expect((await held).result).toBe('ran')
})

test('a bad SPARE10_LAST_MINUTES warns and keeps 20', async ($, on) => {
  const w = world(on, { pct: 50, env: { SPARE10_LAST_MINUTES: '300' } })
  await begin($, w)
  expect(count(transcript(w), 'SPARE10_LAST_MINUTES="300" is not 0 to 299. spare10 uses 20.')).toBe(1)
  const lines = await report($)
  expect(lines).toContain('  · reserve opens  in the last 20 min of the 5-hour window (from /config)')
  expect(lines).toContain('  ⚠ SPARE10_LAST_MINUTES="300" is not 0 to 299. spare10 uses 20.')
})

test('SPARE10_WEEKLY_LAST_HOURS=0 keeps the weekly guard until the weekly reset', SLOW, async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 92, weekResetsAt: WEEK_NEAR, env: { SPARE10_WEEKLY_LAST_HOURS: '0' } })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([weeklyLoopQ(92, wk(at(WEEK_NEAR)), wk(at(WEEK_NEAR)))])
  expect(await report($)).toContain('  · weekly opens   only at the reset (from SPARE10_WEEKLY_LAST_HOURS)')
  await pastOpen(w, WEEK_NEAR_OPENS)
  await w.clock.advance(MIN)
  expect(w.ran).toEqual([])
  expect(w.asked).toHaveLength(1)
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

// ---- 4.2: tell mode and unattended runs ----

test('tell mode: inside the skip window no loop is told, and a prompt goes in with no question', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_PAUSE_PROMPT: 'Commit and stop.' }, agents: ['a1'] })
  await begin($, w)
  await w.clock.set(at('2026-09-24T14:45:00.000Z'))
  for (const id of [undefined, 'a1']) {
    const r = await bash($, id)
    expect(r.result).toBe('ran')
    expect(r.context).toBeUndefined()
  }
  expect(await $.prompt.submit(typed('hello'))).toMatchObject({ text: 'hello' })
  expect(w.asked).toEqual([])
  expect(debug(w).filter((t) => t.startsWith('spare10: told '))).toEqual([])
  expect(transcript(w).some((t) => t.includes('told the agents'))).toBe(false)
})

test('-p wait holds until the skip start and continues with no margin', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'wait' } })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toEqual([]) // a silent hold
  expect((await report($))[2]).toBe(`  ⚠ tripped        unattended run, policy wait. Held work continues at ${hhmm(O_MS)}.`)
  await w.clock.set(O_MS - TICK)
  expect(w.ran).toEqual([])
  await pastOpen(w)
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w)).toContain(continues(open5(hhmm(R_MS))))
})

for (const policy of ['stop', 'prompt'] as const) {
  test(`-p ${policy} lets work through inside the skip window`, async ($, on) => {
    const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: policy } })
    await begin($, w)
    await w.clock.set(at('2026-09-24T14:45:00.000Z'))
    const r = await bash($)
    expect(r.result).toBe('ran')
    expect(r.deny).toBeUndefined()
    expect(r.context).toBeUndefined() // no pause instruction
    expect((await drain($, step())).text).toBe('hi')
    expect((await bash($)).result).toBe('ran')
    const open = `spare10: unattended run inside the reserve (${pf(93, hhmm(R_MS))}), but the reset is near. spare10 lets it through.`
    expect(debug(w).filter((t) => t.startsWith('spare10: unattended run'))).toEqual([open]) // once, and no policy line
  })
}

test('-p wait with SPARE10_SIMULATE="95 in 22m" continues 2 minutes after the first gated event', SLOW, async ($, on) => {
  const w = world(on, { pct: 50, surfaces: [], env: { SPARE10_HEADLESS: 'wait', SPARE10_SIMULATE: '95 in 22m' } })
  await begin($, w)
  const first = T0 + 10 * MIN
  await w.clock.set(first) // the test reading starts at the first event that reads the quota
  const held = bash($)
  await w.clock.settle()
  await w.clock.set(first + 2 * MIN - TICK)
  expect(w.ran).toEqual([])
  await w.clock.set(first + 2 * MIN + TICK)
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w)).toContain(continues(openTest(hhmm(first + 22 * MIN))))
})
