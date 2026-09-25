import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { HOUR, LATER, MIN, OPENS, RESETS, T0, WEEK_OPENS, WEEK_RESETS, bash, begin, clear, cmd, measure, typed, world } from '../helpers/world.ts'
import type { World } from '../helpers/world.ts'

// The floor state (floor design B48 to B55, 2.2 to 2.9, 3.3, 3.4), written from the spec only: the
// consent value with its tier, a 0.2 value, a fresh module (a reload), /clear, /spare10 resume before
// and past the floor, /spare10 stop, the report, the badge, the notices and the simulate replies.
// Every expected text is spelled out here from section 2 of the floor design. Nothing comes from
// hooks/core/text.ts. The world has the shipped spans (20 min, 8 h) and the shipped floors (5, 5).

// ---- clocks and figures, in the machine's zone as the kit runs ----

const R_MS = Date.parse(RESETS)
const O_MS = Date.parse(OPENS)
const W_MS = Date.parse(WEEK_RESETS)
const WO_MS = Date.parse(WEEK_OPENS)
const hhmm = (ms: number): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
/** The weekly clock: `ddd HH:MM` (every weekly time here is within 6 days of now). */
const day = (ms: number): string => `${new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(ms)} ${hhmm(ms)}`
const AT = hhmm(R_MS) // the 5-hour reset
const OPEN = hhmm(O_MS) // the 5-hour skip start
const WAT = day(W_MS) // the weekly reset
const WOPEN = day(WO_MS) // the weekly skip start
const one = (n: number): string => String(Math.round(n * 10) / 10)
const left = (used: number): string => one(100 - used)
const pf = (used: number, at = AT): string => `${one(used)}% used · ${left(used)}% left · resets ${at}`
const LEAD = '20 min before the reset'
const TEST_LEAD = '20 min before the test window ends'
const WLEAD = '8 h before the weekly reset'
const WTEST_LEAD = '8 h before the weekly test window ends'

/** 3.3: a consent value, `<sid> <iso>` (full) or `<sid> <iso> to:<pct>` (a consent to the floor). */
const rec = (sid: string, until: number, to?: number): string =>
  `${sid} ${new Date(until).toISOString()}${to === undefined ? '' : ` to:${to}`}`

// ---- 2.1 and 2.2: the questions ----

/** {asks} of one 5-hour kind with its skip start ahead. */
const asks = (point = 95, open = OPEN): string => `Until ${open}, spare10 asks you again at ${one(point)}% used.`
const TELL_ASKS = `Until ${OPEN}, spare10 tells the agents to wind down at 95% used.`
const W_ASKS = `Until ${WOPEN}, spare10 asks you again at 95% used of the weekly window.`
const BOTH_ASKS = 'Until its reserve opens, spare10 asks you again at 95% used of either window.'
const loopAfter = (at: string, lead: string): string =>
  `If you choose Stop here or do not answer, the work waits until ${at}, ${lead}. Then spare10 continues it, unless a reserve is still reached.`
const promptAfter = `If you do not answer, all of it continues at ${OPEN}, ${LEAD}, unless a reserve is still reached. Stop here gives your prompt back and pauses other work until ${OPEN}.`

/** The first question, loop wording, one 5-hour kind. */
const first = (used: number, o: { point?: number; at?: string; open?: string; lead?: string } = {}): string =>
  `Your 10% reserve is reached: ${pf(used, o.at)}. All work is on hold. Continue on the reserve until ${one(o.point ?? 95)}% used? ` +
  `${asks(o.point, o.open)} ${loopAfter(o.open ?? OPEN, o.lead ?? LEAD)}`
/** The second question, loop wording, one 5-hour kind. */
const second = (used: number, o: { floor?: number; at?: string; open?: string; lead?: string } = {}): string =>
  `Your ${one(o.floor ?? 5)}% floor is reached: ${pf(used, o.at)}. All work is on hold. Continue on the last ${left(used)}% until ${o.at ?? AT}? ` +
  loopAfter(o.open ?? OPEN, o.lead ?? LEAD)
const firstPrompt = (used: number): string =>
  `Your 10% reserve is reached: ${pf(used)}. spare10 holds your prompt and any other work. Continue on the reserve until 95% used? ${asks()} ${promptAfter}`
const secondPrompt = (used: number): string =>
  `Your 5% floor is reached: ${pf(used)}. spare10 holds your prompt and any other work. Continue on the last ${left(used)}% until ${AT}? ${promptAfter}`
const firstTellPrompt = (used: number): string =>
  `Your 10% reserve is reached: ${pf(used)}. spare10 holds your prompt. Continue on the reserve until 95% used? ${TELL_ASKS} ` +
  `If you do not answer, your prompt goes in at ${OPEN}, ${LEAD}, unless a reserve is still reached. Stop here gives it back to you.`
const weekFirst = (used: number, point = 95, lead = WLEAD): string =>
  `Your 10% weekly reserve is reached: ${pf(used, WAT)}. All work is on hold. Continue on the weekly reserve until ${one(point)}% used? ` +
  `Until ${WOPEN}, spare10 asks you again at ${one(point)}% used of the weekly window. ${loopAfter(WOPEN, lead)}`
const weekSecond = (used: number, floor = 5, lead = WLEAD): string =>
  `Your ${one(floor)}% weekly floor is reached: ${pf(used, WAT)}. All work is on hold. Continue on the last ${left(used)}% of the weekly window until ${WAT}? ` +
  loopAfter(WOPEN, lead)
const twoPf = (five: number, week: number): string => `5-hour window ${pf(five)}, weekly window ${pf(week, WAT)}`
const bothFirst = (five: number, week: number): string =>
  `Your 10% reserve and your 10% weekly reserve are reached: ${twoPf(five, week)}. All work is on hold. ` +
  `Continue on both reserves until 95% used? ${BOTH_ASKS} ${loopAfter(WOPEN, WLEAD)}`
const mixed = (five: number, week: number): string =>
  `Your 10% reserve and your 5% weekly floor are reached: ${twoPf(five, week)}. All work is on hold. ` +
  `Continue on the reserve until 95% used and the last ${left(week)}% of the weekly window until ${WAT}? ${asks()} ${loopAfter(WOPEN, WLEAD)}`

// ---- 2.3 and 2.4: model texts and transcript notices ----

const stopReserve = (used: number, at = AT): string =>
  `spare10: the user stopped work at the quota reserve (into your 10% reserve · ${left(used)}% of quota left · resets ${at}). Stop now and wait for the user. Do not call any further tools.`
const stopFloor = (used: number, at = AT): string =>
  `spare10: the user stopped work at the quota reserve (into your 5% floor · ${left(used)}% of quota left · resets ${at}). Stop now and wait for the user. Do not call any further tools.`
const NOTE_RESERVE = 'spare10: earlier work stopped at the 10% quota reserve. The user now chose to continue on the reserve until 95% used. Follow their message.'
const noteFloor = (used: number): string =>
  `spare10: earlier work stopped at the 5% quota floor. The user now chose to continue on the last ${left(used)}% until ${AT}. Follow their message.`
const contFirst = (point = 95): string => `continuing on your 10% reserve until ${one(point)}% used. ${asks(point)}`
const CONT_SECOND = `continuing on your 5% floor. spare10 stays quiet until ${AT}.`
const CONT_WEEK_FIRST = `continuing on your 10% weekly reserve until 95% used. ${W_ASKS}`
const CONT_BOTH = `continuing on your 10% reserve until 95% used and your 10% weekly reserve until 95% used. ${BOTH_ASKS}`
const CONT_MIXED = `continuing on your 10% reserve until 95% used and your 5% weekly floor until ${WAT}. ${asks()}`
const CONT_TELL = `continuing on your 10% reserve until 95% used. ${TELL_ASKS}`
const CONT_SPANS_OFF = 'continuing on your 10% reserve until 95% used. At 95% used, spare10 asks you again.'
const STOPPED_FLOOR = `stopped at your 5% floor until ${OPEN}, ${LEAD}. Then spare10 continues the work, unless a reserve is still reached. Type a prompt to be asked again, or run /spare10 resume.`

// ---- 2.8: command replies ----

