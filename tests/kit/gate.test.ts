import { test, expect } from 'claude-code/testing'
import type { ToolCallResult } from 'claude-code'
import { atText, debugLine, factsOf, notice, questionText, resumeReply, stopReply, stopText } from '../../hooks/core/text.ts'
import { HOUR, RESETS, T0, TICK, above, auditor, bash, begin, clear, cmd, drain, measure, slowAsk, step, stopRec, typed, world } from '../helpers/world.ts'

// The gate through the engine (design 11.4, gate.test.ts): one question for every held loop,
// every answer class, the carrier, the hand-off, decisions from another copy, forks and failures.

const F93 = factsOf({ kind: 'live', pct: 93, resetsAtMs: Date.parse(RESETS) }, 10)
const STOP = stopText(F93)
const AT = atText(Date.parse(RESETS), ['five_hour']) // {at} with autoResume on
const AUTO_OFF = { SPARE10_AUTO_RESUME: 'off' } // the 0.1 behaviour: a question waits for its answer
const debug = (w: { logs: Array<{ text: string; to?: string }> }) => w.logs.filter((l) => l.to === 'debug').map((l) => l.text)
const transcript = (w: { logs: Array<{ text: string; to?: string }> }) => w.logs.filter((l) => l.to !== 'debug').map((l) => l.text)

test('below the reserve every loop runs and nothing asks', async ($, on) => {
  const w = world(on, { pct: 50, agents: ['a1'] })
  await begin($, w)
  const out = await Promise.all([bash($), bash($, 'a1'), bash($, 'fork-1')])
  expect(out.map((r) => r.result)).toEqual(['ran', 'ran', 'ran'])
  await drain($, step())
  await drain($, step('a1'))
  expect(await $.prompt.submit(typed('hello'))).toMatchObject({ text: 'hello' })
  expect(w.requests).toBe(2)
  expect(w.prompts).toHaveLength(1)
  expect(w.asked).toEqual([])
})

test('at the reserve one question holds three loops, and Resume runs all three in place', async ($, on) => {
  const w = world(on, { pct: 93, agents: ['a1', 'a2'] })
  await begin($, w)
  const held = [bash($), bash($, 'a1'), bash($, 'a2')]
  const req = drain($, step('a1', 'T9'))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  w.release('Resume')
  const out = await Promise.all(held)
  expect(out.map((r) => r.result)).toEqual(['ran', 'ran', 'ran'])
  expect((await req).text).toBe('hi')
  expect([...w.ran].sort()).toEqual(['Bash:a1', 'Bash:a2', 'Bash:main'])
  expect(w.requests).toBe(1)
  expect(w.asked).toHaveLength(1)
})

test('after Resume the window is consented: later calls pass and SPARE10_CONSENT holds the window end', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect((await bash($)).result).toBe('ran')
  await drain($, step())
  expect(w.requests).toBe(1)
  expect(w.asked).toHaveLength(1)
  expect(transcript(w)).toContain(notice.continuing(F93))
})

test('Stop here: parked loops are denied, later calls denied and steps refused, no second question, SPARE10_STOPPED written', async ($, on) => {
  const w = world(on, { pct: 93, agents: ['a1'] })
  await begin($, w)
  const held = [bash($), bash($, 'a1')]
  await w.clock.settle()
  w.envSetDelayMs = 1000 // the stop is written late: a crossing meanwhile must not open a second question
  w.release('Stop here')
  const out = await Promise.all(held)
  expect(out.map((r) => r.deny)).toEqual([STOP, STOP])
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect((await bash($, 'a1')).deny).toBe(STOP)
  await w.clock.advance(1000)
  w.envSetDelayMs = 0
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', RESETS, T0, 'five_hour,work,auto'))
  expect((await bash($)).deny).toBe(STOP)
  expect((await bash($, 'a1')).deny).toBe(STOP)
  const refused = await drain($, step())
  expect(refused.text).toContain('No model request was sent')
  expect(w.requests).toBe(0)
  expect(w.ran).toEqual([])
  expect(w.asked).toHaveLength(1)
  expect(transcript(w)).toContain(notice.stopped(F93, { at: AT, work: true }))
})

test('a dismissed dialog, Chat about this (a rejection) and free text all read as Stop', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'dismiss' })
  await begin($, w)
  for (const answer of ['dismiss', 'Chat about this', 'keep going', 'resume', ' Resume', 'Resume, Stop here']) {
    w.env.delete('SPARE10_STOPPED')
    w.answer = answer
    expect((await bash($)).deny).toBe(STOP)
    await w.clock.settle() // the stop is written after the held call returns
    expect(w.env.get('SPARE10_STOPPED')).toBeDefined()
    expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  }
  expect(w.asked).toHaveLength(6)
  expect(w.ran).toEqual([])
})

