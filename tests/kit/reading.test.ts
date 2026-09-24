import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { SessionMeasureInput } from 'claude-code'
import { HOUR, LATER, RESETS, T0, bash, begin, clear, cmd, drain, measure, step, stopRec, typed, world } from '../helpers/world.ts'

// The reading through the engine (design section 6, 11.4 reading.test.ts). Written from the spec:
// every expected text below is built here from the section 2 templates, not from hooks/core/text.ts.

const RESETS_MS = Date.parse(RESETS)
const MIN = 60_000
const WINDOW = 5 * HOUR + MIN // 6.1 WINDOW_MS

// Section 2 number and time rules.
const one = (n: number): string => String(Math.round(n * 10) / 10)
const left = (used: number): number => Math.max(0, 100 - used)
const clock = (ms: number): string => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
const resets = (at: number | null): string => (at === null ? 'at an unknown time' : clock(at))
const until = (at: number | null): string => (at === null ? 'for one hour' : `until ${clock(at)}`)

// {pf}, {mf} and the texts that carry them (B2, B7).
const pf = (used: number, at: number | null): string => `${one(used)}% used · ${one(left(used))}% left · resets ${resets(at)}`
const mf = (reserve: number, used: number, at: number | null): string =>
  `into your ${one(reserve)}% reserve · ${one(left(used))}% of quota left · resets ${resets(at)}`
// With autoResume on (the 0.2 default) a question says when spare10 continues: {at}, the hold end. A
// reading without resetsAt holds until its first sight plus 5 h (3.1), T0 + 5 h here unless given.
const holdEnd = (at: number | null, hold?: number): string => clock(hold ?? at ?? T0 + 5 * HOUR)
const loopQuestion = (reserve: number, used: number, at: number | null, hold?: number): string =>
  `Your ${one(reserve)}% reserve is reached: ${pf(used, at)}. All work is on hold. Continue on the reserve ${until(at)}? ` +
  `If you choose Stop here or do not answer, the work waits until ${holdEnd(at, hold)}. Then spare10 continues it, unless a reserve is still reached.`
const promptQuestion = (reserve: number, used: number, at: number | null, hold?: number): string =>
  `Your ${one(reserve)}% reserve is reached: ${pf(used, at)}. spare10 holds your prompt and any other work. Continue on the reserve ${until(at)}? ` +
  `If you do not answer, all of it continues after ${holdEnd(at, hold)}, unless a reserve is still reached. ` +
  `Stop here gives your prompt back and pauses other work until ${holdEnd(at, hold)}.`
const stopText = (reserve: number, used: number, at: number | null): string =>
  `spare10: the user stopped work at the quota reserve (${mf(reserve, used, at)}). Stop now and wait for the user. Do not call any further tools.`

// /spare10 lines (B22).
const status = async ($: Engine): Promise<string> => (await $.command.run(cmd(''))).text ?? ''
const BLIND_LINE = 'Claude Code reports no 5-hour quota. spare10 lets all work through.'
const WAITING_LINE = 'no reading yet. spare10 lets all work through.'
const reading = (value: string): RegExp => new RegExp(`· reading +${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)

const seedOf = (pct: number, resetsAtMs: number = RESETS_MS): { pct: number; resetsAtMs: number } => ({ pct, resetsAtMs })
const iso = (ms: number): string => new Date(ms).toISOString()
// {clock} of a weekly reset (2.1): the en-GB short weekday, then HH:MM.
const weekClock = (at: string): string =>
  `${new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(Date.parse(at))} ${clock(Date.parse(at))}`

// The footer badge (B21), mounted as the terminal draws it. The badge is the Text that names spare10.
async function badge($: Engine): Promise<() => Promise<{ text: string; color: unknown }>> {
  const ui = await $.ui.mount({ plugin: 'spare10', surface: 'terminal', component: 'SessionMode', props: { modes: [] } } as never)
  return async () => {
    const t = await ui.find({ type: 'Text', text: /spare10|Pausing|Winding/ })
    return { text: t?.text ?? '', color: t?.props.color }
  }
}

// ---- 11.4 reading table ----

test('a stored seed trips the first call of a fresh session', async ($, on) => {
  const w = world(on, { store: { seed: seedOf(93) } }) // no live reading yet
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.asked[0]?.question).toBe(loopQuestion(10, 93, RESETS_MS))
  expect(w.ran).toEqual([])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`) // 6.2: the seed's window end bounds consent
})

