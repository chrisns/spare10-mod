import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, fromOptions } from '../../hooks/core/config.ts'
import {
  HARD_STOP_MAX_AGE_MS,
  LIVE_LUNA_MAX_AGE_MS,
  OPTIONS,
  RESET_JITTER_MS,
  UNATTENDED_ORIGINATORS,
  answerOf,
  attendedFrom,
  blindFrom,
  codexLimits,
  codexText,
  configOptions,
  elicitParams,
  hardStopOf,
  hostKindOf,
  initialPresence,
  isCodexBucket,
  isObservation,
  kindOfMinutes,
  liveOf,
  nearTrip,
  nextPresence,
  offQuota,
  optionOf,
  optionText,
  parseAutoResumeOption,
  parseCommand,
  parseSetValue,
  pickSeed,
  refuseModeOf,
  render,
  rootOnly,
  sessionMetaOf,
  tokenCountOf,
  turnContextOf,
  turnEndOf,
  unsafeMode,
  usableCredits,
  voidedByReset,
  withPrefix,
} from '../../hooks/core/codex.ts'
import type { CodexSnapshot, GateResult, GateSite, HostKind, LiveRead, OptionName, Presence } from '../../hooks/core/codex.ts'
import type { Kind } from '../../hooks/core/reading.ts'

// The pure Codex rules of hooks/core/codex.ts (Codex design 7.1, 8.2 core-codex.spec). They run under the
// Codex host words (codex/test/host-loader.mjs). The probe lines come from the research homes of
// the model-free research probes (gap 3, 6, 7 and 8), with shorter paths.

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.parse('2026-09-25T20:00:00.000Z')
const RESET_S = 1790693559 // 2026-09-29T14:52:39Z, the weekly reset of the probed account
const RESET_ISO = '2026-09-29T14:52:39.000Z'

// ---- Windows ----

test('kindOfMinutes classifies a window by its minutes, never by its slot', () => {
  const cases: Array<[number | null | undefined, Kind | undefined]> = [
    [284, undefined],
    [285, 'five_hour'],
    [300, 'five_hour'],
    [315, 'five_hour'],
    [316, undefined],
    [9575, undefined],
    [9576, 'seven_day'],
    [10080, 'seven_day'],
    [10584, 'seven_day'],
    [10585, undefined],
    [1440, undefined],
    [43200, undefined],
    [null, undefined],
    [undefined, undefined],
    [Number.NaN, undefined],
  ]
  for (const [mins, kind] of cases) assert.equal(kindOfMinutes(mins), kind, `minutes ${String(mins)}`)
})

test('codexLimits: the 5-hour window in primary', () => {
  const s: CodexSnapshot = { limit_id: 'codex', primary: { used_percent: 91.5, window_minutes: 300, resets_at: 1790367448 }, secondary: null }
  assert.deepEqual(codexLimits(s), [{ kind: 'five_hour', percentUsed: 91.5, resetsAt: new Date(1790367448 * 1000).toISOString() }])
})

test('codexLimits: the weekly window in primary, as this account has it', () => {
  const s: CodexSnapshot = { limitId: 'codex', primary: { usedPercent: 96, windowDurationMins: 10080, resetsAt: RESET_S }, secondary: null }
  assert.deepEqual(codexLimits(s), [{ kind: 'seven_day', percentUsed: 96, resetsAt: RESET_ISO }])
})

test('codexLimits: swapped slots and both windows give KINDS order', () => {
  const swapped: CodexSnapshot = {
    limit_id: 'codex',
    primary: { used_percent: 40, window_minutes: 10080, resets_at: RESET_S },
    secondary: { used_percent: 91.5, window_minutes: 300, resets_at: 1790367448 },
  }
  assert.deepEqual(
    codexLimits(swapped).map((l) => [l.kind, l.percentUsed]),
    [
      ['five_hour', 91.5],
      ['seven_day', 40],
    ],
  )
  const both: CodexSnapshot = { ...swapped, primary: swapped.secondary ?? null, secondary: swapped.primary ?? null }
  assert.deepEqual(codexLimits(both), codexLimits(swapped))
})

test('codexLimits: a monthly window is not watched, the weekly one is', () => {
  const s: CodexSnapshot = {
    limit_id: 'codex',
    primary: { used_percent: 12, window_minutes: 10080, resets_at: RESET_S },
    secondary: { used_percent: 80, window_minutes: 43200, resets_at: RESET_S + 30 * 86400 },
  }
  assert.deepEqual(codexLimits(s), [{ kind: 'seven_day', percentUsed: 12, resetsAt: RESET_ISO }])
})

test('codexLimits: a premium bucket gives nothing, a null or missing limit id is the codex bucket', () => {
  const w = { used_percent: 50, window_minutes: 300, resets_at: 1790367448 }
  assert.deepEqual(codexLimits({ limit_id: 'premium', primary: w }), [])
  assert.deepEqual(codexLimits({ limitId: 'premium', primary: w }), [])
  assert.equal(codexLimits({ limit_id: null, primary: w }).length, 1)
  assert.equal(codexLimits({ primary: w }).length, 1)
  assert.equal(isCodexBucket({ limit_id: 'premium' }), false)
  assert.equal(isCodexBucket({ limitId: null, limit_id: 'premium' }), true) // the camelCase field wins
})

test('codexLimits: resets_at as seconds, a digit string or RFC 3339, and a float percent to one decimal', () => {
  const at = (r: number | string | null) => codexLimits({ primary: { used_percent: 91.54, window_minutes: 300, resets_at: r } })[0]
  assert.deepEqual(at(RESET_S), { kind: 'five_hour', percentUsed: 91.5, resetsAt: RESET_ISO })
  assert.deepEqual(at(String(RESET_S)), { kind: 'five_hour', percentUsed: 91.5, resetsAt: RESET_ISO })
  assert.deepEqual(at('2026-09-29T14:52:39Z'), { kind: 'five_hour', percentUsed: 91.5, resetsAt: RESET_ISO })
  assert.deepEqual(at('2026-09-29T16:52:39+02:00'), { kind: 'five_hour', percentUsed: 91.5, resetsAt: RESET_ISO })
  assert.deepEqual(at(null), { kind: 'five_hour', percentUsed: 91.5 })
  assert.deepEqual(at('soon'), { kind: 'five_hour', percentUsed: 91.5 })
  assert.equal(codexLimits({ primary: { used_percent: 91.55, window_minutes: 300 } })[0]?.percentUsed, 91.6)
  assert.equal(codexLimits({ primary: { usedPercent: 100, windowDurationMins: 10080 } })[0]?.percentUsed, 100)
})

test('isObservation: a codex bucket with a window of any length. The window-less 429 marker is not one', () => {
  assert.equal(isObservation({ limit_id: 'codex', primary: { used_percent: 11, window_minutes: 10080, resets_at: RESET_S } }), true)
  assert.equal(isObservation({ limit_id: 'codex', primary: { used_percent: 11, window_minutes: 43200 } }), true)
  assert.equal(isObservation({ limit_id: 'codex', primary: null, secondary: null }), false)
  assert.equal(isObservation({ limit_id: 'premium', primary: { used_percent: 11, window_minutes: 300 } }), false)
  assert.equal(isObservation({ limit_id: 'codex', primary: { window_minutes: 300 } }), false)
})

// ---- Presence and blindness ----

const WEEKLY: CodexSnapshot = { limit_id: 'codex', primary: { used_percent: 61, window_minutes: 10080, resets_at: RESET_S } }
const BOTH: CodexSnapshot = { ...WEEKLY, secondary: { used_percent: 30, window_minutes: 300, resets_at: 1790367448 } }
const WINDOWLESS: CodexSnapshot = { limit_id: 'codex', primary: null, secondary: null }
const noSeed = (): boolean => false

test('nextPresence: before any observation both kinds are present', () => {
  assert.deepEqual(initialPresence(), { present: ['five_hour', 'seven_day'], count: {} })
})

