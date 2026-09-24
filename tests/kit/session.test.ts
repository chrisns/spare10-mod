import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { VERSION } from '../../hooks/core/text.ts'
import { HOUR, LATER, RESETS, T0, WEEK_RESETS, bash, begin, clear, cmd, drain, measure, step, stopRec, typed, world } from '../helpers/world.ts'
import type { World } from '../helpers/world.ts'

// Session set-up, scope, per-run overrides, start-up warnings, env consent and stopped, and /clear
// (design 1.2, 2.5, 2.6, 2.9, 3.5, 3.6, 8, and the 11.4 session.test.ts table).
// Written from the spec: every expected text is built here from section 2, not from hooks/core/text.ts.

const RESETS_MS = Date.parse(RESETS)
const LATER_MS = Date.parse(LATER)

// {clock} is HH:MM 24-hour local time, and the kit runs in the machine's time zone.
const clock = (ms: number): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
// One decimal at most, no trailing .0.
const num = (n: number): string => String(Math.round(n * 10) / 10)
const until = (ms = RESETS_MS): string => `until ${clock(ms)}`
const pf = (used: number, ms = RESETS_MS): string => `${num(used)}% used · ${num(Math.max(0, 100 - used))}% left · resets ${clock(ms)}`
const mf = (reserve: number, used: number, ms = RESETS_MS): string =>
  `into your ${num(reserve)}% reserve · ${num(Math.max(0, 100 - used))}% of quota left · resets ${clock(ms)}`
// With autoResume on (the 0.2 default) a question says what Stop here and no answer mean (2.2).
const loopQuestion = (reserve: number, used: number, ms = RESETS_MS, auto = true): string =>
  `Your ${num(reserve)}% reserve is reached: ${pf(used, ms)}. All work is on hold. Continue on the reserve ${until(ms)}?` +
  (auto ? ` If you choose Stop here or do not answer, the work waits ${until(ms)}. Then spare10 continues it, unless a reserve is still reached.` : '')
const promptQuestion = (reserve: number, used: number, ms = RESETS_MS): string =>
  `Your ${num(reserve)}% reserve is reached: ${pf(used, ms)}. spare10 holds your prompt and any other work. Continue on the reserve ${until(ms)}? ` +
  `If you do not answer, all of it continues after ${clock(ms)}, unless a reserve is still reached. Stop here gives your prompt back and pauses other work ${until(ms)}.`
const ARMED = '● armed spare10 steps in at 90% used, or at 90% used of the weekly window.'
const AUTO_OFF = { SPARE10_AUTO_RESUME: 'off' } // the 0.1 behaviour: no release at the reset
const stopText = (reserve: number, used: number, ms = RESETS_MS): string =>
  `spare10: the user stopped work at the quota reserve (${mf(reserve, used, ms)}). Stop now and wait for the user. Do not call any further tools.`
const pausedText = (reserve: number, used: number, ms = RESETS_MS): string =>
  `spare10: work stopped at the quota reserve (${mf(reserve, used, ms)}). No model request was sent, so this task is not finished. Wait for the user.`
const headlessText = (reserve: number, used: number, sessionId: string): string =>
  `spare10 stopped this unattended run at the quota reserve (${mf(reserve, used)}). No further model requests were sent. To pick it up later: claude --resume ${sessionId}`
const resumeNote = (reserve: number): string =>
  `spare10: earlier work stopped at the ${num(reserve)}% quota reserve. The user now chose to continue on the reserve ${until()}. Follow their message.`
const tellText = (reserve: number, used: number, pausePrompt: string): string =>
  `spare10 budget guard. You have reached the safe usage limit for this session (${mf(reserve, used)}). Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.\n\nUser instructions: ${pausePrompt}`
const TOLD_NOTICE = 'your 10% reserve is reached. spare10 told the agents to wind down.'
const NOT_GUARDED = 'this run is not guarded. Nothing changed.'
const W_FLAG =
  'function hooks are on only in this shell. Background sessions and pane teammates start without spare10. Put CLAUDE_CODE_ENABLE_FUNCTION_HOOKS in the env block of ~/.claude/settings.json.'
const timeoutWarning = (name: string): string =>
  `questions here continue by themselves after a time limit (${name}). An unanswered spare10 question then counts as Stop here, and spare10 continues the work at the reset.`
const consentWarning = (raw: string): string =>
  `SPARE10_CONSENT="${raw}" names a time after this 5-hour window. spare10 ignores it.`
const iso = (ms: number): string => new Date(ms).toISOString()

type Logs = Pick<World, 'logs'>
const transcript = (w: Logs): string[] => w.logs.filter((l) => l.to !== 'debug').map((l) => l.text)
const debug = (w: Logs): string[] => w.logs.filter((l) => l.to === 'debug').map((l) => l.text)
const count = (list: string[], text: string): number => list.filter((t) => t === text).length

