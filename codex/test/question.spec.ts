import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { codexText, elicitParams } from '../../hooks/core/codex.ts'
import { formatConsent, formatStopped, parseStopped } from '../../hooks/core/decide.ts'
import { questionOf, refusalText, resumeNotice } from '../../hooks/core/flow.ts'
import type { Acted } from '../../hooks/core/flow.ts'
import { debugLine, notice, questionText } from '../../hooks/core/text.ts'
import { readJson } from '../src/files.ts'
import type { QuestionRecord } from '../src/question.ts'
import type { CodexSensed } from '../src/sense.ts'
import type { AnswerFile, ThreadState } from '../src/store.ts'
import { BEAT_STALE_MS, HOLD_LIMIT_MS } from '../src/timing.ts'
import { CHILD, HOUR, MIN, SEC, SID, T0, heldCall, logicWorld } from './helpers/logic.ts'
import type { LogicWorld, TestCall } from './helpers/logic.ts'

// One question per session (Codex design 4.3, 2.2, 7.2 question.ts, 8.2 question.spec): open or join in one
// critical section, one form raised by the leader, the answers of 2.2, the hand-off, forget, decided
// elsewhere, the due check, and the settle that writes the answer, the consent or the stop in one lock.
// The gate answer texts of these cases come with gate.spec and prompt.spec (the gate is the next step).
//
// The kit port (8.2). The carrier, its re-arm and its fast rejections (the 10 s park) and the withdrawal
// of a dialog (hook 5) have no Codex form: a held MCP call has no budget, and a form stays until its turn ends.
// Each tests/kit case and the Codex case that tests it: codex/test/kit-port.txt, kept complete by kit-port.spec.ts.

const RESET = T0 + 2 * HOUR

async function tripped(w: LogicWorld, b: ReturnType<LogicWorld['broker']>, pct = 92, reset = RESET, site: 'tool' | 'step' | 'prompt' = 'tool') {
  w.reading(b.thread, pct, { reset })
  const s = await b.sense.sense(b.sx, site)
  const a = await b.sense.act(b.sx, s, { site, person: site === 'prompt' })
  return { s, a }
}

/** Opens or joins the question for `call`, and starts its wait. */
function hold(b: ReturnType<LogicWorld['broker']>, call: TestCall, s: CodexSensed, a: Acted, opener: 'loop' | 'prompt' = 'loop') {
  const key = b.questions.ensureQuestion(b.sx, call, opener, s, a)
  const out = b.questions.waitQuestion(b.sx, call, key)
  return { key, out }
}

const questionFile = (w: LogicWorld): QuestionRecord | undefined => readJson<QuestionRecord>(w.file('question.json'))
const answerFile = (w: LogicWorld): AnswerFile | undefined => readJson<AnswerFile>(w.file('answer.json'))
const threadFile = (w: LogicWorld, tid = SID): ThreadState | undefined => readJson<ThreadState>(join(w.file('threads'), `${tid}.json`))
const texts = (w: LogicWorld): string[] => (w.state().notices ?? []).map((n) => n.text)

test('question: a trip at PreToolUse raises one form with the 2.2 params and the B2 message', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const { s, a } = await tripped(w, b)
  const call = heldCall({ id: 7, turn: 'U1' })
  const { key } = hold(b, call, s, a)
  await w.settle()
  const q = questionOf('loop', s, a, s.now)
  assert.deepEqual(b.mcp.requests, [elicitParams(questionText(q.facts, 'loop', 'hold', true))])
  const file = questionFile(w)
  assert.equal(file?.key, key)
  assert.match(key, new RegExp(`^${SID}:${T0}:[0-9a-f]{8}$`))
  assert.deepEqual(file?.leader, { brokerId: b.owner, pid: b.pid, threadId: SID, turn: 'U1', transcript: b.sx.transcript, call: '7' })
  assert.equal(file?.loops, 1)
  assert.deepEqual(
    threadFile(w)?.held.map((e) => [e.call, e.site, e.turn, e.question]),
    [['7', 'tool', 'U1', key]],
  )
})

