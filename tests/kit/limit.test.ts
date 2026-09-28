import { test, expect } from 'claude-code/testing'
import type { Engine, ElementQuery, FoundElement } from 'claude-code/testing'
import type { PromptOrigin, ToolCallResult } from 'claude-code'
import {
  MARGIN,
  MIN,
  OPENS,
  RESETS,
  SOON,
  T0,
  TEST_MARGIN,
  TICK,
  bash,
  begin,
  cmd,
  consentRec,
  drain,
  measure,
  newerLimit,
  noDialog,
  pastDue,
  pastOpen,
  step,
  stopRe,
  stopRec,
  typed,
  world,
} from '../helpers/world.ts'
import type { World } from '../helpers/world.ts'

// The pause at the quota limit through the engine (limit design 1 to 3, 6.2). Written from the design:
// every expected text is spelled out here from section 3. At 100% used with a known reset, a watched kind
// is at the quota limit: it gates in every state, also in the open reserve and after a Resume, and the
// limit question asks Continue at the reset (first) or Stop here. The world has the shipped spans (20 min
// and 8 h) and floors (5 and 5). LIM is a 5-hour reset 10 minutes after T0, so at T0 a kind at 100% sits in
// its open reserve: before the limit, spare10 let it through. Clocks are in the machine's zone, as the kit runs.

const SLOW = { timeoutMs: 30_000 }

const LIM = '2026-09-24T12:10:00.000Z' // 10 min after T0: inside the last 20 min, the open reserve
const LIM_MS = Date.parse(LIM)
const R_MS = Date.parse(RESETS)
const SOON_MS = Date.parse(SOON)

const hhmm = (ms: number): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
const wk = (ms: number): string => `${new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(ms)} ${hhmm(ms)}`
const AT = hhmm(LIM_MS)

// The limit question (3.2), and its options.
const OPTIONS = ['Continue at the reset', 'Stop here']
const pf = (at = AT): string => `100% used · 0% left · resets ${at}`
const LOOP_Q = (at = AT): string =>
  `The quota limit is reached: ${pf(at)}. All work is on hold. Continue the work at the reset? If you do not answer, the work waits until ${at}. Then spare10 continues it, unless a reserve is still reached. Stop here stops the work. After the reset, type a prompt to continue.`
const LOOP_Q_OFF = `The quota limit is reached: ${pf()}. All work is on hold. Continue the work at the reset? Until you answer, the work waits. Stop here stops the work. After the reset, type a prompt to continue.`
const PROMPT_Q = `The quota limit is reached: ${pf()}. spare10 holds your prompt and any other work. Continue the work at the reset? If you do not answer, all of it continues after ${AT}, unless a reserve is still reached. Stop here gives your prompt back and stops other work. After the reset, type a prompt to continue.`

// Texts the model reads (3.6).
const STOP = (at = AT): string => `spare10: the user stopped work at the quota limit (100% of quota used · resets ${at}). Stop now and wait for the user. Do not call any further tools.`
const PAUSED = `spare10: work stopped at the quota limit (100% of quota used · resets ${AT}). No model request was sent, so this task is not finished. Wait for the user.`
const HEADLESS = `spare10 stopped this unattended run at the quota limit (100% of quota used · resets ${AT}). No further model requests were sent. To pick it up later: claude --resume S1`
const NOT_STARTED = `spare10: not started. The quota limit is reached until ${AT}. Send the prompt again after the reset.`

// Transcript lines and replies (3.3, 3.4), without the engine's prefix.
const CONTINUES = (at = AT): string => `held work waits until ${at}. Then spare10 continues it, unless a reserve is still reached.`
const STOPPED = (at = AT): string => `stopped at the quota limit until ${at}. After the reset, type a prompt to continue.`
const REACHED = 'the quota limit is reached. spare10 asks you again.'
const RESET_CONTINUES = 'the 5-hour window reset. Held work continues.'
const RESET_WAITING = 'the 5-hour window reset. Held work still waits for your answer.'
const NOTHING_NOW = (at: string): string => `nothing to resume now. The quota limit is reached until ${at}. spare10 holds all work until then.`

type Logs = Pick<World, 'logs'>
const transcript = (w: Logs): string[] => w.logs.filter((l) => l.to !== 'debug').map((l) => l.text)
const questions = (w: World): string[] => w.asked.map((a) => a.question)

