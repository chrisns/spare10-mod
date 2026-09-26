import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { realClock } from '../src/clock.ts'
import { writeJson } from '../src/files.ts'
import { sessionStore } from '../src/store.ts'
import { WAKE_POLL_MS } from '../src/timing.ts'
import { WAKE_FILES, fsWake } from '../src/wake.ts'
import type { WatchDir } from '../src/wake.ts'
import { fakeClock } from './helpers/clock.ts'
import { memoryLog } from './helpers/log.ts'
import { tempDir } from './helpers/tmp.ts'
import { memoryWake } from './helpers/wake.ts'

// The Wake source (Codex design 3.7): fs.watch on the session folder plus a 1 s poll in production, and the
// in-process emitter of the specs.

/** Resolves true at the first call of the returned `wake`, or false after `ms` of real time. */
function waiter(ms: number): { wake: () => void; woke: Promise<boolean> } {
  let wake = (): void => {}
  const ac = new AbortController()
  const woke = new Promise<boolean>((resolve) => {
    wake = () => {
      ac.abort()
      resolve(true)
    }
    void realClock.sleep(ms, ac.signal).then(() => resolve(false))
  })
  return { wake, woke }
}

test('fsWake: the poll compares the session files of design 3.7', () => {
  assert.deepEqual(WAKE_FILES, ['state.json', 'question.json', 'answer.json'])
  assert.equal(WAKE_POLL_MS, 1_000)
})

test('fsWake: a write of state.json by rename wakes a waiter through the file event', async (t) => {
  const dir = join(tempDir(t), 'sessions', 'S1')
  mkdirSync(dir, { recursive: true })
  const wake = fsWake(realClock, memoryLog())
  const w = waiter(3_000)
  const stop = wake.watch(dir, w.wake)
  t.after(stop)
  writeJson(join(dir, 'state.json'), { v: 1, rev: 1 })
  assert.equal(await w.woke, true)
})

/** Waits on real time until `done()` is true, for at most `ms`. */
async function until(done: () => boolean, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 20) {
    if (done()) return true
    await realClock.sleep(20)
  }
  return done()
}

test('fsWake: through the file events, a lock, a temp file and a thread file wake no waiter, and a write of state.json does', async (t) => {
  const data = tempDir(t)
  const clock = fakeClock(0) // the poll never runs: only the file events of fs.watch wake
  const wake = fsWake(clock, memoryLog())
  const store = sessionStore({ data }, '01a0da06-c266-7842-bc97-1128f6549960', 'test', wake)
  store.locked((tx) => {
    tx.state.attended = true // the folder and state.json exist before the watch
  })
  let woke = 0
  t.after(wake.watch(store.dir, () => (woke += 1)))
  await realClock.sleep(200) // the events of the set-up, if any come late
  woke = 0
  store.locked(() => undefined) // state.lock comes and goes, and nothing is written
  store.locked((tx) => {
    tx.thread('01a0da07-0000-7000-8000-00000000c41d').beat = 1 // threads/<tid>.json and state.lock only
  })
  writeFileSync(join(store.dir, 'state.json.1.ab.tmp'), '{}')
  await realClock.sleep(500)
  assert.equal(woke, 0, 'no session file changed')
  store.locked((tx) => {
    tx.state.attended = false
  })
  assert.equal(await until(() => woke > 0, 3_000), true, 'the write of state.json wakes')
})

/** A folder watch that never starts: only the poll sees a change. */
const noWatch: WatchDir = () => {
  throw new Error('no watch here')
}

/** A folder watch that the spec drives: `event(dir)` and `fail(dir)` act on the open watch of `dir`. */
function fakeWatch(): WatchDir & { event(dir: string): void; fail(dir: string): void; open(): string[]; starts: number } {
  const open = new Map<string, { onEvent: () => void; onError: (e: unknown) => void }>()
  const fake = Object.assign(
    (dir: string, onEvent: () => void, onError: (e: unknown) => void) => {
      fake.starts += 1
      open.set(dir, { onEvent, onError })
      return { close: () => void open.delete(dir) }
    },
    {
      starts: 0,
      event: (dir: string) => open.get(dir)?.onEvent(),
      fail: (dir: string) => open.get(dir)?.onError(new Error('EMFILE')),
      open: () => [...open.keys()],
    },
  )
  return fake
}

test('fsWake: with no file event, the poll wakes the waiter once per change', async (t) => {
  const dir = join(tempDir(t), 'sessions', 'S2')
  const clock = fakeClock(0)
  const wake = fsWake(clock, memoryLog(), { watchDir: noWatch })
  let woke = 0
  t.after(wake.watch(dir, () => (woke += 1)))
  await clock.advance(WAKE_POLL_MS)
  assert.equal(woke, 0)
  writeJson(join(dir, 'question.json'), { v: 1 })
  await clock.advance(WAKE_POLL_MS - 1)
  assert.equal(woke, 0, 'not before the next poll')
  await clock.advance(1)
  assert.equal(woke, 1)
  await clock.advance(WAKE_POLL_MS * 3)
  assert.equal(woke, 1, 'no new change, no wake')
  writeJson(join(dir, 'question.json'), { v: 1, n: 2 })
  writeJson(join(dir, 'answer.json'), { v: 1 })
  await clock.advance(WAKE_POLL_MS)
  assert.equal(woke, 2, 'two changes between two polls wake once')
  writeFileSync(join(dir, 'threads.json'), '{}')
  await clock.advance(WAKE_POLL_MS)
  assert.equal(woke, 2, 'the poll looks only at the three session files')
})