/** The /spare10 report, one entry per line with runs of white space folded (the layout is pinned by the pure text tests). */
async function status($: Engine): Promise<string[]> {
  const r = await $.command.run(cmd(''))
  return (r.text ?? '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
}

/** The footer badge as the terminal draws it: its text (with the leading space) and its colour. */
async function badgeOf($: Engine): Promise<{ text: string; color: unknown }> {
  const ui = await $.ui.mount({ plugin: 'spare10', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  const t = await ui.find({ type: 'Text', text: /spare10/ })
  await ui.unmount()
  return { text: t?.text ?? '', color: t?.props['color'] }
}

// ---- the 11.4 session table ----

test('options arrive typed and frozen with the defaults', async ($, on) => {
  // The kit loads the plugin with the manifest defaults (reserve 10, weeklyReserve 10, pausePrompt "",
  // autoResume true, headless off, scope all, badge true). A default that did not fit its field would
  // fail this load (gap-10 1.5).
  const w = world(on, { pct: 89.9 })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  expect(await badgeOf($)).toEqual({ text: ' ● spare10', color: 'success' })
  const lines = await status($)
  expect(lines[0]).toBe(`version ${VERSION}`)
  expect(lines).toContain(ARMED)
  expect(lines).toContain('· reserve 10% of the 5-hour window (from /config)')
  expect(lines).toContain('· weekly reserve 10% of the weekly window (from /config)')
  expect(lines).toContain('· at the reserve stop and ask you')
  expect(lines).toContain('· at the reset continue by itself (from /config)')
  expect(lines).toContain('· consent none')
  expect(lines).toContain('· guarded yes (scope all)')
  expect(lines).toContain('· claude -p runs started here: stop')
  expect(lines.some((l) => l.startsWith('· unattended'))).toBe(false)
  expect(lines.some((l) => l.startsWith('⚠'))).toBe(false)
  expect(lines).toContain('/spare10 resume continue on the reserve until the window resets')
  expect(lines).toContain('/spare10 stop stop at the reserve now')
  expect(lines.find((l) => l.startsWith('· reading'))).toContain(`· reading live · ${pf(89.9)} (in `)
  // Reserve 10 trips at 90.0, in hold mode: one question, the loop wording.
  w.pct = 90
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toEqual([{ question: loopQuestion(10, 90), header: 'spare10', labels: ['Stop here', 'Resume'] }])
  expect(w.ran).toEqual(['Bash:main'])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  expect(transcript(w).filter((t) => t.startsWith('SPARE10'))).toEqual([])
})

test('SPARE10_RESERVE=15 moves the trip point for this run', async ($, on) => {
  const w = world(on, { pct: 84.9, env: { SPARE10_RESERVE: '15' } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await drain($, step())
  expect(w.requests).toBe(1)
  expect(w.asked).toEqual([])
  expect(await badgeOf($)).toEqual({ text: ' ● spare10 (15%)', color: 'success' })
  const lines = await status($)
  expect(lines).toContain('● armed spare10 steps in at 85% used, or at 90% used of the weekly window.')
  expect(lines).toContain('· reserve 15% of the 5-hour window (from SPARE10_RESERVE)')
  expect(lines.some((l) => l.startsWith('⚠'))).toBe(false)
  w.pct = 85
  const held = bash($)
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(15, 85)])
  w.release('Stop here')
  expect((await held).deny).toBe(stopText(15, 85))
  await w.clock.settle()
  expect(transcript(w)).toContain(
    `stopped at your 15% reserve ${until()}. Then spare10 continues the work, unless a reserve is still reached. Type a prompt to be asked again, or run /spare10 resume.`,
  )
})

for (const raw of ['abc', '0', '100', '-5', '0.04']) {
  test(`a bad SPARE10_RESERVE is ignored and logged at session start (${raw})`, async ($, on) => {
    const warning = `SPARE10_RESERVE="${raw}" is not 1 to 99. spare10 uses 10.`
    const w = world(on, { pct: 89.9, env: { SPARE10_RESERVE: raw } })
    await begin($, w)
    expect(count(transcript(w), warning)).toBe(1)
    expect((await bash($)).result).toBe('ran')
    await drain($, step())
    expect(count(transcript(w), warning)).toBe(1) // logged once, at session start only
    const lines = await status($)
    expect(lines).toContain(`⚠ ${warning}`)
    expect(lines).toContain('· reserve 10% of the 5-hour window (from /config)')
    expect(lines).toContain(ARMED)
    w.pct = 90
    const held = bash($)
    await w.clock.settle()
    expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 90)])
    w.release('Resume')
    expect((await held).result).toBe('ran')
  })
}

test('SPARE10_RESERVE is rounded to one decimal, and a non-default reserve is spelled out', async ($, on) => {
  const w = world(on, { pct: 89.3, env: { SPARE10_RESERVE: '10.55' } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(await badgeOf($)).toEqual({ text: ' ● spare10 (10.6%)', color: 'success' })
  expect(await status($)).toContain('· reserve 10.6% of the 5-hour window (from SPARE10_RESERVE)')
  expect(transcript(w).filter((t) => t.includes('SPARE10_RESERVE'))).toEqual([])
  w.pct = 89.4
  w.answer = 'Stop here'
  expect((await bash($)).deny).toBe(stopText(10.6, 89.4))
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10.6, 89.4)])
})

test('bad SPARE10_HEADLESS and SPARE10 values are ignored and logged at session start', async ($, on) => {
  const headless = 'SPARE10_HEADLESS="maybe" is not off, prompt, stop or wait. spare10 uses off.'
  const onOff = 'SPARE10="yes" is not on or off. spare10 uses the scope option (all).'
  const w = world(on, { pct: 93, env: { SPARE10_HEADLESS: 'maybe', SPARE10: 'yes' } })
  await begin($, w)
  expect(count(transcript(w), headless)).toBe(1)
  expect(count(transcript(w), onOff)).toBe(1)
  expect(w.env.get('SPARE10_HEADLESS')).toBe('maybe') // a set value is never overwritten (B16)
  const lines = await status($)
  expect(lines).toContain(`⚠ ${headless}`)
  expect(lines).toContain(`⚠ ${onOff}`)
  expect(lines).toContain('· guarded yes (scope all)')
  w.answer = 'Stop here'
  expect((await bash($)).deny).toBe(stopText(10, 93))
  expect(w.asked).toHaveLength(1)
})

