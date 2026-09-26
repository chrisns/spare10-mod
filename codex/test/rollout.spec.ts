import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { codexLimits } from '../../hooks/core/codex.ts'
import { ROLLOUT_CHUNK_BYTES, ROLLOUT_SCAN_MAX } from '../src/timing.ts'
import { createRollouts, metaOf, nodeRolloutIo, turnStartOf } from '../src/rollout.ts'
import type { RolloutIo } from '../src/rollout.ts'
import { fakeRollout, sessionMetaLine, taskStartedLine, tokenCountLine } from './helpers/rollout.ts'
import { tempDir } from './helpers/tmp.ts'

// The rollout cursor (Codex design 3.6, route C): only new bytes, a backward scan on the first read, and
// the newest codex token_count past large tool outputs.

const T0 = Date.UTC(2026, 8, 26, 10)
const MIN = 60_000
const HOUR = 60 * MIN
const five = (pct: number, reset = T0 + 2 * HOUR) => ({ pct, mins: 300, resetsAt: reset })
const week = (pct: number, reset = T0 + 3 * 24 * HOUR) => ({ pct, mins: 10080, resetsAt: reset })
const pcts = (s: Parameters<typeof codexLimits>[0] | undefined): number[] => (s === undefined ? [] : codexLimits(s).map((l) => l.percentUsed))

/** The file reads of the cursor, recorded. */
function spyIo(): RolloutIo & { from: number[]; back: number[]; firsts: number } {
  const spy = {
    from: [] as number[],
    back: [] as number[],
    firsts: 0,
    readFrom: (f: string, o: number) => {
      spy.from.push(o)
      return nodeRolloutIo.readFrom(f, o)
    },
    readBack: (f: string, e: number, m: number) => {
      spy.back.push(e)
      return nodeRolloutIo.readBack(f, e, m)
    },
    firstLine: (f: string) => {
      spy.firsts += 1
      return nodeRolloutIo.firstLine(f)
    },
    stat: nodeRolloutIo.stat,
  }
  return spy
}

test('rollout: an absent file gives an empty read', (t) => {
  const r = createRollouts().read(join(tempDir(t), 'none.jsonl'))
  assert.equal(r.newest, undefined)
  assert.deepEqual(r.byKind, {})
  assert.deepEqual(r.fresh, [])
  assert.equal(r.meta, undefined)
  assert.equal(r.turnEnds.size, 0)
})

test('rollout: the first read finds the newest codex token_count, the session_meta and the turn ends, and stops there', (t) => {
  const path = join(tempDir(t), 'rollout.jsonl')
  fakeRollout(path)
    .sessionMeta({ originator: 'codex-tui', source: 'cli', cwd: '/work/app' })
    .taskStarted('U1', 1790000000, T0)
    .tokenCount({ at: T0 + 1_000, primary: five(40), secondary: week(20) })
    .taskComplete('U1', T0 + 2_000)
    .taskStarted('U2', 1790000100, T0 + 3_000)
    .tokenCount({ at: T0 + 4_000, primary: five(41), secondary: week(21) })
    .turnAborted('U2', 1790000100, T0 + 5_000)
  const r = createRollouts().read(path)
  assert.equal(r.newest?.at, T0 + 4_000)
  assert.deepEqual(pcts(r.newest?.snapshot), [41, 21])
  assert.equal(r.newestObs?.at, T0 + 4_000)
  assert.equal(r.byKind.five_hour?.at, T0 + 4_000)
  assert.equal(r.byKind.seven_day?.at, T0 + 4_000)
  assert.deepEqual(r.fresh.map((f) => f.at), [T0 + 4_000], 'the scan stops at the newest observation')
  assert.deepEqual(r.meta, { type: 'session_meta', originator: 'codex-tui', source: 'cli', cwd: '/work/app' })
  assert.equal(r.turnStart, undefined, 'the task_started of U2 lies before the newest observation')
  assert.deepEqual([...r.turnEnds.values()], [{ turnId: 'U2', how: 'aborted', startedAt: 1790000100, at: T0 + 5_000 }])
})

