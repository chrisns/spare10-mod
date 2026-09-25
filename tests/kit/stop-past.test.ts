import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { HOUR, LATER, MIN, OFF_OPENS, OFF_TICK, OPENS, RESETS, T0, TICK, WEEK_RESETS, bash, begin, cmd, newerCopy, real5, real7, stopRe, stopRec, typed, world } from '../helpers/world.ts'
import type { World } from '../helpers/world.ts'

// TS1: a stop past its end that still holds. A test skip start over a real trip (B45), or an open time
// lowered after the stop (B47), leaves a kind that gates after the stop's until. The stop then holds
// while the real reading of a kind with the `real` tag gates in the window of that tag: the tag keeps
// the reset of the real reading when it was written. It holds with no memory in this copy: after a
// reload (a fresh world with the stop in the env), after a change of the open time (which is a reload),
// and after a reset that moves by a second. Each reload test presets the value that the same-copy test
// before it proves this build writes. Tell mode gets the same stop: a call is refused, a person prompt
// asks, and nothing says that the window reset or that the stop is over.

const SLOW = { timeoutMs: 30_000 }
const AUTO_OFF = { SPARE10_AUTO_RESUME: 'off' }
const TELL = { SPARE10_PAUSE_PROMPT: 'Commit and stop.' }
const SPAN0 = { SPARE10_LAST_MINUTES: '0' }

const R_MS = Date.parse(RESETS) // the real 5-hour reset
const O_MS = Date.parse(OPENS) // its skip start
const OT_MS = Date.parse(OFF_TICK) // a reset 15 s off the tick grid
const OO_MS = Date.parse(OFF_OPENS) // its skip start
const SIM_AT = T0 + 15_000 // simulate here: the test skip start lies 15 s off the tick grid
const SIM_END = SIM_AT + 22 * MIN // the test reset
const SIM_OPENS = SIM_AT + 2 * MIN // the test skip start
const IN_GAP = SIM_OPENS + 5000 // after the test skip start, before the tick after it

// The values this build writes (each proven by a same-copy test below).
const SIM_STOP_AUTO = stopRec('S1', SIM_OPENS, SIM_AT, `five_hour,work,auto,test,skip,${real5(RESETS)}`)
const SIM_STOP_OFF = stopRec('S1', SIM_OPENS, SIM_AT, `five_hour,work,test,skip,${real5(RESETS)}`)
const OFF_STOP_AUTO = stopRec('S1', OO_MS, T0, `five_hour,work,auto,skip,${real5(OFF_TICK)}`)
const OFF_STOP_OFF = stopRec('S1', OO_MS, T0, `five_hour,work,skip,${real5(OFF_TICK)}`)

const hhmm = (ms: number): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
const mf = (used: number, ms = R_MS): string => `into your 10% reserve · ${100 - used}% of quota left · resets ${hhmm(ms)}`
const STOP = (m: string): string =>
  `spare10: the user stopped work at the quota reserve (${m}). Stop now and wait for the user. Do not call any further tools.`

type Logs = Pick<World, 'logs'>
const transcript = (w: Logs): string[] => w.logs.filter((l) => l.to !== 'debug').map((l) => l.text)
/** Notices that would say the stop ended early: the stop is over, it ended, or the window reset. */
const overNotes = (w: Logs): string[] =>
  transcript(w).filter((t) => t.includes('the stop is over') || t.includes('stop ended') || t.includes('window reset'))

async function run($: Engine, args: string): Promise<string | undefined> {
  return (await $.command.run(cmd(args))).text
}

/** A Bash call that must be refused with no dialog. */
async function refused($: Engine, w: World, text: string, agentId?: string): Promise<void> {
  const before = w.asked.length
  const call = bash($, agentId)
  await w.clock.settle()
  expect(w.asked).toHaveLength(before) // no question: the stop holds
  const r = await call
  expect(r.deny).toBe(text)
  expect(r.result).toBeUndefined()
}

/** A person prompt that must ask, and that Stop here drops: nothing goes in, and no note says to continue. */
async function asks($: Engine, w: World): Promise<void> {
  const before = w.asked.length
  const prompts = w.prompts.length
  const p = $.prompt.submit(typed('go on'))
  await w.clock.settle()
  expect(w.asked).toHaveLength(before + 1)
  w.release('Stop here')
  expect((await p).drop).toBeDefined()
  await w.clock.settle()
  expect(w.prompts).toHaveLength(prompts)
}