test('a measure with a five-hour window writes the seed', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  await $.session.measure(measure(91.5))
  await w.clock.settle()
  expect(w.store.get('seed')).toEqual(seedOf(91.5))
  expect(Object.keys(w.store.get('seed') as object).sort()).toEqual(['pct', 'resetsAtMs']) // quota only
  await $.session.measure(measure(92.5, ['rateLimits']))
  await w.clock.settle()
  expect(w.store.get('seed')).toEqual(seedOf(92.5))
  expect([...w.store.keys()]).toEqual(['seed'])
})

test('two response-backed measures with no window go blind and pass', async ($, on) => {
  const w = world(on, { store: { seed: seedOf(93) } }) // a stale subscriber seed, no live reading
  await begin($, w)
  await $.session.measure(measure(undefined, ['context', 'cost']))
  await $.session.measure(measure(undefined, ['context', 'cost']))
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(await $.prompt.submit(typed('hello'))).toMatchObject({ text: 'hello' })
  expect(w.asked).toEqual([])
  expect(w.requests).toBe(1)
  const out = await status($)
  expect(out).toContain(BLIND_LINE)
  expect(out).toMatch(reading('none: Claude Code reports no quota (blind)'))
})

test("a subagent's call decides on the same live figure", async ($, on) => {
  const w = world(on, { pct: 50, agents: ['a1'] })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect((await bash($, 'a1')).result).toBe('ran')
  w.pct = 91 // another loop's response moved the one tracker, no measure raised
  const sub = bash($, 'a1')
  const main = drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.asked[0]?.question).toBe(loopQuestion(10, 91, RESETS_MS))
  expect(w.ran).toEqual(['Bash:main', 'Bash:a1'])
  expect(w.requests).toBe(0)
  w.release('Resume')
  expect((await sub).result).toBe('ran')
  expect((await main).text).toBe('hi')
})

// ---- 6.1 the decision rule ----

test('a stored seed also trips the first typed prompt, with the prompt wording', async ($, on) => {
  const w = world(on, { store: { seed: seedOf(93) }, answer: 'Resume' })
  await begin($, w)
  expect(await $.prompt.submit(typed('hello'))).toMatchObject({ text: 'hello' })
  expect(w.asked.map((a) => a.question)).toEqual([promptQuestion(10, 93, RESETS_MS)])
})

test('the gate reads the live figure on every event, never the last measure', async ($, on) => {
  const w = world(on, { pct: 50, answer: 'Resume' })
  await begin($, w)
  await $.session.measure(measure(50))
  w.pct = 93 // no measure yet for this response
  expect((await drain($, step())).text).toBe('hi')
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93, RESETS_MS)])
})