const TRIPPED_FIRST = `you can use the reserve until 95% used. ${asks()}`
const trippedSecond = (used: number, at = AT): string => `you can use the last ${left(used)}% until ${at}.`
const STOPPED_FIRST = `resumed. You can use the reserve until 95% used. ${asks()} Type a prompt to continue.`
const stoppedSecond = (used: number): string => `resumed. You can use the last ${left(used)}% until ${AT}. Type a prompt to continue.`
const ASKING_FIRST = `resumed. Held work continues on the reserve until 95% used. ${asks()}`
const askingSecond = (used: number): string => `resumed. Held work continues on the last ${left(used)}% until ${AT}.`
const ALREADY_FLOOR = `already resumed until 95% used. ${asks()}`
const ALREADY_FULL = `already resumed until ${AT}.`
const stopTripped = (lead = LEAD): string =>
  `stopped at the reserve until ${OPEN}, ${lead}. Then spare10 continues any stopped work. Type a prompt to be asked again, or run /spare10 resume.`

// ---- 2.9: simulate replies ----

const simSet = (what: string, at: string, extra: string): string =>
  `test reading set to ${what}, resets ${at}. It can only raise the real reading.${extra} Run /spare10 simulate off to clear it.`
const simRaised = (what: string, at: string, extra: string): string =>
  `test reading raised to ${what}, resets ${at}. Your earlier answers stay. It can only raise the real reading.${extra} Run /spare10 simulate off to clear it.`
const PAST = ' This is past your 5% floor.'
const W_PAST = ' This is past your 5% weekly floor.'
const opens = (at = OPEN, lead = TEST_LEAD): string => ` The reserve opens at ${at}, ${lead}.`
const W_OPENS = ` The weekly reserve opens at ${WOPEN}, ${WTEST_LEAD}.`
const REAL_HOLDS = ' The real reading is also in the reserve, so the test window does not open it.'
const REAL_IN = ' A Resume on the test reading also lets real work use the reserve.'

// ---- 2.7: the report ----

const FLOOR_ROW = '5%: after a Resume, spare10 asks again at 95% used (from /config)'
const W_FLOOR_ROW = '5%: after a Resume, spare10 asks again at 95% used of the weekly window (from /config)'
const HELP_FLOOR = '/spare10 resume   continue on the reserve until the floor, or past the floor until the reset'
const HELP_02 = '/spare10 resume   continue on the reserve until the window resets'
const HELP_STOP = '/spare10 stop     stop at the reserve now'
const PHASE_TRIPPED = '  ⚠ tripped        spare10 holds the next step and asks you.'
const consented = (detail: string): string => `  ⨯ consented      ${detail}`
const floorConsent = (point = 95, at = AT): string => `until ${one(point)}% used or ${at} (you chose to continue)`
const endedConsent = (point = 95): string => `ended at ${one(point)}% used (you chose to continue until then)`

// ---- helpers ----

type Logs = Pick<World, 'logs'>
const transcript = (w: Logs): string[] => w.logs.filter((l) => l.to !== 'debug').map((l) => l.text)
const questions = (w: World): string[] => w.asked.map((a) => a.question)

async function run($: Engine, args: string): Promise<string> {
  return (await $.command.run(cmd(args))).text ?? ''
}

async function report($: Engine): Promise<string[]> {
  return (await run($, '')).split('\n')
}

/** The value of a report row: the text after its label, padded to 15. undefined when the row is left out. */
function rowOf(lines: string[], label: string): string | undefined {
  const head = `  · ${label.padEnd(15)}`
  const line = lines.find((l) => l.startsWith(head))
  return line?.slice(head.length)
}
const phaseOf = (lines: string[]): string | undefined => lines[2]

/** The footer badge as the terminal draws it: its one Text and that Text's colour. */
async function badgeOf($: Engine): Promise<{ text: string | undefined; color: unknown }> {
  const ui = await $.ui.mount({ plugin: 'spare10', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  const t = await ui.find({ type: 'Text' })
  await ui.unmount()
  return { text: t?.text, color: t?.props['color'] }
}

/** D1 and the text rules: no prefix that the engine adds, no em-dash, no en-dash, no semicolon. */
function clean(texts: readonly string[]): void {
  for (const t of texts) {
    expect(t.startsWith('spare10')).toBe(false)
    expect(/[\u2013\u2014;]/.test(t)).toBe(false)
  }
}

/** A first question at `used` that the person answers Resume. The consent to the floor is written after it. */
async function resumeAtReserve($: Engine, w: World, used = 91): Promise<void> {
  w.pct = used
  w.answer = 'hang'
  const held = bash($)
  await w.clock.settle()
  expect(questions(w).at(-1)).toBe(first(used))
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
}

// ======================================================================================================
// 3.3: the consent value carries the tier
// ======================================================================================================

test('a Resume at the reserve writes the end point, the reading at the point ends the value for good, and a second Resume writes a full value', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const n = transcript(w).length
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toEqual([{ question: first(91), header: 'spare10', labels: ['Stop here', 'Resume'] }])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
  expect(w.env.has('SPARE10_WEEKLY_CONSENT')).toBe(false)
  expect(transcript(w).slice(n)).toEqual([contFirst()])

  w.pct = 94.9 // below the point: the consent applies
  expect((await bash($)).result).toBe('ran')
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))

  w.pct = 95 // at the point: the consent ends for good, and the gate asks the second question
  const held2 = bash($)
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([first(91), second(95)])
  expect(w.asked[1]?.labels).toEqual(['Stop here', 'Resume'])
  expect(w.env.has('SPARE10_CONSENT')).toBe(false) // B52: unset once a gate saw the point
  expect(transcript(w).slice(n)).toEqual([contFirst()]) // 2.4: no notice says that the consent ended
  expect(w.ran).toEqual(['Bash:main', 'Bash:main'])

  w.release('Resume')
  expect((await held2).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS)) // full: until the reset
  expect(transcript(w).slice(n)).toEqual([contFirst(), CONT_SECOND])
  w.pct = 99.9
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(2)
  clean(transcript(w))
})

test('a floor of 2.5 writes to:97.5, and every text and the value name that point', async ($, on) => {
  const w = world(on, { pct: 91, env: { SPARE10_RESUME_FLOOR: '2.5' } })
  await begin($, w)
  expect(rowOf(await report($), 'resume floor')).toBe('2.5%: after a Resume, spare10 asks again at 97.5% used (from SPARE10_RESUME_FLOOR)')
  const n = transcript(w).length
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([first(91, { point: 97.5 })])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 97.5))
  expect(transcript(w).slice(n)).toEqual([contFirst(97.5)])
  w.pct = 97.4
  expect((await bash($)).result).toBe('ran')
  w.pct = 97.5
  const held2 = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([first(91, { point: 97.5 }), second(97.5, { floor: 2.5 })])
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  w.release('Resume')
  expect((await held2).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS))
  expect(transcript(w).slice(n)).toEqual([contFirst(97.5), `continuing on your 2.5% floor. spare10 stays quiet until ${AT}.`])
})

for (const c of [
  { floor: undefined, point: 95 },
  { floor: '3', point: 97 },
]) {
  test(`a weekly Resume writes SPARE10_WEEKLY_CONSENT with the end point ${c.point}, and the weekly reading at it asks the second question`, async ($, on) => {
    const w = world(on, { pct: 50, weekPct: 91, env: c.floor === undefined ? {} : { SPARE10_WEEKLY_RESUME_FLOOR: c.floor } })
    await begin($, w)
    const n = transcript(w).length
    const held = bash($)
    await w.clock.settle()
    expect(questions(w)).toEqual([weekFirst(91, c.point)])
    w.release('Resume')
    expect((await held).result).toBe('ran')
    await w.clock.settle()
    expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(rec('S1', W_MS, c.point))
    expect(w.env.has('SPARE10_CONSENT')).toBe(false)
    expect(transcript(w).slice(n)).toEqual([
      `continuing on your 10% weekly reserve until ${c.point}% used. Until ${WOPEN}, spare10 asks you again at ${c.point}% used of the weekly window.`,
    ])
    const lines = await report($)
    expect(rowOf(lines, 'weekly consent')).toBe(floorConsent(c.point, WAT))
    expect(rowOf(lines, 'consent')).toBe('none')
    w.weekPct = c.point - 0.1
    expect((await bash($)).result).toBe('ran')
    w.weekPct = c.point
    const held2 = bash($)
    await w.clock.settle()
    expect(questions(w)).toEqual([weekFirst(91, c.point), weekSecond(c.point, 100 - c.point)])
    expect(w.env.has('SPARE10_WEEKLY_CONSENT')).toBe(false)
    w.release('Resume')
    expect((await held2).result).toBe('ran')
    await w.clock.settle()
    expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(rec('S1', W_MS))
    expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  })
}

