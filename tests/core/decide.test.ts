import { test, expect } from 'claude-code/testing'
import {
  afterFailure,
  askVerdict,
  consentCovers,
  decide,
  formatStopped,
  parseStopped,
  phaseOf,
  shouldAbortTurn,
} from '../../hooks/core/decide.ts'
import type { Mode, PhaseInput, Site, Snapshot } from '../../hooks/core/decide.ts'
import type { Headless } from '../../hooks/core/config.ts'
import type { Basis } from '../../hooks/core/reading.ts'

const R = Date.parse('2026-09-24T15:00:00.000Z')
const T0 = Date.parse('2026-09-24T12:00:00Z')
const SITES: readonly Site[] = ['tool', 'step', 'prompt']

// A guarded, attended, tripped session in hold mode, not consented, not stopped.
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  site: 'tool',
  tripped: true,
  enabled: true,
  consented: false,
  attended: true,
  headless: 'off',
  mode: 'hold',
  person: false,
  stopped: false,
  mainTold: false,
  ...over,
})
const at = (site: Site, over: Partial<Snapshot> = {}) => decide(snap({ ...over, site }))
const PASS = { kind: 'pass', trip: false }
const THROUGH = { kind: 'pass', trip: true }
const HOLD = { kind: 'hold' }

test('passes when not tripped, when not guarded, and when consented', () => {
  for (const site of SITES) {
    for (const person of [false, true]) {
      expect(at(site, { tripped: false, person })).toEqual(PASS)
      expect(at(site, { tripped: false, person, stopped: true, attended: false, headless: 'stop' })).toEqual(PASS)
      expect(at(site, { enabled: false, person })).toEqual(THROUGH)
      expect(at(site, { enabled: false, person, attended: false, headless: 'stop' })).toEqual(THROUGH)
      expect(at(site, { enabled: false, person, stopped: true })).toEqual(THROUGH)
      expect(at(site, { consented: true, person })).toEqual(THROUGH)
      expect(at(site, { consented: true, person, stopped: true, mode: 'tell' })).toEqual(THROUGH)
      expect(at(site, { consented: true, person, attended: false, headless: 'stop' })).toEqual(THROUGH)
    }
  }
})

test('unattended off passes and marks the trip', () => {
  for (const site of SITES) {
    expect(at(site, { attended: false, headless: 'off' })).toEqual(THROUGH)
    expect(at(site, { attended: false, headless: 'off', person: true, stopped: true })).toEqual(THROUGH)
  }
})

test('unattended stop refuses tool and step and lets a prompt enter', () => {
  const u = { attended: false, headless: 'stop' as Headless }
  expect(at('tool', u)).toEqual({ kind: 'refuse', text: 'headless' })
  expect(at('step', u)).toEqual({ kind: 'refuse', text: 'headless' })
  expect(at('prompt', u)).toEqual(THROUGH)
  expect(at('prompt', { ...u, person: true })).toEqual(THROUGH)
  expect(at('tool', { ...u, mode: 'tell', stopped: true })).toEqual({ kind: 'refuse', text: 'headless' })
})

test('unattended prompt tells tool results and lets prompts enter', () => {
  const u = { attended: false, headless: 'prompt' as Headless }
  expect(at('tool', u)).toEqual({ kind: 'tell' })
  expect(at('step', u)).toEqual(THROUGH)
  expect(at('prompt', u)).toEqual(THROUGH)
  expect(at('prompt', { ...u, person: true })).toEqual(THROUGH)
})

test('stopped, in either mode: stop text for tools, paused text for steps, a person prompt asks again', () => {
  for (const mode of ['hold', 'tell'] as const) {
    for (const mainTold of [false, true]) {
      const s = { stopped: true, mode, mainTold }
      expect(at('tool', s)).toEqual({ kind: 'refuse', text: 'stop' })
      expect(at('step', s)).toEqual({ kind: 'refuse', text: 'paused' })
      expect(at('prompt', { ...s, person: true })).toEqual(HOLD)
      expect(at('prompt', { ...s, person: false })).toEqual(THROUGH)
    }
  }
})

test('tell mode: tool tells, step passes, a person prompt asks only while main is untold', () => {
  const t = { mode: 'tell' as Mode }
  expect(at('tool', t)).toEqual({ kind: 'tell' })
  expect(at('tool', { ...t, mainTold: true })).toEqual({ kind: 'tell' })
  expect(at('step', t)).toEqual(THROUGH)
  expect(at('prompt', { ...t, person: true })).toEqual(HOLD)
  expect(at('prompt', { ...t, person: true, mainTold: true })).toEqual(THROUGH)
  expect(at('prompt', { ...t, person: false })).toEqual(THROUGH)
})

test('hold mode: tool and step hold, a person prompt holds, other prompts pass', () => {
  expect(at('tool')).toEqual(HOLD)
  expect(at('step')).toEqual(HOLD)
  expect(at('prompt', { person: true })).toEqual(HOLD)
  expect(at('prompt', { person: false })).toEqual(THROUGH)
  expect(at('tool', { mainTold: true })).toEqual(HOLD)
})

test('askVerdict: only the exact yes label resumes', () => {
  expect(askVerdict('Resume', 'Resume')).toBe('resume')
  for (const answer of ['resume', ' Resume', 'Resume ', '', 'Resume, Stop here', 'keep going', 'Stop here', 'RESUME']) {
    expect(askVerdict(answer, 'Resume')).toBe('stop')
  }
})

test('afterFailure: replay after next, refuse while holding, pass while deciding', () => {
  expect(afterFailure(true, true)).toBe('replay')
  expect(afterFailure(true, false)).toBe('replay')
  expect(afterFailure(false, true)).toBe('refuse')
  expect(afterFailure(false, false)).toBe('pass')
})

