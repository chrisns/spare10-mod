import { test, expect } from 'claude-code/testing'
import type { Engine, ElementQuery, FoundElement } from 'claude-code/testing'
import type { RenderSurface } from 'claude-code'
import { HOUR, LATER, OPENS, RESETS, T0, above, bash, begin, cmd, measure, real5, stopRec, typed, world } from '../helpers/world.ts'
import { atText } from '../../hooks/core/text.ts'
import type { World } from '../helpers/world.ts'

// The footer badge through the engine (design 11.4 badge.test.ts, B21, section 7). Written from the
// spec: every expected text and colour is a literal from the B21 table, drawn as ' ' + text.

type Ui = { find: (q: ElementQuery) => Promise<FoundElement | undefined>; findAll: (q: ElementQuery) => Promise<FoundElement[]> }
type Shown = { text: string | undefined; color: unknown }

const STOP_PREFIX = 'spare10: the user stopped work at the quota reserve ('
// 2.6: the clock at which spare10 continues (autoResume on). With the shipped spans that is the skip
// start, 20 min before RESETS (skip 2.6).
const AT = atText(Date.parse(OPENS), ['five_hour'])

/** Mounts the SessionMode footer site as the engine does on terminal and desktop. */
function mountBadge($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({ plugin: 'spare10', surface, component: 'SessionMode', props: { modes: ['focus'] } })
}

/** The badge as drawn: the text of the Box keyed spare10 and the colour of its one Text. */
async function badge(ui: Ui): Promise<Shown> {
  const box = await ui.find({ key: 'spare10' })
  const inner = (box?.children ?? []).find((c): c is { type: string; props?: Record<string, unknown> } =>
    typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'Text')
  return { text: box?.text, color: inner?.props?.color }
}

const shown = (text: string, color?: string): Shown => ({ text, color })

/** The props of the badge's one Text. */
async function textProps(ui: Ui): Promise<Record<string, unknown> | undefined> {
  const texts = await ui.findAll({ type: 'Text' })
  return texts[0]?.props
}

test('the footer badge draws after the engine\'s labels on terminal and desktop', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  for (const surface of ['terminal', 'desktop'] as const satisfies readonly RenderSurface[]) {
    const renders = w.renders
    const ui = await mountBadge($, surface)
    const drawn = (await ui.drawn()) as { type: string; props: Record<string, unknown>; children: unknown[] }
    expect(drawn.type).toBe('Box')
    expect(drawn.props.flexDirection).toBe('row')
    expect(drawn.children).toHaveLength(2)
    expect(drawn.children[0]).toEqual({ type: 'engine', ref: 0 }) // the engine's labels first, kept whole
    expect(drawn.children[1]).toMatchObject({ type: 'Box', props: { key: 'spare10' } })
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts).toHaveLength(1) // one Text, keyed through its Box only
    expect(texts[0]?.key).toBeUndefined()
    expect(await badge(ui)).toEqual(shown(' ● spare10', 'success'))
    expect(w.renders).toBeGreaterThan(renders) // the engine beneath drew its own labels
    await ui.unmount()
  }
})

test('phase walk: waiting, armed, tripped (pulsing), asking, stopped', async ($, on) => {
  const w = world(on)
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ⧗ spare10', 'inactive'))

  w.pct = 50
  await $.session.measure(measure(50))
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ● spare10', 'success'))

  w.pct = 93
  await $.session.measure(measure(93))
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ⚠ Pausing at next step', 'warning'))
  await w.clock.advance(1000)
  expect(await badge(ui)).toEqual(shown('   Pausing at next step', 'warning')) // glyph swapped for one space
  await w.clock.advance(1000)
  expect(await badge(ui)).toEqual(shown(' ⚠ Pausing at next step', 'warning'))

  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(await badge(ui)).toEqual(shown(` ? spare10: waiting for you until ${AT}`, 'warning'))
  const renders = w.renders
  await w.clock.advance(3000)
  expect(w.renders).toBe(renders) // only the tripped row pulses (7.2)

  w.release('Stop here')
  expect((await held).deny).toContain(STOP_PREFIX)
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(` ■ spare10: stopped until ${AT}`, 'warning'))
})

