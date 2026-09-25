import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ToolCallResult } from 'claude-code'
import { MIN, RESETS, WEEK_RESETS, bash, begin, clear, cmd, consentRec, stopRe, typed, world } from '../helpers/world.ts'
import type { World } from '../helpers/world.ts'

// The end of a consent to the floor under env latency and a failed env read (floor design B52). When a
// gate ends a real consent to the floor, this copy buries it: the tomb holds the time in the value and
// its end point. A late write, a restamp after /clear, or a value that a failed read missed then never
// applies again, and the next read unsets it. Each race test holds a call at the second question, then
// lets the reading fall in the window. The held call must not run, and no consent to the floor may stay
// in the env. The world has the shipped floors (5 and 5) and the shipped spans (20 min and 8 h).

const SLOW = { timeoutMs: 60_000 }

async function run($: Engine, args: string): Promise<string> {
  return (await $.command.run(cmd(args))).text ?? ''
}

/** A first question at 91% that the person answers Resume. The consent to the floor is in the env. Later dialogs hang. */
async function resumeAtReserve($: Engine, w: World): Promise<void> {
  w.answer = 'Resume'
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95))
  w.answer = 'hang'
}

/** Advances the clock in 25 ms steps, and gives each value that the consent variable held after a step. */
async function watched(w: World, ms: number, name = 'SPARE10_CONSENT'): Promise<Array<string | undefined>> {
  const seen = new Set<string | undefined>()
  for (let t = 0; t < ms; t += 25) {
    await w.clock.advance(25)
    seen.add(w.env.get(name))
  }
  return [...seen]
}

/** How the gate answers a new call: 'ran', 'denied', or 'held' while it still waits. */
function outcome(w: World, call: Promise<ToolCallResult>): Promise<string> {
  return Promise.race([call.then((r) => (r.result === 'ran' ? 'ran' : 'denied')), w.clock.settle().then(() => 'held')])
}

// ---- the Resume write races the end (settle) ----

for (const get of [50, 100, 200, 400]) {
  test(`a Resume whose write lands after the reading passed the floor stays ended (env read ${get} ms late)`, SLOW, async ($, on) => {
    const w = world(on, { pct: 91 })
    await begin($, w)
    const held = bash($)
    await w.clock.settle()
    expect(w.asked).toHaveLength(1)
    // The gate after the Resume reads the env before the write lands, and gets its answer after the write.
    w.envGetDelayMs = { SPARE10_CONSENT: get }
    w.pct = 96
    w.release('Resume')
    await w.clock.advance(5000)
    w.envGetDelayMs = {}
    await w.clock.settle()
    const env = w.env.get('SPARE10_CONSENT')
    const asked = w.asked.length
    w.pct = 93 // a fall in the window
    await w.clock.advance(2 * MIN)
    await w.clock.settle()
    expect({ env, asked, ran: w.ran.length }).toEqual({ env: undefined, asked: 2, ran: 0 })
    w.release('Stop here')
    expect((await held).deny).toBeDefined()
  })
}

// ---- /spare10 resume races the end ----

for (const gap of [120, 150, 180]) {
  test(`/spare10 resume at 94 and a call at 96 ${gap} ms later: no consent to the floor survives`, SLOW, async ($, on) => {
    const w = world(on, { pct: 94 })
    await begin($, w)
    w.envGetDelayMs = { SPARE10_CONSENT: 100 }
    const reply = run($, 'resume') // it senses 94, so it writes a consent to the floor
    await w.clock.advance(gap)
    w.pct = 96
    const held = bash($)
    await w.clock.advance(5000)
    w.envGetDelayMs = {}
    await w.clock.settle()
    const env = w.env.get('SPARE10_CONSENT')
    const asked = w.asked.length
    w.pct = 93
    await w.clock.advance(2 * MIN)
    await w.clock.settle()
    expect((await reply).startsWith('you can use the reserve until 95% used.')).toBe(true)
    expect({ env, asked, ran: w.ran.length }).toEqual({ env: undefined, asked: 1, ran: 0 })
    w.release('Stop here')
    expect((await held).deny).toBeDefined()
  })
}

