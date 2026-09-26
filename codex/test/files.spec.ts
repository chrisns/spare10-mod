import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  LockTimeout,
  ensureDir,
  firstLine,
  isTorn,
  pidAlive,
  readBack,
  readFrom,
  readJson,
  readOwnJson,
  tryLock,
  unlock,
  withLock,
  writeFileAtomic,
  writeJson,
} from '../src/files.ts'
import { tempDir } from './helpers/tmp.ts'

// The file work of Codex design 3.7 (8.2 files.spec): atomic writes, the one synchronous lock, and the reads
// of the rollout cursor (3.6).

const DEAD_PID = 99_999_999

/** Runs one lock-worker.ts with `job`, and resolves its message. */
function contender(job: object): Promise<{ owner: string; overlaps: number }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./helpers/lock-worker.ts', import.meta.url), { workerData: job })
    w.once('message', resolve)
    w.once('error', reject)
    w.once('exit', (code) => {
      if (code !== 0) reject(new Error(`lock worker exit ${code}`))
    })
  })
}

test('files: ensureDir makes folders with mode 0700, writeJson writes 0600 by rename and leaves no temp file', (t) => {
  const dir = join(tempDir(t), 'data', 'sessions', 'S1')
  ensureDir(dir)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  const file = join(dir, 'state.json')
  writeJson(file, { v: 1, rev: 1, sessionId: 'S1' })
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(readJson(file), { v: 1, rev: 1, sessionId: 'S1' })
  assert.equal(readFileSync(file, 'utf8'), '{\n  "v": 1,\n  "rev": 1,\n  "sessionId": "S1"\n}\n')
  writeJson(file, { v: 1, rev: 2 })
  assert.deepEqual(readJson(file), { v: 1, rev: 2 })
  assert.deepEqual(readdirSync(dir), ['state.json'])
})

test('files: writeJson makes the missing folders of the file', (t) => {
  const file = join(tempDir(t), 'a', 'b', 'c.json')
  writeJson(file, [1, 2])
  assert.deepEqual(readJson(file), [1, 2])
})

test('files: writeFileAtomic keeps the mode it gets, whatever the umask', (t) => {
  const file = join(tempDir(t), 'bin', 'spare10')
  const old = process.umask(0o077)
  try {
    writeFileAtomic(file, '#!/bin/sh\n', 0o755)
  } finally {
    process.umask(old)
  }
  assert.equal(statSync(file).mode & 0o777, 0o755)
})

test('files: readJson gives undefined for an absent file, and throws for bad JSON', (t) => {
  const dir = tempDir(t)
  assert.equal(readJson(join(dir, 'none.json')), undefined)
  assert.equal(readJson(join(dir, 'no', 'folder.json')), undefined)
  writeFileSync(join(dir, 'bad.json'), '{ "reserve": 15,')
  assert.throws(() => readJson(join(dir, 'bad.json')), SyntaxError)
  assert.throws(() => readJson(dir))
})

test('files: readOwnJson reads a file torn by an OS crash as absent, and still throws for other bad JSON', (t) => {
  const dir = tempDir(t)
  assert.equal(readOwnJson(join(dir, 'none.json')), undefined)
  for (const [name, text] of [
    ['empty', ''],
    ['blank', ' \n'],
    ['nul', '\0\0\0\0'],
    ['cut', '{\n  "v": 1,\n  "rev\0\0\0'],
  ] as const) {
    assert.equal(isTorn(text), true, name)
    writeFileSync(join(dir, `${name}.json`), text)
    assert.equal(readOwnJson(join(dir, `${name}.json`)), undefined, name)
    if (text.trim() === '') assert.throws(() => readJson(join(dir, `${name}.json`)), SyntaxError, `${name}: readJson keeps its rule`)
  }
  writeFileSync(join(dir, 'edit.json'), '{ not json')
  assert.equal(isTorn('{ not json'), false)
  assert.throws(() => readOwnJson(join(dir, 'edit.json')), SyntaxError, 'a person edit is not torn')
  writeJson(join(dir, 'ok.json'), { v: 1, text: 'a\u0000b' })
  assert.equal(isTorn(readFileSync(join(dir, 'ok.json'), 'utf8')), false, 'writeJson never writes a NUL byte')
  assert.deepEqual(readOwnJson(join(dir, 'ok.json')), { v: 1, text: 'a\u0000b' })
})

