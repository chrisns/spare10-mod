import { test, expect } from 'claude-code/testing'
import {
  DEFAULTS,
  NO_SPANS,
  childHeadless,
  flagOnlyInShell,
  floorOf,
  fromOptions,
  parseAutoResume,
  parseBadge,
  parseHeadless,
  parseLastMinutes,
  parsePausePrompt,
  parseReserve,
  parseResumeFloor,
  parseScope,
  parseSwitch,
  parseWeeklyLastHours,
  parseWeeklyReserve,
  questionTimeout,
  reserveOf,
  spanOf,
  unreadEnv,
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
  expect(DEFAULTS).toEqual({
    reserve: 10,
    weeklyReserve: 10,
    lastMinutes: 20,
    weeklyLastHours: 8,
    resumeFloor: 5,
    weeklyResumeFloor: 5,
    pausePrompt: null,
    autoResume: true,
    headless: 'off',
    scope: 'all',
    badge: true,
  })
  expect(fromOptions({ reserve: 10, pausePrompt: '', headless: 'off', scope: 'all', badge: true })).toEqual(DEFAULTS)
  const s = fromOptions({ reserve: 20.04, pausePrompt: 'Wrap up.', headless: 'stop', scope: 'opt-in', badge: false, extra: 'x', window: 'both' })
  expect(s).toEqual({
    reserve: 20,
    weeklyReserve: 10,
    lastMinutes: 20,
    weeklyLastHours: 8,
    resumeFloor: 5,
    weeklyResumeFloor: 5,
    pausePrompt: 'Wrap up.',
    autoResume: true,
    headless: 'stop',
    scope: 'opt-in',
    badge: false,
  })
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
  expect(Object.keys(d).sort()).toEqual([
    'autoResume',
    'badge',
    'headless',
    'lastMinutes',
    'pausePrompt',
    'reserve',
    'resumeFloor',
    'scope',
    'weeklyLastHours',
    'weeklyReserve',
    'weeklyResumeFloor',
  ])
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
  expect(plain.from).toEqual({
    reserve: 'option',
    weeklyReserve: 'option',
    lastMinutes: 'option',
    weeklyLastHours: 'option',
    resumeFloor: 'option',
    weeklyResumeFloor: 'option',
    pausePrompt: 'option',
    autoResume: 'option',
    headless: 'option',
    enabled: 'scope',
  })
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

// ---- Skip near the reset (skip design 5, 7.2) ----

test('parseLastMinutes takes 0 to 299 with one decimal', () => {
  expect(parseLastMinutes(0)).toBe(0)
  expect(parseLastMinutes('0')).toBe(0)
  expect(parseLastMinutes(20)).toBe(20)
  expect(parseLastMinutes('2.55')).toBe(2.6)
  expect(parseLastMinutes(' 30 ')).toBe(30)
  expect(parseLastMinutes(299)).toBe(299)
  expect(Object.is(parseLastMinutes(-0.04), 0)).toBe(true) // rounded first, and never -0
  expect(parseLastMinutes(-0.05)).toBe(0) // rounded first, as parseWeeklyReserve
  for (const bad of [300, 299.1, -1, -0.06, 'x', '', ' ', null, undefined, true, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(parseLastMinutes(bad)).toBeUndefined()
  }
})

test('parseWeeklyLastHours takes 0 to 167 with one decimal', () => {
  expect(parseWeeklyLastHours(0)).toBe(0)
  expect(parseWeeklyLastHours(8)).toBe(8)
  expect(parseWeeklyLastHours(0.5)).toBe(0.5)
  expect(parseWeeklyLastHours('12.34')).toBe(12.3)
  expect(parseWeeklyLastHours(167)).toBe(167)
  for (const bad of [168, 167.1, -1, 'x', '', null, undefined, false]) expect(parseWeeklyLastHours(bad)).toBeUndefined()
})

test('fromOptions fills lastMinutes 20 and weeklyLastHours 8', () => {
  const d = fromOptions({})
  expect(Object.keys(d)).toHaveLength(11)
  expect(d.lastMinutes).toBe(20)
  expect(d.weeklyLastHours).toBe(8)
  expect(fromOptions({ lastMinutes: 0, weeklyLastHours: 0 })).toEqual({ ...DEFAULTS, lastMinutes: 0, weeklyLastHours: 0 })
  expect(fromOptions({ lastMinutes: 30.04, weeklyLastHours: '12' })).toEqual({ ...DEFAULTS, lastMinutes: 30, weeklyLastHours: 12 })
  // Out of range: the default, without a word (an option has no warning, as weeklyReserve).
  expect(fromOptions({ lastMinutes: 300, weeklyLastHours: 168 })).toEqual(DEFAULTS)
  expect(fromOptions({ lastMinutes: -5, weeklyLastHours: 'lots' })).toEqual(DEFAULTS)
})

test('withEnv: SPARE10_LAST_MINUTES and SPARE10_WEEKLY_LAST_HOURS override, bad values warn', () => {
  const plain = withEnv(DEFAULTS, {})
  expect(plain.from.lastMinutes).toBe('option')
  expect(plain.from.weeklyLastHours).toBe('option')
  expect(plain.warnings).toEqual([])
  const off = withEnv(DEFAULTS, { lastMinutes: '0', weeklyLastHours: ' 0 ' })
  expect(off.lastMinutes).toBe(0)
  expect(off.weeklyLastHours).toBe(0)
  expect(off.from.lastMinutes).toBe('env')
  expect(off.from.weeklyLastHours).toBe('env')
  expect(off.warnings).toEqual([])
  const on = withEnv({ ...DEFAULTS, lastMinutes: 0 }, { lastMinutes: '45.55', weeklyLastHours: '24' })
  expect(on.lastMinutes).toBe(45.6)
  expect(on.weeklyLastHours).toBe(24)
  const bad = withEnv(DEFAULTS, { lastMinutes: '300', weeklyLastHours: 'x' })
  expect(bad.lastMinutes).toBe(20)
  expect(bad.weeklyLastHours).toBe(8)
  expect(bad.from.lastMinutes).toBe('option')
  expect(bad.from.weeklyLastHours).toBe('option')
  expect(bad.warnings).toEqual([
    'SPARE10_LAST_MINUTES="300" is not 0 to 299. spare10 uses 20.',
    'SPARE10_WEEKLY_LAST_HOURS="x" is not 0 to 167. spare10 uses 8.',
  ])
  expect(withEnv({ ...DEFAULTS, lastMinutes: 2.5, weeklyLastHours: 0 }, { lastMinutes: '-1', weeklyLastHours: '168' }).warnings).toEqual([
    'SPARE10_LAST_MINUTES="-1" is not 0 to 299. spare10 uses 2.5.',
    'SPARE10_WEEKLY_LAST_HOURS="168" is not 0 to 167. spare10 uses 0.',
  ])
})

test('unreadEnv keeps the options but sets both spans to 0 from unread', () => {
  const base = { ...DEFAULTS, reserve: 15, lastMinutes: 30, weeklyLastHours: 12, autoResume: false }
  const u = unreadEnv(base)
  expect(u.lastMinutes).toBe(0)
  expect(u.weeklyLastHours).toBe(0)
  expect(u.from.lastMinutes).toBe('unread')
  expect(u.from.weeklyLastHours).toBe('unread')
  // Every other field is the D0.2 fallback: the options only.
  const plain = withEnv(base, {})
  expect({ ...u, lastMinutes: plain.lastMinutes, weeklyLastHours: plain.weeklyLastHours, from: plain.from }).toEqual(plain)
  expect(u.reserve).toBe(15)
  expect(u.autoResume).toBe(false)
  expect(u.warnings).toEqual([])
})

test('spanOf gives minutes and hours in ms, and 0 when off', () => {
  expect(spanOf(DEFAULTS, 'five_hour')).toBe(20 * 60_000)
  expect(spanOf(DEFAULTS, 'seven_day')).toBe(8 * 3_600_000)
  expect(spanOf({ lastMinutes: 2.5, weeklyLastHours: 0.1 }, 'five_hour')).toBe(150_000)
  expect(spanOf({ lastMinutes: 2.5, weeklyLastHours: 0.1 }, 'seven_day')).toBe(360_000)
  expect(spanOf(NO_SPANS, 'five_hour')).toBe(0)
  expect(spanOf(NO_SPANS, 'seven_day')).toBe(0)
  expect(NO_SPANS).toEqual({ lastMinutes: 0, weeklyLastHours: 0 })
})

// ---- The resume floor (floor design 5, 7.2) ----

test('parseResumeFloor takes 0 to 99 with one decimal', () => {
  expect(parseResumeFloor(0)).toBe(0)
  expect(parseResumeFloor(5)).toBe(5)
  expect(parseResumeFloor('2.55')).toBe(2.6)
  expect(parseResumeFloor(' 7 ')).toBe(7)
  expect(parseResumeFloor(99)).toBe(99)
  expect(parseResumeFloor(-0.01)).toBe(0) // rounds to 0, never -0
  expect(Object.is(parseResumeFloor(-0.01), -0)).toBe(false)
  for (const bad of [100, 99.96, -1, 'x', '', ' ', null, undefined, true, Number.NaN]) expect(parseResumeFloor(bad)).toBeUndefined()
})

test('fromOptions fills resumeFloor 5 and weeklyResumeFloor 5', () => {
  const d = fromOptions({})
  expect(Object.keys(d)).toHaveLength(11)
  expect(d.resumeFloor).toBe(5)
  expect(d.weeklyResumeFloor).toBe(5)
  expect(fromOptions({ resumeFloor: 0, weeklyResumeFloor: 2.54 })).toEqual({ ...DEFAULTS, resumeFloor: 0, weeklyResumeFloor: 2.5 })
  expect(fromOptions({ resumeFloor: '3', weeklyResumeFloor: 12 })).toEqual({ ...DEFAULTS, resumeFloor: 3, weeklyResumeFloor: 12 })
  // Out of range: the default, without a word (an option has no warning, as weeklyReserve).
  expect(fromOptions({ resumeFloor: 100, weeklyResumeFloor: -1 })).toEqual(DEFAULTS)
  expect(fromOptions({ resumeFloor: 'lots', weeklyResumeFloor: '' })).toEqual(DEFAULTS)
})

test('withEnv: SPARE10_RESUME_FLOOR and SPARE10_WEEKLY_RESUME_FLOOR override, bad values warn', () => {
  const plain = withEnv(DEFAULTS, {})
  expect(plain.from.resumeFloor).toBe('option')
  expect(plain.from.weeklyResumeFloor).toBe('option')
  expect(plain.warnings).toEqual([])
  const set = withEnv(DEFAULTS, { resumeFloor: '0', weeklyResumeFloor: '2.5' })
  expect(set.resumeFloor).toBe(0)
  expect(set.weeklyResumeFloor).toBe(2.5)
  expect(set.from.resumeFloor).toBe('env')
  expect(set.from.weeklyResumeFloor).toBe('env')
  expect(set.warnings).toEqual([])
  const bad = withEnv({ ...DEFAULTS, resumeFloor: 3 }, { resumeFloor: 'x', weeklyResumeFloor: '100' })
  expect(bad.resumeFloor).toBe(3)
  expect(bad.weeklyResumeFloor).toBe(5)
  expect(bad.from.resumeFloor).toBe('option')
  expect(bad.from.weeklyResumeFloor).toBe('option')
  expect(bad.warnings).toEqual([
    'SPARE10_RESUME_FLOOR="x" is not 0 to 99. spare10 uses 3.',
    'SPARE10_WEEKLY_RESUME_FLOOR="100" is not 0 to 99. spare10 uses 5.',
  ])
})

test('withEnv warns about a floor at or above its reserve, and not for 0 or an unwatched weekly window', () => {
  const at = withEnv(DEFAULTS, { resumeFloor: '10' })
  expect(at.warnings).toEqual(['the resume floor (10%) is not below the reserve (10%), so it does nothing. Set it below the reserve, or to 0.'])
  expect(withEnv(DEFAULTS, { resumeFloor: '9.9' }).warnings).toEqual([])
  expect(withEnv(DEFAULTS, { resumeFloor: '0', weeklyResumeFloor: '0' }).warnings).toEqual([])
  expect(withEnv(DEFAULTS, { weeklyResumeFloor: '12' }).warnings).toEqual([
    'the weekly resume floor (12%) is not below the weekly reserve (10%), so it does nothing. Set it below the weekly reserve, or to 0.',
  ])
  // The weekly warning needs the weekly window watched.
  expect(withEnv({ ...DEFAULTS, weeklyReserve: 0 }, { weeklyResumeFloor: '12' }).warnings).toEqual([])
  // A reserve that an env value lowers counts: the default floor 5 at a reserve of 5 warns.
  expect(withEnv(DEFAULTS, { reserve: '5' }).warnings).toEqual([
    'the resume floor (5%) is not below the reserve (5%), so it does nothing. Set it below the reserve, or to 0.',
  ])
  // The B27 warnings come first, then the floor warnings (after the overrides).
  expect(withEnv(DEFAULTS, { resumeFloor: '12', weeklyReserve: 'x' }).warnings).toEqual([
    'SPARE10_WEEKLY_RESERVE="x" is not 0 or 1 to 99. spare10 uses 10.',
    'the resume floor (12%) is not below the reserve (10%), so it does nothing. Set it below the reserve, or to 0.',
  ])
})

test('floorOf gives the floor in force per kind, and 0 when off or not below the reserve', () => {
  expect(floorOf(DEFAULTS, 'five_hour')).toBe(5)
  expect(floorOf(DEFAULTS, 'seven_day')).toBe(5)
  expect(floorOf({ ...DEFAULTS, resumeFloor: 0 }, 'five_hour')).toBe(0)
  expect(floorOf({ ...DEFAULTS, resumeFloor: 0 }, 'seven_day')).toBe(5) // floors are per window (B54)
  expect(floorOf({ ...DEFAULTS, resumeFloor: 10 }, 'five_hour')).toBe(0)
  expect(floorOf({ ...DEFAULTS, resumeFloor: 9.9 }, 'five_hour')).toBe(9.9)
  expect(floorOf({ ...DEFAULTS, reserve: 5 }, 'five_hour')).toBe(0)
  expect(floorOf({ ...DEFAULTS, weeklyReserve: 20, weeklyResumeFloor: 12 }, 'seven_day')).toBe(12)
  expect(floorOf({ ...DEFAULTS, weeklyReserve: 0 }, 'seven_day')).toBe(0)
})

test('unreadEnv keeps the option floors', () => {
  const u = unreadEnv({ ...DEFAULTS, resumeFloor: 3, weeklyResumeFloor: 0 })
  expect(u.resumeFloor).toBe(3)
  expect(u.weeklyResumeFloor).toBe(0)
  expect(u.from.resumeFloor).toBe('option')
  expect(u.from.weeklyResumeFloor).toBe('option')
  expect(u.warnings).toEqual([])
  // Its floor warnings come from the options.
  expect(unreadEnv({ ...DEFAULTS, resumeFloor: 15 }).warnings).toEqual([
    'the resume floor (15%) is not below the reserve (10%), so it does nothing. Set it below the reserve, or to 0.',
  ])
})
