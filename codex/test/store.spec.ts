import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VERSION } from '../../hooks/core/text.ts'
import { readJson, withLock } from '../src/files.ts'
import { NOTICE_TTL_MS, PRUNE_AFTER_MS, PRUNE_EVERY_MS } from '../src/timing.ts'
import { FormatError, checkId, freshState, listSessions, pruneSessions, sessionStore, testOf, warnOnce } from '../src/store.ts'
import type { AnswerFile, QuestionFile, SessionState, Unstamped } from '../src/store.ts'
import { fakeClock } from './helpers/clock.ts'
import { fakeRollout } from './helpers/rollout.ts'
import { tempDir } from './helpers/tmp.ts'
import { memoryWake } from './helpers/wake.ts'

// The state files of a session and their one lock (Codex design 3.7, 7.2 store.ts).

const T0 = Date.UTC(2026, 8, 26, 10)
const SID = '01a0da06-c266-7842-bc97-1128f6549960'

function world(t: Parameters<typeof tempDir>[0]) {
  const data = join(tempDir(t), 'data')
  const clock = fakeClock(T0)
  const wake = memoryWake()
  const store = (o: { hostPid?: number; owner?: string; sid?: string } = {}) =>
    sessionStore({ data }, o.sid ?? SID, o.owner ?? 'broker-1', wake, { clock, ...(o.hostPid === undefined ? {} : { hostPid: o.hostPid }) })
  const dir = join(data, 'sessions', SID)
  return { data, clock, wake, store, dir, file: (name: string) => join(dir, name) }
}

const question = (key: string): Unstamped<QuestionFile> => ({
  key,
  leader: null,
  createdAt: T0,
  kinds: ['five_hour'],
  ends: { five_hour: { end: T0 + 3_600_000, test: false } },
  latestEnd: T0 + 3_600_000,
  real: [],
  stopEnd: T0 + 3_600_000,
  holdEnd: T0 + 3_600_000,
  due: T0 + 3_900_000,
  skip: false,
  noteAt: T0 + 3_600_000,
  nextCheck: T0 + 60_000,
  silent: false,
  auto: true,
  loops: 1,
  since: T0,
  mode: 'hold',
  opener: 'loop',
  facts: [],
  handoffs: 0,
  noted: false,
})

test('store: an absent state reads as a fresh state, and a read makes no file', (t) => {
  const w = world(t)
  const s = w.store()
  assert.deepEqual(s.read(), { v: 1, by: VERSION, rev: 0, sessionId: SID, updatedAt: 0 })
  assert.deepEqual(s.read(), freshState(SID))
  assert.equal(s.sid, SID)
  assert.equal(s.dir, w.dir)
  assert.equal(existsSync(w.dir), false)
})

test('store: locked writes the changed state with v, by, rev + 1 and updatedAt, 0600 in a 0700 folder, and fires the wake once', (t) => {
  const w = world(t)
  const s = w.store()
  const got = s.locked((tx) => {
    tx.state.consent = `${SID} 2026-09-26T11:00:00.000Z`
    return 'done'
  })
  assert.equal(got, 'done')
  const st = readJson<SessionState>(w.file('state.json'))
  assert.deepEqual(st, { v: 1, by: VERSION, rev: 1, sessionId: SID, updatedAt: T0, consent: `${SID} 2026-09-26T11:00:00.000Z` })
  assert.equal(statSync(w.file('state.json')).mode & 0o777, 0o600)
  assert.equal(statSync(w.dir).mode & 0o777, 0o700)
  assert.deepEqual(w.wake.fired, [w.dir])
  assert.equal(existsSync(w.file('state.lock')), false, 'the lock goes after the step')
  s.locked((tx) => {
    tx.state.stopped = `${SID} 1 2 five_hour`
  })
  assert.equal(readJson<SessionState>(w.file('state.json'))?.rev, 2)
})

test('store: a locked step that changes nothing writes nothing and fires no wake', (t) => {
  const w = world(t)
  const s = w.store()
  s.locked((tx) => {
    tx.state.child = 'stop'
  })
  const before = readFileSync(w.file('state.json'), 'utf8')
  w.wake.fired.length = 0
  s.locked((tx) => {
    tx.state.child = 'stop'
    tx.thread('T1') // read, not changed
    tx.question()
    tx.answer()
  })
  assert.equal(readFileSync(w.file('state.json'), 'utf8'), before)
  assert.equal(existsSync(join(w.dir, 'threads')), false)
  assert.deepEqual(w.wake.fired, [])
})

