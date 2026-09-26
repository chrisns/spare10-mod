import { test, expect } from 'claude-code/testing'
import {
  ARGUMENT_HINT,
  COMMAND_DESCRIPTION,
  HEADER,
  HEADLESS_GENERIC,
  NOT_STARTED_GENERIC,
  QUESTION_OPTIONS,
  RESUME_LABEL,
  STOP_GENERIC,
  VERSION,
  W_FLAG,
  asksText,
  atText,
  badWarning,
  bgEnvWarning,
  clockText,
  commandFailed,
  consentWarning,
  debugLine,
  eventText,
  factsOf,
  floorWarning,
  fmtDuration,
  fmtPct,
  formatClock,
  headlessText,
  leadText,
  modelFacts,
  notPerson,
  notStarted,
  notice,
  pauseInstruction,
  pausedText,
  personFacts,
  questionText,
  resetContext,
  resetText,
  resumeContext,
  resumePrompt,
  resumeReply,
  simulateReply,
  soonText,
  spanText,
  statusReport,
  stepsIn,
  stopReply,
  stopText,
  timeoutWarning,
  unknownVerb,
  untilFor,
  untilPhrase,
  untilText,
  whenOf,
  withdrawnText,
  yourReserves,
} from '../../hooks/core/text.ts'
import type { Ended, Facts, Named, ReplyCase, StatusInput } from '../../hooks/core/text.ts'
import { badgeView } from '../../hooks/core/badge.ts'
import type { Phase } from '../../hooks/core/decide.ts'
import type { Basis, Kind } from '../../hooks/core/reading.ts'

const TZ = 'UTC'
const T0 = Date.parse('2026-09-24T12:00:00Z')
const RESETS = '2026-09-24T15:00:00.000Z' // 3 h after T0
const R = Date.parse(RESETS)
const MIN = 60_000

const F: Facts = { used: 92, left: 8, resetsAtMs: R, reserve: 10, timeZone: TZ }
const NO_RESET: Facts = { used: 91.5, left: 8.5, resetsAtMs: null, reserve: 10, timeZone: TZ }
const LIVE: Basis = { kind: 'live', pct: 92, resetsAtMs: R }

test('formatClock renders HH:MM in a given time zone', () => {
  expect(formatClock(R, 'UTC')).toBe('15:00')
  expect(formatClock(R, 'America/New_York')).toBe('11:00')
  expect(formatClock(Date.parse('2026-09-24T00:05:00Z'), 'UTC')).toBe('00:05')
  expect(formatClock(Date.parse('2026-09-24T23:59:00Z'), 'UTC')).toBe('23:59')
  expect(formatClock(R)).toMatch(/^\d\d:\d\d$/)
})

test('fmtDuration says hours and minutes', () => {
  expect(fmtDuration(0)).toBe('under 1 min')
  expect(fmtDuration(59_000)).toBe('under 1 min')
  expect(fmtDuration(-5 * MIN)).toBe('under 1 min')
  expect(fmtDuration(14 * MIN)).toBe('14 min')
  expect(fmtDuration(14 * MIN + 59_000)).toBe('14 min')
  expect(fmtDuration(60 * MIN)).toBe('1 h 0 min')
  expect(fmtDuration(134 * MIN)).toBe('2 h 14 min')
})

test('facts lead with what is used and left and when it resets', () => {
  expect(personFacts(F)).toBe('92% used · 8% left · resets 15:00')
  expect(modelFacts(F)).toBe('into your 10% reserve · 8% of quota left · resets 15:00')
  expect(personFacts(NO_RESET)).toBe('91.5% used · 8.5% left · resets at an unknown time')
  expect(modelFacts(NO_RESET)).toBe('into your 10% reserve · 8.5% of quota left · resets at an unknown time')
  expect(untilText(F)).toBe('until 15:00')
  expect(untilText(NO_RESET)).toBe('for one hour')
  expect(fmtPct(91)).toBe('91')
  expect(fmtPct(91.5)).toBe('91.5')
  expect(fmtPct(91.54)).toBe('91.5')
  expect(fmtPct(90.0)).toBe('90')
  expect(fmtPct(-0)).toBe('0')
  expect(factsOf({ kind: 'live', pct: 92.3, resetsAtMs: R }, 10, TZ)).toEqual({ used: 92.3, left: 7.7, resetsAtMs: R, reserve: 10, timeZone: TZ })
  expect(factsOf({ kind: 'seed', pct: 100, resetsAtMs: null }, 40)).toEqual({ used: 100, left: 0, resetsAtMs: null, reserve: 40 })
  expect(factsOf({ kind: 'test', pct: 104.2, resetsAtMs: R }, 10).left).toBe(0)
  expect(personFacts(factsOf({ kind: 'live', pct: 92.3, resetsAtMs: R }, 12.5, TZ))).toBe('92.3% used · 7.7% left · resets 15:00')
  expect(modelFacts(factsOf({ kind: 'live', pct: 92.3, resetsAtMs: R }, 12.5, TZ))).toBe('into your 12.5% reserve · 7.7% of quota left · resets 15:00')
})

test('the pause instruction frames who is asking and why', () => {
  const text = pauseInstruction(F, 'Open a draft PR, then wait.')
  expect(text).toStartWith('spare10 budget guard.')
  expect(text).toContain('safe usage limit for this session')
  expect(text).toContain('Immediately wrap up your work and stop.')
  expect(text).toContain('8% of quota left')
  expect(text).toEndWith('User instructions: Open a draft PR, then wait.')
  expect(text.match(/spare10/g)?.length).toBe(1)
  expect(text).toBe(
    'spare10 budget guard. You have reached the safe usage limit for this session (into your 10% reserve · 8% of quota left · resets 15:00). ' +
      'Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.\n\n' +
      'User instructions: Open a draft PR, then wait.',
  )
})

test('without user text the pause instruction has no User instructions paragraph', () => {
  for (const none of [null, '', '   ']) {
    const text = pauseInstruction(F, none)
    expect(text).not.toContain('User instructions')
    expect(text).not.toContain('\n')
    expect(text).toEndWith('unless the user instructs otherwise.')
  }
})

test('the stop text tells the model to stop and wait, with the figures', () => {
  const text = stopText(F)
  expect(text).toContain('8% of quota left')
  expect(text).toContain('into your 10% reserve')
  expect(text).toContain('Do not call any further tools')
  expect(text).toContain('resets 15:00')
  expect(text).toBe(
    'spare10: the user stopped work at the quota reserve (into your 10% reserve · 8% of quota left · resets 15:00). Stop now and wait for the user. Do not call any further tools.',
  )
  expect(STOP_GENERIC).toBe('spare10: stopped at the quota reserve. Stop now and wait for the user. Do not call any further tools.')
})

test('the paused text says no request was sent and the task is not finished', () => {
  expect(pausedText(F)).toBe(
    'spare10: work stopped at the quota reserve (into your 10% reserve · 8% of quota left · resets 15:00). No model request was sent, so this task is not finished. Wait for the user.',
  )
})

test('the headless text carries the resume command', () => {
  const text = headlessText(F, 'S1')
  expect(text).toContain('claude --resume S1')
  expect(text).toBe(
    'spare10 stopped this unattended run at the quota reserve (into your 10% reserve · 8% of quota left · resets 15:00). No further model requests were sent. To pick it up later: claude --resume S1',
  )
})

test('the question has a loop wording and a prompt wording, both with the figures and the until time', () => {
  expect(questionText(F, 'loop', 'hold')).toBe(
    'Your 10% reserve is reached: 92% used · 8% left · resets 15:00. All work is on hold. Continue on the reserve until 15:00?',
  )
  expect(questionText(F, 'prompt', 'hold')).toBe(
    'Your 10% reserve is reached: 92% used · 8% left · resets 15:00. spare10 holds your prompt and any other work. Continue on the reserve until 15:00?',
  )
  expect(questionText(F, 'prompt', 'tell')).toBe(
    'Your 10% reserve is reached: 92% used · 8% left · resets 15:00. spare10 holds your prompt. Continue on the reserve until 15:00?',
  )
  expect(questionText(NO_RESET, 'loop', 'hold')).toBe(
    'Your 10% reserve is reached: 91.5% used · 8.5% left · resets at an unknown time. All work is on hold. Continue on the reserve for one hour?',
  )
})

test('the options put Stop here first and the header fits 12 characters', () => {
  expect(QUESTION_OPTIONS).toEqual(['Stop here', 'Resume'])
  expect(QUESTION_OPTIONS[1]).toBe(RESUME_LABEL)
  expect(HEADER).toBe('spare10')
  expect(HEADER.length).toBeLessThanOrEqual(12)
  expect(VERSION).toBe('0.3.0')
  expect(COMMAND_DESCRIPTION).toBe('Show the spare10 quota breaker, or resume or stop at the reserve.')
  expect(ARGUMENT_HINT).toBe('[resume|stop]')
})

test('not started names /spare10 resume', () => {
  expect(notStarted(F)).toBe(
    'spare10: not started. This session is inside your 10% reserve until 15:00. Send the prompt again to be asked again, or run /spare10 resume.',
  )
  expect(NOT_STARTED_GENERIC).toBe('spare10: not started. spare10 could not ask you. Send the prompt again, or run /spare10 resume.')
  expect(NOT_STARTED_GENERIC).toContain('/spare10 resume')
  expect(resumeContext(F)).toBe(
    'spare10: earlier work stopped at the 10% quota reserve. The user now chose to continue on the reserve until 15:00. Follow their message.',
  )
})

// D1: the engine puts `spare10: ` in front of each transcript line and command reply, so these texts
// leave it out. Debug lines, model texts and drop reasons keep it (the engine does not prefix them).
test('the notices, warnings and replies are the section 2 texts, without the prefix that the engine adds', () => {
  expect(notice.continuing(F)).toBe('continuing on your 10% reserve. spare10 stays quiet until 15:00.')
  expect(notice.newWindow).toBe('held work continues on the new 5-hour window.')
  expect(notice.stopped(F)).toBe('stopped at your 10% reserve. Type a prompt to be asked again, or run /spare10 resume.')
  expect(notice.resetWaiting).toBe('the 5-hour window reset. Held work still waits for your answer.')
  expect(notice.told(F)).toBe('your 10% reserve is reached. spare10 told the agents to wind down.')
  for (const policy of ['off', 'prompt', 'stop'] as const) {
    expect(debugLine.unattended(F, policy)).toBe(`spare10: unattended run inside the reserve (92% used · 8% left · resets 15:00), policy ${policy}.`)
  }
  expect(debugLine.told('S1:main')).toBe('spare10: told S1:main')
  expect(debugLine.handedOn(2)).toBe('spare10: the loop that asked went away. spare10 asks again (2).')
  expect(debugLine.abortFailed('Error: gone')).toBe('spare10: turn.abort failed: Error: gone')
  expect(withdrawnText('resume')).toBe('spare10: withdrawn (resume)')
  expect(withdrawnText(undefined)).toBe('spare10: withdrawn (closed)')
  expect(badWarning('SPARE10_RESERVE', 'abc', '10')).toBe('SPARE10_RESERVE="abc" is not 1 to 99. spare10 uses 10.')
  expect(badWarning('SPARE10_HEADLESS', 'x', 'off')).toBe('SPARE10_HEADLESS="x" is not off, prompt, stop or wait. spare10 uses off.')
  expect(badWarning('SPARE10', 'maybe', 'all')).toBe('SPARE10="maybe" is not on or off. spare10 uses the scope option (all).')
  expect(W_FLAG).toBe(
    'function hooks are on only in this shell. Background sessions and pane teammates start without spare10. Put CLAUDE_CODE_ENABLE_FUNCTION_HOOKS in the env block of ~/.claude/settings.json.',
  )
  expect(timeoutWarning('askUserQuestionTimeout')).toBe(
    'questions here continue by themselves after a time limit (askUserQuestionTimeout). An unanswered spare10 question then counts as Stop here.',
  )
  expect(consentWarning('2026-09-25T00:00:00.000Z')).toBe(
    'SPARE10_CONSENT="2026-09-25T00:00:00.000Z" names a time after this 5-hour window. spare10 ignores it.',
  )
  expect(bgEnvWarning([['SPARE10', 'off']])).toBe(
    'this background session has SPARE10="off". A background session gets such values from the claude daemon or a settings file, not from your terminal.',
  )
  expect(bgEnvWarning([['SPARE10_RESERVE', '15'], ['SPARE10_PAUSE_PROMPT', 'Say "done".']])).toBe(
    'this background session has SPARE10_RESERVE="15", SPARE10_PAUSE_PROMPT="Say \\"done\\".". A background session gets such values from the claude daemon or a settings file, not from your terminal.',
  )
  expect(resumeReply('asking', F)).toBe('resumed. Held work continues on the reserve until 15:00.')
  expect(resumeReply('stopped', F)).toBe('resumed. You can use the reserve until 15:00. Type a prompt to continue.')
  expect(resumeReply('tripped', F)).toBe('you can use the reserve until 15:00.')
  expect(resumeReply('consented', F)).toBe('already resumed until 15:00.')
  expect(resumeReply('below', { ...F, used: 50, left: 50 })).toBe('nothing to resume. 50% used · 50% left · resets 15:00.')
  expect(resumeReply('none')).toBe('nothing to resume. There is no 5-hour reading yet.')
  expect(resumeReply('off')).toBe('this run is not guarded. Nothing changed.')
  expect(stopReply('asking', F)).toBe('stopped. Held work is refused.')
  expect(stopReply('tripped', F)).toBe('stopped at the reserve. Type a prompt to be asked again, or run /spare10 resume.')
  expect(stopReply('stopped', F)).toBe('already stopped.')
  expect(stopReply('below', F, 90)).toBe('nothing to stop. spare10 steps in at 90% used.')
  expect(stopReply('none', undefined, 60)).toBe('nothing to stop. spare10 steps in at 60% used.')
  expect(stopReply('off')).toBe('this run is not guarded. Nothing changed.')
  expect(notPerson('resume')).toBe('only you can run /spare10 resume. Nothing changed.')
  expect(unknownVerb('pause')).toBe('unknown command "pause". Use /spare10, /spare10 resume or /spare10 stop.')
  expect(simulateReply('set', { ...F, used: 95, left: 5 })).toBe(
    'test reading set to 95% used, resets 15:00. It can only raise the real reading. Run /spare10 simulate off to clear it.',
  )
  expect(simulateReply('off')).toBe('test reading cleared. Consent and stop for this window are cleared too.')
  expect(simulateReply('bad')).toBe(
    '/spare10 simulate takes a percentage from 0 to 100, or off. Add weekly for the weekly window, and in 22m for a test window that resets in 22 minutes.',
  )
  expect(commandFailed('boom')).toBe('/spare10 failed: boom')
})

const status = (over: Partial<StatusInput> = {}): StatusInput => ({
  phase: 'armed',
  mode: 'hold',
  reserve: 10,
  reserveFrom: 'option',
  pausePrompt: null,
  attended: true,
  headless: 'off',
  headlessFrom: 'option',
  childPolicy: 'stop',
  enabled: true,
  enabledFrom: 'scope',
  scope: 'all',
  basis: { kind: 'live', pct: 50, resetsAtMs: R },
  facts: { used: 50, left: 50, resetsAtMs: R, reserve: 10, timeZone: TZ },
  now: T0,
  toldCount: 0,
  warnings: [],
  timeZone: TZ,
  ...over,
})
const FOOT = ['', '/spare10 resume   continue on the reserve until the window resets', '/spare10 stop     stop at the reserve now']

test('the status report prints every field', () => {
  expect(statusReport(status()).split('\n')).toEqual([
    'version 0.3.0',
    '',
    '  ● armed          spare10 steps in at 90% used.',
    '  · reserve        10% of the 5-hour window (from /config)',
    '  · at the reserve stop and ask you',
    '  · reading        live · 50% used · 50% left · resets 15:00 (in 3 h 0 min)',
    '  · consent        none',
    '  · guarded        yes (scope all)',
    '  · claude -p      runs started here: stop',
    ...FOOT,
  ])

  const tripped = { basis: LIVE, facts: F }
  const stopped = statusReport(status({ ...tripped, phase: 'stopped', reserveFrom: 'env', warnings: [W_FLAG] })).split('\n')
  expect(stopped[2]).toBe('  ■ stopped        you chose Stop here. Type a prompt to be asked again, or run /spare10 resume.')
  expect(stopped[3]).toBe('  · reserve        10% of the 5-hour window (from SPARE10_RESERVE)')
  expect(stopped[5]).toBe('  · reading        live · 92% used · 8% left · resets 15:00 (in 3 h 0 min)')
  expect(stopped[9]).toBe(`  ⚠ ${W_FLAG}`)
  expect(stopped.slice(10)).toEqual(FOOT)

  const consented = statusReport(status({ ...tripped, phase: 'consented', consentUntil: R })).split('\n')
  expect(consented[2]).toBe('  ⨯ consented      you chose to continue. spare10 is quiet until 15:00.')
  expect(consented[6]).toBe('  · consent        until 15:00 (you chose to continue)')

  const off = statusReport(status({ phase: 'off', enabled: false, enabledFrom: 'SPARE10' })).split('\n')
  expect(off[2]).toBe('  ○ off            spare10 only watches in this run.')
  expect(off[7]).toBe('  · guarded        no: SPARE10=off. spare10 only watches.')
  const optIn = statusReport(status({ phase: 'off', enabled: false, scope: 'opt-in' })).split('\n')
  expect(optIn[7]).toBe('  · guarded        no: scope opt-in. Start with SPARE10=on to guard a run.')
  const on = statusReport(status({ enabledFrom: 'SPARE10', scope: 'opt-in' })).split('\n')
  expect(on[7]).toBe('  · guarded        yes (SPARE10=on)')

  const asking = statusReport(status({ ...tripped, phase: 'asking' })).split('\n')
  expect(asking[2]).toBe(
    '  ? asking         a question is open. Held work waits until you answer. If no dialog shows, run /spare10 resume or /spare10 stop.',
  )

  const tell = statusReport(status({ ...tripped, phase: 'told', mode: 'tell', pausePrompt: 'Commit "all", then stop.', toldCount: 2 })).split('\n')
  expect(tell[2]).toBe('  ⏸ told           the wind-down went to 2 agent(s).')
  expect(tell[4]).toBe('  · at the reserve tell every agent: "Commit \\"all\\", then stop."')

  const unattended = statusReport(
    status({ ...tripped, phase: 'reserve', attended: false, headless: 'stop', headlessFrom: 'env', basis: { kind: 'seed', pct: 92, resetsAtMs: R } }),
  ).split('\n')
  expect(unattended[2]).toBe('  ⚠ tripped        unattended run, policy stop.')
  expect(unattended[4]).toBe('  · at the reserve unattended policy stop')
  expect(unattended[5]).toBe('  · reading        seed from another session · 92% used · 8% left · resets 15:00 (in 3 h 0 min)')
  expect(unattended[7]).toBe('  · guarded        no: this session is unattended.')
  expect(unattended[8]).toBe('  · unattended     stop (from SPARE10_HEADLESS)')
  expect(unattended).not.toContain('  · claude -p      runs started here: stop')

  const lines = (over: Partial<StatusInput>) => statusReport(status(over)).split('\n')
  expect(lines({ ...tripped, phase: 'tripped' })[2]).toBe('  ⚠ tripped        spare10 holds the next step and asks you.')
  expect(lines({ ...tripped, phase: 'tripped', mode: 'tell' })[2]).toBe('  ⚠ tripped        spare10 tells each agent to wind down at its next step.')
  expect(lines({ phase: 'blind', basis: { kind: 'none', why: 'blind' } })[2]).toBe(
    '  ⚠ blind          Claude Code reports no 5-hour quota. spare10 lets all work through.',
  )
  expect(lines({ phase: 'blind', basis: { kind: 'none', why: 'blind' } })[5]).toBe('  · reading        none: Claude Code reports no quota (blind)')
  expect(lines({ phase: 'waiting', basis: { kind: 'none', why: 'no-reading' } })[2]).toBe(
    '  ⧗ waiting        no reading yet. spare10 lets all work through.',
  )
  expect(lines({ phase: 'waiting', basis: { kind: 'none', why: 'no-reading' } })[5]).toBe('  · reading        none: no reading yet')
  expect(lines({ phase: 'waiting', basis: { kind: 'none', why: 'window-reset' } })[5]).toBe('  · reading        none: the window reset')
  expect(lines({ basis: { kind: 'test', pct: 50, resetsAtMs: R } })[5]).toBe(
    '  · reading        test reading · 50% used · 50% left · resets 15:00 (in 3 h 0 min)',
  )
  expect(lines({ reserve: 40, facts: { used: 50, left: 50, resetsAtMs: R, reserve: 40, timeZone: TZ } })[2]).toBe(
    '  ● armed          spare10 steps in at 60% used.',
  )
  // D2: without a reset time the reading says so once, with no time left.
  expect(lines({ basis: { kind: 'live', pct: 50, resetsAtMs: null }, facts: { used: 50, left: 50, resetsAtMs: null, reserve: 10, timeZone: TZ } })[5]).toBe(
    '  · reading        live · 50% used · 50% left · resets at an unknown time',
  )
  for (const basis of [LIVE, { kind: 'seed', pct: 92, resetsAtMs: R }, { kind: 'test', pct: 95, resetsAtMs: R }] as Basis[]) {
    expect(lines({ basis, facts: factsOf(basis, 10, TZ) })[5]?.match(/resets/g)).toHaveLength(1) // not `resets ... resets in`
  }
})