async function run($: Engine, args: string, kind: PromptOrigin['kind'] = 'composer'): Promise<string | undefined> {
  return (await $.command.run(cmd(args, kind))).text
}

async function report($: Engine): Promise<string[]> {
  return ((await run($, '')) ?? '').split('\n')
}
const phaseLine = (lines: string[]): string | undefined => lines[2]

/** A promise with a flag that says whether it has settled. */
function tracked<T>(p: Promise<T>): { p: Promise<T>; done: () => boolean } {
  let done = false
  void p.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  return { p, done: () => done }
}

/** A held main call at the limit, with the limit question up. */
async function heldAtLimit($: Engine, w: World): Promise<{ p: Promise<ToolCallResult>; done: () => boolean }> {
  const held = tracked(bash($))
  await w.clock.settle()
  expect(held.done()).toBe(false)
  expect(w.asked.at(-1)?.labels).toEqual(OPTIONS)
  return held
}

type Ui = { find: (q: ElementQuery) => Promise<FoundElement | undefined> }
type Shown = { text: string | undefined; color: unknown }

/** The badge as drawn: the text of the Box keyed spare10 (with its leading space) and its Text's colour. */
async function badgeOf($: Engine): Promise<Shown> {
  const ui = await $.ui.mount({ plugin: 'spare10', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  const found: Ui = ui
  const box = await found.find({ key: 'spare10' })
  const inner = (box?.children ?? []).find((c): c is { type: string; props?: Record<string, unknown> } =>
    typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'Text')
  await ui.unmount()
  return { text: box?.text, color: inner?.props?.color }
}

// ---- The question and its answers (1.3, 1.4) ----

test('at 100% in the open reserve a held call asks the limit question, and with no answer it runs after the reset', async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM })
  await begin($, w)
  const held = await heldAtLimit($, w)
  expect(questions(w)).toEqual([LOOP_Q()])
  expect(w.asked[0]?.header).toBe('spare10')
  expect(w.ran).toEqual([])
  await w.clock.set(LIM_MS + MARGIN - TICK) // past the reset, inside the margin: it still waits
  expect(held.done()).toBe(false)
  await pastDue(w, LIM)
  expect((await held.p).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w)).toContain(RESET_CONTINUES)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
})

test('Continue at the reset closes the dialog, a held step joins with no second dialog, and both go on after the reset', async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM, agents: ['a1'] })
  await begin($, w)
  const held = await heldAtLimit($, w)
  w.release('Continue at the reset')
  await w.clock.settle()
  expect(transcript(w)).toContain(CONTINUES())
  expect(held.done()).toBe(false)
  const st = tracked(drain($, step()))
  // A subagent (or a workflow agent) waits too, and goes on after the reset: it is never refused.
  const sub = tracked(bash($, 'a1'))
  const subStep = tracked(drain($, step('a1', 'T9')))
  await w.clock.settle()
  expect([st.done(), sub.done(), subStep.done()]).toEqual([false, false, false])
  expect(w.asked).toHaveLength(1) // no second dialog
  expect(w.requests).toBe(0)
  await w.clock.advance(5 * MIN) // checks run while it waits: nothing is asked or released
  expect(w.asked).toHaveLength(1)
  expect(held.done()).toBe(false)
  await pastDue(w, LIM)
  expect((await held.p).result).toBe('ran')
  expect((await st.p).text).toBe('hi')
  expect((await sub.p).result).toBe('ran')
  expect((await subStep.p).text).toBe('hi')
  expect(w.requests).toBe(2)
  expect([...w.ran].sort()).toEqual(['Bash:a1', 'Bash:main'])
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
})

test('Stop here at the limit refuses the held work, writes a stop with no auto, and sends nothing after the reset', async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM })
  await begin($, w)
  const held = await heldAtLimit($, w)
  w.release('Stop here')
  expect((await held.p).deny).toBe(STOP())
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stopRe('S1', 'five_hour,work'))
  expect(w.env.get('SPARE10_STOPPED')?.split(' ')[1]).toBe(String(LIM_MS))
  expect(transcript(w)).toContain(STOPPED())
  expect((await bash($)).deny).toBe(STOP()) // the stop refuses new work until the reset
  await pastDue(w, LIM)
  await w.clock.advance(2 * MIN)
  expect(w.submitted).toEqual([]) // no resume prompt: nothing continues it
  expect((await bash($)).result).toBe('ran') // after the reset new work goes on
})

