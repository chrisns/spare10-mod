import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { PromptOrigin, ToolCallResult } from 'claude-code'
import { VERSION } from '../../hooks/core/text.ts'
import { HOUR, LATER, OPENS, RESETS, T0, bash, begin, clear, cmd, drain, measure, step, typed, world02 as world } from '../helpers/world.ts'
import type { World } from '../helpers/world.ts'

// The 0.2 texts: floors off (world02). The floor tests: floor*.test.ts.
// /spare10 and its verbs (design B22 to B26, 12.1, 11.4 command.test.ts), written from the spec.
// Every expected text below is spelled out from section 2 (with the orchestrator rulings), not taken
// from hooks/core/text.ts, so a drift in either the texts or the command logic fails here.

const R = Date.parse(RESETS)
const hhmm = (ms: number): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms))
const AT = hhmm(R) // {clock} of RESETS in the machine's zone (the kit ignores TZ)
const UNTIL = `until ${AT}`
// Skip near the reset (the shipped spans): the 5-hour reserve opens 20 min before RESETS, and a question
// or an auto stop continues there (skip 2.2, 2.4, 2.8).
const O = Date.parse(OPENS)
const OPEN_AT = hhmm(O)
const LEAD = '20 min before the reset'

// {pf} and {mf} (section 2).
const pf = (used: string, left: string, at = AT): string => `${used}% used · ${left}% left · resets ${at}`
const mf = (reserve: string, left: string, at = AT): string => `into your ${reserve}% reserve · ${left}% of quota left · resets ${at}`

// Model and person texts (B2, B7, B10, B12, B15).
const STOP93 = `spare10: the user stopped work at the quota reserve (${mf('10', '7')}). Stop now and wait for the user. Do not call any further tools.`
const PAUSED93 = `spare10: work stopped at the quota reserve (${mf('10', '7')}). No model request was sent, so this task is not finished. Wait for the user.`
const HEADLESS93 = `spare10 stopped this unattended run at the quota reserve (${mf('10', '7')}). No further model requests were sent. To pick it up later: claude --resume S1`
const NOT_STARTED = `spare10: not started. This session is inside your 10% reserve ${UNTIL}. Send the prompt again to be asked again, or run /spare10 resume.`
// With autoResume on (the 0.2 default) each question says what no answer and Stop here mean (2.2), at
// the skip start with its lead (skip 2.2).
const loopQuestion = (p: string, lead = LEAD): string =>
  `Your 10% reserve is reached: ${p}. All work is on hold. Continue on the reserve ${UNTIL}? ` +
  `If you choose Stop here or do not answer, the work waits until ${OPEN_AT}, ${lead}. Then spare10 continues it, unless a reserve is still reached.`
const TEST_LEAD = '20 min before the test window ends' // {lead} of a test reading (skip 2.1)
const tellPromptQuestion = (p: string): string =>
  `Your 10% reserve is reached: ${p}. spare10 holds your prompt. Continue on the reserve ${UNTIL}? ` +
  `If you do not answer, your prompt goes in at ${OPEN_AT}, ${LEAD}, unless a reserve is still reached. Stop here gives it back to you.`
const holdPromptQuestion = (p: string): string =>
  `Your 10% reserve is reached: ${p}. spare10 holds your prompt and any other work. Continue on the reserve ${UNTIL}? ` +
  `If you do not answer, all of it continues at ${OPEN_AT}, ${LEAD}, unless a reserve is still reached. Stop here gives your prompt back and pauses other work until ${OPEN_AT}.`
const tellText = (m: string, prompt: string): string =>
  `spare10 budget guard. You have reached the safe usage limit for this session (${m}). Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.\n\nUser instructions: ${prompt}`

// B23 replies.
const RESUMED_ASKING = `resumed. Held work continues on the reserve ${UNTIL}.`
const RESUMED_STOPPED = `resumed. You can use the reserve ${UNTIL}. Type a prompt to continue.`
const RESUMED_TRIPPED = `you can use the reserve ${UNTIL}.`
const ALREADY_RESUMED = `already resumed ${UNTIL}.`
const nothingToResume = (p: string): string => `nothing to resume. ${p}.`
const NOTHING_TO_RESUME_NONE = 'nothing to resume. There is no 5-hour reading yet.'
const NOT_GUARDED = 'this run is not guarded. Nothing changed.'

// B24 replies, with autoResume on (2.8).
const STOPPED_ASKING = `stopped. Held work is refused. spare10 continues it at ${OPEN_AT}, ${LEAD}.`
// A question that held no loop (a prompt question): the stop has no work, so the reply promises nothing (3.2).
const STOPPED_ASKING_NO_WORK = 'stopped. Held work is refused.'
const stoppedTripped = (at: string): string =>
  `stopped at the reserve until ${at}. Then spare10 continues any stopped work. Type a prompt to be asked again, or run /spare10 resume.`
const STOPPED_TRIPPED = stoppedTripped(`${OPEN_AT}, ${LEAD}`)
const ALREADY_STOPPED = `already stopped until ${OPEN_AT}.`
const nothingToStop = (trip: string): string => `nothing to stop. spare10 steps in at ${trip}% used, or at 90% used of the weekly window.`

// B25 and 12.1.
const notPerson = (verb: string): string => `only you can run /spare10 ${verb}. Nothing changed.`
const unknownVerb = (verb: string): string => `unknown command "${verb}". Use /spare10, /spare10 resume or /spare10 stop.`
// Skip 2.9: a test reading at or above the trip point says when its reserve opens (`opens`: the skip start).
const simulateSet = (used: string, at: string, opens?: string): string =>
  `test reading set to ${used}% used, resets ${at}. It can only raise the real reading.${opens === undefined ? '' : ` The reserve opens at ${opens}, ${TEST_LEAD}.`} Run /spare10 simulate off to clear it.`
