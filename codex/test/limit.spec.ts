import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexText, elicitParams, withPrefix } from '../../hooks/core/codex.ts'
import { formatConsent, formatStopped, parseStopped } from '../../hooks/core/decide.ts'
import { LIMIT_OFF, atText, debugLine, headlessText, limitQuestionText, notice, resumeReply, stopReply } from '../../hooks/core/text.ts'
import { readJson } from '../src/files.ts'
import type { QuestionRecord } from '../src/question.ts'
import { BEAT_STALE_MS } from '../src/timing.ts'
import type { AnswerFile } from '../src/store.ts'
import { heldCall, logicWorld } from './helpers/logic.ts'
import type { LogicWorld } from './helpers/logic.ts'
import { CHILD, HOUR, MIN, SEC, SID, T0, parsed, world } from './helpers/world.ts'
import type { World, WorldBroker } from './helpers/world.ts'

// The pause at the quota limit through the gate (limit design 1 to 3, 5 step 4, 6.3). At 100% used with a
// known reset and no credits that pay, a watched kind is at the quota limit: it gates also in the open
// reserve, and the limit form asks Continue at the reset (first and the default) or Stop here. Only Stop
// here stops. Esc while the turn runs, a decline, an error and no form continue at the reset. The held
// calls wait in place and pass after the reset plus the margin. LIM lies inside the last 20 min, where the
// reserve of today is open.
//
// The kit port (8.2):
// Each tests/kit case and the Codex case that tests it: codex/test/kit-port.txt, kept complete by kit-port.spec.ts.

const LIM = T0 + 10 * MIN
const MARGIN = 5 * MIN
const AT = atText(LIM, ['five_hour'])

const question = (w: Pick<World | LogicWorld, 'file'>): QuestionRecord | undefined => readJson<QuestionRecord>(w.file('question.json'))
const answer = (w: Pick<World | LogicWorld, 'file'>): AnswerFile | undefined => readJson<AnswerFile>(w.file('answer.json'))
const params = (b: WorldBroker, n: number): Record<string, unknown> => b.forms()[n]?.['params'] as Record<string, unknown>
const typed = async (b: WorldBroker, prompt: string): Promise<string> => parsed(await b.gate('prompt', { prompt }))['reason'] as string
const lineOf = (text: string | undefined): string | undefined => parsed(text)['systemMessage'] as string | undefined

/** A held tool call at the limit with its one limit form up. */
async function heldAtLimit(w: World, b: WorldBroker, reset = LIM) {
  w.reading(SID, 100, { reset })
  const n = b.forms().length
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false, 'the call holds')
  assert.equal(b.forms().length, n + 1, 'one limit form')
  const q = question(w)
  assert.ok(q !== undefined)
  assert.equal(q.limit, true)
  assert.deepEqual(params(b, n), elicitParams(limitQuestionText(q.facts, q.opener, q.auto), undefined, true))
  return { h, q }
}

const CONTINUE = { action: 'accept', content: { choice: 'continue' } }
const STOP = { action: 'accept', content: { choice: 'stop' } }

test('limit: at 100% in the open reserve a held tool call asks the limit form, and with no answer it passes after the reset', async (t) => {
  const w = world(t)
  const b = await w.broker()
  const { h, q } = await heldAtLimit(w, b)
  assert.equal(q.holdEnd, LIM)
  assert.equal(q.due, LIM + MARGIN)
  const choice = ((params(b, 0)['requestedSchema'] as Record<string, unknown>)['properties'] as Record<string, Record<string, unknown>>)['choice']
  assert.deepEqual(choice?.['oneOf'], [
    { const: 'continue', title: 'Continue at the reset' },
    { const: 'stop', title: 'Stop here' },
  ])
  assert.equal(choice?.['default'], 'continue')
  await w.advance(LIM + MARGIN - T0 - 30 * SEC)
  assert.equal(h.box.done, false, 'inside the margin after the reset')
  await w.advance(MIN)
  assert.equal(h.box.done, true)
  assert.equal(lineOf(h.box.text), withPrefix(notice.resetContinues([{ kind: 'five_hour', test: false }])))
  assert.equal(w.state().stopped, undefined)
  assert.equal(w.state().consent, undefined)
})

