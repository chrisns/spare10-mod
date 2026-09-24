import { test, expect } from 'claude-code/testing'
import {
  DEFAULTS,
  childHeadless,
  flagOnlyInShell,
  fromOptions,
  parseAutoResume,
  parseBadge,
  parseHeadless,
  parsePausePrompt,
  parseReserve,
  parseScope,
  parseSwitch,
  parseWeeklyReserve,
  questionTimeout,
  reserveOf,
  watchedKinds,
  withEnv,
} from '../../hooks/core/config.ts'

test('parseReserve accepts 1 to 99 and rounds to one decimal', () => {
  expect(parseReserve(10)).toBe(10)
  expect(parseReserve('10.55')).toBe(10.6)
  expect(parseReserve(' 15 ')).toBe(15)
  expect(parseReserve(1)).toBe(1)
  expect(parseReserve(99)).toBe(99)
  for (const bad of [0, 100, -5, 0.04, 'abc', ' ', '', null, undefined, true, Number.NaN]) {
    expect(parseReserve(bad)).toBeUndefined()
  }
})

test('parsePausePrompt reads blank as off and keeps text verbatim, newlines included', () => {
  expect(parsePausePrompt('')).toBeNull()
  expect(parsePausePrompt('   ')).toBeNull()
  expect(parsePausePrompt('\n\t ')).toBeNull()
  expect(parsePausePrompt(undefined)).toBeNull()
  expect(parsePausePrompt(false)).toBeNull()
  expect(parsePausePrompt('Commit and stop.')).toBe('Commit and stop.')
  expect(parsePausePrompt('  Commit.\nThen stop.  ')).toBe('  Commit.\nThen stop.  ')
})

test('parseHeadless, parseScope and parseSwitch take their words in any case', () => {
  expect(parseHeadless('off')).toBe('off')
  expect(parseHeadless(' PROMPT ')).toBe('prompt')
  expect(parseHeadless('Stop')).toBe('stop')
  expect(parseHeadless('halt')).toBeUndefined()
  expect(parseHeadless(1)).toBeUndefined()
  expect(parseScope('ALL')).toBe('all')
  expect(parseScope(' Opt-In ')).toBe('opt-in')
  expect(parseScope('optin')).toBeUndefined()
  expect(parseSwitch('ON')).toBe('on')
  expect(parseSwitch(' off ')).toBe('off')
  expect(parseSwitch('1')).toBeUndefined()
  expect(parseSwitch('yes')).toBeUndefined()
  expect(parseSwitch(true)).toBeUndefined()
})

test('parseBadge is on unless explicitly false', () => {
  expect(parseBadge(true)).toBe(true)
  expect(parseBadge('')).toBe(true)
  expect(parseBadge(undefined)).toBe(true)
  expect(parseBadge('false')).toBe(true)
  expect(parseBadge(false)).toBe(false)
})

test('fromOptions fills the defaults and reads only declared fields', () => {
  expect(fromOptions({})).toEqual(DEFAULTS)
  expect(DEFAULTS).toEqual({ reserve: 10, weeklyReserve: 10, pausePrompt: null, autoResume: true, headless: 'off', scope: 'all', badge: true })
  expect(fromOptions({ reserve: 10, pausePrompt: '', headless: 'off', scope: 'all', badge: true })).toEqual(DEFAULTS)
  const s = fromOptions({ reserve: 20.04, pausePrompt: 'Wrap up.', headless: 'stop', scope: 'opt-in', badge: false, extra: 'x', window: 'both' })
  expect(s).toEqual({ reserve: 20, weeklyReserve: 10, pausePrompt: 'Wrap up.', autoResume: true, headless: 'stop', scope: 'opt-in', badge: false })
  expect(fromOptions({ reserve: 150, headless: 'loud', scope: 'some' })).toEqual(DEFAULTS)
})