const SIMULATE_OFF = 'test reading cleared. Consent and stop for this window are cleared too.'
const SIMULATE_BAD =
  '/spare10 simulate takes a percentage from 0 to 100, or off. Add weekly for the weekly window, and in 22m for a test window that resets in 22 minutes.'

// B22: the phase line of the report, as `  {glyph} {phase}  {phase detail}` (R7 for asking).
const PHASE = {
  off: '  ○ off            spare10 only watches in this run.',
  blind: '  ⚠ blind          Claude Code reports no 5-hour quota. spare10 lets all work through.',
  waiting: '  ⧗ waiting        no reading yet. spare10 lets all work through.',
  armed: (trip: string): string => `  ● armed          spare10 steps in at ${trip}% used, or at 90% used of the weekly window.`,
  consented: `  ⨯ consented      you chose to continue. spare10 is quiet ${UNTIL}.`,
  // A stop that held or refused a loop (work), and one that did not (2.7, autoResume on).
  stopped: `  ■ stopped        you chose Stop here. spare10 continues the work at ${OPEN_AT}. Type a prompt to be asked again, or run /spare10 resume.`,
  stoppedIdle: `  ■ stopped        you chose Stop here, until ${OPEN_AT}. Type a prompt to be asked again, or run /spare10 resume.`,
  asking: `  ? asking         a question is open. Held work waits until you answer, or until ${OPEN_AT}. If no dialog shows, run /spare10 resume or /spare10 stop.`,
  askingNoAuto: '  ? asking         a question is open. Held work waits until you answer. If no dialog shows, run /spare10 resume or /spare10 stop.',
  told: (n: number): string => `  ⏸ told           the wind-down went to ${n} agent(s).`,
  reserve: (policy: string): string => `  ⚠ tripped        unattended run, policy ${policy}.`,
  trippedHold: '  ⚠ tripped        spare10 holds the next step and asks you.',
  trippedTell: '  ⚠ tripped        spare10 tells each agent to wind down at its next step.',
}
const FOOTER = ['/spare10 resume   continue on the reserve until the window resets', '/spare10 stop     stop at the reserve now']
const W_FLAG =
  'function hooks are on only in this shell. Background sessions and pane teammates start without spare10. Put CLAUDE_CODE_ENABLE_FUNCTION_HOOKS in the env block of ~/.claude/settings.json.'

async function run($: Engine, args: string, kind: PromptOrigin['kind'] = 'composer'): Promise<string | undefined> {
  return (await $.command.run(cmd(args, kind))).text
}

async function report($: Engine): Promise<string[]> {
  return ((await run($, '')) ?? '').split('\n')
}

const field = (lines: string[], label: string): string | undefined => lines.find((l) => l.startsWith(`  · ${label} `))
const phaseLine = (lines: string[]): string | undefined => lines[2]
const stoppedRe = (sid: string): RegExp => new RegExp(`^${sid} ${O} \\d+ [a-z_,:0-9]+$`) // 0.2: the tags follow. An auto stop ends at the skip start

/**
 * 2.7: the four 0.2 rows, with the weekly window watched and no weekly reading, and the two span rows of
 * skip 2.7 in both modes. `at the reset` is attended only.
 */
const with02 = (lines: string[], attended = true): string[] =>
  lines.flatMap((l) => {
    if (l.startsWith('  · reserve ')) {
      return [
        l,
        '  · weekly reserve 10% of the weekly window (from /config)',
        '  · reserve opens  in the last 20 min of the 5-hour window (from /config)',
        '  · weekly opens   in the last 8 h of the weekly window (from /config)',
        // Floor 7.5: the rows of the floors, off in this file (world02).
        '  · resume floor   off. A Resume lasts until the reset (from SPARE10_RESUME_FLOOR)',
        '  · weekly floor   off. A Resume lasts until the weekly reset (from SPARE10_WEEKLY_RESUME_FLOOR)',
      ]
    }
    if (l.startsWith('  · at the reserve ') && attended) return [l, '  · at the reset   continue by itself (from /config)']
    if (l.startsWith('  · reading ')) return [l, '  · weekly reading none: no reading yet']
    if (l.startsWith('  · consent ')) return [l, '  · weekly consent none']
    return [l]
  })
const nothingDecided = (w: World): void => {
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
}

test('/spare10 is registered at session start as an immediate command', async ($, on) => {
  const w = world(on, { pct: 50 })
  expect((await bash($)).result).toBe('ran') // loads the plugin before session.start
  expect(w.commands).toEqual([])
  await begin($, w)
  expect(w.commands).toEqual(['spare10'])
  expect(w.commandSpecs).toHaveLength(1)
  expect(w.commandSpecs[0]).toMatchObject({
    name: 'spare10',
    description: 'Show the spare10 quota breaker, or resume or stop at the reserve.',
    argumentHint: '[resume|stop]',
    immediate: true,
  })
  // the bare command and `status` print the same report, from any origin
  const bare = await run($, '')
  expect(bare?.startsWith(`version ${VERSION}\n`)).toBe(true)
  expect(await run($, 'status')).toBe(bare)
  expect(await run($, 'status', 'plugin')).toBe(bare)
  expect(await run($, '', 'sdk')).toBe(bare)
})