test('fsWake: a file event wakes once, the poll does not wake again for it, and the watch starts when the folder comes', async (t) => {
  const dir = join(tempDir(t), 'sessions', 'S5')
  const clock = fakeClock(0)
  const watch = fakeWatch()
  const wake = fsWake(clock, memoryLog(), { watchDir: watch })
  let woke = 0
  t.after(wake.watch(dir, () => (woke += 1)))
  assert.deepEqual(watch.open(), [dir])
  writeJson(join(dir, 'state.json'), { v: 1 })
  watch.event(dir)
  assert.equal(woke, 1)
  await clock.advance(WAKE_POLL_MS * 2)
  assert.equal(woke, 1, 'the event took the new marks, so the poll sees no change')
})

test('fsWake: a failed watch leaves a debug line, and the poll starts a new one', async (t) => {
  const dir = join(tempDir(t), 'sessions', 'S6')
  const clock = fakeClock(0)
  const log = memoryLog()
  const watch = fakeWatch()
  const wake = fsWake(clock, log, { watchDir: watch })
  let woke = 0
  const stop = wake.watch(dir, () => (woke += 1))
  t.after(stop)
  assert.equal(watch.starts, 1)
  watch.fail(dir)
  assert.deepEqual(watch.open(), [])
  assert.ok(log.lines.some((l) => l.startsWith('spare10: the watch of ') && l.includes('EMFILE')))
  await clock.advance(WAKE_POLL_MS)
  assert.equal(watch.starts, 2)
  assert.deepEqual(watch.open(), [dir])
  stop()
  assert.deepEqual(watch.open(), [], 'the last unwatch closes the watch')
  watch.event(dir)
  assert.equal(woke, 0)
})

test('fsWake: every waiter of the folder wakes, and the last unwatch stops the poll', async (t) => {
  const dir = join(tempDir(t), 'sessions', 'S3')
  const clock = fakeClock(0)
  const wake = fsWake(clock, memoryLog(), { watchDir: noWatch })
  const seen: string[] = []
  const stopA = wake.watch(dir, () => seen.push('a'))
  const stopB = wake.watch(dir, () => seen.push('b'))
  t.after(stopA)
  t.after(stopB)
  assert.equal(clock.pending(), 1, 'one poll per folder')
  writeJson(join(dir, 'answer.json'), { v: 1 })
  await clock.advance(WAKE_POLL_MS)
  assert.deepEqual(seen, ['a', 'b'])
  stopA()
  assert.equal(clock.pending(), 1)
  stopB()
  assert.equal(clock.pending(), 0)
  seen.length = 0
  writeJson(join(dir, 'answer.json'), { v: 1, n: 2 })
  await clock.advance(WAKE_POLL_MS * 2)
  assert.deepEqual(seen, [])
})

test('fsWake: a waiter that throws does not stop the others, and leaves a debug line', async (t) => {
  const dir = join(tempDir(t), 'sessions', 'S4')
  const clock = fakeClock(0)
  const log = memoryLog()
  const wake = fsWake(clock, log, { watchDir: noWatch })
  let ok = 0
  t.after(
    wake.watch(dir, () => {
      throw new Error('boom')
    }),
  )
  t.after(wake.watch(dir, () => (ok += 1)))
  writeJson(join(dir, 'state.json'), { v: 1 })
  await clock.advance(WAKE_POLL_MS)
  assert.equal(ok, 1)
  assert.ok(log.lines.some((l) => l.startsWith('spare10: a wake waiter failed') && l.includes('boom')))
})

test('fsWake: fire does nothing, because the file events do it', () => {
  const wake = fsWake(fakeClock(0), memoryLog())
  wake.fire('/nowhere')
})

test('memoryWake: a fire wakes every waiter of that folder, in a microtask, and no other folder', async () => {
  const wake = memoryWake()
  const seen: string[] = []
  const stopA = wake.watch('/data/sessions/S1', () => seen.push('a'))
  wake.watch('/data/sessions/S1/', () => seen.push('b'))
  wake.watch('/data/sessions/S2', () => seen.push('other'))
  wake.fire('/data/sessions/S1')
  assert.deepEqual(seen, [], 'never inside the write that fired')
  await Promise.resolve()
  assert.deepEqual(seen, ['a', 'b'])
  stopA()
  assert.equal(wake.waiters('/data/sessions/S1'), 1)
  wake.fire('/data/sessions/./S1')
  await Promise.resolve()
  assert.deepEqual(seen, ['a', 'b', 'b'])
  assert.deepEqual(wake.fired, ['/data/sessions/S1', '/data/sessions/S1'])
})

test('memoryWake: a waiter removed before the microtask runs is not called', async () => {
  const wake = memoryWake()
  let calls = 0
  const stop = wake.watch('/d', () => (calls += 1))
  wake.fire('/d')
  stop()
  await Promise.resolve()
  assert.equal(calls, 0)
  assert.equal(wake.waiters('/d'), 0)
})
