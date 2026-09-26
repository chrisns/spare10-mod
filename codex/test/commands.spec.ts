import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { codexText } from '../../hooks/core/codex.ts'
import type { Command } from '../../hooks/core/codex.ts'
import { formatConsent, formatStopped } from '../../hooks/core/decide.ts'
import type { StoppedRecord } from '../../hooks/core/decide.ts'
import { VERSION, notPerson, resumeReply, simulateReply, unknownVerb } from '../../hooks/core/text.ts'
import { createAttendance } from '../src/attend.ts'
import { createCommands } from '../src/commands.ts'
import { readJson } from '../src/files.ts'
import type { SenseApi } from '../src/sense.ts'
import { createSettings } from '../src/settings.ts'
import { logicWorld } from './helpers/logic.ts'
import { memoryLog } from './helpers/log.ts'
import { CHILD, HOUR, MIN, SID, T0, parsed, world } from './helpers/world.ts'
import type { World, WorldBroker } from './helpers/world.ts'

// The commands (Codex design 2.8, 4.19, 4.20, 8.2 commands.spec): every reply of 2.8 through a typed
// prompt, the block answer, notPerson in a subagent, a report that changes nothing, `asking` in place of
// `stopped` while held work waits under a stop, the stopped phase with held work, and the report of 2.8 on
// the weekly-only world of the owner's account, also for a resume whose first sense fails.
//
// The kit port (8.2):
// Each tests/kit case and the Codex case that tests it: codex/test/kit-port.txt, kept complete by kit-port.spec.ts.

process.env.TZ = 'UTC' // the clock texts of the sample report

const RESET = T0 + 2 * HOUR

/** A typed command: its block reason, without the `spare10: ` of the first line. */
async function typed(b: WorldBroker, prompt: string): Promise<string> {
  const out = parsed(await b.gate('prompt', { prompt }))
  assert.equal(out['decision'], 'block', `${prompt} is blocked`)
  const reason = out['reason'] as string
  assert.ok(reason.startsWith('spare10: '), 'the reason has the prefix')
  return reason.slice('spare10: '.length)
}

/** The phase line of a report: its mark and phase name. */
const phaseOf = (report: string): string => (report.split('\n')[2] ?? '').trim().split(/\s+/).slice(0, 2).join(' ')

const stopOf = (r: Partial<StoppedRecord> = {}): string =>
  formatStopped({ sessionId: SID, windowEnd: RESET - 20 * MIN, at: T0, kinds: ['five_hour'], auto: true, work: true, skip: true, ...r })

test('commands: status in each phase', async (t) => {
  const cases: Array<[string, (w: World) => Promise<WorldBroker>, string]> = [
    ['waiting', async (w) => w.broker(), '⧗ waiting'],
    [
      'armed',
      async (w) => {
        w.reading(SID, 40, { reset: RESET })
        return w.broker()
      },
      '● armed',
    ],
    [
      'tripped',
      async (w) => {
        w.reading(SID, 92, { reset: RESET })
        return w.broker()
      },
      '⚠ tripped',
    ],
    [
      'consented',
      async (w) => {
        w.reading(SID, 92, { reset: RESET })
        w.setState({ consent: formatConsent(SID, RESET) })
        return w.broker()
      },
      '⨯ consented',
    ],
    [
      'open',
      async (w) => {
        w.reading(SID, 92, { reset: T0 + 10 * MIN })
        return w.broker()
      },
      '↻ open',
    ],
    [
      'stopped',
      async (w) => {
        w.reading(SID, 92, { reset: RESET })
        w.setState({ stopped: stopOf() })
        return w.broker()
      },
      '■ stopped',
    ],
    [
      'off',
      async (w) => {
        w.config({ scope: 'opt-in' })
        w.reading(SID, 92, { reset: RESET })
        return w.broker()
      },
      '○ off',
    ],
    [
      'reserve (unattended)',
      async (w) => {
        w.reading(SID, 92, { reset: RESET })
        return w.broker({ hostKind: 'exec', originator: 'codex_exec', source: 'exec' })
      },
      '⚠ tripped',
    ],
    [
      'told',
      async (w) => {
        w.config({ pausePrompt: 'Wind down now.' })
        w.reading(SID, 92, { reset: RESET })
        const b = await w.broker()
        await b.gate('tool')
        return b
      },
      '⏸ told',
    ],
  ]
  for (const [name, make, want] of cases) {
    const w = world(t)
    const b = await make(w)
    const report = await typed(b, 'spare10')
    assert.equal(report.split('\n')[0], `version ${VERSION}`)
    assert.equal(phaseOf(report), want, name)
  }
  // asking: a question is open.
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  const h = b.call('tool')
  await w.settle()
  const report = await typed(b, 'spare10')
  assert.equal(phaseOf(report), '? asking')
  assert.match(report, /If no form shows, run !spare10 resume or !spare10 stop\./)
  b.host.answer({ action: 'accept', content: { choice: 'resume' } })
  await w.settle()
  assert.equal(h.box.done, true)
})