test('the dialog shows the loop question, the spare10 chip and Stop here first', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Resume' })
  await begin($, w)
  await bash($)
  expect(w.asked).toEqual([{ question: questionText(F93, 'loop', 'hold', true), header: 'spare10', labels: ['Stop here', 'Resume'] }])
})

test('a carrier the host rejects is re-armed and the loop still resumes', async ($, on) => {
  const w = world(on, { pct: 93, parkRejects: 1 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.parkCalls).toBe(2)
  expect(w.ran).toEqual([])
  w.cap()
  await w.clock.settle()
  expect(w.parkCalls).toBe(3)
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

test('three fast carrier rejections in a row fail closed', async ($, on) => {
  const w = world(on, { pct: 93, parkRejects: 99 })
  await begin($, w)
  expect((await bash($)).deny).toBe(STOP)
  expect(w.parkCalls).toBe(3)
  expect(w.ran).toEqual([])
})

test('a lost raiser hands the question to another waiter, and Resume still runs it', { plugins: [above] }, async ($, on) => {
  const w = world(on, { pct: 93, agents: ['bg-1'] })
  await begin($, w)
  const main = bash($, undefined, 'abandon me')
  await w.clock.settle()
  const bg = bash($, 'bg-1')
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await w.clock.advance(1000)
  expect((await main).deny).toBe('a hook above settled first')
  w.release() // the host withdraws the dialog of an abandoned dispatch; the kit does not
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
  expect(debug(w)).toContain(debugLine.handedOn(1))
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  w.release('Resume')
  expect((await bg).result).toBe('ran')
  expect(w.ran).toEqual(['Bash:bg-1'])
})

test('a lost raiser with no waiter left closes the question, and the next crossing asks again', { plugins: [above] }, async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const main = bash($, undefined, 'abandon me')
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await w.clock.advance(1000)
  expect((await main).deny).toBe('a hook above settled first')
  w.release()
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(debug(w).filter((t) => t.includes('went away'))).toEqual([])
  w.answer = 'Resume'
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(2)
})

test('a parked loop whose own dispatch is abandoned is denied at once, and the others stay parked', { plugins: [above] }, async ($, on) => {
  const w = world(on, { pct: 93, agents: ['a1'] })
  await begin($, w)
  const bg = bash($, 'a1')
  await w.clock.settle()
  const main = bash($, undefined, 'abandon me')
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await w.clock.advance(1000)
  expect((await main).deny).toBe('a hook above settled first')
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.asked).toHaveLength(1)
  w.release('Resume')
  expect((await bg).result).toBe('ran')
  expect(w.ran).toEqual(['Bash:a1'])
})

test('a decision from another copy in env releases the waiter at its next carrier cycle and withdraws this dialog', async ($, on) => {
  const w = world(on, { pct: 93, agents: ['a1'] })
  await begin($, w)
  const held = bash($, 'a1')
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  w.env.set('SPARE10_CONSENT', RESETS) // another copy's Resume
  w.cap() // the next carrier cycle
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.dialogAborted).toContain('settled the call')
  expect(transcript(w)).not.toContain(notice.continuing(F93)) // the deciding copy logged it
})

test('a stopped value older than the question does not answer it, nor one for a window that ended', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'dismiss' })
  await begin($, w)
  expect((await bash($)).deny).toBe(STOP)
  await w.clock.settle() // the stop is written after the held call returns
  expect(w.env.get('SPARE10_STOPPED')).toBeDefined()
  w.answer = 'hang'
  const p = $.prompt.submit(typed('go'))
  await w.clock.settle()
  w.cap()
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
  expect(w.prompts).toEqual([])
  // Written after the question opened, but for a window that has ended.
  await w.clock.advance(1000)
  w.env.set('SPARE10_STOPPED', stopRec('S1', T0 + 500, T0 + 600))
  w.cap()
  await w.clock.settle()
  expect(w.dialogAborted).toBe('no')
  expect(w.prompts).toEqual([])
  w.release('Resume')
  expect(await p).toMatchObject({ text: 'go' })
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
})

test("another session's stop never settles this session's question", async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  await w.clock.advance(1000)
  w.env.set('SPARE10_STOPPED', stopRec('S0', RESETS, w.clock.now())) // another conversation, after the question opened
  w.cap()
  await w.clock.settle()
  expect(w.dialogAborted).toBe('no')
  expect(w.ran).toEqual([])
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

test('after /clear, a stop from another copy under the new id settles the open question (a fresh id, not the cached one)', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  let out: ToolCallResult | undefined
  void bash($).then((r) => {
    out = r
  })
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await clear($, w, 'S2') // nothing gated runs after it: this copy's cached id is still S1
  await w.clock.advance(1000)
  w.env.set('SPARE10_STOPPED', `S2 ${Date.parse(RESETS)} ${w.clock.now()}`) // legacy: a 0.1 copy's /spare10 stop (three tokens) still stops
  w.cap()
  await w.clock.settle()
  expect(out?.deny).toBe(STOP)
  expect(w.dialogAborted).not.toBe('no')
})

