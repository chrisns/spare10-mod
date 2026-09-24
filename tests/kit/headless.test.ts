import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { HOUR, LATER, RESETS, T0, bash, begin, clear, cmd, drain, measure, step, typed, world } from '../helpers/world.ts'

// Unattended runs through the engine (design 11.4 headless.test.ts, 2.4 B15 and B16, 9, ruling R2).
// Every expected text is spelled out from design section 2 here, not taken from hooks/core/text.ts,
// so a drift in the texts or the policies fails a test.

const RESET_MS = Date.parse(RESETS)
const LATER_MS = Date.parse(LATER)
const TEST_WINDOW = 5 * HOUR

const two = (n: number): string => String(n).padStart(2, '0')
// {clock}: HH:MM, 24-hour, local time (the kit runs in the machine's time zone)
const clockOf = (ms: number): string => {
  const d = new Date(ms)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}
// {used} and {left}: one decimal at most, no trailing .0
const num = (n: number): string => String(Math.round(n * 10) / 10)
const left = (used: number): string => num(Math.max(0, 100 - used))
const pf = (used: number, resetMs = RESET_MS): string => `${num(used)}% used · ${left(used)}% left · resets ${clockOf(resetMs)}`
const mf = (used: number, resetMs = RESET_MS): string =>
  `into your 10% reserve · ${left(used)}% of quota left · resets ${clockOf(resetMs)}`

const HEADLESS = (used: number, sessionId = 'S1', resetMs = RESET_MS): string =>
  `spare10 stopped this unattended run at the quota reserve (${mf(used, resetMs)}). No further model requests were sent. To pick it up later: claude --resume ${sessionId}`
const TELL = (used: number, pausePrompt?: string): string =>
  `spare10 budget guard. You have reached the safe usage limit for this session (${mf(used)}). Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.` +
  (pausePrompt === undefined ? '' : `\n\nUser instructions: ${pausePrompt}`)
const UNATTENDED = (used: number, policy: string, resetMs = RESET_MS): string =>
  `spare10: unattended run inside the reserve (${pf(used, resetMs)}), policy ${policy}.`
const TOLD_NOTICE = 'your 10% reserve is reached. spare10 told the agents to wind down.'
const LOOP_QUESTION = (used: number): string =>
  `Your 10% reserve is reached: ${pf(used)}. All work is on hold. Continue on the reserve until ${clockOf(RESET_MS)}?`
const NOT_GUARDED = 'this run is not guarded. Nothing changed.'
const B28 = 'function hooks are on only in this shell.'
const B29 = 'questions here continue by themselves after a time limit'

type Logged = { logs: Array<{ text: string; to?: string }> }
const debug = (w: Logged): string[] => w.logs.filter((l) => l.to === 'debug').map((l) => l.text)
const transcript = (w: Logged): string[] => w.logs.filter((l) => l.to !== 'debug').map((l) => l.text)
const count = (list: string[], text: string): number => list.filter((t) => t === text).length

// /spare10 as the person types it, one entry per line of the report
const report = async ($: Engine): Promise<string[]> =>
  ((await $.command.run(cmd(''))).text ?? '').split('\n').map((l) => l.trimEnd())