test('nextPresence: one window-less snapshot, or one premium snapshot, changes nothing', () => {
  const p = initialPresence()
  assert.equal(nextPresence(p, WINDOWLESS, noSeed), p)
  assert.equal(nextPresence(p, { limit_id: 'premium', primary: null }, noSeed), p)
})

test('nextPresence: one snapshot without a kind changes nothing, two in a row make it absent', () => {
  const one = nextPresence(initialPresence(), WEEKLY, noSeed)
  assert.deepEqual(one, { present: ['five_hour', 'seven_day'], count: { five_hour: 1, seven_day: 0 } })
  const two = nextPresence(one, WEEKLY, noSeed)
  assert.deepEqual(two, { present: ['seven_day'], count: { five_hour: 2, seven_day: 0 } })
  // A window-less snapshot between them does not reset the count.
  const again = nextPresence(nextPresence(one, WINDOWLESS, noSeed), WEEKLY, noSeed)
  assert.deepEqual(again.present, ['seven_day'])
  // An observation with the kind makes it present at once.
  const back = nextPresence(two, BOTH, noSeed)
  assert.deepEqual(back, { present: ['five_hour', 'seven_day'], count: { five_hour: 0, seven_day: 0 } })
})

test('nextPresence: never absent while its seed is in its window', () => {
  let p: Presence = initialPresence()
  const fiveSeed = (k: Kind): boolean => k === 'five_hour'
  for (let i = 0; i < 5; i += 1) p = nextPresence(p, WEEKLY, fiveSeed)
  assert.deepEqual(p.present, ['five_hour', 'seven_day'])
  assert.equal(p.count.five_hour, 5)
  // The seed leaves its window: the next observation makes the kind absent.
  assert.deepEqual(nextPresence(p, WEEKLY, noSeed).present, ['seven_day'])
})

test('blindFrom: the last two good live reads have no window at all', () => {
  assert.equal(blindFrom([]), false)
  assert.equal(blindFrom([WINDOWLESS]), false)
  assert.equal(blindFrom([WINDOWLESS, WINDOWLESS]), true)
  assert.equal(blindFrom([WEEKLY, WINDOWLESS, WINDOWLESS]), true)
  assert.equal(blindFrom([WINDOWLESS, WEEKLY]), false)
  assert.equal(blindFrom([WINDOWLESS, WINDOWLESS, WEEKLY]), false)
  // A window of a length spare10 does not watch is still a window: not blind.
  const monthly: CodexSnapshot = { limit_id: 'codex', primary: { used_percent: 5, window_minutes: 43200 } }
  assert.equal(blindFrom([monthly, monthly]), false)
  assert.equal(blindFrom([{ limit_id: 'premium' }, { limit_id: 'premium' }]), false)
})

test('blindFrom: a good live read with no codex bucket is no window-less codex read, and it breaks the row (3.6)', () => {
  // quota.ts keeps null for a good live read that has no codex bucket. An empty object names no bucket either.
  assert.equal(blindFrom([{}, {}]), false)
  assert.equal(blindFrom([null, null]), false)
  assert.equal(blindFrom([WINDOWLESS, null]), false)
  assert.equal(blindFrom([WINDOWLESS, {}]), false)
  assert.equal(blindFrom([null, WINDOWLESS, WINDOWLESS]), true)
  // The daemon's own shape: every key is there, with null for no value.
  const daemon: CodexSnapshot = { limitId: null, primary: null, secondary: null }
  assert.equal(blindFrom([daemon, { ...daemon, limitId: 'codex' }]), true)
})

// ---- Seeds, credits, near trip, early reset ----

test('pickSeed: the newer observation wins over a jittered later reset', () => {
  const R = Date.parse(RESET_ISO)
  const older = { pct: 91, resetsAtMs: R + 20_000, at: NOW - MIN }
  const newer = { pct: 92, resetsAtMs: R, at: NOW }
  assert.deepEqual(pickSeed(older, newer), { pct: 92, resetsAtMs: R })
  assert.deepEqual(pickSeed(newer, older), { pct: 92, resetsAtMs: R })
  // A reset credit starts a new window: its newer observation wins.
  const fresh = { pct: 0, resetsAtMs: NOW + 7 * DAY, at: NOW }
  assert.deepEqual(pickSeed({ pct: 96, resetsAtMs: R, at: NOW - HOUR }, fresh), { pct: 0, resetsAtMs: NOW + 7 * DAY })
  // At the same time: resets within the jitter are one window (the higher percent), else the later window.
  assert.deepEqual(pickSeed({ pct: 91, resetsAtMs: R + 30_000, at: NOW }, { pct: 92, resetsAtMs: R, at: NOW }), { pct: 92, resetsAtMs: R })
  assert.deepEqual(pickSeed({ pct: 91, resetsAtMs: R + RESET_JITTER_MS + 1, at: NOW }, { pct: 92, resetsAtMs: R, at: NOW }), {
    pct: 91,
    resetsAtMs: R + RESET_JITTER_MS + 1,
  })
  assert.deepEqual(pickSeed(undefined, newer), { pct: 92, resetsAtMs: R })
  assert.deepEqual(pickSeed(older, undefined), { pct: 91, resetsAtMs: R + 20_000 })
  assert.equal(pickSeed(undefined, undefined), undefined)
})

test('usableCredits: unlimited, or a balance, in either field form', () => {
  assert.equal(usableCredits({ hasCredits: true, unlimited: false, balance: '500' }), true)
  assert.equal(usableCredits({ has_credits: true, unlimited: false, balance: '3' }), true)
  assert.equal(usableCredits({ hasCredits: false, unlimited: true, balance: null }), true)
  assert.equal(usableCredits({ hasCredits: false, unlimited: false, balance: '0' }), false)
  assert.equal(usableCredits({ has_credits: false, unlimited: false, balance: '0' }), false)
  assert.equal(usableCredits(null), false)
  assert.equal(usableCredits(undefined), false)
})

test('nearTrip: within 5 points of the trip point, or of a floor point', () => {
  assert.equal(nearTrip(86, 90), true)
  assert.equal(nearTrip(85, 90), true)
  assert.equal(nearTrip(84.9, 90), false)
  assert.equal(nearTrip(80, 90), false)
  assert.equal(nearTrip(undefined, 90), false)
  assert.equal(nearTrip(97, 90), true)
  // A floor point below the trip point (a trip point past 95) still counts.
  assert.equal(nearTrip(91, 97, 95), true)
  assert.equal(nearTrip(89, 97, 95), false)
})

test('voidedByReset: the same window with jitter keeps a consent, a reset credit or a real reset after a fallback end voids it', () => {
  const R = Date.parse(RESET_ISO)
  assert.equal(voidedByReset({ until: R }, R + 30_000), false)
  assert.equal(voidedByReset({ until: R }, R - 30_000), false)
  assert.equal(voidedByReset({ until: R, to: 95 }, R + RESET_JITTER_MS), false)
  // A reset credit: the new weekly window ends 7 days from now.
  assert.equal(voidedByReset({ until: R }, NOW + 7 * DAY), true)
  // A consent with the one-hour fallback end (no reset known), then a real reset 4 h later.
  assert.equal(voidedByReset({ until: NOW + HOUR }, NOW + 5 * HOUR), true)
  assert.equal(voidedByReset({ until: R }, R + RESET_JITTER_MS + 1), true)
})

// ---- Rollout lines ----

const TOKEN_5H =
  '{"timestamp":"2026-09-25T19:19:19.491Z","ordinal":11,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":0,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0,"total_tokens":0},"last_token_usage":{"input_tokens":0,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0,"total_tokens":0},"model_context_window":258400},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":91.5,"window_minutes":300,"resets_at":1790367448},"secondary":{"used_percent":40.0,"window_minutes":10080,"resets_at":1790623048},"credits":null,"individual_limit":null,"spend_control_reached":null,"plan_type":null,"rate_limit_reached_type":null}}}'