// D4: the phase detail and each field value start in one column, whatever the phase and the fields.
test('every phase line and field line of the report starts its value in the same column', () => {
  const phases: Phase[] = ['off', 'blind', 'waiting', 'armed', 'consented', 'open', 'stopped', 'asking', 'told', 'reserve', 'tripped']
  for (const phase of phases) {
    for (const attended of [true, false]) {
      const lines = statusReport(status({ phase, attended, consentUntil: R, warnings: [W_FLAG] })).split('\n')
      const rows = lines.slice(2, 9) // the phase line and the six fields
      expect(rows[1]?.startsWith('  · reserve ')).toBe(true)
      expect(rows[6]?.startsWith(attended ? '  · claude -p ' : '  · unattended ')).toBe(true)
      for (const row of rows) {
        const chars = [...row]
        expect(chars.slice(0, 4).join('')).toMatch(/^ {2}\S $/) // two spaces, the mark, a space
        expect(chars[18]).toBe(' ') // at least one space after the label
        expect(chars[19]).not.toBe(' ') // the value starts at column 19
      }
    }
  }
})

// A mechanical guard for D1: each class of text, with sample figures.
function enginePrefixed(): string[] {
  const out: string[] = [
    W_FLAG,
    notice.newWindow,
    notice.resetWaiting,
    badWarning('SPARE10_RESERVE', '0', '10'),
    badWarning('SPARE10_HEADLESS', 'x', 'off'),
    badWarning('SPARE10', 'x', 'opt-in'),
    timeoutWarning('askUserQuestionTimeout'),
    consentWarning('2026-09-25T00:00:00.000Z'),
    bgEnvWarning([['SPARE10', 'off']]),
    notPerson('stop'),
    unknownVerb('pause'),
    simulateReply('off'),
    simulateReply('bad'),
    commandFailed('boom'),
    statusReport(status()),
  ]
  for (const f of [F, NO_RESET]) {
    out.push(notice.continuing(f), notice.stopped(f), notice.told(f), simulateReply('set', f))
    for (const c of ['asking', 'stopped', 'tripped', 'consented', 'below', 'none', 'off'] as ReplyCase[]) out.push(resumeReply(c, f))
    for (const c of ['asking', 'stopped', 'tripped', 'below', 'none', 'off'] as const) out.push(stopReply(c, f, 90))
  }
  return [...out, ...newEnginePrefixed(), ...floorEnginePrefixed()]
}

test('no transcript line, warning or command reply starts with the prefix that the engine adds', () => {
  const texts = enginePrefixed()
  expect(texts.length).toBeGreaterThan(40)
  for (const t of texts) {
    expect(t.startsWith('spare10: ')).toBe(false)
    expect(t.startsWith('spare10 ')).toBe(false) // the report header too: it renders as `spare10: version 0.3.0`
  }
})

test('model texts, drop reasons and debug lines keep their own spare10 prefix', () => {
  const kept = [
    STOP_GENERIC,
    NOT_STARTED_GENERIC,
    stopText(F),
    pausedText(F),
    resumeContext(F),
    notStarted(F),
    debugLine.told('S1:main'),
    debugLine.handedOn(1),
    debugLine.abortFailed('gone'),
    debugLine.unattended(F, 'stop'),
  ]
  for (const t of kept) expect(t.startsWith('spare10: ')).toBe(true)
  expect(headlessText(F, 'S1').startsWith('spare10 stopped this unattended run')).toBe(true)
  expect(pauseInstruction(F, null).startsWith('spare10 budget guard.')).toBe(true)
  // The floor forms of floor 2.3 keep theirs too.
  for (const t of floorModelTexts()) {
    if (t.startsWith('spare10 budget guard.')) continue
    expect(t.startsWith('spare10: ')).toBe(true)
  }
})

// Every user-facing string, with sample figures: no em-dash, no en-dash, no semicolon (STE).
function everyText(): string[] {
  const facts = [F, NO_RESET, { ...F, reserve: 12.5, used: 88.4, left: 11.6 }]
  const out: string[] = [
    VERSION,
    HEADER,
    ...QUESTION_OPTIONS,
    RESUME_LABEL,
    COMMAND_DESCRIPTION,
    ARGUMENT_HINT,
    STOP_GENERIC,
    NOT_STARTED_GENERIC,
    W_FLAG,
    notice.newWindow,
    notice.resetWaiting,
    debugLine.told('S1:main'),
    debugLine.handedOn(1),
    debugLine.abortFailed('Error: gone'),
    commandFailed('boom'),
    bgEnvWarning([['SPARE10', 'off'], ['SPARE10_RESERVE', '15']]),
    withdrawnText('resume'),
    withdrawnText('stop'),
    withdrawnText(undefined),
    badWarning('SPARE10_RESERVE', '0', '10'),
    badWarning('SPARE10_HEADLESS', 'x', 'off'),
    badWarning('SPARE10', 'x', 'opt-in'),
    timeoutWarning('askUserQuestionTimeout'),
    timeoutWarning('CLAUDE_AFK_TIMEOUT_MS'),
    consentWarning('2026-09-25T00:00:00.000Z'),
    notPerson('stop'),
    unknownVerb('pause'),
    simulateReply('off'),
    simulateReply('bad'),
    resumeReply('none'),
    resumeReply('off'),
    stopReply('none', undefined, 90),
    stopReply('off'),
    fmtDuration(0),
    fmtDuration(134 * MIN),
  ]
  for (const f of facts) {
    out.push(personFacts(f), modelFacts(f), untilText(f), stopText(f), pausedText(f), headlessText(f, 'S1'))
    out.push(pauseInstruction(f, null), pauseInstruction(f, 'Commit, then stop.'), resumeContext(f), notStarted(f))
    out.push(notice.continuing(f), notice.stopped(f), notice.told(f), simulateReply('set', f))
    for (const policy of ['off', 'prompt', 'stop'] as const) out.push(debugLine.unattended(f, policy))
    for (const opener of ['loop', 'prompt'] as const) for (const mode of ['hold', 'tell'] as const) out.push(questionText(f, opener, mode))
    for (const c of ['asking', 'stopped', 'tripped', 'consented', 'below', 'none', 'off'] as ReplyCase[]) out.push(resumeReply(c, f))
    for (const c of ['asking', 'stopped', 'tripped', 'below', 'none', 'off'] as const) out.push(stopReply(c, f), stopReply(c, f, 90))
  }
  const phases: Phase[] = ['off', 'blind', 'waiting', 'armed', 'consented', 'open', 'stopped', 'asking', 'told', 'reserve', 'tripped']
  const bases: Basis[] = [LIVE, { kind: 'seed', pct: 92, resetsAtMs: null }, { kind: 'test', pct: 95, resetsAtMs: R }, { kind: 'none', why: 'blind' }, { kind: 'none', why: 'no-reading' }, { kind: 'none', why: 'window-reset' }]
  for (const phase of phases)
    for (const mode of ['hold', 'tell'] as const)
      for (const attended of [true, false])
        for (const basis of bases) {
          out.push(
            statusReport(
              status({ phase, mode, attended, basis, facts: factsOf(basis, 10, TZ), pausePrompt: mode === 'tell' ? 'Wrap up.' : null, consentUntil: R, toldCount: 3, warnings: [W_FLAG] }),
            ),
          )
          for (const isTest of [false, true])
            for (const blink of [false, true]) out.push(badgeView(phase, { reserve: 12.5, test: isTest, mode, blink }).text)
        }
  return [...out, ...newTexts(), ...floorTexts()]
}

test('no user-facing string has an em-dash, an en-dash or a semicolon', () => {
  const texts = everyText()
  expect(texts.length).toBeGreaterThan(1500)
  for (const t of texts) {
    expect(t.length).toBeGreaterThan(0)
    expect(t).not.toContain('\u2014') // em-dash
    expect(t).not.toContain('\u2013') // en-dash
    expect(t).not.toContain(';')
  }
})

// ---- 0.2: the weekly window, the reset and autoResume (design 2) ----

// The examples of 2.1: 5-hour 91% used, resets 15:00. Weekly 92% used, resets Monday 09:00. Now is Thursday 12:00.
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const WEEK_RESETS = '2026-09-28T09:00:00.000Z'
const W = Date.parse(WEEK_RESETS)
const NEXT_THU = Date.parse('2026-10-01T11:00:00Z') // 6 d 23 h after T0
const F5: Facts = { used: 91, left: 9, resetsAtMs: R, reserve: 10, timeZone: TZ }
const FW: Facts = { used: 92, left: 8, resetsAtMs: W, reserve: 10, timeZone: TZ, kind: 'seven_day', now: T0 }
const BOTH: Facts[] = [F5, FW]
const FIVE: Named[] = [{ kind: 'five_hour', test: false }]
const WEEK: Named[] = [{ kind: 'seven_day', test: false }]
const TWO: Named[] = [...FIVE, ...WEEK]
const NAMED: Named[][] = [
  FIVE,
  WEEK,
  TWO,
  [{ kind: 'five_hour', test: true }],
  [{ kind: 'seven_day', test: true }],
  [{ kind: 'five_hour', test: true }, { kind: 'seven_day', test: true }],
  [{ kind: 'five_hour', test: false }, { kind: 'seven_day', test: true }],
  [{ kind: 'five_hour', test: true }, { kind: 'seven_day', test: false }],
]

test('clockText gives a weekday for the weekly window only, and a date beyond six days', () => {
  expect(clockText(W, 'seven_day', 'UTC', T0)).toBe('Mon 09:00')
  expect(clockText(W, 'seven_day', 'UTC')).toBe('Mon 09:00')
  expect(clockText(W, 'five_hour', 'UTC', T0)).toBe('09:00')
  expect(clockText(R, 'seven_day', 'UTC', T0)).toBe('Thu 15:00')
  expect(clockText(W, 'seven_day', 'America/New_York', T0)).toBe('Mon 05:00')
  expect(clockText(NEXT_THU, 'seven_day', 'UTC', T0)).toBe('Thu 1 Oct 11:00')
  expect(clockText(Date.parse('2026-10-01T15:00:00Z'), 'seven_day', 'America/New_York', T0)).toBe('Thu 1 Oct 11:00')
  expect(clockText(NEXT_THU, 'five_hour', 'UTC', T0)).toBe('11:00')
  expect(clockText(NEXT_THU, 'seven_day', 'UTC')).toBe('Thu 11:00') // no now: no date rule
  expect(clockText(T0 + 6 * DAY, 'seven_day', 'UTC', T0)).toBe('Wed 12:00') // six days exactly
  expect(clockText(T0 + 6 * DAY + MIN, 'seven_day', 'UTC', T0)).toBe('Wed 30 Sep 12:01') // a fixed month name, never Sept
  expect(clockText(W, 'seven_day')).toMatch(/^[A-Z][a-z]{2} \d\d:\d\d$/)
  expect(atText(W, ['five_hour', 'seven_day'], 'UTC', T0)).toBe('Mon 09:00')
  expect(atText(R, ['five_hour'], 'UTC', T0)).toBe('15:00')
  expect(atText(R, ['seven_day'], 'UTC', T0)).toBe('Thu 15:00')
  expect(atText(NEXT_THU, ['seven_day'], 'UTC', T0)).toBe('Thu 1 Oct 11:00')
})

test('fmtDuration says days from 24 hours', () => {
  expect(fmtDuration(W - T0)).toBe('3 d 21 h')
  expect(fmtDuration(W - T0 + 59 * MIN)).toBe('3 d 21 h')
  expect(fmtDuration(DAY)).toBe('1 d 0 h')
  expect(fmtDuration(DAY - 1)).toBe('23 h 59 min')
  expect(fmtDuration(7 * DAY)).toBe('7 d 0 h')
  expect(fmtDuration(134 * MIN)).toBe('2 h 14 min')
})

test('resetText names real and test windows', () => {
  expect(resetText(FIVE)).toBe('the 5-hour window reset')
  expect(resetText(WEEK)).toBe('the weekly window reset')
  expect(resetText(TWO)).toBe('the 5-hour and weekly windows reset')
  expect(resetText([...WEEK, ...FIVE])).toBe('the 5-hour and weekly windows reset')
  expect(resetText([{ kind: 'five_hour', test: true }])).toBe('the test window ended')
  expect(resetText([{ kind: 'seven_day', test: true }])).toBe('the weekly test window ended')
  expect(resetText([{ kind: 'five_hour', test: true }, { kind: 'seven_day', test: true }])).toBe('the test windows ended')
  expect(resetText([{ kind: 'five_hour', test: false }, { kind: 'seven_day', test: true }])).toBe(
    'the 5-hour window reset and the weekly test window ended',
  )
  expect(resetText([{ kind: 'seven_day', test: false }, { kind: 'five_hour', test: true }])).toBe(
    'the test window ended and the weekly window reset',
  )
  expect(resetText(TWO, true)).toBe('The 5-hour and weekly windows reset')
  expect(resetText([{ kind: 'five_hour', test: true }], true)).toBe('The test window ended')
  expect(resetText([])).toBe('the 5-hour window reset') // a 0.1 stop names no window
})

test('the question has 5-hour, weekly and both wordings', () => {
  expect(questionText(F5, 'loop', 'hold', true)).toBe(
    'Your 10% reserve is reached: 91% used · 9% left · resets 15:00. All work is on hold. Continue on the reserve until 15:00? If you choose Stop here or do not answer, the work waits until 15:00. Then spare10 continues it, unless a reserve is still reached.',
  )
  expect(questionText(F5, 'loop', 'hold', false)).toBe(
    'Your 10% reserve is reached: 91% used · 9% left · resets 15:00. All work is on hold. Continue on the reserve until 15:00?',
  )
  expect(questionText(F5, 'loop', 'hold')).toBe(questionText(F5, 'loop', 'hold', false))
  expect(questionText(FW, 'loop', 'hold', true)).toBe(
    'Your 10% weekly reserve is reached: 92% used · 8% left · resets Mon 09:00. All work is on hold. Continue on the weekly reserve until Mon 09:00? If you choose Stop here or do not answer, the work waits until Mon 09:00. Then spare10 continues it, unless a reserve is still reached.',
  )
  expect(questionText(FW, 'loop', 'hold', false)).toBe(
    'Your 10% weekly reserve is reached: 92% used · 8% left · resets Mon 09:00. All work is on hold. Continue on the weekly reserve until Mon 09:00?',
  )
  expect(questionText(BOTH, 'loop', 'hold', true)).toBe(
    'Your 10% reserve and your 10% weekly reserve are reached: 5-hour window 91% used · 9% left · resets 15:00, weekly window 92% used · 8% left · resets Mon 09:00. All work is on hold. Continue on both reserves until they reset (15:00 and Mon 09:00)? If you choose Stop here or do not answer, the work waits until Mon 09:00. Then spare10 continues it, unless a reserve is still reached.',
  )
  expect(questionText(BOTH, 'loop', 'hold', false)).toBe(
    'Your 10% reserve and your 10% weekly reserve are reached: 5-hour window 91% used · 9% left · resets 15:00, weekly window 92% used · 8% left · resets Mon 09:00. All work is on hold. Continue on both reserves until they reset (15:00 and Mon 09:00)?',
  )
  expect(questionText([FW, F5], 'loop', 'hold', true)).toBe(questionText(BOTH, 'loop', 'hold', true)) // five_hour first
  expect(questionText([F5], 'prompt', 'tell', true)).toBe(questionText(F5, 'prompt', 'tell', true))
  expect(questionText({ ...FW, reserve: 12.5 }, 'prompt', 'hold')).toStartWith('Your 12.5% weekly reserve is reached: ')
})

test('the question says what Stop here and no answer mean when autoResume is on', () => {
  expect(questionText(F5, 'prompt', 'hold', true)).toBe(
    'Your 10% reserve is reached: 91% used · 9% left · resets 15:00. spare10 holds your prompt and any other work. Continue on the reserve until 15:00? If you do not answer, all of it continues after 15:00, unless a reserve is still reached. Stop here gives your prompt back and pauses other work until 15:00.',
  )
  expect(questionText(F5, 'prompt', 'tell', true)).toBe(
    'Your 10% reserve is reached: 91% used · 9% left · resets 15:00. spare10 holds your prompt. Continue on the reserve until 15:00? If you do not answer, your prompt goes in after 15:00, unless a reserve is still reached. Stop here gives it back to you.',
  )
  expect(questionText(F5, 'loop', 'tell', true)).toBe(questionText(F5, 'loop', 'hold', true))
  expect(questionText(BOTH, 'prompt', 'hold', true)).toEndWith(
    'If you do not answer, all of it continues after Mon 09:00, unless a reserve is still reached. Stop here gives your prompt back and pauses other work until Mon 09:00.',
  )
  // {at} is the latest hold end. Without a reset time it is the hold end the caller gives, else the reset.
  expect(questionText({ ...NO_RESET, holdEnd: R + 2 * HOUR }, 'loop', 'hold', true)).toEndWith(
    'Continue on the reserve for one hour? If you choose Stop here or do not answer, the work waits until 17:00. Then spare10 continues it, unless a reserve is still reached.',
  )
  expect(questionText(NO_RESET, 'loop', 'hold', true)).toContain('the work waits until the reset.')
  expect(questionText({ ...FW, resetsAtMs: NEXT_THU }, 'loop', 'hold', true)).toContain('the work waits until Thu 1 Oct 11:00.')
  for (const opener of ['loop', 'prompt'] as const)
    for (const mode of ['hold', 'tell'] as const) {
      expect(questionText(F5, opener, mode, true)).toStartWith(`${questionText(F5, opener, mode, false)} If you `)
    }
})