const mountBadge = ($: Engine) =>
  $.ui.mount({ plugin: 'spare10', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
type Badge = Awaited<ReturnType<typeof mountBadge>>
const badgeOf = async (ui: Badge): Promise<{ text: string | undefined; color: unknown }> => ({
  text: (await ui.find({ key: 'spare10' }))?.text,
  color: (await ui.find({ type: 'Text', text: /spare10/ }))?.props.color,
})

test('-p default off: inside the reserve everything runs, nothing asks, the seed is still written', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], agents: ['a1'] })
  await begin($, w)
  const out = await Promise.all([bash($), bash($, 'a1'), bash($, 'fork-1')])
  expect(out.map((r) => r.result)).toEqual(['ran', 'ran', 'ran'])
  expect(out.map((r) => r.deny)).toEqual([undefined, undefined, undefined])
  expect(out.map((r) => r.context)).toEqual([undefined, undefined, undefined]) // off never tells
  expect((await drain($, step(undefined, 'T1'))).text).toBe('hi')
  expect((await drain($, step('a1', 'A1'))).text).toBe('hi')
  expect(w.requests).toBe(2)
  expect(await $.prompt.submit(typed('go', 'sdk'))).toMatchObject({ text: 'go' })
  expect(await $.prompt.submit(typed('typed', 'composer'))).toMatchObject({ text: 'typed' })
  expect(w.prompts).toHaveLength(2)
  expect(w.asked).toEqual([])
  expect(w.parkCalls).toBe(0)
  expect(w.aborts).toEqual([])
  expect(w.store.has('seed')).toBe(false) // never written on the gate's path (6.3)
  await $.session.measure(measure(93))
  await w.clock.settle()
  expect(w.store.get('seed')).toEqual({ pct: 93, resetsAtMs: RESET_MS })
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(debug(w)).toEqual([UNATTENDED(93, 'off')]) // once per window end (R9)
  expect(transcript(w)).toEqual([])
})

test('-p stop: deny with the resume id, no request', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], agents: ['a1'], env: { SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  const out = await Promise.all([bash($), bash($, 'a1')])
  expect(out.map((r) => r.deny)).toEqual([HEADLESS(93), HEADLESS(93)])
  expect(w.ran).toEqual([])
  const main = await drain($, step(undefined, 'T1'))
  expect(main.text).toBe(HEADLESS(93))
  const sub = await drain($, step('a1', 'A1'))
  expect(sub.text).toBe(HEADLESS(93))
  expect(w.requests).toBe(0)
  await w.clock.settle()
  expect(w.aborts).toEqual([]) // the first refusal stays the run's final answer (4.7)
  await drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(w.aborts).toEqual(['T1']) // a second refused step of the same turn ends it
  expect(w.requests).toBe(0)
  // Prompts enter (row 5): the run's own and a typed one
  expect(await $.prompt.submit(typed('next', 'sdk'))).toMatchObject({ text: 'next' })
  expect(await $.prompt.submit(typed('typed', 'composer'))).toMatchObject({ text: 'typed' })
  expect(w.prompts).toHaveLength(2)
  expect(w.asked).toEqual([])
  expect(w.parkCalls).toBe(0)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined() // a policy refusal records no stop
  expect(debug(w).filter((t) => t.startsWith('spare10: unattended run'))).toEqual([UNATTENDED(93, 'stop')])
})

test('-p stop: an engine fork passes, and a workflow agent that stepped is refused', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  expect((await bash($, 'fork-1')).result).toBe('ran') // unlisted and never stepped: an engine fork (G8)
  expect((await drain($, step('wf-1', 'W1'))).text).toBe(HEADLESS(93))
  expect((await bash($, 'wf-1')).deny).toBe(HEADLESS(93))
  expect(w.ran).toEqual(['Bash:fork-1'])
  expect(w.requests).toBe(0)
})

test('-p prompt: tools run, each loop told once, never blocks', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], agents: ['a1'], env: { SPARE10_HEADLESS: 'prompt' } })
  await begin($, w)
  const first = await bash($)
  expect(first.result).toBe('ran')
  expect(first.context).toEqual([TELL(93)]) // no User instructions paragraph without a pause prompt
  const again = await bash($)
  expect(again.result).toBe('ran')
  expect(again.context).toBeUndefined()
  const sub = await bash($, 'a1')
  expect(sub.context).toEqual([TELL(93)])
  expect((await bash($, 'a1')).context).toBeUndefined()
  const fork = await bash($, 'fork-1') // an unlisted id is its own key (5.1)
  expect(fork.context).toEqual([TELL(93)])
  expect(w.ran).toEqual(['Bash:main', 'Bash:main', 'Bash:a1', 'Bash:a1', 'Bash:fork-1'])
  expect((await drain($, step(undefined, 'T1'))).text).toBe('hi')
  expect((await drain($, step('a1', 'A1'))).text).toBe('hi')
  expect(w.requests).toBe(2)
  expect(await $.prompt.submit(typed('next', 'sdk'))).toMatchObject({ text: 'next' })
  expect(w.asked).toEqual([])
  expect(w.parkCalls).toBe(0)
  expect(w.aborts).toEqual([])
  await w.clock.settle()
  const d = debug(w)
  expect(count(d, 'spare10: told S1:main')).toBe(1)
  expect(count(d, 'spare10: told S1:a1')).toBe(1)
  expect(count(d, 'spare10: told S1:fork-1')).toBe(1)
  expect(count(d, UNATTENDED(93, 'prompt'))).toBe(1)
  expect(count(transcript(w), TOLD_NOTICE)).toBe(1)
})