const TOKEN_EMPTY =
  '{"timestamp":"2026-09-25T20:00:23.841Z","ordinal":12,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0,"total_tokens":2},"last_token_usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0,"total_tokens":2},"model_context_window":258400},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":null,"secondary":null,"credits":null,"individual_limit":null,"spend_control_reached":null,"plan_type":null,"rate_limit_reached_type":null}}}'
const TOKEN_REAL =
  '{"timestamp":"2026-09-25T19:02:00.082Z","ordinal":108,"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":96.0,"window_minutes":10080,"resets_at":1790693559},"secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"individual_limit":null,"spend_control_reached":null,"plan_type":"prolite","rate_limit_reached_type":null}}}'
const TOKEN_PREMIUM =
  '{"timestamp":"2026-09-10T18:45:52.000Z","ordinal":9,"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"limit_id":"premium","limit_name":null,"primary":null,"secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"individual_limit":null,"spend_control_reached":null,"plan_type":"prolite","rate_limit_reached_type":null}}}'
const META_TUI =
  '{"timestamp":"2026-09-25T19:24:41.835Z","ordinal":0,"type":"session_meta","payload":{"session_id":"01a0da06-c266-7842-bc97-1128f6549960","id":"01a0da06-c266-7842-bc97-1128f6549960","timestamp":"2026-09-25T19:24:31.206Z","cwd":"/tmp/x/proj","originator":"codex-tui","cli_version":"0.157.0","source":"cli","thread_source":"user","model_provider":"mock","base_instructions":{"text":"You are a coding agent."}}}'
const META_DAEMON_TUI =
  '{"timestamp":"2026-09-25T20:01:07.977Z","ordinal":0,"type":"session_meta","payload":{"session_id":"01a0da28-3f78-7183-be3c-136bb1bd62fa","id":"01a0da28-3f78-7183-be3c-136bb1bd62fa","timestamp":"2026-09-25T20:01:05.912Z","cwd":"/tmp/x/proj","originator":"codex-tui","cli_version":"0.157.0","source":"vscode","model_provider":"mock"}}'
const META_EXEC =
  '{"timestamp":"2026-09-25T19:23:16.530Z","ordinal":0,"type":"session_meta","payload":{"session_id":"01a0da05-9e86-72b1-a09b-b18456d3aba4","id":"01a0da05-9e86-72b1-a09b-b18456d3aba4","timestamp":"2026-09-25T19:23:16.486Z","cwd":"/tmp/x/proj","originator":"codex_exec","cli_version":"0.157.0","source":"exec","thread_source":"user","model_provider":"mock"}}'
const META_REMOTE =
  '{"timestamp":"2026-09-25T20:00:21.189Z","ordinal":0,"type":"session_meta","payload":{"session_id":"01a0da27-88da-79a0-b865-af8e99b79752","id":"01a0da27-88da-79a0-b865-af8e99b79752","timestamp":"2026-09-25T20:00:19.163Z","cwd":"/tmp/x/proj","originator":"gap7-remote-client","cli_version":"0.157.0","source":"vscode","model_provider":"mock"}}'
const META_SUBAGENT =
  '{"timestamp":"2026-09-25T20:04:22.679Z","ordinal":0,"type":"session_meta","payload":{"session_id":"01a0da2b-1400-7ba3-9173-d9af3081462d","id":"01a0da2b-3ff7-7ad0-b5ee-c6281c89518f","parent_thread_id":"01a0da2b-1400-7ba3-9173-d9af3081462d","timestamp":"2026-09-25T20:04:22.647Z","cwd":"/tmp/x/proj","originator":"codex-tui","cli_version":"0.157.0","source":{"subagent":{"thread_spawn":{"parent_thread_id":"01a0da2b-1400-7ba3-9173-d9af3081462d","depth":1,"agent_path":null,"agent_nickname":"Fermat","agent_role":null}}},"thread_source":"subagent","agent_nickname":"Fermat","model_provider":"mock"}}'
const ABORTED =
  '{"timestamp":"2026-09-25T19:21:34.161Z","ordinal":64,"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"01a0da04-02c6-7c70-93d8-0b14fdbfc155","reason":"interrupted","started_at":1790364091,"completed_at":1790364094,"duration_ms":3082}}'
const ABORTED_NO_START =
  '{"timestamp":"2026-09-25T19:58:10.000Z","ordinal":20,"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"01a0da25-0000-7000-8000-000000000001","reason":"interrupted"}}'
const COMPLETE =
  '{"timestamp":"2026-09-25T20:00:23.908Z","ordinal":17,"type":"event_msg","payload":{"type":"task_complete","turn_id":"01a0da27-9a16-7a63-9a59-80a8b8e58289","last_agent_message":"done after tool","started_at":1790366423,"completed_at":1790366423,"duration_ms":333,"time_to_first_token_ms":138}}'
const STARTED =
  '{"timestamp":"2026-09-25T20:00:23.576Z","ordinal":1,"type":"event_msg","payload":{"type":"task_started","turn_id":"01a0da27-9a16-7a63-9a59-80a8b8e58289","root_turn_id":"01a0da27-9a16-7a63-9a59-80a8b8e58289","started_at":1790366423,"model_context_window":258400,"collaboration_mode_kind":"default"}}'
const CONTEXT_READ_ONLY =
  '{"timestamp":"2026-09-25T20:00:23.580Z","ordinal":5,"type":"turn_context","payload":{"turn_id":"01a0da27-9a16-7a63-9a59-80a8b8e58289","cwd":"/tmp/x/proj","approval_policy":"on-request","approvals_reviewer":"user","sandbox_policy":{"type":"read-only"},"permission_profile":{"type":"managed","file_system":{"type":"restricted","entries":[{"path":{"type":"special","value":{"kind":"root"}},"access":"read"}]},"network":"restricted"},"model":"mock-model"}}'
const CONTEXT_WRITE =
  '{"timestamp":"2026-09-25T20:30:00.580Z","ordinal":5,"type":"turn_context","payload":{"turn_id":"t2","cwd":"/tmp/x/proj","approval_policy":"never","approvals_reviewer":"user","sandbox_policy":{"type":"workspace-write","network_access":false,"exclude_tmpdir_env_var":false,"exclude_slash_tmp":false},"permission_profile":{"type":"managed","file_system":{"type":"restricted","entries":[{"path":{"type":"special","value":{"kind":"root"}},"access":"read"},{"path":{"type":"path","path":"/tmp/x/proj"},"access":"write"},{"path":{"type":"special","value":{"kind":"slash_tmp"}},"access":"write"},{"path":{"type":"special","value":{"kind":"tmpdir"}},"access":"write"},{"path":{"type":"path","path":"/tmp/x/proj/.git"},"access":"read","missing_path_behavior":"skip"}]},"network":"restricted"}}}'
const CONTEXT_YOLO =
  '{"timestamp":"2026-09-25T21:23:28.000Z","ordinal":5,"type":"turn_context","payload":{"turn_id":"t3","approval_policy":"never","approvals_reviewer":"user","sandbox_policy":{"type":"danger-full-access"},"permission_profile":{"type":"disabled"}}}'