test('rollout: the backward scan stops at the newest observation, also with no turn start behind it (CX-R4)', (t) => {
  // A long turn: its task_started lies far back, or the rollout has none. The scan reads only the chunk of
  // the newest token_count (3.6), and a turn start newer than it still counts.
  const path = join(tempDir(t), 'rollout.jsonl')
  const io = spyIo()
  const roll = fakeRollout(path)
    .sessionMeta({ originator: 'codex-tui', source: 'cli' })
    .tokenCount({ at: T0, primary: five(30) })
    .filler(2 * 1024 * 1024, 4096)
    .tokenCount({ at: T0 + 1_000, primary: five(88) })
  const rs = createRollouts({ io })
  const r = rs.read(path)
  assert.equal(r.newest?.at, T0 + 1_000)
  assert.equal(io.back.length, 1, 'one chunk')
  assert.equal(r.turnStart, undefined)
  roll.taskStarted('U3', 1790000200, T0 + 2_000)
  assert.deepEqual(rs.read(path).turnStart, { turnId: 'U3', startedAt: 1790000200, at: T0 + 2_000 }, 'a forward read keeps the newest turn start')
})

test('rollout: a later read parses only the bytes after the offset, and a line with no newline waits', (t) => {
  const path = join(tempDir(t), 'rollout.jsonl')
  const io = spyIo()
  const rs = createRollouts({ io })
  const roll = fakeRollout(path).sessionMeta({ originator: 'codex-tui', source: 'cli' }).tokenCount({ at: T0, primary: five(40) })
  rs.read(path)
  const size1 = statSync(path).size
  assert.equal(rs.cursor(path)?.offset, size1)
  assert.equal(io.from.length, 0, 'the first read scans backwards')
  // A new line, and half of another.
  const next = tokenCountLine({ at: T0 + 2_000, primary: five(43) })
  roll.tokenCount({ at: T0 + 1_000, primary: five(42) }).raw(next.slice(0, 40))
  const r2 = rs.read(path)
  assert.deepEqual(io.from, [size1])
  assert.deepEqual(r2.fresh.map((f) => f.at), [T0 + 1_000])
  assert.equal(r2.newest?.at, T0 + 1_000)
  const size2 = statSync(path).size - 40
  assert.equal(rs.cursor(path)?.offset, size2, 'the cut line comes again')
  roll.raw(`${next.slice(40)}\n`)
  const r3 = rs.read(path)
  assert.deepEqual(io.from, [size1, size2])
  assert.deepEqual(r3.fresh.map((f) => f.at), [T0 + 2_000])
  assert.deepEqual(pcts(r3.newest?.snapshot), [43])
  // Nothing new: an empty read, the same newest.
  const r4 = rs.read(path)
  assert.deepEqual(r4.fresh, [])
  assert.equal(r4.newest?.at, T0 + 2_000)
  assert.equal(r4.meta?.originator, 'codex-tui')
  assert.equal(io.firsts, 1, 'the first line is read once')
})

test('rollout: 1 MiB of tool output after the newest token_count, in one line or in many, is scanned past', (t) => {
  for (const lineBytes of [1024 * 1024, 4096]) {
    const path = join(tempDir(t), `rollout-${lineBytes}.jsonl`)
    const io = spyIo()
    fakeRollout(path)
      .sessionMeta({ originator: 'codex-tui', source: 'cli' })
      .tokenCount({ at: T0, primary: five(30) })
      .tokenCount({ at: T0 + 1_000, primary: five(88), secondary: week(50) })
      .filler(1024 * 1024, lineBytes)
    const r = createRollouts({ io }).read(path)
    assert.equal(r.newest?.at, T0 + 1_000, `lines of ${lineBytes}`)
    assert.deepEqual(pcts(r.newest?.snapshot), [88, 50])
    assert.ok(io.back.length >= 4, `${io.back.length} chunks of ${ROLLOUT_CHUNK_BYTES}`)
  }
})