test('question: the form names the credit balance when credits can pay past 100% (CX46)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  w.reading(SID, 92, { reset: RESET, credits: { has_credits: true, unlimited: false, balance: '17.50' } })
  const s = await b.sense.sense(b.sx, 'tool')
  const a = await b.sense.act(b.sx, s, { site: 'tool' })
  hold(b, heldCall(), s, a)
  await w.settle()
  const q = questionOf('loop', s, a, s.now)
  assert.deepEqual(b.mcp.requests, [elicitParams(questionText(q.facts, 'loop', 'hold', true), '17.50')])
  assert.match(JSON.stringify(b.mcp.requests[0]), new RegExp(codexText.creditsQuestion('17.50').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('question: Resume releases the call, writes the consent at its tier, and queues the continuing line', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const { s, a } = await tripped(w, b)
  const call = heldCall()
  const { key, out } = hold(b, call, s, a)
  await w.settle()
  const q = questionFile(w)
  assert.ok(q !== undefined)
  b.mcp.answer('resume')
  assert.equal(await out, 'resume')
  assert.equal(w.state().consent, formatConsent(SID, RESET, 95), 'B49: to the floor point')
  assert.deepEqual(texts(w), [resumeNotice(q, T0)])
  assert.deepEqual(answerFile(w), { v: 1, by: answerFile(w)?.by, key, outcome: 'resume', via: 'dialog', at: T0, answered: [{ kind: 'five_hour', test: false, to: 95 }] })
  assert.equal(existsSync(w.file('question.json')), false)
  assert.deepEqual(threadFile(w)?.held, [])
  assert.deepEqual(b.questions.answeredOf(b.sx, key), [{ kind: 'five_hour', test: false, to: 95 }])
  // The round after the Resume passes this kind (B38, B50).
  const again = await b.sense.sense(b.sx, 'tool')
  assert.deepEqual((await b.sense.act(b.sx, again, { site: 'tool', resumed: b.questions.answeredOf(b.sx, key) })).verdict, { kind: 'pass', trip: true })
})

test('question: Stop here writes the stop record and its line, and the hosted call is interrupted once', async (t) => {
  const w = logicWorld(t, { daemon: true })
  w.daemon.script.loaded = [SID]
  w.daemon.script.newestTurn = { id: 'U1', status: 'inProgress', startedAt: Math.floor(T0 / 1000) - 5 }
  const b = w.broker()
  const { s, a } = await tripped(w, b)
  const call = heldCall({ turn: 'U1' })
  const { key, out } = hold(b, call, s, a)
  await w.settle()
  b.mcp.answer('stop')
  assert.equal(await out, 'stop')
  await w.settle() // the sweep runs after the settle's lock
  const r = parseStopped(w.state().stopped)
  assert.deepEqual(
    r && { kinds: r.kinds, windowEnd: r.windowEnd, work: r.work, auto: r.auto, skip: r.skip, real: r.real },
    { kinds: ['five_hour'], windowEnd: RESET - 20 * MIN, work: true, auto: true, skip: true, real: [{ kind: 'five_hour', resetsAtMs: RESET }] },
  )
  assert.equal(w.state().stopMeta, undefined)
  const lines = w.state().notices ?? []
  assert.equal(lines.length, 1)
  assert.equal(lines[0]?.tag, 'stop')
  assert.match(lines[0]?.text ?? '', /^stopped at your 10% reserve until /)
  assert.equal(answerFile(w)?.key, key)
  // The stop sweep of the settle interrupted the running turn of the session.
  assert.deepEqual(w.daemon.callsOf('interrupt'), [[SID, 'U1']])
  // The held call refuses by its mode: hosted, so interrupt, which the sweep already did: no second interrupt.
  const res = await b.refusal.refusal(b.sx, call, 'tool', 'stop', s, a)
  assert.deepEqual(res, { kind: 'deny', text: refusalText('stop', s, a, SID) })
  assert.deepEqual(w.daemon.callsOf('interrupt'), [[SID, 'U1']])
  assert.equal(typeof w.state().interrupts?.['U1'], 'number')
})

test('question: three parallel calls of two threads get one form, and one Resume releases them all', async (t) => {
  const w = logicWorld(t)
  const root = w.broker()
  const child = w.broker({ thread: CHILD })
  const { s, a } = await tripped(w, root)
  const one = hold(root, heldCall({ turn: 'U1' }), s, a)
  const two = hold(root, heldCall({ turn: 'U1' }), s, a)
  const c = await tripped(w, child)
  const three = hold(child, heldCall({ turn: 'C1' }), c.s, c.a)
  assert.equal(two.key, one.key)
  assert.equal(three.key, one.key)
  await w.settle()
  assert.equal(root.mcp.requests.length + child.mcp.requests.length, 1)
  assert.equal(questionFile(w)?.loops, 3)
  root.mcp.answer('resume')
  assert.deepEqual(await Promise.all([one.out, two.out, three.out]), ['resume', 'resume', 'resume'])
})

test('question: cancel after the leader turn ended hands the question on, and a held call of another thread raises again', async (t) => {
  const w = logicWorld(t)
  const root = w.broker()
  const child = w.broker({ thread: CHILD })
  const { s, a } = await tripped(w, root)
  const leader = heldCall({ turn: 'U1' })
  const first = hold(root, leader, s, a)
  const c = await tripped(w, child)
  const second = hold(child, heldCall({ turn: 'C1' }), c.s, c.a)
  await w.settle()
  assert.equal(root.mcp.requests.length, 1)
  w.rollout(SID).turnAborted('U1', Math.floor(T0 / 1000), T0)
  root.mcp.answer('cancel')
  await w.settle()
  assert.equal(await first.out, 'dropped')
  assert.equal(leader.dropped.aborted, true)
  assert.equal(child.mcp.requests.length, 1, 'the child raises the second form')
  const q = questionFile(w)
  assert.equal(q?.handoffs, 1)
  assert.equal(q?.leader?.threadId, CHILD)
  assert.ok(w.log.lines.includes(debugLine.handedOn(1)))
  child.mcp.answer('resume')
  assert.equal(await second.out, 'resume')
})

test('question: cancel while the leader turn still runs is Stop here (Esc on the form)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const { s, a } = await tripped(w, b)
  const { out } = hold(b, heldCall({ turn: 'U1' }), s, a)
  await w.settle()
  b.mcp.answer('cancel')
  await w.advance(500)
  assert.equal(await out, 'stop')
  assert.equal(answerFile(w)?.via, 'dialog')
  assert.ok(parseStopped(w.state().stopped) !== undefined)
})

test('question: decline is a held stop, never the person answer (A5)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const { s, a } = await tripped(w, b)
  const { key, out } = hold(b, heldCall(), s, a)
  await w.settle()
  b.mcp.answer('decline')
  assert.equal(await out, 'stop')
  assert.deepEqual(w.state().stopMeta, { noDialog: true })
  assert.equal(b.questions.answerFor(b.sx, key)?.noDialog, true)
  assert.equal(b.questions.answerFor(b.sx, key)?.via, 'could not ask')
  assert.equal(w.state().consent, undefined)
})