test('withEnv: SPARE10_RESERVE overrides, a bad value is ignored with the B27 warning', () => {
  const ok = withEnv(DEFAULTS, { reserve: '15' })
  expect(ok.reserve).toBe(15)
  expect(ok.from.reserve).toBe('env')
  expect(ok.warnings).toEqual([])
  const bad = withEnv(DEFAULTS, { reserve: '0' })
  expect(bad.reserve).toBe(10)
  expect(bad.from.reserve).toBe('option')
  expect(bad.warnings).toEqual(['SPARE10_RESERVE="0" is not 1 to 99. spare10 uses 10.'])
  const h = withEnv(DEFAULTS, { headless: 'loud' })
  expect(h.headless).toBe('off')
  expect(h.from.headless).toBe('option')
  expect(h.warnings).toEqual(['SPARE10_HEADLESS="loud" is not off, prompt, stop or wait. spare10 uses off.'])
  const h2 = withEnv(DEFAULTS, { headless: 'STOP' })
  expect(h2.headless).toBe('stop')
  expect(h2.from.headless).toBe('env')
})

test('withEnv: a set but empty SPARE10_PAUSE_PROMPT forces stop-and-ask', () => {
  const base = { ...DEFAULTS, pausePrompt: 'Commit and stop.' }
  expect(withEnv(base, {}).pausePrompt).toBe('Commit and stop.')
  expect(withEnv(base, {}).from.pausePrompt).toBe('option')
  const empty = withEnv(base, { pausePrompt: '' })
  expect(empty.pausePrompt).toBeNull()
  expect(empty.from.pausePrompt).toBe('env')
  expect(withEnv(base, { pausePrompt: '   ' }).pausePrompt).toBeNull()
  expect(withEnv(DEFAULTS, { pausePrompt: 'Finish, then stop.' }).pausePrompt).toBe('Finish, then stop.')
})

test('withEnv: SPARE10 on and off beat the scope, a bad value warns', () => {
  const all = withEnv(DEFAULTS, {})
  expect(all.enabled).toBe(true)
  expect(all.from.enabled).toBe('scope')
  const optIn = { ...DEFAULTS, scope: 'opt-in' as const }
  const quiet = withEnv(optIn, {})
  expect(quiet.enabled).toBe(false)
  expect(quiet.from.enabled).toBe('scope')
  const on = withEnv(optIn, { onOff: 'on' })
  expect(on.enabled).toBe(true)
  expect(on.from.enabled).toBe('SPARE10')
  const off = withEnv(DEFAULTS, { onOff: ' OFF ' })
  expect(off.enabled).toBe(false)
  expect(off.from.enabled).toBe('SPARE10')
  const bad = withEnv(optIn, { onOff: 'maybe' })
  expect(bad.enabled).toBe(false)
  expect(bad.from.enabled).toBe('scope')
  expect(bad.warnings).toEqual(['SPARE10="maybe" is not on or off. spare10 uses the scope option (opt-in).'])
})

test('withEnv: SPARE10_SIMULATE gives a test percentage, junk gives none', () => {
  expect(withEnv(DEFAULTS, { simulate: '95' }).testPct).toBe(95)
  expect(withEnv(DEFAULTS, { simulate: '91.55' }).testPct).toBe(91.6)
  expect(withEnv(DEFAULTS, { simulate: '0' }).testPct).toBe(0)
  expect(withEnv(DEFAULTS, { simulate: '100' }).testPct).toBe(100)
  expect(withEnv(DEFAULTS, {}).testPct).toBeUndefined()
  for (const junk of ['abc', '', ' ', '101', '-1', 'off']) {
    expect(withEnv(DEFAULTS, { simulate: junk }).testPct).toBeUndefined()
    expect(withEnv(DEFAULTS, { simulate: junk }).warnings).toEqual([])
  }
})

test('parseWeeklyReserve takes 0 as off and 1 to 99 with one decimal', () => {
  expect(parseWeeklyReserve(0)).toBe(0)
  expect(parseWeeklyReserve('0')).toBe(0)
  expect(parseWeeklyReserve(' 0 ')).toBe(0)
  expect(parseWeeklyReserve(10)).toBe(10)
  expect(parseWeeklyReserve('10.55')).toBe(10.6)
  expect(parseWeeklyReserve(1)).toBe(1)
  expect(parseWeeklyReserve(99)).toBe(99)
  expect(parseWeeklyReserve('99')).toBe(99)
  expect(Object.is(parseWeeklyReserve(-0), 0)).toBe(true)
  expect(parseWeeklyReserve(0.95)).toBe(1) // rounded first, as parseReserve
  expect(parseWeeklyReserve(0.04)).toBe(0)
  for (const bad of [0.5, 0.9, 100, 99.1, -1, 'x', '', ' ', null, undefined, true, Number.NaN]) {
    expect(parseWeeklyReserve(bad)).toBeUndefined()
  }
})

