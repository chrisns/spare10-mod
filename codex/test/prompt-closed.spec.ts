import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { HOUR, SID, T0 } from './helpers/logic.ts'
import { parsed, world } from './helpers/world.ts'

// B38 at a person prompt (Codex design 4.2): a question that ended with no answer makes the gate decide
// again. When the sense of that next round fails, the last known state was tripped, so the prompt blocks
// (fail closed). gate.spec has the tool form of this rule.

const RESET = T0 + 2 * HOUR

test('prompt: a sense that fails in the round after a prompt question ended with no answer blocks the prompt (fail closed)', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  b.script('hang')
  const h = b.call('prompt', { prompt: 'go on' })
  await w.settle()
  assert.equal(h.box.done, false, 'the prompt holds and asks')
  // The question ends with no answer (the waiter decides again), and the next sense fails.
  writeFileSync(w.file('state.json'), '{ not json')
  rmSync(w.file('question.json'))
  await w.advance(31_000)
  assert.equal(h.box.done, true)
  const out = parsed(h.box.text)
  assert.equal(out['decision'], 'block', 'never a pass: the model request does not go out')
  assert.match(String(out['reason']), /^spare10: not started\./)
})

test('prompt: a sense that fails with no question before it passes the prompt (fail open)', async (t) => {
  const w = world(t)
  const b = await w.broker()
  writeFileSync(w.file('state.json'), '{ not json')
  assert.equal(await b.gate('prompt', { prompt: 'hello' }), '', 'no known trip: the prompt goes on')
})