test('SPARE10=off watches only: the gate passes, the seed is written, the badge shows off', async ($, on) => {
  const w = world(on, { pct: 95, env: { SPARE10: 'off', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' }, agents: ['a1'] })
  await begin($, w)
  const out = await Promise.all([bash($), bash($, 'a1')])
  expect(out.map((r) => r.result)).toEqual(['ran', 'ran'])
  expect(out.map((r) => r.context)).toEqual([undefined, undefined])
  await drain($, step(undefined, 'T1'))
  await drain($, step('a1', 'T1'))
  expect(w.requests).toBe(2)
  expect(await $.prompt.submit(typed('hello'))).toMatchObject({ text: 'hello' })
  expect(w.prompts.map((p) => p.context)).toEqual([undefined])
  expect(w.asked).toEqual([])
  expect(w.aborts).toEqual([])
  // It still senses and writes the seed.
  await $.session.measure(measure(95))
  expect(w.store.get('seed')).toEqual({ pct: 95, resetsAtMs: RESETS_MS })
  expect(await badgeOf($)).toEqual({ text: ' ○ spare10 off', color: 'inactive' })
  const lines = await status($)
  expect(lines).toContain('○ off spare10 only watches in this run.')
  expect(lines).toContain('· guarded no: SPARE10=off. spare10 only watches.')
  expect(lines.find((l) => l.startsWith('· reading'))).toContain(`· reading live · ${pf(95)}`)
  // Not guarded: no B16 write for children, no B28 warning, and the verbs change nothing.
  expect(w.env.has('SPARE10_HEADLESS')).toBe(false)
  expect(transcript(w)).not.toContain(W_FLAG)
  expect((await $.command.run(cmd('resume'))).text).toBe(NOT_GUARDED)
  expect((await $.command.run(cmd('stop'))).text).toBe(NOT_GUARDED)
  await w.clock.settle()
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect((await bash($)).result).toBe('ran')
})

test('SPARE10=off never tells or refuses, even with a pause prompt and a stop on record for this session', async ($, on) => {
  const w = world(on, {
    pct: 95,
    env: { SPARE10: ' OFF ', SPARE10_PAUSE_PROMPT: 'Commit and stop.', SPARE10_STOPPED: stopRec('S1', RESETS_MS, T0 - 60_000) },
  })
  await begin($, w)
  const r = await bash($)
  expect(r.result).toBe('ran')
  expect(r.context).toBeUndefined()
  const s = await drain($, step())
  expect(s.text).toBe('hi')
  expect(w.requests).toBe(1)
  expect(await $.prompt.submit(typed('hello'))).toMatchObject({ text: 'hello' })
  expect(w.asked).toEqual([])
  expect(w.aborts).toEqual([])
  expect(debug(w).filter((t) => t.startsWith('spare10: told'))).toEqual([])
  expect(await status($)).toContain('○ off spare10 only watches in this run.')
  expect(await badgeOf($)).toEqual({ text: ' ○ spare10 off', color: 'inactive' })
})

test('SPARE10=off passes an unattended run whatever its headless policy', async ($, on) => {
  const w = world(on, { pct: 95, surfaces: [], env: { SPARE10: 'off', SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step(undefined, 'T1'))).text).toBe('hi')
  expect(w.requests).toBe(1)
  expect(w.aborts).toEqual([])
  expect(w.asked).toEqual([])
  expect(await status($)).toContain('○ off spare10 only watches in this run.')
})

test('scope opt-in without SPARE10=on watches only, and SPARE10=on guards', async ($, on) => {
  // The kit cannot pass option values (11.5 #17), so scope stays all here: the opt-in half is pinned
  // by the pure withEnv tests. This pins the SPARE10=on half end to end.
  const w = world(on, { pct: 93, env: { SPARE10: 'on' } })
  await begin($, w)
  expect(await status($)).toContain('· guarded yes (SPARE10=on)')
  expect(w.env.get('SPARE10_HEADLESS')).toBe('stop') // guarded: B16 applies
  const held = bash($)
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93)])
  expect(w.ran).toEqual([])
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

test('SPARE10=on does not make an unattended run ask: it follows the headless policy', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10: 'on', SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  expect((await bash($)).deny).toBe(headlessText(10, 93, 'S1'))
  expect((await drain($, step(undefined, 'T1'))).text).toBe(headlessText(10, 93, 'S1'))
  expect(w.requests).toBe(0)
  expect(w.asked).toEqual([])
  const lines = await status($)
  expect(lines).toContain('· guarded no: this session is unattended.')
  expect(lines).toContain('· unattended stop (from SPARE10_HEADLESS)')
  expect(lines.some((l) => l.startsWith('· claude -p'))).toBe(false)
})

test('the flag only in the process env logs B28, and the flag in user settings does not', async ($, on) => {
  const w = world(on, { pct: 50, env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } })
  await begin($, w)
  expect(count(transcript(w), W_FLAG)).toBe(1)
  expect(await status($)).toContain(`⚠ ${W_FLAG}`)
  expect((await bash($)).result).toBe('ran')
  expect(count(transcript(w), W_FLAG)).toBe(1)
})

for (const source of ['user', 'project', 'local', 'flag', 'policy'] as const) {
  test(`the flag in ${source} settings env as well as the process env logs no B28`, async ($, on) => {
    const w = world(on, {
      pct: 50,
      env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
      settings: { [source]: { env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } } },
    })
    await begin($, w)
    expect(transcript(w)).not.toContain(W_FLAG)
    expect((await status($)).some((l) => l.includes('function hooks are on only in this shell'))).toBe(false)
  })
}