/** A told call on a tripped reading in tell mode: it runs, with the pause text. */
async function told($: Engine, w: World): Promise<void> {
  const r = await bash($)
  expect(r.result).toBe('ran')
  expect(r.context?.[0]).toContain('spare10 budget guard.')
  await w.clock.settle()
}

/** A real trip at 92, a test window in 22m over it from SIM_AT. Tell mode: a told call, then /spare10 stop and a refused call. */
async function simStopTell($: Engine, w: World): Promise<void> {
  await begin($, w)
  await w.clock.set(SIM_AT)
  await run($, 'simulate 95 in 22m')
  await told($, w)
  await run($, 'stop')
  await refused($, w, STOP(mf(95, SIM_END))) // a refused call adds work
  await w.clock.settle()
}

// ---- P2: a test skip stop over a real trip, autoResume off, tell mode ----

test('P2 same copy, tell mode, autoResume off: /spare10 stop over a test window writes the real tag, and past the test skip start the stop still holds', SLOW, async ($, on) => {
  const w = world(on, { floors: 'off', pct: 92, env: { ...AUTO_OFF, ...TELL } })
  await simStopTell($, w)
  expect(w.env.get('SPARE10_STOPPED')).toBe(SIM_STOP_OFF)
  await w.clock.set(IN_GAP + TICK) // past the test skip start and its tick: spare10 never extends this stop
  await refused($, w, STOP(mf(92)))
  await asks($, w)
  await refused($, w, STOP(mf(92)))
  expect(w.env.get('SPARE10_STOPPED')).toBe(SIM_STOP_OFF)
  expect(overNotes(w)).toEqual([])
  expect(w.ran).toEqual(['Bash:main']) // the told call only
})

test('P2 reload, tell mode, autoResume off: the stop past its until over a real trip of the same window still refuses calls and asks for a prompt', SLOW, async ($, on) => {
  const w = world(on, { pct: 92, env: { ...AUTO_OFF, ...TELL, SPARE10_STOPPED: SIM_STOP_OFF } })
  await w.clock.set(IN_GAP + TICK)
  await begin($, w) // a new copy: no test reading, no memory
  await refused($, w, STOP(mf(92)))
  await refused($, w, STOP(mf(92)))
  await asks($, w)
  expect(w.env.get('SPARE10_STOPPED')).toBe(SIM_STOP_OFF) // a Stop here in tell mode writes nothing: the stop stays
  await w.clock.set(O_MS - TICK)
  await refused($, w, STOP(mf(92)))
  expect(overNotes(w)).toEqual([])
  expect(w.ran).toEqual([])
})

test('P2 reload, hold mode, autoResume off: the same stop refuses calls with no question', SLOW, async ($, on) => {
  const w = world(on, { pct: 92, env: { ...AUTO_OFF, SPARE10_STOPPED: SIM_STOP_OFF } })
  await w.clock.set(IN_GAP + TICK)
  await begin($, w)
  await refused($, w, STOP(mf(92)))
  expect(w.env.get('SPARE10_STOPPED')).toBe(SIM_STOP_OFF)
  expect(w.ran).toEqual([])
})

// ---- P3: the same stop with autoResume on, in the gap before the tick ----

test('P3 same copy, tell mode, autoResume on: the test skip stop over a real trip writes the real tag, and in the gap a subagent call and a main call are refused and a prompt asks', SLOW, async ($, on) => {
  const w = world(on, { floors: 'off', pct: 92, agents: ['a1'], env: TELL })
  await simStopTell($, w)
  expect(w.env.get('SPARE10_STOPPED')).toBe(SIM_STOP_AUTO)
  await w.clock.set(IN_GAP)
  await refused($, w, STOP(mf(92)), 'a1')
  await refused($, w, STOP(mf(92)))
  await asks($, w)
  expect(w.env.get('SPARE10_STOPPED')).toBe(SIM_STOP_AUTO)
  expect(overNotes(w)).toEqual([])
  expect(w.submitted).toEqual([])
  expect(w.ran).toEqual(['Bash:main'])
})

