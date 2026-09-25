import { test, expect } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'
import type { ToolCallResult } from 'claude-code'
import { LATER, RESETS, bash, begin, clear, cmd, drain, step, typed, world } from '../helpers/world.ts'

// Tell mode through the engine (design 2.3, 5, 11.4 tell.test.ts). The kit cannot pass options, so
// SPARE10_PAUSE_PROMPT switches the mode. Every expected text is written out from DESIGN section 2
// (and ruling R7), not taken from hooks/core/text.ts, so a wrong text there fails here too.

const PAUSE = 'Commit and stop.'
const TELL = { SPARE10_PAUSE_PROMPT: PAUSE }

// {clock}: HH:MM, 24-hour, local time (the kit runs in the machine's zone).
const clock = (iso: string): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(Date.parse(iso))
const pf = (used: number, left: number, iso: string): string => `${used}% used · ${left}% left · resets ${clock(iso)}`
const mf = (left: number, iso: string): string => `into your 10% reserve · ${left}% of quota left · resets ${clock(iso)}`

// B12, verbatim spare10 template, with the pause prompt paragraph.
const instruction = (iso: string): string =>
  `spare10 budget guard. You have reached the safe usage limit for this session (${mf(7, iso)}). ` +
  'Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.' +
  `\n\nUser instructions: ${PAUSE}`
const INSTR = instruction(RESETS)
const INSTR_LATER = instruction(LATER)
const TOLD_NOTICE = 'your 10% reserve is reached. spare10 told the agents to wind down.'
const toldLine = (key: string): string => `spare10: told ${key}`

// R7: the tell-mode prompt question (autoResume on: what no answer and Stop here mean), and the B10 drop
// text. With the shipped spans the prompt goes in at the skip start, 20 min before the reset (skip 2.2).
const promptQuestion = (iso: string): string =>
  `Your 10% reserve is reached: ${pf(93, 7, iso)}. spare10 holds your prompt. Continue on the reserve until ${clock(iso)}? ` +
  `If you do not answer, your prompt goes in at ${clock(new Date(Date.parse(iso) - 20 * 60_000).toISOString())}, 20 min before the reset, unless a reserve is still reached. Stop here gives it back to you.`
const PROMPT_QUESTION = promptQuestion(RESETS)
const NOT_STARTED = `spare10: not started. This session is inside your 10% reserve until ${clock(RESETS)}. Send the prompt again to be asked again, or run /spare10 resume.`
const CONTINUING = `continuing on your 10% reserve. spare10 stays quiet until ${clock(RESETS)}.`
const STOPPED_NOTICE = 'stopped at your 10% reserve. Type a prompt to be asked again, or run /spare10 resume.'
const STOP = `spare10: the user stopped work at the quota reserve (${mf(7, RESETS)}). Stop now and wait for the user. Do not call any further tools.`
const PAUSED = `spare10: work stopped at the quota reserve (${mf(7, RESETS)}). No model request was sent, so this task is not finished. Wait for the user.`

type Logs = { logs: Array<{ text: string; to?: string }> }
const ctx = (r: ToolCallResult): readonly string[] => r.context ?? []
const debug = (w: Logs): string[] => w.logs.filter((l) => l.to === 'debug').map((l) => l.text)
const transcript = (w: Logs): string[] => w.logs.filter((l) => l.to !== 'debug').map((l) => l.text)
const toldLines = (w: Logs): string[] => debug(w).filter((t) => t.startsWith('spare10: told '))
const notices = (w: Logs): number => transcript(w).filter((t) => t === TOLD_NOTICE).length

// Another plugin that makes its own tool calls: one from a command, one from its tool.call hook
// before an `audited` Bash call goes on.
const other: Plugin = {
  name: 'other',
  register: (on) => {
    on('tool.call', async ($, e, next) => {
      if (e.tool === 'Bash' && (e as unknown as { command?: string }).command === 'audited') {
        await $.tool.call({ tool: 'Read', file_path: '/tmp/x' } as never)
      }
      return next(e)
    })
    on('command.run', { command: 'other' }, async ($) => {
      const r = await $.tool.call({ tool: 'Bash', command: 'whoami' } as never)
      return { text: JSON.stringify(r) }
    })
  },
}