test('live wins over a higher remembered reading, in the store or in memory', async ($, on) => {
  const w = world(on, { pct: 50, store: { seed: seedOf(97) } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await $.session.measure(measure(97)) // remembered in memory and written to the store
  await w.clock.settle()
  w.pct = 60 // a limit-reset grant lowered usage inside the window
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(w.asked).toEqual([])
  expect(w.store.get('seed')).toEqual(seedOf(97)) // the gate never writes the seed
  expect(await status($)).toMatch(reading(`live · ${pf(60, RESETS_MS)} (in `))
})

test('a live reading with a reset time is remembered and bridges a reading that goes missing', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'dismiss' })
  await begin($, w)
  expect((await bash($)).deny).toBe(stopText(10, 93, RESETS_MS))
  await w.clock.settle()
  w.pct = undefined // a response without quota headers emptied the list
  expect((await bash($)).deny).toBe(stopText(10, 93, RESETS_MS))
  expect(await status($)).toMatch(reading(`seed from another session · ${pf(93, RESETS_MS)} (in `))
  w.pct = 40 // live again, and lower: it wins over the remembered 93
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('a live reading without resetsAt is used as read and never remembered', async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: null, answer: 'dismiss' })
  await begin($, w)
  expect((await bash($)).deny).toBe(stopText(10, 93, null))
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93, null)])
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', T0 + 5 * HOUR, T0, 'five_hour,work,auto')) // 3.1: the first sight plus 5 h
  await $.session.measure(measure(93, ['rateLimits', 'cost'], null))
  await w.clock.settle()
  expect(w.store.get('seed')).toBeUndefined()
  w.pct = undefined
  expect((await bash($)).result).toBe('ran') // nothing remembered: no reading, so no trip
  expect(await status($)).toMatch(reading('none: no reading yet'))
})

test('a live reading without resetsAt beats a stored seed but never replaces it', async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: null, store: { seed: seedOf(50) }, answer: 'dismiss' })
  await begin($, w)
  expect((await bash($)).deny).toBe(stopText(10, 93, null))
  await w.clock.settle()
  w.pct = undefined
  expect((await bash($)).result).toBe('ran') // the seed of 50 applies again, not the 93 read without a reset
  expect(await status($)).toMatch(reading(`seed from another session · ${pf(50, RESETS_MS)}`))
})

test('a reading of the next window replaces the remembered one', async ($, on) => {
  const w = world(on, { store: { seed: seedOf(93) }, answer: 'dismiss' })
  await begin($, w)
  expect((await bash($)).deny).toBe(stopText(10, 93, RESETS_MS))
  await w.clock.settle()
  await w.clock.set(RESETS_MS + MIN)
  await $.session.measure(measure(5, ['rateLimits', 'cost'], LATER))
  await w.clock.settle()
  expect((await bash($)).result).toBe('ran')
  expect(await status($)).toMatch(reading(`seed from another session · ${pf(5, Date.parse(LATER))}`))
  expect(w.store.get('seed')).toEqual(seedOf(5, Date.parse(LATER)))
})

test('the remembered reading survives /clear, and the new conversation is asked again', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'dismiss' })
  await begin($, w)
  expect((await bash($)).deny).toBe(stopText(10, 93, RESETS_MS))
  await w.clock.settle()
  w.pct = undefined
  await clear($, w, 'S2') // /clear: a new session id, the module stays
  expect((await bash($)).deny).toBe(stopText(10, 93, RESETS_MS))
  expect(w.asked).toHaveLength(2)
  expect(w.asked[1]?.question).toBe(loopQuestion(10, 93, RESETS_MS))
})

test('a stored seed whose reset is one window and a minute ahead still counts', async ($, on) => {
  const at = T0 + WINDOW
  const w = world(on, { store: { seed: seedOf(93, at) }, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93, at)])
})