test('P3 reload, tell mode, autoResume on: in the gap a subagent call and a main call are refused, a prompt asks, and the tick extends the stop', SLOW, async ($, on) => {
  const w = world(on, { pct: 92, agents: ['a1'], env: { ...TELL, SPARE10_STOPPED: SIM_STOP_AUTO } })
  await w.clock.set(IN_GAP)
  await begin($, w)
  await refused($, w, STOP(mf(92)), 'a1')
  await refused($, w, STOP(mf(92)))
  await asks($, w)
  expect(w.env.get('SPARE10_STOPPED')).toBe(SIM_STOP_AUTO)
  await w.clock.advance(2 * TICK)
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', O_MS, SIM_AT, `five_hour,work,auto,skip,${real5(RESETS)}`)) // extended to the real skip start
  await refused($, w, STOP(mf(92)))
  expect(overNotes(w)).toEqual([])
  expect(w.submitted).toEqual([])
  expect(w.ran).toEqual([])
})

test('P3 reload, hold mode, autoResume on: in the gap the calls are refused with no question, and the tick extends the stop', SLOW, async ($, on) => {
  const w = world(on, { pct: 92, agents: ['a1'], env: { SPARE10_STOPPED: SIM_STOP_AUTO } })
  await w.clock.set(IN_GAP)
  await begin($, w)
  await refused($, w, STOP(mf(92)), 'a1')
  await refused($, w, STOP(mf(92)))
  await w.clock.advance(2 * TICK)
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', O_MS, SIM_AT, `five_hour,work,auto,skip,${real5(RESETS)}`))
  expect(w.submitted).toEqual([])
  expect(w.ran).toEqual([])
})

// ---- P4: the same copy, a test reading over a real trip, and a newer copy sets the open time to 0 ----

test('P4 same copy, tell mode, autoResume on: a test view over a real trip with the span set to 0 by a newer copy still holds in the gap', { ...SLOW, plugins: [newerCopy] }, async ($, on) => {
  const w = world(on, { floors: 'off', pct: 92, env: TELL })
  await simStopTell($, w)
  expect(w.env.get('SPARE10_STOPPED')).toBe(SIM_STOP_AUTO)
  w.env.set('NEWER_COPY_SPANS', '0 0') // the test reading never opens now: it shows on top of the real one
  await w.clock.set(IN_GAP)
  await refused($, w, STOP(mf(95, SIM_END)))
  await asks($, w)
  expect(w.env.get('SPARE10_STOPPED')).toBe(SIM_STOP_AUTO)
  expect(overNotes(w)).toEqual([])
  expect(w.ran).toEqual(['Bash:main'])
})

test('P4 same copy, hold mode, autoResume on: the same, with no new question for a call', { ...SLOW, plugins: [newerCopy] }, async ($, on) => {
  const w = world(on, { floors: 'off', pct: 92 })
  await begin($, w)
  await w.clock.set(SIM_AT)
  await run($, 'simulate 95 in 22m')
  await run($, 'stop')
  await refused($, w, STOP(mf(95, SIM_END)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(SIM_STOP_AUTO)
  w.env.set('NEWER_COPY_SPANS', '0 0')
  await w.clock.set(IN_GAP)
  await refused($, w, STOP(mf(95, SIM_END)))
  await asks($, w)
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stopRe('S1', `five_hour,work,auto,test,${real5(RESETS)}`)) // Stop here: until the test reset
  expect(w.ran).toEqual([])
})

// ---- A Stop here whose sense fails: the real kinds of the question, fail closed ----

test('a Stop here whose sense fails writes the real tag of the question, and the stop still holds past the test skip start', SLOW, async ($, on) => {
  const w = world(on, { floors: 'off', pct: 92, env: AUTO_OFF })
  await begin($, w)
  await w.clock.set(SIM_AT)
  await run($, 'simulate 95 in 22m')
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  w.usageFails = true // the sense of the Stop here fails
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(mf(95, SIM_END)))
  await w.clock.settle()
  w.usageFails = false
  expect(w.env.get('SPARE10_STOPPED')).toBe(SIM_STOP_OFF)
  await w.clock.set(IN_GAP + TICK)
  await refused($, w, STOP(mf(92)))
  expect(w.ran).toEqual([])
})

// ---- P6: the same copy, the real reset moves by 1 s after the stop ----