test('commands: the blind phase after two live reads with no window', async (t) => {
  const w = world(t)
  const b = await w.broker()
  const empty = { ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex', primary: null, secondary: null }, rateLimitsByLimitId: { codex: { limitId: 'codex', primary: null, secondary: null } } }
  w.live(empty, T0, 2) // two good reads in a row with no window
  const report = await typed(b, 'spare10')
  assert.equal(phaseOf(report), '⚠ blind')
  assert.match(report, /Codex reports no quota windows for this login\. spare10 lets all work through\./)
})

test('commands: help, unknown verb, unknown option, and notPerson in a subagent', async (t) => {
  const w = world(t)
  const b = await w.broker()
  assert.equal(await typed(b, 'spare10 help'), codexText.help(w.paths.bin, w.paths.home))
  assert.equal(await typed(b, 'spare10 pause'), unknownVerb('pause'))
  assert.equal(await typed(b, 'spare10 set foo'), codexText.setUnknown('foo'))
  const child = await w.broker({ thread: CHILD })
  for (const [prompt, verb] of [
    ['spare10 resume', 'resume'],
    ['spare10 stop', 'stop'],
    ['spare10 simulate 92', 'simulate'],
    ['spare10 set reserve 15', 'set'],
  ] as const) {
    assert.equal(await typed(child, prompt), notPerson(verb))
  }
  // status, help and the option list run in any thread.
  assert.match(await typed(child, 'spare10'), /^version /)
  assert.match(await typed(child, 'spare10 set'), /^options, from /)
  // An ordinary prompt that starts with spare10 goes to the model.
  assert.equal(await b.gate('prompt', { prompt: 'Spare10 keeps holding my build, why?' }), '')
})

test('commands: a report changes no state', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  await b.gate('stop')
  const before = readFileSync(w.file('state.json'), 'utf8')
  await typed(b, 'spare10')
  await typed(b, 'spare10 status')
  // The prompt gate records its turn in the thread file (the steer rule), never in state.json.
  assert.equal(readFileSync(w.file('state.json'), 'utf8'), before)
})