test('Resume shows the consented mark', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const ui = await mountBadge($, 'desktop')
  expect(await badge(ui)).toEqual(shown(' ⚠ Pausing at next step', 'warning'))
  const held = bash($)
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(` ? spare10: waiting for you until ${AT}`, 'warning'))
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ⨯ spare10', 'warning'))
  const renders = w.renders
  await w.clock.advance(3000)
  expect(w.renders).toBe(renders) // consented is quiet: no pulse
})

test('a Stop redraws the badge', async ($, on) => {
  const w = world(on, { pct: 93, agents: ['a1'] })
  await begin($, w)
  const ui = await mountBadge($)
  const held = [bash($), bash($, 'a1')]
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(` ? spare10: waiting for you until ${AT}`, 'warning'))
  const before = w.invalidations
  w.release('Stop here')
  for (const r of await Promise.all(held)) expect(r.deny).toContain(STOP_PREFIX)
  await w.clock.settle() // no clock move: only the Stop's own redraws can change the drawing
  expect(w.invalidations).toBeGreaterThan(before)
  expect(await badge(ui)).toEqual(shown(` ■ spare10: stopped until ${AT}`, 'warning'))
  const renders = w.renders
  await w.clock.advance(3000)
  expect(w.renders).toBe(renders) // stopped never pulses
  expect(await badge(ui)).toEqual(shown(` ■ spare10: stopped until ${AT}`, 'warning'))
})

test('the pulse redraws once a second only while tripped', async ($, on) => {
  const w = world(on, { pct: 40 })
  await begin($, w)
  const ui = await mountBadge($)
  await $.session.measure(measure(40))
  await w.clock.settle()
  const count = async () => {
    const r = w.renders
    const i = w.invalidations
    await w.clock.advance(10_000)
    return { renders: w.renders - r, invalidations: w.invalidations - i }
  }
  const armed = await count()

  w.pct = 91
  await $.session.measure(measure(91))
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ⚠ Pausing at next step', 'warning'))
  const tripped = await count()

  w.pct = 20 // a new reading below the trip point: the pulse stops
  await $.session.measure(measure(20))
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ● spare10', 'success'))
  const after = await count()

  expect({ armed, tripped, after }).toEqual({
    armed: { renders: 0, invalidations: 0 },
    tripped: { renders: 10, invalidations: 10 },
    after: { renders: 0, invalidations: 0 },
  })
})

test('a run that is not enabled shows off in the inactive colour and never pulses', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10: 'off', SPARE10_RESERVE: '40' } })
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ○ spare10 (40%) off', 'inactive'))
  const renders = w.renders
  await w.clock.advance(3000)
  expect(w.renders).toBe(renders)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(w.asked).toEqual([])
  expect(await badge(ui)).toEqual(shown(' ○ spare10 (40%) off', 'inactive'))
})

test('an unattended run that is not enabled shows off and ignores the headless policy', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10: 'off', SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ○ spare10 off', 'inactive'))
  expect((await bash($)).result).toBe('ran') // R2: not enabled passes everything
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ○ spare10 off', 'inactive'))
})

test('a blind sensor shows the plain warning, and a reading clears it', async ($, on) => {
  const w = world(on)
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ⧗ spare10', 'inactive'))
  const quiet = w.renders
  await w.clock.advance(3000)
  expect(w.renders).toBe(quiet) // waiting does not pulse
  await $.session.measure(measure()) // a billed response with no five-hour window: one miss
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ⧗ spare10', 'inactive'))
  await $.session.measure(measure())
  await w.clock.settle()
  expect(await badge(ui)).toEqual({ text: ' ⚠ spare10 quota unavailable', color: undefined })
  expect(await textProps(ui)).toEqual({}) // plain: no colour prop at all
  const renders = w.renders
  await w.clock.advance(3000)
  expect(w.renders).toBe(renders) // blind does not pulse
  w.pct = 50
  await $.session.measure(measure(50))
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ● spare10', 'success'))
})

