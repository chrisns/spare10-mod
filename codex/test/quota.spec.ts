import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { codexDebug, voidedByReset } from '../../hooks/core/codex.ts'
import { VERSION } from '../../hooks/core/text.ts'
import { readJson, writeJson } from '../src/files.ts'
import type { Paths } from '../src/paths.ts'
import { createQuota } from '../src/quota.ts'
import type { LiveErrorFile, LiveFile, QuotaCtx, SeedFile } from '../src/quota.ts'
import { createRollouts } from '../src/rollout.ts'
import { sessionStore } from '../src/store.ts'
import { A_NEAR_MS, A_READ_MS, FIRST_READ_WAIT_MS, LIVE_NEAR_MAX_AGE_MS } from '../src/timing.ts'
import { fakeClock } from './helpers/clock.ts'
import { memoryLog } from './helpers/log.ts'
import { memoryDaemon } from './helpers/memory-daemon.ts'
import { fakeRollout } from './helpers/rollout.ts'
import { tempDir } from './helpers/tmp.ts'
import { memoryWake } from './helpers/wake.ts'

// The quota sources (Codex design 3.6, 8.2 quota.spec): route A through live.json and live.lock, route C
// through the own rollout and seed.json, the present kinds, blindness, credits and the near-trip read.
//
// The kit port (8.2). The gate half of each case (pass, trip, ask) comes with sense.spec and gate.spec.
// Each tests/kit case and the Codex case that tests it: codex/test/kit-port.txt, kept complete by kit-port.spec.ts.

const T0 = Date.UTC(2026, 8, 26, 10)
const SEC = 1_000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const SID = '01a0da06-c266-7842-bc97-1128f6549960'
const FIVE_RESET = T0 + 2 * HOUR
const WEEK_RESET = T0 + 3 * 24 * HOUR
const five = (pct: number, reset = FIVE_RESET) => ({ pct, mins: 300, resetsAt: reset })
const week = (pct: number, reset = WEEK_RESET) => ({ pct, mins: 10080, resetsAt: reset })

type Credits = { hasCredits?: boolean; unlimited?: boolean; balance?: string | null }