test('rollout: a 1 MiB filler between two token_counts in a forward read still gives the newest', (t) => {
  const path = join(tempDir(t), 'rollout.jsonl')
  const rs = createRollouts()
  const roll = fakeRollout(path).tokenCount({ at: T0, primary: five(30) })
  rs.read(path)
  roll.tokenCount({ at: T0 + 1_000, primary: five(60) }).filler(1024 * 1024).tokenCount({ at: T0 + 2_000, primary: five(89) })
  const r = rs.read(path)
  assert.deepEqual(r.fresh.map((f) => f.at), [T0 + 1_000, T0 + 2_000])
  assert.deepEqual(pcts(r.newest?.snapshot), [89])
})

test('rollout: the scan stops after 8 MiB, and a later line still counts', (t) => {
  const path = join(tempDir(t), 'rollout.jsonl')
  const rs = createRollouts()
  const roll = fakeRollout(path).tokenCount({ at: T0, primary: five(70) }).filler(ROLLOUT_SCAN_MAX + ROLLOUT_CHUNK_BYTES, 1024 * 1024)
  const r = rs.read(path)
  assert.equal(r.newest, undefined, 'past the scan cap')
  assert.equal(rs.cursor(path)?.offset, statSync(path).size)
  roll.tokenCount({ at: T0 + 1_000, primary: five(71) })
  assert.deepEqual(pcts(rs.read(path).newest?.snapshot), [71])
})

test('rollout: a window-less codex token_count is the newest, not the newest observation', (t) => {
  const path = join(tempDir(t), 'rollout.jsonl')
  fakeRollout(path).tokenCount({ at: T0, primary: five(91), secondary: week(40) }).windowless(T0 + 1_000)
  const r = createRollouts().read(path)
  assert.equal(r.newest?.at, T0 + 1_000)
  assert.equal(r.newestObs?.at, T0)
  assert.equal(r.byKind.five_hour?.at, T0)
  assert.deepEqual(r.fresh.map((f) => f.at), [T0, T0 + 1_000], 'oldest first')
})

test('rollout: a premium bucket is never a codex reading', (t) => {
  const path = join(tempDir(t), 'rollout.jsonl')
  const rs = createRollouts()
  const roll = fakeRollout(path).tokenCount({ at: T0, primary: five(50) }).tokenCount({ at: T0 + 1_000, primary: five(99), limitId: 'premium' })
  let r = rs.read(path)
  assert.deepEqual(pcts(r.newest?.snapshot), [50])
  roll.tokenCount({ at: T0 + 2_000, primary: five(99), limitId: 'premium' })
  r = rs.read(path)
  assert.deepEqual(r.fresh, [])
  assert.deepEqual(pcts(r.newest?.snapshot), [50])
  roll.tokenCount({ at: T0 + 3_000, primary: five(51), limitId: null })
  assert.deepEqual(pcts(rs.read(path).newest?.snapshot), [51], 'a null limit id is the codex bucket')
})

test('rollout: each kind keeps its newest observation', (t) => {
  const path = join(tempDir(t), 'rollout.jsonl')
  const rs = createRollouts()
  const roll = fakeRollout(path).tokenCount({ at: T0, primary: five(40), secondary: week(20) })
  rs.read(path)
  roll.tokenCount({ at: T0 + 1_000, primary: week(21) })
  const r = rs.read(path)
  assert.equal(r.byKind.five_hour?.at, T0)
  assert.equal(r.byKind.seven_day?.at, T0 + 1_000)
  assert.equal(r.newestObs?.at, T0 + 1_000)
})

test('rollout: resets_at as seconds and as RFC 3339 both read', (t) => {
  const path = join(tempDir(t), 'rollout.jsonl')
  fakeRollout(path).tokenCount({ at: T0, primary: { pct: 90.25, mins: 300, resetsAt: new Date(T0 + HOUR).toISOString() } })
  const r = createRollouts().read(path)
  assert.deepEqual(codexLimits(r.newest?.snapshot ?? {}), [{ kind: 'five_hour', percentUsed: 90.3, resetsAt: new Date(T0 + HOUR).toISOString() }])
})

