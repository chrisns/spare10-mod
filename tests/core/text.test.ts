import { test, expect } from 'claude-code/testing'
import {
  ARGUMENT_HINT,
  COMMAND_DESCRIPTION,
  HEADER,
  NOT_STARTED_GENERIC,
  QUESTION_OPTIONS,
  RESUME_LABEL,
  STOP_GENERIC,
  VERSION,
  W_FLAG,
  badWarning,
  bgEnvWarning,
  commandFailed,
  consentWarning,
  debugLine,
  factsOf,
  fmtDuration,
  fmtPct,
  formatClock,
  headlessText,
  modelFacts,
  notPerson,
  notStarted,
  notice,
  pauseInstruction,
  pausedText,
  personFacts,
  questionText,
  resumeContext,
  resumeReply,
  simulateReply,
  statusReport,
  stopReply,
  stopText,
  timeoutWarning,
  unknownVerb,
  untilText,
  withdrawnText,
} from '../../hooks/core/text.ts'
import type { Facts, ReplyCase, StatusInput } from '../../hooks/core/text.ts'
import { badgeView } from '../../hooks/core/badge.ts'
import type { Phase } from '../../hooks/core/decide.ts'
import type { Basis } from '../../hooks/core/reading.ts'

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
  expect(VERSION).toBe('0.1.0')
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
  expect(badWarning('SPARE10_HEADLESS', 'x', 'off')).toBe('SPARE10_HEADLESS="x" is not off, prompt or stop. spare10 uses off.')
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
  expect(simulateReply('bad')).toBe('/spare10 simulate takes a percentage from 0 to 100, or off.')
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
    'version 0.1.0',
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
  const phases: Phase[] = ['off', 'blind', 'waiting', 'armed', 'consented', 'stopped', 'asking', 'told', 'reserve', 'tripped']
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
  return out
}

test('no transcript line, warning or command reply starts with the prefix that the engine adds', () => {
  const texts = enginePrefixed()
  expect(texts.length).toBeGreaterThan(40)
  for (const t of texts) {
    expect(t.startsWith('spare10: ')).toBe(false)
    expect(t.startsWith('spare10 ')).toBe(false) // the report header too: it renders as `spare10: version 0.1.0`
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
  const phases: Phase[] = ['off', 'blind', 'waiting', 'armed', 'consented', 'stopped', 'asking', 'told', 'reserve', 'tripped']
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
  return out
}

test('no user-facing string has an em-dash or a semicolon', () => {
  const texts = everyText()
  expect(texts.length).toBeGreaterThan(400)
  for (const t of texts) {
    expect(t.length).toBeGreaterThan(0)
    expect(t).not.toContain('\u2014') // em-dash
    expect(t).not.toContain('\u2013') // en-dash
    expect(t).not.toContain(';')
  }
})