test('no B28 when the process env has no flag', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  expect(transcript(w)).not.toContain(W_FLAG)
  expect((await status($)).some((l) => l.startsWith('⚠'))).toBe(false)
})

test('a question time limit logs B29', async ($, on) => {
  const w = world(on, { pct: 50, settings: { merged: { askUserQuestionTimeout: 60 } } })
  await begin($, w)
  expect(count(transcript(w), timeoutWarning('askUserQuestionTimeout'))).toBe(1)
  expect(await status($)).toContain(`⚠ ${timeoutWarning('askUserQuestionTimeout')}`)
})

test('CLAUDE_AFK_TIMEOUT_MS logs B29 with its own name', async ($, on) => {
  const w = world(on, { pct: 50, env: { CLAUDE_AFK_TIMEOUT_MS: '60000' } })
  await begin($, w)
  expect(count(transcript(w), timeoutWarning('CLAUDE_AFK_TIMEOUT_MS'))).toBe(1)
  expect(await status($)).toContain(`⚠ ${timeoutWarning('CLAUDE_AFK_TIMEOUT_MS')}`)
})

test('B29 names askUserQuestionTimeout first when both limits are set', async ($, on) => {
  const w = world(on, { pct: 50, settings: { merged: { askUserQuestionTimeout: 30 } }, env: { CLAUDE_AFK_TIMEOUT_MS: '60000' } })
  await begin($, w)
  const limits = transcript(w).filter((t) => t.startsWith('questions here continue'))
  expect(limits).toEqual([timeoutWarning('askUserQuestionTimeout')])
})

test('no B29 without a positive time limit', async ($, on) => {
  const w = world(on, { pct: 50, settings: { merged: { askUserQuestionTimeout: 0 } } })
  await begin($, w)
  expect(transcript(w).filter((t) => t.startsWith('questions here continue'))).toEqual([])
})

test('a guarded session sets SPARE10_HEADLESS=stop for children when unset, and leaves a set value alone', async ($, on) => {
  const w = world(on, { pct: 93 })
  expect(w.env.has('SPARE10_HEADLESS')).toBe(false)
  await begin($, w)
  expect(w.env.get('SPARE10_HEADLESS')).toBe('stop')
  const lines = await status($)
  expect(lines).toContain('· claude -p runs started here: stop')
  expect(lines).toContain('· at the reserve stop and ask you')
  // The session itself stays attended and asks: the child policy is not its own.
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

for (const set of ['prompt', 'off', 'stop']) {
  test(`a guarded session leaves a set SPARE10_HEADLESS=${set} alone`, async ($, on) => {
    const w = world(on, { pct: 50, env: { SPARE10_HEADLESS: set } })
    await begin($, w)
    expect(w.env.get('SPARE10_HEADLESS')).toBe(set)
    expect(await status($)).toContain(`· claude -p runs started here: ${set}`)
  })
}

test('an unattended run sets no SPARE10_HEADLESS for children', async ($, on) => {
  const w = world(on, { pct: 50, surfaces: [] })
  await begin($, w)
  expect(w.env.has('SPARE10_HEADLESS')).toBe(false)
})

test('a run switched off by SPARE10=off sets no SPARE10_HEADLESS for children', async ($, on) => {
  const w = world(on, { pct: 50, env: { SPARE10: 'off' } })
  await begin($, w)
  expect(w.env.has('SPARE10_HEADLESS')).toBe(false)
})

// 3.5: consentCovers(until, now, windowEnd) = now < until && until <= windowEnd + 60 000.
const consentCases: Array<{ name: string; raw: string; honoured: boolean; beyond: boolean }> = [
  { name: 'the window end', raw: RESETS, honoured: true, beyond: false },
  { name: 'the window end plus 60 s', raw: iso(RESETS_MS + 60_000), honoured: true, beyond: false },
  { name: 'an earlier time', raw: iso(T0 - 60_000), honoured: false, beyond: false },
  { name: 'now', raw: iso(T0), honoured: false, beyond: false },
  { name: 'the window end plus 61 s', raw: iso(RESETS_MS + 61_000), honoured: false, beyond: true },
  { name: 'a far-future time', raw: LATER, honoured: false, beyond: true },
  { name: 'junk', raw: 'soon', honoured: false, beyond: false },
]

test('a fresh module honours SPARE10_CONSENT for this window, not an earlier or a far-future one', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_CONSENT: RESETS }, agents: ['a1'] })
  await begin($, w)
  const lines = await status($)
  expect(lines).toContain(`⨯ consented you chose to continue. spare10 is quiet ${until()}.`)
  expect(lines).toContain(`· consent ${until()} (you chose to continue)`)
  expect(lines.some((l) => l.includes('SPARE10_CONSENT'))).toBe(false)
  expect(await badgeOf($)).toEqual({ text: ' ⨯ spare10', color: 'warning' })
  const out = await Promise.all([bash($), bash($, 'a1')])
  expect(out.map((r) => r.result)).toEqual(['ran', 'ran'])
  await drain($, step())
  await drain($, step('a1'))
  expect(w.requests).toBe(2)
  expect(await $.prompt.submit(typed('hello'))).toMatchObject({ text: 'hello' })
  expect(w.asked).toEqual([])
  expect(w.env.get('SPARE10_CONSENT')).toBe(RESETS) // a value set before launch is left as it is
})

