import { appendFileSync, closeSync, openSync, unlinkSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import { withLock } from '../../src/files.ts'

// One contender of files.spec: it takes the lock `rounds` times. Inside the lock it makes a marker file with
// an exclusive create, holds it a few ms, and removes it. A second holder at the same time would find the
// marker, so an overlap shows as a failed create.

type Job = { lock: string; marker: string; journal: string; owner: string; rounds: number; holdMs: number }

const job = workerData as Job
const pause = new Int32Array(new SharedArrayBuffer(4))
let overlaps = 0
for (let i = 0; i < job.rounds; i += 1) {
  withLock(job.lock, job.owner, () => {
    let fd: number | undefined
    try {
      fd = openSync(job.marker, 'wx')
    } catch {
      overlaps += 1
    }
    appendFileSync(job.journal, `${job.owner} in\n`)
    Atomics.wait(pause, 0, 0, job.holdMs)
    appendFileSync(job.journal, `${job.owner} out\n`)
    if (fd !== undefined) {
      closeSync(fd)
      unlinkSync(job.marker)
    }
  })
}
parentPort?.postMessage({ owner: job.owner, overlaps })