test('P6 same copy, tell mode, autoResume off: a real reset that moves by 1 s keeps the stop', SLOW, async ($, on) => {
  const w = world(on, { pct: 92, env: { ...AUTO_OFF, ...TELL } })
  await begin($, w)
  await w.clock.set(SIM_AT)
  await run($, 'simulate 95 in 22m')
  await told($, w)
  await run($, 'stop')
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', SIM_OPENS, SIM_AT, `five_hour,test,skip,${real5(RESETS)}`))
  await w.clock.set(IN_GAP + TICK)
  await refused($, w, STOP(mf(92)))
  w.resetsAt = new Date(R_MS + 1000).toISOString() // the same window, its reset 1 s later
  await refused($, w, STOP(mf(92, R_MS + 1000)))
  await asks($, w)
  expect(overNotes(w)).toEqual([])
  expect(w.ran).toEqual(['Bash:main'])
})

test('P6 same copy, hold mode, autoResume off: a real reset that moves by 1 s keeps the stop, with no new question', SLOW, async ($, on) => {
  const w = world(on, { pct: 92, env: AUTO_OFF })
  await begin($, w)
  await w.clock.set(SIM_AT)
  await run($, 'simulate 95 in 22m')
  await run($, 'stop')
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', SIM_OPENS, SIM_AT, `five_hour,test,skip,${real5(RESETS)}`))
  await w.clock.set(IN_GAP + TICK)
  await refused($, w, STOP(mf(92)))
  w.resetsAt = new Date(R_MS + 1000).toISOString()
  await refused($, w, STOP(mf(92, R_MS + 1000)))
  expect(w.ran).toEqual([])
})

// ---- P8: the same copy, the real reading loses its reset time after the test skip start ----

test('P8 same copy, tell mode, autoResume off: a real reading that loses its reset time keeps the stop while it gates (fail closed)', SLOW, async ($, on) => {
  const w = world(on, { pct: 92, env: { ...AUTO_OFF, ...TELL } })
  await begin($, w)
  await w.clock.set(SIM_AT)
  await run($, 'simulate 95 in 22m')
  await told($, w)
  await run($, 'stop')
  await w.clock.set(IN_GAP + TICK)
  await refused($, w, STOP(mf(92)))
  w.resetsAt = null
  await refused($, w, STOP('into your 10% reserve · 8% of quota left · resets at an unknown time'))
  await asks($, w)
  expect(overNotes(w)).toEqual([])
  expect(w.ran).toEqual(['Bash:main'])
})

test('P8 same copy, hold mode, autoResume off: the same, with no new question', SLOW, async ($, on) => {
  const w = world(on, { pct: 92, env: AUTO_OFF })
  await begin($, w)
  await w.clock.set(SIM_AT)
  await run($, 'simulate 95 in 22m')
  await run($, 'stop')
  await w.clock.set(IN_GAP + TICK)
  await refused($, w, STOP(mf(92)))
  w.resetsAt = null
  await refused($, w, STOP('into your 10% reserve · 8% of quota left · resets at an unknown time'))
  expect(w.ran).toEqual([])
})

// ---- P10 and P11: Stop here, then the person sets the open time to 0 (a reload with the option in force) ----

test('P10 same copy, tell mode, autoResume off: /spare10 stop writes the real tag, and a newer copy with the open time at 0 keeps it past the old skip start', { ...SLOW, plugins: [newerCopy] }, async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: OFF_TICK, env: { ...AUTO_OFF, ...TELL } })
  await begin($, w)
  await told($, w)
  await run($, 'stop')
  await refused($, w, STOP(mf(93, OT_MS)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(OFF_STOP_OFF)
  w.env.set('NEWER_COPY_SPANS', '0 0')
  await w.clock.set(OO_MS + 2 * TICK)
  await refused($, w, STOP(mf(93, OT_MS)))
  await asks($, w)
  await refused($, w, STOP(mf(93, OT_MS)))
  expect(w.env.get('SPARE10_STOPPED')).toBe(OFF_STOP_OFF)
  expect(overNotes(w)).toEqual([])
  expect(w.ran).toEqual(['Bash:main'])
})

test('P10 reload with lastMinutes 0, tell mode, autoResume off: past the old skip start the stop still refuses calls and asks for a prompt', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: OFF_TICK, env: { ...AUTO_OFF, ...TELL, ...SPAN0, SPARE10_STOPPED: OFF_STOP_OFF } })
  await w.clock.set(OO_MS - 10 * MIN)
  await begin($, w) // the new copy's session.start
  await refused($, w, STOP(mf(93, OT_MS)))
  await w.clock.set(OO_MS + 2 * TICK)
  await refused($, w, STOP(mf(93, OT_MS)))
  await asks($, w)
  await refused($, w, STOP(mf(93, OT_MS)))
  expect(w.env.get('SPARE10_STOPPED')).toBe(OFF_STOP_OFF)
  expect(await run($, 'stop')).toBe('already stopped.') // it now lasts until the reset: no skip start to show
  expect(overNotes(w)).toEqual([])
  expect(w.ran).toEqual([])
})