test('-p prompt with a pause prompt carries the User instructions and still never asks a typed prompt', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'prompt', SPARE10_PAUSE_PROMPT: 'Commit and stop.' } })
  await begin($, w)
  expect((await bash($)).context).toEqual([TELL(93, 'Commit and stop.')])
  expect(await $.prompt.submit(typed('typed', 'composer'))).toMatchObject({ text: 'typed' }) // row 6 before row 8
  expect((await drain($, step())).text).toBe('hi')
  expect(w.asked).toEqual([])
  expect(w.requests).toBe(1)
})

test('-p with a seed trips before the first response', async ($, on) => {
  const w = world(on, { surfaces: [], env: { SPARE10_HEADLESS: 'stop' }, store: { seed: { pct: 95, resetsAtMs: RESET_MS } } })
  await begin($, w)
  expect((await bash($)).deny).toBe(HEADLESS(95))
  expect((await drain($, step(undefined, 'T1'))).text).toBe(HEADLESS(95))
  expect(w.requests).toBe(0)
  expect(w.ran).toEqual([])
  const lines = await report($)
  expect(lines.some((l) => l.startsWith(`  · reading        seed from another session · ${pf(95)} (in 3 h`))).toBe(true)
})

test('-p ignores a seed whose window has reset', async ($, on) => {
  const w = world(on, { surfaces: [], env: { SPARE10_HEADLESS: 'stop' }, store: { seed: { pct: 95, resetsAtMs: T0 - 60_000 } } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(w.requests).toBe(1)
})

test('-p ignores a seed that lies more than one window ahead', async ($, on) => {
  const w = world(on, { surfaces: [], env: { SPARE10_HEADLESS: 'stop' }, store: { seed: { pct: 95, resetsAtMs: T0 + 6 * HOUR } } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(w.requests).toBe(1)
})

test('-p SPARE10_SIMULATE=95 trips a run with no reading, with a five-hour test window', async ($, on) => {
  const w = world(on, { surfaces: [], env: { SPARE10_HEADLESS: 'stop', SPARE10_SIMULATE: '95' } })
  await begin($, w)
  const end = T0 + TEST_WINDOW
  expect((await bash($)).deny).toBe(HEADLESS(95, 'S1', end))
  expect((await drain($, step())).text).toBe(HEADLESS(95, 'S1', end))
  expect(w.requests).toBe(0)
  const lines = await report($)
  expect(lines.some((l) => l.startsWith(`  · reading        test reading · ${pf(95, end)}`))).toBe(true)
  const ui = await mountBadge($)
  expect(await badgeOf(ui)).toEqual({ text: ' ⚠ spare10 (test): in the reserve', color: 'warning' })
  await ui.unmount()
})

test('before session.start, attendance comes from the surfaces', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop' } })
  // no session.start yet: a gated event raced a reload (9.1)
  expect((await bash($)).deny).toBe(HEADLESS(93))
  expect((await drain($, step())).text).toBe(HEADLESS(93))
  expect(w.asked).toEqual([])
  expect(w.parkCalls).toBe(0)
  expect(w.requests).toBe(0)
})

test('before session.start, a terminal in the surfaces is attended: the call is held and asks', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: ['terminal'], env: { SPARE10_HEADLESS: 'stop' } })
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.asked[0]?.question).toBe(LOOP_QUESTION(93))
  expect(w.ran).toEqual([])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  expect(debug(w).some((t) => t.startsWith('spare10: unattended run'))).toBe(false)
})

