import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOST } from '../../hooks/core/host.ts'
import {
  NOT_STARTED_GENERIC,
  STOP_GENERIC,
  W_FLAG,
  badWarning,
  commandFailed,
  consentWarning,
  debugLine,
  floorWarning,
  headlessText,
  notPerson,
  notStarted,
  notice,
  pauseInstruction,
  pausedText,
  questionText,
  resetContext,
  resumeContext,
  resumePrompt,
  resumeReply,
  simulateReply,
  statusReport,
  stepsIn,
  stopReply,
  stopText,
  timeoutWarning,
  unknownVerb,
} from '../../hooks/core/text.ts'
import type { Facts, Named, StatusInput } from '../../hooks/core/text.ts'
import { codexDebug, codexText, withPrefix } from '../../hooks/core/codex.ts'
import type { Kind } from '../../hooks/core/reading.ts'

// The texts under the Codex host words (Codex design 2.1, 2.4 to 2.9, 8.2 text.spec). The host loader maps
// hooks/core/host.ts to codex/src/host.ts, as the bundle does. The golden list pins the same cases as
// tests/core/host.test.ts, which pins them under the Claude words.

const TZ = 'UTC'
const T0 = Date.parse('2026-09-24T12:00:00Z')
const R = Date.parse('2026-09-24T15:00:00.000Z') // 3 h after T0
const W = Date.parse('2026-09-27T15:00:00.000Z') // the weekly reset
const MIN = 60_000

const F: Facts = { used: 92, left: 8, resetsAtMs: R, reserve: 10, timeZone: TZ }
const FW: Facts = { used: 93, left: 7, resetsAtMs: W, reserve: 10, timeZone: TZ, kind: 'seven_day', now: T0 }
const LEAD: Facts = { ...F, span: 20 * MIN } // a skip owner: its question names {lead}
const FIVE: Named[] = [{ kind: 'five_hour', test: false }]

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

// Every optional row, each from its option: the weekly window, the reset row, both spans and both floors.
const full = (over: Partial<StatusInput> = {}): StatusInput =>
  status({
    weekly: { reserve: 10, from: 'option', basis: { kind: 'live', pct: 61, resetsAtMs: W } },
    autoResume: { on: true, from: 'option' },
    spans: { lastMinutes: 20, lastMinutesFrom: 'option', weeklyLastHours: 8, weeklyLastHoursFrom: 'option' },
    floors: { resumeFloor: 5, resumeFloorFrom: 'option', weeklyResumeFloor: 5, weeklyResumeFloorFrom: 'option' },
    ...over,
  })