test('/spare10 reports the phase, reserve, reading, consent and guarded lines', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  await w.clock.advance(46 * 60_000) // 2 h 14 min before the reset
  expect(await report($)).toEqual(
    with02([
      `version ${VERSION}`,
      '',
      PHASE.armed('90'),
      '  · reserve        10% of the 5-hour window (from /config)',
      '  · at the reserve stop and ask you',
      `  · reading        live · ${pf('50', '50')} (in 2 h 14 min)`,
      '  · consent        none',
      '  · guarded        yes (scope all)',
      '  · claude -p      runs started here: stop', // B16 set SPARE10_HEADLESS=stop at session start
      '',
      ...FOOTER,
    ]),
  )
  // {duration}: '2 h 14 min', '14 min' or 'under 1 min'
  await w.clock.advance(2 * HOUR)
  expect(field(await report($), 'reading')).toBe(`  · reading        live · ${pf('50', '50')} (in 14 min)`)
  await w.clock.advance(13 * 60_000 + 30_000)
  expect(field(await report($), 'reading')).toBe(`  · reading        live · ${pf('50', '50')} (in under 1 min)`)
})

test('/spare10 shows env sources, every start-up warning, and ignores a consent beyond this window', async ($, on) => {
  const FAR = '2026-09-25T12:00:00.000Z'
  const w = world(on, {
    pct: 93,
    env: { SPARE10_RESERVE: '15', SPARE10: 'maybe', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', SPARE10_CONSENT: FAR },
    settings: { merged: { askUserQuestionTimeout: 60 } },
  })
  await begin($, w)
  const lines = await report($)
  expect(phaseLine(lines)).toBe(PHASE.trippedHold)
  expect(field(lines, 'reserve')).toBe('  · reserve        15% of the 5-hour window (from SPARE10_RESERVE)')
  expect(field(lines, 'reading')?.startsWith(`  · reading        live · ${pf('93', '7')} (in `)).toBe(true)
  expect(field(lines, 'consent')).toBe('  · consent        none')
  expect(field(lines, 'guarded')).toBe('  · guarded        yes (scope all)')
  expect(lines).toContain('  ⚠ SPARE10="maybe" is not on or off. spare10 uses the scope option (all).')
  expect(lines).toContain(`  ⚠ ${W_FLAG}`)
  expect(lines).toContain(
    '  ⚠ questions here continue by themselves after a time limit (askUserQuestionTimeout). An unanswered spare10 question then counts as Stop here, and spare10 continues the work at the time that the question names.',
  )
  expect(lines).toContain(`  ⚠ SPARE10_CONSENT="${FAR}" names a time after this 5-hour window. spare10 ignores it.`) // B30, R13
  expect(lines.slice(-3)).toEqual(['', ...FOOTER])
  // the warnings follow the fields, one line each
  const lastField = lines.indexOf(field(lines, 'claude -p') ?? '')
  const warned = lines.flatMap((l, i) => (i > 2 && l.startsWith('  ⚠ ') ? [i] : [])) // line 2 is the phase
  expect(lastField).toBeGreaterThan(2)
  expect(warned).toEqual([lastField + 1, lastField + 2, lastField + 3, lastField + 4])

  // Resume from the command (tripped, not stopped): consent for this window, and B30 no longer applies.
  expect(await run($, 'resume')).toBe(RESUMED_TRIPPED)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  const after = await report($)
  expect(phaseLine(after)).toBe(PHASE.consented)
  expect(field(after, 'consent')).toBe(`  · consent        ${UNTIL} (you chose to continue)`)
  expect(after.some((l) => l.includes('SPARE10_CONSENT='))).toBe(false)

  // Stop from consented (R4): consent cleared, stopped written, then a second stop changes nothing.
  expect(await run($, 'stop')).toBe(STOPPED_TRIPPED)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stoppedRe('S1'))
  expect(phaseLine(await report($))).toBe(PHASE.stoppedIdle)
  expect(await run($, 'stop')).toBe(ALREADY_STOPPED)
})

test('/spare10 names no reading and a blind sensor', async ($, on) => {
  const w = world(on, {})
  await begin($, w)
  let lines = await report($)
  expect(phaseLine(lines)).toBe(PHASE.waiting)
  expect(field(lines, 'reading')).toBe('  · reading        none: no reading yet')
  await $.session.measure(measure(undefined))
  await $.session.measure(measure(undefined))
  lines = await report($)
  expect(phaseLine(lines)).toBe(PHASE.blind)
  expect(field(lines, 'reading')).toBe('  · reading        none: Claude Code reports no quota (blind)')
})

test('/spare10 says the window reset once a remembered reading expires', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  expect((await bash($)).result).toBe('ran') // the gate remembers the live reading
  w.pct = undefined
  await w.clock.advance(3 * HOUR) // now is the reset
  const lines = await report($)
  expect(phaseLine(lines)).toBe(PHASE.waiting)
  expect(field(lines, 'reading')).toBe('  · reading        none: the window reset')
})

test('/spare10 resume while asking withdraws the dialog and releases the loops', async ($, on) => {
  const w = world(on, { pct: 93, agents: ['a1'] })
  await begin($, w)
  const main = bash($)
  const sub = bash($, 'a1')
  const subStep = drain($, step('a1', 'T9'))
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(pf('93', '7'))])
  expect(w.ran).toEqual([])
  expect(phaseLine(await report($))).toBe(PHASE.asking) // R7
  expect(await run($, 'resume')).toBe(RESUMED_ASKING)
  expect((await main).result).toBe('ran')
  expect((await sub).result).toBe('ran')
  expect((await subStep).text).toBe('hi')
  await w.clock.settle()
  expect([...w.ran].sort()).toEqual(['Bash:a1', 'Bash:main'])
  expect(w.requests).toBe(1)
  expect(w.dialogAborted).not.toBe('no') // the withdrawal hook ended the dialog beneath
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
  expect(phaseLine(await report($))).toBe(PHASE.consented)
  expect(await run($, 'resume')).toBe(ALREADY_RESUMED)
})

