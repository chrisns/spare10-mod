import { test, expect } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import { LATER, MARGIN, MIN, RESETS, SOON, T0, TEST_MARGIN, TICK, above, bash, begin, cmd, drain, measure, pastDue, step, typed, world } from '../helpers/world.ts'

// Unattended wait through the engine (design 0.2: 8.3 headless.test.ts additions, B36, B37, 5.3, 5.5).
// Every expected text is spelled out from design section 2 here, not taken from hooks/core/text.ts,
// so a drift in the texts or the policy fails a test.

const RESET_MS = Date.parse(RESETS)
const LATER_MS = Date.parse(LATER)
const WAIT = { SPARE10_HEADLESS: 'wait' }

const two = (n: number): string => String(n).padStart(2, '0')
// {clock} of a 5-hour time: HH:MM, 24-hour, local time (the kit runs in the machine's time zone)
const clockOf = (ms: number): string => {
  const d = new Date(ms)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}
const num = (n: number): string => String(Math.round(n * 10) / 10)
const left = (used: number): string => num(Math.max(0, 100 - used))
const pf = (used: number, resetMs = RESET_MS): string => `${num(used)}% used · ${left(used)}% left · resets ${clockOf(resetMs)}`
const mf = (used: number, resetMs = RESET_MS): string =>
  `into your 10% reserve · ${left(used)}% of quota left · resets ${clockOf(resetMs)}`

const HEADLESS = (used: number, sessionId = 'S1', resetMs = RESET_MS): string =>
  `spare10 stopped this unattended run at the quota reserve (${mf(used, resetMs)}). No further model requests were sent. To pick it up later: claude --resume ${sessionId}`
const HEADLESS_GENERIC = 'spare10 stopped this unattended run at the quota reserve. No further model requests were sent.'
const UNATTENDED = (used: number, resetMs = RESET_MS): string =>
  `spare10: unattended run inside the reserve (${pf(used, resetMs)}), policy wait.`
const RESET_CONTINUES = 'the 5-hour window reset. Held work continues.'
const TEST_CONTINUES = 'the test window ended. Held work continues.'
const RESERVE_PHASE = '  ⚠ tripped        unattended run, policy wait.'
const HELD_PHASE = (atMs: number): string => `${RESERVE_PHASE} Held work continues after ${clockOf(atMs)}.`

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

/**
 * A prepend plugin that holds one $.clock.now call of spare10 on a carrier nobody wakes: the first one
 * after a spare10 session.usage read, once KIT_STALL is 'armed'. A $.clock call spends the caller's
 * budget (dts HookBudget), so the hook that made it overruns after 10 s of real time and its .catch
 * answers. The world's env carries the switch, since an inline plugin sees no variable of this file.
 */
const stallNow: Plugin = {
  name: 'stall-now',
  tier: 'prepend',
  register: (on) => {
    on('session.usage', async ($, e, next) => {
      if (next.origin.plugin === 'spare10' && (await $.env.get('KIT_STALL')) === 'armed') await $.env.set('KIT_STALL', 'usage')
      return next(e)
    })
    on('clock.now', async ($, e, next) => {
      if (next.origin.plugin === 'spare10' && (await $.env.get('KIT_STALL')) === 'usage') {
        await $.env.set('KIT_STALL', 'held')
        await $.spare10.park({ waiter: 'kit-stall' }).catch(() => undefined)
      }
      return next(e)
    })
  },
}

test('-p wait holds a tool call and a step with no dialog, and they continue at the reset', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], agents: ['a1'], env: WAIT })
  await begin($, w)
  const held = [bash($), bash($, 'a1')]
  const req = drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(w.asked).toEqual([]) // no dialog: nobody can answer (5.5)
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  expect(w.parkCalls).toBeGreaterThan(0) // held on the carrier, not refused
  await w.clock.set(RESET_MS - MIN)
  expect(w.ran).toEqual([])
  await w.clock.set(RESET_MS + MARGIN - TICK) // past the reset, inside the 5-minute margin (4.8)
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  await pastDue(w, RESETS)
  const out = await Promise.all(held)
  expect(out.map((r) => r.result)).toEqual(['ran', 'ran'])
  expect(out.map((r) => r.deny)).toEqual([undefined, undefined])
  expect((await req).text).toBe('hi')
  expect([...w.ran].sort()).toEqual(['Bash:a1', 'Bash:main'])
  expect(w.requests).toBe(1)
  await w.clock.settle()
  expect(w.asked).toEqual([])
  expect(w.dialogAborted).toBe('no')
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // the reset writes no consent (B33)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect(count(transcript(w), RESET_CONTINUES)).toBe(1)
})