test('a question on both windows at the reserve writes both values with their end points', async ($, on) => {
  const w = world(on, { pct: 91, weekPct: 92, answer: 'Resume' })
  await begin($, w)
  const n = transcript(w).length
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(questions(w)).toEqual([bothFirst(91, 92)])
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(rec('S1', W_MS, 95))
  expect(transcript(w).slice(n)).toEqual([CONT_BOTH])
  const lines = await report($)
  expect(rowOf(lines, 'consent')).toBe(floorConsent())
  expect(rowOf(lines, 'weekly consent')).toBe(floorConsent(95, WAT))
  expect(phaseOf(lines)).toBe(consented(`you chose to continue. ${BOTH_ASKS}`))
})

test('a question with the 5-hour window at the reserve and the weekly window at its floor writes each kind at its own tier', async ($, on) => {
  const w = world(on, { pct: 91, weekPct: 96, answer: 'Resume' })
  await begin($, w)
  const n = transcript(w).length
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(questions(w)).toEqual([mixed(91, 96)])
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(rec('S1', W_MS))
  expect(transcript(w).slice(n)).toEqual([CONT_MIXED])
  const lines = await report($)
  expect(rowOf(lines, 'consent')).toBe(floorConsent())
  expect(rowOf(lines, 'weekly consent')).toBe(`until ${WAT} (you chose to continue)`)
  expect(phaseOf(lines)).toBe(consented(`you chose to continue. ${asks()}`))
  expect(await run($, 'resume')).toBe(`already resumed until 95% used, and until ${WAT} on the weekly window. ${asks()}`)
})

test('a Resume on a test reading keeps its end point in this copy and never in the env', async ($, on) => {
  const w = world(on, { pct: 50, answer: 'Resume' })
  await begin($, w)
  expect(await run($, 'simulate 91')).toBe(simSet('91% used', AT, opens()))
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(questions(w)).toEqual([first(91, { lead: TEST_LEAD })])
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  const lines = await report($)
  expect(rowOf(lines, 'consent')).toBe(floorConsent())
  expect(phaseOf(lines)).toBe(consented(`you chose to continue. ${asks()}`))
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10 (test): resumed until 95% used', color: 'warning' })
})

// 3.3: anything else is no consent (fail closed). An attended session takes only its own stamp (0.2).
const refused: Array<{ name: string; raw: string }> = [
  { name: 'a junk end point', raw: `S1 ${RESETS} to:abc` },
  { name: 'an end point of 0', raw: `S1 ${RESETS} to:0` },
  { name: 'an end point of 100', raw: `S1 ${RESETS} to:100` },
  { name: 'an end point with two decimals', raw: `S1 ${RESETS} to:95.55` },
  { name: 'an empty end point', raw: `S1 ${RESETS} to:` },
  { name: 'a third token that is not an end point', raw: `S1 ${RESETS} until:95` },
  { name: 'a fourth token', raw: `S1 ${RESETS} to:95 x` },
  { name: 'an end point after a bare time', raw: `${RESETS} to:95` },
  { name: 'the stamp of another session', raw: `S0 ${RESETS} to:95` },
  { name: 'a time after this window', raw: `S1 ${LATER} to:95` },
]
for (const c of refused) {
  test(`a consent value with ${c.name} is no consent, so spare10 asks the first question`, async ($, on) => {
    const w = world(on, { pct: 93, env: { SPARE10_CONSENT: c.raw }, answer: 'Stop here' })
    await begin($, w)
    const lines = await report($)
    expect(rowOf(lines, 'consent')).toBe('none')
    expect(phaseOf(lines)).toBe(PHASE_TRIPPED)
    expect((await bash($)).deny).toBe(stopReserve(93))
    expect(questions(w)).toEqual([first(93)])
  })
}

test('a 0.2 value is a full consent: past the floor nothing asks, and every surface shows the 0.2 form', async ($, on) => {
  const w = world(on, { pct: 96, env: { SPARE10_CONSENT: rec('S1', R_MS) } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  w.pct = 99
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  const lines = await report($)
  expect(rowOf(lines, 'consent')).toBe(`until ${AT} (you chose to continue)`)
  expect(phaseOf(lines)).toBe(consented(`you chose to continue. spare10 is quiet until ${AT}.`))
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10', color: 'warning' })
  w.pct = 93
  expect(await run($, 'resume')).toBe(ALREADY_FULL) // 2.8 verbatim (a 0.2 value at 93)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS))
})

test('a bare 0.2 pre-answer (one token) is a full consent past the floor too', async ($, on) => {
  const w = world(on, { pct: 97, env: { SPARE10_CONSENT: RESETS } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  expect(rowOf(await report($), 'consent')).toBe(`until ${AT} (you chose to continue)`)
})

test('a value with an end point above the floor point ends at the floor point in force (the lower one)', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_CONSENT: rec('S1', R_MS, 97) } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  const lines = await report($)
  expect(rowOf(lines, 'consent')).toBe(floorConsent(95)) // the end point now: min(97, 95)
  expect(phaseOf(lines)).toBe(consented(`you chose to continue. ${asks(95)}`))
  expect(await run($, 'resume')).toBe(ALREADY_FLOOR)
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10: resumed until 95% used', color: 'warning' })
  w.pct = 95
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([second(95)])
  await w.clock.settle()
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  w.release('Stop here')
  expect((await held).deny).toBe(stopFloor(95))
})

test('a value with an end point below the reading ends for good at the first gate, and the question asks for the floor point', async ($, on) => {
  const w = world(on, { pct: 94, env: { SPARE10_CONSENT: rec('S1', R_MS, 93) } })
  await begin($, w)
  const lines = await report($)
  expect(rowOf(lines, 'consent')).toBe(endedConsent(93)) // 2.7: reached, not yet ended by a gate
  expect(phaseOf(lines)).toBe(PHASE_TRIPPED)
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 93)) // the report only reads
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([first(94)]) // at the reserve: 94 is below the floor point 95
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  expect(rowOf(await report($), 'consent')).toBe('none')
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
})

// ======================================================================================================
// A fresh module (a reload): the env value is all that is left
// ======================================================================================================

test('a fresh module finds a consent to the floor: work runs below its point, and the report, badge and resume reply name the point', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_CONSENT: rec('S1', R_MS, 95) }, agents: ['a1'] })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect((await bash($, 'a1')).result).toBe('ran')
  expect(w.asked).toEqual([])
  const lines = await report($)
  expect(rowOf(lines, 'consent')).toBe(floorConsent())
  expect(rowOf(lines, 'weekly consent')).toBe('none')
  expect(phaseOf(lines)).toBe(consented(`you chose to continue. ${asks()}`))
  expect(lines).toContain(HELP_FLOOR)
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10: resumed until 95% used', color: 'warning' })
  const reply = await run($, 'resume')
  expect(reply).toBe(ALREADY_FLOOR)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95)) // unchanged
  clean([reply, ...transcript(w)])

  w.pct = 95
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([second(95)])
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS))
})

test('a fresh module past the point shows the consent as ended until a gate ends it for good', async ($, on) => {
  const w = world(on, { pct: 96, env: { SPARE10_CONSENT: rec('S1', R_MS, 95) } })
  await begin($, w)
  let lines = await report($)
  expect(rowOf(lines, 'consent')).toBe(endedConsent())
  expect(phaseOf(lines)).toBe(PHASE_TRIPPED)
  expect((await badgeOf($)).text?.trim().endsWith('Pausing at next step')).toBe(true)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95)) // the report and the badge only read

  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([second(96)])
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  lines = await report($)
  expect(rowOf(lines, 'consent')).toBe('none')
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS))
  lines = await report($)
  expect(rowOf(lines, 'consent')).toBe(`until ${AT} (you chose to continue)`)
})