test('commands: resume and stop replies below the reserve, at a trip, and over a stop', async (t) => {
  const w = world(t)
  const b = await w.broker()
  assert.equal(await typed(b, 'spare10 resume'), 'nothing to resume. There is no 5-hour reading yet.')
  assert.equal(await typed(b, 'spare10 stop'), 'nothing to stop. spare10 steps in at 90% used, or at 90% used of the weekly window.')
  w.reading(SID, 40, { reset: RESET })
  assert.match(await typed(b, 'spare10 resume'), /^nothing to resume\. 40% used · 60% left · resets /)
  w.reading(SID, 92, { reset: RESET })
  const stop = await typed(b, 'spare10 stop')
  assert.match(stop, /^stopped at the reserve until .+\. Then spare10 continues any stopped work\. Type a prompt to be asked again, or run spare10 resume\.$/)
  assert.notEqual(w.state().stopped, undefined)
  assert.equal(await typed(b, 'spare10 stop'), `already stopped until ${(stop.match(/until (\d\d:\d\d)/) ?? [])[1]}.`)
  const resume = await typed(b, 'spare10 resume')
  assert.match(resume, /^resumed\. You can use the reserve until 95% used\. Until \d\d:\d\d, spare10 asks you again at 95% used\. Type a prompt to continue\.$/)
  assert.equal(w.state().stopped, undefined)
  assert.equal(w.state().consent, formatConsent(SID, RESET, 95))
})

test('commands: a resume whose first sense fails takes the absent kinds of the sense it uses (CX17)', async (t) => {
  const w = logicWorld(t)
  const b = w.broker()
  const weekReset = T0 + 3 * 24 * HOUR
  // Two observations with no 5-hour window: a weekly-only plan (4.15).
  w.reading(SID, 61, { kind: 'seven_day', reset: weekReset, at: T0 - 2 * MIN })
  await b.sense.sense(b.sx, 'tool')
  w.reading(SID, 61, { kind: 'seven_day', reset: weekReset, at: T0 - MIN })
  assert.deepEqual((await b.sense.sense(b.sx, 'tool')).present, ['seven_day'])
  // The first sense of each resume (the takeover sense, skip 4.6) fails, and the second one answers.
  let calls = 0
  const sense: SenseApi = {
    ...b.sense,
    async sense(sx, site) {
      calls += 1
      if (calls % 2 === 1) throw new Error('the quota read failed')
      return b.sense.sense(sx, site)
    },
  }
  const cmds = createCommands({
    paths: w.paths,
    clock: w.clock,
    log: w.log,
    owner: b.owner,
    env: {},
    settings: b.settings,
    sense,
    questions: b.questions,
    sweep: b.sweep,
    daemon: b.daemonLink,
    attendance: createAttendance({ hostKind: 'tui', rollouts: b.rollouts }),
    pidAlive: (p) => w.alive.has(p),
  })
  const resume: Command = { verb: 'resume', words: [], rest: '' }
  // Below the weekly reserve: the facts of the weekly window, and no 5-hour trip.
  assert.equal(await cmds.exec(b.sx, resume, { cli: false }), 'nothing to resume. 61% used · 39% left · resets Tue 10:00.')
  assert.equal(calls, 2)
  // The weekly window resets, and no new reading comes. Only the no-reading form names the absent kinds.
  // So this step fails when the absent kinds come from the failed first sense: that form names a 5-hour reading.
  await w.advance(weekReset - T0 + MIN)
  assert.equal(await cmds.exec(b.sx, resume, { cli: false }), resumeReply('none', undefined, undefined, undefined, 'hold', ['five_hour']))
  assert.equal(await cmds.exec(b.sx, resume, { cli: false }), 'nothing to resume. There is no reading yet.')
  assert.equal(calls, 6)
  assert.equal(w.state().consent, undefined)
  assert.equal(w.state().weeklyConsent, undefined)
})

