import { test, expect } from 'claude-code/testing'
import {
  DEFAULTS,
  flagOnlyInShell,
  fromOptions,
  parseBadge,
  parseHeadless,
  parsePausePrompt,
  parseReserve,
  parseScope,
  parseSwitch,
  questionTimeout,
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
  expect(DEFAULTS).toEqual({ reserve: 10, pausePrompt: null, headless: 'off', scope: 'all', badge: true })
  expect(fromOptions({ reserve: 10, pausePrompt: '', headless: 'off', scope: 'all', badge: true })).toEqual(DEFAULTS)
  const s = fromOptions({ reserve: 20.04, pausePrompt: 'Wrap up.', headless: 'stop', scope: 'opt-in', badge: false, extra: 'x', window: 'both' })
  expect(s).toEqual({ reserve: 20, pausePrompt: 'Wrap up.', headless: 'stop', scope: 'opt-in', badge: false })
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
  expect(h.warnings).toEqual(['SPARE10_HEADLESS="loud" is not off, prompt or stop. spare10 uses off.'])
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
