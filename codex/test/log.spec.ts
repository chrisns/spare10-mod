import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { debugOn, fileLog, LOG_DAY_MAX_BYTES, LOG_KEEP_DAYS, logFileOf, noLog } from '../src/log.ts'
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

test('log: the first line of each UTC day removes the day files older than 7 days, and nothing else', async (t) => {
  assert.equal(LOG_KEEP_DAYS, 7)
  const data = tempDir(t)
  const dir = join(data, 'log')
  mkdirSync(dir)
  const keep = ['broker-2026-09-20.log', 'broker-2026-09-27.log', 'broker-2026-09-26.log.bak', 'notes.txt', 'broker-2026-09-01.txt']
  for (const name of ['broker-2026-09-19.log', 'broker-2025-12-31.log', ...keep]) writeFileSync(join(dir, name), 'x\n')
  // A folder with the name of an old day file stays. A link with such a name goes, but the file behind it stays.
  mkdirSync(join(dir, 'broker-2026-09-01.log'))
  const target = join(data, 'target.txt')
  writeFileSync(target, 'keep\n')
  symlinkSync(target, join(dir, 'broker-2026-09-02.log'))
  const clock = fakeClock(DAY1)
  const log = fileLog(data, true, clock)
  log.debug('spare10: one')
  const after = readdirSync(dir).sort()
  assert.deepEqual(after, ['broker-2026-09-01.log', 'broker-2026-09-20.log', 'broker-2026-09-26.log', 'broker-2026-09-26.log.bak', 'broker-2026-09-27.log', 'broker-2026-09-01.txt', 'notes.txt'].sort())
  assert.equal(readFileSync(target, 'utf8'), 'keep\n', 'the file behind the link stays')
  // An old file that comes later on the same day stays until the first line of the next day.
  writeFileSync(join(dir, 'broker-2026-09-18.log'), 'x\n')
  log.debug('spare10: two')
  assert.equal(existsSync(join(dir, 'broker-2026-09-18.log')), true)
  await clock.advance(3_000)
  log.debug('spare10: three')
  assert.equal(existsSync(join(dir, 'broker-2026-09-18.log')), false)
  assert.equal(existsSync(join(dir, 'broker-2026-09-20.log')), false, 'on 09-27, 09-20 is 7 days back')
  // The day file of 09-27 was there before its day, and the new day appends to it.
  assert.equal(readFileSync(logFileOf(data, DAY1 + 3_000), 'utf8'), 'x\n2026-09-27T00:00:01.000Z spare10: three\n')
})

test('log: a day file at 50 MB takes no more lines, and the next day starts a new file', async (t) => {
  assert.equal(LOG_DAY_MAX_BYTES, 50 * 1024 * 1024)
  const data = tempDir(t)
  const clock = fakeClock(DAY1)
  const log = fileLog(data, true, clock)
  log.debug('spare10: first')
  const day1 = logFileOf(data, DAY1)
  truncateSync(day1, LOG_DAY_MAX_BYTES)
  log.debug('spare10: dropped')
  assert.equal(statSync(day1).size, LOG_DAY_MAX_BYTES)
  await clock.advance(3_000)
  log.debug('spare10: next day')
  assert.equal(readFileSync(logFileOf(data, DAY1 + 3_000), 'utf8'), '2026-09-27T00:00:01.000Z spare10: next day\n')
})
