import { test, expect } from 'claude-code/testing'
import type { Engine, ElementQuery, FoundElement } from 'claude-code/testing'
import type { ToolCallResult } from 'claude-code'
import {
  DAY,
  LATER,
  MARGIN,
  OPENS,
  RESETS,
  SKIP,
  SOON,
  T0,
  TICK,
  WEEK_OPENS,
  WEEK_RESETS,
  WEEK_SKIP,
  bash,
  begin,
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

// The weekly window through the engine (0.2 design B32, 2.1 to 2.9, 3.1, 3.2, 3.5, 5.6, and the 8.3
// weekly.test.ts table). Written from the spec: every expected text is built here from section 2,
// not taken from hooks/core/text.ts, so a drift in the texts or in the per-kind logic fails here.

const RESETS_MS = Date.parse(RESETS)
const WEEK_MS = Date.parse(WEEK_RESETS)
const WEEK_OPENS_MS = Date.parse(WEEK_OPENS) // the weekly skip start: 8 h before WEEK_RESETS
const SOON_MS = Date.parse(SOON)

// ---- 2.1 placeholders, in the machine's zone as the kit runs ----

type Kind = 'five_hour' | 'seven_day'
type Fact = { kind: Kind; used: number; at: number; reserve?: number; now?: number; test?: boolean }

const hhmm = (ms: number): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
const weekday = (ms: number): string => new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(ms)
const dayMonth = (ms: number): string =>
  `${new Intl.DateTimeFormat('en-GB', { day: 'numeric' }).format(ms)} ${new Intl.DateTimeFormat('en-GB', { month: 'short' }).format(ms)}`
/** {clock} of a weekly time: `ddd HH:MM`, or `ddd D MMM HH:MM` when more than 6 days after now. */
const weekClock = (ms: number, now = T0): string =>
  ms - now > 6 * DAY ? `${weekday(ms)} ${dayMonth(ms)} ${hhmm(ms)}` : `${weekday(ms)} ${hhmm(ms)}`
const clockOf = (f: Fact): string => (f.kind === 'five_hour' ? hhmm(f.at) : weekClock(f.at, f.now))
const one = (n: number): string => String(Math.round(n * 10) / 10)

const F5 = (used: number, at = RESETS_MS): Fact => ({ kind: 'five_hour', used, at })
const FW = (used: number, at = WEEK_MS, now = T0): Fact => ({ kind: 'seven_day', used, at, now })

const weekly = (f: Fact): string => (f.kind === 'seven_day' ? 'weekly ' : '')
const Rof = (f: Fact): string => `${one(f.reserve ?? 10)}% ${weekly(f)}reserve`
const pf1 = (f: Fact): string => `${one(f.used)}% used · ${one(100 - f.used)}% left · resets ${clockOf(f)}`
const pf = (fs: Fact[]): string =>
  fs.length === 1 ? pf1(fs[0] as Fact) : fs.map((f) => `${f.kind === 'five_hour' ? '5-hour' : 'weekly'} window ${pf1(f)}`).join(', ')
const Rs = (fs: Fact[]): string => fs.map((f) => `your ${Rof(f)}`).join(' and ')
const mf = (fs: Fact[]): string =>
  fs.map((f) => `into your ${Rof(f)} · ${one(100 - f.used)}% of ${weekly(f)}quota left · resets ${clockOf(f)}`).join(', and ')
const both = (fs: Fact[]): string => `(${fs.map(clockOf).join(' and ')})`
const use = (fs: Fact[]): string =>
  fs.length === 1 ? `the ${weekly(fs[0] as Fact)}reserve until ${clockOf(fs[0] as Fact)}` : `both reserves until they reset ${both(fs)}`
const quiet = (fs: Fact[]): string => (fs.length === 1 ? `until ${clockOf(fs[0] as Fact)}` : `until they reset ${both(fs)}`)
// Skip near the reset (the shipped spans, skip 2.1): a kind's hold end is its skip start, 20 min (5-hour)
// or 8 h (weekly) before its reset, and a text names the lead of the kind whose skip start is latest.
// `off`: the D0.2 timing of a test with spans: 'off', where the hold end is the reset and there is no lead.
const spanOf = (f: Fact): number => (f.kind === 'five_hour' ? SKIP : WEEK_SKIP)
const holdOf = (f: Fact, off: boolean): number => (off ? f.at : f.at - spanOf(f))
const leadOf = (f: Fact): string =>
  f.kind === 'five_hour'
    ? `20 min before ${f.test === true ? 'the test window ends' : 'the reset'}`
    : `8 h before ${f.test === true ? 'the weekly test window ends' : 'the weekly reset'}`
/** {at}: the latest hold end, in the weekday form when a weekly kind is named. */
const at = (fs: Fact[], off = false): string => {
  const latest = Math.max(...fs.map((f) => holdOf(f, off)))
  return fs.some((f) => f.kind === 'seven_day') ? weekClock(latest, fs.find((f) => f.now !== undefined)?.now) : hhmm(latest)
}
/** {at} and, for a skip owner, its {lead}. */
const when = (fs: Fact[], off = false): string => {
  if (off) return at(fs, true)
  const latest = Math.max(...fs.map((f) => holdOf(f, false)))
  const owner = fs.find((f) => holdOf(f, false) === latest) as Fact
  return `${at(fs)}, ${leadOf(owner)}`
}
const is = (fs: Fact[]): string => (fs.length === 1 ? 'is' : 'are')
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

// ---- 2.2 the question, autoResume on (the default) ----

const head = (fs: Fact[]): string => `${cap(Rs(fs))} ${is(fs)} reached: ${pf(fs)}.`
const loopQ = (fs: Fact[], off = false): string =>
  `${head(fs)} All work is on hold. Continue on ${use(fs)}? ` +
  `If you choose Stop here or do not answer, the work waits until ${when(fs, off)}. Then spare10 continues it, unless a reserve is still reached.`
const promptQ = (fs: Fact[], off = false): string =>
  `${head(fs)} spare10 holds your prompt and any other work. Continue on ${use(fs)}? ` +
  `If you do not answer, all of it continues ${off ? 'after' : 'at'} ${when(fs, off)}, unless a reserve is still reached. ` +
  `Stop here gives your prompt back and pauses other work until ${at(fs, off)}.`

// ---- 2.3 texts the model reads ----

const STOP = (fs: Fact[]): string =>
  `spare10: the user stopped work at the quota reserve (${mf(fs)}). Stop now and wait for the user. Do not call any further tools.`
const PAUSED = (fs: Fact[]): string =>
  `spare10: work stopped at the quota reserve (${mf(fs)}). No model request was sent, so this task is not finished. Wait for the user.`
const NOT_STARTED = (fs: Fact[]): string =>
  `spare10: not started. This session is inside ${Rs(fs)} ${quiet(fs)}. Send the prompt again to be asked again, or run /spare10 resume.`
const PAUSE = 'Commit and stop.'
const TELL = { SPARE10_PAUSE_PROMPT: PAUSE }
const instruction = (fs: Fact[]): string =>
  `spare10 budget guard. You have reached the safe usage limit for this session (${mf(fs)}). ` +
  'Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.' +
  `\n\nUser instructions: ${PAUSE}`

// ---- 2.4 notices, 2.7 report, 2.8 replies, 2.9 simulate ----

const continuing = (fs: Fact[]): string => `continuing on ${Rs(fs)}. spare10 stays quiet ${quiet(fs)}.`
const stoppedNotice = (fs: Fact[], off = false): string =>
  `stopped at ${Rs(fs)} until ${when(fs, off)}. Then spare10 continues the work, unless a reserve is still reached. ` +
  'Type a prompt to be asked again, or run /spare10 resume.'
const told = (fs: Fact[]): string => `${Rs(fs)} ${is(fs)} reached. spare10 told the agents to wind down.`
const ARMED = '● armed spare10 steps in at 90% used, or at 90% used of the weekly window.'
const ARMED_WEEKLY_OFF = '● armed spare10 steps in at 90% used.'
const TRIPPED = '⚠ tripped spare10 holds the next step and asks you.'
const consentedLine = (fs: Fact[]): string => `⨯ consented you chose to continue. spare10 is quiet ${quiet(fs)}.`
const consentRow = (f: Fact): string => `until ${clockOf(f)} (you chose to continue)`
const weeklyOffRow = (from: string): string => `· weekly reserve off. spare10 does not watch the weekly window (from ${from})`
// Skip 2.9: at or above the trip point the reply says when the weekly reserve opens (`opens`: the skip start).
const simulateWeekly = (used: number, clock: string, opens?: string): string =>
  `test reading set to ${one(used)}% used of the weekly window, resets ${clock}. It can only raise the real reading.` +
  `${opens === undefined ? '' : ` The weekly reserve opens at ${opens}, 8 h before the weekly test window ends.`} Run /spare10 simulate off to clear it.`
const SIMULATE_OFF = 'test reading cleared. Consent and stop for this window are cleared too.'
const SIMULATE_WEEKLY_OFF = 'the weekly reserve is 0, so spare10 does not watch the weekly window. Nothing changed.'

// ---- helpers ----

type Logs = Pick<World, 'logs'>
const transcript = (w: Logs): string[] => w.logs.filter((l) => l.to !== 'debug').map((l) => l.text)
const count = (list: string[], text: string): number => list.filter((t) => t === text).length
const questions = (w: Pick<World, 'asked'>): string[] => w.asked.map((a) => a.question)
const ctx = (r: ToolCallResult): readonly string[] => r.context ?? []

/** The /spare10 report, one entry per line with runs of white space folded (the layout is pinned by the pure text tests). */
async function status($: Engine): Promise<string[]> {
  const r = await $.command.run(cmd(''))
  return (r.text ?? '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
}

async function run($: Engine, args: string): Promise<string | undefined> {
  return (await $.command.run(cmd(args))).text
}

type Ui = { find: (q: ElementQuery) => Promise<FoundElement | undefined>; unmount: () => Promise<unknown> }

function mountBadge($: Engine): Promise<Ui> {
  return $.ui.mount({ plugin: 'spare10', surface: 'terminal', component: 'SessionMode', props: { modes: [] } }) as Promise<Ui>
}

/** The badge as drawn: the text of the Box keyed spare10 and the colour of its one Text. */
async function badge(ui: Ui): Promise<{ text: string | undefined; color: unknown }> {
  const box = await ui.find({ key: 'spare10' })
  const inner = (box?.children ?? []).find((c): c is { type: string; props?: Record<string, unknown> } =>
    typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'Text')
  return { text: box?.text, color: inner?.props?.color }
}

const iso = (ms: number): string => new Date(ms).toISOString()

// ---- the 8.3 weekly.test.ts table ----

test('a weekly trip holds every loop and asks with the weekly wording', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 92, agents: ['a1'] })
  await begin($, w)
  const week = [FW(92)]
  const held = [bash($), bash($, 'a1')]
  const req = drain($, step('a1', 'T9'))
  await w.clock.settle()
  expect(w.asked).toEqual([{ question: loopQ(week), header: 'spare10', labels: ['Stop here', 'Resume'] }])
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  w.release('Stop here')
  expect((await Promise.all(held)).map((r) => r.deny)).toEqual([STOP(week), STOP(week)])
  expect((await req).text).toBe(PAUSED(week))
  await w.clock.settle()
  // A person prompt in the stopped session asks with the weekly prompt wording, and Stop here drops it.
  w.answer = 'Stop here'
  expect(await $.prompt.submit(typed('hello'))).toEqual({ drop: NOT_STARTED(week) })
  expect(questions(w)).toEqual([loopQ(week), promptQ(week)])
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  expect(w.prompts).toEqual([])
})