test('a fresh module finds a weekly consent to the floor and ends it at the weekly point', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 93, env: { SPARE10_WEEKLY_CONSENT: rec('S1', W_MS, 95) } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  const lines = await report($)
  expect(rowOf(lines, 'weekly consent')).toBe(floorConsent(95, WAT))
  expect(phaseOf(lines)).toBe(consented(`you chose to continue. ${W_ASKS}`))
  expect(await run($, 'resume')).toBe(`already resumed until 95% used of the weekly window. ${W_ASKS}`)
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10: resumed until 95% used', color: 'warning' })
  w.weekPct = 96
  expect(rowOf(await report($), 'weekly consent')).toBe(endedConsent())
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([weekSecond(96)])
  expect(w.env.has('SPARE10_WEEKLY_CONSENT')).toBe(false)
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(rec('S1', W_MS))
})

test('a fresh module with consents to the floor on both windows names both end points', async ($, on) => {
  const w = world(on, {
    pct: 91,
    weekPct: 93,
    env: { SPARE10_CONSENT: rec('S1', R_MS, 95), SPARE10_WEEKLY_CONSENT: rec('S1', W_MS, 95) },
  })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  const lines = await report($)
  expect(rowOf(lines, 'consent')).toBe(floorConsent())
  expect(rowOf(lines, 'weekly consent')).toBe(floorConsent(95, WAT))
  expect(phaseOf(lines)).toBe(consented(`you chose to continue. ${BOTH_ASKS}`))
  expect(await run($, 'resume')).toBe(`already resumed until 95% used, and until 95% used of the weekly window. ${BOTH_ASKS}`)
  // 2.6: the covered kind nearest its end point names the badge: here the weekly kind (2 points left).
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10: resumed until 95% used', color: 'warning' })
})

test('the badge names the end point of the covered kind nearest to it', async ($, on) => {
  const w = world(on, {
    pct: 91,
    weekPct: 96,
    env: {
      SPARE10_WEEKLY_RESUME_FLOOR: '3',
      SPARE10_CONSENT: rec('S1', R_MS, 95),
      SPARE10_WEEKLY_CONSENT: rec('S1', W_MS, 97),
    },
  })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  // 5-hour: 4 points to 95. Weekly: 1 point to 97. The weekly kind is nearer.
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10: resumed until 97% used', color: 'warning' })
  w.pct = 94.5
  w.weekPct = 92
  await $.session.measure(measure(94.5, ['rateLimits', 'cost'], RESETS, { pct: 92 }))
  await w.clock.settle()
  // 5-hour: 0.5 points to 95. Weekly: 5 points to 97. Now the 5-hour kind is nearer.
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10: resumed until 95% used', color: 'warning' })
})

test('a weekly 0.2 value is a full consent past the weekly floor', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 97, env: { SPARE10_WEEKLY_CONSENT: rec('S1', W_MS) } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  expect(rowOf(await report($), 'weekly consent')).toBe(`until ${WAT} (you chose to continue)`)
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10', color: 'warning' })
})

test('a floor switched off after the Resume still ends the consent at its point, and the next question consents until the reset', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_RESUME_FLOOR: '0', SPARE10_CONSENT: rec('S1', R_MS, 95) } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  const lines = await report($)
  expect(rowOf(lines, 'resume floor')).toBe('off. A Resume lasts until the reset (from SPARE10_RESUME_FLOOR)')
  expect(rowOf(lines, 'consent')).toBe(floorConsent())
  expect(await run($, 'resume')).toBe(ALREADY_FLOOR)
  w.pct = 95
  const held = bash($)
  await w.clock.settle()
  // No floor in force: the 0.2 question at the reserve.
  expect(questions(w)).toEqual([
    `Your 10% reserve is reached: ${pf(95)}. All work is on hold. Continue on the reserve until ${AT}? ${loopAfter(OPEN, LEAD)}`,
  ])
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS))
})

// 3.3: two tiers in one variable.

test('a late write of a consent to the floor keeps a full value stamped with a past id of this process', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  await clear($, w, 'S2')
  await w.clock.advance(2000) // both moves run, with nothing to move
  w.pct = 91
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([first(91)])
  w.env.set('SPARE10_CONSENT', rec('S1', R_MS)) // full, stamped S1: an ended id of this process
  w.release('Resume') // at once: no carrier cycle between
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS)) // the stronger tier stays
  w.pct = 96
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('a write of a consent to the floor replaces a full value of another session', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  w.env.set('SPARE10_CONSENT', rec('S0', R_MS)) // not this process: it never counts here
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
})

test('the end of a consent to the floor never unsets a full value that another copy wrote after the read', async ($, on) => {
  const w = world(on, { pct: 96, env: { SPARE10_CONSENT: rec('S1', R_MS, 95) } })
  await begin($, w)
  w.envGetDelayMs = { SPARE10_CONSENT: 200 } // the gate reads the consent to the floor and gets it late
  const held = bash($)
  await w.clock.settle()
  w.env.set('SPARE10_CONSENT', rec('S1', R_MS)) // another copy's second Resume lands meanwhile
  await w.clock.advance(1000) // the stale read returns, and the end compares with the value now
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS))
  w.envGetDelayMs = {}
  w.cap() // the next carrier cycle, if a question opened on the stale read: the full value answers it
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS))
})

// B52: each consent ends only on its own basis.

test('a test reading past the point never ends a real consent to the floor', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  await run($, 'simulate 50') // a test reading below the real one: the real reading is the view
  await resumeAtReserve($, w) // the real reading trips at 91: a real Resume
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
  expect(await run($, 'simulate 96')).toBe(simRaised('96% used', AT, `${PAST}${opens()}${REAL_IN}`))
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([first(91), second(96, { lead: TEST_LEAD })]) // the real consent does not apply to the test view
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95)) // not ended: the real reading is 91
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95)) // a test Resume never goes into the env
})

test('a real reading past the point never ends a test consent to the floor', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  await run($, 'simulate 91')
  expect(await run($, 'resume')).toBe(TRIPPED_FIRST)
  w.pct = 96 // the real reading passes the test reading and the floor point
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([second(96)])
  w.pct = 50 // the test reading is the view again, and its consent to the floor applies again
  expect(rowOf(await report($), 'consent')).toBe(floorConsent()) // never ended by the real reading
  w.cap() // the next carrier cycle
  await w.clock.advance(2 * MIN) // the reset clock reads the fall and lets the held work go
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(rowOf(await report($), 'consent')).toBe(floorConsent())
  expect((await bash($)).result).toBe('ran')
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
})

// ======================================================================================================
// /clear and in-session /resume (3.4: the consent stays, restampConsent keeps `to`)
// ======================================================================================================

test('/clear keeps a consent to the floor at once, moves its stamp with the end point, and it still ends at its point', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
  await clear($, w, 'S2')
  w.pct = 93
  expect((await bash($)).result).toBe('ran') // the ended id is this process's: its consent counts
  await w.clock.advance(300)
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S2', R_MS, 95))
  await w.clock.advance(1500)
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S2', R_MS, 95))
  const lines = await report($)
  expect(rowOf(lines, 'consent')).toBe(floorConsent())
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10: resumed until 95% used', color: 'warning' })
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)

  w.pct = 95
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([first(91), second(95)])
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S2', R_MS)) // stamped with the new id, full
})

test('an in-session /resume moves a full value after the second Resume, with no end point', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  w.pct = 96
  const held = bash($)
  await w.clock.settle()
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS))
  await clear($, w, 'S2', 'resume')
  await w.clock.advance(2000)
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S2', R_MS))
  w.pct = 99
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(2)
})

test('/clear never writes back a consent to the floor that a gate ended while the move read it', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  await clear($, w, 'S2')
  w.envGetDelayMs = { SPARE10_CONSENT: 200 } // the move reads the old value and gets it late
  await w.clock.advance(300)
  w.envGetDelayMs = {}
  w.pct = 96
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([first(91), second(96)])
  expect(w.env.has('SPARE10_CONSENT')).toBe(false) // B52 ended it
  await w.clock.advance(2000) // the stale read returns, and both moves run
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  w.release('Stop here')
  expect((await held).deny).toBe(stopFloor(96))
  await w.clock.settle()
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
})