const GOLDEN: ReadonlyArray<readonly [string, () => string, string]> = [
  ['NOT_STARTED_GENERIC', () => NOT_STARTED_GENERIC, 'spare10: not started. spare10 could not ask you. Send the prompt again, or run spare10 resume.'],
  ['notStarted, one window', () => notStarted(F), 'spare10: not started. This session is inside your 10% reserve until 15:00. Send the prompt again to be asked again, or run spare10 resume.'],
  ['notStarted, both windows', () => notStarted([F, FW]), 'spare10: not started. This session is inside your 10% reserve and your 10% weekly reserve until they reset (15:00 and Sun 15:00). Send the prompt again to be asked again, or run spare10 resume.'],
  ['headlessText', () => headlessText(F, 'S1'), 'spare10 stopped this unattended run at the quota reserve (into your 10% reserve · 8% of quota left · resets 15:00). No further model requests were sent. To pick it up later: codex exec resume S1'],
  ['questionText, prompt opener, tell mode, auto', () => questionText(F, 'prompt', 'tell', true), 'Your 10% reserve is reached: 92% used · 8% left · resets 15:00. spare10 holds your prompt. Continue on the reserve until 15:00? If you do not answer, your prompt goes in after 15:00, unless a reserve is still reached. Stop here drops it.'],
  ['questionText, prompt opener, hold mode, auto', () => questionText(F, 'prompt', 'hold', true), 'Your 10% reserve is reached: 92% used · 8% left · resets 15:00. spare10 holds your prompt and any other work. Continue on the reserve until 15:00? If you do not answer, all of it continues after 15:00, unless a reserve is still reached. Stop here drops your prompt and pauses other work until 15:00.'],
  ['questionText, prompt opener, tell mode, auto, a skip owner', () => questionText(LEAD, 'prompt', 'tell', true), 'Your 10% reserve is reached: 92% used · 8% left · resets 15:00. spare10 holds your prompt. Continue on the reserve until 15:00? If you do not answer, your prompt goes in at 14:40, 20 min before the reset, unless a reserve is still reached. Stop here drops it.'],
  ['questionText, prompt opener, hold mode, auto, a skip owner', () => questionText(LEAD, 'prompt', 'hold', true), 'Your 10% reserve is reached: 92% used · 8% left · resets 15:00. spare10 holds your prompt and any other work. Continue on the reserve until 15:00? If you do not answer, all of it continues at 14:40, 20 min before the reset, unless a reserve is still reached. Stop here drops your prompt and pauses other work until 14:40.'],
  ['questionText, loop opener, hold mode, auto', () => questionText(F, 'loop', 'hold', true), 'Your 10% reserve is reached: 92% used · 8% left · resets 15:00. All work is on hold. Continue on the reserve until 15:00? If you choose Stop here or do not answer, the work waits until 15:00. Then spare10 continues it, unless a reserve is still reached.'],
  ['resumePrompt at the reset (RESUME_TAIL)', () => resumePrompt(FIVE), 'The 5-hour window reset, so the stop at the quota reserve is over. spare10 is set to continue the work at the reset, so do not wait for the user. Continue the task from the point where it stopped. A subagent that was interrupted, or whose result says "spare10: work stopped", did not finish. Run it again if you still need its result.'],
  ['resumePrompt when the reserve opens (RESUME_TAIL)', () => resumePrompt([], [LEAD]), 'The 5-hour window resets at 15:00. Your 10% reserve is open until then, so the stop at the quota reserve is over. spare10 is set to continue the work when the reserve opens, so do not wait for the user. Continue the task from the point where it stopped. A subagent that was interrupted, or whose result says "spare10: work stopped", did not finish. Run it again if you still need its result.'],
  ['notice.stopped', () => notice.stopped(F), 'stopped at your 10% reserve. Type a prompt to be asked again, or run spare10 resume.'],
  ['notice.stopped until a time', () => notice.stopped(F, { at: '15:05', work: false }), 'stopped at your 10% reserve until 15:05. Type a prompt to be asked again, or run spare10 resume.'],
  ['notice.stopped until a time, with work', () => notice.stopped(F, { at: '15:05', work: true }), 'stopped at your 10% reserve until 15:05. Then spare10 continues the work, unless a reserve is still reached. Type a prompt to be asked again, or run spare10 resume.'],
  ['notice.holdLimit', () => notice.holdLimit(F), 'the hold reached its time limit. The work is stopped at your 10% reserve. Type a prompt to be asked again, or run spare10 resume.'],
  ['notice.holdLimit until a time', () => notice.holdLimit(F, { at: '15:05', work: false }), 'the hold reached its time limit. The work is stopped at your 10% reserve until 15:05. Type a prompt to be asked again, or run spare10 resume.'],
  ['notice.holdLimit until a time, with work', () => notice.holdLimit(F, { at: '15:05', work: true }), 'the hold reached its time limit. The work is stopped at your 10% reserve until 15:05. Then spare10 continues it, unless a reserve is still reached.'],
  ['stopReply tripped', () => stopReply('tripped', F, 90), 'stopped at the reserve. Type a prompt to be asked again, or run spare10 resume.'],
  ['stopReply tripped until a time', () => stopReply('tripped', F, 90, { at: '15:05' }), 'stopped at the reserve until 15:05. Then spare10 continues any stopped work. Type a prompt to be asked again, or run spare10 resume.'],
  ['stopReply tripped until a time, no continue', () => stopReply('tripped', F, 90, { at: '15:05', continues: false }), 'stopped at the reserve until 15:05. Type a prompt to be asked again, or run spare10 resume.'],
  ['stopReply open', () => stopReply('open', [LEAD]), 'nothing to stop. The reset is near, so your 10% reserve is open until 15:00. To keep a reserve until the reset, run spare10 set lastMinutes 0, or spare10 set weeklyLastHours 0.'],
  ['notPerson', () => notPerson('stop'), 'only you can run spare10 stop. Nothing changed.'],
  ['unknownVerb', () => unknownVerb('pause'), 'unknown command "pause". Use spare10, spare10 resume or spare10 stop.'],
  ['simulateReply bad', () => simulateReply('bad'), 'simulate takes a percentage from 0 to 100, or off. Add weekly for the weekly window, and in 22m for a test window that resets in 22 minutes.'],
  ['simulateReply set', () => simulateReply('set', F), 'test reading set to 92% used, resets 15:00. It can only raise the real reading. Run spare10 simulate off to clear it.'],
  ['simulateReply raised', () => simulateReply('raised', F), 'test reading raised to 92% used, resets 15:00. Your earlier answers stay. It can only raise the real reading. Run spare10 simulate off to clear it.'],
  ['commandFailed', () => commandFailed('boom'), 'the command failed: boom'],
  ['report: armed, the claude -p row and both help lines', () => statusReport(status()), [
      'version 0.3.0',
      '',
      '  ● armed          spare10 steps in at 90% used.',
      '  · reserve        10% of the 5-hour window (from spare10 set)',
      '  · at the reserve stop and ask you',
      '  · reading        live · 50% used · 50% left · resets 15:00 (in 3 h 0 min)',
      '  · consent        none',
      '  · guarded        yes (scope all)',
      '  · codex exec     runs started here: stop',
      '',
      'spare10 resume    continue on the reserve until the window resets',
      'spare10 stop      stop at the reserve now',
    ].join('\n')],
  ['report: every row from its option, and the floor help line', () => statusReport(full()), [
      'version 0.3.0',
      '',
      '  ● armed          spare10 steps in at 90% used, or at 90% used of the weekly window.',
      '  · reserve        10% of the 5-hour window (from spare10 set)',
      '  · weekly reserve 10% of the weekly window (from spare10 set)',
      '  · reserve opens  in the last 20 min of the 5-hour window (from spare10 set)',
      '  · weekly opens   in the last 8 h of the weekly window (from spare10 set)',
      '  · resume floor   5%: after a Resume, spare10 asks again at 95% used (from spare10 set)',
      '  · weekly floor   5%: after a Resume, spare10 asks again at 95% used of the weekly window (from spare10 set)',
      '  · at the reserve stop and ask you',
      '  · at the reset   continue by itself (from spare10 set)',
      '  · reading        live · 50% used · 50% left · resets 15:00 (in 3 h 0 min)',
      '  · weekly reading live · 61% used · 39% left · resets Sun 15:00 (in 3 d 3 h)',
      '  · consent        none',
      '  · weekly consent none',
      '  · guarded        yes (scope all)',
      '  · codex exec     runs started here: stop',
      '',
      'spare10 resume    continue on the reserve until the floor, or past the floor until the reset',
      'spare10 stop      stop at the reserve now',
    ].join('\n')],
  ['report: the unattended row', () => statusReport(full({ attended: false, phase: 'reserve', headless: 'stop' })), [
      'version 0.3.0',
      '',
      '  ⚠ tripped        unattended run, policy stop.',
      '  · reserve        10% of the 5-hour window (from spare10 set)',
      '  · weekly reserve 10% of the weekly window (from spare10 set)',
      '  · reserve opens  in the last 20 min of the 5-hour window (from spare10 set)',
      '  · weekly opens   in the last 8 h of the weekly window (from spare10 set)',
      '  · resume floor   5%: this run is unattended and never asks, so the floor does nothing (from spare10 set)',
      '  · weekly floor   5%: this run is unattended and never asks, so the floor does nothing (from spare10 set)',
      '  · at the reserve unattended policy stop',
      '  · reading        live · 50% used · 50% left · resets 15:00 (in 3 h 0 min)',
      '  · weekly reading live · 61% used · 39% left · resets Sun 15:00 (in 3 d 3 h)',
      '  · consent        none',
      '  · weekly consent none',
      '  · guarded        no: this session is unattended.',
      '  · unattended     stop (from spare10 set)',
      '',
      'spare10 resume    continue on the reserve until the window resets',
      'spare10 stop      stop at the reserve now',
    ].join('\n')],
  ['report: spans the env could not read', () => statusReport(full({ spans: { lastMinutes: 0, lastMinutesFrom: 'unread', weeklyLastHours: 0, weeklyLastHoursFrom: 'unread' } })), [
      'version 0.3.0',
      '',
      '  ● armed          spare10 steps in at 90% used, or at 90% used of the weekly window.',
      '  · reserve        10% of the 5-hour window (from spare10 set)',
      '  · weekly reserve 10% of the weekly window (from spare10 set)',
      '  · reserve opens  only at the reset (spare10 could not read config.json)',
      '  · weekly opens   only at the reset (spare10 could not read config.json)',
      '  · resume floor   5%: after a Resume, spare10 asks again at 95% used (from spare10 set)',
      '  · weekly floor   5%: after a Resume, spare10 asks again at 95% used of the weekly window (from spare10 set)',
      '  · at the reserve stop and ask you',
      '  · at the reset   continue by itself (from spare10 set)',
      '  · reading        live · 50% used · 50% left · resets 15:00 (in 3 h 0 min)',
      '  · weekly reading live · 61% used · 39% left · resets Sun 15:00 (in 3 d 3 h)',
      '  · consent        none',
      '  · weekly consent none',
      '  · guarded        yes (scope all)',
      '  · codex exec     runs started here: stop',
      '',
      'spare10 resume    continue on the reserve until the floor, or past the floor until the reset',
      'spare10 stop      stop at the reserve now',
    ].join('\n')],
  ['report: weekly off', () => statusReport(status({ weekly: 'off' })), [
      'version 0.3.0',
      '',
      '  ● armed          spare10 steps in at 90% used.',
      '  · reserve        10% of the 5-hour window (from spare10 set)',
      '  · weekly reserve off. spare10 does not watch the weekly window (from spare10 set)',
      '  · at the reserve stop and ask you',
      '  · reading        live · 50% used · 50% left · resets 15:00 (in 3 h 0 min)',
      '  · consent        none',
      '  · guarded        yes (scope all)',
      '  · codex exec     runs started here: stop',
      '',
      'spare10 resume    continue on the reserve until the window resets',
      'spare10 stop      stop at the reserve now',
    ].join('\n')],
  ['report: the asking phase', () => statusReport(status({ phase: 'asking' })), [
      'version 0.3.0',
      '',
      '  ? asking         a question is open. Held work waits until you answer. If no form shows, run !spare10 resume or !spare10 stop.',
      '  · reserve        10% of the 5-hour window (from spare10 set)',
      '  · at the reserve stop and ask you',
      '  · reading        live · 50% used · 50% left · resets 15:00 (in 3 h 0 min)',
      '  · consent        none',
      '  · guarded        yes (scope all)',
      '  · codex exec     runs started here: stop',
      '',
      'spare10 resume    continue on the reserve until the window resets',
      'spare10 stop      stop at the reserve now',
    ].join('\n')],
  ['report: the asking phase with a continue time', () => statusReport(full({ phase: 'asking', at: { ms: R, kinds: ['five_hour'] } })), [
      'version 0.3.0',
      '',
      '  ? asking         a question is open. Held work waits until you answer, or until 15:00. If no form shows, run !spare10 resume or !spare10 stop.',
      '  · reserve        10% of the 5-hour window (from spare10 set)',
      '  · weekly reserve 10% of the weekly window (from spare10 set)',
      '  · reserve opens  in the last 20 min of the 5-hour window (from spare10 set)',
      '  · weekly opens   in the last 8 h of the weekly window (from spare10 set)',
      '  · resume floor   5%: after a Resume, spare10 asks again at 95% used (from spare10 set)',
      '  · weekly floor   5%: after a Resume, spare10 asks again at 95% used of the weekly window (from spare10 set)',
      '  · at the reserve stop and ask you',
      '  · at the reset   continue by itself (from spare10 set)',
      '  · reading        live · 50% used · 50% left · resets 15:00 (in 3 h 0 min)',
      '  · weekly reading live · 61% used · 39% left · resets Sun 15:00 (in 3 d 3 h)',
      '  · consent        none',
      '  · weekly consent none',
      '  · guarded        yes (scope all)',
      '  · codex exec     runs started here: stop',
      '',
      'spare10 resume    continue on the reserve until the floor, or past the floor until the reset',
      'spare10 stop      stop at the reserve now',
    ].join('\n')],
  ['report: the stopped phase', () => statusReport(status({ phase: 'stopped' })), [
      'version 0.3.0',
      '',
      '  ■ stopped        you chose Stop here. Type a prompt to be asked again, or run spare10 resume.',
      '  · reserve        10% of the 5-hour window (from spare10 set)',
      '  · at the reserve stop and ask you',
      '  · reading        live · 50% used · 50% left · resets 15:00 (in 3 h 0 min)',
      '  · consent        none',
      '  · guarded        yes (scope all)',
      '  · codex exec     runs started here: stop',
      '',
      'spare10 resume    continue on the reserve until the window resets',
      'spare10 stop      stop at the reserve now',
    ].join('\n')],
  ['report: the stopped phase with a continue time', () => statusReport(full({ phase: 'stopped', at: { ms: R, kinds: ['five_hour'] }, autoStop: true, work: true })), [
      'version 0.3.0',
      '',
      '  ■ stopped        you chose Stop here. spare10 continues the work after 15:00. Type a prompt to be asked again, or run spare10 resume.',
      '  · reserve        10% of the 5-hour window (from spare10 set)',
      '  · weekly reserve 10% of the weekly window (from spare10 set)',
      '  · reserve opens  in the last 20 min of the 5-hour window (from spare10 set)',
      '  · weekly opens   in the last 8 h of the weekly window (from spare10 set)',
      '  · resume floor   5%: after a Resume, spare10 asks again at 95% used (from spare10 set)',
      '  · weekly floor   5%: after a Resume, spare10 asks again at 95% used of the weekly window (from spare10 set)',
      '  · at the reserve stop and ask you',
      '  · at the reset   continue by itself (from spare10 set)',
      '  · reading        live · 50% used · 50% left · resets 15:00 (in 3 h 0 min)',
      '  · weekly reading live · 61% used · 39% left · resets Sun 15:00 (in 3 d 3 h)',
      '  · consent        none',
      '  · weekly consent none',
      '  · guarded        yes (scope all)',
      '  · codex exec     runs started here: stop',
      '',
      'spare10 resume    continue on the reserve until the floor, or past the floor until the reset',
      'spare10 stop      stop at the reserve now',
    ].join('\n')],
  ['report: the blind phase and reading', () => statusReport(status({ phase: 'blind', basis: { kind: 'none', why: 'blind' }, facts: undefined })), [
      'version 0.3.0',
      '',
      '  ⚠ blind          Codex reports no quota windows for this login. spare10 lets all work through.',
      '  · reserve        10% of the 5-hour window (from spare10 set)',
      '  · at the reserve stop and ask you',
      '  · reading        none: Codex reports no quota (blind)',
      '  · consent        none',
      '  · guarded        yes (scope all)',
      '  · codex exec     runs started here: stop',
      '',
      'spare10 resume    continue on the reserve until the window resets',
      'spare10 stop      stop at the reserve now',
    ].join('\n')],
  ['report: scope opt-in', () => statusReport(status({ phase: 'off', enabled: false, scope: 'opt-in' })), [
      'version 0.3.0',
      '',
      '  ○ off            spare10 only watches in this run.',
      '  · reserve        10% of the 5-hour window (from spare10 set)',
      '  · at the reserve stop and ask you',
      '  · reading        live · 50% used · 50% left · resets 15:00 (in 3 h 0 min)',
      '  · consent        none',
      '  · guarded        no: scope opt-in. Run codex --no-daemon with SPARE10=on to guard a run.',
      '  · codex exec     runs started here: stop',
      '',
      'spare10 resume    continue on the reserve until the window resets',
      'spare10 stop      stop at the reserve now',
    ].join('\n')],
]