for (const c of consentCases) {
  test(`SPARE10_CONSENT at ${c.name} is ${c.honoured ? 'honoured' : 'ignored'}`, async ($, on) => {
    const w = world(on, { pct: 93, env: { SPARE10_CONSENT: c.raw }, answer: 'Stop here' })
    await begin($, w)
    const lines = await status($)
    // B30 shows under /spare10 only, and only for a time beyond this window.
    expect(lines.includes(`⚠ ${consentWarning(c.raw)}`)).toBe(c.beyond)
    expect(transcript(w).some((t) => t.includes('SPARE10_CONSENT'))).toBe(false)
    const r = await bash($)
    if (c.honoured) {
      expect(r.result).toBe('ran')
      expect(w.asked).toEqual([])
    } else {
      expect(r.deny).toBe(stopText(10, 93))
      expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93)])
    }
  })
}

test('stopped is stamped with the session id, so a new id after /clear asks again', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Stop here' })
  await begin($, w)
  expect((await bash($)).deny).toBe(stopText(10, 93))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', RESETS_MS, T0, 'five_hour,work,auto'))
  expect((await bash($)).deny).toBe(stopText(10, 93))
  expect(w.asked).toHaveLength(1)
  expect(await status($)).toContain(
    `■ stopped you chose Stop here. spare10 continues the work after ${clock(RESETS_MS)}. Type a prompt to be asked again, or run /spare10 resume.`,
  )
  await clear($, w, 'S2')
  expect(await status($)).toContain('⚠ tripped spare10 holds the next step and asks you.')
  expect(await badgeOf($)).not.toEqual({ text: ` ■ spare10: stopped ${until()}`, color: 'warning' })
  // The next prompt asks again, with the prompt wording, and Resume lets it in without the resume
  // note: this conversation was never stopped.
  w.answer = 'hang'
  const p = $.prompt.submit(typed('go on'))
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93), promptQuestion(10, 93)])
  expect(w.prompts).toEqual([])
  w.release('Resume')
  expect(await p).toMatchObject({ text: 'go on' })
  expect(w.prompts.map((e) => e.context)).toEqual([undefined])
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S2 ${RESETS}`) // stamped with the id of the writer (9.3)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect((await bash($)).result).toBe('ran')
})

// ---- 3.6: reload, respawn, /clear, /resume ----

test('a stop on record for this session (a reload or respawn) still refuses, and a person prompt asks again', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_STOPPED: stopRec('S1', RESETS_MS, T0 - 60_000) } })
  await begin($, w)
  expect((await bash($)).deny).toBe(stopText(10, 93))
  const refused = await drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(refused.text).toBe(pausedText(10, 93))
  expect(w.requests).toBe(0)
  expect(w.aborts).toEqual(['T1'])
  expect(w.asked).toEqual([])
  expect(await badgeOf($)).toEqual({ text: ` ■ spare10: stopped ${until()}`, color: 'warning' })
  // The older stop never answers the new question (st.at > q.since): it waits for the person.
  const p = $.prompt.submit(typed('carry on'))
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([promptQuestion(10, 93)])
  expect(w.prompts).toEqual([])
  w.release('Resume')
  expect(await p).toMatchObject({ text: 'carry on' })
  expect(w.prompts.map((e) => e.context)).toEqual([[resumeNote(10)]])
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
})

test('a stop on record for another session id does not stop this one', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Resume', env: { SPARE10_STOPPED: stopRec('S0', RESETS_MS, T0 - 60_000) } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93)])
})

test('a stop on record whose window has ended no longer applies', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Resume', env: { SPARE10_STOPPED: stopRec('S1', T0 - 1000, T0 - HOUR) } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('a junk stop on record is ignored', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Resume', env: { SPARE10_STOPPED: 'garbage' } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('consent survives /clear', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  await clear($, w, 'S2')
  expect((await bash($)).result).toBe('ran')
  await drain($, step())
  expect(await $.prompt.submit(typed('hello'))).toMatchObject({ text: 'hello' })
  expect(w.requests).toBe(1)
  expect(w.asked).toHaveLength(1)
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(await status($)).toContain(`⨯ consented you chose to continue. spare10 is quiet ${until()}.`)
})

test('/clear while a question is open keeps the question, and its Stop is stamped with the new session id', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  // Nothing gated runs between the /clear and the answer: the stamp must come from a fresh
  // $.session.id() in settle, not from the id cached before the /clear (R3).
  await clear($, w, 'S2')
  w.release('Stop here')
  expect((await held).deny).toBe(stopText(10, 93))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S2', RESETS_MS, T0, 'five_hour,work,auto'))
  // Stopped applies to the new conversation: refused at once, no second question.
  expect((await bash($)).deny).toBe(stopText(10, 93))
  expect(w.asked).toHaveLength(1)
})

test('/clear while a question is open: a loop of the new conversation joins it', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const first = bash($)
  await w.clock.settle()
  await clear($, w, 'S2')
  const second = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.ran).toEqual([])
  w.release('Stop here')
  expect((await first).deny).toBe(stopText(10, 93))
  expect((await second).deny).toBe(stopText(10, 93))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S2', RESETS_MS, T0, 'five_hour,work,auto'))
})

test('/clear while a question is open: Resume still applies to the held loops', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  await clear($, w, 'S2')
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S2 ${RESETS}`) // stamped with the id of the writer (9.3)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('after /clear every loop is told again, and the wind-down notice stays once per window', async ($, on) => {
  const pause = 'Commit and stop.'
  const w = world(on, { pct: 93, env: { SPARE10_PAUSE_PROMPT: pause } })
  await begin($, w)
  expect((await bash($)).context).toEqual([tellText(10, 93, pause)])
  expect((await bash($)).context).toBeUndefined()
  await clear($, w, 'S2')
  expect((await bash($)).context).toEqual([tellText(10, 93, pause)])
  expect((await bash($)).context).toBeUndefined()
  expect(debug(w).filter((t) => t.startsWith('spare10: told'))).toEqual(['spare10: told S1:main', 'spare10: told S2:main'])
  expect(count(transcript(w), TOLD_NOTICE)).toBe(1)
  expect(w.ran).toHaveLength(4)
  expect(w.asked).toEqual([])
})