test('/clear never lowers a second Resume that replaced the consent to the floor while the move read it', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  await clear($, w, 'S2')
  w.envGetDelayMs = { SPARE10_CONSENT: 200 }
  await w.clock.advance(300)
  w.envGetDelayMs = {}
  w.pct = 96
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([first(91), second(96)])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S2', R_MS))
  await w.clock.advance(2000)
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S2', R_MS)) // the full value stays
})

// ======================================================================================================
// /spare10 resume before and past the floor (2.8, B50 item 4)
// ======================================================================================================

test('/spare10 resume at the reserve consents to the floor, again says so, and past the floor consents until the reset', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const n = transcript(w).length
  expect(await run($, 'resume')).toBe(TRIPPED_FIRST)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
  expect(w.asked).toEqual([])
  w.pct = 93
  expect(await run($, 'resume')).toBe(ALREADY_FLOOR)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
  expect((await bash($)).result).toBe('ran')

  w.pct = 96 // no gate event between: the command itself ends the consent to the floor
  expect(rowOf(await report($), 'consent')).toBe(endedConsent())
  expect(await run($, 'resume')).toBe(trippedSecond(96))
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS))
  expect(rowOf(await report($), 'consent')).toBe(`until ${AT} (you chose to continue)`)
  expect(await run($, 'resume')).toBe(ALREADY_FULL)
  w.pct = 99
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  clean(transcript(w).slice(n))
})

test('/spare10 resume past the floor in a fresh session consents until the reset', async ($, on) => {
  const w = world(on, { pct: 96 })
  await begin($, w)
  expect(await run($, 'resume')).toBe(trippedSecond(96))
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS))
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10', color: 'warning' })
})

test('/spare10 resume with both windows at the reserve consents each to its point', async ($, on) => {
  const w = world(on, { pct: 91, weekPct: 92 })
  await begin($, w)
  expect(await run($, 'resume')).toBe(`you can use both reserves until 95% used. ${BOTH_ASKS}`)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(rec('S1', W_MS, 95))
})

test('/spare10 resume with the 5-hour window at the reserve and the weekly window past its floor', async ($, on) => {
  const w = world(on, { pct: 91, weekPct: 96 })
  await begin($, w)
  expect(await run($, 'resume')).toBe(`you can use the reserve until 95% used and the last 4% of the weekly window until ${WAT}. ${asks()}`)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(rec('S1', W_MS))
})

test('/spare10 resume in a stopped session at the reserve consents to the floor, and at the floor until the reset', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Stop here' })
  await begin($, w)
  expect((await bash($)).deny).toBe(stopReserve(93))
  await w.clock.settle()
  expect(w.env.has('SPARE10_STOPPED')).toBe(true)
  expect(await run($, 'resume')).toBe(STOPPED_FIRST)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect((await bash($)).result).toBe('ran')

  w.pct = 96
  w.answer = 'Stop here'
  expect((await bash($)).deny).toBe(stopFloor(96)) // the second question, answered Stop here
  await w.clock.settle()
  expect(questions(w)).toEqual([first(93), second(96)])
  expect(w.env.has('SPARE10_STOPPED')).toBe(true)
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  expect(await run($, 'resume')).toBe(stoppedSecond(96))
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS))
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect((await bash($)).result).toBe('ran')
})

test('/spare10 resume on an open first question releases the held call with a consent to the floor', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([first(91)])
  expect(await run($, 'resume')).toBe(ASKING_FIRST)
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
  expect(w.asked).toHaveLength(1)
})

test('/spare10 resume on an open second question releases the held call with a full consent', async ($, on) => {
  const w = world(on, { pct: 96 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([second(96)])
  expect(await run($, 'resume')).toBe(askingSecond(96))
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS))
  expect(w.asked).toHaveLength(1)
})

test('/spare10 resume on an open first question whose reading passed the floor consents until the reset (B50 item 4)', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([first(91)])
  w.pct = 96
  expect(await run($, 'resume')).toBe(askingSecond(96))
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS))
  expect(w.asked).toHaveLength(1) // no second question
  expect((await bash($)).result).toBe('ran')
})

test('/spare10 resume on an open first question keeps its tier when the fresh reading at the floor is a test reading (B50 item 4)', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([first(91)])
  await run($, 'simulate 96') // the same window, but on the test basis
  expect(await run($, 'resume')).toBe(ASKING_FIRST)
  await w.clock.settle()
  // The real consent to the floor of the question, never a full value. The test reading asks the second question.
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
  expect(questions(w)).toEqual([first(91), second(96, { lead: TEST_LEAD })])
  expect(w.ran).toEqual([])
  w.release('Stop here')
  expect((await held).deny).toBeDefined()
})

test('/spare10 resume on an open first question keeps its tier when the fresh reading at the floor is in another window (B50 item 4)', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([first(91)])
  w.resetsAt = LATER // the window reset early: a new window at 96%
  w.pct = 96
  expect(await run($, 'resume')).toBe(ASKING_FIRST)
  await w.clock.settle()
  // The consent to the floor of the question ends at once in the new window, and the second question comes. Never a full value.
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(w.asked).toHaveLength(2)
  expect(w.asked[1]?.question.startsWith('Your 5% floor is reached: 96% used')).toBe(true)
  expect(w.ran).toEqual([])
  w.release('Stop here')
  expect((await held).deny).toBeDefined()
})

test('/spare10 resume and the report in tell mode say that spare10 tells the agents to wind down', async ($, on) => {
  const w = world(on, { pct: 91, env: { SPARE10_PAUSE_PROMPT: 'Stop.' } })
  await begin($, w)
  let lines = await report($)
  expect(rowOf(lines, 'resume floor')).toBe('5%: after a Resume, spare10 tells the agents to wind down at 95% used (from /config)')
  expect(rowOf(lines, 'weekly floor')).toBe('5%: after a Resume, spare10 tells the agents to wind down at 95% used of the weekly window (from /config)')
  expect(await run($, 'resume')).toBe(`you can use the reserve until 95% used. ${TELL_ASKS}`)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
  lines = await report($)
  expect(phaseOf(lines)).toBe(consented(`you chose to continue. ${TELL_ASKS}`))
  expect(await run($, 'resume')).toBe(`already resumed until 95% used. ${TELL_ASKS}`)
})

test('a prompt question in tell mode names the wind-down at the floor, and its Resume notice says so too', async ($, on) => {
  const w = world(on, { pct: 91, env: { SPARE10_PAUSE_PROMPT: 'Stop.' } })
  await begin($, w)
  const n = transcript(w).length
  const p = $.prompt.submit(typed('go on'))
  await w.clock.settle()
  expect(questions(w)).toEqual([firstTellPrompt(91)])
  w.release('Resume')
  expect(await p).toMatchObject({ text: 'go on' })
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
  expect(transcript(w).slice(n)).toEqual([CONT_TELL])
})

test('/spare10 resume with the spans off says that spare10 asks again at the point, with no clock', async ($, on) => {
  const w = world(on, { pct: 91, spans: 'off' })
  await begin($, w)
  expect(await run($, 'resume')).toBe('you can use the reserve until 95% used. At 95% used, spare10 asks you again.')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
  expect(phaseOf(await report($))).toBe(consented('you chose to continue. At 95% used, spare10 asks you again.'))
})

test('a Resume notice with the spans off names the point with no clock', async ($, on) => {
  const w = world(on, { pct: 91, spans: 'off', answer: 'Resume' })
  await begin($, w)
  const n = transcript(w).length
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w).slice(n)).toEqual([CONT_SPANS_OFF])
})

test('/spare10 resume with no reset time consents for one hour, or until the point', async ($, on) => {
  const w = world(on, { pct: 91, resetsAt: null })
  await begin($, w)
  expect(await run($, 'resume')).toBe('you can use the reserve for one hour, or until 95% used. At 95% used, spare10 asks you again.')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toMatch(/^S1 \S+ to:95$/)
})

