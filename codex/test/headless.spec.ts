import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexText } from '../../hooks/core/codex.ts'
import { formatConsent } from '../../hooks/core/decide.ts'
import { rateReply as rateReplyOf } from './helpers/logic.ts'
import { HOUR, MIN, SEC, SID, T0, parsed, world } from './helpers/world.ts'

// Unattended runs (Codex design 4.13, 3.10, 8.2 headless.spec) on an exec host: `off` passes with one debug
// line, `prompt` tells, `stop` denies once with the codex exec resume text, then holds the next tool of the
// same turn until the reserve no longer gates, blocks a prompt's step phase and ends at Stop, `wait` holds
// with no form and releases at its due time after a live read, a nested run takes its parent's policy and
// consent, and `codex exec resume` of a TUI thread is unattended.
//
// The kit port (8.2):
// Each tests/kit case and the Codex case that tests it: codex/test/kit-port.txt, kept complete by kit-port.spec.ts.

const RESET = T0 + 2 * HOUR
const EXEC = { hostKind: 'exec' as const, originator: 'codex_exec', source: 'exec' }
const HEADLESS = /^spare10 stopped this unattended run at the quota reserve \(.+\)\. No further model requests were sent\. To pick it up later: codex exec resume 01a0da06-c266-7842-bc97-1128f6549960$/
const reasonOf = (text: string): string => ((parsed(text)['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['permissionDecisionReason'] as string) ?? ''

test('headless: policy off lets the run through with one debug line per kind and window', async (t) => {
  const w = world(t)
  const b = await w.broker(EXEC)
  w.reading(SID, 92, { reset: RESET })
  assert.equal(await b.gate('tool'), '')
  assert.equal(await b.gate('step'), '')
  assert.equal(await b.gate('prompt', { prompt: 'go' }), '')
  const lines = w.log.lines.filter((l) => l.startsWith('spare10: unattended run inside the reserve'))
  assert.equal(lines.length, 1)
  assert.match(lines[0] ?? '', /, policy off\.$/)
})

test('headless: policy prompt tells the agents at the tool', async (t) => {
  const w = world(t)
  const b = await w.broker({ ...EXEC, env: { SPARE10_HEADLESS: 'prompt' } })
  w.reading(SID, 92, { reset: RESET })
  const out = parsed(await b.gate('tool'))
  assert.match((out['hookSpecificOutput'] as Record<string, unknown>)['additionalContext'] as string, /^spare10 budget guard\./)
  assert.equal(await b.gate('prompt', { prompt: 'go on' }), '')
})

test('headless: policy stop denies once per turn, holds the next tool of the turn until the reserve no longer gates, blocks a prompt and ends at Stop', async (t) => {
  const w = world(t)
  const b = await w.broker({ ...EXEC, env: { SPARE10_HEADLESS: 'stop' } })
  w.reading(SID, 92, { reset: RESET })
  await b.gate('prompt', { prompt: 'plain', turn: 'U-a' }).catch(() => '')
  assert.match(reasonOf(await b.gate('tool', { turn: 'U-a' })), HEADLESS)
  // The next tool of the same turn holds.
  const h = b.call('tool', { turn: 'U-a' })
  await w.settle()
  assert.equal(h.box.done, false)
  // A new turn gets one deny again.
  assert.match(reasonOf(await b.gate('tool', { turn: 'U-b' })), HEADLESS)
  // The Stop gate ends the turn with no request.
  assert.deepEqual(parsed(await b.gate('stop', { turn: 'U-b' })), { continue: false, stopReason: codexText.turnEnds })
  // The window resets: the held tool of U-a runs.
  await w.advance(RESET - T0 + 1 * MIN)
  w.reading(SID, 3, { reset: w.clock.now() + 5 * HOUR })
  await w.advance(30 * SEC)
  assert.equal(h.box.done, true)
  assert.equal(h.box.text, '')
})

test('headless: policy stop blocks the step phase of a prompt', async (t) => {
  const w = world(t)
  const b = await w.broker({ ...EXEC, env: { SPARE10_HEADLESS: 'stop' } })
  w.reading(SID, 92, { reset: RESET })
  assert.match(parsed(await b.gate('prompt', { prompt: 'go' }))['reason'] as string, HEADLESS)
})

test('headless: policy wait holds with no form and releases at its due time after a live read', async (t) => {
  const w = world(t, { daemon: true })
  w.daemon.script.rateLimits = rateReplyOf({ five: 92, fiveReset: RESET })
  const b = await w.broker({ ...EXEC, env: { SPARE10_HEADLESS: 'wait' } })
  w.reading(SID, 92, { reset: RESET })
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false)
  assert.equal(b.forms().length, 0, 'a silent question')
  const before = w.daemon.callsOf('rateLimits').length
  await w.advance(RESET - 20 * MIN - T0 - 2 * MIN)
  assert.equal(h.box.done, false)
  await w.advance(3 * MIN)
  assert.equal(h.box.done, true, 'released at the skip start')
  assert.ok(w.daemon.callsOf('rateLimits').length > before, 'the release read the daemon first')
})

test('headless: a nested run takes the child policy and the consent of its parent session', async (t) => {
  const PARENT = '01a0da09-0000-7000-8000-0000000a11ce'
  const NESTED = '01a0da0a-0000-7000-8000-00000000beef'
  const w = world(t)
  // The attended root of the parent session writes child: 'stop' at its first gate (B37).
  await w.broker({ session: PARENT })
  assert.equal(w.state(PARENT).child, 'stop')
  const b = await w.broker({ ...EXEC, session: NESTED, env: { CODEX_SESSION_ID: PARENT } })
  w.reading(NESTED, 92, { reset: RESET })
  assert.match(reasonOf(await b.gate('tool', { turn: 'N1' })), /To pick it up later: codex exec resume 01a0da0a-0000-7000-8000-00000000beef$/)
  // A consent of the parent covers the nested run.
  w.setState({ consent: formatConsent(PARENT, RESET) }, PARENT)
  assert.equal(await b.gate('tool', { turn: 'N2' }), '')
})

test('headless: codex exec resume of a TUI thread is unattended (A21)', async (t) => {
  const w = world(t)
  const b = await w.broker({ hostKind: 'exec', originator: 'codex-tui', source: 'cli', env: { SPARE10_HEADLESS: 'stop' } })
  w.reading(SID, 92, { reset: RESET })
  assert.match(reasonOf(await b.gate('tool')), HEADLESS)
  assert.equal(w.state().attended, false)
})

test('headless: a nested run with a parent consent to the floor runs to its point, then its stop policy applies', async (t) => {
  const PARENT = '01a0da09-0000-7000-8000-0000000a11ce'
  const NESTED = '01a0da0a-0000-7000-8000-00000000beef'
  const w = world(t)
  await w.broker({ session: PARENT })
  w.setState({ consent: formatConsent(PARENT, RESET, 95) }, PARENT)
  const b = await w.broker({ ...EXEC, session: NESTED, env: { CODEX_SESSION_ID: PARENT } })
  w.reading(NESTED, 93, { reset: RESET })
  assert.equal(await b.gate('tool', { turn: 'N1' }), '', 'below the point the parent consent covers the run')
  w.reading(NESTED, 95, { reset: RESET })
  assert.match(reasonOf(await b.gate('tool', { turn: 'N2' })), /To pick it up later: codex exec resume 01a0da0a-0000-7000-8000-00000000beef$/, 'at the point the policy applies')
  w.reading(NESTED, 93, { reset: RESET, at: w.clock.now() + 1 })
  await w.advance(1)
  assert.match(reasonOf(await b.gate('tool', { turn: 'N3' })), /codex exec resume/, 'a fall never brings the ended consent back')
})