test('-p wait lets a prompt enter, and its step holds', async ($, on) => {
  // autoResume off changes nothing here: wait continues at the reset whatever it says (B36)
  const w = world(on, { pct: 93, surfaces: [], env: { ...WAIT, SPARE10_AUTO_RESUME: 'off' } })
  await begin($, w)
  expect(await $.prompt.submit(typed('go', 'sdk'))).toMatchObject({ text: 'go' }) // the run's own prompt
  expect(await $.prompt.submit(typed('typed', 'composer'))).toMatchObject({ text: 'typed' }) // row 6a: prompt passes
  expect(w.prompts.map((p) => p.text)).toEqual(['go', 'typed'])
  const req = drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(w.requests).toBe(0)
  expect(w.asked).toEqual([])
  expect(w.parkCalls).toBeGreaterThan(0)
  await pastDue(w, RESETS)
  expect((await req).text).toBe('hi')
  expect(w.requests).toBe(1)
})

test('-p wait with SPARE10_SIMULATE="95 in 2m" continues after the test window', async ($, on) => {
  const w = world(on, { surfaces: [], env: { ...WAIT, SPARE10_SIMULATE: '95 in 2m' } })
  await begin($, w)
  const end = T0 + 2 * MIN // `in` counts from the first gated event (2.9)
  const held = bash($)
  const req = drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  expect(w.asked).toEqual([])
  expect(debug(w)).toContain(UNATTENDED(95, end))
  await w.clock.set(end + TEST_MARGIN - TICK) // the test window ended, the 60 s margin has not passed (4.8)
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  await pastDue(w, new Date(end).toISOString(), TEST_MARGIN)
  expect((await held).result).toBe('ran')
  expect((await req).text).toBe('hi')
  expect(w.requests).toBe(1)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(count(transcript(w), TEST_CONTINUES)).toBe(1)
})

test('-p wait: a seed alone does not hold, the first step goes, and the next one holds on the live reading', async ($, on) => {
  // -p has no start-up quota read: the first events see only the seed of another session (B36)
  const w = world(on, { surfaces: [], env: WAIT, store: { seed: { pct: 95, resetsAtMs: RESET_MS } } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran') // row 6a: seedOnly passes (trip)
  expect((await drain($, step(undefined, 'T1'))).text).toBe('hi')
  expect(w.requests).toBe(1)
  expect(w.parkCalls).toBe(0)
  // The response of that request brings a live reading, still inside the reserve
  w.pct = 93
  await $.session.measure(measure(93))
  const req = drain($, step(undefined, 'T2'))
  await w.clock.settle()
  expect(w.requests).toBe(1)
  expect(w.asked).toEqual([])
  expect(w.parkCalls).toBeGreaterThan(0)
  const held = bash($)
  await w.clock.settle()
  expect(w.ran).toEqual(['Bash:main']) // only the call that went on the seed
  await pastDue(w, RESETS)
  expect((await req).text).toBe('hi')
  expect((await held).result).toBe('ran')
  expect(w.requests).toBe(2)
})

test('-p wait: an inherited consent for this window passes', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], agents: ['a1'], env: { ...WAIT, SPARE10_CONSENT: RESETS } })
  await begin($, w)
  const out = await Promise.all([bash($), bash($, 'a1')])
  expect(out.map((r) => r.result)).toEqual(['ran', 'ran'])
  expect((await drain($, step(undefined, 'T1'))).text).toBe('hi')
  expect(w.requests).toBe(1)
  expect(w.parkCalls).toBe(0)
  expect(w.asked).toEqual([])
  expect(await report($)).toContain(`  ⨯ consented      you chose to continue. spare10 is quiet until ${clockOf(RESET_MS)}.`)
})

test(
  '-p wait: a carrier that fails closed denies with the HEADLESS text, and the .catch with HEADLESS_GENERIC',
  { plugins: [stallNow], timeoutMs: 30_000 },
  async ($, on) => {
    const w = world(on, { pct: 93, surfaces: [], env: WAIT, parkRejects: 6 })
    await begin($, w)
    // Three fast rejections in a row: the noun is gone, the hold fails closed (5.3, B36)
    expect((await bash($)).deny).toBe(HEADLESS(93))
    expect(w.parkCalls).toBe(3)
    expect((await drain($, step(undefined, 'T1'))).text).toBe(HEADLESS(93))
    expect(w.parkCalls).toBe(6)
    expect(w.ran).toEqual([])
    expect(w.requests).toBe(0)
    await w.clock.settle()
    expect(w.env.get('SPARE10_STOPPED')).toBeUndefined() // a silent hold writes no stop (5.5)
    expect(w.asked).toEqual([])
    // A hook failure after the hold decision: the reading leaves the reserve (again via quota), and the
    // next round's sense overruns the budget. HOLDING has the call, so the .catch refuses (5.3).
    const held = bash($)
    await w.clock.settle()
    expect(w.ran).toEqual([])
    w.pct = 50
    w.env.set('KIT_STALL', 'armed')
    await w.clock.advance(MIN) // the waiter's once-a-minute check (B33)
    expect((await held).deny).toBe(HEADLESS_GENERIC)
    expect(w.env.get('KIT_STALL')).toBe('held') // the stall was reached, so the refusal is the .catch's
    expect(w.ran).toEqual([])
  },
)