for (const c of [
  { name: 'SPARE10_RESUME_FLOOR=0', env: { SPARE10_RESUME_FLOOR: '0' } },
  { name: 'a floor at the reserve (SPARE10_RESUME_FLOOR=10)', env: { SPARE10_RESUME_FLOOR: '10' } },
  { name: 'a floor above the reserve (SPARE10_RESUME_FLOOR=12)', env: { SPARE10_RESUME_FLOOR: '12' } },
]) {
  test(`with ${c.name} /spare10 resume consents until the reset, as in 0.2`, async ($, on) => {
    const w = world(on, { pct: 91, env: c.env })
    await begin($, w)
    expect(await run($, 'resume')).toBe(`you can use the reserve until ${AT}.`)
    await w.clock.settle()
    expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS))
    w.pct = 99
    expect((await bash($)).result).toBe('ran')
    expect(w.asked).toEqual([])
  })
}

test('a 5-hour floor never changes the weekly value: a weekly Resume with the 5-hour floor off still ends at its point', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 91, env: { SPARE10_RESUME_FLOOR: '0' }, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(rec('S1', W_MS, 95))
  w.pct = 92 // a 5-hour trip with the 5-hour floor off
  expect(await run($, 'resume')).toBe(`you can use the reserve until ${AT}.`)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS))
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(rec('S1', W_MS, 95))
})

// ======================================================================================================
// /spare10 stop (2.8: unchanged, and it clears the consents to the floor)
// ======================================================================================================

test('/spare10 stop clears a consent to the floor, and a prompt while stopped asks the first question, whose Resume writes the point and the note', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
  w.pct = 93
  const reply = await run($, 'stop')
  expect(reply).toBe(stopTripped())
  await w.clock.settle()
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  expect(w.env.get('SPARE10_STOPPED')).toMatch(/^S1 /)
  const lines = await report($)
  expect(rowOf(lines, 'consent')).toBe('none')
  expect((await bash($)).deny).toBe(stopReserve(93))

  const p = $.prompt.submit(typed('go on'))
  await w.clock.settle()
  expect(questions(w)).toEqual([first(91), firstPrompt(93)])
  expect(w.prompts).toEqual([])
  w.release('Resume')
  expect(await p).toMatchObject({ text: 'go on' })
  expect(w.prompts.map((e) => e.context)).toEqual([[NOTE_RESERVE]])
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect((await bash($)).result).toBe('ran')
  clean([reply, ...transcript(w)])
})

test('/spare10 stop past the floor: its reply says at the reserve, the stop names the floor, and a prompt asks the second question', async ($, on) => {
  const w = world(on, { pct: 96 })
  await begin($, w)
  expect(await run($, 'stop')).toBe(stopTripped())
  await w.clock.settle()
  expect((await bash($)).deny).toBe(stopFloor(96))
  const p = $.prompt.submit(typed('go on'))
  await w.clock.settle()
  expect(questions(w)).toEqual([secondPrompt(96)])
  w.release('Resume')
  expect(await p).toMatchObject({ text: 'go on' })
  expect(w.prompts.map((e) => e.context)).toEqual([[noteFloor(96)]])
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS))
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
})

test('/spare10 stop clears the consents of both windows, a consent to the floor and a full one', async ($, on) => {
  const w = world(on, { pct: 91, weekPct: 96, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(rec('S1', W_MS))
  const reply = await run($, 'stop')
  clean([reply])
  await w.clock.settle()
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  expect(w.env.has('SPARE10_WEEKLY_CONSENT')).toBe(false)
  const lines = await report($)
  expect(rowOf(lines, 'consent')).toBe('none')
  expect(rowOf(lines, 'weekly consent')).toBe('none')
  expect((await bash($)).deny).toBeDefined()
})

test('/spare10 stop clears a test consent to the floor', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  await run($, 'simulate 91')
  expect(await run($, 'resume')).toBe(TRIPPED_FIRST)
  await w.clock.settle()
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  expect(rowOf(await report($), 'consent')).toBe(floorConsent())
  expect(await run($, 'stop')).toBe(stopTripped(TEST_LEAD))
  await w.clock.settle()
  expect(rowOf(await report($), 'consent')).toBe('none')
  expect((await bash($)).deny).toBe(stopReserve(91))
})

// ======================================================================================================
// The report (2.7) and the warnings (2.10)
// ======================================================================================================

test('/spare10 shows the floor rows after the open rows, and the floor help line', async ($, on) => {
  const w = world(on, { pct: 42, weekPct: 61 })
  await begin($, w)
  await w.clock.advance(46 * MIN)
  const lines = await report($)
  const reading = lines.findIndex((l) => l.startsWith('  · reading '))
  const weekly = lines.findIndex((l) => l.startsWith('  · weekly reading '))
  expect(lines[reading]?.startsWith(`  · reading        live · ${pf(42)} (in `)).toBe(true)
  expect(lines[weekly]?.startsWith(`  · weekly reading live · ${pf(61, WAT)} (in `)).toBe(true)
  const rest = lines.filter((_l, i) => i !== reading && i !== weekly)
  expect(rest).toEqual([
    'version 0.3.0',
    '',
    '  ● armed          spare10 steps in at 90% used, or at 90% used of the weekly window.',
    '  · reserve        10% of the 5-hour window (from /config)',
    '  · weekly reserve 10% of the weekly window (from /config)',
    '  · reserve opens  in the last 20 min of the 5-hour window (from /config)',
    '  · weekly opens   in the last 8 h of the weekly window (from /config)',
    `  · resume floor   ${FLOOR_ROW}`,
    `  · weekly floor   ${W_FLOOR_ROW}`,
    '  · at the reserve stop and ask you',
    '  · at the reset   continue by itself (from /config)',
    '  · consent        none',
    '  · weekly consent none',
    '  · guarded        yes (scope all)',
    '  · claude -p      runs started here: stop',
    '',
    HELP_FLOOR,
    HELP_STOP,
  ])
  expect(reading).toBe(11)
  expect(weekly).toBe(12)
})

test('/spare10 walks the consent row: until the point, ended at the point, none once a gate ends it, then until the reset', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  let lines = await report($)
  expect(phaseOf(lines)).toBe(consented(`you chose to continue. ${asks()}`))
  expect(rowOf(lines, 'consent')).toBe(floorConsent())
  expect(rowOf(lines, 'weekly consent')).toBe('none')

  w.pct = 96
  lines = await report($)
  expect(phaseOf(lines)).toBe(PHASE_TRIPPED)
  expect(rowOf(lines, 'consent')).toBe(endedConsent())

  w.pct = 92 // back below the point with no gate event between: the consent was never ended
  lines = await report($)
  expect(rowOf(lines, 'consent')).toBe(floorConsent())
  expect((await bash($)).result).toBe('ran')

  w.pct = 96
  const held = bash($)
  await w.clock.settle()
  expect(rowOf(await report($), 'consent')).toBe('none')
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  lines = await report($)
  expect(rowOf(lines, 'consent')).toBe(`until ${AT} (you chose to continue)`)
  expect(phaseOf(lines)).toBe(consented(`you chose to continue. spare10 is quiet until ${AT}.`))
})

test('/spare10 with both floors off shows the off rows and the 0.2 help line', async ($, on) => {
  const w = world(on, { pct: 50, floors: 'off' })
  await begin($, w)
  const lines = await report($)
  expect(rowOf(lines, 'resume floor')).toBe('off. A Resume lasts until the reset (from SPARE10_RESUME_FLOOR)')
  expect(rowOf(lines, 'weekly floor')).toBe('off. A Resume lasts until the weekly reset (from SPARE10_WEEKLY_RESUME_FLOOR)')
  expect(lines).toContain(HELP_02)
  expect(lines).not.toContain(HELP_FLOOR)
  expect(lines.some((l) => l.startsWith('  ⚠'))).toBe(false)
})

test('/spare10 with one floor in force keeps the floor help line', async ($, on) => {
  const w = world(on, { pct: 50, env: { SPARE10_RESUME_FLOOR: '0' } })
  await begin($, w)
  const lines = await report($)
  expect(rowOf(lines, 'resume floor')).toBe('off. A Resume lasts until the reset (from SPARE10_RESUME_FLOOR)')
  expect(rowOf(lines, 'weekly floor')).toBe(W_FLOOR_ROW)
  expect(lines).toContain(HELP_FLOOR)
})