test('main is told once on its first tool result, and the tool still runs', async ($, on) => {
  const w = world(on, { pct: 50, env: TELL })
  await begin($, w)
  const below = await bash($)
  expect(below.result).toBe('ran')
  expect(ctx(below)).toEqual([]) // below the trip point nobody is told
  w.pct = 93
  const first = await bash($)
  const second = await bash($)
  expect(first.result).toBe('ran')
  expect(ctx(first)).toEqual([INSTR])
  expect(second.result).toBe('ran')
  expect(ctx(second)).toEqual([])
  expect(w.ran).toEqual(['Bash:main', 'Bash:main', 'Bash:main'])
  expect(w.asked).toEqual([])
  expect(w.parkCalls).toBe(0)
  expect(toldLines(w)).toEqual([toldLine('S1:main')])
})

test('every subagent is told once on its own key', async ($, on) => {
  const w = world(on, { pct: 93, env: TELL, agents: ['a1', 'a2'] })
  await begin($, w)
  const ids = ['a1', undefined, 'a1', 'a2', undefined, 'a2']
  const out: ToolCallResult[] = []
  for (const id of ids) out.push(await bash($, id))
  expect(out.map((r) => r.result)).toEqual(ids.map(() => 'ran'))
  expect(out.map((r) => ctx(r).length)).toEqual([1, 1, 0, 1, 0, 0]) // a subagent never spends main's slot
  expect(out.filter((r) => ctx(r).length > 0).map((r) => ctx(r))).toEqual([[INSTR], [INSTR], [INSTR]])
  expect(toldLines(w)).toEqual([toldLine('S1:a1'), toldLine('S1:main'), toldLine('S1:a2')])
  expect(w.asked).toEqual([])
})

test('an unlisted id is its own key', async ($, on) => {
  const w = world(on, { pct: 93, env: TELL }) // $.agent.list() names nobody
  await begin($, w)
  expect(ctx(await bash($))).toEqual([INSTR])
  const fork = await bash($, 'fork-1') // an engine fork: never stepped, never listed
  expect(fork.result).toBe('ran')
  expect(ctx(fork)).toEqual([INSTR])
  await drain($, step('wf-1')) // a workflow agent: it steps with an unlisted id
  const wf = await bash($, 'wf-1')
  expect(wf.result).toBe('ran')
  expect(ctx(wf)).toEqual([INSTR])
  expect(ctx(await bash($, 'fork-1'))).toEqual([])
  expect(ctx(await bash($, 'wf-1'))).toEqual([])
  expect(ctx(await bash($))).toEqual([])
  expect(toldLines(w)).toEqual([toldLine('S1:main'), toldLine('S1:fork-1'), toldLine('S1:wf-1')])
  expect(w.requests).toBe(1)
  expect(w.asked).toEqual([])
})

test("another plugin's $.tool.call is never told", { plugins: [other] }, async ($, on) => {
  const w = world(on, { pct: 93, env: TELL })
  await begin($, w)
  const out = await $.command.run({ ...cmd(''), command: 'other' })
  const viaPlugin = JSON.parse(out.text ?? '{}') as { result?: unknown; context?: unknown }
  expect(viaPlugin.result).toBe('ran')
  expect(viaPlugin.context).toBeUndefined()
  expect(w.ran).toEqual(['Bash:main'])
  expect(toldLines(w)).toEqual([]) // the plugin's call spent no slot
  const audited = await bash($, undefined, 'audited') // the plugin's Read goes first, in main's loop
  expect(w.ran).toEqual(['Bash:main', 'Read:main', 'Bash:main'])
  expect(audited.result).toBe('ran')
  expect(ctx(audited)).toEqual([INSTR]) // main's own result still carries it
  expect(toldLines(w)).toEqual([toldLine('S1:main')])
  expect(notices(w)).toBe(1)
})