test('tokenCountOf reads the time and the snapshot of a token_count line', () => {
  assert.deepEqual(tokenCountOf(TOKEN_5H), {
    at: Date.parse('2026-09-25T19:19:19.491Z'),
    snapshot: {
      limit_id: 'codex',
      limit_name: null,
      primary: { used_percent: 91.5, window_minutes: 300, resets_at: 1790367448 },
      secondary: { used_percent: 40.0, window_minutes: 10080, resets_at: 1790623048 },
      credits: null,
      individual_limit: null,
      spend_control_reached: null,
      plan_type: null,
      rate_limit_reached_type: null,
    },
  })
  const real = tokenCountOf(TOKEN_REAL)
  assert.ok(real !== undefined)
  assert.deepEqual(codexLimits(real.snapshot), [{ kind: 'seven_day', percentUsed: 96, resetsAt: RESET_ISO }])
  assert.equal(usableCredits(real.snapshot.credits), false)
  const empty = tokenCountOf(TOKEN_EMPTY)
  assert.ok(empty !== undefined)
  assert.equal(isObservation(empty.snapshot), false)
  const premium = tokenCountOf(TOKEN_PREMIUM)
  assert.ok(premium !== undefined)
  assert.equal(isCodexBucket(premium.snapshot), false)
  for (const other of [META_TUI, ABORTED, COMPLETE, STARTED, CONTEXT_READ_ONLY, '', 'not json "token_count"', '{"type":"event_msg","payload":{"type":"token_count","rate_limits":null}}']) {
    assert.equal(tokenCountOf(other), undefined, other.slice(0, 60))
  }
  // A line with no time cannot be ordered.
  assert.equal(tokenCountOf('{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex"}}}'), undefined)
})

test('sessionMetaOf reads the originator and the source of the first line', () => {
  assert.deepEqual(sessionMetaOf(META_TUI), { type: 'session_meta', originator: 'codex-tui', source: 'cli' })
  assert.deepEqual(sessionMetaOf(META_DAEMON_TUI), { type: 'session_meta', originator: 'codex-tui', source: 'vscode' })
  assert.deepEqual(sessionMetaOf(META_EXEC), { type: 'session_meta', originator: 'codex_exec', source: 'exec' })
  assert.deepEqual(sessionMetaOf(META_SUBAGENT), {
    type: 'session_meta',
    originator: 'codex-tui',
    source: { subagent: { thread_spawn: { parent_thread_id: '01a0da2b-1400-7ba3-9173-d9af3081462d', depth: 1, agent_path: null, agent_nickname: 'Fermat', agent_role: null } } },
  })
  assert.deepEqual(sessionMetaOf('{"type":"session_meta","payload":{}}'), { type: 'session_meta' })
  for (const other of [TOKEN_5H, ABORTED, '', '{"type":"session_meta"}', 'session_meta']) assert.equal(sessionMetaOf(other), undefined)
})

test('turnEndOf reads turn_aborted and task_complete, with started_at in seconds or null', () => {
  assert.deepEqual(turnEndOf(ABORTED), { turnId: '01a0da04-02c6-7c70-93d8-0b14fdbfc155', how: 'aborted', startedAt: 1790364091 })
  assert.deepEqual(turnEndOf(ABORTED_NO_START), { turnId: '01a0da25-0000-7000-8000-000000000001', how: 'aborted', startedAt: null })
  assert.deepEqual(turnEndOf(COMPLETE), { turnId: '01a0da27-9a16-7a63-9a59-80a8b8e58289', how: 'complete', startedAt: 1790366423 })
  for (const other of [STARTED, TOKEN_5H, META_TUI, '', '{"type":"event_msg","payload":{"type":"turn_aborted"}}']) assert.equal(turnEndOf(other), undefined)
})

test('turnContextOf (P1) reads the sandbox, the approval and the writable roots', () => {
  assert.deepEqual(turnContextOf(CONTEXT_READ_ONLY), { sandbox: 'read-only', profile: 'managed', approval: 'on-request', reviewer: 'user', roots: [] })
  assert.deepEqual(turnContextOf(CONTEXT_WRITE), { sandbox: 'workspace-write', profile: 'managed', approval: 'never', reviewer: 'user', roots: ['/tmp/x/proj', '/tmp'] })
  assert.deepEqual(turnContextOf(CONTEXT_YOLO), { sandbox: 'danger-full-access', profile: 'disabled', approval: 'never', reviewer: 'user', roots: [] })
  assert.equal(turnContextOf(TOKEN_5H), undefined)
})

test('unsafeMode (P1): no sandbox, auto review, or a writable data dir', () => {
  const data = '/Users/me/.codex/plugins/data/spare10-spare10'
  assert.equal(unsafeMode(turnContextOf(CONTEXT_READ_ONLY), data), false)
  assert.equal(unsafeMode(turnContextOf(CONTEXT_YOLO), data), true)
  assert.equal(unsafeMode({ sandbox: 'external-sandbox', roots: [] }, data), true)
  assert.equal(unsafeMode({ reviewer: 'auto_review', approval: 'on-request', roots: [] }, data), true)
  assert.equal(unsafeMode({ reviewer: 'auto_review', approval: 'never', roots: [] }, data), false)
  assert.equal(unsafeMode({ roots: ['/Users/me'] }, data), true)
  assert.equal(unsafeMode({ roots: ['/Users/me/project'] }, data), false)
  // /tmp is /private/tmp on macOS.
  assert.equal(unsafeMode(turnContextOf(CONTEXT_WRITE), '/private/tmp/h/.codex/plugins/data/spare10-spare10'), true)
  assert.equal(unsafeMode(undefined, data), false)
})

// ---- Live reads ----

const PROBED = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: 96, windowDurationMins: 10080, resetsAt: RESET_S },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    individualLimit: null,
    spendControlReached: false,
    planType: 'prolite',
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex',
      limitName: null,
      normalModelSlug: null,
      primary: { usedPercent: 96, windowDurationMins: 10080, resetsAt: RESET_S },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      individualLimit: null,
      spendControlReached: false,
      planType: 'prolite',
      rateLimitReachedType: null,
    },
  },
  rateLimitResetCredits: { availableCount: 1, credits: null },
  accountId: 'redacted',
  rateLimitUpsell: null,
}

test('liveOf reads the probed account/rateLimits/read response', () => {
  const r = liveOf(PROBED, NOW, 'daemon')
  assert.ok(!('error' in r))
  assert.equal(r.at, NOW)
  assert.equal(r.route, 'daemon')
  assert.equal(r.allowed, true)
  assert.equal(r.reached, null)
  assert.equal(r.spendControl, false)
  assert.deepEqual(r.credits, { hasCredits: false, unlimited: false, balance: '0' })
  assert.ok(r.codex !== undefined)
  assert.deepEqual(codexLimits(r.codex), [{ kind: 'seven_day', percentUsed: 96, resetsAt: RESET_ISO }])
})

test('liveOf takes the codex bucket of the list, else a codex single view, and no other bucket', () => {
  const premiumOnly = { ...PROBED, rateLimits: { ...PROBED.rateLimits, limitId: 'premium' }, rateLimitsByLimitId: null }
  const r = liveOf(premiumOnly, NOW, 'daemon')
  assert.ok(!('error' in r))
  assert.equal(r.codex, undefined)
  const single = liveOf({ ...PROBED, rateLimitsByLimitId: null, ordinaryUsageAllowed: null }, NOW, 'app-server')
  assert.ok(!('error' in single))
  assert.equal(single.codex?.limitId, 'codex')
  assert.equal(single.allowed, null)
  assert.equal(single.route, 'app-server')
  const reached = liveOf({ ...PROBED, ordinaryUsageAllowed: false, rateLimitsByLimitId: { codex: { ...PROBED.rateLimits, rateLimitReachedType: 'rate_limit_reached' } } }, NOW, 'daemon')
  assert.ok(!('error' in reached))
  assert.equal(reached.allowed, false)
  assert.equal(reached.reached, 'rate_limit_reached')
})

test('liveOf on an error', () => {
  assert.deepEqual(liveOf({ error: { code: -32603, message: 'codex account authentication required to read rate limits' } }, NOW, 'daemon'), {
    error: 'codex account authentication required to read rate limits',
  })
  assert.deepEqual(liveOf({ message: 'chatgpt authentication required to read rate limits' }, NOW, 'daemon'), {
    error: 'chatgpt authentication required to read rate limits',
  })
  assert.deepEqual(liveOf(null, NOW, 'daemon'), { error: 'the reply is not an object' })
  assert.deepEqual(liveOf({}, NOW, 'daemon'), { error: 'the reply has no rate limits' })
})