test('store: two stores of one session (two brokers) see and keep each other\'s writes', (t) => {
  const w = world(t)
  const a = w.store({ owner: 'broker-1' })
  const b = w.store({ owner: 'broker-2' })
  a.locked((tx) => {
    tx.state.consent = 'c1'
  })
  b.locked((tx) => {
    assert.equal(tx.state.consent, 'c1')
    tx.state.weeklyConsent = 'w1'
  })
  const st = a.read()
  assert.equal(st.consent, 'c1')
  assert.equal(st.weeklyConsent, 'w1')
  assert.equal(st.rev, 2)
})

test('store: thread files are fresh until written, and only a changed thread is written', (t) => {
  const w = world(t)
  const s = w.store()
  s.locked((tx) => {
    const th = tx.thread('T1')
    assert.deepEqual(th, { v: 1, by: VERSION, threadId: 'T1', sessionId: SID, brokerPid: 0, hostPid: 0, beat: 0, held: [], promptTurns: [], denied: [] })
    th.brokerPid = 4242
    th.hostPid = 77
    th.held.push({ call: '1', site: 'tool', turn: 'U1', since: T0, brokerPid: 4242, hostPid: 77 })
    assert.equal(tx.thread('T1'), th, 'one object per thread in a step')
    tx.thread('T2')
  })
  const t1 = readJson<Record<string, unknown>>(join(w.dir, 'threads', 'T1.json'))
  assert.equal(t1?.brokerPid, 4242)
  assert.deepEqual(t1?.held, [{ call: '1', site: 'tool', turn: 'U1', since: T0, brokerPid: 4242, hostPid: 77 }])
  assert.equal(existsSync(join(w.dir, 'threads', 'T2.json')), false)
  assert.equal(existsSync(w.file('state.json')), false, 'the state did not change')
  s.locked((tx) => {
    tx.thread('T1').held = []
  })
  assert.deepEqual(readJson<Record<string, unknown>>(join(w.dir, 'threads', 'T1.json'))?.held, [])
})

test('store: the question and the answer are set, read, stamped and removed under the lock', (t) => {
  const w = world(t)
  const s = w.store()
  s.locked((tx) => {
    assert.equal(tx.question(), undefined)
    tx.setQuestion(question('K1'))
  })
  const q = readJson<QuestionFile>(w.file('question.json'))
  assert.equal(q?.v, 1)
  assert.equal(q?.by, VERSION)
  assert.equal(q?.key, 'K1')
  const answer: Unstamped<AnswerFile> = { key: 'K1', outcome: 'stop', via: 'dialog', at: T0, answered: [{ kind: 'five_hour', test: false }] }
  s.locked((tx) => {
    assert.equal(tx.question()?.key, 'K1')
    tx.setAnswer(answer)
    tx.state.stopped = `${SID} ${T0 + 3_600_000} ${T0} five_hour,work`
    tx.setQuestion(undefined)
  })
  assert.equal(existsSync(w.file('question.json')), false)
  assert.deepEqual(readJson(w.file('answer.json')), { ...answer, v: 1, by: VERSION })
  assert.equal(s.read().stopped, `${SID} ${T0 + 3_600_000} ${T0} five_hour,work`, 'the answer and its stop come in one step')
  // Deleting a question that is gone is no change.
  w.wake.fired.length = 0
  s.locked((tx) => tx.setQuestion(undefined))
  assert.deepEqual(w.wake.fired, [])
})

test('store: a state of another format is absent when sensing, and a locked step throws FormatError and writes nothing', (t) => {
  const w = world(t)
  mkdirSync(w.dir, { recursive: true })
  const newer = JSON.stringify({ v: 2, by: '9.0.0', rev: 5, sessionId: SID, consent: 'x' })
  writeFileSync(w.file('state.json'), newer)
  const s = w.store()
  assert.deepEqual(s.read(), freshState(SID))
  assert.throws(
    () =>
      s.locked((tx) => {
        tx.state.consent = 'y'
      }),
    (e: unknown) => e instanceof FormatError && e.file === w.file('state.json'),
  )
  assert.equal(readFileSync(w.file('state.json'), 'utf8'), newer)
  assert.equal(existsSync(w.file('state.lock')), false)
})