test('/spare10 resume after Stop consents, clears stopped and asks for a prompt', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Stop here' })
  await begin($, w)
  expect((await bash($)).deny).toBe(STOP93)
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stoppedRe('S1'))
  expect(phaseLine(await report($))).toBe(PHASE.stopped)
  expect(await run($, 'resume')).toBe(RESUMED_STOPPED)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  expect(phaseLine(await report($))).toBe(PHASE.consented)
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(await $.prompt.submit(typed('go on'))).toMatchObject({ text: 'go on' })
  expect(w.asked).toHaveLength(1)
})

test('/spare10 resume below the reserve changes nothing', async ($, on) => {
  const w = world(on, { answer: 'Resume' })
  await begin($, w)
  expect(await run($, 'resume')).toBe(NOTHING_TO_RESUME_NONE)
  expect(await run($, 'stop')).toBe(nothingToStop('90'))
  w.pct = 50
  expect(await run($, 'resume')).toBe(nothingToResume(pf('50', '50')))
  expect(await run($, 'stop')).toBe(nothingToStop('90'))
  await w.clock.settle()
  nothingDecided(w)
  w.pct = 93 // nothing was consented: the next crossing asks
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toHaveLength(1)
})

test('/spare10 stop while tripped makes the next step refuse', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  expect(phaseLine(await report($))).toBe(PHASE.trippedHold)
  expect(await run($, 'stop')).toBe(STOPPED_TRIPPED)
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stoppedRe('S1'))
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  const refused = await drain($, step(undefined, 'T1'))
  await w.clock.settle()
  expect(refused.text).toBe(PAUSED93)
  expect(w.requests).toBe(0)
  expect(w.aborts).toEqual(['T1'])
  expect((await bash($)).deny).toBe(STOP93)
  expect(w.ran).toEqual([])
  expect(w.asked).toEqual([]) // row 7: refused, never parked, no question
  expect(phaseLine(await report($))).toBe(PHASE.stopped)
  expect(await run($, 'stop')).toBe(ALREADY_STOPPED)
})

test('/spare10 stop while asking refuses the held loops and withdraws the dialog', async ($, on) => {
  const w = world(on, { pct: 93, agents: ['a1'] })
  await begin($, w)
  const mainStep = drain($, step(undefined, 'T1'))
  const sub = bash($, 'a1')
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(await run($, 'stop')).toBe(STOPPED_ASKING)
  expect((await sub).deny).toBe(STOP93)
  expect((await mainStep).text).toBe(PAUSED93)
  await w.clock.settle()
  expect(w.dialogAborted).not.toBe('no')
  expect(w.ran).toEqual([])
  expect(w.requests).toBe(0)
  expect(w.aborts).toEqual(['T1'])
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stoppedRe('S1'))
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect((await bash($)).deny).toBe(STOP93)
  expect(w.asked).toHaveLength(1)
  expect(phaseLine(await report($))).toBe(PHASE.stopped)
})

test('/spare10 stop in tell mode sets stopped, and the phase shows stopped, not told', async ($, on) => {
  const w = world(on, { pct: 93, agents: ['a1'], env: { SPARE10_PAUSE_PROMPT: 'Commit and stop.' } })
  await begin($, w)
  let lines = await report($)
  expect(phaseLine(lines)).toBe(PHASE.trippedTell)
  expect(field(lines, 'at the reserve')).toBe('  · at the reserve tell every agent: "Commit and stop."')
  const told = await bash($)
  expect(told.result).toBe('ran')
  expect(told.context).toContain(tellText(mf('10', '7'), 'Commit and stop.'))
  await w.clock.settle()
  expect(phaseLine(await report($))).toBe(PHASE.told(1))
  expect((await bash($, 'a1')).context).toContain(tellText(mf('10', '7'), 'Commit and stop.'))
  await w.clock.settle()
  expect(phaseLine(await report($))).toBe(PHASE.told(2))
  expect(await run($, 'stop')).toBe(STOPPED_TRIPPED)
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stoppedRe('S1'))
  lines = await report($)
  expect(phaseLine(lines)).toBe(PHASE.stoppedIdle)
  expect(lines.some((l) => l.includes('⏸'))).toBe(false)
  // row 7 comes before row 8: a stopped tell-mode session refuses like hold mode
  expect((await bash($)).deny).toBe(STOP93)
  expect((await drain($, step(undefined, 'T2'))).text).toBe(PAUSED93)
  expect(w.requests).toBe(0)
  expect(w.asked).toEqual([])
})

test('/spare10 stop on an open tell-mode prompt question drops the prompt and sets stopped', async ($, on) => {
  const w = world(on, { pct: 93, agents: ['a1'], env: { SPARE10_PAUSE_PROMPT: 'Commit and stop.' } })
  await begin($, w)
  expect((await bash($, 'a1')).context).toContain(tellText(mf('10', '7'), 'Commit and stop.')) // a1 told, main untold
  await w.clock.settle()
  expect(phaseLine(await report($))).toBe(PHASE.told(1))
  const p = $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([tellPromptQuestion(pf('93', '7'))]) // R7 tell wording
  expect(phaseLine(await report($))).toBe(PHASE.asking) // R1: asking ranks before told
  expect(await run($, 'stop')).toBe(STOPPED_ASKING_NO_WORK)
  expect(await p).toEqual({ drop: NOT_STARTED })
  await w.clock.settle()
  expect(w.prompts).toEqual([])
  expect(w.fills).toEqual(['hello'])
  expect(w.dialogAborted).not.toBe('no')
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stoppedRe('S1')) // B24: stopped in tell mode too
  expect(phaseLine(await report($))).toBe(PHASE.stoppedIdle)
  expect((await bash($)).deny).toBe(STOP93)
})