test('Resume on a weekly trip writes SPARE10_WEEKLY_CONSENT only, and later calls pass', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 92, answer: 'Resume' })
  await begin($, w)
  const week = [FW(92)]
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ(week)])
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(`S1 ${WEEK_RESETS}`)
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect(transcript(w)).toContain(continuing(week))
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(await $.prompt.submit(typed('hello'))).toMatchObject({ text: 'hello' })
  expect(w.asked).toHaveLength(1)
  const lines = await status($)
  expect(lines).toContain(consentedLine(week))
  expect(lines).toContain('· consent none')
  expect(lines).toContain(`· weekly consent ${consentRow(FW(92))}`)
})

test('weekly consent does not cover a 5-hour trip', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 92, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(`S1 ${WEEK_RESETS}`)
  w.pct = 93 // the 5-hour window trips too: only it gates
  w.answer = 'Stop here'
  expect((await bash($)).deny).toBe(STOP([F5(93)]))
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ([FW(92)]), loopQ([F5(93)])])
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OPENS, T0, 'five_hour,work,auto,skip'))
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(w.ran).toEqual(['Bash:main'])
})

test('both windows tripped: one question names both, and Resume writes both consents', async ($, on) => {
  const w = world(on, { pct: 91, weekPct: 92, agents: ['a1'] })
  await begin($, w)
  const two = [F5(91), FW(92)]
  const held = [bash($), bash($, 'a1')]
  const req = drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(w.asked).toEqual([{ question: loopQ(two), header: 'spare10', labels: ['Stop here', 'Resume'] }])
  expect(w.ran).toEqual([])
  w.release('Resume')
  expect((await Promise.all(held)).map((r) => r.result)).toEqual(['ran', 'ran'])
  expect((await req).text).toBe('hi')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(`S1 ${WEEK_RESETS}`)
  expect(transcript(w)).toContain(continuing(two))
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
  const lines = await status($)
  expect(lines).toContain(consentedLine(two))
  expect(lines).toContain(`· consent ${consentRow(F5(91))}`)
  expect(lines).toContain(`· weekly consent ${consentRow(FW(92))}`)
})