test('the question has no timed release: past its window end the loops stay held, B6 is logged once, and Resume then runs them', async ($, on) => {
  const w = world(on, { pct: 93, agents: ['a1'], env: AUTO_OFF })
  await begin($, w)
  const held = [bash($), bash($, 'a1')]
  await w.clock.settle()
  await w.clock.set(Date.parse(RESETS) + 60_000)
  w.pct = undefined // the engine drops an expired window
  w.cap()
  await w.clock.advance(HOUR)
  w.cap()
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(transcript(w).filter((t) => t === notice.resetWaiting)).toHaveLength(1)
  w.release('Resume')
  expect((await Promise.all(held)).map((r) => r.result)).toEqual(['ran', 'ran'])
  await w.clock.settle()
  expect(transcript(w)).toContain(notice.newWindow)
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // R10: no consent for a window that ended
})

test('without resetsAt a hold is not released after one hour', async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: null, env: AUTO_OFF })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await w.clock.advance(2 * HOUR + TICK) // B6 comes on the first tick after the fallback window end
  w.cap()
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(transcript(w).filter((t) => t === notice.resetWaiting)).toHaveLength(1)
  w.release('Resume')
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(transcript(w)).toContain(notice.newWindow)
})

test('a reading below the trip point, a blind sensor or a lower test reading never releases a hold', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  // Each w.cap() is one carrier cycle. Three in a row inside one real second fail closed, so two here.
  w.pct = 50
  await $.session.measure(measure(50))
  w.cap()
  await w.clock.settle()
  w.pct = undefined
  await $.session.measure(measure(undefined, ['cost']))
  await $.session.measure(measure(undefined, ['cost']))
  expect((await $.command.run(cmd('simulate 10'))).text).toContain('test reading set to 10% used')
  expect((await $.command.run(cmd('simulate off'))).text).toContain('test reading cleared')
  w.cap()
  await w.clock.settle()
  expect(w.ran).toEqual([])
  expect(w.asked).toHaveLength(1)
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

test('engine forks pass: a tool call from an id that never stepped and is not listed runs', async ($, on) => {
  const w = world(on, { pct: 93, agents: ['a1'] }) // a listed agent runs beside the fork: only the id counts
  await begin($, w)
  expect((await bash($, 'compact-9f2')).result).toBe('ran')
  expect(w.asked).toEqual([])
})

test('a failed agent list gates an unstepped subagent (4.2: a failed list means listed)', async ($, on) => {
  const w = world(on, { pct: 93, agentListFails: true })
  await begin($, w)
  const held = bash($, 'bg-x')
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.ran).toEqual([])
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

test('workflow agents are gated: an unlisted id that stepped is held', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  await drain($, step('wf-1', 'W1'))
  w.pct = 93
  const held = bash($, 'wf-1')
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.ran).toEqual([])
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

test("the model's own AskUserQuestion is never held", async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Blue' })
  await begin($, w)
  const questions = [{ question: 'Which colour?', header: 'Colour', options: [{ label: 'Blue' }, { label: 'Red' }], multiSelect: false }]
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions } as never)
  expect(r).toMatchObject({ result: { answers: { 'Which colour?': 'Blue' } } })
  expect(w.asked.map((a) => a.question)).toEqual(['Which colour?'])
})

test("another plugin's $.tool.call is never held, so the dialog still reaches the bottom", { plugins: [auditor] }, async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Resume' })
  await begin($, w)
  // Raised from a held step: the ask then skips the step registration, not the tool gate.
  expect((await drain($, step(undefined, 'A1'))).text).toBe('hi')
  expect(w.asked).toHaveLength(1)
  expect(w.ran).toEqual(['Read:main'])
  expect((await bash($)).result).toBe('ran')
  expect(w.ran).toEqual(['Read:main', 'Bash:main'])
})

test('a sensor failure passes the call', async ($, on) => {
  const w = world(on, { pct: 93, usageFails: true })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await drain($, step())
  expect(w.requests).toBe(1)
  expect(w.asked).toEqual([])
})

test('an actuator read failure holds and asks', async ($, on) => {
  const w = world(on, { pct: 93, envGetFails: ['SPARE10_CONSENT', 'SPARE10_STOPPED'] })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.ran).toEqual([])
  w.release('Resume')
  expect((await held).result).toBe('ran')
})

test('the pass path costs under 20 ms per call', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  const t0 = performance.now()
  for (let i = 0; i < 200; i += 1) await bash($)
  const per = (performance.now() - t0) / 200
  expect(per).toBeLessThan(20)
  expect(w.ran).toHaveLength(200)
})