test('store: a question or answer of another format throws inside the step, and nothing of the step is written', (t) => {
  const w = world(t)
  mkdirSync(w.dir, { recursive: true })
  writeFileSync(w.file('question.json'), JSON.stringify({ key: 'K0' })) // no format: not known
  const s = w.store()
  assert.throws(
    () =>
      s.locked((tx) => {
        tx.state.consent = 'y'
        tx.question()
      }),
    FormatError,
  )
  assert.equal(existsSync(w.file('state.json')), false)
})

test('store: bad JSON in state.json throws when sensing and when acting', (t) => {
  const w = world(t)
  mkdirSync(w.dir, { recursive: true })
  writeFileSync(w.file('state.json'), '{"v": 1,')
  const s = w.store()
  assert.throws(() => s.read(), SyntaxError)
  assert.throws(() => s.locked(() => 1), SyntaxError)
})

test('store: a state or thread file torn by an OS crash is absent, and the next write replaces it', (t) => {
  const w = world(t)
  mkdirSync(join(w.dir, 'threads'), { recursive: true })
  writeFileSync(w.file('state.json'), '')
  writeFileSync(join(w.dir, 'threads', 'T1.json'), '\0'.repeat(64))
  writeFileSync(w.file('question.json'), '\0'.repeat(64))
  const s = w.store()
  assert.deepEqual(s.read(), freshState(SID))
  s.locked((tx) => {
    assert.deepEqual(tx.thread('T1').held, [])
    assert.equal(tx.question(), undefined)
    tx.state.consent = 'S1 2026-09-26T12:00:00.000Z'
    tx.thread('T1').beat = T0
  })
  assert.equal(s.read().consent, 'S1 2026-09-26T12:00:00.000Z')
  assert.equal(s.read().rev, 1)
  assert.equal(readJson<{ beat: number }>(join(w.dir, 'threads', 'T1.json'))?.beat, T0)
})

test('store: the lock is not reentrant, and a nested step fails at once', (t) => {
  const w = world(t)
  const s = w.store()
  const t0 = Date.now()
  assert.throws(() => s.locked(() => s.locked(() => 1)), /not reentrant/)
  assert.ok(Date.now() - t0 < 500)
  assert.equal(s.locked(() => 2), 2, 'the store works after the failed step')
})

test('store: a session or thread id that cannot name a file throws', (t) => {
  const w = world(t)
  for (const bad of ['', '..', '../x', 'a/b', '.hidden', 'a\\b', 'a b']) {
    assert.throws(() => checkId('session id', bad), /cannot name a file/, bad)
  }
  assert.throws(() => w.store({ sid: '../escape' }), /cannot name a file/)
  const s = w.store()
  assert.throws(() => s.locked((tx) => tx.thread('../../x')), /cannot name a file/)
  checkId('thread id', '01a0da2b-3ff7-7ad0-b5ee-c6281c89518f')
})

test('store: a test reading of another host pid is hidden, and cleared with the next write', (t) => {
  const w = world(t)
  const test = { hostPid: 111, kinds: { five_hour: { pct: 92, resetsAtMs: T0 + 3_600_000 } }, consent: {} }
  w.store({ hostPid: 111 }).locked((tx) => {
    tx.state.test = test
  })
  const same = w.store({ hostPid: 111 })
  assert.deepEqual(same.read().test, test)
  assert.deepEqual(testOf(same.read(), 111), test)
  assert.equal(testOf(same.read(), 222), undefined)
  const other = w.store({ hostPid: 222 })
  assert.equal(other.read().test, undefined)
  // A step that changes nothing else leaves it on disk.
  other.locked((tx) => {
    assert.equal(tx.state.test, undefined)
  })
  assert.deepEqual(readJson<SessionState>(w.file('state.json'))?.test, test)
  // The next write clears it.
  other.locked((tx) => {
    tx.state.child = 'stop'
  })
  assert.equal(readJson<SessionState>(w.file('state.json'))?.test, undefined)
  // A store with no host pid (a reader that cannot tell) sees it as it is.
  w.store({ hostPid: 111 }).locked((tx) => {
    tx.state.test = test
  })
  assert.deepEqual(w.store().read().test, test)
})