// ---- the restamp after /clear races the end ----

test('the restamp after /clear never writes back a consent to the floor that a gate ended (env read 200 ms late)', SLOW, async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  await clear($, w, 'S2') // the restamp runs 300 ms and 1500 ms after the clear
  w.envGetDelayMs = { SPARE10_CONSENT: 200 }
  await w.clock.advance(200)
  w.pct = 96
  const held = bash($) // the gate reads the value at 200 ms
  // The restamp reads the value at 300 ms and compares it after the gate ended it. It never writes it, not even for a moment.
  const values = await watched(w, 1250)
  w.envGetDelayMs = {}
  await w.clock.settle()
  expect(values).not.toContain(consentRec('S2', RESETS, 95))
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(w.asked).toHaveLength(2)
  w.release('Stop here')
  expect((await held).deny).toBeDefined()
})

test('the restamp race, then a fall: the held call never runs, and a new call asks again', SLOW, async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  await clear($, w, 'S2')
  w.envGetDelayMs = { SPARE10_CONSENT: 200 }
  await w.clock.advance(200)
  w.pct = 96
  const held = bash($)
  await w.clock.advance(250)
  await w.clock.advance(1000)
  w.envGetDelayMs = {}
  await w.clock.settle()
  const revived = w.env.get('SPARE10_CONSENT')
  w.pct = 93 // a fall in the window
  await w.clock.advance(2 * MIN)
  const ran = w.ran.length
  const fresh = await outcome(w, bash($))
  // Only the call before the floor ran. The held call waits, and the new call joins the open question.
  expect({ revived, ran, fresh }).toEqual({ revived: undefined, ran: 1, fresh: 'held' })
  w.release('Stop here')
  expect((await held).deny).toBeDefined()
})

for (const at of [100, 200, 250, 290]) {
  test(`the restamp never writes back an ended consent to the floor (env write 200 ms late, gate at ${at} ms)`, SLOW, async ($, on) => {
    const w = world(on, { pct: 91 })
    await begin($, w)
    await resumeAtReserve($, w)
    await clear($, w, 'S2')
    w.envSetDelayMs = 200
    await w.clock.advance(at)
    w.pct = 96
    const held = bash($)
    const values = await watched(w, 3000)
    w.envSetDelayMs = 0
    await w.clock.settle()
    expect(values).not.toContain(consentRec('S2', RESETS, 95)) // not even for a moment
    expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
    w.release('Stop here')
    expect((await held).deny).toBeDefined()
  })
}

