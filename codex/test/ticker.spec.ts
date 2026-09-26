import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexDebug, codexText, withPrefix } from '../../hooks/core/codex.ts'
import { formatStopped, parseStopped } from '../../hooks/core/decide.ts'
import type { StoppedRecord } from '../../hooks/core/decide.ts'
import { debugLine, notice } from '../../hooks/core/text.ts'
import { CHILD, HOUR, MIN, SEC, SID, T0, parsed, world } from './helpers/world.ts'
import type { World } from './helpers/world.ts'

// The root ticker and the continuation (Codex design 4.6, 4.7, 4.2 onStop, 8.2 stop.spec, the ticker
// part): stopTick continues a hosted idle session with turn/start and the exact text, skips when the person
// went on, extends a stop while a kind gates, ends a stop with no work, and reports a failed turn/start.
// Only the root broker ticks. The continuation prompt passes with its line and no note. A person prompt
// after the end takes the stop over with the B35 note. The Stop gate ends the turn with CX3, CX41 or no text.
//
// The kit port (8.2). typingNow (the prompt box) and $.prompt.submit have no Codex form: turn/start instead.
// Each tests/kit case and the Codex case that tests it: codex/test/kit-port.txt, kept complete by kit-port.spec.ts.

const RESET = T0 + 2 * HOUR
const SKIP = RESET - 20 * MIN

const stopOf = (r: Partial<StoppedRecord> = {}): string =>
  formatStopped({ sessionId: SID, windowEnd: SKIP, at: T0, kinds: ['five_hour'], auto: true, work: true, skip: true, ...r })

/** A hosted root broker in the daemon world, with a reading at 92% and a stop. */
async function hostedStop(t: Parameters<typeof world>[0], stop: string, o: { interrupts?: Record<string, number> } = {}) {
  const w = world(t, { daemon: true })
  const b = await w.broker({ hosted: true })
  w.reading(SID, 92, { reset: RESET })
  w.setState({ stopped: stop, ...(o.interrupts === undefined ? {} : { interrupts: o.interrupts }) })
  return { w, b }
}

const starts = (w: World) => w.daemon.callsOf('start') as Array<[string, string]>

test('ticker: at the stop due time a hosted idle session continues with turn/start: B34 alone after a hold, CX39 plus B34 after an interrupt', async (t) => {
  for (const interrupted of [false, true]) {
    const { w } = await hostedStop(t, stopOf(), interrupted ? { interrupts: { U1: T0 + 5 * SEC } } : {})
    w.daemon.script.newestTurn = { id: 'U1', status: interrupted ? 'interrupted' : 'completed', startedAt: Math.floor(T0 / 1000) - 60 }
    await w.advance(SKIP - T0 - 31 * SEC)
    assert.deepEqual(starts(w), [], 'nothing before the due time')
    await w.advance(31 * SEC)
    const got = starts(w)
    assert.equal(got.length, 1)
    const [thread, text] = got[0] ?? ['', '']
    assert.equal(thread, SID)
    const tail = /so the stop at the quota reserve is over\. spare10 is set to continue the work when the reserve opens, so do not wait for the user\. Continue the task from the point where it stopped\./
    assert.match(text, tail)
    assert.equal(text.startsWith(`${codexText.interruptedNote} `), interrupted)
    const st = w.state()
    assert.equal(st.stopped, undefined)
    assert.equal(st.continuation?.text, text)
    assert.equal(st.continuation?.expiresAt, SKIP + 120 * SEC, 'the tick at the due time, plus 120 s')
    assert.match(st.continuation?.notice ?? '', /spare10 continues the stopped work\.$/)
  }
})

