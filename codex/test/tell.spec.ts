import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOUR, SID, T0, CHILD, parsed, world } from './helpers/world.ts'

// The pause prompt, tell mode (Codex design 4.11, 8.2 tell.spec): the wind-down text rides the PreToolUse
// answer as context once per loop and stage (the tool still runs), the told line once per window and
// stage, and the prompt question until the main loop is told.
//
// The kit port (8.2):
// Each tests/kit case and the Codex case that tests it: codex/test/kit-port.txt, kept complete by kit-port.spec.ts.

const RESET = T0 + 2 * HOUR
const TELL = /^spare10 budget guard\. You have reached the safe usage limit for this session \(.+\)\. Immediately wrap up your work and stop\. Immediately stop any subagent, unless the user instructs otherwise\.\n\nUser instructions: Wind down now\.$/

test('tell: the wind-down text rides the tool answer once per loop, and the told line once per window', async (t) => {
  const w = world(t, { config: { pausePrompt: 'Wind down now.' } })
  const root = await w.broker()
  const child = await w.broker({ thread: CHILD })
  w.reading(SID, 92, { reset: RESET })
  w.reading(CHILD, 92, { reset: RESET })
  const first = parsed(await root.gate('tool'))
  assert.deepEqual(Object.keys(first).sort(), ['hookSpecificOutput', 'systemMessage'])
  const hso = first['hookSpecificOutput'] as Record<string, unknown>
  assert.equal(hso['hookEventName'], 'PreToolUse')
  assert.equal(hso['permissionDecision'], undefined, 'the tool still runs')
  assert.match(hso['additionalContext'] as string, TELL)
  assert.match(first['systemMessage'] as string, /^spare10: your 10% reserve is reached\. spare10 told the agents to wind down\.$/)
  // The same loop again: nothing more.
  assert.equal(await root.gate('tool'), '')
  // Another loop (a subagent) is told too, and the told line does not come again.
  const c = parsed(await child.gate('tool'))
  assert.match((c['hookSpecificOutput'] as Record<string, unknown>)['additionalContext'] as string, TELL)
  assert.equal(c['systemMessage'], undefined)
  assert.deepEqual(w.notices(), [])
  // A step in tell mode passes.
  assert.equal(await root.gate('step'), '')
  assert.equal(root.forms().length + child.forms().length, 0)
})

test('tell: a person prompt asks until the main loop is told, then passes', async (t) => {
  const w = world(t, { config: { pausePrompt: 'Wind down now.' } })
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  const h = b.call('prompt', { prompt: 'next task' })
  await w.settle()
  assert.equal(h.box.done, false)
  assert.match((b.forms()[0]?.['params'] as Record<string, unknown>)['message'] as string, /Stop here drops it\.$/)
  b.host.answer({ action: 'accept', content: { choice: 'stop' } })
  await w.settle()
  assert.match(parsed(h.box.text)['reason'] as string, /^spare10: not started\./)
  assert.equal(w.state().stopped, undefined, 'tell mode writes no stop')
  // The main loop is told at its next tool.
  assert.match(((parsed(await b.gate('tool'))['hookSpecificOutput'] as Record<string, unknown>)['additionalContext'] as string), TELL)
  assert.equal(await b.gate('prompt', { prompt: 'and now?' }), '')
  assert.equal(b.forms().length, 1)
})

test('tell: a reset that moves within its jitter keeps each loop told, and a told prompt passes (3.6)', async (t) => {
  const w = world(t, { config: { pausePrompt: 'Wind down now.' } })
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  const first = parsed(await b.gate('tool'))
  assert.match((first['hookSpecificOutput'] as Record<string, unknown>)['additionalContext'] as string, TELL)
  assert.match(first['systemMessage'] as string, /^spare10: your 10% reserve is reached\./)
  // The next reading has a reset 30 s earlier: the same window, so no second tell and no second told line.
  await w.advance(1000)
  w.reading(SID, 92.5, { reset: RESET - 30_000 })
  assert.equal(await b.gate('tool'), '')
  // A reset 20 s later: the main loop is still told, so a person prompt passes with no form.
  await w.advance(1000)
  w.reading(SID, 92.6, { reset: RESET + 20_000 })
  assert.equal(await b.gate('prompt', { prompt: 'next task' }), '')
  assert.equal(b.forms().length, 0)
  assert.deepEqual(w.notices(), [])
  assert.deepEqual(w.state().told, { five_hour: { windowEnd: RESET, keys: [`${SID}:main`] } })
})

test('tell: a subagent that reads a reset within its jitter is told, and the told line does not come again (3.6)', async (t) => {
  const w = world(t, { config: { pausePrompt: 'Wind down now.' } })
  const root = await w.broker()
  const child = await w.broker({ thread: CHILD })
  w.reading(SID, 92, { reset: RESET })
  const first = parsed(await root.gate('tool'))
  assert.match(first['systemMessage'] as string, /^spare10: your 10% reserve is reached\./)
  // The child's first tool reads a reset 30 s earlier: a new loop in the same window.
  await w.advance(1000)
  w.reading(CHILD, 92.5, { reset: RESET - 30_000 })
  const c = parsed(await child.gate('tool'))
  assert.match((c['hookSpecificOutput'] as Record<string, unknown>)['additionalContext'] as string, TELL)
  assert.equal(c['systemMessage'], undefined)
  assert.deepEqual(w.notices(), [], 'no second told line is queued')
  assert.deepEqual(w.state().told, { five_hour: { windowEnd: RESET, keys: [`${SID}:main`, `${SID}:${CHILD}`] } })
})