test('the test reading and the reading memory survive /clear', async ($, on) => {
  const w = world(on, { pct: undefined, answer: 'Stop here' })
  await begin($, w)
  await $.session.measure(measure(93)) // remembered: no live reading follows
  await clear($, w, 'S2')
  expect((await bash($)).deny).toBe(stopText(10, 93))
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93)])
})

test('a test reading set before /clear still trips after it', async ($, on) => {
  const w = world(on, { pct: 50, answer: 'Stop here' })
  await begin($, w)
  await $.command.run(cmd('simulate 95'))
  await clear($, w, 'S2')
  expect((await bash($)).deny).toBe(stopText(10, 95))
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 95)])
})

// ---- 2.5: window end ----

test('stopped ends at the window end, and the next window asks again', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Stop here', env: AUTO_OFF })
  await begin($, w)
  expect((await bash($)).deny).toBe(stopText(10, 93))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', RESETS_MS, T0, 'five_hour,work'))
  const after = RESETS_MS + 60_000
  await w.clock.set(after)
  w.resetsAt = LATER
  w.answer = 'hang'
  const held = bash($)
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93, RESETS_MS, false), loopQuestion(10, 93, LATER_MS, false)])
  w.release('Stop here')
  expect((await held).deny).toBe(stopText(10, 93, LATER_MS))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', LATER_MS, after, 'five_hour,work'))
})

test('consent ends at the window end, and the next window re-arms by itself', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  await w.clock.set(RESETS_MS + 60_000)
  w.resetsAt = LATER
  w.pct = 20
  expect(await status($)).toContain(ARMED)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
  w.pct = 93
  w.answer = 'hang'
  const held = bash($)
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93), loopQuestion(10, 93, LATER_MS)])
  expect(w.ran).toEqual(['Bash:main', 'Bash:main'])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${LATER}`)
})

// ---- 8.2: the pause prompt per run ----

test('a blank SPARE10_PAUSE_PROMPT keeps stop-and-ask', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_PAUSE_PROMPT: '   ' } })
  await begin($, w)
  expect(await status($)).toContain('· at the reserve stop and ask you')
  const held = bash($)
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93)])
  w.release('Resume')
  const r = await held
  expect(r.result).toBe('ran')
  expect(r.context).toBeUndefined()
})

test('SPARE10_PAUSE_PROMPT switches this run to tell mode, quoted in /spare10', async ($, on) => {
  const pause = 'Commit, then "stop".'
  const w = world(on, { pct: 93, env: { SPARE10_PAUSE_PROMPT: pause } })
  await begin($, w)
  expect(await status($)).toContain(`· at the reserve tell every agent: ${JSON.stringify(pause)}`)
  const r = await bash($)
  expect(r.result).toBe('ran')
  expect(r.context).toEqual([tellText(10, 93, pause)])
  expect(w.asked).toEqual([])
})

// ---- more of 2.5, 2.9, 3.5, 3.6 ----

test('a Resume that comes after the window end lets held work go on and writes no consent', async ($, on) => {
  const w = world(on, { pct: 93, env: AUTO_OFF })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await w.clock.set(RESETS_MS + 60_000)
  w.resetsAt = LATER
  w.pct = 5
  expect(w.ran).toEqual([])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  expect(w.env.has('SPARE10_STOPPED')).toBe(false)
  expect(transcript(w)).toContain('held work continues on the new 5-hour window.')
  expect(transcript(w).some((t) => t.startsWith('continuing on your'))).toBe(false)
})

test('an unattended run logs no B28', async ($, on) => {
  const w = world(on, { pct: 50, surfaces: [], env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } })
  await begin($, w)
  expect(transcript(w)).not.toContain(W_FLAG)
})

test('an in-session /resume to another conversation ends stopped too', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Stop here' })
  await begin($, w)
  expect((await bash($)).deny).toBe(stopText(10, 93))
  await w.clock.settle()
  await clear($, w, 'S7', 'resume')
  w.answer = 'Resume'
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(2)
})

test('without resetsAt the question reads for one hour, and consent lasts one hour from the first sight', async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: null })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([
    'Your 10% reserve is reached: 93% used · 7% left · resets at an unknown time. All work is on hold. Continue on the reserve for one hour? ' +
      `If you choose Stop here or do not answer, the work waits until ${clock(T0 + 5 * HOUR)}. Then spare10 continues it, unless a reserve is still reached.`, // 3.1: the first sight plus 5 h
  ])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${iso(T0 + HOUR)}`)
  await w.clock.advance(30 * 60_000)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
  await w.clock.set(T0 + HOUR + 60_000)
  w.answer = 'Stop here'
  expect((await bash($)).deny).toBe(
    'spare10: the user stopped work at the quota reserve (into your 10% reserve · 7% of quota left · resets at an unknown time). Stop now and wait for the user. Do not call any further tools.',
  )
  expect(w.asked).toHaveLength(2)
})

test('without resetsAt the window end is stable, so each loop is told once', async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: null, env: { SPARE10_PAUSE_PROMPT: 'Commit and stop.' } })
  await begin($, w)
  const first = await bash($)
  expect(first.context).toEqual([
    'spare10 budget guard. You have reached the safe usage limit for this session (into your 10% reserve · 7% of quota left · resets at an unknown time). Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.\n\nUser instructions: Commit and stop.',
  ])
  await w.clock.advance(5 * 60_000)
  expect((await bash($)).context).toBeUndefined()
  await w.clock.advance(20 * 60_000)
  expect((await bash($)).context).toBeUndefined()
  expect(debug(w).filter((t) => t.startsWith('spare10: told'))).toEqual(['spare10: told S1:main'])
  expect(count(transcript(w), TOLD_NOTICE)).toBe(1)
})

