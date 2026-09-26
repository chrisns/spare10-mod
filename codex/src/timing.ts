// The constants of the Codex broker (Codex design 5.3). The values that the pure rules need live in
// hooks/core, and this file takes them from there, so each value has one source.

export { CHECK_MS, TICK_MS } from '../../hooks/core/decide.ts'
export { HARD_STOP_MAX_AGE_MS, LIVE_LUNA_MAX_AGE_MS, NEAR_TRIP_POINTS, RESET_JITTER_MS } from '../../hooks/core/codex.ts'

/** The first gate of a thread waits this long for the start-up read (3.6). */
export const FIRST_READ_WAIT_MS = 2_000

/** A release reads the quota again unless the last read is younger (3.6). */
export const LIVE_RELEASE_MAX_AGE_MS = 30_000

/** The most a question check waits for a fresh live read (3.6). */
export const LIVE_POLL_MS = 60_000

/** A near-trip gate reads the quota again unless the last read is younger (A19). */
export const LIVE_NEAR_MAX_AGE_MS = 15_000

/** `live.lock` is free when it is older than this, or when its pid is dead (3.6). */
export const LIVE_LOCK_STALE_MS = 20_000

/** A quota that finds `live.lock` busy reads `live.json` again this often, on real time (3.6). */
export const LIVE_LOCK_POLL_MS = 100

/** A held entry with an older beat is lost, and a leaderless question younger than this is live (4.3). */
export const BEAT_STALE_MS = 90_000

/** The leader's rollout check after `cancel` (2.2). */
export const CANCEL_CHECK_MS = 500

/** How often a question moves to a new leader, as register.tsx. */
export const HANDOFF_LIMIT = 5

/** Codex drops an MCP call and a hook after this long: `tool_timeout_sec` and hook `timeout` are 691200 s. */
export const CODEX_CALL_TIMEOUT_MS = 691_200_000

/** A held call answers this long before Codex drops it. */
export const HOLD_LIMIT_MS = CODEX_CALL_TIMEOUT_MS - 300_000

/** A queued transcript line expires (2.4). */
export const NOTICE_TTL_MS = 1_800_000

/** The resume prompt record expires (4.7). */
export const CONTINUATION_TTL_MS = 120_000

/** A lock file older than this is free (3.7). */
export const LOCK_STALE_MS = 5_000

/** The longest wait for a lock, on real time (3.7). */
export const LOCK_WAIT_MS = 2_000

/** A lock waiter sleeps a random time in this range between two tries, on real time (3.7). */
export const LOCK_SLEEP_MIN_MS = 2
export const LOCK_SLEEP_MAX_MS = 10

/** A session folder whose files did not change for this long can go: 30 days, past the end of any window (3.7). */
export const PRUNE_AFTER_MS = 30 * 24 * 3_600_000

/** The prune of old session folders runs at most this often for each data dir. */
export const PRUNE_EVERY_MS = 24 * 3_600_000

/** One prune removes at most this many session folders. The next prune goes on. */
export const PRUNE_MAX = 500

/** The production Wake polls the session files this often while the broker holds a call (3.7). */
export const WAKE_POLL_MS = 1_000

/** The daemon client (3.5, 3.6). */
export const DAEMON_CONNECT_MS = 1_000
export const A_READ_MS = 5_000
export const A_NEAR_MS = 2_000
export const INTERRUPT_MS = 8_000
/**
 * An interrupt mark older than this is lost: its process died, or it could not remove the mark of a failed
 * interrupt (4.4). A live owner is done sooner. The owner reads the mark time before it takes the lock.
 * Its worst path is LOCK_WAIT_MS (mark), connect, INTERRUPT_MS, connect, THREAD_READ_MS and LOCK_WAIT_MS (unmark).
 * The lifetime is longer than that sum. It is shorter than TICK_MS, so the next sweep cycle takes a lost mark.
 */
export const INTERRUPT_MARK_MS = 2 * INTERRUPT_MS + 2 * LOCK_WAIT_MS
/** A caller that finds a turn marked by another process asks `thread/turns/list` this often, for at most INTERRUPT_MS (4.4). */
export const INTERRUPT_POLL_MS = 250
export const START_MS = 5_000
/** `thread/loaded/list` (3.5). */
export const LOADED_MS = 2_000
/** `thread/read`, `thread/turns/list` and `hooks/list` (3.5). */
export const THREAD_READ_MS = 3_000

/** `hosted()` keeps a `thread/loaded/list` that names the thread this long (3.5). */
export const HOSTED_TTL_MS = 60_000
/** A `thread/loaded/list` that does not name the thread is read again after this long, so a new thread shows. */
export const HOSTED_MISS_TTL_MS = 5_000

/** The safety cap of one daemon message: 64 MiB. */
export const DAEMON_MAX_MESSAGE = 64 * 1024 * 1024

/** The backward scan of the rollout cursor (3.6): 256 KiB chunks, at most 8 MiB. */
export const ROLLOUT_CHUNK_BYTES = 262_144
export const ROLLOUT_SCAN_MAX = 8 * 1024 * 1024

/** The longest first line (`session_meta`) that the cursor reads: 1 MiB. Codex writes about 22 KB. */
export const FIRST_LINE_MAX_BYTES = 1024 * 1024

/** `broker.sh` and the broker refuse an older Node.js. */
export const MIN_NODE_MAJOR = 20