test('never on a deny, and an errored result carries it', async ($, on) => {
  const w = world(on, { pct: 93, env: TELL, core: 'deny' })
  await begin($, w)
  expect(await bash($)).toEqual({ deny: 'no (a permission rule)' })
  expect(toldLines(w)).toEqual([])
  expect(notices(w)).toBe(0)
  w.core = 'error'
  const errored = await bash($)
  expect(errored).toMatchObject({ isError: true, text: 'boom' })
  expect(ctx(errored)).toEqual([INSTR])
  w.core = 'ran'
  expect(ctx(await bash($))).toEqual([])
  expect(toldLines(w)).toEqual([toldLine('S1:main')])
  expect(notices(w)).toBe(1)
})

test('parallel calls in one loop: exactly one carries it', async ($, on) => {
  const w = world(on, { pct: 93, env: TELL, agents: ['a1'] })
  await begin($, w)
  const ids = [undefined, undefined, 'a1', undefined, 'a1', undefined]
  const out = await Promise.all(ids.map((id) => bash($, id)))
  expect(out.map((r) => r.result)).toEqual(ids.map(() => 'ran'))
  const carried = (who: string | undefined) => out.filter((r, i) => ids[i] === who && ctx(r).length > 0)
  expect(carried(undefined).map((r) => ctx(r))).toEqual([[INSTR]])
  expect(carried('a1').map((r) => ctx(r))).toEqual([[INSTR]])
  expect([...toldLines(w)].sort()).toEqual([toldLine('S1:a1'), toldLine('S1:main')])
  expect(notices(w)).toBe(1)
})

test('a new window starts a new set', async ($, on) => {
  const w = world(on, { pct: 93, env: TELL, agents: ['a1'] })
  await begin($, w)
  expect(ctx(await bash($))).toEqual([INSTR])
  expect(ctx(await bash($, 'a1'))).toEqual([INSTR])
  expect(ctx(await bash($))).toEqual([])
  await w.clock.set(Date.parse(RESETS)) // the window resets, and the next one is in the reserve too
  w.resetsAt = LATER
  expect(ctx(await bash($))).toEqual([INSTR_LATER])
  expect(ctx(await bash($, 'a1'))).toEqual([INSTR_LATER])
  expect(ctx(await bash($))).toEqual([])
  expect(ctx(await bash($, 'a1'))).toEqual([])
  expect(toldLines(w)).toEqual([toldLine('S1:main'), toldLine('S1:a1'), toldLine('S1:main'), toldLine('S1:a1')])
  expect(notices(w)).toBe(2) // once per window
})

test('consent suppresses every tell', async ($, on) => {
  const w = world(on, { pct: 93, env: { ...TELL, SPARE10_CONSENT: RESETS }, agents: ['a1'] })
  await begin($, w)
  for (const id of [undefined, 'a1', 'fork-1', undefined]) {
    const r = await bash($, id)
    expect(r.result).toBe('ran')
    expect(ctx(r)).toEqual([])
  }
  expect(await $.prompt.submit(typed('hello'))).toMatchObject({ text: 'hello' })
  expect(w.prompts[0]?.context).toBeUndefined()
  expect(w.asked).toEqual([])
  expect(toldLines(w)).toEqual([])
  expect(notices(w)).toBe(0)
  await w.clock.set(Date.parse(RESETS) + 60_000) // consent ends with its window
  w.resetsAt = LATER
  expect(ctx(await bash($))).toEqual([INSTR_LATER])
  expect(toldLines(w)).toEqual([toldLine('S1:main')])
})