test('a stored seed more than one window ahead is ignored', async ($, on) => {
  const w = world(on, { store: { seed: seedOf(93, T0 + WINDOW + 1000) } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  const out = await status($)
  expect(out).toContain(WAITING_LINE)
  expect(out).toMatch(reading('none: no reading yet'))
})

test('a stored seed whose window already reset gives no stale trip', async ($, on) => {
  const w = world(on, { store: { seed: seedOf(93, T0) } }) // resets exactly now
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(w.asked).toEqual([])
  const out = await status($)
  expect(out).toContain(WAITING_LINE)
  expect(out).toMatch(reading('none: the window reset'))
})

test('a remembered reading stops counting at its reset', async ($, on) => {
  const w = world(on, { store: { seed: seedOf(93) }, answer: 'dismiss' })
  await begin($, w)
  expect((await bash($)).deny).toBe(stopText(10, 93, RESETS_MS))
  await w.clock.settle()
  await w.clock.set(RESETS_MS)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
  expect(await status($)).toMatch(reading('none: the window reset'))
})

for (const [name, value] of [
  ['a string', 'junk'],
  ['null', null],
  ['a string percentage', { pct: '93', resetsAtMs: RESETS_MS }],
  ['no reset time', { pct: 93 }],
  ['an ISO reset time', { pct: 93, resetsAtMs: RESETS }],
  ['a percentage that is not a number', { pct: Number.NaN, resetsAtMs: RESETS_MS }],
] as const) {
  test(`a corrupt stored seed is ignored: ${name}`, async ($, on) => {
    const w = world(on, { store: { seed: value } })
    await begin($, w)
    expect((await bash($)).result).toBe('ran')
    expect(w.asked).toEqual([])
    expect(await status($)).toMatch(reading('none: no reading yet'))
  })
}

test('a failed seed load is no seed: the gate passes without a live reading and trips on one', async ($, on) => {
  const w = world(on, { store: { seed: seedOf(93) }, storeGetFails: true })
  await begin($, w)
  expect((await bash($)).result).toBe('ran') // the stored seed could not be read: no reading, pass
  expect(w.asked).toEqual([])
  expect(await status($)).toMatch(reading('none: no reading yet'))
  w.pct = 93
  const held = bash($)
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93, RESETS_MS)])
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

test('a failed seed load on a tripped first call still holds it: the live reading decides', async ($, on) => {
  const w = world(on, { pct: 93, storeGetFails: true })
  await begin($, w)
  const held = bash($) // the first gated event of the session: it loads the seed, and the load fails
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93, RESETS_MS)])
  expect(w.ran).toEqual([])
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

test('only the five_hour entry is the live basis, whatever other limits say', async ($, on) => {
  const w = world(on, {
    env: { SPARE10_WEEKLY_RESERVE: '0' }, // the weekly guard off: spare10 reads the seven_day window but never acts on it
    extraLimits: [
      { kind: 'seven_day', percentUsed: 99, resetsAt: LATER },
      { kind: 'spend_limit', percentUsed: 120 },
    ],
  })
  await begin($, w)
  expect((await bash($)).result).toBe('ran') // no five_hour window: no reading
  expect(await status($)).toMatch(reading('none: no reading yet'))
  w.pct = 50
  expect((await bash($)).result).toBe('ran')
  expect(await status($)).toMatch(reading(`live · ${pf(50, RESETS_MS)}`))
  w.extraLimits = [{ kind: 'seven_day', percentUsed: 5, resetsAt: LATER }]
  w.pct = 93
  const held = bash($)
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93, RESETS_MS)])
  w.release('Stop here')
  expect((await held).deny).toBe(stopText(10, 93, RESETS_MS))
})

test('a seven_day entry of 99 trips by default, with the weekly wording', async ($, on) => {
  const w = world(on, { pct: 50, extraLimits: [{ kind: 'seven_day', percentUsed: 99, resetsAt: LATER }] })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([
    `Your 10% weekly reserve is reached: 99% used · 1% left · resets ${weekClock(LATER)}. All work is on hold. ` +
      `Continue on the weekly reserve until ${weekClock(LATER)}? If you choose Stop here or do not answer, the work waits until ${weekClock(LATER)}. ` +
      'Then spare10 continues it, unless a reserve is still reached.',
  ])
  expect(w.ran).toEqual([])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(`S1 ${LATER}`)
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
})

test('the stored seed is read once per activation', async ($, on) => {
  const w = world(on)
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  w.store.set('seed', seedOf(93)) // another session writes a tripped seed later
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(w.asked).toEqual([])
})