test('floors at or above their reserves do nothing: the rows say so, each warns once at the start and in /spare10', async ($, on) => {
  const w = world(on, { pct: 50, env: { SPARE10_RESUME_FLOOR: '12', SPARE10_WEEKLY_RESUME_FLOOR: '10' } })
  await begin($, w)
  const FIVE = 'the resume floor (12%) is not below the reserve (10%), so it does nothing. Set it below the reserve, or to 0.'
  const WEEK = 'the weekly resume floor (10%) is not below the weekly reserve (10%), so it does nothing. Set it below the weekly reserve, or to 0.'
  expect(transcript(w).filter((t) => t === FIVE)).toHaveLength(1)
  expect(transcript(w).filter((t) => t === WEEK)).toHaveLength(1)
  const lines = await report($)
  expect(rowOf(lines, 'resume floor')).toBe('12% does nothing, because it is not below the reserve (from SPARE10_RESUME_FLOOR)')
  expect(rowOf(lines, 'weekly floor')).toBe('10% does nothing, because it is not below the weekly reserve (from SPARE10_WEEKLY_RESUME_FLOOR)')
  expect(lines).toContain(`  ⚠ ${FIVE}`)
  expect(lines).toContain(`  ⚠ ${WEEK}`)
  expect(lines).toContain(HELP_02)
  clean(transcript(w))
})

test('a weekly floor with the weekly window not watched has no row and no warning', async ($, on) => {
  const w = world(on, { pct: 50, env: { SPARE10_WEEKLY_RESERVE: '0', SPARE10_WEEKLY_RESUME_FLOOR: '12' } })
  await begin($, w)
  const lines = await report($)
  expect(rowOf(lines, 'resume floor')).toBe(FLOOR_ROW)
  expect(rowOf(lines, 'weekly floor')).toBeUndefined()
  expect(lines.some((l) => l.includes('weekly resume floor'))).toBe(false)
  expect(transcript(w).some((t) => t.includes('weekly resume floor'))).toBe(false)
  expect(lines).toContain(HELP_FLOOR)
})

test('bad floor variables warn with B27 and keep 5', async ($, on) => {
  const w = world(on, { pct: 91, env: { SPARE10_RESUME_FLOOR: '100', SPARE10_WEEKLY_RESUME_FLOOR: 'x' } })
  await begin($, w)
  const FIVE = 'SPARE10_RESUME_FLOOR="100" is not 0 to 99. spare10 uses 5.'
  const WEEK = 'SPARE10_WEEKLY_RESUME_FLOOR="x" is not 0 to 99. spare10 uses 5.'
  expect(transcript(w)).toContain(FIVE)
  expect(transcript(w)).toContain(WEEK)
  const lines = await report($)
  expect(rowOf(lines, 'resume floor')).toBe(FLOOR_ROW)
  expect(rowOf(lines, 'weekly floor')).toBe(W_FLOOR_ROW)
  expect(lines).toContain(`  ⚠ ${FIVE}`)
  expect(lines).toContain(`  ⚠ ${WEEK}`)
  expect(await run($, 'resume')).toBe(TRIPPED_FIRST)
})

test('/spare10 in an unattended run says the floors do nothing there', async ($, on) => {
  const w = world(on, { pct: 50, surfaces: [], env: { SPARE10_HEADLESS: 'stop', SPARE10_WEEKLY_RESUME_FLOOR: '3' } })
  await begin($, w)
  const lines = await report($)
  expect(rowOf(lines, 'resume floor')).toBe('5%: this run is unattended and never asks, so the floor does nothing (from /config)')
  expect(rowOf(lines, 'weekly floor')).toBe('3%: this run is unattended and never asks, so the floor does nothing (from SPARE10_WEEKLY_RESUME_FLOOR)')
})

// ======================================================================================================
// The badge (2.6)
// ======================================================================================================

test('the badge walks resumed until the point, the tripped row at the point, and the plain consented row after the second Resume', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10: resumed until 95% used', color: 'warning' })
  w.pct = 95
  await $.session.measure(measure(95))
  await w.clock.settle()
  const tripped = await badgeOf($)
  expect(tripped.text?.trim().endsWith('Pausing at next step')).toBe(true)
  expect(tripped.color).toBe('warning')
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([first(91), second(95)])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10', color: 'warning' })
})

test('the badge keeps its reserve label with the end point', async ($, on) => {
  const w = world(on, { pct: 86, env: { SPARE10_RESERVE: '15' } })
  await begin($, w)
  expect(await run($, 'resume')).toBe(`you can use the reserve until 95% used. ${asks()}`)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS, 95))
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10 (15%): resumed until 95% used', color: 'warning' })
})

test('inside the skip window a kind whose only consent is a consent to the floor is open, not consented', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_CONSENT: rec('S1', R_MS, 95) } })
  await w.clock.set(O_MS + 5 * MIN)
  await begin($, w)
  expect((await badgeOf($)).text).toBe(` ↻ spare10: reserve open until ${AT}`)
  expect(phaseOf(await report($))).toBe(`  ↻ open           the reset is near. Your 10% reserve is open until ${AT}, so spare10 lets all work through.`)
  expect(await run($, 'resume')).toBe(`nothing to resume. The reset is near, so your 10% reserve is open until ${AT}.`)
  expect(await run($, 'stop')).toBe(
    `nothing to stop. The reset is near, so your 10% reserve is open until ${AT}. To keep a reserve until the reset, set its Open reserve option to 0 in /config.`,
  )
  await w.clock.settle()
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  w.pct = 97
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
})

// ======================================================================================================
// Notices (2.4)
// ======================================================================================================

test('Stop here at the second question writes a stop that names the floor in the notice and the model text', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  await resumeAtReserve($, w)
  const n = transcript(w).length
  w.pct = 96
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([first(91), second(96)])
  w.release('Stop here')
  expect((await held).deny).toBe(stopFloor(96))
  await w.clock.settle()
  expect(transcript(w).slice(n)).toEqual([STOPPED_FLOOR])
  expect(w.env.get('SPARE10_STOPPED')).toMatch(/^S1 \d+ \d+ \S+$/)
  expect(w.env.get('SPARE10_STOPPED')?.split(' ')[1]).toBe(String(O_MS))
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  expect(rowOf(await report($), 'consent')).toBe('none')
  expect(await run($, 'resume')).toBe(stoppedSecond(96))
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(rec('S1', R_MS))
  clean(transcript(w))
})

// ======================================================================================================
// /spare10 simulate (2.9, B53)
// ======================================================================================================

test('the test seam: simulate 91, Resume, simulate 96 raises in place and asks the second question', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  const n = transcript(w).length
  expect(await run($, 'simulate 91')).toBe(simSet('91% used', AT, opens()))
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([first(91, { lead: TEST_LEAD })])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w).slice(n)).toEqual([contFirst()])
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10 (test): resumed until 95% used', color: 'warning' })
  expect((await bash($)).result).toBe('ran') // the test consent to the floor applies

  const raised = await run($, 'simulate 96')
  expect(raised).toBe(simRaised('96% used', AT, `${PAST}${opens()}`))
  let lines = await report($)
  expect(rowOf(lines, 'consent')).toBe(endedConsent()) // kept, and past its point
  const held2 = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([first(91, { lead: TEST_LEAD }), second(96, { lead: TEST_LEAD })])
  lines = await report($)
  expect(rowOf(lines, 'consent')).toBe('none')
  w.release('Resume')
  expect((await held2).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w).slice(n)).toEqual([contFirst(), CONT_SECOND])
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10 (test)', color: 'warning' })
  expect(rowOf(await report($), 'consent')).toBe(`until ${AT} (you chose to continue)`)
  expect(w.env.has('SPARE10_CONSENT')).toBe(false) // a test Resume never goes into the env
  clean([raised, ...transcript(w)])
})

test('a raise below the floor keeps the consent to the floor, and no question comes', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  await run($, 'simulate 91')
  expect(await run($, 'resume')).toBe(TRIPPED_FIRST)
  expect(await run($, 'simulate 93')).toBe(simRaised('93% used', AT, opens()))
  expect(rowOf(await report($), 'consent')).toBe(floorConsent())
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
})