test('the 5-hour texts are the 0.1 texts', () => {
  expect(factsOf({ kind: 'live', pct: 92, resetsAtMs: R }, 10, TZ, 'five_hour', T0)).toEqual(F) // no kind, no now
  expect(factsOf({ kind: 'live', pct: 92, resetsAtMs: W }, 10, TZ, 'seven_day', T0)).toEqual({ ...FW, used: 92, left: 8 })
  const lists: ReadonlyArray<Facts | readonly Facts[]> = [F, [F]]
  for (const f of lists) {
    expect(stopText(f)).toBe(
      'spare10: the user stopped work at the quota reserve (into your 10% reserve · 8% of quota left · resets 15:00). Stop now and wait for the user. Do not call any further tools.',
    )
    expect(pausedText(f)).toBe(
      'spare10: work stopped at the quota reserve (into your 10% reserve · 8% of quota left · resets 15:00). No model request was sent, so this task is not finished. Wait for the user.',
    )
    expect(headlessText(f, 'S1')).toBe(
      'spare10 stopped this unattended run at the quota reserve (into your 10% reserve · 8% of quota left · resets 15:00). No further model requests were sent. To pick it up later: claude --resume S1',
    )
    expect(pauseInstruction(f, null)).toBe(pauseInstruction(F, null))
    expect(resumeContext(f)).toBe(
      'spare10: earlier work stopped at the 10% quota reserve. The user now chose to continue on the reserve until 15:00. Follow their message.',
    )
    expect(notStarted(f)).toBe(
      'spare10: not started. This session is inside your 10% reserve until 15:00. Send the prompt again to be asked again, or run /spare10 resume.',
    )
    expect(notice.continuing(f)).toBe('continuing on your 10% reserve. spare10 stays quiet until 15:00.')
    expect(notice.stopped(f)).toBe('stopped at your 10% reserve. Type a prompt to be asked again, or run /spare10 resume.')
    expect(notice.told(f)).toBe('your 10% reserve is reached. spare10 told the agents to wind down.')
    expect(questionText(f, 'loop', 'hold')).toBe(
      'Your 10% reserve is reached: 92% used · 8% left · resets 15:00. All work is on hold. Continue on the reserve until 15:00?',
    )
    expect(resumeReply('asking', f)).toBe('resumed. Held work continues on the reserve until 15:00.')
    expect(resumeReply('stopped', f)).toBe('resumed. You can use the reserve until 15:00. Type a prompt to continue.')
    expect(resumeReply('tripped', f)).toBe('you can use the reserve until 15:00.')
    expect(resumeReply('consented', f)).toBe('already resumed until 15:00.')
    expect(stopReply('tripped', f)).toBe('stopped at the reserve. Type a prompt to be asked again, or run /spare10 resume.')
    expect(stopReply('below', f)).toBe('nothing to stop. spare10 steps in at 90% used.')
    expect(personFacts(f)).toBe('92% used · 8% left · resets 15:00')
    expect(untilText(f)).toBe('until 15:00')
    expect(debugLine.unattended(f, 'stop')).toBe('spare10: unattended run inside the reserve (92% used · 8% left · resets 15:00), policy stop.')
  }
  expect(notice.newWindowFor(['five_hour'])).toBe(notice.newWindow)
  expect(notice.resetWaitingFor(FIVE)).toBe(notice.resetWaiting)
  expect(timeoutWarning('askUserQuestionTimeout', false)).toBe(timeoutWarning('askUserQuestionTimeout'))
  expect(consentWarning('x', 'five_hour')).toBe(consentWarning('x'))
  expect(stepsIn(10)).toBe('spare10 steps in at 90% used.')
  expect(stepsIn(10, 0)).toBe('spare10 steps in at 90% used.')
  expect(resumeReply('asking')).toBe('resumed. Held work continues on the reserve until the window resets.')
  expect(resumeReply('consented')).toBe('already resumed until the window resets.')
})

test('the model facts join two kinds with a comma and and', () => {
  expect(modelFacts(BOTH)).toBe(
    'into your 10% reserve · 9% of quota left · resets 15:00, and into your 10% weekly reserve · 8% of weekly quota left · resets Mon 09:00',
  )
  expect(modelFacts([FW, F5])).toBe(modelFacts(BOTH))
  expect(modelFacts(FW)).toBe('into your 10% weekly reserve · 8% of weekly quota left · resets Mon 09:00')
  expect(personFacts(FW)).toBe('92% used · 8% left · resets Mon 09:00')
  expect(personFacts(BOTH)).toBe('5-hour window 91% used · 9% left · resets 15:00, weekly window 92% used · 8% left · resets Mon 09:00')
  expect(untilText(BOTH)).toBe('until they reset (15:00 and Mon 09:00)')
  expect(untilText(FW)).toBe('until Mon 09:00')
  expect(untilText({ ...FW, resetsAtMs: null })).toBe('for one hour')
  expect(stopText(BOTH)).toBe(`spare10: the user stopped work at the quota reserve (${modelFacts(BOTH)}). Stop now and wait for the user. Do not call any further tools.`)
  expect(pausedText(FW)).toBe(
    'spare10: work stopped at the quota reserve (into your 10% weekly reserve · 8% of weekly quota left · resets Mon 09:00). No model request was sent, so this task is not finished. Wait for the user.',
  )
  expect(headlessText(BOTH, 'S1')).toBe(
    `spare10 stopped this unattended run at the quota reserve (${modelFacts(BOTH)}). No further model requests were sent. To pick it up later: claude --resume S1`,
  )
  expect(pauseInstruction(BOTH, null)).toContain(`for this session (${modelFacts(BOTH)}).`)
  expect(resumeContext(BOTH)).toBe(
    'spare10: earlier work stopped at the quota reserves. The user now chose to continue on both reserves until they reset (15:00 and Mon 09:00). Follow their message.',
  )
  expect(resumeContext(FW)).toBe(
    'spare10: earlier work stopped at the 10% weekly quota reserve. The user now chose to continue on the weekly reserve until Mon 09:00. Follow their message.',
  )
  expect(resumeContext({ ...FW, resetsAtMs: null })).toContain('continue on the weekly reserve for one hour.')
  expect(notStarted(BOTH)).toBe(
    'spare10: not started. This session is inside your 10% reserve and your 10% weekly reserve until they reset (15:00 and Mon 09:00). Send the prompt again to be asked again, or run /spare10 resume.',
  )
  expect(notStarted(FW)).toBe(
    'spare10: not started. This session is inside your 10% weekly reserve until Mon 09:00. Send the prompt again to be asked again, or run /spare10 resume.',
  )
  expect(debugLine.unattended(FW, 'wait')).toBe('spare10: unattended run inside the reserve (92% used · 8% left · resets Mon 09:00), policy wait.')
})

test('the resume prompt names the windows, lifts wait for the user, and quotes both lead-ins', () => {
  const p = resumePrompt(FIVE)
  expect(p).toBe(
    'The 5-hour window reset, so the stop at the quota reserve is over. spare10 is set to continue the work at the reset, so do not wait for the user. Continue the task from the point where it stopped. A subagent whose result says "spare10: work stopped" or "spare10: the user stopped work" did not finish. Run it again if you still need its result.',
  )
  expect(resumePrompt(TWO)).toStartWith('The 5-hour and weekly windows reset, so the stop at the quota reserve is over.')
  expect(resumePrompt(WEEK)).toStartWith('The weekly window reset, so the stop')
  expect(resumePrompt([{ kind: 'seven_day', test: true }])).toStartWith('The weekly test window ended, so the stop')
  expect(p).toContain('do not wait for the user')
  // The two lead-ins it quotes are the starts of PAUSED and STOP.
  expect(pausedText(BOTH)).toStartWith('spare10: work stopped')
  expect(stopText(BOTH)).toStartWith('spare10: the user stopped work')
  expect(p).toContain('"spare10: work stopped"')
  expect(p).toContain('"spare10: the user stopped work"')
  for (const named of NAMED) {
    const t = resumePrompt(named)
    expect(t).not.toContain('%') // the new window has no figures yet
    expect(t).not.toMatch(/\d\d:\d\d/)
  }
})

test("the reset note tells the model to continue after the user's message", () => {
  expect(resetContext(FIVE)).toBe(
    "spare10: earlier work stopped at the quota reserve. The 5-hour window reset since then, so the stop is over. The stopped task is not finished. After the user's message, continue it unless the user says otherwise.",
  )
  expect(resetContext(WEEK)).toContain('The weekly window reset since then, so the stop is over.')
  expect(resetContext([{ kind: 'five_hour', test: true }])).toContain('The test window ended since then')
})

test('the resume prompt has no spare10 prefix, the model notes keep theirs', () => {
  for (const named of NAMED) {
    expect(resumePrompt(named).startsWith('spare10')).toBe(false)
    expect(resetContext(named).startsWith('spare10: ')).toBe(true)
  }
  const kept = [
    stopText(BOTH),
    pausedText(FW),
    resumeContext(BOTH),
    notStarted(FW),
    debugLine.unattended(BOTH, 'wait'),
    debugLine.droppedStop,
    debugLine.resumeSkipped,
    debugLine.boxDefer(3),
    debugLine.budget(10, 5000),
    debugLine.checkFailed('Error: gone'),
  ]
  for (const t of kept) expect(t.startsWith('spare10: ')).toBe(true)
  expect(headlessText(BOTH, 'S1').startsWith('spare10 stopped this unattended run')).toBe(true)
  expect(HEADLESS_GENERIC).toBe('spare10 stopped this unattended run at the quota reserve. No further model requests were sent.')
  expect(pauseInstruction(BOTH, 'Wrap up.').startsWith('spare10 budget guard.')).toBe(true)
  expect(debugLine.droppedStop).toBe('spare10: a stop of another conversation ended at its reset. spare10 dropped it.')
  expect(debugLine.resumeSkipped).toBe('spare10: the conversation changed before the resume prompt. spare10 sent nothing.')
  expect(debugLine.boxDefer(3)).toBe('spare10: the prompt box has text. The resume prompt waits (3 of 10).')
  expect(debugLine.budget(10, 5000)).toBe('spare10: held 10 min. Budget left 5000 ms.')
  expect(debugLine.checkFailed('Error: gone')).toBe('spare10: the reset check did not run: Error: gone')
})

// The 0.2 transcript lines, warnings and command replies: the engine prefixes each one.
function newEnginePrefixed(): string[] {
  const out: string[] = [
    badWarning('SPARE10_WEEKLY_RESERVE', '0.5', '10'),
    badWarning('SPARE10_AUTO_RESUME', 'yes', 'on'),
    timeoutWarning('askUserQuestionTimeout', true),
    timeoutWarning('CLAUDE_AFK_TIMEOUT_MS', true),
    consentWarning('2026-10-06T00:00:00.000Z', 'seven_day'),
    notice.outOfReserve,
    notice.resumeFailed('dropped by another plugin'),
    simulateReply('weekly-off'),
    simulateReply('set', { ...FW, used: 95, left: 5 }),
    resumeReply('overdue'),
    stopReply('overdue'),
    ...skipEnginePrefixed(),
    stopReply('below', F5, 90, undefined, 90),
    stopReply('none', undefined, 90, undefined, 85),
  ]
  for (const kinds of [['five_hour'], ['seven_day'], ['five_hour', 'seven_day']] as Kind[][]) out.push(notice.newWindowFor(kinds))
  for (const named of NAMED) {
    out.push(notice.resetWaitingFor(named), notice.resetContinues(named), notice.resetResumes(named), notice.resetStopOver(named))
    out.push(notice.stopTakenOver(named), resumeReply('overdue', F5, named))
    for (const still of [[F5], [FW], BOTH]) out.push(notice.resetStillHeld(named, still), notice.stopExtended(named, still, 'Mon 09:00'))
  }
  for (const f of [F5, FW, BOTH, NO_RESET]) {
    out.push(notice.continuing(f), notice.told(f), notice.holdLimit(f))
    for (const work of [false, true]) out.push(notice.holdLimit(f, { at: '15:00', work }))
    for (const work of [false, true]) out.push(notice.stopped(f, { at: '15:00', work }))
    for (const c of ['asking', 'stopped', 'tripped', 'consented', 'below', 'none', 'off', 'overdue'] as const) out.push(resumeReply(c, f, TWO))
    for (const c of ['asking', 'stopped', 'tripped', 'below', 'none', 'off', 'overdue'] as const) {
      out.push(stopReply(c, f, 90, { at: 'Mon 09:00' }, 90), stopReply(c, f))
    }
  }
  out.push(statusReport(status02()))
  return out
}

test('every new notice and reply starts without the engine prefix', () => {
  expect(notice.continuing(FW)).toBe('continuing on your 10% weekly reserve. spare10 stays quiet until Mon 09:00.')
  expect(notice.continuing(BOTH)).toBe(
    'continuing on your 10% reserve and your 10% weekly reserve. spare10 stays quiet until they reset (15:00 and Mon 09:00).',
  )
  expect(notice.newWindowFor(['seven_day'])).toBe('held work continues on the new weekly window.')
  expect(notice.newWindowFor(['seven_day', 'five_hour'])).toBe('held work continues on the new 5-hour and weekly windows.')
  expect(notice.stopped(FW)).toBe('stopped at your 10% weekly reserve. Type a prompt to be asked again, or run /spare10 resume.')
  expect(notice.stopped(F5, { at: '15:00', work: true })).toBe(
    'stopped at your 10% reserve until 15:00. Then spare10 continues the work, unless a reserve is still reached. Type a prompt to be asked again, or run /spare10 resume.',
  )
  expect(notice.stopped(BOTH, { at: 'Mon 09:00', work: false })).toBe(
    'stopped at your 10% reserve and your 10% weekly reserve until Mon 09:00. Type a prompt to be asked again, or run /spare10 resume.',
  )
  expect(notice.holdLimit(F5, { at: '15:00', work: true })).toBe(
    'the hold reached its time limit. The work is stopped at your 10% reserve until 15:00. Then spare10 continues it, unless a reserve is still reached.',
  )
  // No loop was held (a prompt question): spare10 sends nothing at the reset, so the text promises nothing.
  expect(notice.holdLimit(FW, { at: 'Mon 09:00', work: false })).toBe(
    'the hold reached its time limit. The work is stopped at your 10% weekly reserve until Mon 09:00. Type a prompt to be asked again, or run /spare10 resume.',
  )
  expect(notice.holdLimit(F5)).toBe(
    'the hold reached its time limit. The work is stopped at your 10% reserve. Type a prompt to be asked again, or run /spare10 resume.',
  )
  expect(notice.resetWaitingFor(WEEK)).toBe('the weekly window reset. Held work still waits for your answer.')
  expect(notice.told(BOTH)).toBe('your 10% reserve and your 10% weekly reserve are reached. spare10 told the agents to wind down.')
  expect(notice.resetContinues(FIVE)).toBe('the 5-hour window reset. Held work continues.')
  expect(notice.resetStillHeld(FIVE, [FW])).toBe('the 5-hour window reset, but your 10% weekly reserve is reached. Held work still waits.')
  expect(notice.resetStillHeld([{ kind: 'five_hour', test: true }], [F5])).toBe(
    'the test window ended, but your 10% reserve is reached. Held work still waits.',
  )
  expect(notice.outOfReserve).toBe('the quota is no longer in the reserve. Held work continues.')
  expect(notice.resetResumes(TWO)).toBe('the 5-hour and weekly windows reset. spare10 continues the stopped work.')
  expect(notice.resetStopOver(FIVE)).toBe('the 5-hour window reset, and the stop is over. Type a prompt to continue.')
  expect(notice.stopTakenOver(WEEK)).toBe('the weekly window reset, and the stop is over.')
  expect(notice.stopExtended(FIVE, [FW], 'Mon 09:00')).toBe(
    'the 5-hour window reset, but your 10% weekly reserve is reached. The stop lasts until Mon 09:00.',
  )
  expect(notice.resumeFailed('dropped')).toBe('could not continue the stopped work: dropped. Type a prompt to continue.')
  expect(badWarning('SPARE10_WEEKLY_RESERVE', '0.5', '10')).toBe('SPARE10_WEEKLY_RESERVE="0.5" is not 0 or 1 to 99. spare10 uses 10.')
  expect(badWarning('SPARE10_AUTO_RESUME', 'yes', 'on')).toBe('SPARE10_AUTO_RESUME="yes" is not on or off. spare10 uses on.')
  expect(timeoutWarning('askUserQuestionTimeout', true)).toBe(
    'questions here continue by themselves after a time limit (askUserQuestionTimeout). An unanswered spare10 question then counts as Stop here, and spare10 continues the work at the time that the question names.',
  )
  expect(consentWarning('2026-10-06T00:00:00.000Z', 'seven_day')).toBe(
    'SPARE10_WEEKLY_CONSENT="2026-10-06T00:00:00.000Z" names a time after this weekly window. spare10 ignores it.',
  )
  const texts = newEnginePrefixed()
  expect(texts.length).toBeGreaterThan(200)
  for (const t of texts) {
    expect(t.startsWith('spare10: ')).toBe(false)
    expect(t.startsWith('spare10 ')).toBe(false)
  }
})

// The 2.7 example: attended, weekly watched, autoResume on. Now is Thursday 11:46.
const NOW = Date.parse('2026-09-24T11:46:00Z')
const R14 = Date.parse('2026-09-24T14:00:00Z')
const status02 = (over: Partial<StatusInput> = {}): StatusInput =>
  status({
    now: NOW,
    basis: { kind: 'live', pct: 42, resetsAtMs: R14 },
    facts: { used: 42, left: 58, resetsAtMs: R14, reserve: 10, timeZone: TZ },
    weekly: { reserve: 10, from: 'option', basis: { kind: 'live', pct: 61, resetsAtMs: W } },
    autoResume: { on: true, from: 'option' },
    ...over,
  })