test('limit: Continue at the reset keeps the call held with no second form, and the line comes', async (t) => {
  const w = world(t)
  const b = await w.broker()
  const { h, q } = await heldAtLimit(w, b)
  b.host.answer(CONTINUE)
  await w.settle()
  assert.equal(h.box.done, false)
  assert.equal(question(w)?.chosen, true)
  assert.equal(question(w)?.leader, null)
  assert.deepEqual(w.notices(), [notice.limitContinues(q.facts)])
  const h2 = b.call('step')
  await w.settle()
  assert.equal(h2.box.done, false, 'a new call joins the chosen question')
  await w.advance(3 * MIN)
  assert.equal(b.forms().length, 1, 'no second form')
  await w.advance(LIM + MARGIN - T0)
  assert.equal(h.box.done, true)
  assert.equal(h2.box.done, true)
  assert.equal(w.state().consent, undefined)
})

test('limit: Stop here writes a stop with no auto, and the ticker starts no turn after the reset', async (t) => {
  const w = world(t, { daemon: true })
  const b = await w.broker({ hosted: true })
  w.daemon.script.newestTurn = { id: 'U1', status: 'inProgress', startedAt: Math.floor(T0 / 1000) - 60 }
  const { h } = await heldAtLimit(w, b)
  b.host.answer(STOP)
  await w.settle()
  assert.equal(h.box.done, true)
  const r = parseStopped(w.state().stopped)
  assert.deepEqual(r && { kinds: r.kinds, windowEnd: r.windowEnd, work: r.work, auto: r.auto, skip: r.skip }, {
    kinds: ['five_hour'],
    windowEnd: LIM,
    work: true,
    auto: false,
    skip: undefined,
  })
  assert.ok(w.notices().includes(notice.limitStopped(AT)) || (lineOf(h.box.text) ?? '').includes(notice.limitStopped(AT)))
  w.daemon.script.newestTurn = { id: 'U1', status: 'interrupted', startedAt: Math.floor(T0 / 1000) - 60 }
  await w.advance(LIM + MARGIN - T0 + 2 * MIN)
  assert.deepEqual(w.daemon.callsOf('start'), [], 'nothing continues the stop')
})

test('limit: Esc and a decline on the limit form continue at the reset', async (t) => {
  for (const [name, reply] of [
    ['cancel', { action: 'cancel' }],
    ['decline', { action: 'decline' }],
    ['error', { error: { code: -32000, message: 'no form here' } }],
  ] as const) {
    const w = world(t)
    const b = await w.broker()
    const { h, q } = await heldAtLimit(w, b)
    b.host.answer(reply)
    await w.advance(500)
    assert.equal(h.box.done, false, name)
    assert.equal(question(w)?.chosen, true, name)
    assert.equal(w.state().stopped, undefined, name)
    assert.deepEqual(w.notices(), [notice.limitContinues(q.facts)], name)
    await w.advance(LIM + MARGIN - T0)
    assert.equal(h.box.done, true, name)
    assert.equal(b.forms().length, 1, name)
  }
})

test('limit: a question at the reserve gives way to the limit form at the next step', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: T0 + 2 * HOUR })
  const h1 = b.call('tool')
  await w.settle()
  const first = question(w)
  assert.equal(first?.limit, undefined)
  assert.equal(b.forms().length, 1)
  w.reading(SID, 100, { reset: T0 + 2 * HOUR })
  const h2 = b.call('step')
  await w.settle()
  const a = answer(w)
  assert.deepEqual(a && { key: a.key, outcome: a.outcome, via: a.via }, { key: first?.key, outcome: 'again', via: 'limit' })
  assert.equal(question(w)?.limit, true)
  assert.equal(b.forms().length, 2, 'the limit form')
  assert.ok(w.notices().includes(notice.limitReached))
  assert.equal(h1.box.done, false, 'the first call decides again and joins the limit question')
  assert.equal(h2.box.done, false)
  // The reserve form stays on the screen, and its answer finds no open question.
  b.host.answer({ action: 'accept', content: { choice: 'resume' } })
  await w.settle()
  assert.equal(w.state().consent, undefined)
  assert.equal(h1.box.done, false)
  b.host.answer(STOP)
  await w.settle()
  // Stop here on the limit form: a stop with no auto. Each call refuses by its mode (one deny per thread and turn, 4.4).
  assert.equal(parseStopped(w.state().stopped)?.auto, false)
  assert.ok(h1.box.done || h2.box.done)
})