test('a full consent after a second Resume does not let work past the limit', async ($, on) => {
  const w = world(on, { pct: 91 })
  await begin($, w)
  const first = bash($)
  await w.clock.settle()
  w.release('Resume')
  expect((await first).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS, 95))
  w.pct = 96 // at the floor: the second question
  const second = bash($)
  await w.clock.settle()
  w.release('Resume')
  expect((await second).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS)) // full, until the reset
  w.pct = 99.9
  expect((await bash($)).result).toBe('ran')
  w.pct = 100
  const held = await heldAtLimit($, w)
  expect(questions(w).at(-1)).toBe(LOOP_Q(hhmm(R_MS)))
  expect(w.env.get('SPARE10_CONSENT')).toBe(consentRec('S1', RESETS)) // the consent is kept
  expect(held.done()).toBe(false)
  expect(w.ran).toEqual(['Bash:main', 'Bash:main', 'Bash:main'])
})

test('a Resume on the floor question that comes at 100% leads to the limit question, and no request goes out', async ($, on) => {
  const w = world(on, { pct: 96, env: { SPARE10_CONSENT: consentRec('S1', RESETS, 95) } })
  await begin($, w)
  const st = tracked(drain($, step()))
  await w.clock.settle()
  expect(questions(w)[0]).toMatch(/^Your 5% floor is reached: 96% used/)
  w.pct = 100 // the quota reaches the limit while the second question is up
  w.release('Resume')
  await w.clock.settle()
  expect(w.requests).toBe(0)
  expect(st.done()).toBe(false)
  expect(questions(w)).toHaveLength(2)
  expect(questions(w)[1]).toBe(LOOP_Q(hhmm(R_MS)))
  expect(w.asked[1]?.labels).toEqual(OPTIONS)
})

test('a question at the reserve gives way to the limit question at the next step', async ($, on) => {
  const w = world(on, { pct: 92 })
  await begin($, w)
  const first = tracked(bash($))
  await w.clock.settle()
  expect(questions(w)[0]).toMatch(/^Your 10% reserve is reached: 92% used/)
  w.pct = 100
  const st = tracked(drain($, step()))
  await w.clock.settle()
  expect(transcript(w)).toContain(REACHED)
  expect(questions(w)).toHaveLength(2)
  expect(questions(w)[1]).toBe(LOOP_Q(hhmm(R_MS)))
  expect(w.dialogAborted).not.toBe('no') // the reserve dialog is withdrawn
  expect([first.done(), st.done()]).toEqual([false, false]) // both wait in the limit question
  w.release('Stop here')
  expect((await first.p).deny).toBe(STOP(hhmm(R_MS)))
  expect((await st.p).text).toBe(`spare10: work stopped at the quota limit (100% of quota used · resets ${hhmm(R_MS)}). No model request was sent, so this task is not finished. Wait for the user.`)
  expect(w.requests).toBe(0)
})

test('a question at the reserve gives way to the limit question at the next check', async ($, on) => {
  const w = world(on, { pct: 92 })
  await begin($, w)
  const held = tracked(bash($))
  await w.clock.settle()
  expect(questions(w)).toHaveLength(1)
  w.pct = 100 // no new step comes
  await w.clock.advance(2 * MIN) // the waiter's check
  expect(transcript(w)).toContain(REACHED)
  expect(questions(w)).toHaveLength(2)
  expect(questions(w)[1]).toBe(LOOP_Q(hhmm(R_MS)))
  expect(held.done()).toBe(false)
})

test('tell mode holds at the limit and asks the limit question', async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM, env: { SPARE10_PAUSE_PROMPT: 'Wrap up.' } })
  await begin($, w)
  const held = await heldAtLimit($, w)
  expect(questions(w)).toEqual([LOOP_Q()])
  expect(w.ran).toEqual([]) // not told and run: held
  w.release('Stop here')
  expect((await held.p).deny).toBe(STOP())
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stopRe('S1', 'five_hour,work')) // Stop here writes a stop in tell mode too
})