test('store: queued notices come back once, oldest first, and a line older than 30 min is dropped', async (t) => {
  const w = world(t)
  const s = w.store()
  s.queueNotice('continuing on your 10% reserve until 95% used.')
  await w.clock.advance(1_000)
  s.queueNotice('work stopped at the quota reserve.', 'stop')
  assert.deepEqual(
    s.read().notices?.map((n) => [n.at, n.tag]),
    [
      [T0, undefined],
      [T0 + 1_000, 'stop'],
    ],
  )
  assert.deepEqual(s.takeNotices(w.clock.now()), ['continuing on your 10% reserve until 95% used.', 'work stopped at the quota reserve.'])
  assert.deepEqual(s.takeNotices(w.clock.now()), [])
  assert.equal(s.read().notices, undefined)
  s.queueNotice('old line')
  await w.clock.advance(NOTICE_TTL_MS)
  s.queueNotice('new line')
  assert.deepEqual(s.takeNotices(w.clock.now()), ['new line'])
  assert.equal(s.read().notices, undefined, 'the old line is gone too')
})

test('store: takeNotices takes no lock when no line waits', (t) => {
  const w = world(t)
  const s = w.store()
  s.locked((tx) => {
    tx.state.child = 'stop'
  })
  // A busy lock of a live holder: a step would wait 2 s and fail.
  writeFileSync(w.file('state.lock'), JSON.stringify({ owner: 'busy', pid: process.pid, at: Date.now() }))
  const t0 = Date.now()
  assert.deepEqual(s.takeNotices(T0), [])
  assert.ok(Date.now() - t0 < 500)
})

test('store: warnOnce queues a warning once per session', (t) => {
  const w = world(t)
  const s = w.store()
  assert.equal(
    s.locked((tx) => warnOnce(tx.state, 'CX43', 'this session was started by gap7-remote-client, not by the Codex TUI.', T0)),
    true,
  )
  assert.equal(
    s.locked((tx) => warnOnce(tx.state, 'CX43', 'this session was started by gap7-remote-client, not by the Codex TUI.', T0)),
    false,
  )
  assert.deepEqual(s.read().warned, ['CX43'])
  assert.deepEqual(s.takeNotices(T0), ['this session was started by gap7-remote-client, not by the Codex TUI.'])
})

test('store: listSessions gives the sessions newest first, with the cwd of the root rollout', (t) => {
  const w = world(t)
  const roll = join(w.data, '..', 'rollout-a.jsonl')
  fakeRollout(roll).sessionMeta({ originator: 'codex-tui', source: 'cli', cwd: '/work/app' })
  const a = w.store({ sid: 'SA' })
  a.locked((tx) => {
    tx.state.transcript = roll
  })
  const b = w.store({ sid: 'SB' })
  b.locked((tx) => {
    tx.state.transcript = null
  })
  mkdirSync(join(w.data, 'sessions', 'SC'), { recursive: true }) // no state.json: left out
  const old = (Date.now() - 60_000) / 1000
  utimesSync(join(w.data, 'sessions', 'SA', 'state.json'), old, old)
  const rows = listSessions({ data: w.data })
  assert.deepEqual(
    rows.map((r) => [r.sid, r.cwd]),
    [
      ['SB', undefined],
      ['SA', '/work/app'],
    ],
  )
  assert.ok((rows[0]?.mtime ?? 0) > (rows[1]?.mtime ?? 0))
  assert.deepEqual(listSessions({ data: join(w.data, 'none') }), [])
})

test('store: listSessions with a cutoff leaves out an older folder before it reads its files', (t) => {
  const w = world(t)
  const roll = join(w.data, '..', 'rollout-a.jsonl')
  fakeRollout(roll).sessionMeta({ originator: 'codex-tui', source: 'cli', cwd: '/work/app' })
  for (const sid of ['SA', 'SB']) {
    w.store({ sid }).locked((tx) => {
      tx.state.transcript = roll
    })
  }
  const now = Date.now()
  const old = (now - 25 * 3_600_000) / 1000
  utimesSync(join(w.data, 'sessions', 'SA', 'state.json'), old, old)
  // Bad JSON in the old folder: a read of it would give a row with no cwd.
  writeFileSync(join(w.data, 'sessions', 'SA', 'state.json'), '{ not json')
  utimesSync(join(w.data, 'sessions', 'SA', 'state.json'), old, old)
  assert.deepEqual(
    listSessions({ data: w.data }).map((r) => [r.sid, r.cwd]),
    [
      ['SB', '/work/app'],
      ['SA', undefined],
    ],
  )
  assert.deepEqual(
    listSessions({ data: w.data }, now - 24 * 3_600_000).map((r) => [r.sid, r.cwd]),
    [['SB', '/work/app']],
  )
})