test('HOST has the Codex words under the host loader', () => {
  assert.deepEqual(HOST, {
    name: 'Codex',
    command: 'spare10',
    anytime: '!spare10',
    config: 'spare10 set',
    child: 'codex exec',
    resume: 'codex exec resume',
    keepOpen: 'run spare10 set lastMinutes 0, or spare10 set weeklyLastHours 0',
    backIt: 'drops it',
    backPrompt: 'drops your prompt',
    blind: 'Codex reports no quota windows for this login.',
    leadSimulate: 'simulate',
    leadFailed: 'the command',
    stoppedAgent: 'A subagent that was interrupted, or whose result says "spare10: work stopped", did not finish.',
    dialog: 'form',
    optIn: 'Run codex --no-daemon with SPARE10=on to guard a run.',
    unreadSource: 'config.json',
  })
  assert.ok(HOST.child.length <= 15)
})

for (const [name, got, want] of GOLDEN) {
  test(`${name} carries the Codex words`, () => {
    assert.equal(got(), want)
  })
}

// ---- The additions of 2.1 under the Codex words ----

test('the texts of 2.1 name Codex, spare10 and !spare10', () => {
  assert.ok(notStarted(F).endsWith('or run spare10 resume.'))
  assert.ok(NOT_STARTED_GENERIC.endsWith('or run spare10 resume.'))
  const asking = statusReport(status({ phase: 'asking' })).split('\n')[2] ?? ''
  assert.ok(asking.includes('If no form shows, run !spare10 resume or !spare10 stop.'), asking)
  const report = statusReport(full())
  assert.ok(report.includes('(from spare10 set)'))
  assert.ok(report.includes('  · codex exec     runs started here: stop'))
  assert.ok(!report.includes('/spare10') && !report.includes('/config') && !report.includes('claude'))
  assert.equal(stepsIn(10, 10, true), 'spare10 steps in at 90% used of the weekly window.')
  assert.equal(
    statusReport(status({ phase: 'stopped', heldInPlace: true })).split('\n')[2],
    '  ■ stopped        you chose Stop here. Held work waits. Run !spare10 resume to continue it now.',
  )
  assert.equal(resumeReply('none', undefined, undefined, undefined, 'hold', ['five_hour']), 'nothing to resume. There is no reading yet.')
})