test('/spare10 resume from a non-person origin is refused', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Stop here' })
  await begin($, w)
  expect((await bash($)).deny).toBe(STOP93)
  await w.clock.settle()
  const stamp = w.env.get('SPARE10_STOPPED')
  expect(stamp).toMatch(stoppedRe('S1'))
  const others: Array<PromptOrigin['kind']> = ['plugin', 'sdk', 'task-notification', 'scheduled-trigger', 'peer', 'channel']
  for (const kind of others) {
    expect(await run($, 'resume', kind)).toBe(notPerson('resume'))
    expect(await run($, 'stop', kind)).toBe(notPerson('stop'))
    expect(await run($, 'simulate 20', kind)).toBe(notPerson('simulate'))
    expect(await run($, 'simulate off', kind)).toBe(notPerson('simulate'))
  }
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toBe(stamp)
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(phaseLine(await report($))).toBe(PHASE.stopped)
  // the bridge is the person on another surface
  expect(await run($, 'resume', 'bridge')).toBe(RESUMED_STOPPED)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
})

test('/spare10 simulate 95 trips the gate, off clears it with consent and stopped, and it never lowers a real reading', async ($, on) => {
  const w = world(on, { pct: 50, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])

  expect(await run($, 'simulate 95')).toBe(simulateSet('95', AT, OPEN_AT))
  const lines = await report($)
  expect(phaseLine(lines)).toBe(PHASE.trippedHold)
  expect(field(lines, 'reading')?.startsWith(`  · reading        test reading · ${pf('95', '5')} (in `)).toBe(true)
  expect((await bash($)).result).toBe('ran') // asked, and Resume
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(pf('95', '5'), TEST_LEAD)])
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // 3.5: a Resume on a test reading stays in this copy
  const badge = await $.ui.mount({ plugin: 'spare10', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect((await badge.find({ type: 'Text' }))?.text).toBe(' ⨯ spare10 (test)') // B21: the test reading is labelled

  expect(await run($, 'simulate off')).toBe(SIMULATE_OFF)
  await w.clock.settle()
  nothingDecided(w)
  expect((await badge.find({ type: 'Text' }))?.text).toBe(' ● spare10')
  await badge.unmount()
  const cleared = await report($)
  expect(phaseLine(cleared)).toBe(PHASE.armed('90'))
  expect(field(cleared, 'reading')?.startsWith(`  · reading        live · ${pf('50', '50')} (in `)).toBe(true)
  expect(field(cleared, 'consent')).toBe('  · consent        none')

  // off clears a stop too
  w.pct = 93
  w.answer = 'Stop here'
  expect((await bash($)).deny).toBe(STOP93)
  expect(w.asked).toHaveLength(2)
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stoppedRe('S1'))
  expect(await run($, 'simulate off')).toBe(SIMULATE_OFF)
  await w.clock.settle()
  nothingDecided(w)

  // a lower test reading never lowers the real one
  expect(await run($, 'simulate 20')).toBe(simulateSet('20', AT))
  const real = await report($)
  expect(phaseLine(real)).toBe(PHASE.trippedHold)
  expect(field(real, 'reading')?.startsWith(`  · reading        live · ${pf('93', '7')} (in `)).toBe(true)
  w.answer = 'Resume'
  expect((await bash($)).result).toBe('ran')
  expect(w.asked.map((a) => a.question)).toEqual([
    loopQuestion(pf('95', '5'), TEST_LEAD),
    loopQuestion(pf('93', '7')),
    loopQuestion(pf('93', '7')),
  ])
})

test('/spare10 simulate without a live reading resets five hours from now, and bad input says how to use it', async ($, on) => {
  const w = world(on, {})
  await begin($, w)
  for (const bad of ['simulate', 'simulate abc', 'simulate 101', 'simulate -1']) {
    expect(await run($, bad)).toBe(SIMULATE_BAD)
  }
  expect(phaseLine(await report($))).toBe(PHASE.waiting)
  const at = hhmm(T0 + 5 * HOUR)
  const opens = hhmm(T0 + 5 * HOUR - 20 * 60_000)
  expect(await run($, 'simulate 95.5')).toBe(simulateSet('95.5', at, opens))
  expect(field(await report($), 'reading')?.startsWith(`  · reading        test reading · ${pf('95.5', '4.5', at)} (in `)).toBe(true)
  expect(await run($, 'simulate 95')).toBe(simulateSet('95', at, opens))
  const lines = await report($)
  expect(phaseLine(lines)).toBe(PHASE.trippedHold)
  expect(field(lines, 'reading')?.startsWith(`  · reading        test reading · ${pf('95', '5', at)} (in `)).toBe(true)
  w.answer = 'Stop here'
  expect((await bash($)).deny).toBe(
    `spare10: the user stopped work at the quota reserve (${mf('10', '5', at)}). Stop now and wait for the user. Do not call any further tools.`,
  )
  expect(w.asked).toHaveLength(1)
})

test('an unknown verb says how to use the command', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  expect(await run($, 'pause')).toBe(unknownVerb('pause'))
  expect(await run($, 'Resume!')).toBe(unknownVerb('Resume!'))
  await w.clock.settle()
  nothingDecided(w)
  expect(w.asked).toEqual([])
})

test('a run that is not guarded answers resume and stop with the off reply', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10: 'off' } })
  await begin($, w)
  expect(await run($, 'resume')).toBe(NOT_GUARDED)
  expect(await run($, 'stop')).toBe(NOT_GUARDED)
  await w.clock.settle()
  nothingDecided(w)
  const lines = await report($)
  expect(phaseLine(lines)).toBe(PHASE.off)
  expect(field(lines, 'guarded')).toBe('  · guarded        no: SPARE10=off. spare10 only watches.')
  expect(field(lines, 'reading')?.startsWith(`  · reading        live · ${pf('93', '7')} (in `)).toBe(true)
  expect(field(lines, 'claude -p')).toBe('  · claude -p      runs started here: off') // B16 runs only when guarded
  expect((await bash($)).result).toBe('ran')
  expect((await drain($, step())).text).toBe('hi')
  expect(w.asked).toEqual([])
  // the test seam is not a guard verb: it still sets the reading a watching run shows
  w.pct = 50
  expect(await run($, 'simulate 95')).toBe(simulateSet('95', AT, OPEN_AT))
  const sim = await report($)
  expect(phaseLine(sim)).toBe(PHASE.off)
  expect(field(sim, 'reading')?.startsWith(`  · reading        test reading · ${pf('95', '5')} (in `)).toBe(true)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
})