test('limit: both windows wait for the later reset', async (t) => {
  const w = world(t)
  const b = await w.broker()
  const weekly = T0 + HOUR
  w.reading(SID, 100, { reset: LIM, weekly: 100, weeklyReset: weekly })
  const h = b.call('tool')
  await w.settle()
  const q = question(w)
  assert.deepEqual([q?.kinds, q?.holdEnd, q?.due], [['five_hour', 'seven_day'], weekly, weekly + MARGIN])
  assert.match(params(b, 0)['message'] as string, /^The quota limits of both windows are reached: 5-hour window 100% used/)
  b.host.answer(CONTINUE)
  await w.advance(LIM + MARGIN - T0 + MIN)
  assert.equal(h.box.done, false, 'the weekly limit still holds after the 5-hour reset')
  await w.advance(weekly + MARGIN - w.clock.now() + MIN)
  assert.equal(h.box.done, true)
  assert.equal(b.forms().length, 1)
})

test('limit: spare10 resume chooses Continue at the reset and writes no consent', async (t) => {
  const w = world(t)
  const b = await w.broker()
  const { h, q } = await heldAtLimit(w, b)
  assert.equal(await typed(b, 'spare10 resume'), `spare10: ${resumeReply('limit-asking', q.facts)}`)
  assert.equal(question(w)?.chosen, true)
  assert.equal(w.state().consent, undefined)
  assert.equal(w.notices().includes(notice.limitContinues(q.facts)), false, 'the reply says it, no transcript line')
  // The form stays on the screen: its late Stop here finds no leader and changes nothing.
  b.host.answer(STOP)
  await w.settle()
  assert.equal(w.state().stopped, undefined)
  assert.equal(h.box.done, false)
  assert.equal(await typed(b, 'spare10 resume'), `spare10: ${resumeReply('limit', q.facts)}`)
  await w.advance(LIM + MARGIN - T0)
  assert.equal(h.box.done, true)
})

test('limit: spare10 stop writes a stop with no auto', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 100, { reset: LIM })
  assert.equal(await typed(b, 'spare10 stop'), `spare10: ${stopReply('limit', undefined, undefined, { at: AT })}`)
  const r = parseStopped(w.state().stopped)
  assert.deepEqual(r && { kinds: r.kinds, windowEnd: r.windowEnd, auto: r.auto }, { kinds: ['five_hour'], windowEnd: LIM, auto: false })
  assert.equal(b.forms().length, 0)
})

test('limit: unattended wait holds and stop refuses at the limit in the open reserve', async (t) => {
  const w = world(t)
  const b = await w.broker({ hostKind: 'exec', env: { SPARE10_HEADLESS: 'wait' } })
  w.reading(SID, 100, { reset: LIM })
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false, 'wait holds, also in the open reserve')
  assert.equal(b.forms().length, 0)
  await w.advance(LIM + MARGIN - T0 + MIN)
  assert.equal(h.box.done, true)
  const v = world(t)
  const c = await v.broker({ hostKind: 'exec', env: { SPARE10_HEADLESS: 'stop' } })
  v.reading(SID, 100, { reset: LIM })
  const out = parsed(await c.gate('tool'))
  const reason = (out['hookSpecificOutput'] as Record<string, unknown>)['permissionDecisionReason'] as string
  assert.match(reason, /^spare10 stopped this unattended run at the quota limit \(100% of quota used · resets /)
  assert.ok(reason.endsWith(`To pick it up later: codex exec resume ${SID}`))
  assert.equal(reason, headlessText(question(v)?.facts ?? [{ used: 100, left: 0, resetsAtMs: LIM, reserve: 10, limit: true }], SID))
})

test('limit: the Stop gate ends the turn with the limit line (CX55)', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 100, { reset: LIM })
  assert.deepEqual(parsed(await b.gate('stop')), { continue: false, stopReason: codexText.turnEndsLimit })
  w.reading(SID, 92, { reset: T0 + 2 * HOUR })
  assert.deepEqual(parsed(await b.gate('stop')), { continue: false, stopReason: codexText.turnEndsHold })
})