test('in tell mode a stop on record for this session still refuses, and /spare10 shows stopped, not told', async ($, on) => {
  const w = world(on, {
    pct: 93,
    env: { SPARE10_PAUSE_PROMPT: 'Commit and stop.', SPARE10_STOPPED: stopRec('S1', RESETS_MS, T0 - 60_000) },
  })
  await begin($, w)
  const r = await bash($)
  expect(r.deny).toBe(stopText(10, 93))
  expect(r.context).toBeUndefined()
  expect((await drain($, step(undefined, 'T1'))).text).toBe(pausedText(10, 93))
  expect(w.requests).toBe(0)
  expect(w.asked).toEqual([])
  await w.clock.settle() // the refused loops marked the stop as one with work (5.7)
  expect(await status($)).toContain(
    `■ stopped you chose Stop here. spare10 continues the work after ${clock(RESETS_MS)}. Type a prompt to be asked again, or run /spare10 resume.`,
  )
})

test('consent is read as the later of this copy and the env: an env value unset from outside does not re-arm', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  w.env.delete('SPARE10_CONSENT')
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('per-run overrides are read once per activation: a later env change does nothing to this run', async ($, on) => {
  const w = world(on, { pct: 60 })
  await begin($, w)
  w.env.set('SPARE10_RESERVE', '50')
  w.env.set('SPARE10', 'off')
  w.env.set('SPARE10_PAUSE_PROMPT', 'Commit and stop.')
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  const lines = await status($)
  expect(lines).toContain('· reserve 10% of the 5-hour window (from /config)')
  expect(lines).toContain('· guarded yes (scope all)')
  expect(lines).toContain('· at the reserve stop and ask you')
  w.pct = 93
  const held = bash($)
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93)])
  w.release('Resume')
  const r = await held
  expect(r.result).toBe('ran')
  expect(r.context).toBeUndefined()
})

test('after /clear an unattended run with the prompt policy tells every loop again', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'prompt' } })
  await begin($, w)
  const text =
    `spare10 budget guard. You have reached the safe usage limit for this session (${mf(10, 93)}). Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.`
  expect((await bash($)).context).toEqual([text])
  expect((await bash($)).context).toBeUndefined()
  await clear($, w, 'S2')
  expect((await bash($)).context).toEqual([text])
  expect(debug(w).filter((t) => t.startsWith('spare10: told'))).toEqual(['spare10: told S1:main', 'spare10: told S2:main'])
  expect(w.asked).toEqual([])
})

test('after /clear an unattended prompt run counts only the new conversation as told', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'prompt' } })
  await begin($, w)
  expect((await bash($)).context).toHaveLength(1) // S1:main told
  expect(await badgeOf($)).toEqual({ text: ' ⏸ spare10', color: 'warning' })
  expect(await status($)).toContain('⏸ told the wind-down went to 1 agent(s).')
  await clear($, w, 'S2')
  expect(await badgeOf($)).toEqual({ text: ' ⚠ spare10: in the reserve', color: 'warning' })
  expect(await status($)).toContain('⚠ tripped unattended run, policy prompt.')
  expect((await bash($)).context).toHaveLength(1) // S2:main told
  expect(await badgeOf($)).toEqual({ text: ' ⏸ spare10', color: 'warning' })
  expect(await status($)).toContain('⏸ told the wind-down went to 1 agent(s).')
})

test('after /clear in tell mode a person prompt asks again until the new main loop is told', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_PAUSE_PROMPT: 'Commit and stop.' } })
  await begin($, w)
  expect((await bash($)).context).toHaveLength(1) // S1:main told
  expect(await $.prompt.submit(typed('one'))).toMatchObject({ text: 'one' })
  expect(w.asked).toEqual([])
  await clear($, w, 'S2')
  w.answer = 'Stop here'
  expect(await $.prompt.submit(typed('two'))).toEqual({
    drop: `spare10: not started. This session is inside your 10% reserve ${until()}. Send the prompt again to be asked again, or run /spare10 resume.`,
  })
  expect(w.asked.map((a) => a.question)).toEqual([
    `Your 10% reserve is reached: ${pf(93)}. spare10 holds your prompt. Continue on the reserve ${until()}? ` +
      `If you do not answer, your prompt goes in after ${clock(RESETS_MS)}, unless a reserve is still reached. Stop here gives it back to you.`,
  ])
  await w.clock.settle()
  expect(w.env.has('SPARE10_STOPPED')).toBe(false) // B13: a tell-mode Stop sets no stop
  expect((await bash($)).context).toHaveLength(1) // S2:main told
  expect(await $.prompt.submit(typed('three'))).toMatchObject({ text: 'three' })
  expect(w.asked).toHaveLength(1)
})

// ---- sense failures (4.2: sense fails open, a failed override falls back to the options) ----

test('an unreadable SPARE10_* value falls back to the options, and the gate still holds', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_RESERVE: '50' }, envGetFails: ['SPARE10_RESERVE'] })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93)]) // the reserve of the options
  expect(w.ran).toEqual([])
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

// ---- 9.3: consent and switches that a long-lived descendant inherits ----

const BG_WARNING = (list: string): string =>
  `this background session has ${list}. A background session gets such values from the claude daemon or a settings file, not from your terminal.`