test('a weekly trip while a 5-hour question waits: Resume re-checks and asks again for the weekly window only', async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 50 })
  await begin($, w)
  const held = bash($)
  const req = drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ([F5(93)])])
  w.weekPct = 92 // trips while the question waits: the dialog did not name it
  w.release('Resume')
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ([F5(93)]), loopQ([FW(92)])])
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBeUndefined()
  w.release('Resume')
  expect((await held).result).toBe('ran')
  expect((await req).text).toBe('hi')
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(`S1 ${WEEK_RESETS}`)
  expect(w.ran).toEqual(['Bash:main'])
  expect(w.requests).toBe(1)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(2)
})

test('a joiner whose kinds a settled Resume did not name opens a new question, also while the settle writes (envSetDelayMs)', async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 50, agents: ['a1'] })
  await begin($, w)
  const main = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ([F5(93)])])
  w.weekPct = 92
  w.envSetDelayMs = 1000 // the Resume's writes stay in flight: the settled question still looks open
  w.release('Resume')
  const joiner = bash($, 'a1')
  await w.clock.settle()
  // Neither the released loop nor the joiner takes the 5-hour Resume for the weekly window.
  expect(questions(w)).toEqual([loopQ([F5(93)]), loopQ([FW(92)])])
  expect(w.ran).toEqual([])
  await w.clock.advance(5000)
  w.envSetDelayMs = 0
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBeUndefined()
  expect(w.ran).toEqual([])
  expect(w.asked).toHaveLength(2)
  w.release('Resume')
  expect((await main).result).toBe('ran')
  expect((await joiner).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(`S1 ${WEEK_RESETS}`)
  expect(w.asked).toHaveLength(2)
})