test('an unattended run is not guarded: resume and stop change nothing and the report shows the policy', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [], env: { SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  await w.clock.advance(46 * 60_000)
  expect(await report($)).toEqual(
    with02(
      [
        `version ${VERSION}`,
        '',
        PHASE.reserve('stop'),
        '  · reserve        10% of the 5-hour window (from /config)',
        '  · at the reserve unattended policy stop',
        `  · reading        live · ${pf('93', '7')} (in 2 h 14 min)`,
        '  · consent        none',
        '  · guarded        no: this session is unattended.',
        '  · unattended     stop (from SPARE10_HEADLESS)', // unattended only, and no claude -p line
        '',
        ...FOOTER,
      ],
      false,
    ),
  )
  expect(await run($, 'resume')).toBe(NOT_GUARDED)
  expect(await run($, 'stop')).toBe(NOT_GUARDED)
  await w.clock.settle()
  nothingDecided(w)
  expect((await bash($)).deny).toBe(HEADLESS93)
  expect(w.asked).toEqual([])
})

test('/spare10 with SPARE10=on shows the switch, a decimal reserve and the quoted pause prompt', async ($, on) => {
  const w = world(on, {
    pct: 50,
    env: { SPARE10: 'on', SPARE10_RESERVE: '12.5', SPARE10_PAUSE_PROMPT: 'Say "done" and stop.', SPARE10_HEADLESS: 'prompt' },
  })
  await begin($, w)
  const lines = await report($)
  expect(phaseLine(lines)).toBe(PHASE.armed('87.5'))
  expect(field(lines, 'reserve')).toBe('  · reserve        12.5% of the 5-hour window (from SPARE10_RESERVE)')
  expect(field(lines, 'at the reserve')).toBe('  · at the reserve tell every agent: "Say \\"done\\" and stop."')
  expect(field(lines, 'guarded')).toBe('  · guarded        yes (SPARE10=on)')
  expect(field(lines, 'claude -p')).toBe('  · claude -p      runs started here: prompt') // B16 leaves a set value alone
  expect(field(lines, 'unattended')).toBeUndefined()
  expect(w.env.get('SPARE10_HEADLESS')).toBe('prompt')
  expect(await run($, 'stop')).toBe(nothingToStop('87.5'))
  w.pct = 87.4
  expect(await run($, 'resume')).toBe(nothingToResume(pf('87.4', '12.6')))
  w.pct = 87.5
  expect(phaseLine(await report($))).toBe(PHASE.trippedTell)
  expect(await run($, 'resume')).toBe(`you can use the reserve ${UNTIL}.`)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  const r = await bash($)
  expect(r.result).toBe('ran')
  expect((r.context ?? []).some((c) => c.startsWith('spare10 budget guard.'))).toBe(false) // B14
})

test('/spare10 reads a seed from another session', async ($, on) => {
  const w = world(on, { store: { seed: { pct: 70, resetsAtMs: R } } })
  await begin($, w)
  const lines = await report($)
  expect(phaseLine(lines)).toBe(PHASE.armed('90'))
  expect(field(lines, 'reading')?.startsWith(`  · reading        seed from another session · ${pf('70', '30')} (in `)).toBe(true)
})

test('/spare10 launched with SPARE10_SIMULATE uses the test reading, and simulate off clears it for good', async ($, on) => {
  const w = world(on, { pct: 50, env: { SPARE10_SIMULATE: '95' } })
  await begin($, w)
  let lines = await report($)
  expect(phaseLine(lines)).toBe(PHASE.trippedHold)
  expect(field(lines, 'reading')?.startsWith(`  · reading        test reading · ${pf('95', '5')} (in `)).toBe(true)
  expect(await run($, 'simulate off')).toBe(SIMULATE_OFF)
  await w.clock.settle()
  lines = await report($)
  expect(phaseLine(lines)).toBe(PHASE.armed('90'))
  expect(field(lines, 'reading')?.startsWith(`  · reading        live · ${pf('50', '50')} (in `)).toBe(true)
  expect((await bash($)).result).toBe('ran')
  expect(phaseLine(await report($))).toBe(PHASE.armed('90'))
  expect(w.asked).toEqual([])
  expect(w.env.get('SPARE10_SIMULATE')).toBe('95') // read once, never written back
})

test('in a stopped session an open prompt question takes the open-question row of stop and resume', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Stop here' })
  await begin($, w)
  expect((await bash($)).deny).toBe(STOP93)
  await w.clock.settle()
  w.answer = 'hang'
  const holdPrompt = holdPromptQuestion(pf('93', '7'))
  const first = $.prompt.submit(typed('first'))
  await w.clock.settle()
  expect(w.asked.map((a) => a.question)).toEqual([loopQuestion(pf('93', '7')), holdPrompt])
  expect(phaseLine(await report($))).toBe(PHASE.asking) // R1: asking ranks before stopped
  expect(await run($, 'stop')).toBe(STOPPED_ASKING)
  expect(await first).toEqual({ drop: NOT_STARTED })
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stoppedRe('S1'))
  const second = $.prompt.submit(typed('second'))
  await w.clock.settle()
  expect(w.asked).toHaveLength(3)
  expect(await run($, 'resume')).toBe(RESUMED_ASKING)
  expect(await second).toMatchObject({ text: 'second' })
  expect(w.prompts.map((e) => e.text)).toEqual(['second'])
  expect(w.prompts[0]?.context).toEqual([
    `spare10: earlier work stopped at the 10% quota reserve. The user now chose to continue on the reserve ${UNTIL}. Follow their message.`,
  ]) // B9
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
})

