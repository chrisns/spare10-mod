import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexText, withPrefix } from '../../hooks/core/codex.ts'
import { formatStopped } from '../../hooks/core/decide.ts'
import { questionText, resumeContext } from '../../hooks/core/text.ts'
import type { QuestionRecord } from '../src/question.ts'
import { readJson } from '../src/files.ts'
import { CHILD, HOUR, MIN, SID, T0, parsed, world } from './helpers/world.ts'
import type { World } from './helpers/world.ts'

// Prompts (Codex design 4.10, 2.7, 8.2 prompt.spec): the prompt question in hold and tell mode, Stop here
// and a declined form, a Resume with the B9 note (after CX39 when spare10 interrupted a turn of the stop),
// the step phase of an unattended run, a subagent message, the steer rule, and CX18.
//
// The kit port (8.2). restoreDraft and $.prompt.fill have no Codex form: a dropped prompt is not put back.
// Each tests/kit case and the Codex case that tests it: codex/test/kit-port.txt, kept complete by kit-port.spec.ts.

const RESET = T0 + 2 * HOUR

const question = (w: World): QuestionRecord | undefined => readJson<QuestionRecord>(w.file('question.json'))

test('prompt: the prompt question in hold mode shows the B2 prompt text, and Stop here blocks with notStarted', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  const h = b.call('prompt', { prompt: 'refactor the parser' })
  await w.settle()
  assert.equal(h.box.done, false)
  const q = question(w)
  assert.ok(q !== undefined)
  assert.equal(q.opener, 'prompt')
  const form = b.forms()[0]?.['params'] as Record<string, unknown>
  assert.equal(form['message'], questionText(q.facts, 'prompt', 'hold', q.auto))
  assert.match(form['message'] as string, /Stop here drops your prompt and pauses other work until/)
  b.host.answer({ action: 'accept', content: { choice: 'stop' } })
  await w.settle()
  const out = parsed(h.box.text)
  assert.equal(out['decision'], 'block')
  assert.match(out['reason'] as string, /^spare10: not started\. This session is inside your 10% reserve until .+\. Send the prompt again to be asked again, or run spare10 resume\.$/)
  assert.match(out['systemMessage'] as string, /^spare10: stopped at your 10% reserve until /)
})

test('prompt: the prompt question in tell mode says that Stop here drops the prompt', async (t) => {
  const w = world(t, { config: { pausePrompt: 'Finish the file, then stop.' } })
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  const h = b.call('prompt', { prompt: 'go on' })
  await w.settle()
  const q = question(w)
  assert.ok(q !== undefined)
  assert.equal(q.mode, 'tell')
  assert.equal((b.forms()[0]?.['params'] as Record<string, unknown>)['message'], questionText(q.facts, 'prompt', 'tell', q.auto))
  assert.match(questionText(q.facts, 'prompt', 'tell', q.auto), /Stop here drops it\./)
  b.host.answer({ action: 'accept', content: { choice: 'resume' } })
  await w.settle()
  assert.equal(h.box.done, true)
  assert.equal(parsed(h.box.text)['decision'], undefined)
})

test('prompt: a declined form blocks the prompt with CX5 and leaves a held stop', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  b.script('decline')
  const h = b.call('prompt', { prompt: 'hello' })
  await w.settle()
  const out = parsed(h.box.text)
  assert.equal(out['decision'], 'block')
  assert.match(out['reason'] as string, /^spare10: not started\. This session is inside your 10% reserve until .+, and Codex cannot show the spare10 question here\. Run spare10 resume, then send the prompt again\.$/)
  assert.equal(w.state().stopMeta?.noDialog, true)
  // A client with no form capability: the same.
  const c = await w.broker({ session: '01a0da06-0000-7000-8000-00000000c0de', form: false })
  w.reading(c.thread, 92, { reset: RESET })
  const h2 = c.call('prompt', { prompt: 'hello' })
  await w.settle()
  assert.match(parsed(h2.box.text)['reason'] as string, /Codex cannot show the spare10 question here/)
  assert.equal(c.forms().length, 0)
})

test('prompt: Resume lets the prompt in with the B9 note, after CX39 when spare10 interrupted a turn of the stop', async (t) => {
  for (const interrupted of [false, true]) {
    const w = world(t)
    const b = await w.broker()
    w.reading(SID, 92, { reset: RESET })
    w.setState({
      stopped: formatStopped({ sessionId: SID, windowEnd: RESET - 20 * MIN, at: T0 - 10 * MIN, kinds: ['five_hour'], auto: true, work: true, skip: true }),
      ...(interrupted ? { interrupts: { 'U-old': T0 - 9 * MIN } } : {}),
    })
    const h = b.call('prompt', { prompt: 'continue please' })
    await w.settle()
    const q = question(w)
    assert.ok(q !== undefined)
    b.host.answer({ action: 'accept', content: { choice: 'resume' } })
    await w.settle()
    const out = parsed(h.box.text)
    const b9 = resumeContext(q.facts)
    const hso = out['hookSpecificOutput'] as Record<string, unknown>
    assert.equal(hso['hookEventName'], 'UserPromptSubmit')
    assert.equal(hso['additionalContext'], interrupted ? `${codexText.interruptedNote} ${b9}` : b9)
    assert.match(out['systemMessage'] as string, /^spare10: continuing on your 10% reserve/)
    assert.equal(w.state().stopped, undefined)
  }
})