test('both windows at the limit: the question names both, and the work waits for the weekly reset', SLOW, async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM, weekPct: 100, weekResetsAt: SOON })
  await begin($, w)
  const held = await heldAtLimit($, w)
  const five = `5-hour window 100% used · 0% left · resets ${AT}`
  const week = `weekly window 100% used · 0% left · resets ${wk(SOON_MS)}`
  expect(questions(w)).toEqual([
    `The quota limits of both windows are reached: ${five}, ${week}. All work is on hold. Continue the work at the reset? If you do not answer, the work waits until ${wk(SOON_MS)}. Then spare10 continues it, unless a reserve is still reached. Stop here stops the work. After the reset, type a prompt to continue.`,
  ])
  w.release('Continue at the reset')
  await pastDue(w, LIM) // the 5-hour window reset: the weekly limit still holds
  expect(held.done()).toBe(false)
  expect(questions(w)).toHaveLength(1)
  await pastDue(w, SOON)
  expect((await held.p).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w)).toContain('the 5-hour and weekly windows reset. Held work continues.')
})

test('the 5-hour limit with the weekly window in its reserve: after the 5-hour reset the weekly question asks', SLOW, async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM, weekPct: 92 })
  await begin($, w)
  const held = await heldAtLimit($, w)
  expect(questions(w)).toEqual([LOOP_Q()]) // only the kind at the limit
  w.release('Continue at the reset')
  await pastDue(w, LIM)
  await w.clock.settle()
  expect(held.done()).toBe(false)
  expect(transcript(w)).toContain('the 5-hour window reset, but your 10% weekly reserve is reached. Held work still waits.')
  expect(questions(w)).toHaveLength(2)
  expect(questions(w)[1]).toMatch(/^Your 10% weekly reserve is reached: 92% used/)
  expect(w.asked[1]?.labels).toEqual(['Stop here', 'Resume'])
  w.release('Resume')
  expect((await held.p).result).toBe('ran')
})

test('/spare10 simulate 100 in 2m holds in the open test window, and the work goes on 60 s after it ends', async ($, on) => {
  const w = world(on, { pct: 30 })
  await begin($, w)
  const end = T0 + 2 * MIN
  expect(await run($, 'simulate 100 in 2m')).toBe(
    `test reading set to 100% used, resets ${hhmm(end)}. It can only raise the real reading. This is the quota limit, so spare10 holds all work until the test window ends. Run /spare10 simulate off to clear it.`,
  )
  const held = await heldAtLimit($, w)
  expect(questions(w)).toEqual([LOOP_Q(hhmm(end))])
  await w.clock.set(end + TEST_MARGIN - TICK)
  expect(held.done()).toBe(false)
  await w.clock.set(end + TEST_MARGIN + TICK)
  expect((await held.p).result).toBe('ran')
  await w.clock.settle()
  expect(transcript(w)).toContain('the test window ended. Held work continues.')
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
})

test("another copy's consent never answers the limit question, and the held call stays held", async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM })
  await begin($, w)
  const held = await heldAtLimit($, w)
  w.env.set('SPARE10_CONSENT', consentRec('S1', LIM)) // another copy's Resume, as a full consent
  w.cap() // the next carrier cycle reads the env
  await w.clock.settle()
  expect(held.done()).toBe(false)
  expect(w.dialogAborted).toBe('no') // not decided elsewhere: the dialog stays up
  expect(w.ran).toEqual([])
  w.release('Stop here')
  expect((await held.p).deny).toBe(STOP())
})

test('an auto stop at the reserve that is due at the limit lasts until the reset, and then continues', SLOW, async ($, on) => {
  const w = world(on, { pct: 92, answer: 'Stop here' })
  await begin($, w)
  expect((await bash($)).deny).toMatch(/^spare10: the user stopped work at the quota reserve/)
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')?.split(' ')[1]).toBe(String(Date.parse(OPENS))) // until the skip start, with auto
  w.pct = 100 // the quota reaches the limit while the stop waits
  await pastOpen(w)
  expect(w.submitted).toEqual([]) // at the skip start the reserve would open, but the limit holds
  expect(w.env.get('SPARE10_STOPPED')?.split(' ')[1]).toBe(String(R_MS))
  expect(transcript(w)).toContain(`your quota limit is reached. The stop lasts until ${hhmm(R_MS)}.`)
  expect((await bash($)).deny).toBe(STOP(hhmm(R_MS)))
  await pastDue(w, RESETS)
  expect(w.submitted).toHaveLength(1) // after the reset the work continues
  expect(w.submitted[0]).toMatch(/^The 5-hour window reset, so the stop at the quota reserve is over\./)
})

// ---- Commands (1.7) ----