test('offQuota (A7): gpt-reserve passes while ordinary usage is not allowed, or with no fresh live read', () => {
  const live = (allowed: boolean | null, age = 0): LiveRead => ({ at: NOW - age, route: 'daemon', allowed })
  assert.equal(offQuota('gpt-reserve', live(false), NOW), true)
  assert.equal(offQuota('GPT-Reserve', live(false), NOW), true)
  assert.equal(offQuota('gpt-reserve', undefined, NOW), true)
  assert.equal(offQuota('gpt-reserve', live(true, LIVE_LUNA_MAX_AGE_MS), NOW), true) // stale
  assert.equal(offQuota('gpt-reserve', live(true), NOW), false) // gated
  assert.equal(offQuota('gpt-reserve', live(null), NOW), false)
  assert.equal(offQuota('gpt-reserve', live(true, LIVE_LUNA_MAX_AGE_MS - 1), NOW), false)
  assert.equal(offQuota('gpt-5.6', live(false), NOW), false)
  assert.equal(offQuota('gpt-reserve-2', undefined, NOW), false)
  assert.equal(offQuota(undefined, undefined, NOW), false)
})

test('hardStopOf (P1): a fresh live read with allowed false and no usable credits', () => {
  const live = (over: Partial<LiveRead>): LiveRead => ({ at: NOW, route: 'daemon', allowed: true, reached: null, spendControl: false, credits: null, ...over })
  assert.deepEqual(hardStopOf({ live: live({ allowed: false }), now: NOW }), { stop: true })
  assert.deepEqual(hardStopOf({ live: live({ allowed: false, credits: { hasCredits: true, balance: '12' } }), now: NOW }), { stop: false, credits: '12' })
  assert.deepEqual(hardStopOf({ live: live({ allowed: false, reached: 'workspace_owner_credits_depleted' }), now: NOW }), {
    stop: true,
    workspace: 'workspace_owner_credits_depleted',
  })
  // A workspace type or spend control counts only with allowed false.
  assert.deepEqual(hardStopOf({ live: live({ reached: 'workspace_member_usage_limit_reached', spendControl: true }), now: NOW }), { stop: false })
  assert.deepEqual(hardStopOf({ live: live({ allowed: false, spendControl: true }), now: NOW }), { stop: true, workspace: 'spend control' })
  assert.deepEqual(hardStopOf({ live: live({ allowed: null }), now: NOW }), { stop: false })
})

test('hardStopOf (P1): the rollout arm, bounded by its reset and its age', () => {
  const at100: CodexSnapshot = { limit_id: 'codex', primary: { used_percent: 100, window_minutes: 10080, resets_at: Math.floor((NOW + DAY) / 1000) }, credits: null }
  assert.deepEqual(hardStopOf({ newestRollout: { snapshot: at100, at: NOW - MIN }, now: NOW }), { stop: true })
  assert.deepEqual(hardStopOf({ newestRollout: { snapshot: { ...at100, credits: { has_credits: true, balance: '3' } }, at: NOW }, now: NOW }), { stop: false, credits: '3' })
  // The reset has passed, or the line is older than one window: no stop.
  const passed: CodexSnapshot = { ...at100, primary: { used_percent: 100, window_minutes: 10080, resets_at: Math.floor((NOW - MIN) / 1000) } }
  assert.deepEqual(hardStopOf({ newestRollout: { snapshot: passed, at: NOW - HOUR }, now: NOW }), { stop: false })
  assert.deepEqual(hardStopOf({ newestRollout: { snapshot: at100, at: NOW - 8 * DAY }, now: NOW }), { stop: false })
  assert.deepEqual(hardStopOf({ newestRollout: { snapshot: { ...at100, primary: { used_percent: 99, window_minutes: 10080 } }, at: NOW }, now: NOW }), { stop: false })
  // A stale live read leaves the decision to the rollout arm.
  const stale: LiveRead = { at: NOW - HARD_STOP_MAX_AGE_MS, route: 'daemon', allowed: true }
  assert.deepEqual(hardStopOf({ live: stale, newestRollout: { snapshot: at100, at: NOW }, now: NOW }), { stop: true })
  assert.deepEqual(hardStopOf({ now: NOW }), { stop: false })
})

// ---- Host and attendance ----

test('hostKindOf on the probed command lines', () => {
  const cases: Array<[string, HostKind]> = [
    ['/Users/me/.local/bin/codex --no-daemon --dangerously-bypass-hook-trust', 'tui'],
    ['/Users/me/.local/bin/codex app-server --listen unix://', 'daemon'],
    ['/Users/me/.local/bin/codex exec --skip-git-repo-check --dangerously-bypass-hook-trust --json TOOL please', 'exec'],
    ['/Users/me/.codex/packages/app-server-daemon/releases/0.157.0-x/bin/codex app-server --listen unix:// --managed-daemon', 'daemon'],
    ['codex app-server --listen unix://s.sock', 'daemon'],
    ['codex app-server --listen=ws://127.0.0.1:4500', 'daemon'],
    ['/Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled', 'app-server'],
    ['codex app-server --listen stdio://', 'app-server'],
    ['codex app-server --stdio', 'app-server'],
    ['codex e "hello"', 'exec'],
    ['codex exec resume 01a0da06', 'exec'],
    ['codex review --uncommitted', 'exec'],
    ['codex -m gpt-5.6 -c model_reasoning_effort=high exec hi', 'exec'],
    ['codex -m exec', 'tui'], // exec is the model name, not the subcommand
    ['codex', 'tui'],
    ['codex resume --last', 'tui'],
    ['codex fix the review comments', 'tui'],
    ['/Users/me/Library/Application Support/Codex/bin/codex app-server', 'app-server'],
    ['node /usr/local/lib/node_modules/@openai/codex/bin/codex.js exec hi', 'exec'],
    ['', 'unknown'],
    ['   ', 'unknown'],
  ]
  for (const [line, kind] of cases) assert.equal(hostKindOf(line), kind, line)
})