// ---- the dialog on its way, and the hand-off (4.3, 4.5) ----

test('a question settled by /spare10 resume before its dialog reaches the withdrawal hook: the late dialog never draws', { plugins: [slowAsk] }, async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toEqual([]) // the dialog waits in the hook above spare10
  expect((await $.command.run(cmd('resume'))).text).toBe(resumeReply('asking', F93))
  expect((await held).result).toBe('ran')
  await w.clock.advance(1000) // the dialog goes on, down to spare10's withdrawal hook
  await w.clock.settle()
  expect(w.asked).toEqual([]) // withdrawn before it drew: no orphan dialog whose answer nobody reads
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
})

test('a question stopped by /spare10 stop before its dialog arrives: the late dialog never draws, and the stop holds', { plugins: [slowAsk] }, async ($, on) => {
  const w = world(on, { pct: 93, agents: ['a1'] })
  await begin($, w)
  const held = bash($, 'a1')
  await w.clock.settle()
  expect(w.asked).toEqual([])
  expect((await $.command.run(cmd('stop'))).text).toBe(stopReply('asking', undefined, undefined, { at: AT }))
  expect((await held).deny).toBe(STOP)
  await w.clock.advance(1000)
  await w.clock.settle()
  expect(w.asked).toEqual([]) // no dialog is left whose Stop here or Resume nobody reads
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', RESETS, T0, 'five_hour,work,auto'))
  expect((await bash($, 'a1')).deny).toBe(STOP)
})

test("a decision from another copy before the dialog arrives: the late dialog never draws", { plugins: [slowAsk] }, async ($, on) => {
  const w = world(on, { pct: 93, agents: ['a1'] })
  await begin($, w)
  const held = bash($, 'a1')
  await w.clock.settle()
  expect(w.asked).toEqual([])
  w.env.set('SPARE10_CONSENT', `S1 ${RESETS}`) // another copy's Resume in this process
  w.cap() // the next carrier cycle reads it
  expect((await held).result).toBe('ran')
  await w.clock.advance(1000)
  await w.clock.settle()
  expect(w.asked).toEqual([])
})

test('a hand-off while the only live waiter reads the env raises the dialog at once, not after a carrier cycle', { plugins: [above] }, async ($, on) => {
  const w = world(on, { pct: 93, agents: ['bg-1'] })
  await begin($, w)
  const main = bash($, undefined, 'abandon me')
  await w.clock.settle()
  const bg = bash($, 'bg-1')
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await w.clock.advance(1000) // the hook above settles: the raiser's dispatch is abandoned
  expect((await main).deny).toBe('a hook above settled first')
  w.envGetDelayMs = { SPARE10_STOPPED: 500 } // bg-1's next env read stays in flight
  w.cap() // one carrier cycle: bg-1 goes to read the env
  await w.clock.settle()
  w.release() // the host withdraws the abandoned raiser's dialog: the question is handed on
  await w.clock.settle()
  expect(debug(w)).toContain(debugLine.handedOn(1))
  w.envGetDelayMs = {}
  await w.clock.advance(500) // bg-1's read returns: no cap, no poke follows
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
  w.release('Resume')
  expect((await bg).result).toBe('ran')
})

test('after five hand-offs the next lost raiser settles the question as Stop here, never Resume', { plugins: [above] }, async ($, on) => {
  const w = world(on, { pct: 93, agents: ['bg-1'] })
  await begin($, w)
  // Six loops raise in turn: each is abandoned from above 1000 mock ms after it started, 100 ms apart.
  for (let i = 0; i < 6; i += 1) {
    void bash($, undefined, `abandon ${i}`)
    await w.clock.advance(100)
  }
  let bg: ToolCallResult | undefined
  void bash($, 'bg-1').then((r) => {
    bg = r
  })
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await w.clock.advance(400) // the first raiser is abandoned
  for (let i = 0; i < 6; i += 1) {
    w.release() // the host withdraws the abandoned raiser's dialog
    await w.clock.settle()
    if (i < 5) {
      expect(w.asked).toHaveLength(i + 2) // handed on to the next loop, which raises again
      await w.clock.advance(100) // that loop is abandoned in its turn
    }
  }
  expect(debug(w).filter((t) => t.includes('went away'))).toEqual([1, 2, 3, 4, 5].map((n) => debugLine.handedOn(n)))
  expect(w.asked).toHaveLength(6)
  expect(bg?.deny).toBe(STOP) // the live waiter is refused
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stopRec('S1', RESETS, T0 + 1500, 'five_hour,work,auto'))
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(w.ran).toEqual([])
  expect(transcript(w)).toContain(notice.stopped(F93, { at: AT, work: true }))
})
