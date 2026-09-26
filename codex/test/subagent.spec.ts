import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readJson } from '../src/files.ts'
import type { QuestionRecord } from '../src/question.ts'
import { CHILD, HOUR, MIN, SID, T0, parsed, world } from './helpers/world.ts'
import type { World } from './helpers/world.ts'

// Subagents (Codex design 4.16, 8.2 subagent.spec): the root broker and a subagent broker of one session.
// The child leads and the root joins one form. An idle root does not cancel it. Stop here interrupts the
// turns of both threads on the daemon. A root Interrupt does not drop a held child call. SubagentStart
// passes.
//
// The kit port (8.2):
// Each tests/kit case and the Codex case that tests it: codex/test/kit-port.txt, kept complete by kit-port.spec.ts.

const RESET = T0 + 2 * HOUR
const question = (w: World): QuestionRecord | undefined => readJson<QuestionRecord>(w.file('question.json'))

test('subagent: the child leads, the root joins, one form, and one Resume releases both', async (t) => {
  const w = world(t)
  const root = await w.broker()
  const child = await w.broker({ thread: CHILD })
  assert.equal(await root.gate('spawn', { agent: CHILD, agentType: 'worker' }), '', 'SubagentStart passes')
  w.reading(CHILD, 92, { reset: RESET })
  w.reading(SID, 92, { reset: RESET })
  const c = child.call('tool')
  await w.settle()
  assert.equal(child.forms().length, 1, 'the child leads')
  assert.equal(question(w)?.leader?.threadId, CHILD)
  const r = root.call('tool')
  await w.settle()
  assert.equal(root.forms().length, 0, 'the root joins')
  assert.equal(question(w)?.loops, 2)
  // An idle root does not cancel the form: time passes, and the question stays.
  await w.advance(5 * MIN)
  assert.equal(c.box.done, false)
  assert.equal(r.box.done, false)
  assert.equal(child.forms().length, 1)
  child.host.answer({ action: 'accept', content: { choice: 'resume' } })
  await w.settle()
  assert.equal(c.box.done, true)
  assert.equal(r.box.done, true)
  assert.equal(parsed(c.box.text)['systemMessage'], undefined, 'no line rides a subagent answer')
  assert.match(parsed(r.box.text)['systemMessage'] as string, /^spare10: continuing on your 10% reserve/)
})

test('subagent: Stop here on the daemon interrupts the turns of both threads', async (t) => {
  const w = world(t, { daemon: true })
  const root = await w.broker({ hosted: true })
  const child = await w.broker({ thread: CHILD, hosted: true })
  w.reading(CHILD, 92, { reset: RESET })
  w.reading(SID, 92, { reset: RESET })
  const turns: Record<string, string> = {}
  w.daemon.script.newestTurn = (tid: string) => ({ id: turns[tid] ?? 'none', status: 'inProgress', startedAt: Math.floor(T0 / 1000) - 5 })
  const c = child.call('tool', { turn: 'C1' })
  turns[CHILD] = 'C1'
  const r = root.call('tool', { turn: 'R1' })
  turns[SID] = 'R1'
  await w.settle()
  child.host.answer({ action: 'accept', content: { choice: 'stop' } })
  await w.settle()
  const interrupts = w.daemon.callsOf('interrupt').map((a) => `${String(a[0])}/${String(a[1])}`).sort()
  assert.deepEqual(interrupts, [`${CHILD}/C1`, `${SID}/R1`].sort())
  assert.equal(c.box.done, true)
  assert.equal(r.box.done, true)
  assert.equal((parsed(r.box.text)['hookSpecificOutput'] as Record<string, unknown>)['permissionDecision'], 'deny')
  assert.deepEqual(Object.keys(w.state().interrupts ?? {}).sort(), ['C1', 'R1'])
})

test('subagent: a root Interrupt does not drop a held child call', async (t) => {
  const w = world(t)
  const root = await w.broker()
  const child = await w.broker({ thread: CHILD })
  w.reading(CHILD, 92, { reset: RESET })
  const c = child.call('tool', { turn: 'C1' })
  await w.settle()
  assert.equal(c.box.done, false)
  assert.equal(await root.gate('interrupt', { turn: 'R1' }), '')
  await w.settle()
  assert.equal(c.box.done, false)
  assert.equal(child.forms().length, 1)
})