test('limit: limitPause off lets the open reserve through, and the report warns (CX14)', async (t) => {
  const w = world(t, { config: { limitPause: false } })
  const b = await w.broker()
  w.reading(SID, 100, { reset: LIM })
  assert.equal(await b.gate('tool'), '')
  assert.equal(b.forms().length, 0)
  const report = await typed(b, 'spare10')
  assert.ok(report.includes(`⚠ ${codexText.hardStop}`))
  assert.ok(report.includes('  · at the limit   off. spare10 does not pause at the limit (from spare10 set)'))
  // On (the default), the report has neither.
  const v = world(t)
  const c = await v.broker()
  v.reading(SID, 100, { reset: LIM })
  const on = await typed(c, 'spare10')
  assert.equal(on.includes(codexText.hardStop), false)
  assert.equal(on.includes('at the limit   off'), false)
})

test('limit: a new broker joins a chosen limit question and shows no form', async (t) => {
  const w = world(t)
  const b = await w.broker()
  const { h } = await heldAtLimit(w, b)
  b.host.answer(CONTINUE)
  await w.settle()
  const sub = await w.broker({ thread: CHILD })
  const h2 = sub.call('tool')
  await w.settle()
  assert.equal(h2.box.done, false)
  assert.equal(sub.forms().length, 0)
  assert.equal(question(w)?.loops, 2)
  await w.advance(LIM + MARGIN - T0)
  assert.equal(h.box.done, true)
  assert.equal(h2.box.done, true)
})

test('limit: the report shows the limit phase line', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 100, { reset: LIM })
  const line = async (): Promise<string | undefined> => (await typed(b, 'spare10')).split('\n')[2]
  assert.equal(await line(), `  ‖ limit          the quota limit is reached until ${AT}. spare10 holds the next step and asks you. ${LIMIT_OFF}`)
  await heldAtLimit(w, b)
  b.host.answer(CONTINUE)
  await w.settle()
  assert.equal(await line(), `  ‖ limit          the quota limit is reached. Held work waits until ${AT}. Then spare10 continues it, unless a reserve is still reached. ${LIMIT_OFF}`)
})

test('limit: an approval never session holds at the limit with no form, and continues after the reset', async (t) => {
  const w = world(t)
  const b = await w.broker({ form: false, mode: 'bypassPermissions' })
  w.reading(SID, 100, { reset: LIM })
  const h = b.call('tool')
  await w.settle()
  assert.equal(h.box.done, false)
  assert.equal(b.forms().length, 0)
  assert.equal(question(w)?.chosen, true)
  assert.equal(w.state().stopped, undefined, 'no held stop at the limit')
  await w.advance(LIM + MARGIN - T0 + MIN)
  assert.equal(h.box.done, true)
})

test('limit: the 5-hour limit with the weekly window in its reserve asks the weekly question after the 5-hour reset', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 100, { reset: LIM, weekly: 92, weeklyReset: T0 + 72 * HOUR })
  const h = b.call('tool')
  await w.settle()
  assert.deepEqual(question(w)?.kinds, ['five_hour'], 'the limit question names only the kind at the limit')
  b.host.answer(CONTINUE)
  await w.advance(LIM + MARGIN - T0 + MIN)
  assert.equal(h.box.done, false, 'the weekly reserve still gates')
  const q = question(w)
  assert.deepEqual([q?.kinds, q?.limit], [['seven_day'], undefined])
  assert.equal(b.forms().length, 2)
  assert.match(params(b, 1)['message'] as string, /^Your 10% weekly reserve is reached: 92% used/)
  b.host.answer({ action: 'accept', content: { choice: 'resume' } })
  await w.settle()
  assert.equal(h.box.done, true)
})

test('limit: a typed prompt at the limit waits after Continue at the reset, and goes in after the reset', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 100, { reset: LIM })
  const h = b.call('prompt', { prompt: 'go on' })
  await w.settle()
  const q = question(w)
  assert.deepEqual([q?.opener, q?.limit], ['prompt', true])
  assert.equal(params(b, 0)['message'], limitQuestionText(q?.facts ?? [], 'prompt', true))
  b.host.answer(CONTINUE)
  await w.settle()
  assert.equal(h.box.done, false)
  await w.advance(LIM + MARGIN - T0 + MIN)
  assert.equal(h.box.done, true)
  assert.notEqual(parsed(h.box.text)['decision'], 'block', 'the prompt goes in')
})