test('question: a client with no form capability gives a held stop with no request (A5)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker({ form: false })
  const { s, a } = await tripped(w, b)
  const { out } = hold(b, heldCall(), s, a)
  assert.equal(await out, 'stop')
  assert.deepEqual(b.mcp.requests, [])
  assert.deepEqual(w.state().stopMeta, { noDialog: true })
})

test('question: an elicitation error is a held stop, and a broker that shuts down leaves the question to the next one', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const { s, a } = await tripped(w, b)
  const call = heldCall()
  const { out } = hold(b, call, s, a)
  await w.settle()
  b.mcp.shut()
  await w.settle()
  assert.equal(answerFile(w), undefined, 'no outcome at shutdown')
  call.drop()
  assert.equal(await out, 'dropped')
  const b2 = w.broker()
  const x = await tripped(w, b2)
  const again = hold(b2, heldCall(), x.s, x.a)
  await w.settle()
  b2.mcp.answer('error')
  assert.equal(await again.out, 'stop')
  assert.deepEqual(w.state().stopMeta, { noDialog: true })
})

test('question: a stale answer after the question ended as again is ignored', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const { s, a } = await tripped(w, b)
  const { out } = hold(b, heldCall(), s, a)
  await w.settle()
  // The quota falls out of the reserve: the next check releases the held work with no answer.
  w.reading(SID, 50, { reset: RESET })
  await w.advance(60 * SEC)
  assert.equal(await out, 'again')
  // A skip owner names the window as reset (flow.againNotice), as register.tsx does.
  assert.deepEqual(texts(w), [notice.resetContinues([{ kind: 'five_hour', test: false }])])
  b.mcp.answer('stop')
  await w.settle()
  assert.equal(answerFile(w)?.outcome, 'again')
  assert.equal(w.state().stopped, undefined)
})

