import { test, expect } from 'claude-code/testing'
import { atText, factsOf, headlessText, pausedText, stopReply, stopText } from '../../hooks/core/text.ts'
import { OPENS, RESETS, bash, begin, cmd, drain, step, stepAbove, world } from '../helpers/world.ts'

// What Stop does to each kind of loop (design 4.8, 11.4 stop.test.ts): a refused main step ends its
// turn, so a blocking Stop hook cannot re-prompt it.

const F93 = factsOf({ kind: 'live', pct: 93, resetsAtMs: Date.parse(RESETS) }, 10)
// {at} with autoResume on: with the shipped spans the skip start, 20 min before RESETS (skip 2.8).
const AT = atText(Date.parse(OPENS), ['five_hour'])
const LEAD = '20 min before the reset'

test('a refused main step in an attended session ends the turn with turn.abort', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'dismiss' })
  await begin($, w)
  expect((await bash($)).deny).toBe(stopText(F93))
  await w.clock.settle()
  const refused = await drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(refused.text).toBe(pausedText(F93))
  expect(w.requests).toBe(0)
  expect(w.aborts).toEqual(['T1'])
})

test('a refused subagent step never aborts', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'dismiss', agents: ['a1'] })
  await begin($, w)
  expect((await bash($, 'a1')).deny).toBe(stopText(F93))
  await w.clock.settle()
  const refused = await drain($, step('a1', 'T2'))
  await drain($, step('a1', 'T2'))
  await w.clock.settle()
  expect(refused.text).toBe(pausedText(F93))
  expect(w.requests).toBe(0)
  expect(w.aborts).toEqual([])
})

test('an unattended stop aborts only a second refused step of the same turn', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  const first = await drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(first.text).toBe(headlessText(F93, 'S1'))
  expect(first.text).toContain('claude --resume S1')
  expect(w.aborts).toEqual([])
  await drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(w.aborts).toEqual(['T1'])
  await drain($, step(undefined, 'T2'))
  await w.clock.settle()
  expect(w.aborts).toEqual(['T1'])
  expect(w.requests).toBe(0)
  expect(w.asked).toEqual([])
})

test('a main step answered Stop here ends its turn too', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const held = drain($, step(undefined, 'T3'))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.aborts).toEqual([])
  w.release('Stop here')
  expect((await held).text).toBe(pausedText(F93))
  await w.clock.settle()
  expect(w.requests).toBe(0)
  expect(w.aborts).toEqual(['T3'])
})

test('/spare10 stop after Resume denies the next call and refuses the next step', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect((await $.command.run(cmd('stop'))).text).toBe(stopReply('tripped', F93, undefined, { at: AT, lead: LEAD }))
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect((await bash($)).deny).toBe(stopText(F93))
  await drain($, step(undefined, 'T4'))
  await w.clock.settle()
  expect(w.requests).toBe(0)
  expect(w.aborts).toEqual(['T4'])
  expect(w.asked).toHaveLength(1)
})

test('a held main step abandoned from above sends no request and ends no turn', { plugins: [stepAbove] }, async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const held = drain($, step(undefined, 'abandon-1'))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await w.clock.advance(1000) // the hook above answers the step itself
  expect((await held).text).toBe('above')
  await w.clock.settle()
  expect(w.requests).toBe(0)
  expect(w.aborts).toEqual([])
  w.release() // the host withdraws the dialog of the abandoned step
  await w.clock.settle()
  expect(w.requests).toBe(0)
  expect(w.aborts).toEqual([])
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined() // nobody answered: nothing is decided
})