test('attendedFrom: the rows of 3.10', () => {
  const meta = (line: string) => sessionMetaOf(line)
  const of = (i: Parameters<typeof attendedFrom>[0]) => attendedFrom(i)
  // The embedded TUI (source cli), and the TUI on the daemon (vscode plus codex-tui).
  assert.deepEqual(of({ meta: meta(META_TUI), transcriptNull: false, mode: 'default', hostKind: 'tui' }), { attended: true })
  assert.deepEqual(of({ meta: meta(META_DAEMON_TUI), transcriptNull: false, mode: 'default', hostKind: 'daemon' }), { attended: true })
  // codex exec, and codex exec resume of a TUI thread.
  assert.deepEqual(of({ meta: meta(META_EXEC), transcriptNull: false, mode: 'default', hostKind: 'exec' }), { attended: false })
  assert.deepEqual(of({ meta: meta(META_TUI), transcriptNull: false, mode: 'default', hostKind: 'exec' }), { attended: false })
  // The desktop app, the IDE and an SDK on their own app-server.
  for (const originator of ['Codex Desktop', 'codex_vscode', 'codex_sdk_ts', 'some-other-app']) {
    assert.deepEqual(of({ meta: { type: 'session_meta', originator, source: 'vscode' }, transcriptNull: false, hostKind: 'app-server' }), { attended: false }, originator)
  }
  // A known unattended app on the daemon stays unattended.
  for (const originator of UNATTENDED_ORIGINATORS) {
    assert.deepEqual(of({ meta: { type: 'session_meta', originator, source: 'vscode' }, transcriptNull: false, hostKind: 'daemon' }), { attended: false }, originator)
  }
  // An unknown originator on the daemon: attended, and it warns (CX43).
  assert.deepEqual(of({ meta: meta(META_REMOTE), transcriptNull: false, mode: 'default', hostKind: 'daemon' }), { attended: true, warnOriginator: 'gap7-remote-client' })
  assert.deepEqual(of({ meta: { type: 'session_meta', source: 'vscode' }, transcriptNull: false, hostKind: 'daemon' }), { attended: true, warnOriginator: 'an unknown app' })
  // A subagent inherits the root's originator.
  assert.deepEqual(of({ meta: meta(META_SUBAGENT), transcriptNull: false, mode: 'default', hostKind: 'tui' }), { attended: true })
  assert.deepEqual(of({ meta: meta(META_SUBAGENT), transcriptNull: false, mode: 'default', hostKind: 'daemon' }), { attended: true })
  // An ephemeral thread (no rollout): on the TUI and on the daemon, unless approval is never.
  assert.deepEqual(of({ transcriptNull: true, mode: 'default', hostKind: 'tui' }), { attended: true })
  assert.deepEqual(of({ transcriptNull: true, mode: 'default', hostKind: 'daemon' }), { attended: true })
  assert.deepEqual(of({ transcriptNull: true, mode: 'bypassPermissions', hostKind: 'tui' }), { attended: false })
  assert.deepEqual(of({ transcriptNull: true, mode: 'bypassPermissions', hostKind: 'daemon' }), { attended: false })
  assert.deepEqual(of({ transcriptNull: true, mode: 'default', hostKind: 'app-server' }), { attended: false })
  assert.deepEqual(of({ transcriptNull: true, mode: 'default', hostKind: 'exec' }), { attended: false })
  // No session_meta: the TUI only.
  assert.deepEqual(of({ transcriptNull: false, hostKind: 'tui' }), { attended: true })
  assert.deepEqual(of({ transcriptNull: false, hostKind: 'daemon' }), { attended: false })
  assert.deepEqual(of({ meta: { type: 'event_msg' }, transcriptNull: false, hostKind: 'tui' }), { attended: true })
  // A source of exec wins over the TUI originator.
  assert.deepEqual(of({ meta: { type: 'session_meta', originator: 'codex-tui', source: 'exec' }, transcriptNull: false, hostKind: 'tui' }), { attended: false })
  // With no ps (unknown host), the TUI originator still counts.
  assert.deepEqual(of({ meta: meta(META_TUI), transcriptNull: false, hostKind: 'unknown' }), { attended: true })
})

// ---- Options ----

test('parseAutoResumeOption takes a boolean, on or off', () => {
  assert.equal(parseAutoResumeOption(true), true)
  assert.equal(parseAutoResumeOption(false), false)
  assert.equal(parseAutoResumeOption('on'), true)
  assert.equal(parseAutoResumeOption('off'), false)
  assert.equal(parseAutoResumeOption(' OFF '), false)
  assert.equal(parseAutoResumeOption(1), undefined)
  assert.equal(parseAutoResumeOption('yes'), undefined)
  assert.equal(parseAutoResumeOption(null), undefined)
})

test('OPTIONS names the ten options of 5.1 with their variables and ranges', () => {
  assert.deepEqual(
    OPTIONS.map((o) => [o.name, o.env, o.range]),
    [
      ['reserve', 'SPARE10_RESERVE', '1 to 99'],
      ['weeklyReserve', 'SPARE10_WEEKLY_RESERVE', '0, or 1 to 99'],
      ['lastMinutes', 'SPARE10_LAST_MINUTES', '0 to 299'],
      ['weeklyLastHours', 'SPARE10_WEEKLY_LAST_HOURS', '0 to 167'],
      ['resumeFloor', 'SPARE10_RESUME_FLOOR', '0 to 99'],
      ['weeklyResumeFloor', 'SPARE10_WEEKLY_RESUME_FLOOR', '0 to 99'],
      ['pausePrompt', 'SPARE10_PAUSE_PROMPT', 'any text'],
      ['autoResume', 'SPARE10_AUTO_RESUME', 'on or off'],
      ['headless', 'SPARE10_HEADLESS', 'off, prompt, stop or wait'],
      ['scope', 'SPARE10', 'all or opt-in'],
    ],
  )
  assert.equal(optionOf('WEEKLYRESERVE')?.name, 'weeklyReserve')
  assert.equal(optionOf('badge'), undefined)
})

const PATH = '/h/.codex/plugins/data/spare10-spare10/config.json'

test('configOptions: good values pass to fromOptions', () => {
  const raw = { reserve: 15, weeklyReserve: 5, lastMinutes: 30, weeklyLastHours: 0, resumeFloor: 3, weeklyResumeFloor: 2.5, pausePrompt: 'Commit, then stop.', autoResume: false, headless: 'wait', scope: 'opt-in' }
  const { options, warnings } = configOptions(PATH, raw)
  assert.deepEqual(warnings, [])
  assert.deepEqual(options, raw)
  assert.deepEqual(fromOptions(options), {
    reserve: 15,
    weeklyReserve: 5,
    lastMinutes: 30,
    weeklyLastHours: 0,
    resumeFloor: 3,
    weeklyResumeFloor: 2.5,
    pausePrompt: 'Commit, then stop.',
    autoResume: false,
    headless: 'wait',
    scope: 'opt-in',
    badge: true,
  })
})

test('configOptions: autoResume false or off gives off, a blank pause prompt is none', () => {
  assert.equal(fromOptions(configOptions(PATH, { autoResume: false }).options).autoResume, false)
  assert.equal(fromOptions(configOptions(PATH, { autoResume: 'off' }).options).autoResume, false)
  assert.equal(fromOptions(configOptions(PATH, { autoResume: 'on' }).options).autoResume, true)
  assert.equal(fromOptions(configOptions(PATH, {}).options).autoResume, true)
  assert.deepEqual(configOptions(PATH, { pausePrompt: '  ' }).options, { pausePrompt: '' })
  assert.equal(fromOptions(configOptions(PATH, { pausePrompt: '  ' }).options).pausePrompt, null)
})

test('configOptions: each bad value warns with CX11 and is left out', () => {
  const bad: Array<[OptionName, unknown, string]> = [
    ['reserve', 0, `${PATH} sets reserve to 0, which is not 1 to 99. spare10 uses 10.`],
    ['weeklyReserve', 0.5, `${PATH} sets weeklyReserve to 0.5, which is not 0, or 1 to 99. spare10 uses 10.`],
    ['lastMinutes', 300, `${PATH} sets lastMinutes to 300, which is not 0 to 299. spare10 uses 20.`],
    ['weeklyLastHours', 'soon', `${PATH} sets weeklyLastHours to "soon", which is not 0 to 167. spare10 uses 8.`],
    ['resumeFloor', -1, `${PATH} sets resumeFloor to -1, which is not 0 to 99. spare10 uses 5.`],
    ['weeklyResumeFloor', 100, `${PATH} sets weeklyResumeFloor to 100, which is not 0 to 99. spare10 uses 5.`],
    ['pausePrompt', 5, `${PATH} sets pausePrompt to 5, which is not any text. spare10 uses an empty text.`],
    ['autoResume', 1, `${PATH} sets autoResume to 1, which is not on or off. spare10 uses on.`],
    ['headless', 'sometimes', `${PATH} sets headless to "sometimes", which is not off, prompt, stop or wait. spare10 uses off.`],
    ['scope', ['all'], `${PATH} sets scope to ["all"], which is not all or opt-in. spare10 uses all.`],
  ]
  for (const [name, value, text] of bad) {
    const r = configOptions(PATH, { [name]: value, reserve: name === 'reserve' ? value : 12 })
    assert.deepEqual(r.warnings, [text], name)
    assert.equal(name in r.options, false, name)
    assert.deepEqual(fromOptions(r.options)[name], name === 'reserve' ? DEFAULTS.reserve : DEFAULTS[name])
  }
})