test('question: a leader that leaves hands the question on, and past the hand-off limit it is Stop here', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const { s, a } = await tripped(w, b)
  const call = heldCall()
  const { key, out } = hold(b, call, s, a)
  await w.settle()
  call.drop()
  assert.equal(await out, 'dropped')
  assert.equal(questionFile(w)?.handoffs, 1)
  assert.equal(questionFile(w)?.leader, null)
  // Four more hand-offs, then the fifth leader leaves: Stop here.
  b.sx.store.locked((tx) => tx.setQuestion({ ...(tx.question() as QuestionRecord), handoffs: 5 }))
  const last = heldCall()
  const again = hold(b, last, s, a)
  assert.equal(again.key, key)
  await w.settle()
  last.drop()
  assert.equal(await again.out, 'dropped')
  await w.settle()
  assert.deepEqual(
    answerFile(w) && [answerFile(w)?.key, answerFile(w)?.outcome, answerFile(w)?.via],
    [key, 'stop', 'dialog ended without an answer'],
  )
})

test('question: the last waiter that leaves forgets a question older than 90 s, and a younger one stays for a new waiter', async (t) => {
  const w = logicWorld(t)
  const b = w.broker({ hostKind: 'exec', env: { SPARE10_HEADLESS: 'wait' }, originator: 'codex_exec', source: 'exec' })
  const { s, a } = await tripped(w, b)
  assert.deepEqual(a.verdict, { kind: 'hold' })
  const young = heldCall()
  const one = hold(b, young, s, a)
  assert.equal(questionFile(w)?.silent, true)
  await w.advance(10 * SEC)
  young.drop()
  assert.equal(await one.out, 'dropped')
  assert.equal(questionFile(w)?.key, one.key, 'younger than 90 s: it stays')
  const old = heldCall()
  const two = hold(b, old, s, a)
  assert.equal(two.key, one.key)
  await w.advance(BEAT_STALE_MS)
  old.drop()
  assert.equal(await two.out, 'dropped')
  assert.equal(existsSync(w.file('question.json')), false)
  assert.deepEqual(b.mcp.requests, [], 'a silent question never shows a form')
})

test('question: a consent that the CLI wrote decides the question elsewhere, and the late form answer is ignored', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const { s, a } = await tripped(w, b)
  const { key, out } = hold(b, heldCall(), s, a)
  await w.settle()
  w.setState({ consent: formatConsent(SID, RESET, 95) })
  assert.equal(await out, 'resume')
  assert.deepEqual([answerFile(w)?.key, answerFile(w)?.outcome, answerFile(w)?.via], [key, 'resume', 'elsewhere'])
  b.mcp.answer('stop')
  await w.settle()
  assert.equal(w.state().stopped, undefined)
})

test('question: a consent to the floor does not answer a question asked at the floor, a full one does (B50)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const { s, a } = await tripped(w, b, 96)
  const { out } = hold(b, heldCall(), s, a)
  await w.settle()
  w.setState({ consent: formatConsent(SID, RESET, 95) })
  await w.settle()
  assert.equal(answerFile(w), undefined)
  w.setState({ consent: formatConsent(SID, RESET) })
  assert.equal(await out, 'resume')
})