test('the prompt question on Codex differs from Claude only in the host words (2.2)', () => {
  const q = questionText({ ...F, span: 20 * MIN }, 'prompt', 'hold', true)
  assert.ok(q.endsWith('If you do not answer, all of it continues at 14:40, 20 min before the reset, unless a reserve is still reached. Stop here drops your prompt and pauses other work until 14:40.'), q)
  assert.ok(questionText(F, 'prompt', 'tell', true).endsWith('Stop here drops it.'))
})

// ---- The Codex report of 2.8: an attended session on a weekly-only plan, hosted by the daemon ----

const W2 = Date.parse('2026-09-29T15:52:00.000Z') // Tue 15:52
const NOW2 = W2 - (3 * 24 * 60 + 21 * 60 + 30) * MIN // 3 d 21 h 30 min before it
const CLI = '/Users/me/.codex/plugins/data/spare10-spare10/bin/spare10'

const SAMPLE: StatusInput = {
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
  basis: { kind: 'none', why: 'no-reading' },
  now: NOW2,
  toldCount: 0,
  warnings: [codexText.weeklyOnlyOpen(8)],
  timeZone: TZ,
  weekly: { reserve: 10, from: 'option', basis: { kind: 'live', pct: 61, resetsAtMs: W2 } },
  autoResume: { on: true, from: 'option' },
  spans: { lastMinutes: 20, lastMinutesFrom: 'option', weeklyLastHours: 8, weeklyLastHoursFrom: 'option' },
  floors: { resumeFloor: 5, resumeFloorFrom: 'option', weeklyResumeFloor: 5, weeklyResumeFloorFrom: 'option' },
  absent: ['five_hour'],
  extraRows: [
    ['daemon', codexText.daemonRow(true, true)],
    ['live read', codexText.liveRow({ agoMs: 20_000 })],
    ['cli', CLI],
  ],
  extraHelp: [codexText.helpSet, codexText.helpAnytime],
}