test('without resetsAt the replies say for one hour, and the fallback window end holds for the episode', async ($, on) => {
  const w = world(on, { pct: 50, resetsAt: null })
  await begin($, w)
  expect(await run($, 'resume')).toBe('nothing to resume. 50% used · 50% left · resets at an unknown time.')
  w.pct = 93
  expect(await run($, 'resume')).toBe('you can use the reserve for one hour.')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${new Date(T0 + HOUR).toISOString()}`)
  // the consent end is a known clock time here, so the phase line may name it: pin only the phase
  expect(phaseLine(await report($))?.startsWith('  ⨯ consented      you chose to continue. spare10 is quiet ')).toBe(true)
  await w.clock.advance(30 * 60_000)
  expect(await run($, 'resume')).toBe('already resumed for one hour.')
  expect(await run($, 'stop')).toBe(stoppedTripped(hhmm(T0 + 5 * HOUR))) // 3.1: the hold end is the first sight plus 5 h
  expect(await run($, 'resume')).toBe('resumed. You can use the reserve for one hour. Type a prompt to continue.')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${new Date(T0 + HOUR).toISOString()}`) // R11: the same end, not now + 1 h
  await w.clock.advance(31 * 60_000) // past the fallback end: consent lapses, a new episode starts
  expect(phaseLine(await report($))).toBe(PHASE.trippedHold)
  expect(await run($, 'resume')).toBe('you can use the reserve for one hour.')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${new Date(T0 + 61 * 60_000 + HOUR).toISOString()}`)
})

test('an unattended run with the default policy reports off from /config', async ($, on) => {
  const w = world(on, { pct: 93, surfaces: [] })
  await begin($, w)
  const lines = await report($)
  expect(phaseLine(lines)).toBe(PHASE.reserve('off'))
  expect(field(lines, 'at the reserve')).toBe('  · at the reserve unattended policy off')
  expect(field(lines, 'unattended')).toBe('  · unattended     off (from /config)')
  expect(w.env.get('SPARE10_HEADLESS')).toBeUndefined() // B16 is for guarded sessions only
  expect((await bash($)).result).toBe('ran')
})

test('a SPARE10_CONSENT set for this window at launch reads as consented until a stop clears it', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_CONSENT: RESETS } })
  await begin($, w)
  const lines = await report($)
  expect(phaseLine(lines)).toBe(PHASE.consented)
  expect(field(lines, 'consent')).toBe(`  · consent        ${UNTIL} (you chose to continue)`)
  expect(lines.slice(3).some((l) => l.startsWith('  ⚠ '))).toBe(false)
  expect(await run($, 'resume')).toBe(ALREADY_RESUMED)
  expect((await bash($)).result).toBe('ran')
  expect(await run($, 'stop')).toBe(STOPPED_TRIPPED)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stoppedRe('S1'))
})

test('after /clear the old stop no longer counts, and a stop names the new session', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Stop here' })
  await begin($, w)
  expect((await bash($)).deny).toBe(STOP93)
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stoppedRe('S1'))
  await clear($, w, 'S2') // a /clear: session.end, no session.start
  expect(phaseLine(await report($))).toBe(PHASE.trippedHold)
  expect(await run($, 'stop')).toBe(STOPPED_TRIPPED)
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stoppedRe('S2'))
  expect(await run($, 'stop')).toBe(ALREADY_STOPPED)
  expect(await run($, 'resume')).toBe(RESUMED_STOPPED)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S2 ${RESETS}`) // 9.3: stamped with the id of the writer
})

test('a /clear while a question is open: /spare10 stop stamps the new session id', async ($, on) => {
  const w = world(on, { pct: 93 })
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await clear($, w, 'S2') // R3: the question stays open across /clear
  expect(phaseLine(await report($))).toBe(PHASE.asking)
  expect(await run($, 'stop')).toBe(STOPPED_ASKING)
  expect((await held).deny).toBe(STOP93)
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stoppedRe('S2'))
  expect(phaseLine(await report($))).toBe(PHASE.stopped)
  expect((await bash($)).deny).toBe(STOP93)
  expect(w.asked).toHaveLength(1)
})