/** The logic world: a held tool call at the limit, with its question open and its wait started. */
async function limitWait(w: LogicWorld, b: ReturnType<LogicWorld['broker']>, turn = 'U1', reset = LIM) {
  w.reading(b.thread, 100, { reset })
  const s = await b.sense.sense(b.sx, 'tool')
  const a = await b.sense.act(b.sx, s, { site: 'tool' })
  const call = heldCall({ turn })
  const key = b.questions.ensureQuestion(b.sx, call, 'loop', s, a)
  const box: { out?: string } = {}
  const out = b.questions.waitQuestion(b.sx, call, key).then((o) => {
    box.out = o
    return o
  })
  return { call, key, out, box }
}

// The logic world drives one wait with no gate round: a consent that answered the limit question would end
// the wait at once, and the spec fails fast instead of looping with a new question at each cycle.
test('limit: a consent in the state never answers the limit question, so the form stays and the call holds', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const { box } = await limitWait(w, b)
  await w.settle()
  assert.equal(b.mcp.requests.length, 1)
  w.setState({ consent: formatConsent(SID, LIM) }) // a full consent, as the CLI or a second Resume writes it
  await w.advance(2 * MIN)
  assert.equal(box.out, undefined, 'the call holds')
  assert.equal(answer(w), undefined, 'not decided elsewhere')
  assert.equal(question(w)?.limit, true)
  b.mcp.answer('stop')
  await w.settle()
  assert.equal(box.out, 'stop')
  assert.equal(parseStopped(w.state().stopped)?.auto, false)
})

test('limit: an auto stop at the reserve that is due at the limit lasts until the reset, and then one turn continues it', async (t) => {
  const w = world(t, { daemon: true })
  const b = await w.broker({ hosted: true })
  const reset = T0 + HOUR
  const skip = reset - 20 * MIN
  w.reading(SID, 100, { reset })
  w.setState({ stopped: formatStopped({ sessionId: SID, windowEnd: skip, at: T0, kinds: ['five_hour'], auto: true, work: true, skip: true }) })
  w.daemon.script.newestTurn = { id: 'U1', status: 'interrupted', startedAt: Math.floor(T0 / 1000) - 60 }
  await w.advance(skip - T0 + MIN)
  assert.deepEqual(w.daemon.callsOf('start'), [], 'the reserve would open at the skip start, but the limit holds')
  const r = parseStopped(w.state().stopped)
  assert.deepEqual(r && { windowEnd: r.windowEnd, auto: r.auto, skip: r.skip }, { windowEnd: reset, auto: true, skip: undefined })
  assert.ok(w.notices().some((n) => n.startsWith('your quota limit is reached. The stop lasts until ')))
  assert.equal(b.forms().length, 0)
  w.reading(SID, 3, { reset: reset + 5 * HOUR }) // the new window
  await w.advance(reset + MARGIN - w.clock.now() + MIN)
  assert.equal(w.daemon.callsOf('start').length, 1)
  assert.equal(w.state().stopped, undefined)
})

test('limit: spare10 stop on a question at the reserve after the quota reached 100% stops until the reset, with no auto', async (t) => {
  const w = world(t)
  const b = await w.broker()
  const reset = T0 + 2 * HOUR
  w.reading(SID, 92, { reset })
  b.call('tool')
  await w.settle()
  assert.equal(question(w)?.limit, undefined, 'the question at the reserve is open')
  w.reading(SID, 100, { reset }) // the quota reaches the limit before the next check
  assert.equal(await typed(b, 'spare10 stop'), `spare10: ${stopReply('asking')}`)
  const r = parseStopped(w.state().stopped)
  assert.deepEqual(r && { windowEnd: r.windowEnd, auto: r.auto, skip: r.skip, work: r.work }, { windowEnd: reset, auto: false, skip: undefined, work: true })
})

test('limit: Stop here on the form at the reserve after the quota reached 100% stops until the reset, with the limit line', async (t) => {
  const w = world(t)
  const b = await w.broker()
  const reset = T0 + 2 * HOUR
  w.reading(SID, 92, { reset })
  const h = b.call('tool')
  await w.settle()
  w.reading(SID, 100, { reset })
  b.host.answer(STOP)
  await w.settle()
  const r = parseStopped(w.state().stopped)
  assert.deepEqual(r && { windowEnd: r.windowEnd, auto: r.auto }, { windowEnd: reset, auto: false })
  const at = atText(reset, ['five_hour'], undefined, T0)
  assert.ok(w.notices().includes(notice.limitStopped(at)) || (lineOf(h.box.text) ?? '').includes(notice.limitStopped(at)))
})