test('a non-default reserve is spelled out in every labelled row', async ($, on) => {
  const w = world(on, { env: { SPARE10_RESERVE: '40' } })
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ⧗ spare10 (40%)', 'inactive'))
  w.pct = 59.9
  await $.session.measure(measure(59.9))
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ● spare10 (40%)', 'success'))
  w.pct = 60 // the trip point is 100 - 40
  await $.session.measure(measure(60))
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ⚠ Pausing at next step', 'warning'))
  await $.command.run(cmd('resume'))
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ⨯ spare10 (40%)', 'warning'))
  await $.command.run(cmd('stop'))
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(` ■ spare10 (40%): stopped until ${AT}`, 'warning'))
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(await badge(ui)).toEqual(shown(` ? spare10 (40%): waiting for you until ${AT}`, 'warning'))
  w.release('Stop here')
  expect(await p).toMatchObject({ drop: expect.stringContaining('spare10: not started.') })
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(` ■ spare10 (40%): stopped until ${AT}`, 'warning'))
})

test('a reserve of 10.0 is the default label', async ($, on) => {
  const w = world(on, { pct: 50, env: { SPARE10_RESERVE: '10.0' } })
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ● spare10', 'success'))
})

test('the label spells the reserve with one decimal at most', async ($, on) => {
  const w = world(on, { pct: 50, env: { SPARE10_RESERVE: '12.54' } })
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ● spare10 (12.5%)', 'success'))
})

test('tell mode winds down with a pulse, a prompt question shows asking, and a told loop shows told', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_PAUSE_PROMPT: 'Commit and stop.' } })
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ⚠ Winding down at next step', 'warning'))
  await w.clock.advance(1000)
  expect(await badge(ui)).toEqual(shown('   Winding down at next step', 'warning'))
  await w.clock.advance(1000)
  expect(await badge(ui)).toEqual(shown(' ⚠ Winding down at next step', 'warning'))

  // B13: a person prompt asks while main is untold. Stop here drops it and sets no stop.
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(await badge(ui)).toEqual(shown(` ? spare10: waiting for you until ${AT}`, 'warning'))
  w.release('Stop here')
  expect(await p).toMatchObject({ drop: expect.stringContaining('spare10: not started.') })
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ⚠ Winding down at next step', 'warning'))

  // B12: the tool runs, main is told, the badge shows told and stops pulsing.
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ⏸ spare10', 'warning'))
  const renders = w.renders
  await w.clock.advance(3000)
  expect(w.renders).toBe(renders)

  // B24: /spare10 stop sets stopped in tell mode too, and stopped ranks before told.
  await $.command.run(cmd('stop'))
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(` ■ spare10: stopped until ${AT}`, 'warning'))
})

test('an unattended run in the reserve shows the reserve row and never pulses', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ⚠ spare10: in the reserve', 'warning'))
  const renders = w.renders
  await w.clock.advance(3000)
  expect(w.renders).toBe(renders)
  expect((await bash($)).deny).toContain('spare10 stopped this unattended run at the quota reserve (')
  await w.clock.settle()
  expect(w.asked).toEqual([])
  expect(await badge(ui)).toEqual(shown(' ⚠ spare10: in the reserve', 'warning')) // stopped needs an attended run
})

test('an unattended prompt policy shows the reserve row, then told once any loop was told', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], agents: ['a1'], env: { SPARE10_HEADLESS: 'prompt' } })
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ⚠ spare10: in the reserve', 'warning'))
  expect((await bash($, 'a1')).result).toBe('ran')
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ⏸ spare10', 'warning'))
})

test('a test reading is labelled (test) while it applies, and only then', async ($, on) => {
  const w = world(on, { pct: 60 })
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ● spare10', 'success'))
  await $.command.run(cmd('simulate 50')) // lower than the live reading: it does not apply
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ● spare10', 'success'))
  await $.command.run(cmd('simulate 70'))
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ● spare10 (test)', 'success'))
  await $.command.run(cmd('simulate 95'))
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ⚠ Pausing at next step', 'warning'))
  const held = bash($)
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(` ? spare10 (test): waiting for you until ${AT}`, 'warning'))
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ⨯ spare10 (test)', 'warning'))
  await $.command.run(cmd('simulate off'))
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(await badge(ui)).toEqual(shown(' ● spare10', 'success'))
})