test('a person prompt asks while main is untold, and Stop sets no stop', async ($, on) => {
  const w = world(on, { pct: 93, env: TELL, agents: ['a1'] })
  await begin($, w)
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(w.asked).toEqual([{ question: PROMPT_QUESTION, header: 'spare10', labels: ['Stop here', 'Resume'] }])
  expect(w.prompts).toEqual([])
  w.release('Stop here')
  expect(await p).toEqual({ drop: NOT_STARTED })
  await w.clock.settle()
  expect(w.prompts).toEqual([])
  expect(w.fills).toEqual(['hello']) // the text goes back in the empty box (B10)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(transcript(w)).not.toContain(STOPPED_NOTICE)
  expect(toldLines(w)).toEqual([])
  // Main is still untold, so the prompt sent again is asked again.
  const again = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([PROMPT_QUESTION, PROMPT_QUESTION])
  w.release('Stop here')
  expect(await again).toEqual({ drop: NOT_STARTED })
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  // Nothing is stopped: requests go, tools run, and main is told on its first result.
  const s = await drain($, step())
  expect(s.text).toBe('hi')
  expect(w.requests).toBe(1)
  const r = await bash($)
  expect(r.result).toBe('ran')
  expect(ctx(r)).toEqual([INSTR])
  // Main is told now, so the next person prompt enters without a question.
  expect(await $.prompt.submit(typed('next'))).toMatchObject({ text: 'next' })
  expect(w.prompts.map((e) => e.text)).toEqual(['next'])
  expect(w.prompts[0]?.context).toBeUndefined() // v1 tells through tool results only
  expect(w.asked).toHaveLength(2)
})

test('a prompt nobody typed enters untouched while main is untold, and is never asked or told', async ($, on) => {
  const w = world(on, { pct: 93, env: TELL })
  await begin($, w)
  for (const kind of ['task-notification', 'peer', 'plugin'] as const) {
    expect(await $.prompt.submit(typed(`from ${kind}`, kind))).toMatchObject({ text: `from ${kind}` })
  }
  expect(w.prompts.map((e) => e.text)).toEqual(['from task-notification', 'from peer', 'from plugin'])
  expect(w.prompts.map((e) => e.context)).toEqual([undefined, undefined, undefined])
  expect(w.asked).toEqual([])
  expect(toldLines(w)).toEqual([])
  expect(ctx(await bash($))).toEqual([INSTR]) // main's first tool result is still told
})

test('a person prompt answered Resume enters and consents, so no loop is told in the window', async ($, on) => {
  const w = world(on, { pct: 93, env: TELL, agents: ['a1'] })
  await begin($, w)
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([PROMPT_QUESTION])
  w.release('Resume')
  expect(await p).toMatchObject({ text: 'hello' })
  expect(w.prompts.map((e) => e.text)).toEqual(['hello'])
  expect(w.prompts[0]?.context).toBeUndefined() // not stopped: no resume note, and no instruction
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(transcript(w)).toContain(CONTINUING)
  for (const id of [undefined, 'a1', 'fork-1']) {
    const r = await bash($, id)
    expect(r.result).toBe('ran')
    expect(ctx(r)).toEqual([])
  }
  expect(toldLines(w)).toEqual([])
  expect(notices(w)).toBe(0)
})

test('tell mode never holds a model request', async ($, on) => {
  const w = world(on, { pct: 93, env: TELL, agents: ['a1'] })
  await begin($, w)
  expect((await drain($, step())).text).toBe('hi') // main untold
  expect((await drain($, step('a1'))).text).toBe('hi')
  await bash($)
  await bash($, 'a1')
  const after = await Promise.all([drain($, step()), drain($, step('a1')), drain($, step('wf-2'))])
  expect(after.map((d) => d.text)).toEqual(['hi', 'hi', 'hi'])
  expect(w.requests).toBe(5)
  expect(w.asked).toEqual([])
  expect(w.parkCalls).toBe(0)
  expect(w.aborts).toEqual([])
})

test('the first tell of a window logs the notice once, and each claim logs a debug line', async ($, on) => {
  const w = world(on, { pct: 93, env: TELL, agents: ['a1', 'a2'] })
  await begin($, w)
  await drain($, step())
  expect(notices(w)).toBe(0) // the trip alone tells nobody
  for (const id of [undefined, 'a1', undefined, 'a2', 'a1']) await bash($, id)
  expect(notices(w)).toBe(1)
  expect(debug(w)).not.toContain(TOLD_NOTICE)
  expect(toldLines(w)).toEqual([toldLine('S1:main'), toldLine('S1:a1'), toldLine('S1:a2')])
})