test('parseAutoResume is on unless explicitly false', () => {
  expect(parseAutoResume('')).toBe(true)
  expect(parseAutoResume(true)).toBe(true)
  expect(parseAutoResume(undefined)).toBe(true)
  expect(parseAutoResume('false')).toBe(true)
  expect(parseAutoResume(false)).toBe(false)
})

test('parseHeadless takes wait', () => {
  expect(parseHeadless('wait')).toBe('wait')
  expect(parseHeadless(' WAIT ')).toBe('wait')
  expect(parseHeadless('Wait')).toBe('wait')
  expect(parseHeadless('waiting')).toBeUndefined()
})

test('fromOptions fills weeklyReserve 10 and autoResume true', () => {
  const d = fromOptions({})
  expect(Object.keys(d).sort()).toEqual(['autoResume', 'badge', 'headless', 'pausePrompt', 'reserve', 'scope', 'weeklyReserve'])
  expect(d.weeklyReserve).toBe(10)
  expect(d.autoResume).toBe(true)
  expect(fromOptions({ weeklyReserve: 0, autoResume: false, headless: 'wait' })).toEqual({ ...DEFAULTS, weeklyReserve: 0, autoResume: false, headless: 'wait' })
  expect(fromOptions({ weeklyReserve: 25.04 }).weeklyReserve).toBe(25)
  expect(fromOptions({ weeklyReserve: 0.5 }).weeklyReserve).toBe(10) // /config takes 0 to 99, the parser does not
  expect(fromOptions({ weeklyReserve: 150, autoResume: '' }).weeklyReserve).toBe(10)
  expect(fromOptions({ autoResume: '' }).autoResume).toBe(true)
})

test('withEnv: SPARE10_WEEKLY_RESERVE and SPARE10_AUTO_RESUME override, bad values warn', () => {
  const plain = withEnv(DEFAULTS, {})
  expect(plain.from).toEqual({ reserve: 'option', weeklyReserve: 'option', pausePrompt: 'option', autoResume: 'option', headless: 'option', enabled: 'scope' })
  expect(plain.weeklyReserve).toBe(10)
  expect(plain.autoResume).toBe(true)
  const off = withEnv(DEFAULTS, { weeklyReserve: '0', autoResume: ' OFF ' })
  expect(off.weeklyReserve).toBe(0)
  expect(off.from.weeklyReserve).toBe('env')
  expect(off.autoResume).toBe(false)
  expect(off.from.autoResume).toBe('env')
  expect(off.warnings).toEqual([])
  const on = withEnv({ ...DEFAULTS, autoResume: false }, { weeklyReserve: '15', autoResume: 'on' })
  expect(on.weeklyReserve).toBe(15)
  expect(on.autoResume).toBe(true)
  const bad = withEnv(DEFAULTS, { weeklyReserve: '0.5', autoResume: 'yes' })
  expect(bad.weeklyReserve).toBe(10)
  expect(bad.from.weeklyReserve).toBe('option')
  expect(bad.autoResume).toBe(true)
  expect(bad.from.autoResume).toBe('option')
  expect(bad.warnings).toEqual([
    'SPARE10_WEEKLY_RESERVE="0.5" is not 0 or 1 to 99. spare10 uses 10.',
    'SPARE10_AUTO_RESUME="yes" is not on or off. spare10 uses on.',
  ])
  expect(withEnv({ ...DEFAULTS, weeklyReserve: 12.5, autoResume: false }, { weeklyReserve: 'x', autoResume: '1' }).warnings).toEqual([
    'SPARE10_WEEKLY_RESERVE="x" is not 0 or 1 to 99. spare10 uses 12.5.',
    'SPARE10_AUTO_RESUME="1" is not on or off. spare10 uses off.',
  ])
  const wait = withEnv(DEFAULTS, { headless: 'Wait' })
  expect(wait.headless).toBe('wait')
  expect(wait.from.headless).toBe('env')
})