test('an open question keeps the asking mark while the reading drops below the trip point', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const ui = await mountBadge($)
  const held = bash($)
  await w.clock.settle()
  w.pct = 50
  await $.session.measure(measure(50))
  await w.clock.settle()
  expect(w.ran).toEqual([]) // B6: a lower reading never releases a hold
  expect(await badge(ui)).toEqual(shown(` ? spare10: waiting for you until ${AT}`, 'warning')) // R1: asking ranks before armed
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ● spare10', 'success'))
})

test('an open question keeps the asking mark past the window end, and a late Resume leaves the waiting mark', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_AUTO_RESUME: 'off' } }) // the 0.1 rows: no timed release
  await begin($, w)
  const ui = await mountBadge($)
  const held = bash($)
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ? spare10: waiting for you', 'warning'))
  w.pct = undefined // the engine drops a window once it reset
  await w.clock.set(Date.parse(RESETS) + 60_000)
  expect(w.ran).toEqual([])
  expect(await badge(ui)).toEqual(shown(' ? spare10: waiting for you', 'warning')) // R1: asking ranks before waiting
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // R10: no consent after the window end
  expect(await badge(ui)).toEqual(shown(' ⧗ spare10', 'inactive'))
})

test('a person prompt in a stopped session shows asking, and Stop here shows stopped again', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const ui = await mountBadge($)
  const held = bash($)
  await w.clock.settle()
  w.release('Stop here')
  await held
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(` ■ spare10: stopped until ${AT}`, 'warning'))
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
  expect(await badge(ui)).toEqual(shown(` ? spare10: waiting for you until ${AT}`, 'warning')) // R1, R5
  w.release('Stop here')
  expect(await p).toMatchObject({ drop: expect.stringContaining('spare10: not started.') })
  await w.clock.settle()
  expect(w.prompts).toEqual([])
  expect(await badge(ui)).toEqual(shown(` ■ spare10: stopped until ${AT}`, 'warning'))
})

test('a command that writes consent or stopped redraws the badge at once', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ⚠ Pausing at next step', 'warning'))
  const steps: Array<[string, Shown]> = [
    ['resume', shown(' ⨯ spare10', 'warning')],
    ['stop', shown(` ■ spare10: stopped until ${AT}`, 'warning')],
    ['resume', shown(' ⨯ spare10', 'warning')],
    ['stop', shown(` ■ spare10: stopped until ${AT}`, 'warning')],
  ]
  for (const [verb, want] of steps) {
    const before = w.invalidations
    await $.command.run(cmd(verb))
    await w.clock.settle() // no clock move: the pulse cannot redraw, only the command can
    expect(w.invalidations).toBeGreaterThan(before)
    expect(await badge(ui)).toEqual(want)
  }
})

test('/spare10 stop while a question is open redraws the stopped row', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const ui = await mountBadge($)
  const held = bash($)
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(` ? spare10: waiting for you until ${AT}`, 'warning'))
  await $.command.run(cmd('stop'))
  expect((await held).deny).toContain(STOP_PREFIX)
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(` ■ spare10: stopped until ${AT}`, 'warning'))
})

test('the edge timer redraws a stopped badge at the window end', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Stop here', spans: 'off' }) // the D0.2 reset timing
  const atReset = atText(Date.parse(RESETS), ['five_hour'])
  await begin($, w)
  const ui = await mountBadge($)
  expect((await bash($)).deny).toContain(STOP_PREFIX)
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(` ■ spare10: stopped until ${atReset}`, 'warning'))
  await w.clock.set(Date.parse(RESETS) - 1000)
  expect(await badge(ui)).toEqual(shown(` ■ spare10: stopped until ${atReset}`, 'warning'))
  w.pct = undefined // the engine drops a window once it reset
  const before = w.invalidations
  await w.clock.advance(2000) // no event, no pulse: only the edge timer can redraw
  expect(w.invalidations).toBeGreaterThan(before)
  expect(await badge(ui)).toEqual(shown(' ⧗ spare10', 'inactive'))
})