test('a stored seed and a measured reading of the same window: the newer, then the higher, counts', async ($, on) => {
  const w = world(on, { store: { seed: seedOf(93) }, answer: 'Resume' })
  await begin($, w)
  await $.session.measure(measure(50, ['cost'])) // a five-hour window, but rateLimits did not move: no write
  await w.clock.settle()
  expect(w.store.get('seed')).toEqual(seedOf(93))
  expect((await bash($)).result).toBe('ran')
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93, RESETS_MS)])
})

// ---- 6.2 trip test and window end ----

for (const [raw, r, below, at] of [
  [undefined, 10, 89.9, 90],
  ['40', 40, 59.9, 60],
  ['10.6', 10.6, 89.3, 89.4],
  ['10.55', 10.6, 89.3, 89.4], // the reserve is rounded to one decimal
] as const) {
  test(`reserve ${raw ?? 'default'} passes at ${below} and trips at the first point of the reserve, ${at}`, async ($, on) => {
    const w = world(on, { pct: below, answer: 'Resume', ...(raw === undefined ? {} : { env: { SPARE10_RESERVE: raw } }) })
    await begin($, w)
    expect((await bash($)).result).toBe('ran')
    expect((await drain($, step())).text).toBe('hi')
    expect(w.asked).toEqual([])
    w.pct = at
    expect((await bash($)).result).toBe('ran')
    expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(r, at, RESETS_MS)])
  })
}