test('rollout: a file that got shorter, or was replaced, is scanned again from its end', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'rollout.jsonl')
  const rs = createRollouts()
  fakeRollout(path).tokenCount({ at: T0, primary: five(40) }).tokenCount({ at: T0 + 1_000, primary: five(41) })
  rs.read(path)
  writeFileSync(path, `${tokenCountLine({ at: T0 + 5_000, primary: five(10) })}\n`)
  assert.deepEqual(pcts(rs.read(path).newest?.snapshot), [10], 'shorter')
  const other = join(dir, 'other.jsonl')
  fakeRollout(other).sessionMeta({ originator: 'codex_exec', source: 'exec' }).tokenCount({ at: T0 + 6_000, primary: five(20) })
  renameSync(other, path)
  const r = rs.read(path)
  assert.deepEqual(pcts(r.newest?.snapshot), [20], 'replaced')
  assert.equal(r.meta?.originator, 'codex_exec')
})

test('rollout: a file that grew by more than the scan cap is scanned from its end', (t) => {
  const path = join(tempDir(t), 'rollout.jsonl')
  const io = spyIo()
  const rs = createRollouts({ io })
  const roll = fakeRollout(path).tokenCount({ at: T0, primary: five(40) })
  rs.read(path)
  roll.filler(ROLLOUT_SCAN_MAX + 1024, 1024 * 1024).tokenCount({ at: T0 + 1_000, primary: five(45) })
  const backs = io.back.length
  const r = rs.read(path)
  assert.deepEqual(io.from, [], 'no forward read of more than 8 MiB')
  assert.ok(io.back.length > backs)
  assert.deepEqual(pcts(r.newest?.snapshot), [45])
})

test('rollout: forget drops the cursor, and the next read scans again', (t) => {
  const path = join(tempDir(t), 'rollout.jsonl')
  const rs = createRollouts()
  fakeRollout(path).tokenCount({ at: T0, primary: five(40) })
  rs.read(path)
  assert.ok(rs.cursor(path) !== undefined)
  rs.forget(path)
  assert.equal(rs.cursor(path), undefined)
  assert.deepEqual(rs.read(path).fresh.map((f) => f.at), [T0])
})

test('rollout: the cursor keeps the newest 64 turn ends, oldest first', (t) => {
  const path = join(tempDir(t), 'rollout.jsonl')
  const rs = createRollouts()
  const roll = fakeRollout(path)
  for (let i = 0; i < 70; i += 1) roll.taskComplete(`U${i}`, T0 + i)
  const first = [...rs.read(path).turnEnds.keys()]
  assert.equal(first.length, 64)
  assert.equal(first[0], 'U6')
  assert.equal(first[63], 'U69')
  roll.turnAborted('U70', undefined, T0 + 70)
  const next = [...rs.read(path).turnEnds.values()]
  assert.equal(next.length, 64)
  assert.deepEqual(next[63], { turnId: 'U70', how: 'aborted', startedAt: null, at: T0 + 70 })
})

test('rollout: metaOf and turnStartOf read the probed shapes', () => {
  assert.deepEqual(metaOf(sessionMetaLine({ originator: 'codex-tui', source: 'vscode', cwd: '/p' })), {
    type: 'session_meta',
    originator: 'codex-tui',
    source: 'vscode',
    cwd: '/p',
  })
  assert.equal(metaOf(tokenCountLine({ at: T0, primary: five(1) })), undefined)
  assert.deepEqual(turnStartOf(taskStartedLine('U9', 1790366423, T0)), { turnId: 'U9', startedAt: 1790366423, at: T0 })
  assert.deepEqual(turnStartOf(taskStartedLine('U9', undefined, T0)), { turnId: 'U9', startedAt: null, at: T0 })
  assert.equal(turnStartOf('{"type":"event_msg","payload":{"type":"task_started"}}'), undefined)
  assert.equal(turnStartOf('not json "task_started"'), undefined)
})