test('limit: spare10 stop over an auto stop at the limit drops its auto, and replies with the limit text', async (t) => {
  const w = world(t)
  const b = await w.broker()
  const reset = T0 + HOUR
  w.reading(SID, 100, { reset })
  w.setState({ stopped: formatStopped({ sessionId: SID, windowEnd: reset, at: T0 - MIN, kinds: ['five_hour'], auto: true, work: true }) })
  assert.equal(await typed(b, 'spare10 stop'), `spare10: ${stopReply('limit', undefined, undefined, { at: atText(reset, ['five_hour'], undefined, T0) })}`)
  const r = parseStopped(w.state().stopped)
  assert.deepEqual(r && { windowEnd: r.windowEnd, auto: r.auto, work: r.work }, { windowEnd: reset, auto: false, work: true })
})

test('limit: the Stop gate after Stop here ends the turn with the limit line (CX56), and after Continue at the reset with CX57', async (t) => {
  const w = world(t)
  const b = await w.broker()
  await heldAtLimit(w, b)
  b.host.answer(STOP)
  await w.settle()
  assert.deepEqual(parsed(await b.gate('stop')), { continue: false, stopReason: codexText.turnEndsAtLimit })
  const v = world(t)
  const c = await v.broker()
  await heldAtLimit(v, c)
  c.host.answer(CONTINUE)
  await v.settle()
  const end = parsed(await c.gate('stop'))
  assert.deepEqual([end['continue'], end['stopReason']], [false, codexText.turnEndsLimitHeld(AT)])
})

test('limit: with limitPause off, a test reading at 100% gives no CX14 warning', async (t) => {
  const w = world(t, { config: { limitPause: false } })
  const b = await w.broker()
  w.reading(SID, 30, { reset: T0 + 2 * HOUR })
  await typed(b, 'spare10 simulate 100 in 2m')
  const report = await typed(b, 'spare10')
  assert.equal(report.includes(codexText.hardStop), false)
})

test('limit: Continue at the reset after the reset queues no line that names the passed reset', async (t) => {
  const w = world(t, { config: { autoResume: false } })
  const b = await w.broker()
  const { h, q } = await heldAtLimit(w, b)
  await w.advance(LIM + MARGIN - T0 + 2 * MIN)
  assert.equal(h.box.done, false, 'autoResume off: the work waits for the answer')
  w.reading(SID, 3, { reset: LIM + 5 * HOUR }) // the new window
  b.host.answer(CONTINUE)
  await w.advance(MIN)
  assert.equal(h.box.done, true)
  const shown = [...w.notices(), lineOf(h.box.text) ?? '']
  assert.equal(
    shown.some((l) => l.includes(notice.limitContinues(q.facts))),
    false,
  )
})

test('limit: Esc on the limit form after the leader turn ended hands it on, and a held call of another thread shows it again', async (t) => {
  const w = logicWorld(t)
  const root = w.broker()
  const child = w.broker({ thread: CHILD })
  const first = await limitWait(w, root, 'U1')
  const second = await limitWait(w, child, 'C1')
  assert.equal(second.key, first.key)
  await w.settle()
  assert.equal(root.mcp.requests.length, 1)
  w.rollout(SID).turnAborted('U1', Math.floor(T0 / 1000), T0)
  root.mcp.answer('cancel')
  await w.settle()
  assert.equal(await first.out, 'dropped')
  const q = question(w)
  assert.deepEqual([q?.handoffs, q?.chosen, q?.leader?.threadId], [1, undefined, CHILD])
  assert.ok(w.log.lines.includes(debugLine.handedOn(1)))
  assert.equal(child.mcp.requests.length, 1, 'the child shows the limit form again')
  assert.deepEqual(child.mcp.requests[0], root.mcp.requests[0])
})