test('the status report shows both windows, the reset row, a weekly-off row and the ticker warning', () => {
  expect(statusReport(status02())).toBe(
    [
      'version 0.3.0',
      '',
      '  ● armed          spare10 steps in at 90% used, or at 90% used of the weekly window.',
      '  · reserve        10% of the 5-hour window (from /config)',
      '  · weekly reserve 10% of the weekly window (from /config)',
      '  · at the reserve stop and ask you',
      '  · at the reset   continue by itself (from /config)',
      '  · reading        live · 42% used · 58% left · resets 14:00 (in 2 h 14 min)',
      '  · weekly reading live · 61% used · 39% left · resets Mon 09:00 (in 3 d 21 h)',
      '  · consent        none',
      '  · weekly consent none',
      '  · guarded        yes (scope all)',
      '  · claude -p      runs started here: stop',
      '',
      '/spare10 resume   continue on the reserve until the window resets',
      '/spare10 stop     stop at the reserve now',
    ].join('\n'),
  )
  const lines = (over: Partial<StatusInput>) => statusReport(status02(over)).split('\n')
  // Sources from the env.
  const env = lines({ weekly: { reserve: 15, from: 'env', basis: { kind: 'none', why: 'no-reading' } }, autoResume: { on: false, from: 'env' } })
  expect(env[2]).toBe('  ● armed          spare10 steps in at 90% used, or at 85% used of the weekly window.')
  expect(env[4]).toBe('  · weekly reserve 15% of the weekly window (from SPARE10_WEEKLY_RESERVE)')
  expect(env[6]).toBe('  · at the reset   wait for your answer (from SPARE10_AUTO_RESUME)')
  expect(env[8]).toBe('  · weekly reading none: no reading yet')
  // The weekly reading forms.
  const reading = (basis: Basis) => lines({ weekly: { reserve: 10, from: 'option', basis } })[8]
  expect(reading({ kind: 'seed', pct: 92, resetsAtMs: W })).toBe('  · weekly reading seed from another session · 92% used · 8% left · resets Mon 09:00 (in 3 d 21 h)')
  expect(reading({ kind: 'test', pct: 95, resetsAtMs: NOW + 2 * MIN })).toBe('  · weekly reading test reading · 95% used · 5% left · resets Thu 11:48 (in 2 min)')
  expect(reading({ kind: 'test', pct: 95, resetsAtMs: NEXT_THU })).toBe(
    '  · weekly reading test reading · 95% used · 5% left · resets Thu 1 Oct 11:00 (in 6 d 23 h)',
  )
  expect(reading({ kind: 'none', why: 'window-reset' })).toBe('  · weekly reading none: the window reset')
  expect(reading({ kind: 'none', why: 'blind' })).toBe('  · weekly reading none: Claude Code reports no quota (blind)')
  expect(reading({ kind: 'live', pct: 61, resetsAtMs: null })).toBe('  · weekly reading live · 61% used · 39% left · resets at an unknown time')
  // Weekly consent.
  const consented = lines({ phase: 'consented', weekly: { reserve: 10, from: 'option', basis: { kind: 'live', pct: 93, resetsAtMs: W }, consentUntil: W } })
  expect(consented[2]).toBe('  ⨯ consented      you chose to continue. spare10 is quiet until Mon 09:00.')
  expect(consented[10]).toBe('  · weekly consent until Mon 09:00 (you chose to continue)')
  const both = lines({ phase: 'consented', consentUntil: R14, weekly: { reserve: 10, from: 'option', basis: { kind: 'live', pct: 93, resetsAtMs: W }, consentUntil: W } })
  expect(both[2]).toBe('  ⨯ consented      you chose to continue. spare10 is quiet until they reset (14:00 and Mon 09:00).')
  expect(both[9]).toBe('  · consent        until 14:00 (you chose to continue)')
  // Weekly off: one row, and no weekly reading or consent.
  for (const weekly of ['off', { reserve: 0, from: 'option', basis: { kind: 'none', why: 'no-reading' } }] as const) {
    const off = lines({ weekly })
    expect(off[2]).toBe('  ● armed          spare10 steps in at 90% used.')
    expect(off[4]).toBe('  · weekly reserve off. spare10 does not watch the weekly window (from /config)')
    expect(off.some((l) => l.includes('weekly reading') || l.includes('weekly consent'))).toBe(false)
  }
  expect(lines({ weekly: { reserve: 0, from: 'env', basis: { kind: 'none', why: 'no-reading' } } })[4]).toBe(
    '  · weekly reserve off. spare10 does not watch the weekly window (from SPARE10_WEEKLY_RESERVE)',
  )
  // Unattended: no reset row, the unattended row names wait.
  const wait = lines({ attended: false, headless: 'wait', headlessFrom: 'env' })
  expect(wait.some((l) => l.includes('at the reset'))).toBe(false)
  expect(wait).toContain('  · unattended     wait (from SPARE10_HEADLESS)')
  // The ticker warning comes before the other warnings.
  const stale = lines({ tickerStale: true, warnings: [W_FLAG] })
  expect(stale.slice(13, 15)).toEqual([
    '  ⚠ spare10 cannot check the reset in this session. Type a prompt to continue after the reset.',
    `  ⚠ ${W_FLAG}`,
  ])
  expect(lines({ tickerStale: false }).some((l) => l.includes('cannot check the reset'))).toBe(false)
  // D4 for the new rows: every value starts at column 19.
  for (const row of lines({ phase: 'consented', consentUntil: R14 }).slice(2, 13)) {
    const chars = [...row]
    expect(chars.slice(0, 4).join('')).toMatch(/^ {2}\S $/)
    expect(chars[18]).toBe(' ')
    expect(chars[19]).not.toBe(' ')
  }
})

test('the stopped and asking phase lines say when spare10 continues', () => {
  const at = { ms: R, kinds: ['five_hour'] as Kind[] }
  const line = (over: Partial<StatusInput>) => statusReport(status02(over)).split('\n')[2]
  expect(line({ phase: 'stopped', at, autoStop: true, work: true })).toBe(
    '  ■ stopped        you chose Stop here. spare10 continues the work after 15:00. Type a prompt to be asked again, or run /spare10 resume.',
  )
  expect(line({ phase: 'stopped', at, autoStop: true, work: false })).toBe(
    '  ■ stopped        you chose Stop here, until 15:00. Type a prompt to be asked again, or run /spare10 resume.',
  )
  expect(line({ phase: 'stopped', at: { ms: W, kinds: ['five_hour', 'seven_day'] }, autoStop: true })).toBe(
    '  ■ stopped        you chose Stop here, until Mon 09:00. Type a prompt to be asked again, or run /spare10 resume.',
  )
  for (const over of [{ at, autoStop: false, work: true }, { autoStop: true, work: true }, {}]) {
    expect(line({ phase: 'stopped', ...over })).toBe('  ■ stopped        you chose Stop here. Type a prompt to be asked again, or run /spare10 resume.')
  }
  expect(line({ phase: 'asking', at: { ms: W, kinds: ['seven_day'] } })).toBe(
    '  ? asking         a question is open. Held work waits until you answer, or until Mon 09:00. If no dialog shows, run /spare10 resume or /spare10 stop.',
  )
  for (const over of [{ at, autoResume: { on: false, from: 'option' as const } }, { at: undefined }]) {
    expect(line({ phase: 'asking', ...over })).toBe(
      '  ? asking         a question is open. Held work waits until you answer. If no dialog shows, run /spare10 resume or /spare10 stop.',
    )
  }
  expect(line({ phase: 'reserve', attended: false, headless: 'wait', at })).toBe(
    '  ⚠ tripped        unattended run, policy wait. Held work continues after 15:00.',
  )
  expect(line({ phase: 'reserve', attended: false, headless: 'wait' })).toBe('  ⚠ tripped        unattended run, policy wait.')
  expect(line({ phase: 'reserve', attended: false, headless: 'stop', at })).toBe('  ⚠ tripped        unattended run, policy stop.')
})

test('the stop and resume replies have overdue forms', () => {
  expect(resumeReply('overdue', undefined, FIVE)).toBe('the 5-hour window reset, and the stop is over. Type a prompt to continue.')
  expect(resumeReply('overdue', F5, TWO)).toBe('the 5-hour and weekly windows reset, and the stop is over. Type a prompt to continue.')
  expect(stopReply('overdue')).toBe('the stop ended at the reset. spare10 will not continue the stopped work.')
  expect(resumeReply('asking', BOTH)).toBe('resumed. Held work continues on both reserves until they reset (15:00 and Mon 09:00).')
  expect(resumeReply('stopped', FW)).toBe('resumed. You can use the weekly reserve until Mon 09:00. Type a prompt to continue.')
  expect(resumeReply('tripped', BOTH)).toBe('you can use both reserves until they reset (15:00 and Mon 09:00).')
  expect(resumeReply('consented', FW)).toBe('already resumed until Mon 09:00.')
  expect(resumeReply('below', [{ ...F5, used: 50, left: 50 }, { ...FW, used: 61, left: 39 }])).toBe(
    'nothing to resume. 5-hour window 50% used · 50% left · resets 15:00, weekly window 61% used · 39% left · resets Mon 09:00.',
  )
  expect(resumeReply('below', [])).toBe('nothing to resume. There is no 5-hour reading yet.')
  expect(stopReply('asking', F5, undefined, { at: '15:00' })).toBe('stopped. Held work is refused. spare10 continues it after 15:00.')
  expect(stopReply('tripped', BOTH, undefined, { at: 'Mon 09:00' })).toBe(
    'stopped at the reserve until Mon 09:00. Then spare10 continues any stopped work. Type a prompt to be asked again, or run /spare10 resume.',
  )
  expect(stopReply('stopped', F5, undefined, { at: '15:00' })).toBe('already stopped until 15:00.')
  expect(stopReply('below', F5, 90, undefined, 90)).toBe('nothing to stop. spare10 steps in at 90% used, or at 90% used of the weekly window.')
  expect(stopReply('none', undefined, 85, { at: '15:00' }, 80)).toBe('nothing to stop. spare10 steps in at 85% used, or at 80% used of the weekly window.')
  expect(stepsIn(10, 10)).toBe('spare10 steps in at 90% used, or at 90% used of the weekly window.')
  expect(stepsIn(15, 10.6)).toBe('spare10 steps in at 85% used, or at 89.4% used of the weekly window.')
})

test('the simulate replies name the weekly window and the new grammar', () => {
  const thu1402 = Date.parse('2026-09-24T14:02:00Z')
  expect(simulateReply('set', { used: 95, left: 5, resetsAtMs: thu1402, reserve: 10, timeZone: TZ })).toBe(
    'test reading set to 95% used, resets 14:02. It can only raise the real reading. Run /spare10 simulate off to clear it.',
  )
  expect(simulateReply('set', { used: 95, left: 5, resetsAtMs: thu1402, reserve: 10, timeZone: TZ, kind: 'seven_day', now: T0 })).toBe(
    'test reading set to 95% used of the weekly window, resets Thu 14:02. It can only raise the real reading. Run /spare10 simulate off to clear it.',
  )
  expect(simulateReply('weekly-off')).toBe('the weekly reserve is 0, so spare10 does not watch the weekly window. Nothing changed.')
  expect(simulateReply('bad')).toBe(
    '/spare10 simulate takes a percentage from 0 to 100, or off. Add weekly for the weekly window, and in 22m for a test window that resets in 22 minutes.',
  )
  expect(simulateReply('off')).toBe('test reading cleared. Consent and stop for this window are cleared too.')
})

// Every 0.2 text, both kinds, autoResume on and off, for the STE guard.
function newTexts(): string[] {
  const out: string[] = [
    HEADLESS_GENERIC,
    ...newEnginePrefixed(),
    debugLine.droppedStop,
    debugLine.resumeSkipped,
    debugLine.boxDefer(10),
    debugLine.budget(0, 1999),
    debugLine.checkFailed('Error: gone'),
    stepsIn(10, 10),
    stepsIn(12.5, 0),
    clockText(NEXT_THU, 'seven_day', TZ, T0),
    fmtDuration(W - T0),
    ...skipTexts(),
  ]
  const lists: Array<Facts | Facts[]> = [F5, FW, BOTH, NO_RESET, { ...FW, resetsAtMs: null }, [NO_RESET, { ...FW, resetsAtMs: null }], { ...FW, resetsAtMs: NEXT_THU }]
  for (const f of lists) {
    out.push(personFacts(f), modelFacts(f), untilText(f), stopText(f), pausedText(f), headlessText(f, 'S1'))
    out.push(pauseInstruction(f, null), pauseInstruction(f, 'Commit, then stop.'), resumeContext(f), notStarted(f))
    for (const auto of [false, true])
      for (const opener of ['loop', 'prompt'] as const)
        for (const mode of ['hold', 'tell'] as const) out.push(questionText(f, opener, mode, auto))
    for (const policy of ['off', 'prompt', 'stop', 'wait'] as const) out.push(debugLine.unattended(f, policy))
  }
  for (const named of NAMED) out.push(resetText(named), resetText(named, true), resetContext(named), resumePrompt(named))
  const phases: Phase[] = ['off', 'blind', 'waiting', 'armed', 'consented', 'stopped', 'asking', 'told', 'reserve', 'tripped']
  const weeklies: Array<StatusInput['weekly']> = [
    undefined,
    'off',
    { reserve: 10, from: 'env', basis: { kind: 'live', pct: 93, resetsAtMs: W }, consentUntil: W },
    { reserve: 12.5, from: 'option', basis: { kind: 'none', why: 'blind' } },
  ]
  for (const phase of phases)
    for (const attended of [true, false])
      for (const weekly of weeklies)
        for (const on of [false, true]) {
          out.push(
            statusReport(
              status02({
                phase,
                attended,
                weekly,
                autoResume: { on, from: on ? 'option' : 'env' },
                headless: attended ? 'off' : 'wait',
                at: { ms: W, kinds: ['seven_day'] },
                work: on,
                autoStop: on,
                tickerStale: on,
                consentUntil: R14,
                warnings: [W_FLAG],
              }),
            ),
          )
          for (const until of ['15:00', 'Mon 09:00', 'Thu 1 Oct 11:00']) out.push(badgeView(phase, { reserve: 12.5, test: on, mode: 'hold', blink: on, until }).text)
        }
  return out
}

// ---- Skip near the reset (skip design 2, 7.2) ----

// The examples of skip 2: 5-hour reserve 10, 92% used, reset 16:40, span 20 min, skip start 16:20. Weekly
// reserve 10, 92% used, reset Mon 09:00, span 8 h, skip start Mon 01:00. A test window set at 14:00 `in
// 22m`: reset 14:22, skip start 14:02. A weekly test window `in 482m`: reset Thu 22:02, skip start Thu 14:02.
const R1640 = Date.parse('2026-09-24T16:40:00Z')
const T1400 = Date.parse('2026-09-24T14:00:00Z')
const S5 = 20 * MIN
const S7 = 8 * HOUR
const OPEN5: Facts = { used: 92, left: 8, resetsAtMs: R1640, reserve: 10, timeZone: TZ } // an open kind: no span, no hold end
const OPEN7: Facts = { used: 92, left: 8, resetsAtMs: W, reserve: 10, timeZone: TZ, kind: 'seven_day', now: T0 }
const OWN5: Facts = { ...OPEN5, holdEnd: R1640 - S5, span: S5 } // a skip owner's 5-hour facts
const OWN7: Facts = { ...OPEN7, holdEnd: W - S7, span: S7 }
const TEST5: Facts = { used: 95, left: 5, resetsAtMs: T1400 + 22 * MIN, reserve: 10, timeZone: TZ, test: true, holdEnd: T1400 + 2 * MIN, span: S5 }
const TEST7: Facts = { used: 95, left: 5, resetsAtMs: T1400 + 482 * MIN, reserve: 10, timeZone: TZ, kind: 'seven_day', now: T1400, test: true, span: S7 }
const KIT: Facts = { used: 90, left: 10, resetsAtMs: R, reserve: 10, timeZone: TZ, holdEnd: R - S5, span: S5 } // the kit default world
const NONE: Ended = { reset: [], open: [] }
const OPEN_5: Ended = { reset: [], open: [OPEN5] }

test('leadText names the span and the reset, the weekly reset and the test windows', () => {
  expect(leadText(OWN5)).toBe('20 min before the reset')
  expect(leadText(OWN7)).toBe('8 h before the weekly reset')
  expect(leadText(TEST5)).toBe('20 min before the test window ends')
  expect(leadText(TEST7)).toBe('8 h before the weekly test window ends')
  expect(leadText({ ...OWN5, span: 2.5 * MIN })).toBe('2.5 min before the reset')
  expect(leadText({ ...OWN7, span: 0.5 * HOUR })).toBe('0.5 h before the weekly reset')
  expect(leadText(OPEN5)).toBeUndefined() // no span: no lead
  expect(spanText(OWN5)).toBe('20 min')
  expect(spanText(OWN7)).toBe('8 h')
})

test('soonText and eventText name reset and open windows in order', () => {
  expect(soonText(OPEN5)).toBe('the 5-hour window resets at 16:40')
  expect(soonText(OPEN7)).toBe('the weekly window resets at Mon 09:00')
  expect(soonText({ ...OPEN5, resetsAtMs: T1400 + 22 * MIN, test: true })).toBe('the test window ends at 14:22')
  expect(soonText(TEST7)).toBe('the weekly test window ends at Thu 22:02')
  expect(soonText([OPEN7, OPEN5])).toBe('the 5-hour window resets at 16:40, and the weekly window resets at Mon 09:00') // five_hour first
  expect(eventText([], [OPEN5])).toBe('the 5-hour window resets at 16:40. Your 10% reserve is open until then')
  expect(eventText(FIVE, [OPEN7])).toBe(
    'the 5-hour window reset. The weekly window resets at Mon 09:00. Your 10% weekly reserve is open until then',
  )
  expect(eventText([], [OPEN5, OPEN7])).toBe(
    'the 5-hour window resets at 16:40, and the weekly window resets at Mon 09:00. Your 10% reserve and your 10% weekly reserve are open until then',
  )
  expect(eventText(TWO, [])).toBe(resetText(TWO)) // no open kind: {reset}
  expect(eventText([], [])).toBe('')
})