test('question: a stop of this session newer than the question settles it, an older one does not (R6)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const { s, a } = await tripped(w, b)
  w.setState({ stopped: formatStopped({ sessionId: SID, windowEnd: RESET, at: T0 - MIN, kinds: ['five_hour'], auto: true }) })
  const { out } = hold(b, heldCall(), s, a)
  await w.settle()
  assert.equal(answerFile(w), undefined, 'a stop older than the question')
  await w.advance(SEC)
  w.setState({ stopped: formatStopped({ sessionId: 'another', windowEnd: RESET, at: T0 + SEC, kinds: ['five_hour'], auto: true }) })
  await w.settle()
  assert.equal(answerFile(w), undefined, 'a stop of another session')
  w.setState({ stopped: formatStopped({ sessionId: SID, windowEnd: RESET, at: T0 + SEC, kinds: ['five_hour'], auto: true }) })
  assert.equal(await out, 'stop')
  assert.equal(answerFile(w)?.via, 'elsewhere')
})

test('question: a second broker joins in the same tick as the leader leaves, and the question survives', async (t) => {
  const w = logicWorld(t)
  const root = w.broker()
  const child = w.broker({ thread: CHILD })
  const { s, a } = await tripped(w, root)
  const leader = heldCall({ turn: 'U1' })
  const first = hold(root, leader, s, a)
  await w.settle()
  const c = await tripped(w, child)
  leader.drop()
  const second = hold(child, heldCall({ turn: 'C1' }), c.s, c.a)
  assert.equal(second.key, first.key)
  assert.equal(await first.out, 'dropped')
  await w.settle()
  assert.equal(questionFile(w)?.key, first.key)
  assert.equal(child.mcp.requests.length, 1)
  child.mcp.answer('resume')
  assert.equal(await second.out, 'resume')
})

test('question: a deleted question with no answer makes the waiter decide again, never Stop here', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const { s, a } = await tripped(w, b)
  const { out } = hold(b, heldCall(), s, a)
  await w.settle()
  b.sx.store.locked((tx) => tx.setQuestion(undefined))
  assert.equal(await out, 'again')
  assert.equal(w.state().stopped, undefined)
})

test('question: a question whose leader broker died, with no live waiter, is replaced at the next open', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const other = w.broker({ thread: CHILD })
  const { s, a } = await tripped(w, b)
  // What a broker that died at a daemon restart leaves: its question and its held entry. A new broker of
  // the same thread beats the thread file, so the beat alone does not show that the entry is dead.
  const deadKey = `${SID}:${T0}:deadbeef`
  const leftBehind = (live: boolean): void =>
    b.sx.store.locked((tx) => {
      tx.setQuestion({ ...questionOf('loop', s, a, T0), key: deadKey, leader: { brokerId: 'broker-999', pid: 999, threadId: SID, call: '1' }, createdAt: T0 })
      tx.thread(SID).held = [{ call: '1', site: 'tool', turn: 'U0', since: T0, question: deadKey, brokerPid: 999, hostPid: 4000 }]
      tx.thread(SID).beat = T0
      tx.thread(CHILD).held = live ? [{ call: '5', site: 'tool', turn: 'C0', since: T0, question: deadKey, brokerPid: other.pid, hostPid: 4000 }] : []
      tx.thread(CHILD).beat = T0
    })
  // A live held entry of another thread still waits on it: it is joined, and its waiter raises it again.
  leftBehind(true)
  assert.equal(b.questions.ensureQuestion(b.sx, heldCall(), 'loop', s, a), deadKey)
  // No live held entry: it is replaced at once.
  leftBehind(false)
  const x = await tripped(w, b)
  const second = hold(b, heldCall(), x.s, x.a)
  assert.notEqual(second.key, deadKey)
  await w.settle()
  assert.equal(b.mcp.requests.length, 1)
})