test('the weekly restamp never writes back an ended weekly consent to the floor (env write 200 ms late)', SLOW, async ($, on) => {
  const w = world(on, { pct: 20, weekPct: 91, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(consentRec('S1', WEEK_RESETS, 95))
  w.answer = 'hang'
  await clear($, w, 'S2')
  w.envSetDelayMs = 200
  await w.clock.advance(200)
  w.weekPct = 96
  const held = bash($)
  const values = await watched(w, 3000, 'SPARE10_WEEKLY_CONSENT')
  w.envSetDelayMs = 0
  await w.clock.settle()
  expect(values).not.toContain(consentRec('S2', WEEK_RESETS, 95))
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBeUndefined()
  expect(w.asked).toHaveLength(2)
  expect(w.asked[1]?.question.startsWith('Your 5% weekly floor is reached')).toBe(true)
  w.release('Stop here')
  expect((await held).deny).toBeDefined()
})

test('a failed weekly consent read at the weekly floor still ends the weekly consent for good', SLOW, async ($, on) => {
  const w = world(on, { pct: 20, weekPct: 91, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(consentRec('S1', WEEK_RESETS, 95))
  w.answer = 'hang'
  w.envGetFails = ['SPARE10_WEEKLY_CONSENT']
  w.weekPct = 96
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
  w.envGetFails = []
  w.weekPct = 93
  await w.clock.advance(2 * MIN)
  await w.clock.settle()
  expect({ ran: w.ran.length, env: w.env.get('SPARE10_WEEKLY_CONSENT') }).toEqual({ ran: 1, env: undefined })
  w.release('Stop here')
  expect((await held).deny).toBeDefined()
})

// ---- a failed env read at the gate that crosses the floor ----

test('a failed consent read at the floor still ends the consent for good, and a fall never releases the held call', SLOW, async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  w.envGetFails = ['SPARE10_CONSENT']
  w.pct = 96
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(2) // the second question
  w.envGetFails = []
  w.pct = 93 // a fall in the window, before any other gate event at 96
  await w.clock.advance(2 * MIN)
  await w.clock.settle()
  expect({ ran: w.ran.length, env: w.env.get('SPARE10_CONSENT') }).toEqual({ ran: 1, env: undefined })
  w.release('Stop here')
  expect((await held).deny).toBeDefined()
})

test('a Stop here at the second question still refuses after a fall, when the consent read failed at the floor', SLOW, async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  w.envGetFails = ['SPARE10_CONSENT']
  w.pct = 96
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
  w.release('Stop here')
  expect((await held).deny).toBeDefined()
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stopRe('S1'))
  w.envGetFails = []
  w.pct = 93
  const r = await outcome(w, bash($))
  expect({ r, env: w.env.get('SPARE10_CONSENT'), stop: w.env.has('SPARE10_STOPPED') }).toEqual({ r: 'denied', env: undefined, stop: true })
})

test('a failed read at the floor also ends a consent to the floor that only the env holds, as after a reload', SLOW, async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_CONSENT: consentRec('S1', RESETS, 95) } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran') // the value of the copy before the reload applies below its point
  w.envGetFails = ['SPARE10_CONSENT']
  w.pct = 96
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.asked[0]?.question.startsWith('Your 5% floor is reached')).toBe(true)
  w.envGetFails = []
  w.pct = 93
  await w.clock.advance(2 * MIN)
  await w.clock.settle()
  expect({ ran: w.ran.length, env: w.env.get('SPARE10_CONSENT') }).toEqual({ ran: 1, env: undefined })
  w.release('Stop here')
  expect((await held).deny).toBeDefined()
})

// ---- a late value of an ended consent, and a new Resume after a fall ----

test('a late write of an ended consent to the floor is no consent, and the next read unsets it', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  w.pct = 96
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  w.env.set('SPARE10_CONSENT', consentRec('S1', RESETS, 95)) // a write that was in flight lands now
  w.pct = 93
  const fresh = await outcome(w, bash($))
  expect({ fresh, ran: w.ran.length, env: w.env.get('SPARE10_CONSENT') }).toEqual({ fresh: 'held', ran: 1, env: undefined })
  w.release('Stop here')
  expect((await held).deny).toBeDefined()
})

test('after the end and a fall in the window, a Resume at the first question consents to the floor again', SLOW, async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  w.pct = 96
  w.answer = 'Stop here'
  expect((await bash($)).deny).toBeDefined() // the second question
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  w.pct = 92
  w.answer = 'Resume'
  expect((await $.prompt.submit(typed('go on'))).drop).toBeUndefined() // the first question again
  await w.clock.settle()
  expect(w.asked).toHaveLength(3)
  expect(w.asked[2]?.question.startsWith('Your 10% reserve is reached')).toBe(true)
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95))
  expect((await bash($)).result).toBe('ran')
  w.pct = 96
  w.answer = 'Stop here'
  expect((await bash($)).deny).toBeDefined() // the second question again
  await w.clock.settle()
  expect(w.asked).toHaveLength(4)
  expect(w.asked[3]?.question.startsWith('Your 5% floor is reached')).toBe(true)
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
})