test('once session.start ran, its answer wins over the surfaces list', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: ['terminal'], env: { SPARE10_HEADLESS: 'stop' } })
  // A desktop or IDE host through the SDK starts with isInteractive false and no surface (9.5)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  expect((await bash($)).deny).toBe(HEADLESS(93))
  expect(w.asked).toEqual([])
  expect(w.parkCalls).toBe(0)
})

test('an attended start stays attended when the surfaces list empties', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: ['terminal'], env: { SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  w.surfaces = []
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

test('an attended session with the same reading is the only one that asks', async ($, on) => {
  const w = world(on, { pct: 93, agents: ['a1'], env: { SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  const held = [bash($), bash($, 'a1')]
  const req = drain($, step('a1', 'A1'))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.asked[0]).toEqual({ question: LOOP_QUESTION(93), header: 'spare10', labels: ['Stop here', 'Resume'] })
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  w.release('Resume')
  const out = await Promise.all(held)
  expect(out.map((r) => r.result)).toEqual(['ran', 'ran'])
  expect(out.map((r) => r.deny)).toEqual([undefined, undefined]) // the headless policy never applies here
  expect((await req).text).toBe('hi')
  expect(debug(w).some((t) => t.startsWith('spare10: unattended run'))).toBe(false)
  expect(w.env.get('SPARE10_HEADLESS')).toBe('stop') // a set value is left alone (B16)
  const lines = await report($)
  expect(lines).toContain('  · guarded        yes (scope all)')
  expect(lines).toContain('  · claude -p      runs started here: stop')
  expect(lines.some((l) => l.startsWith('  · unattended'))).toBe(false)
})

test('an attended session with default off gives its children SPARE10_HEADLESS=stop', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  expect(w.env.get('SPARE10_HEADLESS')).toBe('stop') // B16
  expect(await report($)).toContain('  · claude -p      runs started here: stop')
})

test('a -p run gives its children no SPARE10_HEADLESS', async ($, on) => {
  const w = world(on, { pct: 50, surfaces: [] })
  await begin($, w)
  expect(w.env.get('SPARE10_HEADLESS')).toBeUndefined() // only a guarded session sets it (B16)
  expect(await report($)).toContain('  · unattended     off (from /config)')
})

test('an attended session that is not enabled gives its children no SPARE10_HEADLESS', async ($, on) => {
  const w = world(on, { pct: 50, env: { SPARE10: 'off' } })
  await begin($, w)
  expect(w.env.get('SPARE10_HEADLESS')).toBeUndefined() // enabled and attended only (R2, B16)
})

test('an unattended run logs no start-up checks', async ($, on) => {
  const w = world(on, {
    pct: 50,
    surfaces: [],
    env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', CLAUDE_AFK_TIMEOUT_MS: '60000' },
    settings: { merged: { askUserQuestionTimeout: 30 } },
  })
  await begin($, w)
  await w.clock.settle()
  const all = w.logs.map((l) => l.text)
  expect(all.some((t) => t.startsWith(B28))).toBe(false)
  expect(all.some((t) => t.startsWith(B29))).toBe(false)
  expect(w.env.get('SPARE10_HEADLESS')).toBeUndefined()
})

test('a bad SPARE10_HEADLESS is ignored with the B27 warning, and the run keeps the option', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'halt' } })
  await begin($, w)
  await w.clock.settle()
  expect(w.logs.map((l) => l.text)).toContain('SPARE10_HEADLESS="halt" is not off, prompt or stop. spare10 uses off.')
  expect((await bash($)).result).toBe('ran')
  expect(await report($)).toContain('  · unattended     off (from /config)')
})