test('the Codex report equals the sample of 2.8', () => {
  assert.equal(
    `spare10: ${statusReport(SAMPLE)}`,
    [
      'spare10: version 0.3.0',
      '',
      '  ● armed          spare10 steps in at 90% used of the weekly window.',
      '  · reserve        10% of the 5-hour window (from spare10 set)',
      '  · weekly reserve 10% of the weekly window (from spare10 set)',
      '  · reserve opens  in the last 20 min of the 5-hour window (from spare10 set)',
      '  · weekly opens   in the last 8 h of the weekly window (from spare10 set)',
      '  · resume floor   5%: after a Resume, spare10 asks again at 95% used (from spare10 set)',
      '  · weekly floor   5%: after a Resume, spare10 asks again at 95% used of the weekly window (from spare10 set)',
      '  · at the reserve stop and ask you',
      '  · at the reset   continue by itself (from spare10 set)',
      '  · reading        none: Codex reports no 5-hour window for this plan',
      '  · weekly reading live · 61% used · 39% left · resets Tue 15:52 (in 3 d 21 h)',
      '  · consent        none',
      '  · weekly consent none',
      '  · guarded        yes (scope all)',
      '  · codex exec     runs started here: stop',
      '  · daemon         yes. spare10 can end a turn and start one.',
      '  · live read      from the Codex daemon, under 1 min ago',
      `  · cli            ${CLI}`,
      '  ⚠ Codex reports only a weekly window here. In the last 8 h before the weekly reset, spare10 lets all work through. To keep the weekly reserve until the reset, run spare10 set weeklyLastHours 0.',
      '',
      'spare10 resume    continue on the reserve until the floor, or past the floor until the reset',
      'spare10 stop      stop at the reserve now',
      'spare10 set       change an option, such as spare10 set reserve 15',
      '!spare10 status   run a command during a turn (see spare10 help)',
    ].join('\n'),
  )
})

// ---- The texts of CX1 to CX47 ----

const L = '/Users/me/.codex/plugins/data/spare10-spare10/bin/spare10'
const D = '/Users/me/.codex/plugins/data/spare10-spare10/bin'
const CFG = '/Users/me/.codex/plugins/data/spare10-spare10/config.json'