test('configOptions: unknown keys are ignored, a value that is not an object gives CX12', () => {
  assert.deepEqual(configOptions(PATH, { badge: false, color: 'red', reserve: 20 }), { options: { reserve: 20 }, warnings: [] })
  for (const raw of [null, [], 'x', 5, true]) {
    assert.deepEqual(configOptions(PATH, raw), {
      options: {},
      warnings: [`cannot read ${PATH} (it is not a JSON object). spare10 uses the default options, and keeps each reserve until the reset.`],
    })
  }
})

test('parseSetValue: each option and its range, the stored JSON type', () => {
  const ok = (name: OptionName, raw: string, value: string | number | boolean) => assert.deepEqual(parseSetValue(name, raw), { ok: true, value }, `${name} ${raw}`)
  const no = (name: OptionName, raw: string) => assert.deepEqual(parseSetValue(name, raw), { ok: false }, `${name} ${raw}`)
  ok('reserve', '15', 15)
  ok('reserve', '12.55', 12.6)
  no('reserve', '0')
  no('reserve', 'ten')
  ok('weeklyReserve', '0', 0)
  no('weeklyReserve', '0.5')
  ok('lastMinutes', '0', 0)
  no('lastMinutes', '300')
  ok('weeklyLastHours', '167', 167)
  no('weeklyLastHours', '168')
  ok('resumeFloor', '0', 0)
  no('resumeFloor', '100')
  ok('weeklyResumeFloor', '2.5', 2.5)
  ok('pausePrompt', 'Finish this, then stop.', 'Finish this, then stop.')
  no('pausePrompt', '   ')
  ok('autoResume', 'off', false)
  ok('autoResume', 'ON', true)
  no('autoResume', 'false')
  ok('headless', 'Wait', 'wait')
  no('headless', 'never')
  ok('scope', 'opt-in', 'opt-in')
  no('scope', 'some')
  no('reserve', '')
})

test('optionText shows a value as the texts do', () => {
  assert.equal(optionText('reserve', 15), '15')
  assert.equal(optionText('weeklyResumeFloor', 2.5), '2.5')
  assert.equal(optionText('autoResume', false), 'off')
  assert.equal(optionText('autoResume', true), 'on')
  assert.equal(optionText('pausePrompt', null), 'an empty text')
  assert.equal(optionText('pausePrompt', 'Commit, then stop.'), '"Commit, then stop."')
  assert.equal(optionText('headless', 'wait'), 'wait')
})

// ---- Commands (2.8) ----

test('parseCommand: every form of 2.8', () => {
  assert.deepEqual(parseCommand('spare10'), { verb: 'status', words: [], rest: '' })
  assert.deepEqual(parseCommand('spare10 status'), { verb: 'status', words: [], rest: '' })
  assert.deepEqual(parseCommand('spare10 help'), { verb: 'help', words: [], rest: '' })
  assert.deepEqual(parseCommand('spare10 resume'), { verb: 'resume', words: [], rest: '' })
  assert.deepEqual(parseCommand('spare10 stop'), { verb: 'stop', words: [], rest: '' })
  assert.deepEqual(parseCommand('spare10 simulate 92'), { verb: 'simulate', words: ['92'], rest: '92' })
  assert.deepEqual(parseCommand('spare10 simulate 92 weekly'), { verb: 'simulate', words: ['92', 'weekly'], rest: '92 weekly' })
  assert.deepEqual(parseCommand('spare10 simulate 92 in 20s'), { verb: 'simulate', words: ['92', 'in', '20s'], rest: '92 in 20s' })
  assert.deepEqual(parseCommand('spare10 simulate off'), { verb: 'simulate', words: ['off'], rest: 'off' })
  assert.deepEqual(parseCommand('spare10 set'), { verb: 'set', words: [], rest: '' })
  assert.deepEqual(parseCommand('spare10 set reserve 15'), { verb: 'set', words: ['reserve', '15'], rest: '15' })
  assert.deepEqual(parseCommand('spare10 set reserve default'), { verb: 'set', words: ['reserve', 'default'], rest: 'default' })
  assert.deepEqual(parseCommand('spare10 set foo'), { verb: 'unknownOption', word: 'foo' })
  assert.deepEqual(parseCommand('spare10 pause'), { verb: 'unknown', word: 'pause' })
})

test('parseCommand: any case, extra spaces, and the option name in any case', () => {
  assert.deepEqual(parseCommand('  SPARE10  '), { verb: 'status', words: [], rest: '' })
  assert.deepEqual(parseCommand('Spare10 Resume'), { verb: 'resume', words: [], rest: '' })
  assert.deepEqual(parseCommand('spare10   STOP'), { verb: 'stop', words: [], rest: '' })
  assert.deepEqual(parseCommand('spare10 set WeeklyReserve   5'), { verb: 'set', words: ['weeklyReserve', '5'], rest: '5' })
  assert.deepEqual(parseCommand('spare10 Pause'), { verb: 'unknown', word: 'Pause' })
})

test('parseCommand: the pause prompt keeps its text verbatim', () => {
  assert.deepEqual(parseCommand('spare10 set pausePrompt Finish this, then stop.'), {
    verb: 'set',
    words: ['pausePrompt', 'Finish', 'this,', 'then', 'stop.'],
    rest: 'Finish this, then stop.',
  })
  assert.deepEqual(parseCommand('spare10 set pausePrompt  Keep  two  spaces.'), {
    verb: 'set',
    words: ['pausePrompt', 'Keep', 'two', 'spaces.'],
    rest: 'Keep  two  spaces.',
  })
})

test('parseCommand: an option with no value is a set, so its reply names the range', () => {
  assert.deepEqual(parseCommand('spare10 set reserve'), { verb: 'set', words: ['reserve'], rest: '' })
})

test('parseCommand: ordinary prompts', () => {
  for (const p of [
    '',
    'hello',
    'spare10x',
    'spare10x status',
    'Spare10 keeps holding my build, why?',
    'spare10 is slow today',
    'spare10 status please',
    'spare10 resume now',
    'spare10 set up is broken',
    'spare10 simulate the reset later please thanks',
    'spare10\nstatus',
    'spare10 status\nthen go on',
    'spare10 stop\r\n and more',
    'please run spare10 stop',
    '!spare10 status',
  ]) {
    assert.equal(parseCommand(p), undefined, JSON.stringify(p))
  }
})

test('parseCommand: a bad simulate of at most 6 words is a command, so it gets the bad reply', () => {
  assert.deepEqual(parseCommand('spare10 simulate'), { verb: 'simulate', words: [], rest: '' })
  assert.deepEqual(parseCommand('spare10 simulate lots'), { verb: 'simulate', words: ['lots'], rest: 'lots' })
  assert.deepEqual(parseCommand('spare10 simulate 92 in the week'), { verb: 'simulate', words: ['92', 'in', 'the', 'week'], rest: '92 in the week' })
  assert.equal(parseCommand('spare10 simulate 92 in the next week'), undefined)
})

test('rootOnly: resume, stop, simulate and a set that changes an option', () => {
  const root = (p: string): boolean => {
    const c = parseCommand(p)
    assert.ok(c !== undefined, p)
    return rootOnly(c)
  }
  assert.equal(root('spare10 resume'), true)
  assert.equal(root('spare10 stop'), true)
  assert.equal(root('spare10 simulate 92'), true)
  assert.equal(root('spare10 set reserve 15'), true)
  assert.equal(root('spare10 set reserve'), true)
  assert.equal(root('spare10'), false)
  assert.equal(root('spare10 status'), false)
  assert.equal(root('spare10 help'), false)
  assert.equal(root('spare10 set'), false)
  assert.equal(root('spare10 set foo'), false)
  assert.equal(root('spare10 pause'), false)
})

// ---- The question (2.2) ----