test('SPARE10_HEADLESS is read trimmed and in any case', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: ' Stop ' } })
  await begin($, w)
  expect((await bash($)).deny).toBe(HEADLESS(93))
  expect(await report($)).toContain('  · unattended     stop (from SPARE10_HEADLESS)')
  expect(w.logs.some((l) => l.text.startsWith('SPARE10_HEADLESS='))).toBe(false)
})

test('the debug line comes once per window end, and again in a new window', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  await bash($)
  await drain($, step(undefined, 'T1'))
  await bash($)
  expect(debug(w).filter((t) => t.startsWith('spare10: unattended run'))).toEqual([UNATTENDED(93, 'stop')])
  await w.clock.set(RESET_MS + 60_000)
  w.pct = 95
  w.resetsAt = LATER
  expect((await bash($)).deny).toBe(HEADLESS(95, 'S1', LATER_MS))
  await bash($)
  expect(debug(w).filter((t) => t.startsWith('spare10: unattended run'))).toEqual([UNATTENDED(93, 'stop'), UNATTENDED(95, 'stop', LATER_MS)])
})

test('a -p child that inherits consent for this window runs through its stop policy', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop', SPARE10_CONSENT: RESETS } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(w.requests).toBe(1)
})

test('a -p child takes the consent that the session which started it stamped with its own id', async ($, on) => {
  // 9.3: an attended session takes only its own stamp, but a nested claude -p follows its parent.
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop', SPARE10_CONSENT: `S0 ${RESETS}` } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(w.requests).toBe(1)
})

test('consent for an earlier window or a far later one does not stop the policy', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop', SPARE10_CONSENT: '2026-09-24T11:00:00.000Z' } })
  await begin($, w)
  expect((await bash($)).deny).toBe(HEADLESS(93))
  w.env.set('SPARE10_CONSENT', LATER) // more than one window ahead (B30)
  expect((await bash($)).deny).toBe(HEADLESS(93))
  expect((await drain($, step())).text).toBe(HEADLESS(93))
  expect(w.requests).toBe(0)
})

test('a -p run inside the reserve reports its policy under /spare10', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  const lines = await report($)
  expect(lines).toContain('  ⚠ tripped        unattended run, policy stop.')
  expect(lines).toContain('  · at the reserve unattended policy stop')
  expect(lines).toContain('  · guarded        no: this session is unattended.')
  expect(lines).toContain('  · unattended     stop (from SPARE10_HEADLESS)')
  expect(lines.some((l) => l.startsWith(`  · reading        live · ${pf(93)} (in 3 h`))).toBe(true)
  expect(lines.some((l) => l.startsWith('  · claude -p'))).toBe(false) // attended session only
  expect(w.asked).toEqual([])
})

test('a -p run below the reserve is armed and names its policy', async ($, on) => {
  const w = world(on, { pct: 50, surfaces: [] })
  await begin($, w)
  const lines = await report($)
  expect(lines).toContain('  ● armed          spare10 steps in at 90% used.')
  expect(lines).toContain('  · at the reserve unattended policy off')
  expect(lines).toContain('  · guarded        no: this session is unattended.')
  expect((await bash($)).result).toBe('ran')
  expect(debug(w).some((t) => t.startsWith('spare10: unattended run'))).toBe(false) // only inside the reserve
})

test('-p prompt: the phase is told once a loop was told, and the badge shows it', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], agents: ['a1'], env: { SPARE10_HEADLESS: 'prompt' } })
  await begin($, w)
  expect(await report($)).toContain('  ⚠ tripped        unattended run, policy prompt.')
  await bash($)
  await bash($, 'a1')
  expect(await report($)).toContain('  ⏸ told           the wind-down went to 2 agent(s).')
  const ui = await mountBadge($)
  expect(await badgeOf(ui)).toEqual({ text: ' ⏸ spare10', color: 'warning' })
  await ui.unmount()
})