test('limit: past the hand-off limit the limit question is chosen, with no stop, and the held work passes after the reset', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const first = await limitWait(w, b)
  await w.settle()
  b.sx.store.locked((tx) => tx.setQuestion({ ...(tx.question() as QuestionRecord), handoffs: 5 }))
  first.call.drop()
  assert.equal(await first.out, 'dropped')
  await w.settle()
  const q = question(w)
  assert.deepEqual([q?.key, q?.chosen, q?.leader], [first.key, true, null])
  assert.equal(answer(w), undefined, 'no Stop here')
  assert.equal(w.state().stopped, undefined)
  const next = await limitWait(w, b)
  assert.equal(next.key, first.key, 'a new call joins the chosen question')
  w.reading(SID, 3, { reset: LIM + 5 * HOUR }) // the new window
  await w.advance(LIM + MARGIN - T0 + MIN)
  assert.equal(await next.out, 'again')
  assert.equal(b.mcp.requests.length, 1)
})

test('limit: Stop here after the reset with autoResume off names no passed reset, and spare10 resume names none either', async (t) => {
  const w = world(t, { config: { autoResume: false } })
  const b = await w.broker()
  const { h } = await heldAtLimit(w, b)
  await w.advance(LIM + MARGIN - T0 + 2 * MIN)
  assert.equal(h.box.done, false, 'autoResume off: the work waits for the answer')
  w.reading(SID, 3, { reset: LIM + 5 * HOUR }) // the new window
  b.host.answer(STOP)
  await w.settle()
  assert.equal(h.box.done, true)
  const shown = [...w.notices(), lineOf(h.box.text) ?? '']
  assert.ok(shown.some((l) => l.includes(notice.limitStopped())))
  assert.equal(
    shown.some((l) => l.includes(notice.limitStopped(AT))),
    false,
  )
  const v = world(t, { config: { autoResume: false } })
  const c = await v.broker()
  const held = await heldAtLimit(v, c)
  await v.advance(LIM + MARGIN - T0 + 2 * MIN)
  v.reading(SID, 3, { reset: LIM + 5 * HOUR })
  assert.equal(await typed(c, 'spare10 resume'), `spare10: ${resumeReply('limit-late')}`)
  await v.settle()
  assert.equal(held.h.box.done, true)
})

test('limit: spare10 resume while a hand-off waits for a new leader shows no second form', async (t) => {
  const w = logicWorld(t)
  const root = w.broker()
  const child = w.broker({ thread: CHILD })
  const first = await limitWait(w, root, 'U1')
  const second = await limitWait(w, child, 'C1')
  assert.equal(second.key, first.key)
  await w.settle()
  assert.equal(root.mcp.requests.length, 1)
  // The leader went away, and the question waits for a new leader. spare10 resume chooses first.
  root.sx.store.locked((tx) => tx.setQuestion({ ...(tx.question() as QuestionRecord), leader: null, handoffs: 1 }))
  assert.equal(child.questions.choose(child.sx, first.key, 'command'), true)
  await w.advance(2 * MIN)
  assert.equal(question(w)?.chosen, true)
  assert.deepEqual([root.mcp.requests.length, child.mcp.requests.length], [1, 0], 'no second form')
  assert.equal(second.box.out, undefined, 'the call still holds')
})

test('limit: after Continue at the reset the chosen question outlives its held work for 90 s, and then the next call asks again', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const first = await limitWait(w, b)
  await w.settle()
  assert.equal(b.mcp.requests.length, 1)
  b.mcp.answer('resume') // an accept that is not stop: Continue at the reset
  await w.settle()
  assert.equal(question(w)?.chosen, true)
  first.call.drop()
  assert.equal(await first.out, 'dropped')
  // Unlike Claude Code, a question younger than 90 s stays for a new call of any broker (4.3).
  const young = await limitWait(w, b)
  assert.equal(young.key, first.key, 'younger than 90 s: a new call joins the chosen question')
  await w.settle()
  assert.equal(b.mcp.requests.length, 1, 'with no form')
  await w.advance(BEAT_STALE_MS)
  young.call.drop()
  assert.equal(await young.out, 'dropped')
  assert.equal(question(w), undefined, 'older than 90 s: the last call that leaves forgets it')
  const next = await limitWait(w, b)
  assert.notEqual(next.key, first.key)
  await w.settle()
  assert.equal(b.mcp.requests.length, 2, 'the next call asks the limit form again')
})
