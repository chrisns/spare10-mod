import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { debugOn, fileLog, logFileOf, noLog } from '../src/log.ts'
import { fakeClock } from './helpers/clock.ts'
import { tempDir } from './helpers/tmp.ts'

// The debug log (Codex design 1.2, 3.7): `<data dir>/log/broker-<yyyy-mm-dd>.log`, only with
// SPARE10_CODEX_DEBUG=1.

const DAY1 = Date.parse('2026-09-26T23:59:58.000Z')

test('log: on only with SPARE10_CODEX_DEBUG=1', () => {
  assert.equal(debugOn({ SPARE10_CODEX_DEBUG: '1' }), true)
  assert.equal(debugOn({ SPARE10_CODEX_DEBUG: 'true' }), false)
  assert.equal(debugOn({ SPARE10_CODEX_DEBUG: '0' }), false)
  assert.equal(debugOn({}), false)
})

test('log: off writes nothing and makes no folder', (t) => {
  const data = join(tempDir(t), 'data')
  const log = fileLog(data, false, fakeClock(DAY1))
  assert.equal(log, noLog)
  log.debug('spare10: a line')
  assert.equal(existsSync(data), false)
})

test('log: one file per UTC day, each line with its ISO time and tag', async (t) => {
  const data = join(tempDir(t), 'data')
  const clock = fakeClock(DAY1)
  const log = fileLog(data, true, clock, { tag: 'pid 4242' })
  log.debug('spare10: the gate failed: boom')
  await clock.advance(3_000)
  log.debug('spare10: 2 held call(s) dropped.')
  const day1 = join(data, 'log', 'broker-2026-09-26.log')
  const day2 = join(data, 'log', 'broker-2026-09-27.log')
  assert.equal(logFileOf(data, DAY1), day1)
  assert.equal(readFileSync(day1, 'utf8'), '2026-09-26T23:59:58.000Z [pid 4242] spare10: the gate failed: boom\n')
  assert.equal(readFileSync(day2, 'utf8'), '2026-09-27T00:00:01.000Z [pid 4242] spare10: 2 held call(s) dropped.\n')
  assert.equal(statSync(join(data, 'log')).mode & 0o777, 0o700)
  assert.equal(statSync(day1).mode & 0o777, 0o600)
})

test('log: lines append, and a line with newlines stays one entry', (t) => {
  const data = tempDir(t)
  const log = fileLog(data, true, fakeClock(DAY1))
  log.debug('spare10: one')
  log.debug('spare10: two\nthree\r\nfour')
  assert.equal(
    readFileSync(logFileOf(data, DAY1), 'utf8'),
    '2026-09-26T23:59:58.000Z spare10: one\n2026-09-26T23:59:58.000Z spare10: two\\nthree\\nfour\n',
  )
})

test('log: a failed write never throws', (t) => {
  const file = join(tempDir(t), 'not-a-folder')
  writeFileSync(file, 'x')
  const log = fileLog(file, true, fakeClock(DAY1))
  log.debug('spare10: lost')
})