test('P10 reload with lastMinutes 0, hold mode, autoResume off: past the old skip start the stop refuses calls with no question', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: OFF_TICK, env: { ...AUTO_OFF, ...SPAN0, SPARE10_STOPPED: OFF_STOP_OFF } })
  await w.clock.set(OO_MS - 10 * MIN)
  await begin($, w)
  await refused($, w, STOP(mf(93, OT_MS)))
  await w.clock.set(OO_MS + 2 * TICK)
  await refused($, w, STOP(mf(93, OT_MS)))
  expect(w.env.get('SPARE10_STOPPED')).toBe(OFF_STOP_OFF)
  expect(w.ran).toEqual([])
})

test('a 0.2 value from before the real tag reads as before: past its until it holds nothing, and a call asks again', SLOW, async ($, on) => {
  const old = stopRec('S1', OO_MS, T0, 'five_hour,work,skip')
  const w = world(on, { pct: 93, resetsAt: OFF_TICK, env: { ...AUTO_OFF, ...SPAN0, SPARE10_STOPPED: old } })
  await w.clock.set(OO_MS - 10 * MIN)
  await begin($, w)
  await refused($, w, STOP(mf(93, OT_MS)))
  await w.clock.set(OO_MS + 2 * TICK)
  const call = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  w.release('Stop here')
  expect((await call).deny).toBe(STOP(mf(93, OT_MS)))
})

test('P11 same copy, tell mode, autoResume on: a newer copy with the open time at 0 keeps the stop in the gap before the tick, and the tick extends it', { ...SLOW, plugins: [newerCopy] }, async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: OFF_TICK, env: TELL })
  await begin($, w)
  await told($, w)
  await run($, 'stop')
  await refused($, w, STOP(mf(93, OT_MS)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(OFF_STOP_AUTO)
  w.env.set('NEWER_COPY_SPANS', '0 0')
  await w.clock.set(OO_MS + 5000) // past the old skip start, before the tick
  await refused($, w, STOP(mf(93, OT_MS)))
  await asks($, w)
  await w.clock.advance(2 * TICK)
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OT_MS, T0, 'five_hour,work,auto')) // extended until the reset
  await refused($, w, STOP(mf(93, OT_MS)))
  expect(overNotes(w)).toEqual([])
  expect(w.submitted).toEqual([])
  expect(w.ran).toEqual(['Bash:main'])
})

test('P11 reload with lastMinutes 0, tell mode, autoResume on: in the gap before the tick a call is refused and a prompt asks, and the tick extends the stop', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: OFF_TICK, env: { ...TELL, ...SPAN0, SPARE10_STOPPED: OFF_STOP_AUTO } })
  await w.clock.set(OO_MS - 10 * MIN - 15_000) // ticks at 14:40:00 and 14:40:30: the gap is 14:40:15 to 14:40:30
  await begin($, w)
  await refused($, w, STOP(mf(93, OT_MS)))
  await w.clock.set(OO_MS + 5000)
  await refused($, w, STOP(mf(93, OT_MS)))
  await asks($, w)
  expect(w.env.get('SPARE10_STOPPED')).toBe(OFF_STOP_AUTO)
  await w.clock.advance(2 * TICK)
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OT_MS, T0, 'five_hour,work,auto'))
  await refused($, w, STOP(mf(93, OT_MS)))
  expect(overNotes(w)).toEqual([])
  expect(w.submitted).toEqual([])
  expect(w.ran).toEqual([])
})

test('P11 reload with lastMinutes 0, hold mode, autoResume on: in the gap the call is refused with no question, and the tick extends the stop', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: OFF_TICK, env: { ...SPAN0, SPARE10_STOPPED: OFF_STOP_AUTO } })
  await w.clock.set(OO_MS - 10 * MIN - 15_000)
  await begin($, w)
  await w.clock.set(OO_MS + 5000)
  await refused($, w, STOP(mf(93, OT_MS)))
  await w.clock.advance(2 * TICK)
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OT_MS, T0, 'five_hour,work,auto'))
  expect(w.submitted).toEqual([])
  expect(w.ran).toEqual([])
})