test('ticker: the continuation prompt passes with its line and no note, and an expired or changed text does not match', async (t) => {
  const { w, b } = await hostedStop(t, stopOf())
  w.daemon.script.newestTurn = { id: 'U1', status: 'completed', startedAt: Math.floor(T0 / 1000) - 60 }
  await w.advance(SKIP - T0 + 1 * SEC)
  const text = starts(w)[0]?.[1] ?? ''
  const rec = w.state().continuation
  assert.ok(rec !== undefined)
  // A changed text is an ordinary prompt: the record stays.
  assert.equal(parsed(await b.gate('prompt', { prompt: `${text} ` }))['systemMessage'], undefined)
  assert.deepEqual(w.state().continuation, rec)
  // The continuation itself: consumed, its line queued and shown, no note for the model.
  const out = parsed(await b.gate('prompt', { prompt: text }))
  assert.deepEqual(out, { systemMessage: withPrefix(rec.notice) })
  assert.equal(w.state().continuation, undefined)
  // An expired record does not match.
  w.setState({ continuation: { ...rec, expiresAt: w.clock.now() - 1 } })
  assert.deepEqual(parsed(await b.gate('prompt', { prompt: text })), {})
  assert.notEqual(w.state().continuation, undefined)
})

test('ticker: a turn that started after the stop means the person went on: the stop ends and nothing is sent', async (t) => {
  const { w } = await hostedStop(t, stopOf())
  w.daemon.script.newestTurn = { id: 'U9', status: 'completed', startedAt: Math.floor((T0 + 30 * MIN) / 1000) }
  await w.advance(SKIP - T0 + 31 * SEC)
  assert.deepEqual(starts(w), [])
  assert.equal(w.state().stopped, undefined)
  assert.ok(w.log.lines.includes(debugLine.resumeSkipped))
})

test('ticker: while a turn still runs, the continue waits for the thread to be idle', async (t) => {
  const { w } = await hostedStop(t, stopOf())
  w.daemon.script.newestTurn = { id: 'U1', status: 'inProgress', startedAt: Math.floor(T0 / 1000) - 60 }
  w.daemon.script.status = 'active'
  await w.advance(SKIP - T0 + 31 * SEC)
  assert.deepEqual(starts(w), [])
  assert.notEqual(w.state().stopped, undefined)
  w.daemon.script.status = 'idle'
  w.daemon.script.newestTurn = { id: 'U1', status: 'interrupted', startedAt: Math.floor(T0 / 1000) - 60 }
  await w.advance(30 * SEC)
  assert.equal(starts(w).length, 1)
})

test('ticker: a stop whose kind still gates at its due time is extended, with the B34 line', async (t) => {
  const early = T0 + 10 * MIN
  const { w } = await hostedStop(t, stopOf({ windowEnd: early, skip: false, test: true }))
  // A test stop has the 60 s test margin. At its due time the real reading still gates, so it is extended.
  await w.advance(early + 60 * SEC - T0 + 30 * SEC)
  const r = parseStopped(w.state().stopped)
  assert.ok(r !== undefined)
  assert.equal(r.windowEnd, SKIP)
  const lines = w.notices()
  assert.equal(lines.length, 1)
  assert.match(lines[0] ?? '', /reached\. The stop lasts until /)
  assert.deepEqual(starts(w), [])
})

test('ticker: a stop with no work ends with the stop-over line, and nothing is sent', async (t) => {
  const { w } = await hostedStop(t, stopOf({ work: false }))
  await w.advance(SKIP - T0 + 31 * SEC)
  assert.equal(w.state().stopped, undefined)
  assert.deepEqual(starts(w), [])
  const lines = w.notices()
  assert.equal(lines.length, 1)
  assert.match(lines[0] ?? '', /and the stop is over\. Type a prompt to continue\.$/)
})

test('ticker: a failed turn/start clears the continuation and says so', async (t) => {
  const { w } = await hostedStop(t, stopOf())
  w.daemon.script.newestTurn = { id: 'U1', status: 'completed', startedAt: Math.floor(T0 / 1000) - 60 }
  w.daemon.script.start = new Error('thread not found')
  await w.advance(SKIP - T0 + 31 * SEC)
  assert.equal(starts(w).length, 1)
  assert.equal(w.state().continuation, undefined)
  assert.deepEqual(w.notices(), [notice.resumeFailed('thread not found')])
  assert.ok(w.log.lines.includes(codexDebug.startFailed('thread not found')))
})