test('the CX texts read as in the design', () => {
  assert.equal(codexText.statusHold, 'spare10 checks the quota reserve. Esc stops a held step.')
  assert.equal(codexText.statusStart, 'spare10 reads the quota.')
  assert.equal(codexText.turnEnds, 'spare10: the turn ends here, because work stopped at the quota reserve.')
  assert.equal(codexText.turnEndsHold, 'spare10: the turn ends here, because the quota reserve is reached. spare10 asks at your next prompt.')
  assert.equal(codexText.steerNote, 'spare10: the last user line was a command for the spare10 plugin, and spare10 handled it. Ignore that line.')
  assert.equal(
    codexText.interruptedNote,
    'spare10: the note that the user interrupted the previous turn is not right. spare10 interrupted it at the quota reserve.',
  )
  assert.equal(
    codexText.notStartedNoDialog(F),
    'spare10: not started. This session is inside your 10% reserve until 15:00, and Codex cannot show the spare10 question here. Run spare10 resume, then send the prompt again.',
  )
  assert.equal(
    codexText.notStartedNoDialog([FW, F]),
    'spare10: not started. This session is inside your 10% reserve and your 10% weekly reserve until they reset (15:00 and Sun 15:00), and Codex cannot show the spare10 question here. Run spare10 resume, then send the prompt again.',
  )
  assert.equal(
    codexText.configBad(CFG, 'reserve', 150, '1 to 99', '10'),
    `${CFG} sets reserve to 150, which is not 1 to 99. spare10 uses 10.`,
  )
  assert.equal(
    codexText.configUnread(CFG, 'Unexpected token } in JSON at position 12'),
    `cannot read ${CFG} (Unexpected token } in JSON at position 12). spare10 uses the default options, and keeps each reserve until the reset.`,
  )
  assert.equal(
    codexText.daemonEnv([['SPARE10', 'off'], ['SPARE10_RESERVE', '15']]),
    'this session runs on the Codex daemon, which has SPARE10="off", SPARE10_RESERVE="15". A daemon session gets such values from the environment of the daemon when it started, not from your terminal. To change them, restart the Codex daemon, or run codex --no-daemon.',
  )
  assert.equal(
    codexText.originator('gap7-remote-client'),
    'this session was started by gap7-remote-client, not by the Codex TUI. spare10 treats it as attended. If gap7-remote-client cannot show the spare10 question, spare10 holds the work at the reserve.',
  )
  assert.equal(
    codexText.cliHint(L, D),
    `to run a spare10 command during a turn, type !${L} status in the prompt. For the short form !spare10 status, add export PATH="${D}:$PATH" to ~/.zshrc or ~/.bashrc, then start a new Codex session.`,
  )
  assert.equal(codexText.weeklyOnlyOpen(8), 'Codex reports only a weekly window here. In the last 8 h before the weekly reset, spare10 lets all work through. To keep the weekly reserve until the reset, run spare10 set weeklyLastHours 0.')
  assert.equal(codexText.weeklyOnlyOpen(2.5).includes('In the last 2.5 h before'), true)
  assert.equal(codexText.credits('497'), 'past 100% used, Codex spends your credits. The balance is 497.')
  assert.equal(codexText.creditsQuestion('497'), 'Past 100% used, Codex spends your credits. The balance is 497.')
  assert.equal(codexText.workspaceLimit('workspace_owner_credits_depleted'), 'Codex reports a workspace limit (workspace_owner_credits_depleted). spare10 continues no work until Codex allows it.')
  assert.equal(codexText.daemonRow(true, false), 'yes. spare10 can end a turn and start one.')
  assert.equal(codexText.daemonRow(false, true), 'no. After Stop here, spare10 holds the work in place.')
  assert.equal(codexText.daemonRow(false, false), 'no. After Stop here, each running loop gets one more model request.')
  assert.equal(codexText.daemonReach(true), 'reachable')
  assert.equal(codexText.daemonReach(false), 'not found')
  assert.equal(codexText.brokerRow(true), 'running')
  assert.equal(codexText.brokerRow(false), 'not running: spare10 does not guard this session now.')
  assert.equal(codexText.liveRow({ agoMs: 20_000 }), 'from the Codex daemon, under 1 min ago')
  assert.equal(codexText.liveRow({ agoMs: 134 * MIN, error: 'ignored' }), 'from the Codex daemon, 2 h 14 min ago')
  assert.equal(codexText.liveRow({ error: 'no socket' }), 'none: no socket')
  assert.equal(codexText.liveRow({}), 'none yet')
  assert.equal(codexText.helpSet, 'spare10 set       change an option, such as spare10 set reserve 15')
  assert.equal(codexText.helpAnytime, '!spare10 status   run a command during a turn (see spare10 help)')
  assert.equal(codexText.setOk('reserve', '15', '10'), 'reserve is now 15. It was 10. It applies from the next step.')
  assert.equal(codexText.setDefault('reserve', '10'), 'reserve is back to its default, 10. It applies from the next step.')
  assert.equal(
    codexText.setOk('reserve', '15', '10') + codexText.setEnvWins('SPARE10_RESERVE'),
    'reserve is now 15. It was 10. It applies from the next step. SPARE10_RESERVE is set here, and it wins over the option. On the Codex daemon, restart the daemon to clear it.',
  )
  assert.equal(codexText.setBad('reserve', '1 to 99'), 'reserve takes 1 to 99. Nothing changed.')
  assert.equal(
    codexText.setUnknown('foo'),
    'unknown option "foo". The options are reserve, weeklyReserve, lastMinutes, weeklyLastHours, resumeFloor, weeklyResumeFloor, pausePrompt, autoResume, headless and scope.',
  )
  assert.equal(codexText.setFailed(CFG, 'EACCES'), `could not write ${CFG}: EACCES. Nothing changed.`)
  assert.equal(
    codexText.setList(CFG, [
      ['reserve', '15', 'config.json'],
      ['autoResume', 'off', 'SPARE10_AUTO_RESUME wins'],
      ['headless', 'off', 'default'],
    ]),
    [
      `options, from ${CFG}:`,
      '  · reserve           15 (config.json)',
      '  · autoResume        off (SPARE10_AUTO_RESUME wins)',
      '  · headless          off (default)',
      'Change one with spare10 set <option> <value>, or spare10 set <option> default.',
    ].join('\n'),
  )
  assert.equal(
    codexText.help(D),
    [
      'commands, typed as the whole prompt:',
      'spare10           show the status',
      'spare10 resume    continue on the reserve',
      'spare10 stop      stop at the reserve now',
      'spare10 simulate  set a test reading, such as spare10 simulate 92',
      'spare10 set       show or change the options',
      'During a turn, run them as !spare10 ... in the prompt. This needs the spare10 folder on your PATH:',
      `add export PATH="${D}:$PATH" to ~/.zshrc or ~/.bashrc, then start a new Codex session.`,
      'Codex gives the output of a ! command to the model.',
    ].join('\n'),
  )
  assert.equal(codexText.cliDone('resume'), 'spare10: resume done. The details show in the Codex transcript.')
  assert.equal(codexText.cliSandbox('resume'), 'spare10: run this as !spare10 resume in the Codex prompt. The agent cannot run it.')
  assert.equal(
    codexText.cliNoSession('stop', [['01a0da06', '/Users/me/proj', 'stopped']]),
    'spare10: name the session. Run this as !spare10 stop in the Codex prompt, or add --session <id>. Sessions of the last 24 h:\n  · 01a0da06  /Users/me/proj  stopped',
  )
  assert.equal(
    codexText.cliUsage,
    'usage: spare10 [status [--full]|help|resume|stop|simulate <words>|set [<option> [<value>]]] [--session <id>] [--codex-home <dir>] [--data <dir>]',
  )
  assert.equal(codexText.hooksRow(9, 9), 'all 9 trusted')
  assert.equal(codexText.hooksRow(7, 9), '7 of 9 trusted. Start codex and trust the spare10 hooks, or run /hooks.')
})