/** An account/rateLimits/read result of the probed shape (quota 2.1). */
function reply(o: { five?: number; week?: number; credits?: Credits | null; allowed?: boolean | null } = {}) {
  const win = (pct: number | undefined, mins: number, reset: number) =>
    pct === undefined ? null : { usedPercent: pct, windowDurationMins: mins, resetsAt: Math.floor(reset / 1000) }
  const codex = {
    limitId: 'codex',
    limitName: null,
    primary: win(o.five, 300, FIVE_RESET),
    secondary: win(o.week, 10080, WEEK_RESET),
    credits: o.credits === undefined ? { hasCredits: false, unlimited: false, balance: '0' } : o.credits,
    spendControlReached: false,
    planType: 'prolite',
    rateLimitReachedType: null,
  }
  return { ordinaryUsageAllowed: o.allowed === undefined ? true : o.allowed, rateLimits: codex, rateLimitsByLimitId: { codex } }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve = (_v: T): void => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function world(t: Parameters<typeof tempDir>[0]) {
  const root = tempDir(t)
  const data = join(root, 'data')
  const paths: Paths = { codexHome: root, data, pluginRoot: root, socket: join(root, 'daemon.sock'), launcher: join(data, 'bin', 'spare10'), bin: join(data, 'bin'), home: join(root, 'home') }
  const clock = fakeClock(T0)
  const log = memoryLog()
  const daemon = memoryDaemon(clock)
  const link = { socket: true, get: () => (link.socket ? daemon : undefined) }
  const wake = memoryWake()
  const store = (sid = SID) => sessionStore({ data }, sid, 'b', wake, { clock })
  const quota = (owner = 'broker-1') => createQuota({ paths, clock, log, owner, daemon: link, rollouts: createRollouts() })
  const rollout = (name = 'rollout.jsonl') => fakeRollout(join(root, 'sessions', name))
  const sx = (transcript: string | null, sid = SID): QuotaCtx => ({ transcript, store: store(sid) })
  const file = (name: string) => join(data, name)
  return { root, data, paths, clock, log, daemon, link, store, quota, rollout, sx, file }
}

test('quota: route A writes live.json with the read, the file fields and the blind history', async (t) => {
  const w = world(t)
  w.daemon.script.rateLimits = reply({ week: 96 })
  const q = w.quota()
  const r = await q.live(30_000)
  assert.ok(r !== undefined)
  assert.equal(r.at, T0)
  assert.equal(r.route, 'daemon')
  assert.equal(r.allowed, true)
  assert.deepEqual(w.daemon.callsOf('rateLimits'), [[A_READ_MS]])
  const f = readJson<LiveFile>(w.file('live.json'))
  assert.deepEqual(f, { ...r, v: 1, by: VERSION, recent: [r.codex] })
  assert.equal(statSync(w.file('live.json')).mode & 0o777, 0o600)
  assert.equal(existsSync(w.file('live.lock')), false)
  assert.equal(existsSync(w.file('live-error.json')), false)
})

test('quota: a young live.json answers with no read, and an old one reads again', async (t) => {
  const w = world(t)
  w.daemon.script.rateLimits = reply({ five: 40 })
  const q = w.quota()
  await q.live(30_000)
  await w.clock.advance(29 * SEC)
  const again = await q.live(30_000)
  assert.equal(again?.at, T0)
  assert.equal(w.daemon.callsOf('rateLimits').length, 1)
  await w.clock.advance(1 * SEC)
  assert.equal((await q.live(30_000))?.at, T0 + 30 * SEC)
  assert.equal(w.daemon.callsOf('rateLimits').length, 2)
  const f = readJson<LiveFile>(w.file('live.json'))
  assert.equal(f?.recent.length, 2, 'the last two good reads')
})

test('quota: a failed read writes live-error.json, keeps live.json, and logs a line', async (t) => {
  const w = world(t)
  w.daemon.script.rateLimits = reply({ five: 92 })
  const q = w.quota()
  const good = await q.live(30_000)
  const before = readFileSync(w.file('live.json'), 'utf8')
  await w.clock.advance(MIN)
  w.daemon.script.rateLimits = new Error('codex account authentication required to read rate limits')
  assert.equal(await q.live(30_000), undefined)
  assert.equal(readFileSync(w.file('live.json'), 'utf8'), before)
  assert.deepEqual(readJson<LiveErrorFile>(w.file('live-error.json')), {
    v: 1,
    by: VERSION,
    at: T0 + MIN,
    route: 'daemon',
    error: 'codex account authentication required to read rate limits',
  })
  assert.deepEqual(w.log.lines, [codexDebug.liveFailed('daemon', 'codex account authentication required to read rate limits')])
  // The view keeps the trip of the last good read, and names the newer failure.
  const v = q.view(w.sx(null), w.clock.now())
  assert.equal(v.readings.five_hour?.pct, 92)
  assert.equal(v.own.five_hour?.from, 'daemon')
  assert.deepEqual(v.live, good)
  assert.deepEqual(v.liveError, { at: T0 + MIN, error: 'codex account authentication required to read rate limits' })
})

test('quota: an error reply of the daemon is a failed read', async (t) => {
  const w = world(t)
  w.daemon.script.rateLimits = { error: { code: -32600, message: 'not logged in' } }
  assert.equal(await w.quota().live(30_000), undefined)
  assert.equal(readJson<LiveErrorFile>(w.file('live-error.json'))?.error, 'not logged in')
  assert.equal(existsSync(w.file('live.json')), false)
})

test('quota: a read with no answer fails at its timeout on the broker clock', async (t) => {
  const w = world(t)
  w.daemon.script.rateLimits = () => new Promise(() => {})
  const q = w.quota()
  let done: unknown = 'pending'
  void q.live(30_000).then((r) => {
    done = r
  })
  await w.clock.advance(A_READ_MS - 1)
  assert.equal(done, 'pending')
  await w.clock.advance(1)
  assert.equal(done, undefined)
  assert.equal(readJson<LiveErrorFile>(w.file('live-error.json'))?.error, `no answer within ${A_READ_MS} ms`)
  assert.equal(existsSync(w.file('live.lock')), false)
})

test('quota: two quotas of one data dir share one read through live.lock', async (t) => {
  const w = world(t)
  const d = deferred<unknown>()
  w.daemon.script.rateLimits = () => d.promise
  const qa = w.quota('broker-a')
  const qb = w.quota('broker-b')
  const a = qa.live(30_000)
  await w.clock.settle()
  assert.ok(existsSync(w.file('live.lock')), 'broker a holds the lock')
  const b = qb.live(30_000)
  await w.clock.settle()
  d.resolve(reply({ five: 91 }))
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(w.daemon.callsOf('rateLimits').length, 1)
  assert.deepEqual(rb, ra)
  assert.equal(existsSync(w.file('live.lock')), false)
})

test('quota: two live calls of one quota at once make one read', async (t) => {
  const w = world(t)
  const d = deferred<unknown>()
  w.daemon.script.rateLimits = () => d.promise
  const q = w.quota()
  const a = q.live(30_000)
  const b = q.live(15_000, A_NEAR_MS)
  d.resolve(reply({ five: 10 }))
  assert.deepEqual(await a, await b)
  assert.equal(w.daemon.callsOf('rateLimits').length, 1)
})

test('quota: with no daemon socket, live reads nothing and the view uses the rollout only', async (t) => {
  const w = world(t)
  w.link.socket = false
  const q = w.quota()
  assert.equal(await q.live(30_000), undefined)
  assert.deepEqual(w.daemon.calls, [])
  assert.equal(existsSync(w.file('live-error.json')), false)
  const r = w.rollout().sessionMeta({ originator: 'codex-tui', source: 'cli' }).tokenCount({ at: T0 - MIN, primary: five(88), secondary: week(40) })
  const v = q.view(w.sx(r.path), T0)
  assert.equal(v.readings.five_hour?.live?.percentUsed, 88)
  assert.equal(v.own.five_hour?.from, 'rollout')
  assert.equal(v.live, undefined)
  assert.deepEqual(v.present, ['five_hour', 'seven_day'])
})

test('quota: the newer of the live read and the own rollout is the own reading of each kind', async (t) => {
  const w = world(t)
  w.daemon.script.rateLimits = reply({ five: 80, week: 30 })
  const q = w.quota()
  await q.live(30_000)
  const r = w.rollout().tokenCount({ at: T0 + SEC, primary: five(81) })
  const v = q.view(w.sx(r.path), T0 + SEC)
  assert.deepEqual(v.own.five_hour, { at: T0 + SEC, limit: { kind: 'five_hour', percentUsed: 81, resetsAt: new Date(FIVE_RESET).toISOString() }, from: 'rollout' })
  assert.equal(v.own.seven_day?.from, 'daemon')
  assert.equal(v.own.seven_day?.limit.percentUsed, 30)
})

test('quota: the own reading wins over an older seed.json, and a newer seed.json wins over an old own reading', (t) => {
  const w = world(t)
  const q = w.quota()
  writeJson(w.file('seed.json'), { v: 1, by: VERSION, five_hour: { pct: 50, resetsAtMs: FIVE_RESET + 20 * SEC, at: T0 - HOUR } } satisfies SeedFile)
  const r = w.rollout().tokenCount({ at: T0 - MIN, primary: five(70) })
  let v = q.view(w.sx(r.path), T0)
  assert.equal(v.readings.five_hour?.live?.percentUsed, 70)
  assert.equal(v.readings.five_hour?.pct, 70)
  assert.deepEqual(v.readings.five_hour?.seed, { pct: 70, resetsAtMs: FIVE_RESET }, 'picked by time, not by the later reset')
  // Another thread saw a newer reading.
  writeJson(w.file('seed.json'), { v: 1, by: VERSION, five_hour: { pct: 93, resetsAtMs: FIVE_RESET, at: T0 - SEC } } satisfies SeedFile)
  v = q.view(w.sx(r.path), T0)
  assert.equal(v.readings.five_hour?.live, undefined)
  assert.equal(v.readings.five_hour?.pct, 93)
  assert.deepEqual(v.readings.five_hour?.seed, { pct: 93, resetsAtMs: FIVE_RESET })
})

test('quota: seed.json answers when the thread has no reading, while its window lasts', (t) => {
  const w = world(t)
  const q = w.quota()
  writeJson(w.file('seed.json'), { v: 1, by: VERSION, seven_day: { pct: 96, resetsAtMs: WEEK_RESET, at: T0 - HOUR } } satisfies SeedFile)
  let v = q.view(w.sx(null), T0)
  assert.equal(v.readings.seven_day?.live, undefined)
  assert.equal(v.readings.seven_day?.pct, 96)
  assert.deepEqual(v.seed.seven_day, { pct: 96, resetsAtMs: WEEK_RESET, at: T0 - HOUR })
  v = q.view(w.sx(null), WEEK_RESET + SEC)
  assert.equal(v.readings.seven_day?.pct, undefined, 'past its reset')
  assert.deepEqual(v.readings.seven_day?.seed, { pct: 96, resetsAtMs: WEEK_RESET }, 'still the memory seed, for the reset margin')
})

test('quota: seed.json takes a newer own reading per kind with its time and credits, and is not written again for the same one', (t) => {
  const w = world(t)
  const q = w.quota()
  const r = w.rollout().tokenCount({ at: T0 - MIN, primary: five(61), secondary: week(20), credits: { has_credits: true, unlimited: false, balance: '12.50' } })
  q.view(w.sx(r.path), T0)
  const seed = readJson<SeedFile>(w.file('seed.json'))
  assert.deepEqual(seed, {
    v: 1,
    by: VERSION,
    five_hour: { pct: 61, resetsAtMs: FIVE_RESET, at: T0 - MIN },
    seven_day: { pct: 20, resetsAtMs: WEEK_RESET, at: T0 - MIN },
    credits: { at: T0 - MIN, value: { has_credits: true, unlimited: false, balance: '12.50' } },
  })
  const before = statSync(w.file('seed.json'))
  q.view(w.sx(r.path), T0 + SEC)
  assert.equal(statSync(w.file('seed.json')).ino, before.ino, 'no second write')
  r.tokenCount({ at: T0, primary: five(62) })
  q.view(w.sx(r.path), T0 + SEC)
  const next = readJson<SeedFile>(w.file('seed.json'))
  assert.deepEqual(next?.five_hour, { pct: 62, resetsAtMs: FIVE_RESET, at: T0 })
  assert.deepEqual(next?.seven_day, { pct: 20, resetsAtMs: WEEK_RESET, at: T0 - MIN })
})

test('quota: a window-less codex snapshot keeps both kinds watched, and makes no kind blind', async (t) => {
  const w = world(t)
  const q = w.quota()
  const r = w.rollout().windowless(T0 - 2 * SEC).windowless(T0 - SEC)
  let v = q.view(w.sx(r.path), T0)
  assert.deepEqual(v.present, ['five_hour', 'seven_day'])
  assert.equal(v.blind, false)
  w.daemon.script.rateLimits = reply({})
  await q.live(30_000)
  v = q.view(w.sx(r.path), T0)
  assert.deepEqual(v.present, ['five_hour', 'seven_day'], 'one live read with no window')
  assert.equal(v.blind, false)
  assert.equal(w.store().read().absentCount, undefined, 'no count was written')
})

test('quota: the first read of a rollout counts its newest observation only', (t) => {
  const w = world(t)
  const r = w.rollout().tokenCount({ at: T0 - 2 * MIN, primary: week(96) }).tokenCount({ at: T0 - MIN, primary: week(96) })
  assert.deepEqual(w.quota().view(w.sx(r.path), T0).present, ['five_hour', 'seven_day'])
  assert.deepEqual(w.store().read().absentCount, { five_hour: 1, seven_day: 0 })
})

test('quota: a kind is absent only after two observations in a row omit it (a weekly-only plan)', (t) => {
  const w = world(t)
  const q = w.quota()
  const r = w.rollout().tokenCount({ at: T0 - 2 * MIN, primary: week(96) })
  let v = q.view(w.sx(r.path), T0)
  assert.deepEqual(v.present, ['five_hour', 'seven_day'], 'one observation changes nothing')
  assert.deepEqual(w.store().read().absentCount, { five_hour: 1, seven_day: 0 })
  r.windowless(T0 - MIN)
  v = q.view(w.sx(r.path), T0)
  assert.deepEqual(v.present, ['five_hour', 'seven_day'], 'the 429 marker is no observation')
  r.tokenCount({ at: T0 - SEC, primary: week(96) })
  v = q.view(w.sx(r.path), T0)
  assert.deepEqual(v.present, ['seven_day'])
  const st = w.store().read()
  assert.deepEqual(st.absentCount, { five_hour: 2, seven_day: 0 })
  assert.equal(st.absentAt, T0 - SEC)
  // An observation with the kind makes it present at once.
  r.tokenCount({ at: T0, primary: five(10), secondary: week(96) })
  v = q.view(w.sx(r.path), T0 + SEC)
  assert.deepEqual(v.present, ['five_hour', 'seven_day'])
})

test('quota: a kind whose seed is in its window stays present', (t) => {
  const w = world(t)
  const q = w.quota()
  writeJson(w.file('seed.json'), { v: 1, by: VERSION, five_hour: { pct: 40, resetsAtMs: FIVE_RESET, at: T0 - 3 * HOUR } } satisfies SeedFile)
  const r = w.rollout().tokenCount({ at: T0 - 2 * MIN, primary: week(50) })
  q.view(w.sx(r.path), T0)
  r.tokenCount({ at: T0 - MIN, primary: week(51) })
  assert.deepEqual(q.view(w.sx(r.path), T0).present, ['five_hour', 'seven_day'])
  assert.deepEqual(w.store().read().absentCount, { five_hour: 2, seven_day: 0 })
  assert.deepEqual(q.view(w.sx(r.path), FIVE_RESET).present, ['seven_day'], 'the seed window ended')
})

test('quota: an observation that two brokers of a session see counts once', async (t) => {
  const w = world(t)
  w.daemon.script.rateLimits = reply({ week: 96 })
  const qa = w.quota('broker-a')
  const qb = w.quota('broker-b')
  await qa.live(30_000)
  qa.view(w.sx(null), T0)
  qb.view(w.sx(null), T0)
  assert.deepEqual(w.store().read().absentCount, { five_hour: 1, seven_day: 0 })
  await w.clock.advance(31 * SEC)
  await qb.live(30_000)
  assert.deepEqual(qa.view(w.sx(null), w.clock.now()).present, ['seven_day'])
  assert.deepEqual(w.store().read().absentCount, { five_hour: 2, seven_day: 0 })
})

test('quota: two good live reads with no window make the login blind, and a newer own observation ends it', async (t) => {
  const w = world(t)
  w.daemon.script.rateLimits = reply({})
  const q = w.quota()
  await q.live(30_000)
  assert.equal(q.view(w.sx(null), w.clock.now()).blind, false, 'one read')
  await w.clock.advance(31 * SEC)
  w.daemon.script.rateLimits = new Error('network')
  await q.live(30_000)
  assert.equal(q.view(w.sx(null), w.clock.now()).blind, false, 'a failed read is not a good read')
  await w.clock.advance(31 * SEC)
  w.daemon.script.rateLimits = reply({})
  await q.live(30_000)
  const old = w.rollout('old.jsonl').tokenCount({ at: T0 - HOUR, primary: five(70) })
  let v = q.view(w.sx(old.path), w.clock.now())
  assert.equal(v.blind, true)
  assert.deepEqual(v.present, ['five_hour', 'seven_day'], 'blind is not absent')
  assert.deepEqual(v.readings.five_hour, { seed: { pct: 70, resetsAtMs: FIVE_RESET } }, 'an older reading gives no live reading, only the seed')
  const r = w.rollout().tokenCount({ at: w.clock.now() + SEC, primary: five(20) })
  v = q.view(w.sx(r.path), w.clock.now() + SEC)
  assert.equal(v.blind, false)
  await w.clock.advance(31 * SEC)
  w.daemon.script.rateLimits = reply({ five: 20 })
  await q.live(30_000)
  assert.equal(q.view(w.sx(null), w.clock.now()).blind, false, 'a read with a window ends it')
})

test('quota: live reads with no codex bucket never make the login blind, and the rollout reading stays (3.6)', async (t) => {
  const w = world(t)
  const premium = { limitId: 'premium', limitName: null, primary: null, secondary: null, credits: null, spendControlReached: null, rateLimitReachedType: null }
  w.daemon.script.rateLimits = { ordinaryUsageAllowed: true, rateLimits: premium, rateLimitsByLimitId: { premium } }
  const q = w.quota()
  const r = w.rollout().tokenCount({ at: T0 - MIN, primary: five(95) })
  await q.live(30_000)
  await w.clock.advance(31 * SEC)
  await q.live(30_000)
  assert.deepEqual(readJson<LiveFile>(w.file('live.json'))?.recent, [null, null], 'a read with no codex bucket is kept as null')
  const v = q.view(w.sx(r.path), w.clock.now())
  assert.equal(v.blind, false)
  assert.equal(v.readings.five_hour?.live?.percentUsed, 95, 'the 95% rollout reading still counts')
  assert.deepEqual(v.present, ['five_hour', 'seven_day'])
})

test('quota: near a trip point the view reads the daemon first (live 15 s, 2 s timeout), and not below it', async (t) => {
  const w = world(t)
  const q = w.quota()
  w.daemon.script.rateLimits = reply({ five: 87 })
  const low = w.rollout('low.jsonl').tokenCount({ at: T0 - MIN, primary: five(80) })
  let v = await q.nearView(w.sx(low.path), { five_hour: { trip: 90 } })
  assert.equal(v.near, false)
  assert.deepEqual(w.daemon.calls, [])
  const high = w.rollout('high.jsonl').tokenCount({ at: T0 - MIN, primary: five(86) })
  v = await q.nearView(w.sx(high.path), { five_hour: { trip: 90 } })
  assert.deepEqual(w.daemon.callsOf('rateLimits'), [[A_NEAR_MS]])
  assert.equal(v.near, true)
  assert.equal(v.readings.five_hour?.pct, 87, 'the view after the read')
  await w.clock.advance(LIVE_NEAR_MAX_AGE_MS - SEC)
  await q.nearView(w.sx(high.path), { five_hour: { trip: 90 } })
  assert.equal(w.daemon.callsOf('rateLimits').length, 1, 'the read is young')
  // No point for the kind (not watched), or no daemon: no read.
  await w.clock.advance(MIN)
  await q.nearView(w.sx(high.path), {})
  w.link.socket = false
  assert.equal((await q.nearView(w.sx(high.path), { five_hour: { trip: 90 } })).near, true)
  assert.equal(w.daemon.callsOf('rateLimits').length, 1)
})

test('quota: a thread with no rollout reads the daemon at each tool and step gate, near or not (Q1)', async (t) => {
  const w = world(t)
  const q = w.quota()
  w.daemon.script.rateLimits = reply({ five: 80 })
  await q.live(30_000)
  // The thread spends, and no rollout of its own shows it: only the daemon does.
  w.daemon.script.rateLimits = reply({ five: 97 })
  await w.clock.advance(5 * MIN)
  const v = await q.nearView(w.sx(null), { five_hour: { trip: 90 } })
  assert.deepEqual(w.daemon.callsOf('rateLimits'), [[A_READ_MS], [A_NEAR_MS]])
  assert.equal(v.readings.five_hour?.pct, 97)
  assert.equal(v.own.five_hour?.from, 'daemon')
  await w.clock.advance(LIVE_NEAR_MAX_AGE_MS - SEC)
  await q.nearView(w.sx(null), {})
  assert.equal(w.daemon.callsOf('rateLimits').length, 2, 'a young read is not read again')
  await w.clock.advance(SEC)
  await q.nearView(w.sx(null), {})
  assert.equal(w.daemon.callsOf('rateLimits').length, 3, 'with no watched kind near too')
})

test('quota: without a daemon, a thread with no rollout has no own reading, and live.json counts as a seed (Q1)', async (t) => {
  const w = world(t)
  const q = w.quota()
  w.daemon.script.rateLimits = reply({ five: 92 })
  await q.live(30_000)
  w.link.socket = false
  await w.clock.advance(10 * MIN)
  const v = await q.nearView(w.sx(null), { five_hour: { trip: 90 } })
  assert.equal(w.daemon.callsOf('rateLimits').length, 1, 'no daemon, no read')
  assert.deepEqual(v.own, {}, 'no own reading')
  assert.equal(v.readings.five_hour?.live, undefined)
  assert.deepEqual(v.readings.five_hour?.seed, { pct: 92, resetsAtMs: FIVE_RESET })
  assert.equal(v.readings.five_hour?.pct, 92, 'it still trips, as a seed')
  assert.equal(v.live?.at, T0, 'the report still shows the last live read and its age')
  // A thread with a rollout keeps live.json as its own reading.
  const r = w.rollout().sessionMeta({ originator: 'codex-tui', source: 'cli' })
  assert.equal(q.view(w.sx(r.path), w.clock.now()).own.five_hour?.from, 'daemon')
})

test('quota: near counts a floor point too', (t) => {
  const w = world(t)
  const q = w.quota()
  const r = w.rollout().tokenCount({ at: T0 - MIN, primary: five(92) })
  assert.equal(q.view(w.sx(r.path), T0, { five_hour: { trip: 99, floorPoint: 95 } }).near, true)
  assert.equal(q.view(w.sx(r.path), T0, { five_hour: { trip: 99, floorPoint: 98 } }).near, false)
})

test('quota: the first gate waits for the first read at most 2 s, once', async (t) => {
  const w = world(t)
  w.daemon.script.rateLimits = () => new Promise(() => {})
  const q = w.quota()
  void q.live(30_000)
  let waited = false
  void q.awaitFirstRead().then(() => {
    waited = true
  })
  await w.clock.advance(FIRST_READ_WAIT_MS - 1)
  assert.equal(waited, false)
  await w.clock.advance(1)
  assert.equal(waited, true)
  let again = false
  void q.awaitFirstRead().then(() => {
    again = true
  })
  await w.clock.settle()
  assert.equal(again, true, 'the second gate does not wait')
})

test('quota: the first read settles at once with a young live.json or no daemon', async (t) => {
  const w = world(t)
  w.link.socket = false
  const q = w.quota()
  let settled = false
  void q.firstRead.then(() => {
    settled = true
  })
  await q.live(30_000)
  await w.clock.settle()
  assert.equal(settled, true)
  await q.awaitFirstRead()
  assert.equal(w.clock.pending(), 0, 'no timer left')
})

test('quota: credits come from the newest of the live read and the rollout', async (t) => {
  const w = world(t)
  w.daemon.script.rateLimits = reply({ five: 100, credits: { hasCredits: false, unlimited: true, balance: null } })
  const q = w.quota()
  await q.live(30_000)
  const r = w.rollout().tokenCount({ at: T0 - MIN, primary: five(99), credits: { has_credits: false, unlimited: false, balance: '0' } })
  let v = q.view(w.sx(r.path), T0)
  assert.deepEqual(v.credits, { hasCredits: false, unlimited: true, balance: null })
  assert.equal(v.creditsUsable, true)
  r.tokenCount({ at: T0 + SEC, primary: five(100), credits: { has_credits: true, unlimited: false, balance: '12.50' } })
  v = q.view(w.sx(r.path), T0 + SEC)
  assert.deepEqual(v.credits, { has_credits: true, unlimited: false, balance: '12.50' })
  assert.equal(v.creditsUsable, true)
  r.tokenCount({ at: T0 + 2 * SEC, primary: five(100), credits: { has_credits: false, unlimited: false, balance: '0' } })
  v = q.view(w.sx(r.path), T0 + 2 * SEC)
  assert.equal(v.creditsUsable, false)
  const none = w.quota().view(w.sx(null, 'OTHER'), T0)
  assert.deepEqual(none.credits, { has_credits: false, unlimited: false, balance: '0' }, 'seed.json keeps the newest own credits')
})

test('quota: a live.json of another format, or broken, counts as none', async (t) => {
  const w = world(t)
  mkdirSync(w.data, { recursive: true })
  writeFileSync(w.file('live.json'), JSON.stringify({ v: 2, at: T0, route: 'daemon' }))
  const q = w.quota()
  assert.equal(q.view(w.sx(null), T0).live, undefined)
  writeFileSync(w.file('live.json'), '{')
  assert.equal(q.view(w.sx(null), T0).live, undefined)
  assert.match(w.log.lines[0] ?? '', /^spare10: could not read .*live\.json: /)
  w.daemon.script.rateLimits = reply({ five: 1 })
  assert.equal((await q.live(30_000))?.at, T0, 'a broken live.json is read again')
})

test('quota: the reading of a kind is picked by time, so a reset credit voids an old consent and 30 s of jitter does not (A22)', async (t) => {
  const w = world(t)
  const q = w.quota()
  const consent = { until: FIVE_RESET } // a Resume of the window that ends at FIVE_RESET
  const r = w.rollout().tokenCount({ at: T0 - MIN, primary: five(92) })
  const endOf = (v: ReturnType<typeof q.view>): number => v.readings.five_hour?.seed?.resetsAtMs ?? Number.NaN
  // The next read of the same window: its reset jitters 30 s earlier. The newer read wins, and keeps the consent.
  w.daemon.script.rateLimits = { ...reply({}), rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 93, windowDurationMins: 300, resetsAt: Math.floor((FIVE_RESET - 30 * SEC) / 1000) }, secondary: null } } }
  await q.live(30_000)
  let v = q.view(w.sx(r.path), T0)
  assert.equal(endOf(v), FIVE_RESET - 30 * SEC)
  assert.equal(voidedByReset(consent, endOf(v)), false)
  // A reset credit: a new window, 5 h from now. The consent of the old window is void.
  await w.clock.advance(MIN)
  const newReset = w.clock.now() + 5 * HOUR
  w.daemon.script.rateLimits = { ...reply({}), rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: Math.floor(newReset / 1000) }, secondary: null } } }
  await q.live(30_000)
  v = q.view(w.sx(r.path), w.clock.now())
  assert.equal(v.readings.five_hour?.pct, 0)
  assert.equal(endOf(v), Math.floor(newReset / 1000) * 1000)
  assert.equal(voidedByReset(consent, endOf(v)), true)
})

test('quota: the count of an absent kind stops at two, so later observations write nothing', (t) => {
  const w = world(t)
  const q = w.quota()
  const r = w.rollout().tokenCount({ at: T0 - 3 * MIN, primary: week(96) })
  q.view(w.sx(r.path), T0)
  r.tokenCount({ at: T0 - 2 * MIN, primary: week(96) })
  q.view(w.sx(r.path), T0)
  const before = w.store().read()
  assert.deepEqual(before.absentCount, { five_hour: 2, seven_day: 0 })
  r.tokenCount({ at: T0 - MIN, primary: week(97) })
  assert.deepEqual(q.view(w.sx(r.path), T0).present, ['seven_day'])
  assert.equal(w.store().read().rev, before.rev)
})