// ---- A: an extension adopts a kind whose window started after the stop ----
// A weekly skip stop lasts across a 5-hour reset. At the weekly skip start the new 5-hour window gates,
// so the tick extends the stop to it (B34). Its real tag keeps the reset of that 5-hour window, not the
// time of the stop. Then the 5-hour open time goes to 0 (B47). In the gap before the next tick the stop
// still holds.

const WEEK_END = '2026-09-25T00:00:00.000Z' // a weekly reset: the weekly skip start is 16:00
const WE_OPENS_MS = Date.parse(WEEK_END) - 8 * HOUR
const NEXT_RESET = '2026-09-24T20:05:15.000Z' // the next 5-hour window, 15 s off the tick grid
const NR_MS = Date.parse(NEXT_RESET)
const NR_OPENS_MS = NR_MS - 20 * MIN // its skip start
const EXT_STOP = stopRec('S1', NR_OPENS_MS, T0, `five_hour,work,auto,skip,${real5(NEXT_RESET)}`)

for (const mode of ['tell', 'hold'] as const) {
  test(`A same copy, ${mode} mode, autoResume on: a weekly stop extended into a later 5-hour window holds past its end when a newer copy sets the open time to 0`, { ...SLOW, plugins: [newerCopy] }, async ($, on) => {
    const w = world(on, { pct: 50, weekPct: 93, weekResetsAt: WEEK_END, env: mode === 'tell' ? TELL : {} })
    await begin($, w)
    if (mode === 'tell') await told($, w)
    await run($, 'stop')
    await refused($, w, STOP(`into your 10% weekly reserve · 7% of weekly quota left · resets ${new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(Date.parse(WEEK_END))} ${hhmm(Date.parse(WEEK_END))}`))
    await w.clock.settle()
    expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', WE_OPENS_MS, T0, `seven_day,work,auto,skip,${real7(WEEK_END)}`))
    await w.clock.set(R_MS + 5000) // the 5-hour window resets
    w.resetsAt = NEXT_RESET
    w.pct = 92 // the next 5-hour window is in the reserve at once
    await w.clock.set(WE_OPENS_MS + TICK) // the tick at the weekly skip start extends the stop
    expect(w.env.get('SPARE10_STOPPED')).toBe(EXT_STOP)
    const logged = w.logs.length // the extension notice names the weekly reset: that is true
    w.env.set('NEWER_COPY_SPANS', '0 8') // the 5-hour reserve never opens now
    await w.clock.set(NR_OPENS_MS + 5000) // past the end of the extension, before the tick after it
    await refused($, w, STOP(mf(92, NR_MS)))
    if (mode === 'tell') await asks($, w)
    await refused($, w, STOP(mf(92, NR_MS)))
    expect(w.env.get('SPARE10_STOPPED')).toBe(EXT_STOP)
    await w.clock.advance(2 * TICK)
    expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', NR_MS, T0, 'five_hour,work,auto')) // extended until the reset
    await refused($, w, STOP(mf(92, NR_MS)))
    expect(overNotes({ logs: w.logs.slice(logged) })).toEqual([])
    expect(w.submitted).toEqual([])
    expect(w.ran).toEqual(mode === 'tell' ? ['Bash:main'] : [])
  })

  test(`A reload with lastMinutes 0, ${mode} mode, autoResume on: the extended value holds in the gap before the tick`, SLOW, async ($, on) => {
    const w = world(on, { pct: 92, resetsAt: NEXT_RESET, weekPct: 93, weekResetsAt: WEEK_END, env: { ...(mode === 'tell' ? TELL : {}), ...SPAN0, SPARE10_STOPPED: EXT_STOP } })
    await w.clock.set(NR_OPENS_MS - 10 * MIN - 15_000) // ticks at 19:45:00 and 19:45:30: the gap is 19:45:15 to 19:45:30
    await begin($, w)
    await w.clock.set(NR_OPENS_MS + 5000)
    await refused($, w, STOP(mf(92, NR_MS)))
    if (mode === 'tell') await asks($, w)
    await refused($, w, STOP(mf(92, NR_MS)))
    expect(w.env.get('SPARE10_STOPPED')).toBe(EXT_STOP)
    expect(overNotes(w)).toEqual([])
    expect(w.ran).toEqual([])
  })
}