// A held waiter across 8 h of mock time checks on every tick: allow more than the 5 s default.
test('-p wait: a lost hold with no waiter is forgotten, and the next call holds again', { plugins: [above], timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: WAIT })
  await begin($, w)
  const lost = bash($, undefined, 'abandon me')
  await w.clock.settle()
  expect(await report($)).toContain(HELD_PHASE(RESET_MS))
  await w.clock.advance(1000)
  expect((await lost).deny).toBe('a hook above settled first')
  await w.clock.settle()
  expect(await report($)).toContain(RESERVE_PHASE) // no held work: the silent question is gone (5.5)
  // A later window: a forgotten question is not joined, so the new hold ends at the new reset
  w.pct = 95
  w.resetsAt = LATER
  const held = bash($)
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.asked).toEqual([])
  expect(await report($)).toContain(HELD_PHASE(LATER_MS))
  await pastDue(w, RESETS)
  expect(w.ran).toEqual([])
  await pastDue(w, LATER)
  expect((await held).result).toBe('ran')
  expect(w.ran).toEqual(['Bash:main'])
})

test('-p wait logs the unattended debug line with policy wait', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: WAIT })
  await begin($, w)
  const held = bash($)
  const req = drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(debug(w).filter((t) => t.startsWith('spare10: unattended run'))).toEqual([UNATTENDED(93)]) // once per kind and window
  expect(transcript(w).filter((t) => t.startsWith('spare10'))).toEqual([]) // the engine adds the prefix
  await pastDue(w, RESETS)
  expect((await held).result).toBe('ran')
  expect((await req).text).toBe('hi')
  expect(debug(w).filter((t) => t.startsWith('spare10: unattended run'))).toEqual([UNATTENDED(93)])
})

test('session.end other stops the ticker, and logout keeps it', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: WAIT })
  await begin($, w)
  const first = bash($)
  await w.clock.settle()
  await $.session.end({ reason: 'logout', sessionId: w.sessionId, resume: { id: w.sessionId } })
  await pastDue(w, RESETS)
  expect((await first).result).toBe('ran') // the ticker ran on and started the check (4.2)
  expect(w.ran).toEqual(['Bash:main'])
  // A new window inside the reserve, then the run ends: no ticker is left to start the check
  w.resetsAt = LATER
  const second = bash($)
  await w.clock.settle()
  expect(w.ran).toEqual(['Bash:main'])
  await $.session.end({ reason: 'other', sessionId: w.sessionId, resume: { id: w.sessionId } })
  await pastDue(w, LATER)
  await w.clock.settle()
  expect(w.ran).toEqual(['Bash:main'])
  w.cap() // the host's carrier cycle still runs the waiter's own check (4.5)
  expect((await second).result).toBe('ran')
  expect(w.ran).toEqual(['Bash:main', 'Bash:main'])
})

test('-p wait shows the reserve phase, never asking', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: WAIT })
  await begin($, w)
  const idle = await report($)
  expect(idle).toContain(RESERVE_PHASE)
  expect(idle).toContain('  · at the reserve unattended policy wait')
  expect(idle).toContain('  · unattended     wait (from SPARE10_HEADLESS)')
  expect(idle.some((l) => l.startsWith('  · at the reset'))).toBe(false) // attended only (2.7)
  const held = bash($)
  await w.clock.settle()
  const lines = await report($)
  expect(lines).toContain(HELD_PHASE(RESET_MS))
  expect(lines.some((l) => l.startsWith('  ?'))).toBe(false)
  expect(lines.some((l) => l.includes('a question is open'))).toBe(false)
  const ui = await mountBadge($)
  await w.clock.settle()
  expect(await badgeOf(ui)).toEqual({ text: ' ⚠ spare10: in the reserve', color: 'warning' })
  await ui.unmount()
  expect(w.asked).toEqual([])
  await pastDue(w, RESETS)
  expect((await held).result).toBe('ran')
})

test('a guarded session with headless wait sets SPARE10_HEADLESS=stop for children', async ($, on) => {
  // The kit loads the manifest defaults, so wait comes by the env. The env is read once per activation
  // (D0.1 8.2): once read, the effective policy stays wait while the variable itself is gone.
  const w = world(on, { pct: 50, env: WAIT })
  expect((await bash($)).result).toBe('ran') // the first event reads the env
  w.env.delete('SPARE10_HEADLESS')
  await begin($, w)
  expect(w.env.get('SPARE10_HEADLESS')).toBe('stop') // B37: a child -p would be killed with its Bash call
  const lines = await report($)
  expect(lines).toContain('  · claude -p      runs started here: stop')
  expect(lines).toContain('  · guarded        yes (scope all)')
})

test('-p wait holds a step when a live reading gates beside a seed, and releases it at the reset', { timeoutMs: 20_000 }, async ($, on) => {
  // The weekly window rests on a seed from another session, the 5-hour window on a live reading.
  const w = world(on, { pct: 93, surfaces: [], env: WAIT, store: { 'seed-weekly': { pct: 95, resetsAtMs: Date.parse(SOON) } } })
  await begin($, w)
  const req = drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(w.requests).toBe(0) // row 6a lets a step go only when every gating kind rests on a seed
  expect(w.asked).toEqual([])
  await pastDue(w, RESETS)
  expect((await req).text).toBe('hi')
  expect(w.requests).toBe(1)
})
