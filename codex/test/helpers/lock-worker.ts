import { appendFileSync, closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import { withLock } from '../../src/files.ts'

// One contender of files.spec: it takes the lock `rounds` times. Inside the lock it makes a marker file with
// an exclusive create, holds it a few ms, and removes it. A second holder at the same time would find the
// marker, so an overlap shows as a failed create.
//
// With `stale`, the contenders meet before each round. The last one to arrive writes a lock of a dead pid,
// and they all start at the same ms, so they all find that stale lock at once.

type Stale = {
  /** 16 shared bytes: the arrivals (int32), the round (int32), then the start ms (int64). */
  sab: SharedArrayBuffer
  /** The number of contenders. */
  n: number
  /** The pid in the stale lock: a pid that no process has. */
  deadPid: number
}

type Job = { lock: string; marker: string; journal?: string; owner: string; rounds: number; holdMs: number; stale?: Stale }

const job = workerData as Job
const pause = new Int32Array(new SharedArrayBuffer(4))

/** Waits for every contender. The last one writes the stale lock and sets the start, 3 ms from now. */
function meet(s: Stale): void {
  const ctrl = new Int32Array(s.sab, 0, 2)
  const start = new BigInt64Array(s.sab, 8, 1)
  const round = Atomics.load(ctrl, 1)
  if (Atomics.add(ctrl, 0, 1) === s.n - 1) {
    writeFileSync(job.lock, JSON.stringify({ owner: 'gone', pid: s.deadPid, at: Date.now() }))
    Atomics.store(start, 0, BigInt(Date.now() + 3))
    Atomics.store(ctrl, 0, 0)
    Atomics.add(ctrl, 1, 1)
    Atomics.notify(ctrl, 1)
  } else {
    while (Atomics.load(ctrl, 1) === round) Atomics.wait(ctrl, 1, round)
  }
  const at = Number(Atomics.load(start, 0))
  while (Date.now() < at) {
    // Spin: every contender leaves at the same ms tick.
  }
}

let overlaps = 0
for (let i = 0; i < job.rounds; i += 1) {
  if (job.stale !== undefined) meet(job.stale)
  withLock(job.lock, job.owner, () => {
    let fd: number | undefined
    try {
      fd = openSync(job.marker, 'wx')
    } catch {
      overlaps += 1
    }
    if (job.journal !== undefined) appendFileSync(job.journal, `${job.owner} in\n`)
    Atomics.wait(pause, 0, 0, job.holdMs)
    if (job.journal !== undefined) appendFileSync(job.journal, `${job.owner} out\n`)
    if (fd !== undefined) {
      closeSync(fd)
      unlinkSync(job.marker)
    }
  })
}
parentPort?.postMessage({ owner: job.owner, overlaps })