test('an unattended run in the reserve shows the reserve badge and does not pulse', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  await bash($)
  const ui = await mountBadge($)
  await w.clock.settle()
  expect(await badgeOf(ui)).toEqual({ text: ' ⚠ spare10: in the reserve', color: 'warning' })
  const before = w.invalidations
  await w.clock.advance(3000)
  expect(w.invalidations).toBe(before)
  expect(await badgeOf(ui)).toEqual({ text: ' ⚠ spare10: in the reserve', color: 'warning' })
  await ui.unmount()
})

test('/spare10 resume and stop in an unattended run answer that the run is not guarded', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  expect((await $.command.run(cmd('resume'))).text).toBe(NOT_GUARDED)
  expect((await $.command.run(cmd('stop'))).text).toBe(NOT_GUARDED)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect((await bash($)).deny).toBe(HEADLESS(93)) // the policy still applies
})

test('a run that is not enabled ignores the headless policy: SPARE10=off passes everything and shows off', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], agents: ['a1'], env: { SPARE10: 'off', SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  const out = await Promise.all([bash($), bash($, 'a1')])
  expect(out.map((r) => r.result)).toEqual(['ran', 'ran'])
  expect(out.map((r) => r.context)).toEqual([undefined, undefined])
  expect((await drain($, step(undefined, 'T1'))).text).toBe('hi')
  expect(w.requests).toBe(1)
  expect(w.asked).toEqual([])
  expect(w.aborts).toEqual([])
  await $.session.measure(measure(93))
  await w.clock.settle()
  expect(w.store.get('seed')).toEqual({ pct: 93, resetsAtMs: RESET_MS }) // it still senses and seeds (1.2)
  const lines = await report($)
  expect(lines).toContain('  ○ off            spare10 only watches in this run.')
  expect(lines).toContain('  · guarded        no: SPARE10=off. spare10 only watches.')
  const ui = await mountBadge($)
  expect(await badgeOf(ui)).toEqual({ text: ' ○ spare10 off', color: 'inactive' })
  await ui.unmount()
})

test('a -p run that is not enabled also ignores the prompt policy', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10: 'off', SPARE10_HEADLESS: 'prompt' } })
  await begin($, w)
  expect((await bash($)).context).toBeUndefined()
  expect(debug(w).some((t) => t.startsWith('spare10: told'))).toBe(false)
})

test('SPARE10=on in an unattended run follows the headless policy', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10: 'on', SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  expect((await bash($)).deny).toBe(HEADLESS(93))
  expect((await drain($, step())).text).toBe(HEADLESS(93))
  expect(w.asked).toEqual([])
  expect(w.requests).toBe(0)
  expect(await report($)).toContain('  · guarded        no: this session is unattended.')
})

test('a sensor failure passes an unattended stop run', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop' }, usageFails: true })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(w.requests).toBe(1)
})

test('-p stop: a refused step yields the text first, then the end of the turn', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  const r = await drain($, step(undefined, 'T1'))
  expect(r.chunks[0]).toEqual({ kind: 'text', index: 0, text: HEADLESS(93) })
  expect(r.chunks[r.chunks.length - 1]).toMatchObject({ kind: 'stop', stopReason: 'end_turn' })
  expect(w.requests).toBe(0)
})

test('an unreadable consent does not stop the unattended stop policy', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop', SPARE10_CONSENT: RESETS }, envGetFails: ['SPARE10_CONSENT'] })
  await begin($, w)
  expect((await bash($)).deny).toBe(HEADLESS(93))
  expect((await drain($, step())).text).toBe(HEADLESS(93))
  expect(w.requests).toBe(0)
})

test('a stopped value in the env never stops an unattended off run', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_STOPPED: `S1 ${RESET_MS} ${T0}` } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(w.requests).toBe(1)
  expect(await report($)).toContain('  ⚠ tripped        unattended run, policy off.') // stopped needs attended (3.1)
})