test('/spare10 resume on the limit question chooses Continue at the reset and writes no consent', async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM })
  await begin($, w)
  const held = await heldAtLimit($, w)
  expect(await run($, 'resume')).toBe(CONTINUES())
  await w.clock.settle()
  expect(w.dialogAborted).not.toBe('no') // the dialog is withdrawn
  expect(transcript(w)).not.toContain(CONTINUES()) // the reply says it, not a transcript line
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(held.done()).toBe(false)
  expect(await run($, 'resume')).toBe(NOTHING_NOW(AT)) // chosen already: nothing changes
  await pastDue(w, LIM)
  expect((await held.p).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('/spare10 resume at the limit with an auto stop keeps the stop and changes nothing', async ($, on) => {
  const stop = stopRec('S1', RESETS, T0 - MIN, 'five_hour,work,auto')
  const w = world(on, { pct: 100, env: { SPARE10_STOPPED: stop } })
  await begin($, w)
  expect(await run($, 'resume')).toBe(NOTHING_NOW(hhmm(R_MS)))
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stop)
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect((await bash($)).deny).toBe(STOP(hhmm(R_MS))) // the stop still refuses
})

test('/spare10 stop at the limit writes a stop with no auto, and replies with the limit text', async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM })
  await begin($, w)
  expect(await run($, 'stop')).toBe(STOPPED())
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(`S1 ${LIM_MS} ${T0} five_hour`)
  expect((await bash($)).deny).toBe(STOP())
  await pastDue(w, LIM)
  await w.clock.advance(2 * MIN)
  expect(w.submitted).toEqual([])
})

// ---- Person prompts (1.3) ----

test('a person prompt at the limit waits after Continue at the reset, and goes in after the reset', async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM })
  await begin($, w)
  const p = tracked($.prompt.submit(typed('hello')))
  await w.clock.settle()
  expect(questions(w)).toEqual([PROMPT_Q])
  expect(w.asked[0]?.labels).toEqual(OPTIONS)
  w.release('Continue at the reset')
  await w.clock.settle()
  expect(p.done()).toBe(false)
  expect(w.prompts).toEqual([])
  await pastDue(w, LIM)
  expect(await p.p).toMatchObject({ text: 'hello' })
  expect(w.prompts.map((x) => x.text)).toEqual(['hello'])
})

test('Stop here on a prompt question at the limit drops the prompt, puts the text back, and names the limit', async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM })
  await begin($, w)
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  w.release('Stop here')
  expect(await p).toEqual({ drop: NOT_STARTED })
  await w.clock.settle()
  expect(w.fills).toEqual(['hello'])
  expect(w.prompts).toEqual([])
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stopRe('S1', 'five_hour'))
})

// ---- A dialog with no answer (1.3) ----

test('Esc on the limit dialog counts as Continue at the reset', async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM, answer: 'dismiss' })
  await begin($, w)
  const held = tracked(bash($))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(held.done()).toBe(false)
  expect(transcript(w)).toContain(CONTINUES())
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  await pastDue(w, LIM)
  expect((await held.p).result).toBe('ran')
  expect(w.asked).toHaveLength(1) // Continue at the reset raises no dialog again
})

test('a dialog that cannot show continues at the reset', { plugins: [noDialog] }, async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM })
  await begin($, w)
  const held = tracked(bash($))
  await w.clock.settle()
  expect(held.done()).toBe(false)
  expect(transcript(w)).toContain(CONTINUES())
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  await pastDue(w, LIM)
  expect((await held.p).result).toBe('ran')
})

test('autoResume off: with no answer the held work waits past the reset with one note, and Continue at the reset then lets it go', async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM, env: { SPARE10_AUTO_RESUME: 'off' } })
  await begin($, w)
  const held = await heldAtLimit($, w)
  expect(questions(w)).toEqual([LOOP_Q_OFF])
  await pastDue(w, LIM)
  await w.clock.advance(10 * MIN)
  expect(held.done()).toBe(false)
  expect(transcript(w).filter((t) => t === RESET_WAITING)).toHaveLength(1)
  w.release('Continue at the reset')
  expect((await held.p).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

// ---- Unattended runs (1.8) ----

test('unattended wait holds at the limit in the open reserve until the reset', async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM, surfaces: [], env: { SPARE10_HEADLESS: 'wait' } })
  await begin($, w)
  const held = tracked(bash($))
  await w.clock.settle()
  expect(held.done()).toBe(false)
  expect(w.asked).toEqual([])
  await pastDue(w, LIM)
  expect((await held.p).result).toBe('ran')
})

