import { test, expect } from 'claude-code/testing'
import { atText, factsOf, notStarted, notice, questionText, resumeContext } from '../../hooks/core/text.ts'
import { OPENS, RESETS, SKIP, bash, begin, drain, real5, step, stopRe, typed, world02 as world } from '../helpers/world.ts'

// The 0.2 texts: floors off (world02). The floor tests: floor*.test.ts.
// The person's prompts in hold mode (design B8 to B11, 11.4 prompt.test.ts).

const F93 = factsOf({ kind: 'live', pct: 93, resetsAtMs: Date.parse(RESETS) }, 10)
// {at}: the clock at which spare10 continues (autoResume on). With the shipped spans the skip start,
// 20 min before RESETS, and the question names its lead (skip 2.1, 2.2).
const AT = atText(Date.parse(OPENS), ['five_hour'])
const LEAD = '20 min before the reset'
const F93_OWNER = { ...F93, holdEnd: Date.parse(OPENS), span: SKIP }
const transcript = (w: { logs: Array<{ text: string; to?: string }> }) => w.logs.filter((l) => l.to !== 'debug').map((l) => l.text)

test('a typed prompt inside the reserve asks the prompt question before it enters', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([questionText(F93_OWNER, 'prompt', 'hold', true)])
  expect(w.prompts).toEqual([])
  w.release('Resume')
  expect(await p).toMatchObject({ text: 'hello' })
  expect(w.prompts.map((e) => e.text)).toEqual(['hello'])
})

test('Stop here drops the prompt with the reason, leaves the session stopped, and puts the text back in an empty box', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Stop here' })
  await begin($, w)
  const r = await $.prompt.submit(typed('hello'))
  expect(r).toEqual({ drop: notStarted(F93) })
  await w.clock.settle()
  expect(w.prompts).toEqual([])
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stopRe('S1', `five_hour,auto,skip,${real5(RESETS)}`))
  expect(transcript(w)).toContain(notice.stopped(F93, { at: AT, work: false, lead: LEAD }))
  expect(w.fills).toEqual(['hello'])
  await drain($, step())
  expect(w.requests).toBe(0)
})

test('the text is not put back when the box already holds text', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Stop here', box: 'draft' })
  await begin($, w)
  expect(await $.prompt.submit(typed('hello'))).toEqual({ drop: notStarted(F93) })
  await w.clock.settle()
  expect(w.fills).toEqual([])
  expect(w.box).toBe('draft')
})

test('Resume lets it in and consents for the window', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Resume' })
  await begin($, w)
  const r = await $.prompt.submit(typed('hello'))
  expect(r).toMatchObject({ text: 'hello' })
  expect(w.prompts[0]?.context).toBeUndefined()
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect((await bash($)).result).toBe('ran')
  expect(await $.prompt.submit(typed('again'))).toMatchObject({ text: 'again' })
  expect(w.asked).toHaveLength(1)
})

test('after Stop, a typed prompt asks again, and Resume adds the resume note', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'dismiss' })
  await begin($, w)
  await bash($)
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBeDefined()
  w.answer = 'Resume'
  const r = await $.prompt.submit(typed('carry on'))
  expect(r).toMatchObject({ text: 'carry on' })
  expect(w.asked.map((a) => a.question)).toEqual([questionText(F93_OWNER, 'loop', 'hold', true), questionText(F93_OWNER, 'prompt', 'hold', true)])
  expect(w.prompts[0]?.context).toEqual([resumeContext(F93)])
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
})

test('notifications, peers and plugin prompts are never asked', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'dismiss' })
  await begin($, w)
  await bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  for (const kind of ['task-notification', 'peer', 'plugin', 'scheduled-trigger', 'sdk'] as const) {
    expect(await $.prompt.submit(typed(`from ${kind}`, kind))).toMatchObject({ text: `from ${kind}` })
  }
  expect(w.prompts).toHaveLength(5)
  expect(w.asked).toHaveLength(1)
  await drain($, step(undefined, 'N1')) // stopped: the step of such a prompt is refused
  expect(w.requests).toBe(0)
})

test('a typed prompt while a question is open joins it', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.prompts).toEqual([])
  w.release('Resume')
  expect((await held).result).toBe('ran')
  expect(await p).toMatchObject({ text: 'hello' })
  expect(w.asked).toHaveLength(1)
})

test('a prompt from a remote surface (the bridge) asks, Stop drops it, and the local box is not filled', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const p = $.prompt.submit(typed('from my phone', 'bridge'))
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([questionText(F93_OWNER, 'prompt', 'hold', true)])
  expect(w.prompts).toEqual([])
  w.release('Stop here')
  expect(await p).toEqual({ drop: notStarted(F93) })
  await w.clock.settle()
  expect(w.prompts).toEqual([])
  expect(w.fills).toEqual([]) // the text was typed on another surface: it never lands in this box
  // Stopped now: a bridge prompt still asks, and Resume lets it in with the resume note.
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stopRe('S1', `five_hour,auto,skip,${real5(RESETS)}`))
  w.answer = 'Resume'
  expect(await $.prompt.submit(typed('go on', 'bridge'))).toMatchObject({ text: 'go on' })
  expect(w.asked).toHaveLength(2)
  expect(w.prompts[0]?.context).toEqual([resumeContext(F93)])
})

test('a sensor failure lets a typed prompt enter without a question', async ($, on) => {
  const w = world(on, { pct: 93, usageFails: true })
  await begin($, w)
  expect(await $.prompt.submit(typed('hello'))).toMatchObject({ text: 'hello' })
  expect(w.prompts.map((e) => e.text)).toEqual(['hello'])
  expect(w.asked).toEqual([])
})