test('a pause prompt alone does not make an unattended off run tell', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_PAUSE_PROMPT: 'Commit and stop.' } })
  await begin($, w)
  const r = await bash($)
  expect(r.result).toBe('ran')
  expect(r.context).toBeUndefined()
  expect(await $.prompt.submit(typed('typed', 'composer'))).toMatchObject({ text: 'typed' })
  expect(w.asked).toEqual([])
  expect(debug(w).some((t) => t.startsWith('spare10: told'))).toBe(false)
  expect(count(debug(w), UNATTENDED(93, 'off'))).toBe(1)
})

test('-p prompt: nothing rides a deny, and the loop is told on its next result', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'prompt' }, core: 'deny' })
  await begin($, w)
  const denied = await bash($)
  expect(denied.deny).toBe('no (a permission rule)')
  expect(denied.context).toBeUndefined()
  w.core = 'ran'
  expect((await bash($)).context).toEqual([TELL(93)])
})

test('-p prompt: consent for this window suppresses every tell', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], agents: ['a1'], env: { SPARE10_HEADLESS: 'prompt', SPARE10_CONSENT: RESETS } })
  await begin($, w)
  expect((await bash($)).context).toBeUndefined()
  expect((await bash($, 'a1')).context).toBeUndefined()
  expect(debug(w).some((t) => t.startsWith('spare10: told'))).toBe(false)
  expect(count(transcript(w), TOLD_NOTICE)).toBe(0)
})

test('-p prompt: a new window tells every loop again, with its own notice', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'prompt' } })
  await begin($, w)
  expect((await bash($)).context).toEqual([TELL(93)])
  expect((await bash($)).context).toBeUndefined()
  await w.clock.set(RESET_MS + 60_000)
  w.resetsAt = LATER
  const next = await bash($)
  expect(next.context).toEqual([
    `spare10 budget guard. You have reached the safe usage limit for this session (${mf(93, LATER_MS)}). Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.`,
  ])
  expect((await bash($)).context).toBeUndefined()
  await w.clock.settle()
  expect(count(debug(w), 'spare10: told S1:main')).toBe(2)
  expect(count(transcript(w), TOLD_NOTICE)).toBe(2)
  expect(debug(w).filter((t) => t.startsWith('spare10: unattended run'))).toEqual([UNATTENDED(93, 'prompt'), UNATTENDED(93, 'prompt', LATER_MS)])
})

test('a reading without resetsAt keeps one fallback window end per episode (R11)', async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: null, surfaces: [], env: { SPARE10_HEADLESS: 'prompt' } })
  await begin($, w)
  const unknown = 'into your 10% reserve · 7% of quota left · resets at an unknown time'
  const tell = `spare10 budget guard. You have reached the safe usage limit for this session (${unknown}). Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.`
  const note = 'spare10: unattended run inside the reserve (93% used · 7% left · resets at an unknown time), policy prompt.'
  expect((await bash($)).context).toEqual([tell])
  await w.clock.advance(60_000)
  expect((await bash($)).context).toBeUndefined() // the same window end a minute later: already told
  await w.clock.advance(20 * 60_000)
  expect((await bash($)).context).toBeUndefined()
  await w.clock.settle()
  expect(count(debug(w), note)).toBe(1)
  expect(count(transcript(w), TOLD_NOTICE)).toBe(1)
  await w.clock.advance(HOUR) // the fallback end has passed: a new episode
  expect((await bash($)).context).toEqual([tell])
  await w.clock.settle()
  expect(count(debug(w), note)).toBe(2)
})

test('-p stop without resetsAt names an unknown reset time and a stable window end', async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: null, surfaces: [], env: { SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  const text =
    'spare10 stopped this unattended run at the quota reserve (into your 10% reserve · 7% of quota left · resets at an unknown time). No further model requests were sent. To pick it up later: claude --resume S1'
  expect((await bash($)).deny).toBe(text)
  await w.clock.advance(60_000)
  expect((await drain($, step())).text).toBe(text)
  await w.clock.settle()
  expect(debug(w).filter((t) => t.startsWith('spare10: unattended run'))).toHaveLength(1)
})