test('commands: `asking` replaces `stopped` while held work waits under a stop, and the stopped phase says so', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  w.setState({ stopped: stopOf() })
  // Not hosted, Continue at the reset on: the refused tool call holds in place.
  const h = b.call('tool', { turn: 'U-held' })
  await w.settle()
  assert.equal(h.box.done, false)
  const report = await typed(b, 'spare10')
  assert.equal(phaseOf(report), '■ stopped')
  assert.match(report, /Held work waits\. Run !spare10 resume to continue it now\./)
  // The held work continues in place at the stop end (4.4), so the report does not say that nothing can (live check LCX7).
  assert.ok(!report.includes('spare10 cannot check the reset in this session.'), 'no ticker warning while held work waits in place')
  // A stop over this stop leaves the held call where it is (no daemon, no sweep), and says so, as the report does.
  assert.equal(await typed(b, 'spare10 stop'), 'already stopped until 11:40. Held work waits. Run !spare10 resume to continue it now.')
  await w.settle()
  assert.equal(h.box.done, false, 'the held call still waits')
  // With no held work (Esc ended the turn) and no daemon, nothing continues the stopped work: the report says so.
  b.drop(h.id)
  await b.gate('interrupt', { turn: 'U-held' })
  await w.settle()
  assert.equal(h.box.done, true)
  assert.deepEqual(w.thread(SID)?.held, [], 'no held work')
  assert.match(await typed(b, 'spare10'), /⚠ spare10 cannot check the reset in this session\. Type a prompt to continue after the reset\./)
  const h2 = b.call('tool', { turn: 'U-next' })
  await w.settle()
  assert.equal(h2.box.done, false)
  const reply = await typed(b, 'spare10 resume')
  assert.match(reply, /^resumed\. Held work continues on the reserve until 95% used\. Until \d\d:\d\d, spare10 asks you again at 95% used\.$/)
  await w.settle()
  assert.equal(h2.box.done, true)
  assert.equal(parsed(h2.box.text)['hookSpecificOutput'], undefined, 'the held tool runs')
})

test('commands: simulate sets, rejects and clears a test reading', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 40, { reset: RESET })
  const set = await typed(b, 'spare10 simulate 92')
  assert.match(set, /^test reading set to 92% used, resets .+\. It can only raise the real reading\./)
  assert.match(set, /Run spare10 simulate off to clear it\.$/)
  assert.equal(w.state().test?.hostPid, b.hostPid)
  assert.equal(w.state().test?.kinds.five_hour?.pct, 92)
  assert.equal(await typed(b, 'spare10 simulate lots'), simulateReply('bad'))
  // Off clears the test reading, and with it any consent and stop of the session, as register.tsx does.
  w.setState({ consent: formatConsent(SID, RESET), weeklyConsent: formatConsent(SID, T0 + 3 * 24 * HOUR), stopped: stopOf() })
  assert.equal(await typed(b, 'spare10 simulate off'), simulateReply('off'))
  assert.deepEqual(w.state().test?.kinds, {})
  assert.equal(w.state().consent, undefined)
  assert.equal(w.state().weeklyConsent, undefined)
  assert.equal(w.state().stopped, undefined)
})