// The rule holds in each gate: a Resume answers only the round after it (5.3).
for (const gate of ['tool', 'step', 'prompt'] as const) {
  test(`a Resume answers only the round after it (${gate} gate): when a later weekly question ends, a new 5-hour window in the reserve asks again`, { timeoutMs: 20_000 }, async ($, on) => {
    const weekEnd = '2026-09-24T18:00:00.000Z' // after the 5-hour reset, so a new 5-hour window starts during the weekly hold
    const weekEndMs = Date.parse(weekEnd)
    // the D0.2 reset timing: a weekly reset 6 h after T0 is inside the shipped weekly span, and the test moves past both resets
    const w = world(on, { pct: 93, weekPct: 50, weekResetsAt: weekEnd, spans: 'off' })
    await begin($, w)
    const q = (fs: Fact[]): string => (gate === 'prompt' ? promptQ(fs, true) : loopQ(fs, true))
    const held: Promise<boolean> =
      gate === 'tool'
        ? bash($).then((r) => r.result === 'ran')
        : gate === 'step'
          ? drain($, step(undefined, 'T1')).then((r) => r.text === 'hi')
          : $.prompt.submit(typed('hello')).then((r) => (r as { text?: string }).text === 'hello')
    await w.clock.settle()
    w.weekPct = 92
    w.release('Resume')
    await w.clock.settle()
    expect(questions(w)).toEqual([q([F5(93)]), q([FW(92, weekEndMs)])])
    expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
    await pastDue(w, RESETS)
    w.pct = 95 // the new 5-hour window is in the reserve too, and the Resume named only the old one
    w.resetsAt = LATER
    await pastDue(w, weekEnd)
    await w.clock.settle()
    expect(w.ran).toEqual([])
    expect(w.requests).toBe(0)
    expect(w.prompts).toEqual([])
    expect(transcript(w)).toContain(`the weekly window reset, but ${Rs([F5(95, Date.parse(LATER))])} is reached. Held work still waits.`)
    expect(questions(w)).toEqual([q([F5(93)]), q([FW(92, weekEndMs)]), q([F5(95, Date.parse(LATER))])])
    w.release('Resume')
    expect(await held).toBe(true)
    await w.clock.settle()
    expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${LATER}`)
  })
}

test('a real 5-hour trip at 93 and simulate 95 weekly: Resume writes SPARE10_CONSENT only, and the next call passes without a second question', async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 50, answer: 'Resume' })
  await begin($, w)
  expect(await run($, 'simulate 95 weekly')).toBe(simulateWeekly(95, weekClock(WEEK_MS), weekClock(WEEK_OPENS_MS))) // the live weekly reset
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ([F5(93), { ...FW(95), test: true }])])
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBeUndefined() // a test kind stays in this copy
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(w.asked).toHaveLength(1)
  expect(w.ran).toEqual(['Bash:main', 'Bash:main'])
})

test('SPARE10_WEEKLY_RESERVE=0 never acts on the weekly window, and /spare10 says off', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 100, env: { SPARE10_WEEKLY_RESERVE: '0' }, agents: ['a1'] }) // the weekly window used up
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect((await bash($, 'a1')).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(await $.prompt.submit(typed('hello'))).toMatchObject({ text: 'hello' })
  expect(w.asked).toEqual([])
  const lines = await status($)
  expect(lines).toContain(ARMED_WEEKLY_OFF)
  expect(lines).toContain(weeklyOffRow('SPARE10_WEEKLY_RESERVE'))
  expect(lines.some((l) => l.startsWith('· weekly reading'))).toBe(false)
  expect(lines.some((l) => l.startsWith('· weekly consent'))).toBe(false)
  expect(transcript(w).some((t) => t.includes('SPARE10_WEEKLY_RESERVE'))).toBe(false) // 0 is a valid value
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual({ text: ' ● spare10', color: 'success' })
  await ui.unmount()
  expect(await run($, 'stop')).toBe('nothing to stop. spare10 steps in at 90% used.')
  // The 5-hour window still trips, and the question names it alone.
  w.pct = 93
  w.answer = 'Resume'
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ([F5(93)])])
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBeUndefined()
})

test('a weekly Stop here writes a stop until the weekly reset', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 92, agents: ['a1'] })
  await begin($, w)
  const week = [FW(92)]
  const held = [bash($), bash($, 'a1')]
  await w.clock.settle()
  w.release('Stop here')
  expect((await Promise.all(held)).map((r) => r.deny)).toEqual([STOP(week), STOP(week)])
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', WEEK_OPENS, T0, 'seven_day,work,auto,skip'))
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBeUndefined()
  expect(transcript(w)).toContain(stoppedNotice(week))
  expect((await bash($)).deny).toBe(STOP(week))
  expect((await drain($, step())).text).toBe(PAUSED(week))
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual({ text: ` ■ spare10: stopped until ${weekClock(WEEK_OPENS_MS)}`, color: 'warning' })
  await ui.unmount()
  expect(await status($)).toContain(
    `■ stopped you chose Stop here. spare10 continues the work at ${weekClock(WEEK_OPENS_MS)}. Type a prompt to be asked again, or run /spare10 resume.`,
  )
  // The 5-hour window resets: the weekly stop goes on, and nothing is sent.
  await w.clock.set(RESETS_MS + 10 * 60_000)
  w.resetsAt = LATER
  w.pct = 10
  expect((await bash($)).deny).toBe(STOP([FW(92, WEEK_MS, RESETS_MS + 10 * 60_000)]))
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', WEEK_OPENS, T0, 'seven_day,work,auto,skip'))
  expect(w.submitted).toEqual([])
  expect(w.ran).toEqual([])
  expect(w.asked).toHaveLength(1)
})

test('a measure writes seed-weekly, and a fresh session trips on it', async ($, on) => {
  // A fresh session: no live reading yet, only the weekly seed another session stored.
  const w = world(on, { store: { 'seed-weekly': { pct: 93, resetsAtMs: WEEK_MS } }, answer: 'Resume' })
  await begin($, w)
  const lines = await status($)
  expect(lines).toContain(`· weekly reading seed from another session · ${pf1(FW(93))} (in 3 d 21 h)`)
  expect(lines).toContain('· reading none: no reading yet')
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ([FW(93)])])
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(`S1 ${WEEK_RESETS}`)
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(w.store.get('seed')).toBeUndefined() // a weekly seed never feeds the 5-hour seed
  // A measure with both windows writes each seed under its own key.
  await $.session.measure(measure(50, ['rateLimits', 'cost'], RESETS, { pct: 94 }))
  await w.clock.settle()
  expect(w.store.get('seed-weekly')).toEqual({ pct: 94, resetsAtMs: WEEK_MS })
  expect(w.store.get('seed')).toEqual({ pct: 50, resetsAtMs: RESETS_MS })
  // A weekly window without a reset time writes no weekly seed.
  await $.session.measure(measure(50, ['rateLimits', 'cost'], RESETS, { pct: 97, resetsAt: null }))
  await w.clock.settle()
  expect(w.store.get('seed-weekly')).toEqual({ pct: 94, resetsAtMs: WEEK_MS })
})

test('a weekly consent stamped with this session counts after a reload', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 93, env: { SPARE10_WEEKLY_CONSENT: `S1 ${WEEK_RESETS}` }, agents: ['a1'] })
  await begin($, w)
  const lines = await status($)
  expect(lines).toContain(consentedLine([FW(93)]))
  expect(lines).toContain(`· weekly consent ${consentRow(FW(93))}`)
  expect(lines.some((l) => l.includes('SPARE10_WEEKLY_CONSENT'))).toBe(false)
  expect((await Promise.all([bash($), bash($, 'a1')])).map((r) => r.result)).toEqual(['ran', 'ran'])
  expect((await drain($, step())).text).toBe('hi')
  expect(await $.prompt.submit(typed('hello'))).toMatchObject({ text: 'hello' })
  expect(w.asked).toEqual([])
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(`S1 ${WEEK_RESETS}`)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual({ text: ' ⨯ spare10', color: 'warning' })
  await ui.unmount()
})

test('/spare10 simulate 95 weekly trips the weekly window, and simulate off clears it', async ($, on) => {
  // No weekly entry: the test window is 7 days from now. The D0.2 reset timing: the test sets test windows
  // shorter than the weekly span (skip 7.4).
  const w = world(on, { pct: 50, spans: 'off' })
  await begin($, w)
  const end = T0 + 7 * DAY
  const week = [FW(95, end)]
  expect(await run($, 'simulate 95 weekly')).toBe(simulateWeekly(95, weekClock(end)))
  expect(weekClock(end)).toMatch(/^\w{3} \d{1,2} \w{3,4} \d{2}:\d{2}$/) // the date form: more than 6 days ahead
  let lines = await status($)
  expect(lines).toContain(TRIPPED)
  expect(lines.some((l) => l.startsWith(`· weekly reading test reading · ${pf1(week[0] as Fact)} (in 7 d`))).toBe(true)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ(week, true)])
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(week))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', end, T0, 'seven_day,work,auto,test'))
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual({ text: ` ■ spare10 (test): stopped until ${weekClock(end)}`, color: 'warning' })
  await ui.unmount()
  expect(await run($, 'simulate off')).toBe(SIMULATE_OFF)
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect((await bash($)).result).toBe('ran')
  lines = await status($)
  expect(lines).toContain(ARMED)
  expect(lines).toContain('· weekly reading none: no reading yet')
  // `in` sets a short test window, and 7d names the weekly window too.
  expect(await run($, 'simulate 95 weekly in 2m')).toBe(simulateWeekly(95, weekClock(T0 + 2 * 60_000)))
  expect(await status($)).toContain(`· weekly reading test reading · ${pf1(FW(95, T0 + 2 * 60_000))} (in 2 min)`)
  expect(await run($, 'simulate off')).toBe(SIMULATE_OFF)
  expect(await run($, 'simulate 96 7d in 3m')).toBe(simulateWeekly(96, weekClock(T0 + 3 * 60_000)))
  expect(await run($, 'simulate off')).toBe(SIMULATE_OFF)
  expect(w.asked).toHaveLength(1)
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBeUndefined()
})

test('/spare10 simulate 95 weekly with the weekly guard off changes nothing', async ($, on) => {
  const w = world(on, { pct: 50, env: { SPARE10_WEEKLY_RESERVE: '0' } })
  await begin($, w)
  expect(await run($, 'simulate 95 weekly')).toBe(SIMULATE_WEEKLY_OFF)
  expect(await run($, 'simulate 95 7d in 2m')).toBe(SIMULATE_WEEKLY_OFF)
  const lines = await status($)
  expect(lines).toContain(ARMED_WEEKLY_OFF)
  expect(lines.some((l) => l.startsWith('· weekly reading'))).toBe(false)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual({ text: ' ● spare10', color: 'success' }) // no test label
  await ui.unmount()
})

test('tell mode tells each loop once per kind and window, not again when the other window resets', async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 50, weekResetsAt: SOON, env: TELL, agents: ['a1'], spans: 'off' }) // the D0.2 reset timing
  await begin($, w)
  const five = [F5(93)]
  expect(ctx(await bash($))).toEqual([instruction(five)])
  expect(ctx(await bash($, 'a1'))).toEqual([instruction(five)])
  expect(ctx(await bash($))).toEqual([])
  // The weekly window trips too: each loop lacks its weekly key, so it is told once more, with both.
  w.weekPct = 92
  const two = [F5(93), FW(92, SOON_MS)]
  expect(ctx(await bash($))).toEqual([instruction(two)])
  expect(ctx(await bash($, 'a1'))).toEqual([instruction(two)])
  expect(ctx(await bash($))).toEqual([])
  expect(ctx(await bash($, 'a1'))).toEqual([])
  // The weekly window resets below the reserve: the 5-hour window still gates, and its set holds.
  await w.clock.set(SOON_MS)
  w.weekResetsAt = WEEK_RESETS
  w.weekPct = 20
  expect(ctx(await bash($))).toEqual([])
  expect(ctx(await bash($, 'a1'))).toEqual([])
  // The new weekly window trips: a new weekly set.
  w.weekPct = 95
  const next = [F5(93), FW(95, WEEK_MS, SOON_MS)]
  expect(ctx(await bash($))).toEqual([instruction(next)])
  expect(ctx(await bash($))).toEqual([])
  // The 5-hour window resets below the reserve: the weekly window still gates, and its set holds.
  await w.clock.set(RESETS_MS)
  w.resetsAt = LATER
  w.pct = 10
  expect(ctx(await bash($))).toEqual([])
  expect(w.asked).toEqual([])
  const notices = transcript(w).filter((t) => t.endsWith('spare10 told the agents to wind down.'))
  expect(count(notices, told(five))).toBe(1)
  expect(notices.filter((t) => t.includes('10% weekly reserve'))).toHaveLength(2) // once per weekly window
  expect(notices).toHaveLength(3)
})

test('a weekly trip alone keeps the armed 5-hour badge rows out: the badge shows tripped, not waiting', async ($, on) => {
  const w = world(on, { weekPct: 93 }) // no 5-hour reading
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual({ text: ' ⚠ Pausing at next step', color: 'warning' })
  let lines = await status($)
  expect(lines).toContain(TRIPPED)
  expect(lines).toContain('· reading none: no reading yet')
  expect(lines).toContain(`· weekly reading live · ${pf1(FW(93))} (in 3 d 21 h)`)
  // Two billed responses without a 5-hour window: the 5-hour basis goes blind, and the weekly trip still rules.
  await $.session.measure(measure(undefined, ['rateLimits', 'cost'], RESETS, { pct: 93 }))
  await $.session.measure(measure(undefined, ['rateLimits', 'cost'], RESETS, { pct: 93 }))
  await w.clock.settle()
  expect(await badge(ui)).toEqual({ text: ' ⚠ Pausing at next step', color: 'warning' })
  lines = await status($)
  expect(lines).toContain(TRIPPED)
  expect(lines).toContain('· reading none: Claude Code reports no quota (blind)')
  // The gate holds on the weekly trip, and the badge says until when.
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ([FW(93)])])
  expect(await badge(ui)).toEqual({ text: ` ? spare10: waiting for you until ${weekClock(WEEK_OPENS_MS)}`, color: 'warning' })
  expect(await status($)).toContain(
    `? asking a question is open. Held work waits until you answer, or until ${weekClock(WEEK_OPENS_MS)}. If no dialog shows, run /spare10 resume or /spare10 stop.`,
  )
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(await badge(ui)).toEqual({ text: ' ⨯ spare10', color: 'warning' })
  await ui.unmount()
})

// ---- further weekly rules (B27, B30, 1.3 item 2, 2.8, 3.2) ----

test('a 5-hour consent does not cover a weekly trip', async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 92, env: { SPARE10_CONSENT: `S1 ${RESETS}` }, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ([FW(92)])])
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(`S1 ${WEEK_RESETS}`)
  expect(transcript(w)).toContain(continuing([FW(92)]))
})

const weeklyConsentCases = [
  { name: 'stamped with this session', raw: `S1 ${WEEK_RESETS}`, honoured: true, beyond: false },
  { name: 'set before launch (a bare time)', raw: WEEK_RESETS, honoured: true, beyond: false },
  { name: 'at the window end plus 60 s', raw: iso(WEEK_MS + 60_000), honoured: true, beyond: false },
  { name: 'stamped with another session', raw: `S0 ${WEEK_RESETS}`, honoured: false, beyond: false },
  { name: 'at an earlier time', raw: iso(T0 - 60_000), honoured: false, beyond: false },
  { name: 'at the window end plus 61 s', raw: iso(WEEK_MS + 61_000), honoured: false, beyond: true },
  { name: 'a value only Date.parse accepts', raw: 'abc-123', honoured: false, beyond: false },
]

for (const c of weeklyConsentCases) {
  test(`SPARE10_WEEKLY_CONSENT ${c.name} is ${c.honoured ? 'honoured' : 'ignored'}`, async ($, on) => {
    const w = world(on, { pct: 50, weekPct: 93, env: { SPARE10_WEEKLY_CONSENT: c.raw }, answer: 'Stop here' })
    await begin($, w)
    const lines = await status($)
    expect(lines.includes(`⚠ SPARE10_WEEKLY_CONSENT="${c.raw}" names a time after this weekly window. spare10 ignores it.`)).toBe(c.beyond)
    expect(transcript(w).some((t) => t.includes('SPARE10_WEEKLY_CONSENT'))).toBe(false)
    const r = await bash($)
    if (c.honoured) {
      expect(r.result).toBe('ran')
      expect(w.asked).toEqual([])
    } else {
      expect(r.deny).toBe(STOP([FW(93)]))
      expect(questions(w)).toEqual([loopQ([FW(93)])])
    }
  })
}

test('/spare10 resume with no question consents every gating kind and names them', async ($, on) => {
  const w = world(on, { pct: 91, weekPct: 92 })
  await begin($, w)
  const two = [F5(91), FW(92)]
  expect(await run($, 'resume')).toBe(`you can use ${use(two)}.`)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(`S1 ${WEEK_RESETS}`)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  expect(await run($, 'resume')).toBe(`already resumed ${quiet(two)}.`)
})

test('/spare10 stop on a weekly trip stops until the weekly reset, and a refused call adds work', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 92 })
  await begin($, w)
  const week = [FW(92)]
  expect(await run($, 'stop')).toBe(
    `stopped at the reserve until ${weekClock(WEEK_OPENS_MS)}, 8 h before the weekly reset. Then spare10 continues any stopped work. Type a prompt to be asked again, or run /spare10 resume.`,
  )
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', WEEK_OPENS, T0, 'seven_day,auto,skip'))
  expect(await run($, 'stop')).toBe(`already stopped until ${weekClock(WEEK_OPENS_MS)}.`)
  expect((await bash($)).deny).toBe(STOP(week))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', WEEK_OPENS, T0, 'seven_day,work,auto,skip'))
  expect(w.asked).toEqual([])
})

test('SPARE10_WEEKLY_RESERVE=15 moves the weekly trip point, and the label keeps the 5-hour reserve', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 84.9, env: { SPARE10_WEEKLY_RESERVE: '15' }, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  const lines = await status($)
  expect(lines).toContain('● armed spare10 steps in at 90% used, or at 85% used of the weekly window.')
  expect(lines).toContain('· weekly reserve 15% of the weekly window (from SPARE10_WEEKLY_RESERVE)')
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual({ text: ' ● spare10', color: 'success' }) // the weekly reserve never shows
  await ui.unmount()
  w.weekPct = 85
  expect((await bash($)).result).toBe('ran')
  expect(questions(w)).toEqual([loopQ([{ ...FW(85), reserve: 15 }])])
})

for (const raw of ['0.5', '100', 'abc']) {
  test(`a bad SPARE10_WEEKLY_RESERVE is ignored with a warning, and the weekly reserve stays 10 (${raw})`, async ($, on) => {
    const warning = `SPARE10_WEEKLY_RESERVE="${raw}" is not 0 or 1 to 99. spare10 uses 10.`
    const w = world(on, { pct: 50, weekPct: 89.9, env: { SPARE10_WEEKLY_RESERVE: raw }, answer: 'Resume' })
    await begin($, w)
    expect(count(transcript(w), warning)).toBe(1)
    const lines = await status($)
    expect(lines).toContain(`⚠ ${warning}`)
    expect(lines).toContain('· weekly reserve 10% of the weekly window (from /config)')
    expect((await bash($)).result).toBe('ran')
    expect(w.asked).toEqual([])
    w.weekPct = 90
    expect((await bash($)).result).toBe('ran')
    expect(questions(w)).toEqual([loopQ([FW(90)])])
    expect(count(transcript(w), warning)).toBe(1)
  })
}

test('both windows tripped: Stop here stops until the later reset and names both', async ($, on) => {
  const w = world(on, { pct: 91, weekPct: 92 })
  await begin($, w)
  const two = [F5(91), FW(92)]
  const held = bash($)
  await w.clock.settle()
  w.release('Stop here')
  expect((await held).deny).toBe(STOP(two))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', WEEK_OPENS, T0, 'five_hour,seven_day,work,auto,skip'))
  expect(transcript(w)).toContain(stoppedNotice(two))
  expect((await drain($, step())).text).toBe(PAUSED(two))
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual({ text: ` ■ spare10: stopped until ${weekClock(WEEK_OPENS_MS)}`, color: 'warning' })
  await ui.unmount()
})

test('/spare10 stop with a weekly question open refuses the held work until the weekly reset', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 92 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ([FW(92)])])
  expect(await run($, 'stop')).toBe(`stopped. Held work is refused. spare10 continues it at ${weekClock(WEEK_OPENS_MS)}, 8 h before the weekly reset.`)
  expect((await held).deny).toBe(STOP([FW(92)]))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', WEEK_OPENS, T0, 'seven_day,work,auto,skip'))
  expect(w.dialogAborted).not.toBe('no') // the dialog is withdrawn
  expect(w.asked).toHaveLength(1)
})

test('/spare10 resume and stop below both reserves name both readings', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 61 })
  await begin($, w)
  expect(await run($, 'resume')).toBe(`nothing to resume. ${pf([F5(50), FW(61)])}.`)
  expect(await run($, 'stop')).toBe('nothing to stop. spare10 steps in at 90% used, or at 90% used of the weekly window.')
  const lines = await status($)
  expect(lines).toContain(ARMED)
  expect(lines).toContain('· weekly reserve 10% of the weekly window (from /config)')
  expect(lines).toContain(`· weekly reading live · ${pf1(FW(61))} (in 3 d 21 h)`)
  expect(lines).toContain('· weekly consent none')
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
})

test('autoResume off: a weekly question waits past its reset, says so once, and a late Resume continues on the new weekly window', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 92, weekResetsAt: SOON, env: { SPARE10_AUTO_RESUME: 'off' }, spans: 'off' }) // the D0.2 reset timing
  await begin($, w)
  const week = [FW(92, SOON_MS)]
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([`${head(week)} All work is on hold. Continue on ${use(week)}?`]) // no {after} part
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual({ text: ' ? spare10: waiting for you', color: 'warning' })
  await ui.unmount()
  await w.clock.set(SOON_MS + MARGIN + 3 * TICK) // past the due time: nothing continues by itself
  expect(w.ran).toEqual([])
  expect(count(transcript(w), 'the weekly window reset. Held work still waits for your answer.')).toBe(1)
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w)).toContain('held work continues on the new weekly window.')
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBeUndefined() // an ended window gets no consent
  expect(w.submitted).toEqual([])
})

test('/spare10 stop after a weekly Resume clears the weekly consent, and the next call is refused', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 92, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(`S1 ${WEEK_RESETS}`)
  expect(await run($, 'stop')).toBe(
    `stopped at the reserve until ${weekClock(WEEK_OPENS_MS)}, 8 h before the weekly reset. Then spare10 continues any stopped work. Type a prompt to be asked again, or run /spare10 resume.`,
  )
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBeUndefined()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', WEEK_OPENS, T0, 'seven_day,auto,skip'))
  expect((await bash($)).deny).toBe(STOP([FW(92)]))
  expect(w.asked).toHaveLength(1)
})

test('/spare10 simulate off clears a real weekly consent too', async ($, on) => {
  const w = world(on, { pct: 50, weekPct: 92, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(`S1 ${WEEK_RESETS}`)
  expect(await run($, 'simulate off')).toBe(SIMULATE_OFF)
  await w.clock.settle()
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBeUndefined()
  w.answer = 'Stop here'
  expect((await bash($)).deny).toBe(STOP([FW(92)]))
  expect(questions(w)).toEqual([loopQ([FW(92)]), loopQ([FW(92)])])
})

test('a question that names both windows is not settled by another copy\'s consent for one of them', async ($, on) => {
  const w = world(on, { pct: 91, weekPct: 92 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(questions(w)).toEqual([loopQ([F5(91), FW(92)])])
  // Another copy of this process (a 0.1 copy that retires, or a Resume of a 5-hour question) writes SPARE10_CONSENT only.
  w.env.set('SPARE10_CONSENT', `S1 ${RESETS}`)
  w.cap() // the carrier cycles, and the waiter reads the env
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.dialogAborted).toBe('no') // the dialog stays up
  expect(w.asked).toHaveLength(1)
  w.env.set('SPARE10_WEEKLY_CONSENT', `S1 ${WEEK_RESETS}`) // now both windows have consent
  w.cap()
  expect((await held).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})
