import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as core from '../../hooks/core/codex.ts'
import * as decide from '../../hooks/core/decide.ts'
import * as timing from '../src/timing.ts'

// codex/src/timing.ts holds the constants of Codex design 5.3. The values that the pure rules need come from
// hooks/core, so each value has one source.

test('timing: the values of design 5.3', () => {
  assert.deepEqual(
    {
      TICK_MS: timing.TICK_MS,
      CHECK_MS: timing.CHECK_MS,
      FIRST_READ_WAIT_MS: timing.FIRST_READ_WAIT_MS,
      LIVE_RELEASE_MAX_AGE_MS: timing.LIVE_RELEASE_MAX_AGE_MS,
      LIVE_POLL_MS: timing.LIVE_POLL_MS,
      LIVE_NEAR_MAX_AGE_MS: timing.LIVE_NEAR_MAX_AGE_MS,
      NEAR_TRIP_POINTS: timing.NEAR_TRIP_POINTS,
      LIVE_LUNA_MAX_AGE_MS: timing.LIVE_LUNA_MAX_AGE_MS,
      RESET_JITTER_MS: timing.RESET_JITTER_MS,
      BEAT_STALE_MS: timing.BEAT_STALE_MS,
      CANCEL_CHECK_MS: timing.CANCEL_CHECK_MS,
      HANDOFF_LIMIT: timing.HANDOFF_LIMIT,
      HOLD_LIMIT_MS: timing.HOLD_LIMIT_MS,
      NOTICE_TTL_MS: timing.NOTICE_TTL_MS,
      CONTINUATION_TTL_MS: timing.CONTINUATION_TTL_MS,
      LOCK_STALE_MS: timing.LOCK_STALE_MS,
      LOCK_WAIT_MS: timing.LOCK_WAIT_MS,
      DAEMON_CONNECT_MS: timing.DAEMON_CONNECT_MS,
      A_READ_MS: timing.A_READ_MS,
      A_NEAR_MS: timing.A_NEAR_MS,
      INTERRUPT_MS: timing.INTERRUPT_MS,
      START_MS: timing.START_MS,
      DAEMON_MAX_MESSAGE: timing.DAEMON_MAX_MESSAGE,
      ROLLOUT_CHUNK_BYTES: timing.ROLLOUT_CHUNK_BYTES,
      ROLLOUT_SCAN_MAX: timing.ROLLOUT_SCAN_MAX,
      MIN_NODE_MAJOR: timing.MIN_NODE_MAJOR,
    },
    {
      TICK_MS: 30_000,
      CHECK_MS: 60_000,
      FIRST_READ_WAIT_MS: 2_000,
      LIVE_RELEASE_MAX_AGE_MS: 30_000,
      LIVE_POLL_MS: 60_000,
      LIVE_NEAR_MAX_AGE_MS: 15_000,
      NEAR_TRIP_POINTS: 5,
      LIVE_LUNA_MAX_AGE_MS: 60_000,
      RESET_JITTER_MS: 600_000,
      BEAT_STALE_MS: 90_000,
      CANCEL_CHECK_MS: 500,
      HANDOFF_LIMIT: 5,
      HOLD_LIMIT_MS: 691_200_000 - 300_000,
      NOTICE_TTL_MS: 1_800_000,
      CONTINUATION_TTL_MS: 120_000,
      LOCK_STALE_MS: 5_000,
      LOCK_WAIT_MS: 2_000,
      DAEMON_CONNECT_MS: 1_000,
      A_READ_MS: 5_000,
      A_NEAR_MS: 2_000,
      INTERRUPT_MS: 8_000,
      START_MS: 5_000,
      DAEMON_MAX_MESSAGE: 67_108_864,
      ROLLOUT_CHUNK_BYTES: 262_144,
      ROLLOUT_SCAN_MAX: 8_388_608,
      MIN_NODE_MAJOR: 20,
    },
  )
})

test('timing: the values of 3.6 and 3.7 that 5.3 does not list', () => {
  assert.equal(timing.LIVE_LOCK_STALE_MS, 20_000)
  assert.equal(timing.LIVE_LOCK_POLL_MS, 100)
  assert.equal(timing.WAKE_POLL_MS, 1_000)
  assert.equal(timing.LOCK_SLEEP_MIN_MS, 2)
  assert.equal(timing.LOCK_SLEEP_MAX_MS, 10)
  assert.equal(timing.CODEX_CALL_TIMEOUT_MS, 691_200 * 1000)
  assert.ok(timing.FIRST_LINE_MAX_BYTES >= 64 * 1024)
})

test('timing: the core values come from hooks/core, not from a copy', () => {
  assert.equal(timing.TICK_MS, decide.TICK_MS)
  assert.equal(timing.CHECK_MS, decide.CHECK_MS)
  assert.equal(timing.NEAR_TRIP_POINTS, core.NEAR_TRIP_POINTS)
  assert.equal(timing.LIVE_LUNA_MAX_AGE_MS, core.LIVE_LUNA_MAX_AGE_MS)
  assert.equal(timing.RESET_JITTER_MS, core.RESET_JITTER_MS)
  assert.equal(timing.HARD_STOP_MAX_AGE_MS, core.HARD_STOP_MAX_AGE_MS)
})

test('timing: a hold ends before Codex drops the call, and fits one Node timer', () => {
  assert.ok(timing.HOLD_LIMIT_MS < timing.CODEX_CALL_TIMEOUT_MS)
  assert.ok(timing.HOLD_LIMIT_MS < 2_147_483_647)
})