test('the question says when the reserve opens, for loop, prompt hold and prompt tell', () => {
  expect(questionText(OWN5, 'loop', 'hold', true)).toBe(
    'Your 10% reserve is reached: 92% used · 8% left · resets 16:40. All work is on hold. Continue on the reserve until 16:40? If you choose Stop here or do not answer, the work waits until 16:20, 20 min before the reset. Then spare10 continues it, unless a reserve is still reached.',
  )
  expect(questionText(OWN7, 'loop', 'hold', true)).toBe(
    'Your 10% weekly reserve is reached: 92% used · 8% left · resets Mon 09:00. All work is on hold. Continue on the weekly reserve until Mon 09:00? If you choose Stop here or do not answer, the work waits until Mon 01:00, 8 h before the weekly reset. Then spare10 continues it, unless a reserve is still reached.',
  )
  expect(questionText(TEST5, 'loop', 'hold', true)).toBe(
    'Your 10% reserve is reached: 95% used · 5% left · resets 14:22. All work is on hold. Continue on the reserve until 14:22? If you choose Stop here or do not answer, the work waits until 14:02, 20 min before the test window ends. Then spare10 continues it, unless a reserve is still reached.',
  )
  expect(questionText(OWN5, 'prompt', 'hold', true)).toBe(
    'Your 10% reserve is reached: 92% used · 8% left · resets 16:40. spare10 holds your prompt and any other work. Continue on the reserve until 16:40? If you do not answer, all of it continues at 16:20, 20 min before the reset, unless a reserve is still reached. Stop here gives your prompt back and pauses other work until 16:20.',
  )
  expect(questionText(OWN5, 'prompt', 'tell', true)).toBe(
    'Your 10% reserve is reached: 92% used · 8% left · resets 16:40. spare10 holds your prompt. Continue on the reserve until 16:40? If you do not answer, your prompt goes in at 16:20, 20 min before the reset, unless a reserve is still reached. Stop here gives it back to you.',
  )
  expect(questionText(KIT, 'loop', 'hold', true)).toBe(
    'Your 10% reserve is reached: 90% used · 10% left · resets 15:00. All work is on hold. Continue on the reserve until 15:00? If you choose Stop here or do not answer, the work waits until 14:40, 20 min before the reset. Then spare10 continues it, unless a reserve is still reached.',
  )
  // The span alone gives the skip start: the hold end is optional.
  expect(questionText({ ...OPEN5, span: S5 }, 'loop', 'hold', true)).toBe(questionText(OWN5, 'loop', 'hold', true))
  // Two kinds: {at} is the latest hold end, and the lead is its owner's.
  expect(questionText([OWN5, OWN7], 'loop', 'hold', true)).toEndWith(
    'the work waits until Mon 01:00, 8 h before the weekly reset. Then spare10 continues it, unless a reserve is still reached.',
  )
  // autoResume off: no {after}, as D0.2.
  expect(questionText(OWN5, 'loop', 'hold', false)).toBe(questionText(OPEN5, 'loop', 'hold', false))
  expect(whenOf(OWN5)).toEqual({ at: '16:20', lead: '20 min before the reset' })
})

test('the question keeps the D0.2 wording without a skip owner', () => {
  // A weekly reset owns the time (the weekly span is 0): the 5-hour facts carry no span, and {at} is the reset.
  const five = { ...OPEN5, holdEnd: R1640 - S5 } // a skip start ahead, but no skip owner
  expect(questionText([five, OPEN7], 'loop', 'hold', true)).toEndWith(
    'If you choose Stop here or do not answer, the work waits until Mon 09:00. Then spare10 continues it, unless a reserve is still reached.',
  )
  // Facts without span: {at} is the hold end, with no lead and `after`.
  expect(questionText(five, 'prompt', 'hold', true)).toEndWith(
    'If you do not answer, all of it continues after 16:20, unless a reserve is still reached. Stop here gives your prompt back and pauses other work until 16:20.',
  )
  expect(questionText(F5, 'loop', 'hold', true)).toContain('the work waits until 15:00. Then')
  expect(whenOf([five, OPEN7])).toEqual({ at: 'Mon 09:00' })
})

test('the reset notices with an empty open list are the D0.2 texts', () => {
  for (const named of NAMED) {
    expect(notice.resetContinues(named, [])).toBe(`${resetText(named)}. Held work continues.`)
    expect(notice.resetStillHeld(named, [F5], [])).toBe(`${resetText(named)}, but your 10% reserve is reached. Held work still waits.`)
    expect(notice.resetResumes(named, [])).toBe(`${resetText(named)}. spare10 continues the stopped work.`)
    expect(notice.resetStopOver(named, [])).toBe(`${resetText(named)}, and the stop is over. Type a prompt to continue.`)
    expect(notice.stopTakenOver(named, [])).toBe(`${resetText(named)}, and the stop is over.`)
    expect(notice.stopExtended(named, [FW], 'Mon 09:00', [])).toBe(`${resetText(named)}, but your 10% weekly reserve is reached. The stop lasts until Mon 09:00.`)
    expect(notice.resetWaitingFor(named, [])).toBe(`${resetText(named)}. Held work still waits for your answer.`)
    expect(notice.resetContinues(named)).toBe(notice.resetContinues(named, []))
    expect(resumePrompt(named, [])).toBe(resumePrompt(named))
    expect(resetContext(named, [])).toBe(resetContext(named))
  }
  expect(notice.resetContinues(FIVE)).toBe('the 5-hour window reset. Held work continues.')
  expect(notice.resetWaitingFor(FIVE)).toBe(notice.resetWaiting)
})

test('the reset notices with open kinds, and their empty-event forms', () => {
  expect(notice.resetContinues([], [OPEN5])).toBe('the 5-hour window resets at 16:40. Your 10% reserve is open until then. Held work continues.')
  expect(notice.resetStillHeld([], [FW], [OPEN5])).toBe(
    'the 5-hour window resets at 16:40. Your 10% reserve is open until then, but your 10% weekly reserve is reached. Held work still waits.',
  )
  expect(notice.resetResumes([], [OPEN5])).toBe('the 5-hour window resets at 16:40. Your 10% reserve is open until then. spare10 continues the stopped work.')
  expect(notice.resetStopOver([], [OPEN5])).toBe(
    'the 5-hour window resets at 16:40. Your 10% reserve is open until then, and the stop is over. Type a prompt to continue.',
  )
  expect(notice.stopTakenOver([], [OPEN5])).toBe('the 5-hour window resets at 16:40. Your 10% reserve is open until then, and the stop is over.')
  expect(notice.stopExtended([], [OWN7], untilPhrase(untilFor(OWN7, W - S7, ['seven_day'], true)), [OPEN5])).toBe(
    'the 5-hour window resets at 16:40. Your 10% reserve is open until then, but your 10% weekly reserve is reached. The stop lasts until Mon 01:00, 8 h before the weekly reset.',
  )
  // Both open, a reset and an open kind, and a test window.
  expect(notice.resetContinues([], [OPEN5, OPEN7])).toBe(
    'the 5-hour window resets at 16:40, and the weekly window resets at Mon 09:00. Your 10% reserve and your 10% weekly reserve are open until then. Held work continues.',
  )
  expect(notice.resetResumes(FIVE, [OPEN7])).toBe(
    'the 5-hour window reset. The weekly window resets at Mon 09:00. Your 10% weekly reserve is open until then. spare10 continues the stopped work.',
  )
  expect(notice.resetContinues([], [{ ...OPEN5, resetsAtMs: T1400 + 22 * MIN, test: true }])).toBe(
    'the test window ends at 14:22. Your 10% reserve is open until then. Held work continues.',
  )
  // The empty event: a test kind whose skip start came while a real trip beneath it still gates (B45).
  expect(notice.resetStillHeld([], [F5], [])).toBe('your 10% reserve is reached. Held work still waits.')
  expect(notice.stopTakenOver([], [])).toBe('the stop is over.')
  expect(notice.stopExtended([], [OWN7], 'Mon 01:00', [])).toBe('your 10% weekly reserve is reached. The stop lasts until Mon 01:00.')
})

test('resetWaitingFor says that new work goes on only when a kind is open', () => {
  expect(notice.resetWaitingFor([], [OPEN5])).toBe(
    'the 5-hour window resets at 16:40. Your 10% reserve is open until then, but held work still waits for your answer. New work goes on with no question.',
  )
  expect(notice.resetWaitingFor(FIVE, [OPEN7])).toBe(
    'the 5-hour window reset. The weekly window resets at Mon 09:00. Your 10% weekly reserve is open until then, but held work still waits for your answer. New work goes on with no question.',
  )
  expect(notice.resetWaitingFor(FIVE, [])).toBe('the 5-hour window reset. Held work still waits for your answer.')
  expect(notice.resetWaitingFor(FIVE, [])).not.toContain('New work')
  // Another window still gates: it holds new work too, so the note does not say that new work goes on.
  expect(notice.resetWaitingFor([], [OPEN5], false)).toBe(
    'the 5-hour window resets at 16:40. Your 10% reserve is open until then, but held work still waits for your answer.',
  )
})

test('the stop and hold-limit notices name the skip start and the lead', () => {
  const u = untilFor(OWN5, R1640 - S5, ['five_hour'], true)
  expect(u).toEqual({ at: '16:20', lead: '20 min before the reset' })
  expect(untilFor(OWN5, R1640 - S5, ['five_hour'], false)).toEqual({ at: '16:20' }) // not a skip owner: no lead
  expect(untilFor(OPEN5, R1640 - S5, ['five_hour'], true)).toEqual({ at: '16:20' }) // no span: no lead
  expect(untilFor([OWN5, OWN7], W - S7, ['five_hour', 'seven_day'], true)).toEqual({ at: 'Mon 01:00', lead: '8 h before the weekly reset' })
  expect(notice.stopped(OWN5, { ...u, work: true })).toBe(
    'stopped at your 10% reserve until 16:20, 20 min before the reset. Then spare10 continues the work, unless a reserve is still reached. Type a prompt to be asked again, or run /spare10 resume.',
  )
  expect(notice.stopped(OWN5, { ...u, work: false })).toBe(
    'stopped at your 10% reserve until 16:20, 20 min before the reset. Type a prompt to be asked again, or run /spare10 resume.',
  )
  expect(notice.holdLimit(OWN5, { ...u, work: true })).toBe(
    'the hold reached its time limit. The work is stopped at your 10% reserve until 16:20, 20 min before the reset. Then spare10 continues it, unless a reserve is still reached.',
  )
  expect(notice.holdLimit(OWN5, { ...u, work: false })).toBe(
    'the hold reached its time limit. The work is stopped at your 10% reserve until 16:20, 20 min before the reset. Type a prompt to be asked again, or run /spare10 resume.',
  )
  expect(notice.stopped(F5, { at: '15:00', work: true })).toBe(notice.stopped(F5, { at: '15:00', work: true, lead: undefined as never }))
})

test('the late stop notices: soon and open', () => {
  expect(notice.stoppedLate(OWN5, OPEN_5, true)).toBe(
    'stopped at your 10% reserve. The 5-hour window resets at 16:40. Your 10% reserve is open until then, so spare10 continues the work soon, unless a reserve is still reached.',
  )
  expect(notice.stoppedLate(OWN5, OPEN_5, false)).toBe(
    'stopped. Held work is refused. The 5-hour window resets at 16:40. Your 10% reserve is open until then, so new work goes on with no question.',
  )
  expect(notice.holdLimitLate(OWN5, OPEN_5, true)).toBe(
    'the hold reached its time limit. The work is stopped at your 10% reserve. The 5-hour window resets at 16:40. Your 10% reserve is open until then, so spare10 continues it soon, unless a reserve is still reached.',
  )
  expect(notice.holdLimitLate(OWN5, OPEN_5, false)).toBe(
    'the hold reached its time limit. Held work is refused. The 5-hour window resets at 16:40. Your 10% reserve is open until then, so new work goes on with no question.',
  )
  // No past time: the skip start that has passed is never named.
  for (const soon of [false, true]) {
    for (const t of [notice.stoppedLate(OWN5, OPEN_5, soon), notice.holdLimitLate(OWN5, OPEN_5, soon)]) {
      expect(t).not.toContain('16:20')
      expect(t).not.toContain(' until 1')
    }
  }
})

test('the open resume prompt and the open reset note', () => {
  expect(resumePrompt([], [OPEN5])).toBe(
    'The 5-hour window resets at 16:40. Your 10% reserve is open until then, so the stop at the quota reserve is over. spare10 is set to continue the work when the reserve opens, so do not wait for the user. Continue the task from the point where it stopped. A subagent whose result says "spare10: work stopped" or "spare10: the user stopped work" did not finish. Run it again if you still need its result.',
  )
  expect(resetContext([], [OPEN5])).toBe(
    "spare10: earlier work stopped at the quota reserve. The 5-hour window resets at 16:40. Your 10% reserve is open until then, so the stop is over. The stopped task is not finished. After the user's message, continue it unless the user says otherwise.",
  )
  expect(resumePrompt(FIVE, [OPEN7])).toStartWith('The 5-hour window reset. The weekly window resets at Mon 09:00. Your 10% weekly reserve is open until then, so the stop')
  expect(resumePrompt([], [OPEN5]).startsWith('spare10')).toBe(false)
  expect(resetContext([], [OPEN5]).startsWith('spare10: ')).toBe(true)
})

test('the stop replies have skip, late, open and overdue forms', () => {
  const u = untilFor(OWN5, R1640 - S5, ['five_hour'], true)
  expect(stopReply('open', OPEN5)).toBe(
    'nothing to stop. The reset is near, so your 10% reserve is open until 16:40. To keep a reserve until the reset, set its Open reserve option to 0 in /config.',
  )
  expect(stopReply('open', [OPEN5, OPEN7])).toBe(
    'nothing to stop. The reset is near, so your 10% reserve and your 10% weekly reserve are open until they reset (16:40 and Mon 09:00). To keep a reserve until the reset, set its Open reserve option to 0 in /config.',
  )
  expect(stopReply('overdue-open', OPEN5)).toBe(
    'the stop is over, because the reset is near. Your 10% reserve is open until 16:40. spare10 will not continue the stopped work.',
  )
  expect(stopReply('overdue-skip')).toBe('the stop is over. spare10 will not continue the stopped work.')
  expect(stopReply('overdue')).toBe('the stop ended at the reset. spare10 will not continue the stopped work.')
  expect(stopReply('tripped', OWN5, undefined, { ...u })).toBe(
    'stopped at the reserve until 16:20, 20 min before the reset. Then spare10 continues any stopped work. Type a prompt to be asked again, or run /spare10 resume.',
  )
  expect(stopReply('tripped', OWN5, undefined, { ...u, continues: false })).toBe(
    'stopped at the reserve until 16:20, 20 min before the reset. Type a prompt to be asked again, or run /spare10 resume.',
  )
  expect(stopReply('asking', undefined, undefined, u)).toBe('stopped. Held work is refused. spare10 continues it at 16:20, 20 min before the reset.')
  expect(stopReply('asking', undefined, undefined, { at: '15:00' })).toBe('stopped. Held work is refused. spare10 continues it after 15:00.')
  expect(stopReply('asking-soon', undefined, undefined, undefined, undefined, OPEN_5)).toBe(
    'stopped. Held work is refused. The 5-hour window resets at 16:40. Your 10% reserve is open until then, so spare10 continues it soon, unless a reserve is still reached.',
  )
  expect(stopReply('asking-open', undefined, undefined, undefined, undefined, OPEN_5)).toBe(
    'stopped. Held work is refused. The 5-hour window resets at 16:40. Your 10% reserve is open until then, so new work goes on with no question.',
  )
  expect(stopReply('stopped', OWN5, undefined, u)).toBe('already stopped until 16:20.') // the lead is left out
})

test('the resume replies: open, and overdue with an empty event', () => {
  expect(resumeReply('open', OPEN5)).toBe('nothing to resume. The reset is near, so your 10% reserve is open until 16:40.')
  expect(resumeReply('open', OPEN7)).toBe('nothing to resume. The reset is near, so your 10% weekly reserve is open until Mon 09:00.')
  expect(resumeReply('overdue', undefined, [], [OPEN5])).toBe(
    'the 5-hour window resets at 16:40. Your 10% reserve is open until then, and the stop is over. Type a prompt to continue.',
  )
  expect(resumeReply('overdue', undefined, [], [])).toBe('the stop is over. Type a prompt to continue.')
  expect(resumeReply('overdue')).toBe('the stop is over. Type a prompt to continue.')
  expect(resumeReply('overdue', undefined, FIVE)).toBe('the 5-hour window reset, and the stop is over. Type a prompt to continue.')
})

const SPANS = { lastMinutes: 20, lastMinutesFrom: 'option', weeklyLastHours: 8, weeklyLastHoursFrom: 'option' } as const

test('the status report shows the reserve opens rows with their sources, and leaves weekly opens out when the weekly guard is off', () => {
  expect(statusReport(status02({ spans: SPANS }))).toBe(
    [
      'version 0.3.0',
      '',
      '  ● armed          spare10 steps in at 90% used, or at 90% used of the weekly window.',
      '  · reserve        10% of the 5-hour window (from /config)',
      '  · weekly reserve 10% of the weekly window (from /config)',
      '  · reserve opens  in the last 20 min of the 5-hour window (from /config)',
      '  · weekly opens   in the last 8 h of the weekly window (from /config)',
      '  · at the reserve stop and ask you',
      '  · at the reset   continue by itself (from /config)',
      '  · reading        live · 42% used · 58% left · resets 14:00 (in 2 h 14 min)',
      '  · weekly reading live · 61% used · 39% left · resets Mon 09:00 (in 3 d 21 h)',
      '  · consent        none',
      '  · weekly consent none',
      '  · guarded        yes (scope all)',
      '  · claude -p      runs started here: stop',
      '',
      '/spare10 resume   continue on the reserve until the window resets',
      '/spare10 stop     stop at the reserve now',
    ].join('\n'),
  )
  const rows = (over: Partial<StatusInput>): string[] =>
    statusReport(status02(over))
      .split('\n')
      .filter((l) => l.includes('opens '))
  expect(rows({ spans: { lastMinutes: 2.5, lastMinutesFrom: 'env', weeklyLastHours: 0, weeklyLastHoursFrom: 'env' } })).toEqual([
    '  · reserve opens  in the last 2.5 min of the 5-hour window (from SPARE10_LAST_MINUTES)',
    '  · weekly opens   only at the reset (from SPARE10_WEEKLY_LAST_HOURS)',
  ])
  expect(rows({ spans: { lastMinutes: 0, lastMinutesFrom: 'option', weeklyLastHours: 0.5, weeklyLastHoursFrom: 'option' } })).toEqual([
    '  · reserve opens  only at the reset (from /config)',
    '  · weekly opens   in the last 0.5 h of the weekly window (from /config)',
  ])
  expect(rows({ spans: { lastMinutes: 0, lastMinutesFrom: 'unread', weeklyLastHours: 0, weeklyLastHoursFrom: 'unread' } })).toEqual([
    '  · reserve opens  only at the reset (spare10 could not read the env)',
    '  · weekly opens   only at the reset (spare10 could not read the env)',
  ])
  for (const weekly of ['off', { reserve: 0, from: 'option', basis: { kind: 'none', why: 'no-reading' } }] as const) {
    expect(rows({ spans: SPANS, weekly })).toEqual(['  · reserve opens  in the last 20 min of the 5-hour window (from /config)'])
  }
  // Unattended runs show the rows too. Without spans: no rows (the D0.2 report).
  expect(rows({ spans: SPANS, attended: false, headless: 'stop' })).toHaveLength(2)
  expect(rows({})).toEqual([])
  // D4: every value starts at column 19.
  for (const row of statusReport(status02({ spans: SPANS })).split('\n').slice(2, 15)) {
    const chars = [...row]
    expect(chars[18]).toBe(' ')
    expect(chars[19]).not.toBe(' ')
  }
})

test('the open phase line names the open reserves and the reset', () => {
  const line = (over: Partial<StatusInput>) => statusReport(status02(over)).split('\n')[2]
  expect(line({ phase: 'open', open: [OPEN5] })).toBe('  ↻ open           the reset is near. Your 10% reserve is open until 16:40, so spare10 lets all work through.')
  expect(line({ phase: 'open', open: [OPEN7, OPEN5] })).toBe(
    '  ↻ open           the reset is near. Your 10% reserve and your 10% weekly reserve are open until they reset (16:40 and Mon 09:00), so spare10 lets all work through.',
  )
  expect(line({ phase: 'open' })).toBe('  ↻ open           the reset is near, so spare10 lets all work through.')
})