test('question: a live waiter of another broker raises again when the leader broker dies', async (t) => {
  const w = logicWorld(t)
  const root = w.broker()
  const child = w.broker({ thread: CHILD })
  const { s, a } = await tripped(w, root)
  hold(root, heldCall({ turn: 'U1' }), s, a)
  const c = await tripped(w, child)
  const second = hold(child, heldCall({ turn: 'C1' }), c.s, c.a)
  await w.settle()
  assert.equal(root.mcp.requests.length, 1)
  w.alive.delete(root.pid)
  await w.advance(30 * SEC)
  assert.equal(child.mcp.requests.length, 1)
  child.mcp.answer('resume')
  assert.equal(await second.out, 'resume')
})

test('question: past the hold limit the waiter settles as Stop here with the hold-limit line', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const { s, a } = await tripped(w, b)
  const call = heldCall({ since: T0 - HOLD_LIMIT_MS + MIN })
  const { out } = hold(b, call, s, a)
  await w.settle()
  await w.advance(MIN)
  assert.equal(await out, 'stop')
  assert.equal(answerFile(w)?.via, 'time limit')
  assert.match(texts(w)[0] ?? '', /^the hold reached its time limit\. /)
})

test('question: past the hold limit a waiter whose question file has another format answers Stop here (fail closed)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const { s, a } = await tripped(w, b)
  const call = heldCall({ since: T0 - HOLD_LIMIT_MS + MIN })
  const { key, out } = hold(b, call, s, a)
  let done = false
  void out.then(() => {
    done = true
  })
  await w.settle()
  // A newer spare10 rewrites the question in its own format. No settle can write it now.
  writeFileSync(w.file('question.json'), JSON.stringify({ ...questionFile(w), v: 2 }))
  await w.advance(30 * SEC)
  assert.equal(done, false, 'before the limit the call holds')
  await w.advance(MIN)
  assert.equal(await out, 'stop')
  assert.notEqual(answerFile(w)?.key, key, 'nothing settled the question')
})

test('question: with Continue at the reset on, the held work continues at the skip start with the notice', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const soon = T0 + 25 * MIN // the skip start is at T0 + 5 min
  const { s, a } = await tripped(w, b, 92, soon)
  const { key, out } = hold(b, heldCall(), s, a)
  const q = questionFile(w)
  assert.equal(q?.skip, true)
  assert.equal(q?.due, soon - 20 * MIN)
  await w.advance(5 * MIN)
  assert.equal(await out, 'again')
  assert.deepEqual([answerFile(w)?.key, answerFile(w)?.via], [key, 'reset'])
  assert.equal(texts(w).length, 1)
  assert.match(texts(w)[0] ?? '', /Held work continues\.$/)
})

test('question: with Continue at the reset off, one note at the skip start, and the work waits for the answer (B6, B43)', async (t) => {
  const w = logicWorld(t, { config: { autoResume: false } })
  const b = w.broker()
  const soon = T0 + 25 * MIN
  const { s, a } = await tripped(w, b, 92, soon)
  const { out } = hold(b, heldCall(), s, a)
  let done = false
  void out.then(() => {
    done = true
  })
  await w.advance(15 * MIN)
  assert.equal(done, false)
  assert.equal(texts(w).length, 1)
  assert.match(texts(w)[0] ?? '', /held work still waits for your answer\. New work goes on with no question\.$/)
  assert.equal(questionFile(w)?.noted, true)
  b.mcp.answer('resume')
  assert.equal(await out, 'resume')
})

test('question: a silent question shows no form, and at its due time it reads the daemon before it releases', async (t) => {
  const w = logicWorld(t, { daemon: true })
  const b = w.broker({ hostKind: 'exec', env: { SPARE10_HEADLESS: 'wait' }, originator: 'codex_exec', source: 'exec' })
  w.daemon.script.rateLimits = new Error('no daemon read in this case')
  const soon = T0 + 25 * MIN
  const { s, a } = await tripped(w, b, 92, soon)
  const { out } = hold(b, heldCall(), s, a)
  await w.advance(5 * MIN)
  assert.equal(await out, 'again')
  assert.deepEqual(b.mcp.requests, [])
  assert.ok(w.daemon.callsOf('rateLimits').length >= 1, 'the check reads the daemon first')
})