const SCHEMA = {
  type: 'object',
  required: ['choice'],
  properties: {
    choice: {
      type: 'string',
      title: 'spare10',
      oneOf: [
        { const: 'stop', title: 'Stop here' },
        { const: 'resume', title: 'Resume' },
      ],
      default: 'stop',
    },
  },
}

test('elicitParams equals the JSON of 2.2, with and without CX46', () => {
  const msg = 'Your 10% weekly reserve is reached: 91% used · 9% left · resets Tue 15:52. All work is on hold.'
  assert.deepEqual(JSON.parse(JSON.stringify(elicitParams(msg))), { message: msg, requestedSchema: SCHEMA })
  assert.deepEqual(JSON.parse(JSON.stringify(elicitParams(msg, '497'))), {
    message: `${msg} Past 100% used, Codex spends your credits. The balance is 497.`,
    requestedSchema: SCHEMA,
  })
})

test('answerOf maps each row of 2.2', () => {
  assert.equal(answerOf({ action: 'accept', content: { choice: 'resume' } }, false), 'resume')
  assert.equal(answerOf({ action: 'accept', content: { choice: 'stop' } }, false), 'stop')
  assert.equal(answerOf({ action: 'accept', content: { choice: 'maybe' } }, false), 'stop')
  assert.equal(answerOf({ action: 'accept', content: { choice: 'Resume' } }, false), 'stop')
  assert.equal(answerOf({ action: 'accept' }, false), 'stop')
  assert.equal(answerOf({ action: 'cancel' }, false), 'cancel')
  assert.equal(answerOf({ action: 'decline' }, false), 'decline')
  assert.equal(answerOf({ action: 'accept', content: { choice: 'resume' } }, true), 'decline') // a JSON-RPC error
  assert.equal(answerOf(undefined, true), 'decline') // no elicitation capability
  assert.equal(answerOf({ action: 'later' }, false), 'decline')
  assert.equal(answerOf('accept', false), 'decline')
})

// ---- The gate answer (3.3, 4.4) ----

const SITES: GateSite[] = ['start', 'prompt', 'tool', 'step', 'compact', 'spawn', 'stop', 'interrupt']
const parsed = (s: string): unknown => (s === '' ? '' : JSON.parse(s))

test('render: pass, and pass with context, at every site', () => {
  for (const site of SITES) assert.equal(render(site, { kind: 'pass' }), '', site)
  assert.deepEqual(parsed(render('prompt', { kind: 'pass', context: 'C' })), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'C' } })
  assert.deepEqual(parsed(render('tool', { kind: 'pass', context: 'C' })), { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'C' } })
  assert.deepEqual(parsed(render('step', { kind: 'pass', context: 'C' })), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'C' } })
  // A site that takes no context passes without it.
  for (const site of ['start', 'compact', 'spawn', 'stop', 'interrupt'] as const) assert.equal(render(site, { kind: 'pass', context: 'C' }), '', site)
  assert.equal(render('tool', { kind: 'pass', context: '' }), '')
})

test('render: the refusal cells of 3.3', () => {
  assert.deepEqual(parsed(render('prompt', { kind: 'block', text: 'T' })), { decision: 'block', reason: 'T' })
  assert.deepEqual(parsed(render('tool', { kind: 'deny', text: 'T' })), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'T' },
  })
  assert.deepEqual(parsed(render('step', { kind: 'deny', text: 'T' })), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'T' } })
  assert.deepEqual(parsed(render('stop', { kind: 'end', text: codexText.turnEnds })), { continue: false, stopReason: codexText.turnEnds })
  assert.deepEqual(parsed(render('stop', { kind: 'end', text: codexText.turnEndsHold })), { continue: false, stopReason: codexText.turnEndsHold })
  assert.deepEqual(parsed(render('stop', { kind: 'end' })), { continue: false })
  assert.deepEqual(parsed(render('compact', { kind: 'end', text: codexText.turnEnds })), { continue: false, stopReason: codexText.turnEnds })
})

test('render is total: a refusal where 3.3 says never takes the closest refusal of the site, and a site that cannot refuse passes', () => {
  const results: GateResult[] = [
    { kind: 'deny', text: 'T' },
    { kind: 'block', text: 'T' },
    { kind: 'end', text: 'T' },
    { kind: 'end' },
  ]
  for (const r of results) {
    const t = r.kind === 'end' && r.text === undefined ? undefined : 'T'
    assert.deepEqual(parsed(render('prompt', r)), { decision: 'block', reason: t ?? 'spare10: not started. spare10 could not ask you. Send the prompt again, or run spare10 resume.' })
    assert.deepEqual(parsed(render('tool', r)), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: t ?? 'spare10: stopped at the quota reserve. Stop now and wait for the user. Do not call any further tools.',
      },
    })
    assert.deepEqual(parsed(render('step', r)), {
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: t ?? 'spare10: stopped at the quota reserve. Stop now and wait for the user. Do not call any further tools.' },
    })
    for (const site of ['stop', 'compact'] as const) assert.deepEqual(parsed(render(site, r)), t === undefined ? { continue: false } : { continue: false, stopReason: 'T' })
    for (const site of ['start', 'spawn', 'interrupt'] as const) assert.equal(render(site, r), '', `${site} ${r.kind}`)
  }
})

test('render: a systemMessage rides every answer', () => {
  const m = 'spare10: stopped at your 10% reserve.'
  for (const site of SITES) assert.deepEqual(parsed(render(site, { kind: 'pass' }, m)), { systemMessage: m }, site)
  assert.deepEqual(parsed(render('prompt', { kind: 'pass', context: codexText.steerNote }, m)), {
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: codexText.steerNote },
    systemMessage: m,
  })
  assert.deepEqual(parsed(render('prompt', { kind: 'block', text: 'T' }, m)), { decision: 'block', reason: 'T', systemMessage: m })
  assert.deepEqual(parsed(render('tool', { kind: 'deny', text: 'T' }, m)), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'T' },
    systemMessage: m,
  })
  assert.deepEqual(parsed(render('stop', { kind: 'end', text: 'T' }, m)), { continue: false, stopReason: 'T', systemMessage: m })
  assert.equal(render('interrupt', { kind: 'pass' }, ''), '')
})

test('refuseModeOf follows the order of 4.4', () => {
  const base = { attended: true, noDialog: false, hosted: false, autoStop: false, autoResume: true, deniedThisTurn: false }
  assert.equal(refuseModeOf({ ...base, noDialog: true, hosted: true }), 'hold')
  assert.equal(refuseModeOf({ ...base, hosted: true }), 'interrupt')
  assert.equal(refuseModeOf({ ...base, hosted: true, deniedThisTurn: true }), 'interrupt')
  assert.equal(refuseModeOf({ ...base, autoStop: true }), 'hold')
  assert.equal(refuseModeOf({ ...base, autoStop: true, autoResume: false }), 'deny')
  assert.equal(refuseModeOf({ ...base, autoStop: true, autoResume: false, deniedThisTurn: true }), 'hold')
  assert.equal(refuseModeOf(base), 'deny')
  assert.equal(refuseModeOf({ ...base, deniedThisTurn: true }), 'hold')
  // Unattended: one deny per thread and turn, then hold, also when hosted or on an auto stop.
  const un = { ...base, attended: false }
  assert.equal(refuseModeOf({ ...un, hosted: true }), 'deny')
  assert.equal(refuseModeOf({ ...un, hosted: true, autoStop: true }), 'deny')
  assert.equal(refuseModeOf({ ...un, deniedThisTurn: true }), 'hold')
})

test('withPrefix prefixes each line that has text', () => {
  assert.equal(withPrefix('one'), 'spare10: one')
  assert.equal(withPrefix('one\ntwo'), 'spare10: one\nspare10: two')
  assert.equal(withPrefix('version 0.3.0\n\n  ● armed'), 'spare10: version 0.3.0\n\nspare10:   ● armed')
  assert.equal(withPrefix(''), '')
})