test('unattended stop refuses at the limit in the open reserve with the limit text', async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM, surfaces: [], env: { SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  expect((await bash($)).deny).toBe(HEADLESS)
  expect(w.ran).toEqual([])
})

test('unattended off lets the work through at the limit', async ($, on) => {
  const w = world(on, { pct: 100, surfaces: [] })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(w.asked).toEqual([])
})

// ---- The option (4) ----

test('SPARE10_LIMIT_PAUSE=off lets the open reserve through at 100%, and the report shows the limit row', async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM, env: { SPARE10_LIMIT_PAUSE: 'off' } })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  const lines = await report($)
  expect(lines).toContain('  · at the limit   off. spare10 does not pause at the limit (from SPARE10_LIMIT_PAUSE)')
  expect(phaseLine(lines)).toMatch(/^ {2}↻ open/)
})

test('SPARE10_LIMIT_PAUSE with a bad value warns at the start and keeps the option', async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM, env: { SPARE10_LIMIT_PAUSE: 'yes' } })
  await begin($, w)
  expect(transcript(w)).toContain('SPARE10_LIMIT_PAUSE="yes" is not on or off. spare10 uses on.')
  await heldAtLimit($, w)
  expect((await report($)).some((l) => l.startsWith('  · at the limit'))).toBe(false) // on: no row
})

// ---- A reload, the badge and the report (2, 3.5) ----

test('a Stop here at the limit survives a reload: a new copy refuses work until the reset', async ($, on) => {
  // A new copy starts with the value that the old copy wrote (a reload).
  const w = world(on, { pct: 100, resetsAt: LIM, env: { SPARE10_STOPPED: stopRec('S1', LIM, T0 - MIN, 'five_hour,work') } })
  await begin($, w)
  expect((await bash($)).deny).toBe(STOP())
  expect((await drain($, step())).text).toBe(PAUSED)
  expect(w.asked).toEqual([])
  await pastDue(w, LIM)
  await w.clock.advance(2 * MIN)
  expect(w.submitted).toEqual([]) // no auto: the ticker continues nothing
  expect((await bash($)).result).toBe('ran')
})

test('the badge shows the limit row while held work waits for the reset', async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM })
  await begin($, w)
  await $.session.measure(measure(100, ['rateLimits', 'cost'], LIM))
  await w.clock.settle()
  expect(await badgeOf($)).toEqual({ text: ` ‖ spare10: at the limit until ${AT}`, color: 'warning' })
  expect(phaseLine(await report($))).toBe(`  ‖ limit          the quota limit is reached until ${AT}. spare10 holds the next step and asks you.`)
  const held = await heldAtLimit($, w)
  expect(await badgeOf($)).toEqual({ text: ` ? spare10: waiting for you until ${AT}`, color: 'warning' })
  w.release('Continue at the reset')
  await w.clock.settle()
  expect(await badgeOf($)).toEqual({ text: ` ‖ spare10: at the limit until ${AT}`, color: 'warning' })
  expect(phaseLine(await report($))).toBe(`  ‖ limit          the quota limit is reached. Held work waits until ${AT}. Then spare10 continues it, unless a reserve is still reached.`)
  await pastDue(w, LIM)
  expect((await held.p).result).toBe('ran')
})

test('a reading at 100% without a reset time keeps the rules of today', async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: null, floors: 'off' })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked[0]?.labels).toEqual(['Stop here', 'Resume'])
  expect(questions(w)[0]).toMatch(/^Your 10% reserve is reached: 100% used · 0% left · resets at an unknown time\./)
  w.release('Resume')
  expect((await held).result).toBe('ran')
  expect((await bash($)).result).toBe('ran') // the Resume consents, as before the limit
})

test('$.spare10.limit answers the option of the newest copy', { plugins: [newerLimit] }, async ($, on) => {
  const w = world(on, { pct: 100, resetsAt: LIM })
  await begin($, w)
  w.env.set('NEWER_COPY_LIMIT', 'off') // the newest copy has limitPause off: its value is in force here too
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
  w.env.set('NEWER_COPY_LIMIT', 'on')
  await heldAtLimit($, w)
  expect(questions(w)).toEqual([LOOP_Q()])
})