test('commands: spare10 stop on an open loop question settles it as Stop here, and the held call is refused', async (t) => {
  // From the prompt (a steer of the root) and from the CLI (!spare10 stop), the stop reaches the open question.
  for (const via of ['prompt', 'cli'] as const) {
    const w = world(t, { daemon: true })
    const b = await w.broker({ hosted: true })
    w.reading(SID, 92, { reset: RESET })
    w.daemon.script.newestTurn = { id: 'U-held', status: 'inProgress', startedAt: Math.floor(T0 / 1000) - 5 }
    b.script('hang')
    const h = b.call('tool', { turn: 'U-held' })
    await w.settle()
    assert.equal(h.box.done, false, `${via}: the tool holds on the question`)
    const key = readJson<{ key: string }>(w.file('question.json'))?.key
    assert.ok(key !== undefined, `${via}: a question is open`)
    const reply = via === 'cli' ? (await w.cli(['stop', '--session', SID])).out : `spare10: ${await typed(b, 'spare10 stop')}`
    assert.match(reply, /^spare10: stopped\. Held work is refused\. spare10 continues it at \d\d:\d\d, 20 min before the reset\.$/, `${via}: the stop reply`)
    await w.settle()
    assert.equal(readJson<{ key: string; outcome: string; via: string }>(w.file('answer.json'))?.outcome, 'stop', `${via}: the question is settled as Stop here`)
    assert.equal(readJson<{ key: string }>(w.file('answer.json'))?.key, key)
    assert.notEqual(w.state().stopped, undefined, `${via}: the stop is written`)
    assert.equal(h.box.done, true, `${via}: the held call is answered`)
    assert.equal((parsed(h.box.text)['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['permissionDecision'], 'deny', `${via}: refused`)
    assert.deepEqual(w.daemon.callsOf('interrupt'), [[SID, 'U-held']], `${via}: the hosted turn is interrupted once`)
  }
})

test('commands: set lists, changes, rejects and resets an option, and a variable of the broker wins', async (t) => {
  const w = world(t)
  const b = await w.broker({ env: { SPARE10_WEEKLY_RESERVE: '12' } })
  const path = join(w.data, 'config.json')
  const list = await typed(b, 'spare10 set')
  assert.equal(
    list,
    [
      `options, from ${path}:`,
      '  · reserve           10 (default)',
      '  · weeklyReserve     12 (SPARE10_WEEKLY_RESERVE wins)',
      '  · lastMinutes       20 (default)',
      '  · weeklyLastHours   8 (default)',
      '  · resumeFloor       5 (default)',
      '  · weeklyResumeFloor 5 (default)',
      '  · pausePrompt       an empty text (default)',
      '  · autoResume        on (default)',
      '  · headless          off (default)',
      '  · scope             all (default)',
      'Change one with spare10 set <option> <value>, or spare10 set <option> default.',
    ].join('\n'),
  )
  assert.equal(await typed(b, 'spare10 set reserve 15'), codexText.setOk('reserve', '15', '10'))
  assert.equal(await typed(b, 'spare10 set Reserve 16'), codexText.setOk('reserve', '16', '15'))
  assert.equal(await typed(b, 'spare10 set reserve 150'), codexText.setBad('reserve', '1 to 99'))
  assert.equal(await typed(b, 'spare10 set weeklyReserve 5'), `${codexText.setOk('weeklyReserve', '5', '10')}${codexText.setEnvWins('SPARE10_WEEKLY_RESERVE')}`)
  assert.equal(await typed(b, 'spare10 set pausePrompt Finish this, then stop.'), codexText.setOk('pausePrompt', '"Finish this, then stop."', 'an empty text'))
  assert.equal(await typed(b, 'spare10 set reserve default'), codexText.setDefault('reserve', '10'))
  assert.deepEqual(readJson(path), { weeklyReserve: 5, pausePrompt: 'Finish this, then stop.' })
  // autoResume off: stored as false, read back as off by the settings, and shown in the report.
  assert.equal(await typed(b, 'spare10 set autoResume off'), codexText.setOk('autoResume', 'off', 'on'))
  assert.equal(readJson<Record<string, unknown>>(path)?.['autoResume'], false)
  const eff = createSettings({ paths: w.paths, log: memoryLog(), env: {}, parentChild: () => undefined, simulateKind: () => 'five_hour' }).get()
  assert.equal(eff.autoResume, false)
  assert.match(await typed(b, 'spare10'), /· at the reset   wait for your answer \(from spare10 set\)/)
  // A config.json that is not an object is never overwritten.
  const { writeFileSync } = await import('node:fs')
  writeFileSync(path, '[1, 2]')
  assert.equal(await typed(b, 'spare10 set reserve 15'), codexText.setFailed(path, 'it is not a JSON object'))
})

test('commands: set names a variable as the winner only when its value parses (A15)', async (t) => {
  const w = world(t)
  const b = await w.broker({ env: { SPARE10_RESERVE: 'abc', SPARE10: 'maybe' } })
  // withEnv keeps the option for a value that does not parse, and the report warns (B27): the reply agrees.
  assert.equal(await typed(b, 'spare10 set reserve 15'), codexText.setOk('reserve', '15', '10'))
  const list = await typed(b, 'spare10 set')
  assert.match(list, /\n {2}· reserve {11}15 \(config\.json\)\n/)
  assert.match(list, /\n {2}· scope {13}all \(default\)\n/)
  assert.equal(await typed(b, 'spare10 set scope opt-in'), codexText.setOk('scope', 'opt-in', 'all'))
})

test('commands: the report warns of a consent after this window in the Codex words, never SPARE10_CONSENT (CX48)', async (t) => {
  const w = world(t)
  const b = await w.broker()
  w.reading(SID, 92, { reset: RESET })
  assert.match(await typed(b, 'spare10 resume'), /^you can use the reserve until 95% used\./)
  assert.equal(w.state().consent, formatConsent(SID, RESET, 95))
  // A first test reading keeps the real consent, and its own window ends before that consent does.
  assert.match(await typed(b, 'spare10 simulate 93 in 30m'), /^test reading set to 93% used/)
  assert.equal(w.state().consent, formatConsent(SID, RESET, 95))
  const report = await typed(b, 'spare10')
  assert.ok(report.includes(`\n  ⚠ ${codexText.consentBeyond('five_hour', RESET, T0)}`), report)
  assert.ok(!report.includes('SPARE10_CONSENT'), 'Codex keeps consent in the session state')
})

test('commands: the report, help and set never name the home folder: ~/... in a row, "$HOME/..." in a command', async (t) => {
  const w = world(t, { homeAtRoot: true })
  const b = await w.broker()
  const report = await typed(b, 'spare10')
  assert.match(report, /\n {2}· cli {12}~\/data\/bin\/spare10\n/)
  const help = await typed(b, 'spare10 help')
  assert.equal(help, codexText.help(w.paths.bin, w.paths.home))
  assert.match(help, /add export PATH="\$HOME\/data\/bin:\$PATH" to/)
  assert.match(await typed(b, 'spare10 set'), /^options, from ~\/data\/config\.json:\n/)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(w.data, 'config.json'), '[1, 2]')
  assert.equal(await typed(b, 'spare10 set reserve 15'), codexText.setFailed('~/data/config.json', 'it is not a JSON object'))
  for (const text of [report, help]) assert.ok(!text.includes(w.root), 'no text names the home folder')
})

test('commands: the report of 2.8 on a weekly-only plan hosted by the daemon', async (t) => {
  const w = world(t, { daemon: true })
  const weekReset = T0 + 3 * 24 * HOUR + 21 * HOUR
  const snap = { limitId: 'codex', primary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: Math.floor(weekReset / 1000) }, secondary: null, credits: { hasCredits: false, unlimited: false, balance: '0' } }
  // Two observations with no 5-hour window: the rollout's, then the live read's.
  w.rollout(SID).tokenCount({ at: T0 - MIN, primary: { pct: 61, mins: 10080, resetsAt: weekReset }, secondary: null })
  w.live({ ordinaryUsageAllowed: true, rateLimits: snap, rateLimitsByLimitId: { codex: snap } })
  const b = await w.broker({ hosted: true })
  const report = `spare10: ${await typed(b, 'spare10')}`
  const want = [
    `spare10: version ${VERSION}`,
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
    '  · weekly reading live · 61% used · 39% left · resets Wed 07:00 (in 3 d 21 h)',
    '  · consent        none',
    '  · weekly consent none',
    '  · guarded        yes (scope all)',
    '  · codex exec     runs started here: stop',
    '  · daemon         yes. spare10 can end a turn and start one.',
    '  · live read      from the Codex daemon, under 1 min ago',
    `  · cli            ${w.paths.launcher}`,
    `  ⚠ ${codexText.weeklyOnlyOpen(8)}`,
    '',
    'spare10 resume    continue on the reserve until the floor, or past the floor until the reset',
    'spare10 stop      stop at the reserve now',
    'spare10 set       change an option, such as spare10 set reserve 15',
    '!spare10 status   run a command during a turn (see spare10 help)',
  ]
  assert.equal(report, want.join('\n'))
})