test('a first test reading past the floor says so and asks the second question at once', async ($, on) => {
  const w = world(on, { pct: 50, answer: 'Resume' })
  await begin($, w)
  expect(await run($, 'simulate 96')).toBe(simSet('96% used', AT, `${PAST}${opens()}`))
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(questions(w)).toEqual([second(96, { lead: TEST_LEAD })])
  expect(rowOf(await report($), 'consent')).toBe(`until ${AT} (you chose to continue)`)
})

test('the floor sentence starts at the point: 95 has it, 94.9 does not', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  expect(await run($, 'simulate 95')).toBe(simSet('95% used', AT, `${PAST}${opens()}`))
  expect(await run($, 'simulate 94.9')).toBe(simSet('94.9% used', AT, opens()))
})

test('the same value, a lower value or a value with in starts a new test and clears the consent', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  await run($, 'simulate 91')
  expect(await run($, 'resume')).toBe(TRIPPED_FIRST)
  expect(rowOf(await report($), 'consent')).toBe(floorConsent())

  expect(await run($, 'simulate 91')).toBe(simSet('91% used', AT, opens())) // the same value again: a new test
  expect(rowOf(await report($), 'consent')).toBe('none')

  expect(await run($, 'resume')).toBe(TRIPPED_FIRST)
  expect(await run($, 'simulate 90')).toBe(simSet('90% used', AT, opens())) // lower: a new test
  expect(rowOf(await report($), 'consent')).toBe('none')

  expect(await run($, 'resume')).toBe(`you can use the reserve until 95% used. ${asks()}`)
  const end = T0 + HOUR
  expect(await run($, 'simulate 96 in 1h')).toBe(simSet('96% used', hhmm(end), `${PAST}${opens(hhmm(end - 20 * MIN))}`)) // in: a new test
  expect(rowOf(await report($), 'consent')).toBe('none')
  w.answer = 'Stop here'
  expect((await bash($)).deny).toBe(stopFloor(96, hhmm(end)))
  expect(questions(w)).toEqual([second(96, { at: hhmm(end), open: hhmm(end - 20 * MIN), lead: TEST_LEAD })])
})

test('a raise keeps a stop on the test reading', async ($, on) => {
  const w = world(on, { pct: 50, answer: 'Stop here' })
  await begin($, w)
  await run($, 'simulate 91')
  expect((await bash($)).deny).toBe(stopReserve(91))
  await w.clock.settle()
  const stopped = w.env.get('SPARE10_STOPPED')
  expect(stopped).toMatch(/^S1 /)
  expect(await run($, 'simulate 96')).toBe(simRaised('96% used', AT, `${PAST}${opens()}`))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopped)
  expect((await bash($)).deny).toBe(stopFloor(96))
  expect(w.asked).toHaveLength(1)
})

test('with the floors off a raise keeps a full test consent, and the reply has no floor sentence', async ($, on) => {
  const w = world(on, { pct: 50, floors: 'off' })
  await begin($, w)
  await run($, 'simulate 91')
  expect(await run($, 'resume')).toBe(`you can use the reserve until ${AT}.`)
  expect(await run($, 'simulate 96')).toBe(simRaised('96% used', AT, opens()))
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
})

test('a floor at or above the reserve gives no floor sentence', async ($, on) => {
  const w = world(on, { pct: 50, env: { SPARE10_RESUME_FLOOR: '12' } })
  await begin($, w)
  expect(await run($, 'simulate 96')).toBe(simSet('96% used', AT, opens()))
})

test('a test window that is open at once gives no floor sentence', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  expect(await run($, 'simulate 96 in 10m')).toBe(
    simSet('96% used', hhmm(T0 + 10 * MIN), ' The test window ends within 20 min, so the reserve is open at once.'),
  )
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
})

test('the weekly test seam raises in place with the weekly floor sentence', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 50 })
  await begin($, w)
  expect(await run($, 'simulate 91 weekly')).toBe(simSet('91% used of the weekly window', WAT, W_OPENS))
  expect(await run($, 'resume')).toBe(`you can use the weekly reserve until 95% used. ${W_ASKS}`)
  await w.clock.settle()
  expect(w.env.has('SPARE10_WEEKLY_CONSENT')).toBe(false)
  expect(await run($, 'simulate 96 weekly')).toBe(simRaised('96% used of the weekly window', WAT, `${W_PAST}${W_OPENS}`))
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([weekSecond(96, 5, WTEST_LEAD)])
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

test('simulate warns when the real reading is in the reserve beneath the test reading, also on a raise', async ($, on) => {
  const w = world(on, { pct: 92 })
  await begin($, w)
  const end = T0 + 22 * MIN
  expect(await run($, 'simulate 93 in 22m')).toBe(simSet('93% used', hhmm(end), `${REAL_HOLDS}${REAL_IN}`))
  expect(await run($, 'simulate 96')).toBe(simRaised('96% used', hhmm(end), `${PAST}${REAL_HOLDS}${REAL_IN}`))
})

// Floor 2.9 says that {opens} is the DS sentence. The DS rule gives the real sentence only when the real
// skip start lies after the test skip start. With no `in`, the test window takes the live reset, so both
// skip starts are the same, and the DS sentence is the opens sentence. (The 2.9 sample for real 93 at the
// kit clock shows the real sentence there. That sample does not follow the rule that 2.9 names.)
test('simulate 95 over a real 93 with the same reset names the floor, the skip start and the real reading beneath', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  expect(await run($, 'simulate 95')).toBe(simSet('95% used', AT, `${PAST}${opens()}${REAL_IN}`))
})

test('no real sentence when the real reading is below the reserve', async ($, on) => {
  const w = world(on, { pct: 89 })
  await begin($, w)
  expect(await run($, 'simulate 96')).toBe(simSet('96% used', AT, `${PAST}${opens()}`))
})

test('simulate off clears a test consent to the floor', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  await run($, 'simulate 91')
  expect(await run($, 'resume')).toBe(TRIPPED_FIRST)
  expect(await run($, 'simulate off')).toBe('test reading cleared. Consent and stop for this window are cleared too.')
  expect(rowOf(await report($), 'consent')).toBe('none')
  expect(await badgeOf($)).toEqual({ text: ' ● spare10', color: 'success' })
})

test('a raise keeps the test window of the earlier value', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  const end = T0 + HOUR
  const open = hhmm(end - 20 * MIN)
  expect(await run($, 'simulate 91 in 1h')).toBe(simSet('91% used', hhmm(end), opens(open)))
  expect(await run($, 'resume')).toBe(`you can use the reserve until 95% used. ${asks(95, open)}`)
  expect(await run($, 'simulate 96')).toBe(simRaised('96% used', hhmm(end), `${PAST}${opens(open)}`))
  expect(await run($, 'resume')).toBe(trippedSecond(96, hhmm(end)))
})

test('a raise needs a test reading in its window: after the test window ends, a higher value starts a new test', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  expect(await run($, 'simulate 91 in 30m')).toBe(simSet('91% used', hhmm(T0 + 30 * MIN), opens(hhmm(T0 + 10 * MIN))))
  await w.clock.advance(31 * MIN)
  expect(await run($, 'simulate 96')).toBe(simSet('96% used', AT, `${PAST}${opens()}`))
})

test('a raise is per kind: a 5-hour test reading never makes a first weekly value a raise', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 50 })
  await begin($, w)
  await run($, 'simulate 91')
  expect(await run($, 'simulate 96 weekly')).toBe(simSet('96% used of the weekly window', WAT, `${W_PAST}${W_OPENS}`))
})

test('the live check LC34: /spare10 resume before and past the floor on a test reading, with no prompt', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  await run($, 'simulate 91')
  expect(await run($, 'resume')).toBe(TRIPPED_FIRST)
  expect(await run($, 'resume')).toBe(ALREADY_FLOOR)
  expect(await run($, 'simulate 96')).toBe(simRaised('96% used', AT, `${PAST}${opens()}`))
  const lines = await report($)
  expect(rowOf(lines, 'consent')).toBe(endedConsent())
  expect(phaseOf(lines)).toBe(PHASE_TRIPPED)
  expect(await run($, 'resume')).toBe(trippedSecond(96))
  expect(rowOf(await report($), 'consent')).toBe(`until ${AT} (you chose to continue)`)
  expect(await run($, 'simulate off')).toBe('test reading cleared. Consent and stop for this window are cleared too.')
  await w.clock.settle()
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  expect(w.asked).toEqual([])
})