test('an attended session ignores the prompt policy too: it holds, and nothing is told', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_HEADLESS: 'prompt' }, answer: 'Resume' })
  await begin($, w)
  const r = await bash($)
  expect(r.result).toBe('ran')
  expect(r.context).toBeUndefined()
  expect(w.asked).toHaveLength(1)
  expect(debug(w).some((t) => t.startsWith('spare10: told'))).toBe(false)
})

test('an unattended run shows the consented phase while inherited consent covers the window', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop', SPARE10_CONSENT: RESETS } })
  await begin($, w)
  const lines = await report($)
  expect(lines).toContain(`  ⨯ consented      you chose to continue. spare10 is quiet until ${clockOf(RESET_MS)}.`)
  expect(lines).toContain(`  · consent        until ${clockOf(RESET_MS)} (you chose to continue)`)
})

test('/spare10 warns when an inherited SPARE10_CONSENT lies beyond this window (B30, R13)', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop', SPARE10_CONSENT: LATER } })
  await begin($, w)
  expect((await bash($)).deny).toBe(HEADLESS(93))
  const lines = await report($)
  expect(lines).toContain(`  ⚠ SPARE10_CONSENT="${LATER}" names a time after this 5-hour window. spare10 ignores it.`)
  expect(lines).toContain('  · consent        none')
})

test('in a -p run, /spare10 resume and stop from the run itself are refused as not typed by the person', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  expect((await $.command.run(cmd('resume', 'sdk'))).text).toBe('only you can run /spare10 resume. Nothing changed.')
  expect((await $.command.run(cmd('stop', 'sdk'))).text).toBe('only you can run /spare10 stop. Nothing changed.')
  expect((await $.command.run(cmd('', 'sdk'))).text).toContain('  ⚠ tripped        unattended run, policy stop.') // status from any origin
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
})

test('-p prompt: a blank pause prompt leaves out the User instructions, and text is kept verbatim', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], agents: ['a1'], env: { SPARE10_HEADLESS: 'prompt', SPARE10_PAUSE_PROMPT: '   ' } })
  await begin($, w)
  expect((await bash($)).context).toEqual([TELL(93)])
  expect(w.asked).toEqual([])
})

test('-p prompt: a multi-line pause prompt is passed on verbatim', async ($, on) => {
  const text = 'Commit your work.\nThen stop.'
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'prompt', SPARE10_PAUSE_PROMPT: text } })
  await begin($, w)
  expect((await bash($)).context).toEqual([TELL(93, text)])
})

test('-p stop: the resume command names the current session id', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  expect((await bash($)).deny).toBe(HEADLESS(93, 'S1'))
  await clear($, w, 'S2') // a new conversation in the same process (/clear), no session.start follows
  expect((await bash($)).deny).toBe(HEADLESS(93, 'S2'))
  expect((await drain($, step())).text).toBe(HEADLESS(93, 'S2'))
})

test('prompt policy: after /clear in an unattended host, every loop of the new conversation is told again', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'prompt' } })
  await begin($, w)
  expect((await bash($)).context).toEqual([TELL(93)])
  expect((await bash($)).context).toBeUndefined()
  await clear($, w, 'S2') // /clear: session.end fires, no session.start follows (3.6)
  expect((await bash($)).context).toEqual([TELL(93)])
  await w.clock.settle()
  expect(count(debug(w), 'spare10: told S2:main')).toBe(1)
})

test('/spare10 simulate works in an unattended run and only raises the reading', async ($, on) => {
  const w = world(on, { pct: 50, surfaces: [], env: { SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect((await $.command.run(cmd('simulate 95'))).text).toBe(
    `test reading set to 95% used, resets ${clockOf(RESET_MS)}. It can only raise the real reading. Run /spare10 simulate off to clear it.`,
  )
  expect((await bash($)).deny).toBe(HEADLESS(95))
  expect((await $.command.run(cmd('simulate off'))).text).toBe('test reading cleared. Consent and stop for this window are cleared too.')
  expect((await bash($)).result).toBe('ran')
})