test('store: pruneSessions removes only the old folders that nothing needs, once a day, under the session lock', (t) => {
  const w = world(t)
  const now = T0
  const LIVE = 77
  const alive = (p: number): boolean => p === LIVE
  const setup = (sid: string, fn: (tx: Parameters<Parameters<ReturnType<typeof w.store>['locked']>[0]>[0]) => void): string => {
    w.store({ sid }).locked(fn)
    return join(w.data, 'sessions', sid)
  }
  /** Sets the mtime of each file of a session folder to `ms` before `now`. */
  const age = (dir: string, ms: number): void => {
    const at = (now - ms) / 1000
    for (const name of readdirSync(dir)) {
      if (name === 'threads') for (const th of readdirSync(join(dir, 'threads'))) utimesSync(join(dir, 'threads', th), at, at)
      else utimesSync(join(dir, name), at, at)
    }
  }
  const OLD = PRUNE_AFTER_MS + 60_000
  const dirs = {
    old: setup('S-OLD', (tx) => {
      tx.state.hostPid = 12
      tx.state.warned = ['CX6']
      tx.thread('T1').brokerPid = 13
    }),
    recent: setup('S-RECENT', (tx) => {
      tx.state.hostPid = 12
    }),
    question: setup('S-QUESTION', (tx) => {
      tx.setQuestion(question('k1'))
    }),
    stop: setup('S-STOP', (tx) => {
      tx.state.stopped = `S-STOP ${now + 3_600_000} ${now - OLD} five_hour`
    }),
    oldStop: setup('S-OLDSTOP', (tx) => {
      tx.state.stopped = `S-OLDSTOP ${now - OLD} ${now - OLD - 3_600_000} five_hour`
    }),
    host: setup('S-HOST', (tx) => {
      tx.state.hostPid = LIVE
    }),
    broker: setup('S-BROKER', (tx) => {
      tx.thread('T2').brokerPid = LIVE
    }),
    edited: setup('S-EDITED', (tx) => {
      tx.state.hostPid = 12
    }),
    locked: setup('S-LOCKED', (tx) => {
      tx.state.hostPid = 12
    }),
  }
  writeFileSync(join(dirs.edited, 'state.json'), '{ not json')
  for (const [k, dir] of Object.entries(dirs)) if (k !== 'recent') age(dir, OLD)
  age(dirs.recent, PRUNE_AFTER_MS - 2 * PRUNE_EVERY_MS)
  const trash = join(w.data, 'sessions', '.pruned-S-GONE-abcd1234')
  mkdirSync(join(trash, 'threads'), { recursive: true })
  mkdirSync(join(w.data, 'sessions', '.none'), { recursive: true })
  // A live lock of another process: the folder stays.
  const gone = withLock(join(dirs.locked, 'state.lock'), 'other', () => pruneSessions({ data: w.data }, 'broker-1', now, alive))
  assert.deepEqual(gone.sort(), ['S-OLD', 'S-OLDSTOP'])
  const left = readdirSync(join(w.data, 'sessions')).sort()
  assert.deepEqual(left, ['.none', 'S-BROKER', 'S-EDITED', 'S-HOST', 'S-LOCKED', 'S-QUESTION', 'S-RECENT', 'S-STOP'])
  assert.equal(listSessions({ data: w.data }).some((r) => r.sid === 'S-OLD'), false)
  assert.equal(readFileSync(join(w.data, 'pruned'), 'utf8'), String(now), 'the time of the prune, beside sessions/')
  // Once a day: a second prune in the same day does nothing, also with the lock free now.
  assert.deepEqual(pruneSessions({ data: w.data }, 'broker-1', now + 60_000, alive), [])
  assert.ok(existsSync(dirs.locked))
  assert.deepEqual(pruneSessions({ data: w.data }, 'broker-1', now + PRUNE_EVERY_MS, alive), ['S-LOCKED'])
  // A session that a broker resumes later starts a fresh folder.
  assert.deepEqual(w.store({ sid: 'S-OLD' }).read(), freshState('S-OLD'))
  // No sessions folder: no prune, and no folder made.
  const empty = join(w.data, '..', 'empty')
  assert.deepEqual(pruneSessions({ data: empty }, 'broker-1', now, alive), [])
  assert.equal(existsSync(empty), false)
})