test('the edge timer redraws a consented badge at the window end', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Resume' })
  await begin($, w)
  const ui = await mountBadge($)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ⨯ spare10', 'warning'))
  await w.clock.set(Date.parse(RESETS) - 1000)
  expect(await badge(ui)).toEqual(shown(' ⨯ spare10', 'warning'))
  w.pct = 5 // the next window, as the engine reports it after the reset
  w.resetsAt = LATER
  const before = w.invalidations
  await w.clock.advance(2000) // no event, no pulse: only the edge timer can redraw
  expect(w.invalidations).toBeGreaterThan(before)
  expect(await badge(ui)).toEqual(shown(' ● spare10', 'success'))
})

test('a failed read draws the waiting mark, never a stale phase', async ($, on) => {
  const seed = { pct: 93, resetsAtMs: Date.parse(RESETS) }
  const w = world(on, { pct: 93, usageFails: true, store: { seed } })
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ⧗ spare10', 'inactive'))
  const renders = w.renders
  await w.clock.advance(3000)
  expect(w.renders).toBe(renders)
})

test('a question closed with no outcome redraws the badge back to tripped', { plugins: [above] }, async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const ui = await mountBadge($)
  const main = bash($, undefined, 'abandon me')
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(await badge(ui)).toEqual(shown(` ? spare10: waiting for you until ${AT}`, 'warning'))
  await w.clock.advance(1000) // the hook above settles: the raiser's own dispatch is abandoned
  expect((await main).deny).toBe('a hook above settled first')
  w.release() // the host withdraws the dialog of an abandoned dispatch (the kit does not, 11.5 #9)
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(await badge(ui)).toEqual(shown(' ⚠ Pausing at next step', 'warning'))
})

test('a gate read that sees a new reading redraws the badge', async ($, on) => {
  const w = world(on, { pct: 50, surfaces: [] })
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ● spare10', 'success'))
  w.pct = 93 // no measure: only the gate's own read sees it
  const before = w.invalidations
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(w.invalidations).toBeGreaterThan(before)
  expect(await badge(ui)).toEqual(shown(' ⚠ spare10: in the reserve', 'warning'))
})

test('a consent in the env for this window shows the consented mark', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_CONSENT: RESETS } })
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ⨯ spare10', 'warning'))
})

test('a consent in the env beyond this window is ignored by the badge', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_CONSENT: LATER } })
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ⚠ Pausing at next step', 'warning'))
})

test('a stopped value in the env shows stopped only for this session id', async ($, on) => {
  // legacy: a 0.1 value (three tokens) shows the 0.1 row, with no time
  const stamp = `${Date.parse(RESETS)} ${T0 - 60_000}`
  const w = world(on, { pct: 93, env: { SPARE10_STOPPED: `S1 ${stamp}` } })
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ■ spare10: stopped', 'warning'))
  await ui.unmount()
  w.env.set('SPARE10_STOPPED', `S0 ${stamp}`) // another conversation's stop (B18)
  const again = await mountBadge($)
  expect(await badge(again)).toEqual(shown(' ⚠ Pausing at next step', 'warning'))
})

test('a new window starts a new told set, so the badge winds down again', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_PAUSE_PROMPT: 'Commit and stop.' } })
  await begin($, w)
  const ui = await mountBadge($)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ⏸ spare10', 'warning'))
  // A new window, and the figure moves too.
  w.pct = 94
  w.resetsAt = LATER
  await $.session.measure(measure(94, ['rateLimits', 'cost'], LATER))
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ⚠ Winding down at next step', 'warning'))
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ⏸ spare10', 'warning'))
})

test('a new window at the same figure redraws a told badge', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_PAUSE_PROMPT: 'Commit and stop.' } })
  await begin($, w)
  const ui = await mountBadge($)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ⏸ spare10', 'warning'))
  // Only the reset moves: the told set of the old window no longer counts.
  w.resetsAt = LATER
  await $.session.measure(measure(93, ['rateLimits'], LATER))
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ⚠ Winding down at next step', 'warning'))
})

test('two surfaces share one pulse: one redraw a second, one render per surface', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const terminal = await mountBadge($, 'terminal')
  const desktop = await mountBadge($, 'desktop')
  await w.clock.settle()
  const r = w.renders
  const i = w.invalidations
  await w.clock.advance(5000)
  expect({ renders: w.renders - r, invalidations: w.invalidations - i }).toEqual({ renders: 10, invalidations: 5 })
  expect(await badge(terminal)).toEqual(await badge(desktop))
})