test('the asking line says that new work goes on while a reserve is open', () => {
  const line = (over: Partial<StatusInput>) => statusReport(status02(over)).split('\n')[2]
  expect(line({ phase: 'asking', open: [OPEN5] })).toBe(
    '  ? asking         a question is open. Held work waits until you answer. Your 10% reserve is open until 16:40, so new work goes on. If no dialog shows, run /spare10 resume or /spare10 stop.',
  )
  expect(line({ phase: 'asking', open: [OPEN5], at: { ms: W - S7, kinds: ['seven_day'], skip: true } })).toBe(
    '  ? asking         a question is open. Held work waits until you answer, or until Mon 01:00. Your 10% reserve is open until 16:40, so new work goes on. If no dialog shows, run /spare10 resume or /spare10 stop.',
  )
  expect(line({ phase: 'asking', open: [] })).toBe(line({ phase: 'asking' })) // no open kind: the D0.2 line
})

test('a skip stop and a skip wait say at, not after', () => {
  const at = { ms: R1640 - S5, kinds: ['five_hour'] as Kind[], skip: true }
  const line = (over: Partial<StatusInput>) => statusReport(status02(over)).split('\n')[2]
  expect(line({ phase: 'stopped', at, skipStop: true, autoStop: true, work: true })).toBe(
    '  ■ stopped        you chose Stop here. spare10 continues the work at 16:20. Type a prompt to be asked again, or run /spare10 resume.',
  )
  // No work, or autoResume off (no auto tag in force): the stop ends by time, and the line says until when.
  for (const over of [{ autoStop: true, work: false }, { autoStop: false, work: true }, { autoStop: false, work: false }]) {
    expect(line({ phase: 'stopped', at, skipStop: true, ...over })).toBe(
      '  ■ stopped        you chose Stop here, until 16:20. Type a prompt to be asked again, or run /spare10 resume.',
    )
  }
  expect(line({ phase: 'reserve', attended: false, headless: 'wait', at })).toBe('  ⚠ tripped        unattended run, policy wait. Held work continues at 16:20.')
  // Not a skip: the D0.2 lines.
  expect(line({ phase: 'reserve', attended: false, headless: 'wait', at: { ...at, skip: false } })).toBe(
    '  ⚠ tripped        unattended run, policy wait. Held work continues after 16:20.',
  )
  expect(line({ phase: 'stopped', at: { ...at, skip: false }, autoStop: true, work: true })).toBe(
    '  ■ stopped        you chose Stop here. spare10 continues the work after 16:20. Type a prompt to be asked again, or run /spare10 resume.',
  )
})

test('the simulate reply says when the reserve opens, that it is open at once, or that the real reading holds', () => {
  const t22: Facts = { used: 95, left: 5, resetsAtMs: T1400 + 22 * MIN, reserve: 10, timeZone: TZ, test: true, span: S5 }
  expect(simulateReply('set', t22, { at: '14:02', lead: '20 min before the test window ends' })).toBe(
    'test reading set to 95% used, resets 14:22. It can only raise the real reading. The reserve opens at 14:02, 20 min before the test window ends. Run /spare10 simulate off to clear it.',
  )
  expect(simulateReply('set', { ...t22, resetsAtMs: T1400 + 10 * MIN }, 'now')).toBe(
    'test reading set to 95% used, resets 14:10. It can only raise the real reading. The test window ends within 20 min, so the reserve is open at once. Run /spare10 simulate off to clear it.',
  )
  expect(simulateReply('set', TEST7, { at: 'Thu 14:02', lead: '8 h before the weekly test window ends' })).toBe(
    'test reading set to 95% used of the weekly window, resets Thu 22:02. It can only raise the real reading. The weekly reserve opens at Thu 14:02, 8 h before the weekly test window ends. Run /spare10 simulate off to clear it.',
  )
  expect(simulateReply('set', t22, 'real')).toBe(
    'test reading set to 95% used, resets 14:22. It can only raise the real reading. The real reading is also in the reserve, so the test window does not open it. Run /spare10 simulate off to clear it.',
  )
  expect(simulateReply('set', TEST7, 'real')).toContain(
    'It can only raise the real reading. The real weekly reading is also in the weekly reserve, so the weekly test window does not open it. Run',
  )
  expect(simulateReply('set', TEST7, 'now')).toContain('The weekly test window ends within 8 h, so the weekly reserve is open at once.')
  // A span of 0, or a percentage below the trip point: the caller passes nothing, and the reply is D0.2.
  expect(simulateReply('set', { ...t22, used: 50, left: 50 })).toBe(
    'test reading set to 50% used, resets 14:22. It can only raise the real reading. Run /spare10 simulate off to clear it.',
  )
  expect(simulateReply('bad')).toBe(
    '/spare10 simulate takes a percentage from 0 to 100, or off. Add weekly for the weekly window, and in 22m for a test window that resets in 22 minutes.',
  )
})

test('B27 names 0 to 299 and 0 to 167, and B29 names the time that the question names', () => {
  expect(badWarning('SPARE10_LAST_MINUTES', '300', '20')).toBe('SPARE10_LAST_MINUTES="300" is not 0 to 299. spare10 uses 20.')
  expect(badWarning('SPARE10_WEEKLY_LAST_HOURS', 'x', '8')).toBe('SPARE10_WEEKLY_LAST_HOURS="x" is not 0 to 167. spare10 uses 8.')
  expect(timeoutWarning('CLAUDE_AFK_TIMEOUT_MS', true)).toBe(
    'questions here continue by themselves after a time limit (CLAUDE_AFK_TIMEOUT_MS). An unanswered spare10 question then counts as Stop here, and spare10 continues the work at the time that the question names.',
  )
  expect(timeoutWarning('CLAUDE_AFK_TIMEOUT_MS', false)).toBe(
    'questions here continue by themselves after a time limit (CLAUDE_AFK_TIMEOUT_MS). An unanswered spare10 question then counts as Stop here.',
  )
})

test('the unattended open debug line keeps its prefix', () => {
  expect(debugLine.unattendedOpen(OPEN5)).toBe(
    'spare10: unattended run inside the reserve (92% used · 8% left · resets 16:40), but the reset is near. spare10 lets it through.',
  )
  expect(debugLine.unattendedOpen([OPEN5, OPEN7]).startsWith('spare10: ')).toBe(true)
})

// The skip notices and replies: the engine prefixes each one.
function skipEnginePrefixed(): string[] {
  const u = untilFor(OWN5, R1640 - S5, ['five_hour'], true)
  const endeds: Ended[] = [NONE, OPEN_5, { reset: FIVE, open: [OPEN7] }, { reset: [], open: [OPEN5, OPEN7] }]
  const out: string[] = [
    badWarning('SPARE10_LAST_MINUTES', '300', '20'),
    badWarning('SPARE10_WEEKLY_LAST_HOURS', 'x', '8'),
    stopReply('overdue-skip'),
    resumeReply('overdue', undefined, [], []),
    notice.stopTakenOver([], []),
  ]
  for (const e of endeds.slice(1)) {
    out.push(notice.stoppedLate(OWN5, e, true), notice.stoppedLate(OWN5, e, false), notice.holdLimitLate(OWN5, e, true), notice.holdLimitLate(OWN5, e, false))
    out.push(stopReply('asking-soon', undefined, undefined, undefined, undefined, e), stopReply('asking-open', undefined, undefined, undefined, undefined, e))
  }
  for (const e of endeds) {
    out.push(notice.resetWaitingFor(e.reset.length === 0 ? FIVE : e.reset, e.open), notice.resetContinues(e.reset, e.open))
    out.push(notice.resetStillHeld(e.reset, [FW], e.open), notice.resetResumes(e.reset.length === 0 ? FIVE : e.reset, e.open))
    out.push(notice.resetStopOver(e.reset.length === 0 ? FIVE : e.reset, e.open), notice.stopTakenOver(e.reset, e.open))
    out.push(notice.stopExtended(e.reset, [OWN7], 'Mon 01:00, 8 h before the weekly reset', e.open), resumeReply('overdue', undefined, e.reset, e.open))
  }
  for (const f of [OPEN5, OPEN7, [OPEN5, OPEN7]]) out.push(resumeReply('open', f), stopReply('open', f), stopReply('overdue-open', f))
  for (const work of [false, true]) out.push(notice.stopped(OWN5, { ...u, work }), notice.holdLimit(OWN5, { ...u, work }))
  for (const continues of [false, true]) out.push(stopReply('tripped', OWN5, undefined, { ...u, continues }))
  out.push(stopReply('asking', undefined, undefined, u), stopReply('stopped', OWN5, undefined, u))
  for (const opens of [undefined, 'now', 'real', { at: '14:02', lead: '20 min before the test window ends' }] as const) {
    out.push(simulateReply('set', TEST5, opens), simulateReply('set', TEST7, opens))
  }
  out.push(statusReport(status02({ spans: SPANS, phase: 'open', open: [OPEN5] })))
  return out
}

test('every skip notice and reply starts without the engine prefix', () => {
  const texts = skipEnginePrefixed()
  expect(texts.length).toBeGreaterThan(60)
  for (const t of texts) {
    expect(t.startsWith('spare10: ')).toBe(false)
    expect(t.startsWith('spare10 ')).toBe(false)
  }
})

// Every skip text, skip on and off, for the STE guard.
function skipTexts(): string[] {
  const out: string[] = [...skipEnginePrefixed(), debugLine.unattendedOpen(OPEN5), debugLine.unattendedOpen([OPEN5, OPEN7])]
  for (const f of [OWN5, OWN7, TEST5, TEST7, KIT, [OWN5, OWN7], [OWN5, OPEN7]] as Array<Facts | Facts[]>) {
    for (const auto of [false, true])
      for (const opener of ['loop', 'prompt'] as const)
        for (const mode of ['hold', 'tell'] as const) out.push(questionText(f, opener, mode, auto))
    out.push(soonText(f), whenOf(f).at, untilPhrase(whenOf(f)))
  }
  for (const f of [OWN5, OWN7, TEST5, TEST7]) out.push(leadText(f) ?? 'no lead', spanText(f))
  for (const named of NAMED)
    for (const open of [[], [OPEN5], [OPEN7], [OPEN5, OPEN7]] as Facts[][]) {
      out.push(resumePrompt(named, open), resetContext(named, open), eventText(named, open) || 'empty')
    }
  const spans = [
    SPANS,
    { lastMinutes: 0, lastMinutesFrom: 'env', weeklyLastHours: 0, weeklyLastHoursFrom: 'unread' },
    { lastMinutes: 2.5, lastMinutesFrom: 'unread', weeklyLastHours: 167, weeklyLastHoursFrom: 'env' },
  ] as const
  const phases: Phase[] = ['off', 'blind', 'waiting', 'armed', 'consented', 'open', 'stopped', 'asking', 'told', 'reserve', 'tripped']
  for (const phase of phases)
    for (const attended of [true, false])
      for (const sp of spans)
        for (const skip of [false, true]) {
          out.push(
            statusReport(
              status02({
                phase,
                attended,
                spans: sp,
                open: skip ? [OPEN5, OPEN7] : [],
                skipStop: skip,
                at: { ms: R1640 - S5, kinds: ['five_hour'], skip },
                headless: attended ? 'off' : 'wait',
                work: skip,
                autoStop: true,
              }),
            ),
          )
          out.push(badgeView(phase, { reserve: 10, test: skip, mode: 'hold', blink: skip, until: '16:40' }).text)
        }
  return out
}

// ---- The resume floor (floor design 2, 7.2) ----

// The examples of floor 2: 5-hour reserve 10, floor 5, reset 14:00, span 20 min, skip start 13:40.
// Weekly reserve 10, floor 5, reset Mon 09:00, span 8 h, skip start Mon 01:00. A kind at the reserve
// reads 91%, a kind at the floor 96% (4% left). Now is Thursday 12:00.
const RES5: Facts = { used: 91, left: 9, resetsAtMs: R14, reserve: 10, timeZone: TZ, holdEnd: R14 - S5, span: S5, to: 95 }
const FLO5: Facts = { used: 96, left: 4, resetsAtMs: R14, reserve: 10, timeZone: TZ, holdEnd: R14 - S5, span: S5, floor: 5 }
const RES7: Facts = { used: 91, left: 9, resetsAtMs: W, reserve: 10, timeZone: TZ, kind: 'seven_day', now: T0, holdEnd: W - S7, span: S7, to: 95 }
const FLO7: Facts = { used: 96, left: 4, resetsAtMs: W, reserve: 10, timeZone: TZ, kind: 'seven_day', now: T0, holdEnd: W - S7, span: S7, floor: 5 }
const RES7B: Facts = { ...RES7, used: 92, left: 8 } // the weekly window at 92
const FULL7B: Facts = { used: 92, left: 8, resetsAtMs: W, reserve: 10, timeZone: TZ, kind: 'seven_day', now: T0 } // the weekly window at 92, no floor in force
const FLO7B: Facts = { ...FLO7, used: 97, left: 3 } // the weekly window at 97
const NOSPAN = <T extends Facts>(f: T): Facts => {
  const { holdEnd: _h, span: _s, ...rest } = f
  return rest
}
/** The facts of a consented kind: the skip start ahead rides along, but it has no span (not a question). */
const NOLEAD = (f: Facts): Facts => {
  const { span: _s, ...rest } = f
  return rest
}
const ASKS_5 = 'Until 13:40, spare10 asks you again at 95% used.'
const AFTER_LOOP_5 = 'If you choose Stop here or do not answer, the work waits until 13:40, 20 min before the reset. Then spare10 continues it, unless a reserve is still reached.'
const AFTER_LOOP_7 = 'If you choose Stop here or do not answer, the work waits until Mon 01:00, 8 h before the weekly reset. Then spare10 continues it, unless a reserve is still reached.'
const FLOORS = { resumeFloor: 5, resumeFloorFrom: 'option', weeklyResumeFloor: 5, weeklyResumeFloorFrom: 'option' } as const

test('the first question names the end point and says until when spare10 asks again', () => {
  expect(questionText(RES5, 'loop', 'hold', true)).toBe(
    `Your 10% reserve is reached: 91% used · 9% left · resets 14:00. All work is on hold. Continue on the reserve until 95% used? ${ASKS_5} ${AFTER_LOOP_5}`,
  )
  expect(questionText(RES5, 'prompt', 'hold', true)).toBe(
    'Your 10% reserve is reached: 91% used · 9% left · resets 14:00. spare10 holds your prompt and any other work. Continue on the reserve until 95% used? Until 13:40, spare10 asks you again at 95% used. If you do not answer, all of it continues at 13:40, 20 min before the reset, unless a reserve is still reached. Stop here gives your prompt back and pauses other work until 13:40.',
  )
  expect(questionText(RES5, 'prompt', 'tell', true)).toBe(
    'Your 10% reserve is reached: 91% used · 9% left · resets 14:00. spare10 holds your prompt. Continue on the reserve until 95% used? Until 13:40, spare10 tells the agents to wind down at 95% used. If you do not answer, your prompt goes in at 13:40, 20 min before the reset, unless a reserve is still reached. Stop here gives it back to you.',
  )
  expect(questionText(RES5, 'loop', 'hold', false)).toBe(
    'Your 10% reserve is reached: 91% used · 9% left · resets 14:00. All work is on hold. Continue on the reserve until 95% used? Until 13:40, spare10 asks you again at 95% used.',
  )
  // Spans off: no skip start ahead, the D0.2 {after}.
  expect(questionText(NOSPAN(RES5), 'loop', 'hold', true)).toBe(
    'Your 10% reserve is reached: 91% used · 9% left · resets 14:00. All work is on hold. Continue on the reserve until 95% used? At 95% used, spare10 asks you again. If you choose Stop here or do not answer, the work waits until 14:00. Then spare10 continues it, unless a reserve is still reached.',
  )
  // No reset time: the first-sight hold end rides along, and no skip start is ahead.
  const noReset: Facts = { used: 91, left: 9, resetsAtMs: null, reserve: 10, timeZone: TZ, holdEnd: R14 + HOUR, to: 95 }
  expect(questionText(noReset, 'loop', 'hold', true)).toBe(
    'Your 10% reserve is reached: 91% used · 9% left · resets at an unknown time. All work is on hold. Continue on the reserve for one hour, or until 95% used? At 95% used, spare10 asks you again. If you choose Stop here or do not answer, the work waits until 15:00. Then spare10 continues it, unless a reserve is still reached.',
  )
  // The kit default: 90% used at T0, reset 15:00.
  expect(questionText({ ...KIT, to: 95 }, 'loop', 'hold', true)).toBe(
    'Your 10% reserve is reached: 90% used · 10% left · resets 15:00. All work is on hold. Continue on the reserve until 95% used? Until 14:40, spare10 asks you again at 95% used. If you choose Stop here or do not answer, the work waits until 14:40, 20 min before the reset. Then spare10 continues it, unless a reserve is still reached.',
  )
  expect(questionText(RES7, 'loop', 'hold', true)).toBe(
    `Your 10% weekly reserve is reached: 91% used · 9% left · resets Mon 09:00. All work is on hold. Continue on the weekly reserve until 95% used? Until Mon 01:00, spare10 asks you again at 95% used of the weekly window. ${AFTER_LOOP_7}`,
  )
  expect(questionText(NOSPAN(RES7), 'loop', 'hold', false)).toBe(
    'Your 10% weekly reserve is reached: 91% used · 9% left · resets Mon 09:00. All work is on hold. Continue on the weekly reserve until 95% used? At 95% used of the weekly window, spare10 asks you again.',
  )
})

test('the second question names what is left and the reset', () => {
  expect(questionText(FLO5, 'loop', 'hold', true)).toBe(
    `Your 5% floor is reached: 96% used · 4% left · resets 14:00. All work is on hold. Continue on the last 4% until 14:00? ${AFTER_LOOP_5}`,
  )
  expect(questionText(FLO5, 'prompt', 'hold', true)).toBe(
    'Your 5% floor is reached: 96% used · 4% left · resets 14:00. spare10 holds your prompt and any other work. Continue on the last 4% until 14:00? If you do not answer, all of it continues at 13:40, 20 min before the reset, unless a reserve is still reached. Stop here gives your prompt back and pauses other work until 13:40.',
  )
  expect(questionText(FLO5, 'prompt', 'tell', true)).toBe(
    'Your 5% floor is reached: 96% used · 4% left · resets 14:00. spare10 holds your prompt. Continue on the last 4% until 14:00? If you do not answer, your prompt goes in at 13:40, 20 min before the reset, unless a reserve is still reached. Stop here gives it back to you.',
  )
  expect(questionText(FLO5, 'loop', 'hold', false)).toBe(
    'Your 5% floor is reached: 96% used · 4% left · resets 14:00. All work is on hold. Continue on the last 4% until 14:00?',
  )
  const noReset: Facts = { used: 96, left: 4, resetsAtMs: null, reserve: 10, timeZone: TZ, holdEnd: R14 + HOUR, floor: 5 }
  expect(questionText(noReset, 'loop', 'hold', true)).toBe(
    'Your 5% floor is reached: 96% used · 4% left · resets at an unknown time. All work is on hold. Continue on the last 4% for one hour? If you choose Stop here or do not answer, the work waits until 15:00. Then spare10 continues it, unless a reserve is still reached.',
  )
  expect(questionText(FLO7, 'loop', 'hold', true)).toBe(
    `Your 5% weekly floor is reached: 96% used · 4% left · resets Mon 09:00. All work is on hold. Continue on the last 4% of the weekly window until Mon 09:00? ${AFTER_LOOP_7}`,
  )
  expect(questionText({ ...FLO7, resetsAtMs: null, holdEnd: W }, 'loop', 'hold', false)).toBe(
    'Your 5% weekly floor is reached: 96% used · 4% left · resets at an unknown time. All work is on hold. Continue on the last 4% of the weekly window for one hour?',
  )
})