test('withEnv: SPARE10_SIMULATE takes a kind and a duration', () => {
  const full = withEnv(DEFAULTS, { simulate: '95 weekly in 2m' })
  expect(full.testPct).toBe(95)
  expect(full.testKind).toBe('seven_day')
  expect(full.testInMs).toBe(120_000)
  const plain = withEnv(DEFAULTS, { simulate: '95' })
  expect(plain.testPct).toBe(95)
  expect('testKind' in plain).toBe(false)
  expect('testInMs' in plain).toBe(false)
  const soon = withEnv(DEFAULTS, { simulate: ' 95  in 90s ' })
  expect(soon.testPct).toBe(95)
  expect('testKind' in soon).toBe(false)
  expect(soon.testInMs).toBe(90_000)
  expect(withEnv(DEFAULTS, { simulate: '95 5h' }).testKind).toBeUndefined()
  for (const junk of ['95 monthly', '95 in 5s', '95 in', 'weekly 95', 'off', '95 weekly weekly']) {
    const e = withEnv(DEFAULTS, { simulate: junk })
    expect(e.testPct).toBeUndefined()
    expect(e.testKind).toBeUndefined()
    expect(e.testInMs).toBeUndefined()
    expect(e.warnings).toEqual([])
  }
})

test('watchedKinds leaves the weekly window out at 0', () => {
  expect(watchedKinds(DEFAULTS)).toEqual(['five_hour', 'seven_day'])
  expect(watchedKinds({ weeklyReserve: 1 })).toEqual(['five_hour', 'seven_day'])
  expect(watchedKinds({ weeklyReserve: 0 })).toEqual(['five_hour'])
  expect(watchedKinds(withEnv(DEFAULTS, { weeklyReserve: '0' }))).toEqual(['five_hour'])
})

test('reserveOf gives each kind its reserve', () => {
  const s = { reserve: 15, weeklyReserve: 5 }
  expect(reserveOf(s, 'five_hour')).toBe(15)
  expect(reserveOf(s, 'seven_day')).toBe(5)
  expect(reserveOf(DEFAULTS, 'five_hour')).toBe(10)
  expect(reserveOf(DEFAULTS, 'seven_day')).toBe(10)
})

test('childHeadless gives stop for off and wait, nothing for prompt, stop or a set variable', () => {
  expect(childHeadless('off', false)).toBe('stop')
  expect(childHeadless('wait', false)).toBe('stop')
  expect(childHeadless('prompt', false)).toBeUndefined()
  expect(childHeadless('stop', false)).toBeUndefined()
  for (const h of ['off', 'prompt', 'stop', 'wait'] as const) expect(childHeadless(h, true)).toBeUndefined()
})

test('flagOnlyInShell is true only when the process has the flag and no settings source does', () => {
  const flag = { env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } }
  const other = { env: { FOO: '1' }, model: 'haiku' }
  expect(flagOnlyInShell(true, [{}, {}, {}, {}])).toBe(true)
  expect(flagOnlyInShell(true, [other, { env: null }, { env: 'x' }, {}])).toBe(true)
  expect(flagOnlyInShell(false, [{}, {}, {}, {}])).toBe(false)
  expect(flagOnlyInShell(true, [flag, {}, {}, {}])).toBe(false) // user
  expect(flagOnlyInShell(true, [{}, flag, {}, {}])).toBe(false) // project
  expect(flagOnlyInShell(true, [{}, {}, flag, {}])).toBe(false) // local
  expect(flagOnlyInShell(true, [{}, {}, {}, flag])).toBe(false) // policy
  expect(flagOnlyInShell(false, [flag])).toBe(false)
})

test('questionTimeout names askUserQuestionTimeout or CLAUDE_AFK_TIMEOUT_MS', () => {
  expect(questionTimeout({}, undefined)).toBeUndefined()
  expect(questionTimeout({ askUserQuestionTimeout: 60 }, undefined)).toBe('askUserQuestionTimeout')
  expect(questionTimeout({ askUserQuestionTimeout: 60 }, '60000')).toBe('askUserQuestionTimeout')
  expect(questionTimeout({}, '60000')).toBe('CLAUDE_AFK_TIMEOUT_MS')
  expect(questionTimeout({ askUserQuestionTimeout: 0 }, undefined)).toBeUndefined()
  expect(questionTimeout({ askUserQuestionTimeout: '60' }, undefined)).toBeUndefined()
  expect(questionTimeout({ askUserQuestionTimeout: null }, '1')).toBe('CLAUDE_AFK_TIMEOUT_MS')
})