test('/spare10 resume after the window end releases the held work and writes no consent', async ($, on) => {
  const w = world(on, { pct: 93, env: { SPARE10_AUTO_RESUME: 'off' } }) // the 0.1 path: no timed release
  await begin($, w)
  const held = bash($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await w.clock.advance(3 * HOUR + 60_000) // past the question's window end
  w.pct = 5
  w.resetsAt = LATER // the new window
  expect(w.ran).toEqual([]) // B6: the window end releases nothing
  expect(phaseLine(await report($))).toBe(PHASE.askingNoAuto)
  expect(await run($, 'resume')).toBe(RESUMED_ASKING) // B23 row 1, the question's own figures
  expect((await held).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // R10, B3: no consent after the window end
  expect(w.env.get('SPARE10_STOPPED')).toBeUndefined()
  const lines = await report($)
  expect(phaseLine(lines)).toBe(PHASE.armed('90'))
  expect(field(lines, 'consent')).toBe('  · consent        none')
})

test('SPARE10_SIMULATE at launch trips an unattended run the same way', async ($, on) => {
  const w = world(on, { pct: 50, surfaces: [], env: { SPARE10_SIMULATE: '95', SPARE10_HEADLESS: 'stop' } })
  await begin($, w)
  const lines = await report($)
  expect(phaseLine(lines)).toBe(PHASE.reserve('stop'))
  expect(field(lines, 'reading')?.startsWith(`  · reading        test reading · ${pf('95', '5')} (in `)).toBe(true)
  expect((await bash($)).deny).toBe(
    `spare10 stopped this unattended run at the quota reserve (${mf('10', '5')}). No further model requests were sent. To pick it up later: claude --resume S1`,
  )
  expect(w.asked).toEqual([])
})

// ---- crossings during the command's own writes ----

test('/spare10 stop settles a question that a crossing opened during its writes', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Resume', agents: ['a1'] })
  await begin($, w)
  expect((await bash($)).result).toBe('ran') // Resume: this window is consented
  await w.clock.settle()
  w.answer = 'hang'
  w.envSetDelayMs = 1000 // each env write lands 1000 mock ms late
  const stop = $.command.run(cmd('stop'))
  await w.clock.advance(1500) // the consent is cleared, the stop is not written yet
  let late: ToolCallResult | undefined
  void bash($, 'a1').then((r) => {
    late = r
  })
  await w.clock.settle()
  expect(w.asked).toHaveLength(2) // the crossing saw neither consent nor stop, so it asked
  await w.clock.advance(1000) // the stop lands
  await w.clock.settle()
  expect(late?.deny).toBe(STOP93)
  expect(w.dialogAborted).not.toBe('no') // its dialog is withdrawn
  await w.clock.advance(1000)
  expect((await stop).text).toBe(STOPPED_TRIPPED)
  w.envSetDelayMs = 0
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stoppedRe('S1'))
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(w.ran).toEqual(['Bash:main'])
})

test('/spare10 stop during an in-flight consent read denies that call', async ($, on) => {
  const w = world(on, { pct: 93, answer: 'Resume' })
  await begin($, w)
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBe(`S1 ${RESETS}`)
  w.envGetDelayMs = { SPARE10_CONSENT: 500 } // the gate reads the consent now, and gets the answer late
  const call = bash($)
  await w.clock.settle()
  expect(await run($, 'stop')).toBe(STOPPED_TRIPPED)
  w.envGetDelayMs = {}
  await w.clock.advance(500)
  expect((await call).deny).toBe(STOP93) // the stale answer names the cleared consent: ignored
  expect(w.ran).toEqual(['Bash:main'])
})

// ---- 3.5: a Resume on a test reading never carries into real use ----

test('a Resume on a test reading stays in this copy: the env keeps no consent, and a lower test reading asks again', async ($, on) => {
  const w = world(on, { pct: 50, answer: 'Resume' })
  await begin($, w)
  expect(await run($, 'simulate 95')).toBe(simulateSet('95', AT, OPEN_AT))
  expect((await bash($)).result).toBe('ran') // asked, and Resume
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined() // a reload or a respawn starts with no consent
  expect(field(await report($), 'consent')).toBe(`  · consent        ${UNTIL} (you chose to continue)`)
  // A new test reading replaces the old one, and the answer given under the old one goes with it. A
  // strictly higher value raises in place (floor B53), so the new value here is lower.
  expect(await run($, 'simulate 94')).toBe(simulateSet('94', AT, OPEN_AT))
  expect(field(await report($), 'consent')).toBe('  · consent        none')
  w.answer = 'Stop here'
  expect((await bash($)).deny).toBe(`spare10: the user stopped work at the quota reserve (${mf('10', '6')}). Stop now and wait for the user. Do not call any further tools.`)
  expect(w.asked).toHaveLength(2)
  await w.clock.settle()
  expect(w.env.get('SPARE10_STOPPED')).toMatch(stoppedRe('S1'))
  // The stop given under that test goes with it too, and a real trip then asks.
  expect(await run($, 'simulate 0')).toBe(simulateSet('0', AT))
  await w.clock.settle()
  nothingDecided(w)
  w.pct = 93
  expect((await bash($)).deny).toBe(STOP93)
  expect(w.asked).toHaveLength(3)
})

test('a Resume on a test reading does not cover a real reading that climbs past it', async ($, on) => {
  const w = world(on, { pct: 50, answer: 'Resume' })
  await begin($, w)
  await run($, 'simulate 92')
  expect((await bash($)).result).toBe('ran')
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect((await bash($)).result).toBe('ran') // the test reading applies: its consent holds
  expect(w.asked).toHaveLength(1)
  w.pct = 95 // the real reading is now the higher one
  w.answer = 'Stop here'
  expect((await bash($)).deny).toBe(
    `spare10: the user stopped work at the quota reserve (${mf('10', '5')}). Stop now and wait for the user. Do not call any further tools.`,
  )
  expect(w.asked).toHaveLength(2)
})

test('/spare10 resume on a test reading also stays in this copy', async ($, on) => {
  const w = world(on, { pct: 50 })
  await begin($, w)
  await run($, 'simulate 95')
  expect(await run($, 'resume')).toBe(RESUMED_TRIPPED)
  await w.clock.settle()
  expect(w.env.get('SPARE10_CONSENT')).toBeUndefined()
  expect(phaseLine(await report($))).toBe(PHASE.consented)
  expect((await bash($)).result).toBe('ran')
  expect(w.asked).toEqual([])
})

test('/spare10 stop with Continue at the reset off and no reset time stops for the one-hour fallback (0.1)', async ($, on) => {
  const w = world(on, { pct: 93, resetsAt: null, env: { SPARE10_AUTO_RESUME: 'off' } })
  await begin($, w)
  expect(await run($, 'stop')).toBe('stopped at the reserve. Type a prompt to be asked again, or run /spare10 resume.')
  await w.clock.settle()
  // The consent bound (the one-hour fallback), not the hold end (the first sight plus 5 h).
  expect(w.env.get('SPARE10_STOPPED')).toBe(`S1 ${T0 + HOUR} ${T0} five_hour`)
})