test('question: openQuestion and answerFor read the files of the session', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  assert.equal(b.questions.openQuestion(b.sx), undefined)
  const { s, a } = await tripped(w, b)
  const { key, out } = hold(b, heldCall(), s, a)
  assert.equal(b.questions.openQuestion(b.sx)?.key, key)
  assert.equal(b.questions.answerFor(b.sx, key), undefined)
  await w.settle()
  b.mcp.answer('resume')
  await out
  assert.equal(b.questions.openQuestion(b.sx), undefined)
  assert.equal(b.questions.answerFor(b.sx, key)?.outcome, 'resume')
  assert.equal(b.questions.answerFor(b.sx, 'another'), undefined)
})

test('question: a settle by command raises a kind at the floor to a full Resume (B50 item 4)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const { s, a } = await tripped(w, b)
  const { key, out } = hold(b, heldCall(), s, a)
  await w.settle()
  // The reading passed the floor while the question waited: the resume command consents until the reset.
  w.reading(SID, 96, { reset: RESET })
  const now = await b.sense.sense(b.sx, 'prompt')
  const r = await b.questions.settle(b.sx, key, 'resume', 'command', { raiseAt: now })
  assert.equal(r.q?.key, key)
  assert.equal(r.q?.ends.five_hour?.to, undefined)
  assert.equal(await out, 'resume')
  assert.equal(w.state().consent, formatConsent(SID, RESET))
  assert.deepEqual(texts(w), [], 'a command writes no transcript line: its reply says it')
})

test('question: a Resume at the reserve consents to the floor, and at the floor the second question asks until the reset (B48)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const first = await tripped(w, b, 91)
  const one = hold(b, heldCall(), first.s, first.a)
  await w.settle()
  b.mcp.answer('resume')
  assert.equal(await one.out, 'resume')
  assert.equal(w.state().consent, formatConsent(SID, RESET, 95))
  // Below the floor point the window is consented.
  const below = await tripped(w, b, 94.9)
  assert.deepEqual(below.a.verdict, { kind: 'pass', trip: true })
  // At the floor point: the consent ends for good, and one second question holds the loop.
  const at = await tripped(w, b, 95)
  assert.deepEqual(at.a.verdict, { kind: 'hold' })
  assert.deepEqual(w.state().tombs, { five_hour: [{ until: RESET, to: 95 }] })
  const two = hold(b, heldCall(), at.s, at.a)
  await w.settle()
  const q = questionFile(w)
  assert.notEqual(q?.key, one.key)
  assert.deepEqual(q?.ends.five_hour, { end: RESET, test: false, skipAt: RESET - 20 * MIN }, 'asked at the floor: no end point')
  assert.equal(q?.facts[0]?.floor, 5)
  b.mcp.answer('resume')
  assert.equal(await two.out, 'resume')
  assert.equal(w.state().consent, formatConsent(SID, RESET), 'the second Resume lasts until the reset')
})

test('question: a Stop here after the skip start with Continue at the reset off writes nothing, and says that new work goes on (B46)', async (t) => {
  const w = logicWorld(t, { config: { autoResume: false } })
  const b = w.broker()
  const soon = T0 + 25 * MIN // the skip start is at T0 + 5 min
  const { s, a } = await tripped(w, b, 92, soon)
  const { out } = hold(b, heldCall(), s, a)
  await w.advance(6 * MIN)
  w.reading(SID, 92, { reset: soon })
  b.mcp.answer('stop')
  assert.equal(await out, 'stop')
  assert.equal(w.state().stopped, undefined)
  const lines = (w.state().notices ?? []).filter((n) => n.tag === 'stop').map((n) => n.text)
  assert.equal(lines.length, 1)
  assert.match(lines[0] ?? '', /^stopped\. Held work is refused\. .*, so new work goes on with no question\.$/)
})