test('a question with two windows at the reserve, at the floor, mixed, and with different end points', () => {
  expect(questionText([RES5, RES7B], 'loop', 'hold', true)).toBe(
    `Your 10% reserve and your 10% weekly reserve are reached: 5-hour window 91% used · 9% left · resets 14:00, weekly window 92% used · 8% left · resets Mon 09:00. All work is on hold. Continue on both reserves until 95% used? Until its reserve opens, spare10 asks you again at 95% used of either window. ${AFTER_LOOP_7}`,
  )
  expect(questionText([FLO5, FLO7B], 'loop', 'hold', true)).toBe(
    `Your 5% floor and your 5% weekly floor are reached: 5-hour window 96% used · 4% left · resets 14:00, weekly window 97% used · 3% left · resets Mon 09:00. All work is on hold. Continue on the last 4% until 14:00 and the last 3% of the weekly window until Mon 09:00? ${AFTER_LOOP_7}`,
  )
  expect(questionText([RES5, FLO7], 'loop', 'hold', true)).toBe(
    `Your 10% reserve and your 5% weekly floor are reached: 5-hour window 91% used · 9% left · resets 14:00, weekly window 96% used · 4% left · resets Mon 09:00. All work is on hold. Continue on the reserve until 95% used and the last 4% of the weekly window until Mon 09:00? ${ASKS_5} ${AFTER_LOOP_7}`,
  )
  expect(questionText([RES5, { ...RES7B, to: 97 }], 'loop', 'hold', true)).toBe(
    `Your 10% reserve and your 10% weekly reserve are reached: 5-hour window 91% used · 9% left · resets 14:00, weekly window 92% used · 8% left · resets Mon 09:00. All work is on hold. Continue on the reserve until 95% used and the weekly reserve until 97% used? Until its reserve opens, spare10 asks you again at 95% used, or at 97% used of the weekly window. ${AFTER_LOOP_7}`,
  )
  // The weekly floor off: the weekly part is the 0.2 part.
  expect(questionText([RES5, FULL7B], 'loop', 'hold', false)).toBe(
    'Your 10% reserve and your 10% weekly reserve are reached: 5-hour window 91% used · 9% left · resets 14:00, weekly window 92% used · 8% left · resets Mon 09:00. All work is on hold. Continue on the reserve until 95% used and the weekly reserve until Mon 09:00? Until 13:40, spare10 asks you again at 95% used.',
  )
  // No skip start ahead on either kind.
  expect(asksText([NOSPAN(RES5), NOSPAN(RES7B)])).toBe('At 95% used of either window, spare10 asks you again.')
  expect(asksText([NOSPAN(RES5), NOSPAN({ ...RES7B, to: 97 })])).toBe('At 95% used, or at 97% used of the weekly window, spare10 asks you again.')
  expect(asksText([NOSPAN(RES5), RES7B], 'tell')).toBe('Until its reserve opens, spare10 tells the agents to wind down at 95% used of either window.')
  expect(asksText([RES5, { ...RES7B, to: 97 }], 'tell')).toBe(
    'Until its reserve opens, spare10 tells the agents to wind down at 95% used, or at 97% used of the weekly window.',
  )
  expect(asksText(RES7)).toBe('Until Mon 01:00, spare10 asks you again at 95% used of the weekly window.')
  expect(asksText(NOSPAN(RES7))).toBe('At 95% used of the weekly window, spare10 asks you again.')
  expect(asksText([FLO5, FLO7])).toBe('')
})

test('facts without the floor fields give the 0.2 texts in both modes', () => {
  const f5: Facts = { used: 93, left: 7, resetsAtMs: R, reserve: 10, timeZone: TZ }
  const fw: Facts = { used: 92, left: 8, resetsAtMs: W, reserve: 10, timeZone: TZ, kind: 'seven_day', now: T0 }
  for (const mode of ['hold', 'tell'] as const) {
    expect(asksText(f5, mode)).toBe('')
    expect(asksText([OWN5, OWN7], mode)).toBe('')
    expect(questionText(f5, 'loop', mode, false)).toBe('Your 10% reserve is reached: 93% used · 7% left · resets 15:00. All work is on hold. Continue on the reserve until 15:00?')
    expect(questionText([f5, fw], 'loop', mode, false)).toBe(
      'Your 10% reserve and your 10% weekly reserve are reached: 5-hour window 93% used · 7% left · resets 15:00, weekly window 92% used · 8% left · resets Mon 09:00. All work is on hold. Continue on both reserves until they reset (15:00 and Mon 09:00)?',
    )
    expect(questionText(OWN5, 'loop', mode, true)).toBe(
      'Your 10% reserve is reached: 92% used · 8% left · resets 16:40. All work is on hold. Continue on the reserve until 16:40? If you choose Stop here or do not answer, the work waits until 16:20, 20 min before the reset. Then spare10 continues it, unless a reserve is still reached.',
    )
    expect(notice.continuing(f5, mode)).toBe('continuing on your 10% reserve. spare10 stays quiet until 15:00.')
    expect(notice.continuing([f5, fw], mode)).toBe('continuing on your 10% reserve and your 10% weekly reserve. spare10 stays quiet until they reset (15:00 and Mon 09:00).')
    expect(resumeReply('tripped', f5, undefined, undefined, mode)).toBe('you can use the reserve until 15:00.')
    expect(resumeReply('tripped', [f5, fw], undefined, undefined, mode)).toBe('you can use both reserves until they reset (15:00 and Mon 09:00).')
    expect(resumeReply('stopped', f5, undefined, undefined, mode)).toBe('resumed. You can use the reserve until 15:00. Type a prompt to continue.')
    expect(resumeReply('asking', fw, undefined, undefined, mode)).toBe('resumed. Held work continues on the weekly reserve until Mon 09:00.')
    expect(resumeReply('consented', f5, undefined, undefined, mode)).toBe('already resumed until 15:00.')
  }
  expect(modelFacts(f5)).toBe('into your 10% reserve · 7% of quota left · resets 15:00')
  expect(notice.told(f5)).toBe('your 10% reserve is reached. spare10 told the agents to wind down.')
  expect(notice.stopped(f5)).toBe('stopped at your 10% reserve. Type a prompt to be asked again, or run /spare10 resume.')
  expect(notStarted(f5)).toBe(
    'spare10: not started. This session is inside your 10% reserve until 15:00. Send the prompt again to be asked again, or run /spare10 resume.',
  )
  expect(resumeContext(f5)).toBe(
    'spare10: earlier work stopped at the 10% quota reserve. The user now chose to continue on the reserve until 15:00. Follow their message.',
  )
  expect(pauseInstruction(f5, null)).toBe(
    'spare10 budget guard. You have reached the safe usage limit for this session (into your 10% reserve · 7% of quota left · resets 15:00). Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.',
  )
})

test('the continuing notice at the reserve says until when spare10 asks again, and at the floor stays quiet until the reset', () => {
  expect(notice.continuing(RES5)).toBe('continuing on your 10% reserve until 95% used. Until 13:40, spare10 asks you again at 95% used.')
  expect(notice.continuing(NOSPAN(RES5))).toBe('continuing on your 10% reserve until 95% used. At 95% used, spare10 asks you again.')
  expect(notice.continuing(RES5, 'tell')).toBe(
    'continuing on your 10% reserve until 95% used. Until 13:40, spare10 tells the agents to wind down at 95% used.',
  )
  expect(notice.continuing(FLO5)).toBe('continuing on your 5% floor. spare10 stays quiet until 14:00.')
  expect(notice.continuing(RES7)).toBe(
    'continuing on your 10% weekly reserve until 95% used. Until Mon 01:00, spare10 asks you again at 95% used of the weekly window.',
  )
  expect(notice.continuing([RES5, RES7])).toBe(
    'continuing on your 10% reserve until 95% used and your 10% weekly reserve until 95% used. Until its reserve opens, spare10 asks you again at 95% used of either window.',
  )
  expect(notice.continuing([RES5, FLO7])).toBe(
    'continuing on your 10% reserve until 95% used and your 5% weekly floor until Mon 09:00. Until 13:40, spare10 asks you again at 95% used.',
  )
  // A kind with no floor in force beside one at the reserve.
  expect(notice.continuing([RES5, FULL7B])).toBe(
    'continuing on your 10% reserve until 95% used and your 10% weekly reserve until Mon 09:00. Until 13:40, spare10 asks you again at 95% used.',
  )
})

test('STOP, PAUSED, the stop notice, holdLimit, stopExtended, resetStillHeld, the told notice and notStarted name the floor at the floor', () => {
  expect(modelFacts(FLO5)).toBe('into your 5% floor · 4% of quota left · resets 14:00')
  expect(modelFacts(FLO7)).toBe('into your 5% weekly floor · 4% of weekly quota left · resets Mon 09:00')
  expect(stopText(FLO5)).toBe(
    'spare10: the user stopped work at the quota reserve (into your 5% floor · 4% of quota left · resets 14:00). Stop now and wait for the user. Do not call any further tools.',
  )
  expect(pausedText(FLO5)).toBe(
    'spare10: work stopped at the quota reserve (into your 5% floor · 4% of quota left · resets 14:00). No model request was sent, so this task is not finished. Wait for the user.',
  )
  const until = { at: '13:40', lead: '20 min before the reset' }
  expect(notice.stopped(FLO5, { ...until, work: true })).toBe(
    'stopped at your 5% floor until 13:40, 20 min before the reset. Then spare10 continues the work, unless a reserve is still reached. Type a prompt to be asked again, or run /spare10 resume.',
  )
  expect(notice.holdLimit(FLO5, { ...until, work: true })).toBe(
    'the hold reached its time limit. The work is stopped at your 5% floor until 13:40, 20 min before the reset. Then spare10 continues it, unless a reserve is still reached.',
  )
  expect(notice.resetStillHeld(FIVE, [FLO7])).toBe('the 5-hour window reset, but your 5% weekly floor is reached. Held work still waits.')
  expect(notice.stopExtended(FIVE, [FLO7], 'Mon 01:00, 8 h before the weekly reset')).toBe(
    'the 5-hour window reset, but your 5% weekly floor is reached. The stop lasts until Mon 01:00, 8 h before the weekly reset.',
  )
  expect(notice.told(FLO5)).toBe('your 5% floor is reached. spare10 told the agents to wind down.')
  expect(notice.told([RES5, FLO7])).toBe('your 10% reserve and your 5% weekly floor are reached. spare10 told the agents to wind down.')
  expect(notStarted(FLO5)).toBe(
    'spare10: not started. This session is inside your 5% floor until 14:00. Send the prompt again to be asked again, or run /spare10 resume.',
  )
})

test('the pause instruction at the floor has its own first sentence, with and without user text', () => {
  const head =
    'spare10 budget guard. You have reached the floor of the quota reserve for this session (into your 5% floor · 4% of quota left · resets 14:00). Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.'
  expect(pauseInstruction(FLO5, null)).toBe(head)
  expect(pauseInstruction(FLO5, 'Finish this block, commit, then stop.')).toBe(`${head}\n\nUser instructions: Finish this block, commit, then stop.`)
  // Two kinds at different stages: the floor sentence wins.
  expect(pauseInstruction([RES5, FLO7], null)).toStartWith('spare10 budget guard. You have reached the floor of the quota reserve for this session (')
  // A kind at the reserve keeps the 0.2 sentence.
  expect(pauseInstruction(RES5, null)).toStartWith('spare10 budget guard. You have reached the safe usage limit for this session (')
})

test('the resume note names the end point at the reserve and what is left at the floor', () => {
  expect(resumeContext(RES5)).toBe(
    'spare10: earlier work stopped at the 10% quota reserve. The user now chose to continue on the reserve until 95% used. Follow their message.',
  )
  expect(resumeContext(FLO5)).toBe(
    'spare10: earlier work stopped at the 5% quota floor. The user now chose to continue on the last 4% until 14:00. Follow their message.',
  )
  expect(resumeContext(FLO7)).toBe(
    'spare10: earlier work stopped at the 5% weekly quota floor. The user now chose to continue on the last 4% of the weekly window until Mon 09:00. Follow their message.',
  )
})

test('the resume replies before and past the floor, and while a consent to the floor applies, in both modes', () => {
  expect(resumeReply('tripped', RES5)).toBe('you can use the reserve until 95% used. Until 13:40, spare10 asks you again at 95% used.')
  expect(resumeReply('tripped', FLO5)).toBe('you can use the last 4% until 14:00.')
  expect(resumeReply('tripped', [RES5, RES7])).toBe(
    'you can use both reserves until 95% used. Until its reserve opens, spare10 asks you again at 95% used of either window.',
  )
  expect(resumeReply('stopped', RES5)).toBe(
    'resumed. You can use the reserve until 95% used. Until 13:40, spare10 asks you again at 95% used. Type a prompt to continue.',
  )
  expect(resumeReply('stopped', FLO5)).toBe('resumed. You can use the last 4% until 14:00. Type a prompt to continue.')
  expect(resumeReply('asking', RES5)).toBe('resumed. Held work continues on the reserve until 95% used. Until 13:40, spare10 asks you again at 95% used.')
  expect(resumeReply('asking', FLO5)).toBe('resumed. Held work continues on the last 4% until 14:00.')
  // The tell {verb}.
  expect(resumeReply('tripped', RES5, undefined, undefined, 'tell')).toBe(
    'you can use the reserve until 95% used. Until 13:40, spare10 tells the agents to wind down at 95% used.',
  )
  expect(resumeReply('stopped', RES5, undefined, undefined, 'tell')).toBe(
    'resumed. You can use the reserve until 95% used. Until 13:40, spare10 tells the agents to wind down at 95% used. Type a prompt to continue.',
  )
  expect(resumeReply('asking', RES5, undefined, undefined, 'tell')).toBe(
    'resumed. Held work continues on the reserve until 95% used. Until 13:40, spare10 tells the agents to wind down at 95% used.',
  )
  // The consented forms: the facts of the covering consents (no span: not a question).
  const c5 = NOLEAD(RES5)
  const full7: Facts = { used: 92, left: 8, resetsAtMs: W, reserve: 10, timeZone: TZ, kind: 'seven_day', now: T0, holdEnd: W - S7 }
  expect(resumeReply('consented', c5)).toBe('already resumed until 95% used. Until 13:40, spare10 asks you again at 95% used.')
  expect(resumeReply('consented', [c5, full7])).toBe(
    'already resumed until 95% used, and until Mon 09:00 on the weekly window. Until 13:40, spare10 asks you again at 95% used.',
  )
  expect(resumeReply('consented', [c5, NOLEAD(RES7B)])).toBe(
    'already resumed until 95% used, and until 95% used of the weekly window. Until its reserve opens, spare10 asks you again at 95% used of either window.',
  )
  expect(resumeReply('consented', c5, undefined, undefined, 'tell')).toBe(
    'already resumed until 95% used. Until 13:40, spare10 tells the agents to wind down at 95% used.',
  )
  // A full consent only (a 0.2 value): the 0.2 reply.
  expect(resumeReply('consented', { used: 93, left: 7, resetsAtMs: R, reserve: 10, timeZone: TZ })).toBe('already resumed until 15:00.')
})

test('the status report shows the floor rows: in force in both modes, off, not below the reserve, unattended, and no weekly row when the weekly guard is off', () => {
  expect(statusReport(status02({ spans: SPANS, floors: FLOORS }))).toBe(
    [
      'version 0.3.0',
      '',
      '  ● armed          spare10 steps in at 90% used, or at 90% used of the weekly window.',
      '  · reserve        10% of the 5-hour window (from /config)',
      '  · weekly reserve 10% of the weekly window (from /config)',
      '  · reserve opens  in the last 20 min of the 5-hour window (from /config)',
      '  · weekly opens   in the last 8 h of the weekly window (from /config)',
      '  · resume floor   5%: after a Resume, spare10 asks again at 95% used (from /config)',
      '  · weekly floor   5%: after a Resume, spare10 asks again at 95% used of the weekly window (from /config)',
      '  · at the reserve stop and ask you',
      '  · at the reset   continue by itself (from /config)',
      '  · reading        live · 42% used · 58% left · resets 14:00 (in 2 h 14 min)',
      '  · weekly reading live · 61% used · 39% left · resets Mon 09:00 (in 3 d 21 h)',
      '  · consent        none',
      '  · weekly consent none',
      '  · guarded        yes (scope all)',
      '  · claude -p      runs started here: stop',
      '',
      '/spare10 resume   continue on the reserve until the floor, or past the floor until the reset',
      '/spare10 stop     stop at the reserve now',
    ].join('\n'),
  )
  const rows = (over: Partial<StatusInput>): string[] =>
    statusReport(status02({ spans: SPANS, floors: FLOORS, ...over }))
      .split('\n')
      .filter((l) => l.startsWith('  · resume floor') || l.startsWith('  · weekly floor') || l.startsWith('/spare10 resume'))
  expect(rows({ mode: 'tell', pausePrompt: 'Wrap up.' })).toEqual([
    '  · resume floor   5%: after a Resume, spare10 tells the agents to wind down at 95% used (from /config)',
    '  · weekly floor   5%: after a Resume, spare10 tells the agents to wind down at 95% used of the weekly window (from /config)',
    '/spare10 resume   continue on the reserve until the floor, or past the floor until the reset',
  ])
  expect(rows({ floors: { resumeFloor: 0, resumeFloorFrom: 'env', weeklyResumeFloor: 0, weeklyResumeFloorFrom: 'env' } })).toEqual([
    '  · resume floor   off. A Resume lasts until the reset (from SPARE10_RESUME_FLOOR)',
    '  · weekly floor   off. A Resume lasts until the weekly reset (from SPARE10_WEEKLY_RESUME_FLOOR)',
    '/spare10 resume   continue on the reserve until the window resets',
  ])
  expect(rows({ floors: { resumeFloor: 12, resumeFloorFrom: 'env', weeklyResumeFloor: 10, weeklyResumeFloorFrom: 'option' } })).toEqual([
    '  · resume floor   12% does nothing, because it is not below the reserve (from SPARE10_RESUME_FLOOR)',
    '  · weekly floor   10% does nothing, because it is not below the weekly reserve (from /config)',
    '/spare10 resume   continue on the reserve until the window resets',
  ])
  // One floor in force is enough for the help line.
  expect(rows({ floors: { resumeFloor: 0, resumeFloorFrom: 'option', weeklyResumeFloor: 2.5, weeklyResumeFloorFrom: 'option' } })).toEqual([
    '  · resume floor   off. A Resume lasts until the reset (from /config)',
    '  · weekly floor   2.5%: after a Resume, spare10 asks again at 97.5% used of the weekly window (from /config)',
    '/spare10 resume   continue on the reserve until the floor, or past the floor until the reset',
  ])
  expect(rows({ attended: false, headless: 'stop' })).toEqual([
    '  · resume floor   5%: this run is unattended and never asks, so the floor does nothing (from /config)',
    '  · weekly floor   5%: this run is unattended and never asks, so the floor does nothing (from /config)',
    '/spare10 resume   continue on the reserve until the window resets',
  ])
  expect(rows({ weekly: 'off' })).toEqual([
    '  · resume floor   5%: after a Resume, spare10 asks again at 95% used (from /config)',
    '/spare10 resume   continue on the reserve until the floor, or past the floor until the reset',
  ])
  // A weekly floor in force while the weekly window is not watched does not name the floor.
  expect(rows({ weekly: 'off', floors: { ...FLOORS, resumeFloor: 0 } })).toEqual([
    '  · resume floor   off. A Resume lasts until the reset (from /config)',
    '/spare10 resume   continue on the reserve until the window resets',
  ])
})