// ---- B: /spare10 stop in the gap after a stop's end, over a real trip that came after the stop ----
// The test skip stop has no real tag: the real reading was below the reserve then. So past its end it
// does not hold the later real trip. But the person runs /spare10 stop while that trip gates: the old
// stop is taken over, and a new stop follows with the real tag. Its reply names no reset.

const STOP_AGAIN = `stopped at the reserve until ${hhmm(O_MS)}, 20 min before the reset. Then spare10 continues any stopped work. Type a prompt to be asked again, or run /spare10 resume.`

for (const mode of ['tell', 'hold'] as const) {
  test(`B ${mode} mode, autoResume on: /spare10 stop after a test stop's end, over a later real trip, stops again, and no call runs`, SLOW, async ($, on) => {
    const w = world(on, { floors: 'off', pct: 50, env: mode === 'tell' ? TELL : {} })
    await begin($, w)
    await w.clock.set(SIM_AT)
    await run($, 'simulate 95 in 22m')
    if (mode === 'tell') {
      await told($, w)
      await run($, 'stop')
    } else {
      const held = bash($)
      await w.clock.settle()
      w.release('Stop here')
      expect((await held).deny).toBe(STOP(mf(95, SIM_END)))
    }
    await w.clock.settle()
    const work = mode === 'hold' ? 'work,' : ''
    expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', SIM_OPENS, SIM_AT, `five_hour,${work}auto,test,skip`))
    w.pct = 92 // the real reading reaches the reserve during the stop, in the same window
    await w.clock.set(IN_GAP)
    expect(await run($, 'stop')).toBe(STOP_AGAIN)
    await w.clock.settle()
    expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', O_MS, IN_GAP, `five_hour,${work}auto,skip,${real5(RESETS)}`)) // the work of the old stop stays
    await refused($, w, STOP(mf(92)))
    await w.clock.advance(2 * TICK)
    await refused($, w, STOP(mf(92)))
    expect(overNotes(w)).toEqual([])
    expect(w.submitted).toEqual([])
    expect(w.ran).toEqual(mode === 'tell' ? ['Bash:main'] : [])
  })
}

// ---- C: a merge never carries a real tag into a later window ----

test('C hold mode, autoResume off: a Stop here merged into a test stop after a real reset drops the old real tag, so a later real trip asks again', SLOW, async ($, on) => {
  const w = world(on, { floors: 'off', pct: 92, env: AUTO_OFF })
  await begin($, w)
  await run($, 'simulate 95 in 4h') // its skip start 15:40 lies after the real reset 15:00
  await run($, 'stop')
  await w.clock.settle()
  const testEnd = T0 + 4 * HOUR
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', testEnd - 20 * MIN, T0, `five_hour,test,skip,${real5(RESETS)}`))
  const at = R_MS + 10 * MIN
  await w.clock.set(at)
  w.resetsAt = LATER // the next real window, below the reserve
  w.pct = 50
  await refused($, w, STOP(mf(95, testEnd))) // the test stop still applies
  await asks($, w) // Stop here merges into it
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', testEnd - 20 * MIN, at, 'five_hour,work,test,skip')) // the tag of the last window is gone
  await w.clock.set(R_MS + 30 * MIN)
  w.pct = 92 // a real trip in the next window, after the stop
  await w.clock.set(testEnd - 15 * MIN) // past the test skip start: the real reading shows
  const call = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(2) // it asks again
  w.release('Stop here')
  expect((await call).deny).toBe(STOP(mf(92, Date.parse(LATER))))
  expect(w.ran).toEqual([])
})

// ---- D: the real tag and its check read the real reading, beneath any test reading ----

for (const mode of ['tell', 'hold'] as const) {
  test(`D reload with lastMinutes 0, ${mode} mode, autoResume off: a first test reading on top, with a later reset, does not end the stop past its end`, SLOW, async ($, on) => {
    const w = world(on, { floors: 'off', pct: 93, resetsAt: OFF_TICK, env: { ...AUTO_OFF, ...(mode === 'tell' ? TELL : {}), ...SPAN0, SPARE10_STOPPED: OFF_STOP_OFF } })
    await w.clock.set(OO_MS - 10 * MIN)
    await begin($, w)
    const now = OO_MS + 2 * TICK
    await w.clock.set(now)
    await refused($, w, STOP(mf(93, OT_MS)))
    await run($, 'simulate 95 in 5h') // replaces nothing in this copy, so the stop stays
    await refused($, w, STOP(mf(95, now + 5 * HOUR))) // the real reading beneath still gates in the window of the stop
    await asks($, w)
    // Tell mode: a Stop here writes nothing. Hold mode: it writes a stop on the test reading, with the real tag.
    expect(w.env.get('SPARE10_STOPPED')).toBe(mode === 'tell' ? OFF_STOP_OFF : stopRec('S1', now + 5 * HOUR, now, `five_hour,test,${real5(OFF_TICK)}`))
    expect(overNotes(w)).toEqual([])
    expect(w.ran).toEqual([])
  })
}

