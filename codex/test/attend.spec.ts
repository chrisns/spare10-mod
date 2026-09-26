import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { codexText } from '../../hooks/core/codex.ts'
import type { HostKind } from '../../hooks/core/codex.ts'
import { createAttendance, nestedParent, noteOriginator, parentChildOf } from '../src/attend.ts'
import { createRollouts } from '../src/rollout.ts'
import { sessionStore } from '../src/store.ts'
import { fakeRollout } from './helpers/rollout.ts'
import type { MetaSpec } from './helpers/rollout.ts'
import { tempDir } from './helpers/tmp.ts'
import { memoryWake } from './helpers/wake.ts'

// Attendance (Codex design 3.10, 8.2 attend.spec): the rows of attendedFrom through the rollout of the
// thread, the kept answer, CX43 once per session, and the parent policy of a nested run.

const T0 = Date.UTC(2026, 8, 26, 10)
const SID = '01a0da06-c266-7842-bc97-1128f6549960'
const SUBAGENT_SOURCE = { subagent: { thread_spawn: { parent_thread_id: SID, depth: 1, agent_path: null, agent_nickname: 'Fermat', agent_role: null } } }

function rolloutWith(t: Parameters<typeof tempDir>[0], meta: MetaSpec | undefined): string {
  const path = join(tempDir(t), 'rollout.jsonl')
  const r = fakeRollout(path)
  if (meta !== undefined) r.sessionMeta(meta)
  r.tokenCount({ at: T0, primary: { pct: 10, mins: 300, resetsAt: T0 + 3_600_000 } })
  return path
}

const attendedOf = (hostKind: HostKind, transcript: string | null, mode?: string) =>
  createAttendance({ hostKind, rollouts: createRollouts() }).attended({ transcript }, mode)

test('attend: the rows of 3.10 through the rollout of the thread', (t) => {
  const rows: Array<[string, HostKind, MetaSpec | undefined, { attended: boolean; warnOriginator?: string }]> = [
    ['embedded TUI', 'tui', { originator: 'codex-tui', source: 'cli' }, { attended: true }],
    ['TUI on the daemon', 'daemon', { originator: 'codex-tui', source: 'vscode' }, { attended: true }],
    ['codex exec', 'exec', { originator: 'codex_exec', source: 'exec' }, { attended: false }],
    ['codex exec resume of a TUI thread', 'exec', { originator: 'codex-tui', source: 'cli' }, { attended: false }],
    ['exec thread on the daemon', 'daemon', { originator: 'codex_exec', source: 'exec' }, { attended: false }],
    ['desktop app on its app-server', 'app-server', { originator: 'Codex Desktop', source: 'vscode' }, { attended: false }],
    ['IDE extension on its app-server', 'app-server', { originator: 'codex_vscode', source: 'vscode' }, { attended: false }],
    ['SDK', 'app-server', { originator: 'codex_sdk_ts', source: 'vscode' }, { attended: false }],
    ['desktop app on the daemon', 'daemon', { originator: 'Codex Desktop', source: 'vscode' }, { attended: false }],
    ['unknown app on the daemon', 'daemon', { originator: 'gap7-remote-client', source: 'vscode' }, { attended: true, warnOriginator: 'gap7-remote-client' }],
    ['subagent of a TUI root', 'tui', { originator: 'codex-tui', source: SUBAGENT_SOURCE }, { attended: true }],
    ['subagent of an exec root on the daemon', 'daemon', { originator: 'codex_exec', source: SUBAGENT_SOURCE }, { attended: false }],
    ['no session_meta on the TUI', 'tui', undefined, { attended: true }],
    ['no session_meta on the daemon', 'daemon', undefined, { attended: false }],
  ]
  for (const [name, hostKind, meta, want] of rows) {
    assert.deepEqual(attendedOf(hostKind, rolloutWith(t, meta)), want, name)
  }
})

test('attend: an ephemeral thread (no rollout) is attended on the TUI and the daemon, unless approval is never', () => {
  assert.deepEqual(attendedOf('tui', null), { attended: true })
  assert.deepEqual(attendedOf('daemon', null), { attended: true })
  assert.deepEqual(attendedOf('app-server', null), { attended: false })
  assert.deepEqual(attendedOf('daemon', null, 'bypassPermissions'), { attended: false })
  assert.deepEqual(attendedOf('tui', null, 'default'), { attended: true })
  assert.deepEqual(attendedOf('exec', null), { attended: false })
})

test('attend: an answer is kept once final, and a rollout with no session_meta yet is read again', (t) => {
  const path = join(tempDir(t), 'rollout.jsonl')
  const a = createAttendance({ hostKind: 'daemon', rollouts: createRollouts() })
  assert.deepEqual(a.attended({ transcript: path }), { attended: false }, 'no file yet')
  fakeRollout(path).sessionMeta({ originator: 'codex-tui', source: 'vscode' })
  assert.deepEqual(a.attended({ transcript: path }), { attended: true })
  // Kept: a later change of the file does not change it.
  writeFileSync(path, '')
  assert.deepEqual(a.attended({ transcript: path }), { attended: true })
  // The mode is part of the key.
  assert.deepEqual(a.attended({ transcript: null }, 'bypassPermissions'), { attended: false })
  assert.deepEqual(a.attended({ transcript: null }), { attended: true })
})

test('attend: CX43 is queued once per session', (t) => {
  const data = join(tempDir(t), 'data')
  const store = sessionStore({ data }, SID, 'broker-1', memoryWake())
  const a = attendedOf('daemon', rolloutWith(t, { originator: 'gap7-remote-client', source: 'vscode' }))
  assert.equal(noteOriginator(store, a, T0), true)
  assert.equal(noteOriginator(store, a, T0), false)
  assert.equal(noteOriginator(store, { attended: true }, T0), false)
  assert.deepEqual(store.read().warned, ['CX43'])
  assert.deepEqual(store.takeNotices(T0), [codexText.originator('gap7-remote-client')])
})

test('attend: a nested run names its parent session, and takes the child policy the parent wrote', (t) => {
  const data = join(tempDir(t), 'data')
  assert.equal(nestedParent({}, SID), undefined)
  assert.equal(nestedParent({ CODEX_SESSION_ID: SID }, SID), undefined, 'the same session is not nested')
  assert.equal(nestedParent({ CODEX_SESSION_ID: '' }, SID), undefined)
  assert.equal(nestedParent({ CODEX_SESSION_ID: 'PARENT' }, SID), 'PARENT')
  const env = { CODEX_SESSION_ID: 'PARENT' }
  assert.equal(parentChildOf({ data }, env, SID), undefined, 'no parent state')
  sessionStore({ data }, 'PARENT', 'root', memoryWake()).locked((tx) => {
    tx.state.child = 'stop'
  })
  assert.equal(parentChildOf({ data }, env, SID), 'stop')
  assert.equal(parentChildOf({ data }, {}, SID), undefined)
  const dir = join(data, 'sessions', 'NEWER')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ v: 2, child: 'stop' }))
  assert.equal(parentChildOf({ data }, { CODEX_SESSION_ID: 'NEWER' }, SID), undefined, 'another format counts as none')
  assert.throws(() => parentChildOf({ data }, { CODEX_SESSION_ID: '../x' }, SID), /cannot name a file/)
})
