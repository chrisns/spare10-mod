import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_TIMER_MS, realClock } from '../src/clock.ts'
import { fakeClock } from './helpers/clock.ts'

// The Clock seam (Codex design 3.8): realClock on Node timers, and the fake clock of the specs (8.2).

test('realClock: now is wall-clock time', () => {
  const before = Date.now()
  const now = realClock.now()
  assert.ok(now >= before && now <= Date.now())
})

test('realClock: sleep resolves after the time', async () => {
  const t0 = Date.now()
  await realClock.sleep(25)
  assert.ok(Date.now() - t0 >= 20)
})

test('realClock: sleep resolves early and with no throw when the signal aborts', async () => {
  const ac = new AbortController()
  const t0 = Date.now()
  const slept = realClock.sleep(60_000, ac.signal)
  ac.abort()
  await slept
  assert.ok(Date.now() - t0 < 1_000)
})

test('realClock: sleep with a signal that aborted already resolves at once', async () => {
  const ac = new AbortController()
  ac.abort()
  const t0 = Date.now()
  await realClock.sleep(60_000, ac.signal)
  assert.ok(Date.now() - t0 < 1_000)
})

test('realClock: after runs once, and a cancel before it stops it', async () => {
  let ran = 0
  let cancelled = 0
  realClock.after(5, () => (ran += 1))
  realClock.after(5, () => (cancelled += 1)).cancel()
  await realClock.sleep(40)
  assert.equal(ran, 1)
  assert.equal(cancelled, 0)
})

test('realClock: every runs until a cancel, also a cancel from inside its own run', async () => {
  let runs = 0
  const t = realClock.every(5, () => {
    runs += 1
    if (runs === 3) t.cancel()
  })
  await realClock.sleep(120)
  assert.equal(runs, 3)
})

test('realClock: a wait longer than one Node timer does not fire at once', async () => {
  // Node clamps a delay above MAX_TIMER_MS to 1 ms. The clock chains timers instead.
  let ran = false
  const t = realClock.after(MAX_TIMER_MS + 1_000, () => (ran = true))
  const ac = new AbortController()
  const slept = realClock.sleep(MAX_TIMER_MS * 2, ac.signal)
  let woke = false
  void slept.then(() => (woke = true))
  await realClock.sleep(30)
  assert.equal(ran, false)
  assert.equal(woke, false)
  t.cancel()
  ac.abort()
  await slept
  assert.equal(woke, true)
})

test('fakeClock: time moves only in advance, and timers run in time order, then in arm order', async () => {
  const c = fakeClock(1_000)
  const seen: string[] = []
  c.after(300, () => seen.push(`b@${c.now()}`))
  c.after(100, () => seen.push(`a@${c.now()}`))
  c.after(300, () => seen.push(`c@${c.now()}`))
  c.after(500, () => seen.push(`late@${c.now()}`))
  assert.equal(c.now(), 1_000)
  await c.advance(300)
  assert.deepEqual(seen, ['a@1100', 'b@1300', 'c@1300'])
  assert.equal(c.now(), 1_300)
  assert.equal(c.pending(), 1)
  await c.advance(1_000)
  assert.deepEqual(seen.at(-1), 'late@1500')
  assert.equal(c.now(), 2_300)
})

test('fakeClock: the clock settles after each timer, so a chain of sleeps runs in one advance', async () => {
  const c = fakeClock(0)
  const seen: number[] = []
  const run = async (): Promise<void> => {
    await c.sleep(1_000)
    seen.push(c.now())
    await Promise.resolve()
    await c.sleep(1_000)
    seen.push(c.now())
    c.after(500, () => seen.push(c.now()))
  }
  void run()
  await c.advance(2_500)
  assert.deepEqual(seen, [1_000, 2_000, 2_500])
})

test('fakeClock: every re-arms, and a cancel inside its run stops it', async () => {
  const c = fakeClock(0)
  const at: number[] = []
  const t = c.every(30_000, () => {
    at.push(c.now())
    if (at.length === 3) t.cancel()
  })
  await c.advance(200_000)
  assert.deepEqual(at, [30_000, 60_000, 90_000])
  assert.equal(c.pending(), 0)
})

test('fakeClock: sleep resolves early at an abort, and leaves no timer behind', async () => {
  const c = fakeClock(0)
  const ac = new AbortController()
  let woke = false
  const slept = c.sleep(10_000, ac.signal).then(() => (woke = true))
  assert.equal(c.pending(), 1)
  ac.abort()
  await slept
  assert.equal(woke, true)
  assert.equal(c.pending(), 0)
  assert.equal(c.now(), 0)
})

test('fakeClock: a cancelled timer never runs, and advanceTo in the past moves no time', async () => {
  const c = fakeClock(5_000)
  let ran = false
  c.after(10, () => (ran = true)).cancel()
  await c.advanceTo(1_000)
  assert.equal(c.now(), 5_000)
  await c.advance(100)
  assert.equal(ran, false)
})