test('a failed stopped read draws the waiting mark', async ($, on) => {
  const w = world(on, { pct: 93, envGetFails: ['SPARE10_STOPPED'] })
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ⧗ spare10', 'inactive'))
})

test('a failed read keeps the label of the reserve in force', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_RESERVE: '40' }, envGetFails: ['SPARE10_STOPPED'] })
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ⧗ spare10 (40%)', 'inactive'))
})

test('an unattended run ignores a stopped value, even one with its own session id', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_STOPPED: stopRec('S1', RESETS, T0 - 60_000) } })
  await begin($, w)
  const ui = await mountBadge($)
  expect(await badge(ui)).toEqual(shown(' ⚠ spare10: in the reserve', 'warning'))
  expect((await bash($)).result).toBe('ran') // headless off: the stopped value does not refuse
})

test('a pulse that stops resets the glyph, so a new trip starts with the warning sign', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const ui = await mountBadge($)
  await w.clock.advance(1000)
  expect(await badge(ui)).toEqual(shown('   Pausing at next step', 'warning'))
  w.pct = 50
  await $.session.measure(measure(50))
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ● spare10', 'success'))
  w.pct = 93
  await $.session.measure(measure(93))
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ⚠ Pausing at next step', 'warning'))
})

test('without resetsAt the consented mark lasts the one-hour fallback, then the edge timer redraws', async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: null, answer: 'Resume' })
  await begin($, w)
  const ui = await mountBadge($)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(await badge(ui)).toEqual(shown(' ⨯ spare10', 'warning'))
  await w.clock.set(T0 + HOUR - 1000) // R11: the fallback window end holds still for the episode
  expect(await badge(ui)).toEqual(shown(' ⨯ spare10', 'warning'))
  const before = w.invalidations
  await w.clock.advance(1500) // past the fallback end, before the first pulse tick
  expect(w.invalidations).toBeGreaterThan(before)
  expect(await badge(ui)).toEqual(shown(' ⚠ Pausing at next step', 'warning'))
})

// D3: session.end runs while $.session.id() still answers the ending id, and the engine answers the new
// id only after the chain. So the badge must be right at once, and be drawn again after the switch.
for (const reason of ['clear', 'resume'] as const) {
  test(`a ${reason === 'clear' ? '/clear' : 'in-session /resume'} redraws a stopped badge at once and again after the new id`, async ($, on) => {
    const w: World = world(on, { pct: 93, answer: 'Stop here' })
    await begin($, w)
    const ui = await mountBadge($)
    expect((await bash($)).deny).toContain(STOP_PREFIX)
    await w.clock.settle()
    expect(await badge(ui)).toEqual(shown(` ■ spare10: stopped until ${AT}`, 'warning'))
    const before = w.invalidations
    await $.session.end({ reason, sessionId: 'S1', resume: { id: 'S1' } }) // the id is still S1 here
    await w.clock.settle()
    expect(w.invalidations).toBeGreaterThan(before)
    expect(await badge(ui)).toEqual(shown(' ⚠ Pausing at next step', 'warning'))
    w.sessionId = 'S2' // the engine switches to the new id after the chain
    const switched = w.invalidations
    await w.clock.advance(300) // before the first pulse tick: only the end's own timer redraws
    expect(w.invalidations).toBeGreaterThan(switched)
    expect(await badge(ui)).toEqual(shown(' ⚠ Pausing at next step', 'warning'))
    expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', OPENS, T0, `five_hour,work,auto,skip,${real5(RESETS)}`)) // the record stays: it names S1
  })
}

test('a session end for another reason changes nothing on the badge', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Stop here' })
  await begin($, w)
  const ui = await mountBadge($)
  expect((await bash($)).deny).toContain(STOP_PREFIX)
  await w.clock.settle()
  const before = w.invalidations
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'S1', resume: { id: 'S1' } })
  await w.clock.advance(2000)
  expect(w.invalidations).toBe(before)
  expect(await badge(ui)).toEqual(shown(` ■ spare10: stopped until ${AT}`, 'warning'))
})