test('prompt: the step phase of an unattended stop policy blocks the prompt with the codex exec resume text', async (t) => {
  const w = world(t)
  const b = await w.broker({ hostKind: 'exec', env: { SPARE10_HEADLESS: 'stop' }, originator: 'codex_exec', source: 'exec' })
  w.reading(SID, 92, { reset: RESET })
  const text = await b.gate('prompt', { prompt: 'run the task' })
  const out = parsed(text)
  assert.equal(out['decision'], 'block')
  assert.match(out['reason'] as string, /^spare10 stopped this unattended run at the quota reserve \(.+\)\. No further model requests were sent\. To pick it up later: codex exec resume 01a0da06-c266-7842-bc97-1128f6549960$/)
  assert.equal(b.forms().length, 0)
})

test('prompt: a subagent message is never asked: it holds as a step with a loop question', async (t) => {
  const w = world(t)
  await w.broker()
  const child = await w.broker({ thread: CHILD })
  w.reading(CHILD, 92, { reset: RESET })
  const h = child.call('prompt', { prompt: 'check the tests' })
  await w.settle()
  assert.equal(h.box.done, false)
  const q = question(w)
  assert.equal(q?.opener, 'loop')
  assert.equal((child.forms()[0]?.['params'] as Record<string, unknown>)['message'], questionText(q?.facts ?? [], 'loop', 'hold', q?.auto))
  child.host.answer({ action: 'accept', content: { choice: 'stop' } })
  await w.settle()
  const out = parsed(h.box.text)
  assert.equal(out['decision'], 'block')
  assert.match(out['reason'] as string, /^spare10: work stopped at the quota reserve/)
  assert.equal(out['systemMessage'], undefined, 'a subagent answer carries no transcript line')
})

test('prompt: a steered command passes with the prefixed reply and CX4, and a steered stop blocks', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 40, { reset: RESET })
  assert.equal(await b.gate('prompt', { prompt: 'SLOW', turn: 'U-slow' }), '')
  const out = parsed(await b.gate('prompt', { prompt: 'spare10 status', turn: 'U-slow' }))
  assert.equal(out['decision'], undefined)
  assert.deepEqual(out['hookSpecificOutput'], { hookEventName: 'UserPromptSubmit', additionalContext: codexText.steerNote })
  const sys = out['systemMessage'] as string
  assert.match(sys, /^spare10: version /)
  assert.ok(sys.split('\n').every((l) => l === '' || l.startsWith('spare10: ')), 'each line has its prefix')
  const stop = parsed(await b.gate('prompt', { prompt: 'spare10 stop', turn: 'U-slow' }))
  assert.equal(stop['decision'], 'block')
  assert.match(stop['reason'] as string, /^spare10: nothing to stop\./)
  // The same command typed as a new prompt blocks.
  assert.equal(parsed(await b.gate('prompt', { prompt: 'spare10 status' }))['decision'], 'block')
})

test('prompt: CX18 for a held prompt of a broker that died', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.store().locked((tx) => {
    tx.thread(SID).held = [{ call: '9', site: 'prompt', turn: 'U-lost', since: T0 - 5 * MIN, prompt: 'the lost prompt', brokerPid: 999, hostPid: 3999 }]
  })
  w.reading(SID, 40, { reset: RESET })
  const out = parsed(await b.gate('prompt', { prompt: 'hello again' }))
  assert.equal(out['systemMessage'], withPrefix(codexText.promptLost))
  assert.deepEqual(w.thread(SID)?.held, [])
})

test('prompt: a typed prompt while a loop question is open joins it: one form, and one Resume lets both in', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  const tool = b.call('tool')
  await w.settle()
  assert.equal(tool.box.done, false)
  const key = question(w)?.key
  const prompt = b.call('prompt', { prompt: 'next task' })
  await w.settle()
  assert.equal(prompt.box.done, false, 'the prompt holds')
  assert.equal(question(w)?.key, key, 'on the same question')
  assert.equal(b.forms().length, 1, 'one form')
  b.host.answer({ action: 'accept', content: { choice: 'resume' } })
  await w.settle()
  assert.equal(tool.box.done, true)
  assert.equal((parsed(tool.box.text)['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['permissionDecision'], undefined, 'the tool runs')
  assert.equal(prompt.box.done, true)
  assert.equal(parsed(prompt.box.text)['decision'], undefined, 'the prompt goes in')
})