test('consentCovers needs a time inside this window', () => {
  expect(consentCovers(R, T0, R)).toBe(true) // the window end
  expect(consentCovers(R + 60_000, T0, R)).toBe(true) // the minute of slack
  expect(consentCovers(T0 - 1, T0, R)).toBe(false) // expired
  expect(consentCovers(T0, T0, R)).toBe(false) // equal to now
  expect(consentCovers(R + 5 * 3_600_000 + 61_000, T0, R)).toBe(false) // one window ahead + 61 s
  expect(consentCovers(R + 61_000, T0, R)).toBe(false)
  expect(consentCovers(0, T0, R)).toBe(false)
})

test('parseStopped reads the three fields and refuses junk', () => {
  const rec = { sessionId: 'S1', windowEnd: R, at: T0 }
  expect(formatStopped(rec)).toBe(`S1 ${R} ${T0}`)
  expect(parseStopped(formatStopped(rec))).toEqual(rec)
  const uuid = { sessionId: '0f6c1c2e-8f7a-4c1e-9d55-2b8a1d3e4f50', windowEnd: R, at: T0 + 5 }
  expect(parseStopped(formatStopped(uuid))).toEqual(uuid)
  for (const junk of [undefined, '', 'S1', `S1 ${R}`, `S1 ${R} x`, ` ${R} ${T0}`, `S1 ${R} ${T0} extra`, `S1  ${R} ${T0}`, `S1 -1 ${T0}`]) {
    expect(parseStopped(junk)).toBeUndefined()
  }
})

test('shouldAbortTurn: attended always, unattended only on a repeat', () => {
  expect(shouldAbortTurn(true, false)).toBe(true)
  expect(shouldAbortTurn(true, true)).toBe(true)
  expect(shouldAbortTurn(false, false)).toBe(false)
  expect(shouldAbortTurn(false, true)).toBe(true)
})

const LIVE: Basis = { kind: 'live', pct: 95, resetsAtMs: R }
const BELOW: Basis = { kind: 'live', pct: 50, resetsAtMs: R }
const phase = (over: Partial<PhaseInput> = {}) =>
  phaseOf({ enabled: true, basis: LIVE, tripped: true, consented: false, stopped: false, asking: false, told: false, attended: true, ...over })

test('phaseOf ranks off, asking, blind, waiting, armed, consented, stopped, told, reserve, tripped', () => {
  const all = { consented: true, stopped: true, asking: true, told: true }
  expect(phase({ ...all, enabled: false })).toBe('off')
  expect(phase({ enabled: false, basis: { kind: 'none', why: 'blind' }, tripped: false })).toBe('off')
  expect(phase(all)).toBe('asking')
  expect(phase({ asking: true, basis: { kind: 'none', why: 'blind' }, tripped: false })).toBe('asking')
  expect(phase({ asking: true, basis: BELOW, tripped: false })).toBe('asking')
  expect(phase({ ...all, asking: false, basis: { kind: 'none', why: 'blind' }, tripped: false })).toBe('blind')
  expect(phase({ ...all, asking: false, basis: { kind: 'none', why: 'no-reading' }, tripped: false })).toBe('waiting')
  expect(phase({ ...all, asking: false, basis: { kind: 'none', why: 'window-reset' }, tripped: false })).toBe('waiting')
  expect(phase({ ...all, asking: false, basis: BELOW, tripped: false })).toBe('armed')
  expect(phase({ ...all, asking: false })).toBe('consented')
  expect(phase({ ...all, asking: false, consented: false })).toBe('stopped')
  expect(phase({ told: true })).toBe('told')
  expect(phase({ stopped: true, told: true, attended: false })).toBe('told')
  expect(phase({ attended: false })).toBe('reserve')
  expect(phase({ stopped: true, attended: false })).toBe('reserve')
  expect(phase()).toBe('tripped')
  expect(phase({ basis: { kind: 'seed', pct: 93, resetsAtMs: R } })).toBe('tripped')
  expect(phase({ basis: { kind: 'test', pct: 95, resetsAtMs: R } })).toBe('tripped')
})

test('phaseOf agrees with decide', () => {
  const bools = [false, true]
  const bases: Basis[] = [LIVE, BELOW, { kind: 'none', why: 'blind' }, { kind: 'none', why: 'no-reading' }]
  let checked = 0
  for (const enabled of bools)
    for (const b of bases)
      for (const consented of bools)
        for (const stopped of bools)
          for (const asking of bools)
            for (const told of bools)
              for (const attended of bools)
                for (const mode of ['hold', 'tell'] as const)
                  for (const headless of ['off', 'prompt', 'stop'] as const) {
                    const tripped = b.kind !== 'none' && b.pct >= 90
                    // A question opens only in a guarded session that is not consented.
                    if (asking && (!enabled || !attended || consented)) continue
                    const p = phaseOf({ enabled, basis: b, tripped, consented, stopped, asking, told, attended })
                    const d = (site: Site) =>
                      decide({ site, tripped, enabled, consented, attended, headless, mode, person: false, stopped, mainTold: told })
                    if (p === 'stopped') expect(d('tool')).toEqual({ kind: 'refuse', text: 'stop' })
                    if (p === 'consented' || p === 'off') for (const site of SITES) expect(d(site).kind).toBe('pass')
                    if (mode === 'hold' && (p === 'tripped' || (p === 'asking' && tripped && !stopped))) {
                      expect(d('tool')).toEqual(HOLD)
                      expect(d('step')).toEqual(HOLD)
                    }
                    checked += 1
                  }
  expect(checked).toBe(864)
})