test('files: an atomic write is never seen half done by a reader', async (t) => {
  // A worker rewrites one big file again and again. Each read here parses and is whole.
  const file = join(tempDir(t), 'state.json')
  const big = (n: number): object => ({ v: 1, rev: n, pad: 'x'.repeat(200_000), end: n })
  writeJson(file, big(0))
  const code = `
    const { workerData, parentPort } = require('node:worker_threads')
    import(workerData.files).then(({ writeJson }) => {
      for (let n = 1; n <= 60; n += 1) writeJson(workerData.file, { v: 1, rev: n, pad: 'x'.repeat(200000), end: n })
      parentPort.postMessage('done')
    })
  `
  const files = new URL('../src/files.ts', import.meta.url).href
  const w = new Worker(code, { eval: true, workerData: { file, files } })
  let done = false
  w.once('message', () => (done = true))
  let reads = 0
  while (!done) {
    const v = readJson<{ rev: number; end: number; pad: string }>(file)
    assert.ok(v !== undefined)
    assert.equal(v.rev, v.end)
    assert.equal(v.pad.length, 200_000)
    reads += 1
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.ok(reads > 0)
  assert.deepEqual(readJson(file), big(60))
  // The in-process writer, too: no temp file is left.
  for (let n = 0; n < 5; n += 1) writeJson(file, big(n))
  assert.deepEqual(readdirSync(join(file, '..')), ['state.json'])
})

test('files: two withLock callers in worker threads both finish, and never hold the lock at once', async (t) => {
  const dir = tempDir(t)
  const job = { lock: join(dir, 'state.lock'), marker: join(dir, 'marker'), journal: join(dir, 'journal'), rounds: 25, holdMs: 2 }
  const results = await Promise.all([contender({ ...job, owner: 'A' }), contender({ ...job, owner: 'B' })])
  assert.deepEqual(results.map((r) => r.overlaps), [0, 0])
  const lines = readFileSync(job.journal, 'utf8').trim().split('\n')
  assert.equal(lines.length, 100)
  for (let i = 0; i < lines.length; i += 2) {
    const owner = lines[i]?.split(' ')[0]
    assert.equal(lines[i], `${owner} in`)
    assert.equal(lines[i + 1], `${owner} out`, `an in with no out at line ${i + 1}`)
  }
  assert.ok(lines.includes('A in') && lines.includes('B in'))
  assert.equal(existsSync(job.lock), false)
})

test('files: withLock writes { owner, pid, at } and removes the lock after fn', (t) => {
  const lock = join(tempDir(t), 'sessions', 'S1', 'state.lock')
  const seen = withLock(lock, 'broker-1', () => JSON.parse(readFileSync(lock, 'utf8')) as Record<string, unknown>)
  assert.equal(seen.owner, 'broker-1')
  assert.equal(seen.pid, process.pid)
  assert.equal(typeof seen.at, 'number')
  assert.ok(Math.abs(Date.now() - (seen.at as number)) < 5_000)
  assert.equal(statSync(join(lock, '..')).mode & 0o777, 0o700, 'withLock makes a missing folder')
  assert.equal(existsSync(lock), false)
})

test('files: a stale lock by age is removed, and the create is tried again', (t) => {
  const lock = join(tempDir(t), 'state.lock')
  writeFileSync(lock, JSON.stringify({ owner: 'old', pid: process.pid, at: Date.now() - 6_000 }))
  const t0 = Date.now()
  assert.equal(withLock(lock, 'new', () => readFileSync(lock, 'utf8').includes('"new"')), true)
  assert.ok(Date.now() - t0 < 1_000)
  assert.equal(existsSync(lock), false)
  // A time far in the future (the wall clock went back) is stale too.
  writeFileSync(lock, JSON.stringify({ owner: 'future', pid: process.pid, at: Date.now() + 60_000 }))
  assert.equal(withLock(lock, 'new', () => 'ok'), 'ok')
})

test('files: a stale lock by a dead pid is removed at once', (t) => {
  const lock = join(tempDir(t), 'state.lock')
  writeFileSync(lock, JSON.stringify({ owner: 'gone', pid: DEAD_PID, at: Date.now() }))
  assert.equal(withLock(lock, 'new', () => 7), 7)
  writeFileSync(lock, JSON.stringify({ owner: 'fake', pid: 4242, at: Date.now() }))
  assert.equal(withLock(lock, 'new', () => 8, { pidAlive: (p) => p !== 4242 }), 8)
})

test('files: a live lock gives LockTimeout after the wait, and stays in place', (t) => {
  const lock = join(tempDir(t), 'state.lock')
  const held = JSON.stringify({ owner: 'busy', pid: process.pid, at: Date.now() })
  writeFileSync(lock, held)
  const t0 = Date.now()
  let ran = false
  assert.throws(
    () => withLock(lock, 'me', () => (ran = true), { waitMs: 80 }),
    (e: unknown) => e instanceof LockTimeout && e.name === 'LockTimeout' && e.holder?.owner === 'busy' && e.lockFile === lock,
  )
  const waited = Date.now() - t0
  assert.ok(waited >= 70 && waited < 1_500, `waited ${waited} ms`)
  assert.equal(ran, false)
  assert.equal(readFileSync(lock, 'utf8'), held)
})

test('files: a lock with no holder yet is busy while it is new, and stale by its mtime', (t) => {
  const lock = join(tempDir(t), 'state.lock')
  writeFileSync(lock, '')
  assert.throws(() => withLock(lock, 'me', () => 1, { waitMs: 30 }), LockTimeout)
  const old = (Date.now() - 10_000) / 1000
  utimesSync(lock, old, old)
  assert.equal(withLock(lock, 'me', () => 2), 2)
})

test('files: the release leaves a lock that another taker holds now', (t) => {
  const lock = join(tempDir(t), 'state.lock')
  const theirs = JSON.stringify({ owner: 'taker', pid: process.pid, at: Date.now() })
  withLock(lock, 'slow', () => writeFileSync(lock, theirs))
  assert.equal(readFileSync(lock, 'utf8'), theirs)
})

test('files: withLock releases when fn throws, and refuses async work', async (t) => {
  const lock = join(tempDir(t), 'state.lock')
  assert.throws(() => withLock(lock, 'me', () => {
    throw new Error('inside')
  }), /inside/)
  assert.equal(existsSync(lock), false)
  assert.throws(() => withLock(lock, 'me', async () => 1), /synchronous work only/)
  assert.equal(existsSync(lock), false)
})

test('files: pidAlive', () => {
  assert.equal(pidAlive(process.pid), true)
  assert.equal(pidAlive(1), true, 'pid 1 exists, and a signal to it gives EPERM')
  assert.equal(pidAlive(DEAD_PID), false)
  assert.equal(pidAlive(0), false)
  assert.equal(pidAlive(-1), false)
  assert.equal(pidAlive(1.5), false)
  assert.equal(pidAlive(Number.NaN), false)
})

/** Writes `lines` as a JSONL file, each with a newline, then `tail` with none. */
function jsonl(file: string, lines: readonly string[], tail = ''): number[] {
  const starts: number[] = []
  let at = 0
  for (const l of lines) {
    starts.push(at)
    at += Buffer.byteLength(l) + 1
  }
  writeFileSync(file, lines.map((l) => `${l}\n`).join('') + tail)
  return starts
}

test('files: readBack over a line cut in half leaves it out, and the next chunk has it whole', (t) => {
  const file = join(tempDir(t), 'rollout.jsonl')
  const lines = ['{"a":1}', '{"b":"é-long-line-here"}', '{"c":3}', '{"d":4}']
  const starts = jsonl(file, lines)
  const size = statSync(file).size
  // The chunk starts inside line b.
  const first = readBack(file, 0, size - (starts[1] ?? 0) - 4)
  assert.deepEqual(first?.lines, ['{"c":3}', '{"d":4}'])
  assert.equal(first?.start, starts[2])
  assert.equal(first?.end, size)
  assert.equal(first?.size, size)
  const next = readBack(file, size - (first?.start ?? 0), 64)
  assert.deepEqual(next?.lines, ['{"a":1}', '{"b":"é-long-line-here"}'])
  assert.equal(next?.start, 0)
  assert.equal(next?.end, starts[2])
})

test('files: readBack leaves out a last line with no newline, and a chunk that starts on a line start keeps it', (t) => {
  const file = join(tempDir(t), 'rollout.jsonl')
  const starts = jsonl(file, ['{"a":1}', '{"b":2}', '{"c":3}'], '{"half":')
  const whole = readBack(file, 0, 1_000)
  assert.deepEqual(whole?.lines, ['{"a":1}', '{"b":2}', '{"c":3}'])
  assert.equal(whole?.end, (starts[2] ?? 0) + 8)
  const size = statSync(file).size
  // A chunk that starts exactly at the start of line b.
  const exact = readBack(file, 0, size - (starts[1] ?? 0))
  assert.deepEqual(exact?.lines, ['{"b":2}', '{"c":3}'])
  assert.equal(exact?.start, starts[1])
})

test('files: readBack skips a line longer than the chunk, and gives the lines before it', (t) => {
  const file = join(tempDir(t), 'rollout.jsonl')
  const filler = `{"filler":"${'x'.repeat(5_000)}"}`
  const starts = jsonl(file, ['{"token_count":1}', filler, '{"tail":1}'])
  const size = statSync(file).size
  let fromEnd = 0
  const got: string[] = []
  let empty = 0
  for (let i = 0; i < 20 && fromEnd < size; i += 1) {
    const r = readBack(file, fromEnd, 1_024)
    assert.ok(r !== undefined)
    if (r.lines.length === 0) {
      // A chunk inside the filler: the scan goes on from the chunk start.
      empty += 1
      assert.equal(r.start, Math.max(0, size - fromEnd - 1_024))
    }
    got.unshift(...r.lines)
    assert.ok(size - r.start > fromEnd || r.start === 0, 'the scan moves back at each chunk')
    fromEnd = size - r.start
    if (r.start === 0) break
  }
  assert.deepEqual(got, ['{"token_count":1}', '{"tail":1}'])
  assert.ok(empty >= 3)
  // The first chunk ends at the end of the file, after the last newline.
  assert.equal(readBack(file, 0, 1_024)?.end, size)
  assert.equal(readBack(file, 0, 1_024)?.start, starts[2])
})

test('files: readBack and readFrom give undefined for an absent file', (t) => {
  const dir = tempDir(t)
  assert.equal(readBack(join(dir, 'none'), 0, 100), undefined)
  assert.equal(readFrom(join(dir, 'none'), 0), undefined)
  assert.equal(firstLine(join(dir, 'none')), undefined)
})

test('files: readFrom from an offset gives the new full lines, and the offset of the next read', (t) => {
  const file = join(tempDir(t), 'rollout.jsonl')
  const starts = jsonl(file, ['{"a":1}', '{"b":2}'], '{"c":')
  const r1 = readFrom(file, starts[1] ?? 0)
  assert.deepEqual(r1?.lines, ['{"b":2}'])
  assert.equal(r1?.start, starts[1])
  const end = r1?.end ?? 0
  assert.equal(end, (starts[1] ?? 0) + 8)
  // Codex ends the line and adds one more.
  appendFileSync(file, '3}\n{"d":4}\n')
  const r2 = readFrom(file, end)
  assert.deepEqual(r2?.lines, ['{"c":3}', '{"d":4}'])
  assert.equal(r2?.end, statSync(file).size)
  // Nothing new.
  const r3 = readFrom(file, r2?.end ?? 0)
  assert.deepEqual(r3?.lines, [])
  assert.equal(r3?.end, r2?.end)
})

test('files: readFrom on a file that got shorter gives no line and the new size', (t) => {
  const file = join(tempDir(t), 'rollout.jsonl')
  jsonl(file, ['{"a":1}'])
  const r = readFrom(file, 500)
  assert.deepEqual(r, { lines: [], start: 500, end: 500, size: 8 })
})

test('files: firstLine reads a long first line whole, and nothing while it has no newline', (t) => {
  const dir = tempDir(t)
  const meta = JSON.stringify({ type: 'session_meta', payload: { originator: 'codex-tui', instructions: 'i'.repeat(150_000) } })
  const file = join(dir, 'rollout.jsonl')
  jsonl(file, [meta, '{"type":"turn_context"}'])
  assert.equal(firstLine(file), meta)
  const half = join(dir, 'half.jsonl')
  writeFileSync(half, '{"type":"session_meta"')
  assert.equal(firstLine(half), undefined)
  assert.equal(firstLine(file, 1_000), undefined, 'no newline within max bytes')
  mkdirSync(join(dir, 'empty'))
  writeFileSync(join(dir, 'empty', 'e.jsonl'), '')
  assert.equal(firstLine(join(dir, 'empty', 'e.jsonl')), undefined)
})

/** A small seeded random source (mulberry32), so a failure repeats. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let r = Math.imul(a ^ (a >>> 15), 1 | a)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** A random line of 1 to `most` characters, some of them two and three bytes long in UTF-8. */
function randomLine(r: () => number, most: number): string {
  const chars = ['a', 'b', '{', '"', ':', 'é', '€', ' ']
  let s = ''
  const n = 1 + Math.floor(r() * most)
  for (let i = 0; i < n; i += 1) s += chars[Math.floor(r() * chars.length)] ?? 'a'
  return s
}

test('files: a backward scan gives each line that fits a chunk once, in order, and no other', (t) => {
  const dir = tempDir(t)
  for (let seed = 1; seed <= 150; seed += 1) {
    const r = rng(seed)
    const lines = Array.from({ length: 1 + Math.floor(r() * 30) }, () => randomLine(r, r() < 0.15 ? 400 : 40))
    const tail = r() < 0.5 ? randomLine(r, 30) : ''
    const file = join(dir, `f${seed}.jsonl`)
    jsonl(file, lines, tail)
    const max = 8 + Math.floor(r() * 200)
    const size = statSync(file).size
    const got: string[] = []
    let fromEnd = 0
    for (let i = 0; ; i += 1) {
      assert.ok(i < 10_000, `seed ${seed}: the scan does not end`)
      const back = readBack(file, fromEnd, max)
      assert.ok(back !== undefined)
      got.unshift(...back.lines)
      if (back.start === 0) break
      assert.ok(size - back.start > fromEnd, `seed ${seed}: the scan moves back`)
      fromEnd = size - back.start
    }
    const want = lines.filter((l) => Buffer.byteLength(l) + 1 <= max)
    assert.deepEqual(got, want, `seed ${seed}, max ${max}`)
  }
})

test('files: a cursor over a file that grows in random cuts reads each full line once', (t) => {
  const dir = tempDir(t)
  for (let seed = 1; seed <= 60; seed += 1) {
    const r = rng(seed * 7)
    const lines = Array.from({ length: 5 + Math.floor(r() * 40) }, () => randomLine(r, 60))
    const all = Buffer.from(lines.map((l) => `${l}\n`).join(''), 'utf8')
    const file = join(dir, `g${seed}.jsonl`)
    writeFileSync(file, '')
    const got: string[] = []
    let offset = 0
    let written = 0
    while (written < all.length) {
      // A cut can fall inside a line, and inside a character of two or three bytes.
      const n = Math.min(all.length - written, 1 + Math.floor(r() * 50))
      appendFileSync(file, all.subarray(written, written + n))
      written += n
      const next = readFrom(file, offset)
      assert.ok(next !== undefined)
      got.push(...next.lines)
      offset = next.end
    }
    assert.deepEqual(got, lines, `seed ${seed}`)
    assert.equal(offset, all.length)
  }
})

test('files: tryLock takes a free lock at once, and a busy one never waits', (t) => {
  const lock = join(tempDir(t), 'live.lock')
  const token = tryLock(lock, 'quota-1')
  assert.ok(token !== undefined)
  assert.equal(readFileSync(lock, 'utf8'), token)
  const held = JSON.parse(token) as Record<string, unknown>
  assert.equal(held.owner, 'quota-1')
  assert.equal(held.pid, process.pid)
  const t0 = Date.now()
  assert.equal(tryLock(lock, 'quota-2'), undefined)
  assert.ok(Date.now() - t0 < 200)
  unlock(lock, token)
  assert.equal(existsSync(lock), false)
})

test('files: tryLock breaks a stale lock by age or by a dead pid, with its own stale time', (t) => {
  const lock = join(tempDir(t), 'live.lock')
  writeFileSync(lock, JSON.stringify({ owner: 'old', pid: process.pid, at: Date.now() - 6_000 }))
  assert.equal(tryLock(lock, 'q', { staleMs: 20_000 }), undefined, 'young for a 20 s stale time')
  assert.ok(tryLock(lock, 'q', { staleMs: 5_000 }) !== undefined, 'stale for a 5 s stale time')
  writeFileSync(lock, JSON.stringify({ owner: 'gone', pid: DEAD_PID, at: Date.now() }))
  assert.ok(tryLock(lock, 'q', { staleMs: 20_000 }) !== undefined)
})

test('files: unlock leaves a lock that another taker holds now', (t) => {
  const lock = join(tempDir(t), 'live.lock')
  const mine = tryLock(lock, 'slow')
  assert.ok(mine !== undefined)
  const theirs = JSON.stringify({ owner: 'taker', pid: process.pid, at: Date.now() })
  writeFileSync(lock, theirs)
  unlock(lock, mine)
  assert.equal(readFileSync(lock, 'utf8'), theirs)
})