test('without resetsAt the fallback window end stays fixed for the episode', async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: null, answer: 'dismiss', env: { SPARE10_AUTO_RESUME: 'off' } }) // 0.1: the stop has the 1 h bound
  await begin($, w)
  expect((await bash($)).deny).toBe(stopText(10, 93, null))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', T0 + HOUR, T0, 'five_hour,work'))
  await w.clock.advance(10 * MIN)
  expect((await bash($)).deny).toBe(stopText(10, 93, null)) // still stopped, no new question
  expect(w.asked).toHaveLength(1)
  await $.command.run(cmd('resume'))
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${iso(T0 + HOUR)}`) // the same end, not now + 1 h
  expect((await bash($)).result).toBe('ran')
})

test('without resetsAt a new fallback window starts once the old one passes, and the question comes back', async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: null, answer: 'dismiss', env: { SPARE10_AUTO_RESUME: 'off' } }) // 0.1: the stop has the 1 h bound
  await begin($, w)
  expect((await bash($)).deny).toBe(stopText(10, 93, null))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', T0 + HOUR, T0, 'five_hour,work'))
  await w.clock.set(T0 + HOUR) // stopped lasts until the window end, and that end has come
  expect((await bash($)).deny).toBe(stopText(10, 93, null))
  expect(w.asked).toHaveLength(2)
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', T0 + 2 * HOUR, T0 + HOUR, 'five_hour,work'))
})

test('in tell mode without resetsAt each loop is told once, not on every event', async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: null, agents: ['a1'], env: { SPARE10_PAUSE_PROMPT: 'Commit and stop.' } })
  await begin($, w)
  const first = await bash($)
  expect(first.result).toBe('ran')
  expect((first.context ?? []).filter((c) => c.startsWith('spare10 budget guard.'))).toHaveLength(1)
  expect((first.context ?? []).join('\n')).toContain(mf(10, 93, null))
  await w.clock.advance(MIN)
  const again = await bash($)
  expect(again.result).toBe('ran')
  expect((again.context ?? []).filter((c) => c.startsWith('spare10 budget guard.'))).toEqual([])
  await w.clock.advance(MIN)
  const sub = [await bash($, 'a1'), await bash($, 'a1')]
  expect(sub.map((r) => (r.context ?? []).filter((c) => c.startsWith('spare10 budget guard.')).length)).toEqual([1, 0])
})

// ---- 6.3 seed write ----

test('a measure writes the seed only when the rate limits moved and the window has a reset time', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  const weekOnly: SessionMeasureInput = {
    context: { window: 200_000 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 97, resetsAt: LATER }],
    cost: { usd: 0.1 },
    changed: ['rateLimits', 'cost'],
  }
  await $.session.measure(measure(91, ['context', 'cost'])) // rateLimits did not move
  await $.session.measure(measure(91, ['rateLimits', 'cost'], null)) // no reset time
  await $.session.measure(measure(undefined, ['rateLimits', 'cost'])) // no five-hour window
  await $.session.measure(weekOnly) // only the seven-day window: its own seed (0.2)
  await w.clock.settle()
  expect(w.store.get('seed')).toBeUndefined()
  expect(w.store.get('seed-weekly')).toEqual(seedOf(97, Date.parse(LATER)))
  await $.session.measure(measure(91))
  await w.clock.settle()
  expect(w.store.get('seed')).toEqual(seedOf(91))
})

test('a later measure replaces the stored seed, a lower figure too (last writer wins)', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  await $.session.measure(measure(93))
  await $.session.measure(measure(91))
  await w.clock.settle()
  expect(w.store.get('seed')).toEqual(seedOf(91))
})

test('the gate never writes the store, and consent never reaches it', async ($, on) => {
  const w = world(on, { pct: 50, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await drain($, step())
  await $.prompt.submit(typed('hello'))
  w.pct = 93
  expect((await bash($)).result).toBe('ran') // asked, Resume
  await drain($, step())
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect([...w.store.keys()]).toEqual([])
  await $.session.measure(measure(93))
  await w.clock.settle()
  expect([...w.store.keys()]).toEqual(['seed'])
  expect(w.store.get('seed')).toEqual(seedOf(93))
})

for (const [name, opts] of [
  ['an unattended run', { surfaces: [] }],
  ['a run switched off with SPARE10=off', { env: { SPARE10: 'off' } }],
] as const) {
  test(`${name} still senses and writes the seed`, async ($, on) => {
    const w = world(on, { pct: 93, ...opts, surfaces: 'surfaces' in opts ? [] : ['terminal'] })
    await begin($, w)
    expect((await bash($)).result).toBe('ran')
    expect(w.asked).toEqual([])
    await $.session.measure(measure(93))
    await w.clock.settle()
    expect(w.store.get('seed')).toEqual(seedOf(93))
  })
}

// ---- 6.4 blind count ----

test('a stale seed on a login with no quota costs at most one question', async ($, on) => {
  const w = world(on, { store: { seed: seedOf(93) }, answer: 'dismiss' })
  await begin($, w)
  expect((await bash($)).deny).toBe(stopText(10, 93, RESETS_MS)) // the one question, answered Stop here
  await w.clock.settle()
  await $.session.measure(measure(undefined, ['context', 'cost']))
  await $.session.measure(measure(undefined, ['cost']))
  expect((await bash($)).result).toBe('ran') // blind is not tripped, so a stop no longer refuses
  expect((await drain($, step())).text).toBe('hi')
  expect(await $.prompt.submit(typed('hello'))).toMatchObject({ text: 'hello' })
  expect(w.asked).toHaveLength(1)
})

test('one miss is not blind, a measure without cost is no miss, and the gate never counts one', async ($, on) => {
  const w = world(on, { store: { seed: seedOf(50) } }) // armed on the seed, no live reading
  await begin($, w)
  for (let i = 0; i < 5; i += 1) expect((await bash($)).result).toBe('ran') // the gate's own empty reads
  await $.session.measure(measure(undefined, ['context', 'cost']))
  expect(await status($)).toMatch(reading(`seed from another session · ${pf(50, RESETS_MS)}`))
  await $.session.measure(measure(undefined, ['context']))
  await $.session.measure(measure(undefined, ['context']))
  expect(await status($)).not.toContain(BLIND_LINE)
  await $.session.measure(measure(undefined, ['context', 'cost'])) // the second miss: context-only measures left the count as it was
  const out = await status($)
  expect(out).toContain(BLIND_LINE)
  expect(out).toMatch(reading('none: Claude Code reports no quota (blind)'))
})

test('a measure with a window resets the count, so misses must be consecutive', async ($, on) => {
  const w = world(on, { store: { seed: seedOf(50) } })
  await begin($, w)
  await $.session.measure(measure(undefined, ['cost']))
  await $.session.measure(measure(50, ['rateLimits', 'cost']))
  await $.session.measure(measure(undefined, ['cost']))
  expect(await status($)).not.toContain(BLIND_LINE)
  await $.session.measure(measure(undefined, ['cost']))
  expect(await status($)).toContain(BLIND_LINE)
})

test('a five-hour window without a reset time also resets the count', async ($, on) => {
  const w = world(on, { store: { seed: seedOf(50) } })
  await begin($, w)
  await $.session.measure(measure(undefined, ['cost']))
  await $.session.measure(measure(50, ['rateLimits', 'cost'], null))
  await $.session.measure(measure(undefined, ['cost']))
  expect(await status($)).not.toContain(BLIND_LINE)
})

test('blind shows the plain quota warning on the badge', async ($, on) => {
  const w = world(on, { store: { seed: seedOf(50) } })
  await begin($, w)
  const view = await badge($)
  expect(await view()).toEqual({ text: ' ● spare10', color: 'success' })
  await $.session.measure(measure(undefined, ['cost']))
  await $.session.measure(measure(undefined, ['cost']))
  await w.clock.settle()
  expect(await view()).toEqual({ text: ' ⚠ spare10 quota unavailable', color: undefined })
})

test('blind passes even a stored seed inside the reserve, and a measured reading makes it trip again', async ($, on) => {
  const w = world(on, { store: { seed: seedOf(93) }, answer: 'Resume' })
  await begin($, w)
  await $.session.measure(measure(undefined, ['cost']))
  await $.session.measure(measure(undefined, ['cost']))
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  await $.session.measure(measure(93)) // a response with the window again
  expect((await bash($)).result).toBe('ran')
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93, RESETS_MS)])
})

test('a live reading wins over blind, and clears it for the remembered reading', async ($, on) => {
  const w = world(on, { store: { seed: seedOf(50) }, answer: 'dismiss' })
  await begin($, w)
  await $.session.measure(measure(undefined, ['cost']))
  await $.session.measure(measure(undefined, ['cost']))
  expect((await bash($)).result).toBe('ran')
  w.pct = 93 // the gate reads live before blind
  expect((await bash($)).deny).toBe(stopText(10, 93, RESETS_MS))
  expect(w.asked).toHaveLength(1)
  await w.clock.settle()
  w.pct = undefined
  expect((await bash($)).deny).toBe(stopText(10, 93, RESETS_MS)) // not blind: the remembered 93 applies
  expect(await status($)).not.toContain(BLIND_LINE)
})

// ---- 6.1 test reading (12.1) ----

test('SPARE10_SIMULATE raises a lower live reading and borrows its reset time', async ($, on) => {
  const w = world(on, { pct: 50, env: { SPARE10_SIMULATE: '95' }, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 95, RESETS_MS)])
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // 3.5: a Resume on a test reading stays in this copy
  expect(await status($)).toMatch(reading(`test reading · ${pf(95, RESETS_MS)} (in `))
  expect(await status($)).toMatch(new RegExp(`consent +until ${clock(RESETS_MS)} \\(you chose to continue\\)`))
})

for (const [sim, live] of [
  ['95', 97],
  ['40', 93],
] as const) {
  test(`a test reading of ${sim} never lowers a live ${live}`, async ($, on) => {
    const w = world(on, { pct: live, env: { SPARE10_SIMULATE: sim }, answer: 'Resume' })
    await begin($, w)
    expect((await bash($)).result).toBe('ran')
    expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, live, RESETS_MS)])
    expect(await status($)).toMatch(reading(`live · ${pf(live, RESETS_MS)}`))
  })
}

test('a test reading equal to the live reading leaves the live basis', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_SIMULATE: '93' }, answer: 'Resume' })
  await begin($, w)
  expect(await status($)).toMatch(reading(`live · ${pf(93, RESETS_MS)}`))
})

for (const [sim, live, text] of [
  ['60', 50, ' ● spare10 (test)'],
  ['40', 50, ' ● spare10'],
] as const) {
  test(`the badge with a test reading of ${sim} over a live ${live} reads "${text.trim()}"`, async ($, on) => {
    const w = world(on, { pct: live, env: { SPARE10_SIMULATE: sim } })
    await begin($, w)
    expect((await bash($)).result).toBe('ran')
    const view = await badge($)
    expect(await view()).toEqual({ text, color: 'success' })
  })
}

test('a test reading applies over a blind sensor', async ($, on) => {
  const w = world(on, { env: { SPARE10_SIMULATE: '95' }, answer: 'Resume' })
  await begin($, w)
  await $.session.measure(measure(undefined, ['cost']))
  await $.session.measure(measure(undefined, ['cost']))
  expect((await bash($)).result).toBe('ran')
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 95, T0 + 5 * HOUR)])
})

test('a test reading over a stored seed runs five hours from now, not to the seed reset', async ($, on) => {
  const w = world(on, { store: { seed: seedOf(50) }, env: { SPARE10_SIMULATE: '95' }, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 95, T0 + 5 * HOUR)])
})

test('a test reading below the trip point never masks a live trip', async ($, on) => {
  const w = world(on, { pct: 50, env: { SPARE10_SIMULATE: '60' }, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  w.pct = 93
  expect((await bash($)).result).toBe('ran')
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93, RESETS_MS)])
})

test('without a live reading the test reading lasts five hours from its first use', async ($, on) => {
  const w = world(on, { env: { SPARE10_SIMULATE: '95' }, answer: 'Resume' })
  await begin($, w)
  const end = T0 + 5 * HOUR
  expect((await bash($)).result).toBe('ran')
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 95, end)])
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // 3.5: a Resume on a test reading stays in this copy
  expect((await bash($)).result).toBe('ran') // this copy keeps the consent while the test reading applies
  expect(w.asked).toHaveLength(1)
  await w.clock.set(end)
  expect((await bash($)).result).toBe('ran') // consent and test reading end together: no reading, no question
  expect(w.asked).toHaveLength(1)
  expect(await status($)).toMatch(reading('none: no reading yet'))
})

test('the test reading ends with the live window it borrowed', async ($, on) => {
  const w = world(on, { pct: 50, env: { SPARE10_SIMULATE: '95' }, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
  await w.clock.set(RESETS_MS + MIN)
  w.pct = 2 // the new window
  w.resetsAt = LATER
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
  expect(await status($)).toMatch(reading(`live · ${pf(2, Date.parse(LATER))}`))
})

test('SPARE10_SIMULATE is read once per activation', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  w.env.set('SPARE10_SIMULATE', '95')
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
})

test('a test reading is never written back to the store or the env', async ($, on) => {
  const w = world(on, { pct: 50, env: { SPARE10_SIMULATE: '95' }, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
  await $.session.measure(measure(50))
  await w.clock.settle()
  expect(w.store.get('seed')).toEqual(seedOf(50))
  expect(w.env.get('SPARE10_SIMULATE')).toBe('95')
})

for (const junk of ['lots', '101', '-1', '']) {
  test(`SPARE10_SIMULATE="${junk}" gives no test reading`, async ($, on) => {
    const w = world(on, { pct: 50, env: { SPARE10_SIMULATE: junk } })
    await begin($, w)
    expect((await bash($)).result).toBe('ran')
    expect(w.asked).toEqual([])
    expect(await status($)).toMatch(reading(`live · ${pf(50, RESETS_MS)}`))
  })
}