test('D hold mode: a Resume on the real reading still covers it beneath a later test window, so a Stop here on the test window writes no real tag', SLOW, async ($, on) => {
  const w = world(on, { pct: 92 })
  await begin($, w)
  const first = bash($)
  await w.clock.settle()
  w.release('Resume') // with the shipped floors: a consent to the floor (95), on the real reading
  expect((await first).result).toBe('ran')
  await w.clock.set(SIM_AT)
  await run($, 'simulate 95 in 22m') // the test window ends before the real reset, so the Resume does not cover it
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
  w.release('Stop here')
  // Floor B49: the test reading is at the floor point, so the real consent does not apply to it, and the
  // question and the stop name the floor. The real reading (92) stays below the point: the consent stays.
  expect((await held).deny).toBe(STOP(`into your 5% floor · 5% of quota left · resets ${hhmm(SIM_END)}`))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', SIM_OPENS, SIM_AT, 'five_hour,work,auto,test,skip')) // no real tag: the real reading is consented
  await w.clock.set(IN_GAP) // past the test skip start: the real reading shows, and the Resume covers it
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(2)
})

// ---- /spare10 stop over a stop in force: it always stops what gates now ----

test('/spare10 stop over a test stop, after a later real trip: the stop gets the real tag, so past its end it still holds (tell mode, autoResume off)', SLOW, async ($, on) => {
  const w = world(on, { pct: 50, env: { ...AUTO_OFF, ...TELL } })
  await begin($, w)
  await w.clock.set(SIM_AT)
  await run($, 'simulate 95 in 22m')
  await told($, w)
  await run($, 'stop')
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', SIM_OPENS, SIM_AT, 'five_hour,test,skip')) // the real reading is below the reserve
  await w.clock.set(SIM_AT + 30_000)
  w.pct = 92 // the real reading reaches the reserve during the stop
  expect(await run($, 'stop')).toBe(`already stopped until ${hhmm(SIM_OPENS)}.`)
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', SIM_OPENS, SIM_AT, `five_hour,test,skip,${real5(RESETS)}`)) // only the real tag is new
  await w.clock.set(IN_GAP + TICK) // past the test skip start: the real reading shows
  await refused($, w, STOP(mf(92)))
  await asks($, w)
  await refused($, w, STOP(mf(92)))
  expect(overNotes(w)).toEqual([])
  expect(w.ran).toEqual(['Bash:main'])
})

test('/spare10 stop over a 5-hour stop, after a later weekly trip: a merged stop names both windows and lasts past the 5-hour skip start (tell mode, autoResume off)', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 50, env: { ...AUTO_OFF, ...TELL } })
  await begin($, w)
  await told($, w)
  await run($, 'stop')
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', O_MS, T0, `five_hour,skip,${real5(RESETS)}`))
  const at = T0 + MIN
  await w.clock.set(at)
  w.weekPct = 92 // the weekly window reaches its reserve during the stop
  const weekEnd = Date.parse(WEEK_RESETS)
  const weekOpens = weekEnd - 8 * HOUR
  const day = (ms: number): string => `${new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(ms)} ${hhmm(ms)}`
  expect(await run($, 'stop')).toBe(`stopped at the reserve until ${day(weekOpens)}, 8 h before the weekly reset. Type a prompt to be asked again, or run /spare10 resume.`)
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', weekOpens, at, `five_hour,seven_day,skip,${real5(RESETS)},${real7(WEEK_RESETS)}`))
  await w.clock.set(O_MS + TICK) // the 5-hour reserve is open: the weekly window still gates
  await refused($, w, STOP(`into your 10% weekly reserve · 8% of weekly quota left · resets ${day(weekEnd)}`))
  await asks($, w)
  expect(w.ran).toEqual(['Bash:main'])
})