test("an attended session ignores a consent stamped with another session's id", async ($, on) => {
  // The transient claude daemon, a tmux server or a nested interactive claude inherits the env of the
  // session that consented. Its stamp names that session, not this one.
  const w = world(on, { pct: 93, env: { SPARE10_CONSENT: `S0 ${RESETS}` }, answer: 'Stop here' })
  await begin($, w)
  const lines = await status($)
  expect(lines).toContain('⚠ tripped spare10 holds the next step and asks you.')
  expect(lines).toContain('· consent none')
  expect((await bash($)).deny).toBe(stopText(10, 93))
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93)])
})

test('a consent stamped with this session id counts in a fresh module, as after a reload', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_CONSENT: `S1 ${RESETS}` } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(await status($)).toContain(`· consent ${until()} (you chose to continue)`)
  expect(w.asked).toEqual([])
})

test('a --bg session asks despite a bare consent from the daemon, and its own Resume counts', async ($, on) => {
  const w = world(on, { pct: 93, env: { CLAUDE_CODE_SESSION_KIND: 'bg', SPARE10_CONSENT: RESETS }, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(10, 93)])
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('a --bg session warns about SPARE10 switches that it got from the daemon, also when they switch spare10 off', async ($, on) => {
  const w = world(on, {
    pct: 93,
    env: { CLAUDE_CODE_SESSION_KIND: 'bg', SPARE10: 'off', SPARE10_RESERVE: '15', SPARE10_PAUSE_PROMPT: 'Stop.' },
  })
  await begin($, w)
  const warning = BG_WARNING('SPARE10="off", SPARE10_RESERVE="15", SPARE10_PAUSE_PROMPT="Stop."')
  expect(count(transcript(w), warning)).toBe(1)
  expect(await status($)).toContain(`⚠ ${warning}`)
})

test('no background warning outside a --bg session', async ($, on) => {
  const w = world(on, { pct: 50, env: { SPARE10_RESERVE: '15', SPARE10: 'on' } })
  await begin($, w)
  expect(transcript(w).some((t) => t.startsWith('this background session'))).toBe(false)
})

test('no background warning in a --bg session without SPARE10 switches', async ($, on) => {
  const w = world(on, { pct: 50, env: { CLAUDE_CODE_SESSION_KIND: 'bg', SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  expect(transcript(w).some((t) => t.startsWith('this background session'))).toBe(false)
  expect((await status($)).some((l) => l.startsWith('⚠'))).toBe(false)
})

test('/clear keeps consent at once, and then moves its stamp to the new session id', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  await clear($, w, 'S2')
  expect((await bash($)).result).toBe('ran') // the ended id is this process's: its consent counts
  await w.clock.advance(300)
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S2 ${RESETS}`) // a reload after this still finds it
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('/clear moves the stamp of a weekly consent too', async ($, on) => {
  const w = world(on, { pct: 93, weekPct: 92, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(`S1 ${WEEK_RESETS}`)
  await clear($, w, 'S2')
  await w.clock.advance(300)
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S2 ${RESETS}`)
  expect(w.env.get('SPARE10_WEEKLY_CONSENT')).toBe(`S2 ${WEEK_RESETS}`) // a reload after this still finds it
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('/spare10 stop right after /clear is never undone by the move of the stamp', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  await clear($, w, 'S2')
  w.envGetDelayMs = { SPARE10_CONSENT: 200 } // the move reads the old stamp, and gets the answer late
  await w.clock.advance(300)
  expect((await $.command.run(cmd('stop'))).text).toBe(
    `stopped at the reserve ${until()}. Then spare10 continues any stopped work. Type a prompt to be asked again, or run /spare10 resume.`,
  )
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  w.envGetDelayMs = {}
  await w.clock.advance(2000) // the stale read returns, and the second move runs
  expect(w.env.has('SPARE10_CONSENT')).toBe(false)
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S2', RESETS_MS, T0 + 300, 'five_hour,auto'))
})

test('after a reload and then /clear, the consent of this process counts before its stamp moves', async ($, on) => {
  // A fresh module with the stamp of this process in the env is what a reload leaves: no cache holds it.
  const w = world(on, { pct: 93, env: { SPARE10_CONSENT: `S1 ${RESETS}` } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await clear($, w, 'S2')
  expect((await bash($)).result).toBe('ran') // S1 ended in this process: its consent is still this process's
  expect(w.asked).toEqual([])
  await w.clock.advance(300)
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S2 ${RESETS}`)
})

// D1: the engine puts `spare10: ` in front of each transcript line and command reply. A text that
// starts with it renders as `spare10: spare10: ...`. Debug lines are not prefixed, so they keep it.
test('no transcript line and no command reply starts with the prefix that the engine adds', async ($, on) => {
  const w = world(on, {
    pct: 93,
    env: { SPARE10: 'maybe', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
    settings: { merged: { askUserQuestionTimeout: 60 } },
    answer: 'Stop here',
  })
  await begin($, w)
  expect((await bash($)).deny).toBe(stopText(10, 93))
  await w.clock.settle()
  const replies: string[] = []
  for (const args of ['', 'resume', 'stop', 'stop', 'simulate', 'simulate 95', 'simulate off', 'pause']) {
    replies.push((await $.command.run(cmd(args))).text ?? '')
  }
  replies.push((await $.command.run(cmd('resume', 'plugin'))).text ?? '')
  await w.clock.settle()
  expect(transcript(w)).toHaveLength(4) // the three start-up warnings and the Stop notice
  for (const t of [...transcript(w), ...replies]) expect(t.startsWith('spare10')).toBe(false)
  expect(replies[0]?.split('\n')[0]).toBe(`version ${VERSION}`) // renders as `spare10: version 0.2.0`
  for (const t of debug(w)) expect(t.startsWith('spare10: ')).toBe(true)
})