/** The debug lines of the broker log, with sample values. */
const DEBUG = [
  codexDebug.gateError('boom'),
  codexDebug.interruptFailed('thread not found'),
  codexDebug.startFailed('timeout'),
  codexDebug.liveFailed('daemon', 'no socket'),
  codexDebug.simulateIgnored,
  codexDebug.dropped(2),
  codexDebug.swept(3),
  codexDebug.recovery(1),
  codexDebug.wakeFailed('boom'),
  codexDebug.watchFailed('/data/sessions/S1', 'EMFILE'),
  codexDebug.mcpBadLine('Unexpected token'),
  codexDebug.mcpBadOut('circular'),
  codexDebug.mcpOutputFailed('EPIPE'),
  codexDebug.mcpClosed('stdin closed', 2),
  codexDebug.cancelled('7'),
  codexDebug.boot('0.3.0', true),
  codexDebug.boot('0.3.0', false),
]

// ---- The prefix rules under the Codex words (a port of enginePrefixed() of tests/core/text.test.ts) ----

const NO_RESET: Facts = { used: 91.5, left: 8.5, resetsAtMs: null, reserve: 10, timeZone: TZ }
const WEEK: Named[] = [{ kind: 'seven_day', test: false }]
const TEST5: Named[] = [{ kind: 'five_hour', test: true }]
const NAMED: Named[][] = [FIVE, WEEK, TEST5, [...FIVE, ...WEEK], []]

/** The Codex-only texts that the broker prefixes: warnings, transcript lines and command replies. */
function codexPrefixed(): string[] {
  return [
    codexText.noDaemon(true),
    codexText.noDaemon(false),
    codexText.approvalNever,
    codexText.unsafe,
    codexText.daemonEnv([['SPARE10', 'off']]),
    codexText.configBad(CFG, 'reserve', 0, '1 to 99', '10'),
    codexText.configUnread(CFG, 'bad JSON'),
    codexText.weeklyOnlyOff,
    codexText.weeklyOnlyOpen(8),
    codexText.optInDaemon,
    codexText.originator('some-app'),
    codexText.hardStop,
    codexText.workspaceLimit('workspace_owner_usage_limit_reached'),
    codexText.credits('3'),
    codexText.promptLost,
    codexText.cliHint(L, D),
    codexText.setOk('reserve', '15', '10'),
    codexText.setOk('reserve', '15', '10') + codexText.setEnvWins('SPARE10_RESERVE'),
    codexText.setDefault('pausePrompt', 'an empty text'),
    codexText.setBad('headless', 'off, prompt, stop or wait'),
    codexText.setUnknown('foo'),
    codexText.setFailed(CFG, 'EROFS'),
    codexText.setList(CFG, [['reserve', '10', 'default']]),
    codexText.help(D),
  ]
}