test('ticker: only the root broker ticks, and a thread that is not hosted releases in place instead', async (t) => {
  const w = world(t, { daemon: true })
  w.hosted.add(SID)
  const child = await w.broker({ thread: CHILD, hosted: true })
  void child
  w.reading(SID, 92, { reset: RESET })
  w.setState({ stopped: stopOf() })
  w.daemon.script.newestTurn = { id: 'U1', status: 'completed', startedAt: Math.floor(T0 / 1000) - 60 }
  await w.advance(SKIP - T0 + 2 * MIN)
  assert.deepEqual(starts(w), [], 'the child broker never ticks')
  assert.notEqual(w.state().stopped, undefined)
  // A root broker whose thread is not hosted does not continue by turn/start either.
  const w2 = world(t, { daemon: true })
  await w2.broker()
  w2.reading(SID, 92, { reset: RESET })
  w2.setState({ stopped: stopOf() })
  await w2.advance(SKIP - T0 + 2 * MIN)
  assert.deepEqual(starts(w2), [])
})

test('ticker: a person prompt after the end takes the stop over with the B35 note, after CX39 when spare10 interrupted a turn', async (t) => {
  for (const interrupted of [false, true]) {
    const w = world(t)
    const b = await w.broker()
    w.reading(SID, 92, { reset: RESET })
    w.setState({ stopped: stopOf(), ...(interrupted ? { interrupts: { U1: T0 + 5 * SEC } } : {}) })
    await w.advance(SKIP - T0 + 1 * MIN)
    const out = parsed(await b.gate('prompt', { prompt: 'where were we' }))
    const ctx = (out['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['additionalContext'] as string
    const b35 = /^spare10: earlier work stopped at the quota reserve\. .+, so the stop is over\. The stopped task is not finished\. After the user's message, continue it unless the user says otherwise\.$/
    if (interrupted) {
      assert.ok(ctx.startsWith(`${codexText.interruptedNote} `))
      assert.match(ctx.slice(codexText.interruptedNote.length + 1), b35)
    } else assert.match(ctx, b35)
    assert.match(out['systemMessage'] as string, /and the stop is over\.$/)
    assert.equal(w.state().stopped, undefined)
  }
})

test('ticker: the Stop gate ends the turn with CX3 under a stop, CX41 at a hold verdict, and no text for an unattended wait', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  assert.deepEqual(parsed(await b.gate('stop', { active: false })), { continue: false, stopReason: codexText.turnEndsHold })
  w.setState({ stopped: stopOf() })
  assert.deepEqual(parsed(await b.gate('stop', { active: false })), { continue: false, stopReason: codexText.turnEnds })
  const u = world(t)
  const x = await u.broker({ hostKind: 'exec', env: { SPARE10_HEADLESS: 'wait' }, originator: 'codex_exec', source: 'exec' })
  u.reading(SID, 92, { reset: RESET })
  assert.deepEqual(parsed(await x.gate('stop', { active: false })), { continue: false })
  // Below the reserve the Stop gate passes.
  const v = world(t)
  const y = await v.broker()
  v.reading(SID, 50, { reset: RESET })
  assert.equal(await y.gate('stop', { active: false }), '')
})

test('ticker: with Continue at the reset off, or a stop with no auto tag, nothing is sent at the stop end and the stop stays', async (t) => {
  for (const [name, config, stop] of [
    ['Continue at the reset off now', { autoResume: false }, stopOf()],
    ['a stop with no auto tag', {}, stopOf({ auto: false })],
  ] as const) {
    const w = world(t, { daemon: true, config })
    await w.broker({ hosted: true })
    w.reading(SID, 92, { reset: RESET })
    w.setState({ stopped: stop })
    w.daemon.script.newestTurn = { id: 'U1', status: 'completed', startedAt: Math.floor(T0 / 1000) - 60 }
    await w.advance(RESET - T0 + 10 * MIN)
    assert.deepEqual(starts(w), [], `${name}: no turn/start`)
    assert.equal(w.state().stopped, stop, `${name}: the stop stays for the person`)
    assert.equal(w.state().continuation, undefined, name)
  }
})

test('ticker: a prompt question open in a stopped session lets the prompt in at the stop end with the B35 note, and no turn/start comes', async (t) => {
  const { w, b } = await hostedStop(t, stopOf())
  b.script('hang')
  const h = b.call('prompt', { prompt: 'next task', turn: 'U-p' })
  // The prompt gate runs inside its own turn: the root thread is active while it holds.
  w.daemon.script.status = () => (h.box.done ? 'idle' : 'active')
  w.daemon.script.newestTurn = () => ({ id: 'U-p', status: h.box.done ? 'completed' : 'inProgress', startedAt: Math.floor(T0 / 1000) + 60 })
  await w.settle()
  assert.equal(h.box.done, false, 'the prompt asks under the stop')
  assert.equal(b.forms().length, 1)
  await w.advance(SKIP - T0 + 2 * MIN)
  assert.equal(h.box.done, true, 'at the stop end the prompt goes in')
  const out = parsed(h.box.text)
  assert.equal(out['decision'], undefined)
  const ctx = (out['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['additionalContext'] as string | undefined
  assert.match(ctx ?? '', /^spare10: earlier work stopped at the quota reserve\. /, 'with the note that the stop is over')
  assert.equal(w.state().stopped, undefined, 'the prompt took the stop over')
  await w.advance(2 * MIN)
  assert.deepEqual(starts(w), [], 'no turn/start')
})

test('ticker: a loop Stop here, then Esc on a prompt question: the merged stop keeps the skip start, and one turn/start comes there', async (t) => {
  const w = world(t, { daemon: true })
  const b = await w.broker({ hosted: true })
  w.reading(SID, 92, { reset: RESET })
  // The loop: its tool asks, and Stop here stops it until the skip start, with work.
  w.daemon.script.newestTurn = { id: 'U-loop', status: 'inProgress', startedAt: Math.floor(T0 / 1000) - 60 }
  b.script('stop')
  const tool = b.call('tool', { turn: 'U-loop' })
  await w.settle()
  assert.equal(tool.box.done, true)
  const first = parseStopped(w.state().stopped)
  assert.equal(first?.skip, true)
  assert.equal(first?.work, true)
  // A person prompt a minute later asks under the stop, and Esc on its form (cancel, the turn runs) is Stop here.
  await w.advance(MIN)
  w.daemon.script.newestTurn = { id: 'U-p', status: 'inProgress', startedAt: Math.floor(w.clock.now() / 1000) }
  b.script('cancel')
  const prompt = b.call('prompt', { prompt: 'one more thing', turn: 'U-p' })
  await w.settle()
  await w.advance(SEC)
  assert.equal(prompt.box.done, true)
  assert.equal(parsed(prompt.box.text)['decision'], 'block', 'the prompt is dropped')
  const merged = parseStopped(w.state().stopped)
  assert.equal(merged?.skip, true, 'the merged stop keeps the skip start')
  assert.equal(merged?.work, true, 'and the work of the loop')
  assert.equal(merged?.windowEnd, SKIP)
  w.daemon.script.newestTurn = { id: 'U-p', status: 'completed', startedAt: Math.floor((T0 + MIN) / 1000) }
  await w.advance(SKIP - w.clock.now() + 31 * SEC)
  assert.equal(starts(w).length, 1, 'one turn/start at the skip start')
  await w.advance(5 * MIN)
  assert.equal(starts(w).length, 1, 'and no second one')
})