test('the consent rows show an end point, and a consent that ended at it', () => {
  const field = (over: Partial<StatusInput>, label: string): string | undefined =>
    statusReport(status02({ floors: FLOORS, ...over }))
      .split('\n')
      .find((l) => l.startsWith(`  · ${label.padEnd(15)}`))
  expect(field({ consentUntil: R14, consentTo: 95 }, 'consent')).toBe('  · consent        until 95% used or 14:00 (you chose to continue)')
  expect(field({ consentTo: 95, consentEnded: true }, 'consent')).toBe('  · consent        ended at 95% used (you chose to continue until then)')
  expect(field({ consentUntil: R14 }, 'consent')).toBe('  · consent        until 14:00 (you chose to continue)')
  const week = { reserve: 10, from: 'option', basis: { kind: 'live', pct: 93, resetsAtMs: W } } as const
  expect(field({ weekly: { ...week, consentUntil: W, consentTo: 95 } }, 'weekly consent')).toBe(
    '  · weekly consent until 95% used or Mon 09:00 (you chose to continue)',
  )
  expect(field({ weekly: { ...week, consentTo: 95, consentEnded: true } }, 'weekly consent')).toBe(
    '  · weekly consent ended at 95% used (you chose to continue until then)',
  )
  expect(field({ weekly: { ...week, consentUntil: W } }, 'weekly consent')).toBe('  · weekly consent until Mon 09:00 (you chose to continue)')
})

test('the consented phase line says until when spare10 asks again', () => {
  const line = (over: Partial<StatusInput>): string | undefined =>
    statusReport(status02({ phase: 'consented', floors: FLOORS, ...over })).split('\n')[2]
  expect(line({ consentUntil: R14, consentTo: 95, consented: [NOLEAD(RES5)] })).toBe(
    '  ⨯ consented      you chose to continue. Until 13:40, spare10 asks you again at 95% used.',
  )
  expect(line({ mode: 'tell', pausePrompt: 'x', consentUntil: R14, consentTo: 95, consented: [NOLEAD(RES5)] })).toBe(
    '  ⨯ consented      you chose to continue. Until 13:40, spare10 tells the agents to wind down at 95% used.',
  )
  // Full consents only: the 0.2 line.
  expect(line({ consentUntil: R14, consented: [{ used: 91, left: 9, resetsAtMs: R14, reserve: 10, timeZone: TZ, holdEnd: R14 - S5 }] })).toBe(
    '  ⨯ consented      you chose to continue. spare10 is quiet until 14:00.',
  )
  expect(line({ consentUntil: R14 })).toBe('  ⨯ consented      you chose to continue. spare10 is quiet until 14:00.')
})

test('the help line names the floor only while a floor is in force', () => {
  const help = (over: Partial<StatusInput>): string | undefined =>
    statusReport(status02(over))
      .split('\n')
      .find((l) => l.startsWith('/spare10 resume'))
  expect(help({})).toBe('/spare10 resume   continue on the reserve until the window resets') // no floors: the 0.2 input
  expect(help({ floors: FLOORS })).toBe('/spare10 resume   continue on the reserve until the floor, or past the floor until the reset')
  expect(help({ floors: FLOORS, attended: false })).toBe('/spare10 resume   continue on the reserve until the window resets')
  expect(help({ floors: { ...FLOORS, resumeFloor: 10, weeklyResumeFloor: 0 } })).toBe('/spare10 resume   continue on the reserve until the window resets')
})

test('the simulate replies: past the floor, raised in place, and the real reading in the reserve', () => {
  const t96: Facts = { ...TEST5, used: 96, left: 4 }
  const opens = { at: '14:02', lead: '20 min before the test window ends' }
  expect(simulateReply('set', t96, opens, 5)).toBe(
    'test reading set to 96% used, resets 14:22. It can only raise the real reading. This is past your 5% floor. The reserve opens at 14:02, 20 min before the test window ends. Run /spare10 simulate off to clear it.',
  )
  expect(simulateReply('raised', t96, opens, 5)).toBe(
    'test reading raised to 96% used, resets 14:22. Your earlier answers stay. It can only raise the real reading. This is past your 5% floor. The reserve opens at 14:02, 20 min before the test window ends. Run /spare10 simulate off to clear it.',
  )
  expect(simulateReply('raised', { ...TEST5, used: 93, left: 7 }, opens)).toBe(
    'test reading raised to 93% used, resets 14:22. Your earlier answers stay. It can only raise the real reading. The reserve opens at 14:02, 20 min before the test window ends. Run /spare10 simulate off to clear it.',
  )
  expect(simulateReply('raised', { ...TEST7, used: 96, left: 4 }, { at: 'Thu 14:02', lead: '8 h before the weekly test window ends' }, 5)).toBe(
    'test reading raised to 96% used of the weekly window, resets Thu 22:02. Your earlier answers stay. It can only raise the real reading. This is past your 5% weekly floor. The weekly reserve opens at Thu 14:02, 8 h before the weekly test window ends. Run /spare10 simulate off to clear it.',
  )
  expect(simulateReply('set', { used: 95, left: 5, resetsAtMs: R, reserve: 10, timeZone: TZ, test: true }, 'real', 5, true)).toBe(
    'test reading set to 95% used, resets 15:00. It can only raise the real reading. This is past your 5% floor. The real reading is also in the reserve, so the test window does not open it. A Resume on the test reading also lets real work use the reserve. Run /spare10 simulate off to clear it.',
  )
  expect(simulateReply('set', { ...TEST7, used: 95, left: 5 }, 'real', undefined, true)).toBe(
    'test reading set to 95% used of the weekly window, resets Thu 22:02. It can only raise the real reading. The real weekly reading is also in the weekly reserve, so the weekly test window does not open it. A Resume on the test reading also lets real work use the weekly reserve. Run /spare10 simulate off to clear it.',
  )
  // Open at once: the caller passes no floor, and the reply is the DS reply.
  expect(simulateReply('set', { ...TEST5, used: 96, left: 4 }, 'now')).toBe(
    'test reading set to 96% used, resets 14:22. It can only raise the real reading. The test window ends within 20 min, so the reserve is open at once. Run /spare10 simulate off to clear it.',
  )
})

test('B27 names 0 to 99 for both floor variables, and the floor warnings name the reserve', () => {
  expect(badWarning('SPARE10_RESUME_FLOOR', 'x', '5')).toBe('SPARE10_RESUME_FLOOR="x" is not 0 to 99. spare10 uses 5.')
  expect(badWarning('SPARE10_WEEKLY_RESUME_FLOOR', '100', '5')).toBe('SPARE10_WEEKLY_RESUME_FLOOR="100" is not 0 to 99. spare10 uses 5.')
  expect(floorWarning('five_hour', 12, 10)).toBe(
    'the resume floor (12%) is not below the reserve (10%), so it does nothing. Set it below the reserve, or to 0.',
  )
  expect(floorWarning('seven_day', 12.5, 10)).toBe(
    'the weekly resume floor (12.5%) is not below the weekly reserve (10%), so it does nothing. Set it below the weekly reserve, or to 0.',
  )
})

/** Every floor text that the engine prefixes: notices, warnings, replies and the report. */
function floorEnginePrefixed(): string[] {
  const lists: Array<Facts | Facts[]> = [RES5, FLO5, RES7, FLO7, [RES5, RES7B], [FLO5, FLO7B], [RES5, FLO7], NOSPAN(RES5)]
  const out: string[] = [
    badWarning('SPARE10_RESUME_FLOOR', 'x', '5'),
    badWarning('SPARE10_WEEKLY_RESUME_FLOOR', 'x', '5'),
    floorWarning('five_hour', 12, 10),
    floorWarning('seven_day', 12, 10),
  ]
  for (const f of lists)
    for (const mode of ['hold', 'tell'] as const) {
      out.push(notice.continuing(f, mode), notice.told(f), notice.stopped(f), notice.holdLimit(f), notice.resetStillHeld(FIVE, Array.isArray(f) ? f : [f]))
      for (const c of ['asking', 'stopped', 'tripped', 'consented'] as const) out.push(resumeReply(c, f, undefined, undefined, mode))
    }
  for (const k of ['set', 'raised'] as const)
    for (const f of [TEST5, TEST7])
      for (const opens of [undefined, 'real', 'now'] as const) for (const past of [undefined, 5]) out.push(simulateReply(k, f, opens, past, past === 5))
  const floors = [FLOORS, { resumeFloor: 0, resumeFloorFrom: 'env', weeklyResumeFloor: 12, weeklyResumeFloorFrom: 'env' }] as const
  for (const fl of floors)
    for (const attended of [true, false])
      for (const mode of ['hold', 'tell'] as const) {
        out.push(
          statusReport(
            status02({
              phase: 'consented',
              mode,
              attended,
              floors: fl,
              consentUntil: R14,
              consentTo: 95,
              consented: [NOLEAD(RES5)],
              weekly: { reserve: 10, from: 'option', basis: { kind: 'live', pct: 96, resetsAtMs: W }, consentTo: 95, consentEnded: true },
            }),
          ),
        )
      }
  return out
}

/** The floor forms of the texts the model reads (floor 2.3). */
function floorModelTexts(): string[] {
  const out: string[] = []
  for (const f of [FLO5, FLO7, [RES5, FLO7], RES5] as Array<Facts | Facts[]>) {
    out.push(stopText(f), pausedText(f), resumeContext(f), notStarted(f), pauseInstruction(f, null), pauseInstruction(f, 'Commit, then stop.'))
  }
  return out
}

/** Every floor text, for the STE guard. */
function floorTexts(): string[] {
  const out: string[] = [...floorEnginePrefixed(), ...floorModelTexts()]
  for (const f of [RES5, FLO5, RES7, FLO7, [RES5, RES7B], [FLO5, FLO7B], [RES5, FLO7], NOSPAN(RES5)] as Array<Facts | Facts[]>)
    for (const auto of [false, true])
      for (const opener of ['loop', 'prompt'] as const)
        for (const mode of ['hold', 'tell'] as const) out.push(questionText(f, opener, mode, auto), asksText(f, mode) || 'no asks')
  for (const to of ['95', '97.5']) for (const t of [false, true]) out.push(badgeView('consented', { reserve: 10, test: t, mode: 'hold', blink: true, to }).text)
  return out
}

test('every floor notice, warning and reply starts without the engine prefix', () => {
  const texts = floorEnginePrefixed()
  expect(texts.length).toBeGreaterThan(100)
  for (const t of texts) {
    expect(t.startsWith('spare10: ')).toBe(false)
    expect(t.startsWith('spare10 ')).toBe(false)
  }
})

// ---- Codex design 2.1: the host inputs of the report and the replies. Claude passes none of them. ----

// A weekly-only plan, as a host reports it: no 5-hour window, a weekly reading.
const WO = (over: Partial<StatusInput> = {}): StatusInput =>
  status({
    basis: { kind: 'none', why: 'no-reading' },
    facts: undefined,
    weekly: { reserve: 10, from: 'option', basis: { kind: 'live', pct: 61, resetsAtMs: W } },
    autoResume: { on: true, from: 'option' },
    absent: ['five_hour'],
    ...over,
  })

test('yourReserves is {Rs}', () => {
  expect(yourReserves([F])).toBe('your 10% reserve')
  expect(yourReserves([F, FW])).toBe('your 10% reserve and your 10% weekly reserve')
})

test('stepsIn with fiveAbsent names only the weekly trip point, or no window', () => {
  expect(stepsIn(10, 10, true)).toBe('spare10 steps in at 90% used of the weekly window.')
  expect(stepsIn(10, 15.5, true)).toBe('spare10 steps in at 84.5% used of the weekly window.')
  expect(stepsIn(10, 0, true)).toBe('spare10 watches no window.')
  expect(stepsIn(10, undefined, true)).toBe('spare10 watches no window.')
  // Without it: the old texts.
  expect(stepsIn(10, 10, false)).toBe('spare10 steps in at 90% used, or at 90% used of the weekly window.')
  expect(stepsIn(10, 10)).toBe('spare10 steps in at 90% used, or at 90% used of the weekly window.')
  expect(stepsIn(10, 0)).toBe('spare10 steps in at 90% used.')
  expect(stepsIn(10)).toBe('spare10 steps in at 90% used.')
})

test('the report of a weekly-only plan names the missing 5-hour window (CX17) and the weekly trip point', () => {
  expect(statusReport(WO()).split('\n')).toEqual([
    'version 0.3.0',
    '',
    '  ● armed          spare10 steps in at 90% used of the weekly window.',
    '  · reserve        10% of the 5-hour window (from /config)',
    '  · weekly reserve 10% of the weekly window (from /config)',
    '  · at the reserve stop and ask you',
    '  · at the reset   continue by itself (from /config)',
    '  · reading        none: Claude Code reports no 5-hour window for this plan',
    '  · weekly reading live · 61% used · 39% left · resets Mon 09:00 (in 3 d 21 h)',
    '  · consent        none',
    '  · weekly consent none',
    '  · guarded        yes (scope all)',
    '  · claude -p      runs started here: stop',
    ...FOOT,
  ])
  // Weekly reserve 0 on the same plan: no window is watched.
  const off = statusReport(WO({ weekly: 'off' })).split('\n')
  expect(off[2]).toBe('  ● armed          spare10 watches no window.')
  expect(off).toContain('  · weekly reserve off. spare10 does not watch the weekly window (from /config)')
  expect(off).toContain('  · reading        none: Claude Code reports no 5-hour window for this plan')
})

test('the report of a plan with no weekly window names it, and the armed line names no weekly trip point', () => {
  const lines = statusReport(status({ weekly: { reserve: 10, from: 'option', basis: { kind: 'none', why: 'no-reading' } }, absent: ['seven_day'] })).split('\n')
  expect(lines[2]).toBe('  ● armed          spare10 steps in at 90% used.')
  expect(lines).toContain('  · weekly reading none: Claude Code reports no weekly window for this plan')
  expect(lines).toContain('  · reading        live · 50% used · 50% left · resets 15:00 (in 3 h 0 min)')
})

test('heldInPlace: the stopped line says that held work waits, in place of the way back', () => {
  expect(statusReport(status({ phase: 'stopped', heldInPlace: true })).split('\n')[2]).toBe(
    '  ■ stopped        you chose Stop here. Held work waits. Run /spare10 resume to continue it now.',
  )
  expect(statusReport(status({ phase: 'stopped', heldInPlace: true, at: { ms: R, kinds: ['five_hour'] }, autoStop: true, work: true })).split('\n')[2]).toBe(
    '  ■ stopped        you chose Stop here. spare10 continues the work after 15:00. Held work waits. Run /spare10 resume to continue it now.',
  )
  expect(statusReport(status({ phase: 'stopped', heldInPlace: false })).split('\n')[2]).toBe(
    '  ■ stopped        you chose Stop here. Type a prompt to be asked again, or run /spare10 resume.',
  )
})

test('extraRows follow the claude -p or unattended row, and extraHelp follows the help lines', () => {
  const extra = { extraRows: [['daemon', 'yes'], ['cli', '/x/bin/spare10']] as const, extraHelp: ['one more line', 'and another'], warnings: ['a warning'] }
  expect(statusReport(status(extra)).split('\n')).toEqual([
    'version 0.3.0',
    '',
    '  ● armed          spare10 steps in at 90% used.',
    '  · reserve        10% of the 5-hour window (from /config)',
    '  · at the reserve stop and ask you',
    '  · reading        live · 50% used · 50% left · resets 15:00 (in 3 h 0 min)',
    '  · consent        none',
    '  · guarded        yes (scope all)',
    '  · claude -p      runs started here: stop',
    '  · daemon         yes',
    '  · cli            /x/bin/spare10',
    '  ⚠ a warning',
    ...FOOT,
    'one more line',
    'and another',
  ])
  const unattended = statusReport(status({ ...extra, attended: false, phase: 'reserve' })).split('\n')
  const at = unattended.indexOf('  · unattended     off (from /config)')
  expect(at).toBeGreaterThan(0)
  expect(unattended.slice(at + 1, at + 3)).toEqual(['  · daemon         yes', '  · cli            /x/bin/spare10'])
})

test('without the host inputs the report is the same as before', () => {
  for (const s of [status(), status({ phase: 'stopped' }), WO({ absent: undefined })]) {
    expect(statusReport({ ...s, absent: [], heldInPlace: false, extraRows: [], extraHelp: [] })).toBe(statusReport(s))
  }
})

test('resumeReply and stopReply with five_hour absent name no 5-hour reading or trip point', () => {
  const five = ['five_hour'] as const
  expect(resumeReply('none', undefined, undefined, undefined, 'hold', five)).toBe('nothing to resume. There is no reading yet.')
  expect(resumeReply('below', undefined, undefined, undefined, 'hold', five)).toBe('nothing to resume. There is no reading yet.')
  expect(resumeReply('below', FW, undefined, undefined, 'hold', five)).toBe(`nothing to resume. ${personFacts(FW)}.`)
  expect(stopReply('none', undefined, 90, undefined, 90, undefined, five)).toBe('nothing to stop. spare10 steps in at 90% used of the weekly window.')
  expect(stopReply('below', FW, 90, undefined, 84.5, undefined, five)).toBe('nothing to stop. spare10 steps in at 84.5% used of the weekly window.')
  expect(stopReply('none', undefined, 90, undefined, undefined, undefined, five)).toBe('nothing to stop. spare10 watches no window.')
  // Without five_hour absent: the old texts.
  for (const absent of [undefined, [] as Kind[], ['seven_day'] as Kind[]]) {
    expect(resumeReply('none', undefined, undefined, undefined, 'hold', absent)).toBe('nothing to resume. There is no 5-hour reading yet.')
    expect(stopReply('none', undefined, 90, undefined, 90, undefined, absent)).toBe('nothing to stop. spare10 steps in at 90% used, or at 90% used of the weekly window.')
    expect(stopReply('below', F, 90, undefined, undefined, undefined, absent)).toBe('nothing to stop. spare10 steps in at 90% used.')
  }
})