/** The core notices, warnings and replies, with sample figures, under the Codex words. */
function corePrefixed(): string[] {
  const out: string[] = [
    W_FLAG,
    notice.newWindow,
    notice.resetWaiting,
    notice.outOfReserve,
    notice.resumeFailed('thread not found'),
    badWarning('SPARE10_RESERVE', '0', '10'),
    badWarning('SPARE10_WEEKLY_RESERVE', '0.5', '10'),
    badWarning('SPARE10_AUTO_RESUME', 'yes', 'on'),
    badWarning('SPARE10_HEADLESS', 'x', 'off'),
    badWarning('SPARE10', 'x', 'opt-in'),
    floorWarning('five_hour', 10, 10),
    floorWarning('seven_day', 12, 10),
    timeoutWarning('askUserQuestionTimeout'),
    consentWarning('2026-09-25T00:00:00.000Z'),
    notPerson('stop'),
    unknownVerb('pause'),
    simulateReply('off'),
    simulateReply('bad'),
    simulateReply('weekly-off'),
    commandFailed('boom'),
    resumeReply('overdue'),
    stopReply('overdue'),
    statusReport(status()),
    statusReport(SAMPLE),
  ]
  for (const kinds of [['five_hour'], ['seven_day'], ['five_hour', 'seven_day']] as Kind[][]) out.push(notice.newWindowFor(kinds))
  for (const named of NAMED) {
    out.push(notice.resetWaitingFor(named), notice.resetContinues(named), notice.resetResumes(named), notice.resetStopOver(named))
    out.push(notice.stopTakenOver(named), resumeReply('overdue', F, named))
    for (const still of [[F], [FW], [F, FW]]) out.push(notice.resetStillHeld(named, still), notice.stopExtended(named, still, 'Mon 09:00'))
  }
  for (const f of [F, FW, NO_RESET, [F, FW]] as Array<Facts | Facts[]>) {
    out.push(notice.continuing(f), notice.told(f), notice.holdLimit(f), notice.stopped(f))
    for (const work of [false, true]) out.push(notice.holdLimit(f, { at: '15:00', work }), notice.stopped(f, { at: '15:00', work }))
    for (const c of ['asking', 'stopped', 'tripped', 'consented', 'below', 'none', 'off', 'overdue', 'open'] as const) out.push(resumeReply(c, f))
    for (const c of ['asking', 'stopped', 'tripped', 'below', 'none', 'off', 'overdue', 'overdue-open', 'overdue-skip', 'open'] as const) {
      out.push(stopReply(c, f, 90, { at: 'Mon 09:00' }, 90), stopReply(c, f), stopReply(c, f, 90, undefined, 90, undefined, ['five_hour']))
    }
    if (!Array.isArray(f)) out.push(simulateReply('set', f), simulateReply('raised', f))
  }
  return out
}

test('no transcript line, warning or command reply starts with the prefix that the broker adds', () => {
  const texts = [...corePrefixed(), ...codexPrefixed()]
  assert.ok(texts.length > 250, String(texts.length))
  for (const t of texts) {
    assert.equal(t.startsWith('spare10: '), false, t)
    assert.equal(t.startsWith('spare10 '), false, t)
  }
})

test('model texts, drop reasons, CLI lines and debug lines keep their own spare10 prefix', () => {
  const kept = [
    codexText.turnEnds,
    codexText.steerNote,
    codexText.notStartedNoDialog(F),
    codexText.cliSandbox('resume'),
    codexText.cliNoSession('resume', []),
    codexText.interruptedNote,
    codexText.turnEndsHold,
    codexText.cliDone('stop'),
    ...DEBUG,
    STOP_GENERIC,
    NOT_STARTED_GENERIC,
    stopText(F),
    pausedText(F),
    resumeContext(F),
    resetContext(FIVE),
    notStarted(F),
    debugLine.told('S1:main'),
    debugLine.handedOn(1),
    debugLine.unattended(F, 'stop'),
    debugLine.resumeSkipped,
  ]
  for (const t of kept) assert.ok(t.startsWith('spare10: '), t)
  assert.ok(headlessText(F, 'S1').startsWith('spare10 stopped this unattended run'))
  assert.ok(headlessText(F, 'S1').endsWith('To pick it up later: codex exec resume S1'))
  assert.ok(pauseInstruction(F, null).startsWith('spare10 budget guard.'))
  // The resume prompt is a user message: no prefix, and the Codex subagent sentence.
  assert.ok(resumePrompt(FIVE).startsWith('The 5-hour window reset'))
  assert.ok(resumePrompt(FIVE).includes('A subagent that was interrupted, or whose result says "spare10: work stopped", did not finish.'))
})

test('withPrefix of a two-line text prefixes both lines', () => {
  const two = `${notice.outOfReserve}\n${codexText.promptLost}`
  assert.equal(withPrefix(two), `spare10: ${notice.outOfReserve}\nspare10: ${codexText.promptLost}`)
})

// ---- Punctuation: no semicolon and no dash character (ASD-STE100, CLAUDE.md) ----

const DASHES = /[\u2012-\u2015\u2212\u2e3a\u2e3b\ufe58\ufe63\uff0d]/

function everyCodexText(): string[] {
  const texts: string[] = [
    ...codexPrefixed(),
    codexText.statusHold,
    codexText.statusStart,
    codexText.turnEnds,
    codexText.turnEndsHold,
    codexText.steerNote,
    codexText.interruptedNote,
    codexText.notStartedNoDialog([F, FW]),
    codexText.notStartedNoDialog(NO_RESET),
    codexText.creditsQuestion('497'),
    codexText.helpSet,
    codexText.helpAnytime,
    codexText.cliDone('simulate'),
    codexText.cliSandbox('stop'),
    codexText.cliNoSession('resume', [['a', '/b', 'armed']]),
    codexText.cliUsage,
    codexText.hooksRow(3, 9),
    codexText.hooksRow(9, 9),
    ...[true, false].flatMap((a) => [codexText.daemonRow(true, a), codexText.daemonRow(false, a), codexText.daemonReach(a), codexText.brokerRow(a)]),
    codexText.liveRow({ agoMs: 1 }),
    codexText.liveRow({ error: 'x' }),
    codexText.liveRow({}),
    ...DEBUG,
  ]
  return texts
}

test('no CX text has a semicolon or a dash character', () => {
  const texts = everyCodexText()
  assert.ok(texts.length > 50, String(texts.length))
  for (const t of texts) {
    assert.equal(t.includes(';'), false, t)
    assert.equal(DASHES.test(t), false, t)
  }
})

test('the core texts under the Codex words have no semicolon or dash character either', () => {
  const texts = [...corePrefixed(), ...GOLDEN.map(([, got]) => got())]
  for (const t of texts) {
    assert.equal(t.includes(';'), false, t)
    assert.equal(DASHES.test(t), false, t)
  }
})