test('a new conversation after /clear tells every loop again', async ($, on) => {
  const w = world(on, { pct: 93, env: TELL, agents: ['a1'] })
  await begin($, w)
  expect(ctx(await bash($))).toEqual([INSTR])
  expect(ctx(await bash($, 'a1'))).toEqual([INSTR])
  await clear($, w, 'S2') // /clear: a new session id, and no session.start follows
  w.answer = 'Stop here'
  expect(await $.prompt.submit(typed('fresh'))).toEqual({ drop: NOT_STARTED }) // main of S2 is untold
  expect(w.asked).toHaveLength(1)
  expect(ctx(await bash($))).toEqual([INSTR])
  expect(ctx(await bash($, 'a1'))).toEqual([INSTR])
  expect(ctx(await bash($))).toEqual([])
  expect(toldLines(w)).toEqual([toldLine('S1:main'), toldLine('S1:a1'), toldLine('S2:main'), toldLine('S2:a1')])
})

test('a stop from another copy settles an open tell-mode question, and stopped then refuses', async ($, on) => {
  const w = world(on, { pct: 93, env: TELL })
  await begin($, w)
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await w.clock.advance(1000)
  w.env.set('SPARE10_STOPPED', `S1 ${Date.parse(RESETS)} ${w.clock.now()}`) // another copy's /spare10 stop
  w.cap() // the next carrier cycle reads the env (R6)
  expect(await p).toEqual({ drop: NOT_STARTED })
  await w.clock.settle()
  expect(w.dialogAborted).not.toBe('no') // this copy's dialog is withdrawn
  expect(w.prompts).toEqual([])
  // Stopped comes before tell mode (row 7): a tool is refused, a step is refused, nobody is told.
  expect(await bash($)).toEqual({ deny: STOP })
  expect((await drain($, step('a1'))).text).toBe(PAUSED)
  expect(w.requests).toBe(0)
  expect(w.ran).toEqual([])
  expect(toldLines(w)).toEqual([])
})

test('/spare10 shows the tell action, then the told phase with the number of agents told', async ($, on) => {
  const w = world(on, { pct: 93, env: TELL, agents: ['a1'] })
  await begin($, w)
  const before = (await $.command.run(cmd(''))).text ?? ''
  expect(before).toContain('⚠ tripped        spare10 tells each agent to wind down at its next step.')
  expect(before).toContain(`· at the reserve tell every agent: ${JSON.stringify(PAUSE)}`)
  await bash($)
  await bash($, 'a1')
  const after = (await $.command.run(cmd('status'))).text ?? ''
  expect(after).toContain('⏸ told           the wind-down went to 2 agent(s).')
  expect(w.asked).toEqual([])
})

test('in a new window a person prompt asks again until main is told in that window', async ($, on) => {
  const w = world(on, { pct: 93, env: TELL })
  await begin($, w)
  expect(ctx(await bash($))).toEqual([INSTR]) // main is told in this window
  expect(await $.prompt.submit(typed('one'))).toMatchObject({ text: 'one' })
  expect(w.asked).toEqual([])
  await w.clock.set(Date.parse(RESETS)) // the window resets, and the next one is in the reserve too
  w.resetsAt = LATER
  w.answer = 'Stop here'
  expect(await $.prompt.submit(typed('two'))).toEqual({
    drop: `spare10: not started. This session is inside your 10% reserve until ${clock(LATER)}. Send the prompt again to be asked again, or run /spare10 resume.`,
  })
  expect(w.asked.map((a) => a.question)).toEqual([promptQuestion(LATER)])
  expect(ctx(await bash($))).toEqual([INSTR_LATER]) // main is told in the new window
  expect(await $.prompt.submit(typed('three'))).toMatchObject({ text: 'three' })
  expect(w.asked).toHaveLength(1)
})

test('the instruction goes after the context that hooks beneath added', async ($, on) => {
  const w = world(on, { pct: 93, env: TELL, coreContext: ['from beneath'] })
  await begin($, w)
  expect(ctx(await bash($))).toEqual(['from beneath', INSTR])
  expect(ctx(await bash($))).toEqual(['from beneath'])
})
