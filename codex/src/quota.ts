import type { SessionRateLimit } from 'claude-code'
import { join } from 'node:path'
import { blindFrom, codexDebug, codexLimits, isObservation, liveOf, nearTrip, nextPresence, pickSeed, usableCredits } from '../../hooks/core/codex.ts'
import type { CodexCredits, CodexSnapshot, LiveRead, Presence } from '../../hooks/core/codex.ts'
import { BLIND_AFTER, KINDS, anchoredOf, inWindow } from '../../hooks/core/reading.ts'
import type { Anchored, Kind } from '../../hooks/core/reading.ts'
import { VERSION } from '../../hooks/core/text.ts'
import { realClock } from './clock.ts'
import type { Clock } from './clock.ts'
import type { DaemonLink } from './daemon.ts'
import type { Deps } from './deps.ts'
import { readJson, tryLock, unlock, withLock, writeJson } from './files.ts'
import type { Rollouts, TokenCount } from './rollout.ts'
import type { SessionStore } from './store.ts'
import { A_NEAR_MS, A_READ_MS, FIRST_READ_WAIT_MS, LIVE_LOCK_POLL_MS, LIVE_LOCK_STALE_MS, LIVE_NEAR_MAX_AGE_MS } from './timing.ts'

// The quota sources of a broker (Codex design 3.6). Route A: `account/rateLimits/read` on the daemon,
// shared by every broker and the CLI of one data dir through live.json and live.lock. Route C: the
// thread's own rollout (the cursor of rollout.ts) and seed.json, the newest reading per kind. The view
// holds what the sense needs: per kind the newest own reading and the seed picked by time, the present
// kinds (two observations in a row, 3.6), blindness (two good live reads with no window), the credits and
// whether a watched kind is near its trip point. The core decides: this file only reads and writes files.

/** The part of the daemon link that the quota uses. */
export type QuotaDaemon = Pick<DaemonLink, 'get'>

/** P1: route B, a short `codex app-server` read. P0 passes none. */
export type ReadB = (timeoutMs: number) => Promise<unknown>

/**
 * live.json: the last good live read, and the codex snapshots of the last good reads for the blind rule
 * (oldest first). A good read with no codex bucket is null there: it is no window-less codex read (3.6).
 */
export type LiveFile = LiveRead & { v: 1; by: string; recent: Array<CodexSnapshot | null> }

/** live-error.json: the last failed live read. */
export type LiveErrorFile = { v: 1; by: string; at: number; route: LiveRead['route']; error: string }

/** One kind of seed.json: the reading with its window and the time of its observation. */
export type SeedEntry = Anchored & { at: number }

/** seed.json: the newest reading per kind, and the newest credits, of every broker of the data dir. */
export type SeedFile = { v: 1; by: string; five_hour?: SeedEntry; seven_day?: SeedEntry; credits?: { at: number; value: CodexCredits } }

/** The newest own reading of one kind: from a live read, or from the thread's own rollout. */
export type KindObs = { at: number; limit: SessionRateLimit; from: LiveRead['route'] | 'rollout' }

/**
 * What the sense feeds the core for one kind. `live`: the own reading, when it is at least as new as the
 * seed (then `sawLive` and `basis` take it). `seed`: the reading picked by observation time (pickSeed),
 * for the memory seed. `pct`: the reading the near test uses, `at` its time.
 */
export type KindReading = { live?: SessionRateLimit; seed?: Anchored; pct?: number; at?: number }

export type View = {
  own: Partial<Record<Kind, KindObs>>
  seed: Partial<Record<Kind, SeedEntry>>
  readings: Partial<Record<Kind, KindReading>>
  /** The kinds the host reports (3.6). A kind with a test reading in force is present too: the sense adds it. */
  present: Kind[]
  /** Two good live reads in a row with no window at all, and no newer own observation. Then no kind has a `live` or a `pct`. */
  blind: boolean
  /** The newest credits of the live read, the own rollout and seed.json. */
  credits?: CodexCredits
  /** A23: the credits can pay past 100%. */
  creditsUsable: boolean
  /** The last good live read (live.json), whatever its age. */
  live?: LiveRead
  /** The last failed live read, when it is newer than the last good one (CX23). */
  liveError?: { at: number; error: string }
  /** The newest own codex token_count, with windows or not (P1: the hard stop). */
  newest?: TokenCount
  /** A19: a watched kind of `points` is near its trip or floor point. */
  near: boolean
}

/** The part of the session context that the view reads. */
export type QuotaCtx = { transcript: string | null; store: Pick<SessionStore, 'read' | 'locked'> }

/** A19: the trip point and, with a floor consent, the floor point of each watched kind. */
export type Points = Partial<Record<Kind, { trip: number; floorPoint?: number }>>

export type QuotaDeps = Pick<Deps, 'paths' | 'clock' | 'log' | 'owner'> & {
  daemon: QuotaDaemon
  rollouts: Rollouts
  readB?: ReadB
  /** The clock of the live.lock wait: real time (3.6). The specs keep the default. */
  lockClock?: Clock
  /** The liveness test of a live.lock holder. */
  pidAlive?: (pid: number) => boolean
}

export type Quota = {
  /** 3.6: the live read, shared by the data dir. live.json when it is younger than `maxAgeMs`, else a read under live.lock. Undefined on a failure or with no daemon. */
  live(maxAgeMs: number, timeoutMs?: number): Promise<LiveRead | undefined>
  /** What the sense reads at `now`. It reads files only. It can write seed.json and the present kinds of the session (never inside `locked`). */
  view(sx: QuotaCtx, now: number, points?: Points): View
  /**
   * A19: the view, and when a kind is near its trip point and a daemon exists, a live(15 s) read with a 2 s
   * timeout first. A thread with no rollout reads so at every call (Q1): no reading of its own grows as it spends.
   */
  nearView(sx: QuotaCtx, points: Points): Promise<View>
  /** Settles when the first live read of this broker settles. */
  firstRead: Promise<void>
  /** The first gate of the thread waits for the first read, for at most FIRST_READ_WAIT_MS, once. */
  awaitFirstRead(): Promise<void>
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** A kind's reading in a codex snapshot. */
const limitIn = (s: CodexSnapshot, k: Kind): SessionRateLimit | undefined => codexLimits(s).find((l) => l.kind === k)

const asSeed = (v: unknown): SeedEntry | undefined =>
  isObject(v) && finite(v['pct']) && finite(v['resetsAtMs']) && finite(v['at']) ? { pct: v['pct'], resetsAtMs: v['resetsAtMs'], at: v['at'] } : undefined

/** The live read of a file, without the file fields. */
function liveReadOf(f: LiveFile): LiveRead {
  const { v: _v, by: _by, recent: _recent, ...read } = f
  return read
}

const sameCounts = (a: Partial<Record<Kind, number>>, b: Partial<Record<Kind, number>>): boolean => KINDS.every((k) => (a[k] ?? 0) === (b[k] ?? 0))

/** A thread with no rollout: an ephemeral thread (TUI /side, `codex exec --ephemeral`, an ephemeral app-server thread). */
export const noRollout = (sx: Pick<QuotaCtx, 'transcript'>): boolean => sx.transcript === null || sx.transcript === ''

/** The quota of one broker (3.6). */
export function createQuota(d: QuotaDeps): Quota {
  const livePath = join(d.paths.data, 'live.json')
  const liveLock = join(d.paths.data, 'live.lock')
  const errorPath = join(d.paths.data, 'live-error.json')
  const seedPath = join(d.paths.data, 'seed.json')
  const seedLock = join(d.paths.data, 'seed.lock')
  const lockClock = d.lockClock ?? realClock
  let inflight: Promise<LiveRead | undefined> | undefined
  let firstDone = (): void => {}
  const firstRead = new Promise<void>((resolve) => {
    firstDone = resolve
  })
  let waited = false

  const readFile = <T>(file: string, valid: (v: Record<string, unknown>) => boolean): T | undefined => {
    try {
      const v = readJson<unknown>(file)
      return isObject(v) && v['v'] === 1 && valid(v) ? (v as T) : undefined
    } catch (e) {
      d.log.debug(codexDebug.readFailed(file, errText(e)))
      return undefined
    }
  }
  const readLive = (): LiveFile | undefined => readFile<LiveFile>(livePath, (v) => finite(v['at']))
  const readError = (): LiveErrorFile | undefined => readFile<LiveErrorFile>(errorPath, (v) => finite(v['at']) && typeof v['error'] === 'string')
  const readSeed = (): SeedFile | undefined => readFile<SeedFile>(seedPath, () => true)
  const young = (f: LiveFile | undefined, maxAgeMs: number): f is LiveFile => f !== undefined && d.clock.now() - f.at < maxAgeMs

  const write = (file: string, v: unknown): void => {
    try {
      writeJson(file, v)
    } catch (e) {
      d.log.debug(codexDebug.writeFailed(file, errText(e)))
    }
  }

  /** The read itself, with its timeout on the broker clock. */
  const call = async (route: LiveRead['route'], timeoutMs: number): Promise<unknown> => {
    const ac = new AbortController()
    try {
      const reader =
        route === 'daemon'
          ? (() => {
              const daemon = d.daemon.get()
              if (daemon === undefined) throw new Error('the Codex daemon is gone')
              return daemon.rateLimits(timeoutMs)
            })()
          : (d.readB ?? (() => Promise.reject(new Error('no route B'))))(timeoutMs)
      reader.catch(() => undefined) // a read that fails after its timeout is no unhandled rejection
      const timeout = d.clock.sleep(timeoutMs, ac.signal).then(() => {
        if (!ac.signal.aborted) throw new Error(`no answer within ${timeoutMs} ms`)
      })
      return await Promise.race([reader, timeout])
    } finally {
      ac.abort()
    }
  }

  const routeNow = (): LiveRead['route'] | undefined => {
    let daemon: unknown
    try {
      daemon = d.daemon.get()
    } catch (e) {
      d.log.debug(codexDebug.liveFailed('daemon', errText(e)))
      daemon = undefined
    }
    if (daemon !== undefined) return 'daemon'
    return d.readB !== undefined ? 'app-server' : undefined
  }

  const readLiveNow = async (maxAgeMs: number, timeoutMs: number): Promise<LiveRead | undefined> => {
    const route = routeNow()
    if (route === undefined) return undefined
    const deadline = Date.now() + timeoutMs
    let token: string | undefined
    for (;;) {
      try {
        token = tryLock(liveLock, d.owner, { staleMs: LIVE_LOCK_STALE_MS, ...(d.pidAlive === undefined ? {} : { pidAlive: d.pidAlive }) })
      } catch (e) {
        d.log.debug(codexDebug.liveFailed(route, errText(e)))
        return undefined
      }
      if (token !== undefined) break
      // Another broker reads: wait for its live.json, on real time, for at most the read timeout.
      if (Date.now() >= deadline) {
        const f = readLive()
        return young(f, maxAgeMs) ? liveReadOf(f) : undefined
      }
      await lockClock.sleep(LIVE_LOCK_POLL_MS)
      const f = readLive()
      if (young(f, maxAgeMs)) return liveReadOf(f)
    }
    try {
      const f = readLive()
      if (young(f, maxAgeMs)) return liveReadOf(f) // it came while this broker waited for the lock
      let r: LiveRead | { error: string }
      try {
        r = liveOf(await call(route, timeoutMs), d.clock.now(), route)
      } catch (e) {
        r = { error: errText(e) }
      }
      if ('error' in r) {
        d.log.debug(codexDebug.liveFailed(route, r.error))
        write(errorPath, { v: 1, by: VERSION, at: d.clock.now(), route, error: r.error } satisfies LiveErrorFile)
        return undefined
      }
      const recent = [...(readLive()?.recent ?? []), r.codex ?? null].slice(-BLIND_AFTER)
      write(livePath, { ...r, v: 1, by: VERSION, recent } satisfies LiveFile)
      return r
    } finally {
      unlock(liveLock, token)
    }
  }

  const live = (maxAgeMs: number, timeoutMs: number = A_READ_MS): Promise<LiveRead | undefined> => {
    const f = readLive()
    if (young(f, maxAgeMs)) {
      firstDone()
      return Promise.resolve(liveReadOf(f))
    }
    if (inflight !== undefined) return inflight
    const p = readLiveNow(maxAgeMs, timeoutMs)
      .catch((e: unknown) => {
        d.log.debug(codexDebug.liveFailed('daemon', errText(e)))
        return undefined
      })
      .finally(() => {
        if (inflight === p) inflight = undefined
        firstDone()
      })
    inflight = p
    return p
  }

  /**
   * The present kinds (3.6). The session keeps per kind the count of observations in a row that omit it,
   * and the time of the newest observation it counted, so an observation that two brokers see counts
   * once. A kind is present while its count is under BLIND_AFTER, or while its seed is in its window.
   */
  const presentOf = (store: QuotaCtx['store'], seen: readonly TokenCount[], seedInWindow: (k: Kind) => boolean): Kind[] => {
    const state = store.read()
    let count: Partial<Record<Kind, number>> = { ...(state.absentCount ?? {}) }
    const apply = (from: Partial<Record<Kind, number>>, after: number): { count: Partial<Record<Kind, number>>; at: number } => {
      const news = seen.filter((o) => o.at > after && isObservation(o.snapshot)).sort((a, b) => a.at - b.at)
      let p: Presence = { present: [...KINDS], count: { ...from } }
      for (const o of news) p = nextPresence(p, o.snapshot, () => false)
      // A count past BLIND_AFTER changes nothing, so it stops there: an absent kind costs no write per response.
      const capped: Partial<Record<Kind, number>> = {}
      for (const k of KINDS) if (p.count[k] !== undefined) capped[k] = Math.min(BLIND_AFTER, p.count[k] ?? 0)
      return { count: capped, at: news.length === 0 ? after : Math.max(after, news[news.length - 1]?.at ?? after) }
    }
    const next = apply(count, state.absentAt ?? 0)
    if (!sameCounts(next.count, count)) {
      try {
        count = store.locked((tx) => {
          const again = apply(tx.state.absentCount ?? {}, tx.state.absentAt ?? 0)
          tx.state.absentCount = again.count
          tx.state.absentAt = again.at
          return again.count
        })
      } catch (e) {
        d.log.debug(codexDebug.writeFailed('the present kinds', errText(e)))
        count = next.count
      }
    }
    // The rule of nextPresence, on the stored counts.
    return KINDS.filter((k) => (count[k] ?? 0) < BLIND_AFTER || seedInWindow(k))
  }

  /** seed.json takes each own reading that is newer than its entry, and newer own credits (under seed.lock). */
  const updateSeed = (own: Partial<Record<Kind, KindObs>>, credits: { at: number; value: CodexCredits } | undefined, file: SeedFile | undefined): void => {
    const entries: Array<[Kind, SeedEntry]> = []
    for (const k of KINDS) {
      const o = own[k]
      const a = o === undefined ? undefined : anchoredOf(o.limit)
      if (o === undefined || a === undefined) continue
      const had = file?.[k]
      if (had === undefined || o.at > had.at) entries.push([k, { ...a, at: o.at }])
    }
    const newCredits = credits !== undefined && (file?.credits === undefined || credits.at > file.credits.at)
    if (entries.length === 0 && !newCredits) return
    try {
      withLock(seedLock, d.owner, () => {
        const cur = readSeed() ?? { v: 1, by: VERSION }
        const next: SeedFile = { ...cur, v: 1, by: VERSION }
        let changed = false
        for (const [k, e] of entries) {
          const had = asSeed(cur[k])
          if (had === undefined || e.at > had.at) {
            next[k] = e
            changed = true
          }
        }
        if (newCredits && credits !== undefined && (cur.credits === undefined || credits.at > cur.credits.at)) {
          next.credits = credits
          changed = true
        }
        if (changed) writeJson(seedPath, next)
      })
    } catch (e) {
      d.log.debug(codexDebug.writeFailed(seedPath, errText(e)))
    }
  }

  const view = (sx: QuotaCtx, now: number, points: Points = {}): View => {
    const liveFile = readLive()
    const liveError = readError()
    const seedFile = readSeed()
    const roll = sx.transcript === null || sx.transcript === '' ? undefined : d.rollouts.read(sx.transcript)
    // Q1: a thread with no rollout has the live read as its only own reading, and nearView keeps it fresh on
    // the daemon. Without a route, nothing refreshes that read for it: it is a reading of another time, so it
    // counts as a seed only, as seed.json does (a Claude session before its first response).
    const liveOwn = !noRollout(sx) || routeNow() !== undefined
    const liveLimit = (k: Kind): SessionRateLimit | undefined => (liveFile?.codex === undefined || liveFile.codex === null ? undefined : limitIn(liveFile.codex, k))

    // Own readings per kind: the thread's rollout, then the live read. The newer observation wins.
    const own: Partial<Record<Kind, KindObs>> = {}
    for (const k of KINDS) {
      const tc = roll?.byKind[k]
      const l = tc === undefined ? undefined : limitIn(tc.snapshot, k)
      if (tc !== undefined && l !== undefined) own[k] = { at: tc.at, limit: l, from: 'rollout' }
      const lf = liveLimit(k)
      const prev = own[k]
      if (liveOwn && liveFile !== undefined && lf !== undefined && (prev === undefined || liveFile.at >= prev.at)) own[k] = { at: liveFile.at, limit: lf, from: liveFile.route }
    }

    // Blind: only live reads make it, and a newer own observation with windows ends it. A blind login has
    // no reading to feed the core (the sense gives the basis `none`, why `blind`). The seed stays, for the
    // reset margin.
    const newerObs = roll?.newestObs !== undefined && liveFile !== undefined && roll.newestObs.at > liveFile.at
    const blind = liveFile !== undefined && blindFrom(liveFile.recent ?? []) && !newerObs

    const seed: Partial<Record<Kind, SeedEntry>> = {}
    const readings: Partial<Record<Kind, KindReading>> = {}
    for (const k of KINDS) {
      let s = asSeed(seedFile?.[k])
      // Q1: a live read that is no own reading is a seed of its time, and the newer seed wins.
      const ll = liveOwn ? undefined : liveLimit(k)
      const la = ll === undefined ? undefined : anchoredOf(ll)
      if (la !== undefined && liveFile !== undefined && (s === undefined || liveFile.at > s.at)) s = { ...la, at: liveFile.at }
      if (s !== undefined) seed[k] = s
      const o = own[k]
      const oa = o === undefined ? undefined : anchoredOf(o.limit)
      const picked = pickSeed(o !== undefined && oa !== undefined ? { ...oa, at: o.at } : undefined, s)
      const ownWins = o !== undefined && (s === undefined || o.at >= s.at)
      const r: KindReading = {}
      if (!blind && ownWins) {
        r.live = o.limit
        r.pct = o.limit.percentUsed
        r.at = o.at
      } else if (!blind && s !== undefined && inWindow(s, now, k)) {
        r.pct = s.pct
        r.at = s.at
      }
      if (picked !== undefined) r.seed = picked
      readings[k] = r
    }

    const seedInWindow = (k: Kind): boolean => {
      const r = readings[k]?.seed
      return r !== undefined && inWindow(r, now, k)
    }
    const seen: TokenCount[] = [...(roll?.fresh ?? [])]
    // Another reader of the cursor (attendance, a waiter's turn-end check) can take the fresh lines first.
    // The cursor keeps its newest observation, so that one always counts; the time dedupes it.
    const obs = roll?.newestObs
    if (obs !== undefined && !seen.some((o) => o.at === obs.at)) seen.push(obs)
    if (liveFile?.codex !== undefined && liveFile.codex !== null) seen.push({ at: liveFile.at, snapshot: liveFile.codex })
    const present = presentOf(sx.store, seen, seedInWindow)

    // Credits: the newest of the live read, the own rollout and seed.json.
    const sources: Array<{ at: number; value: CodexCredits; own: boolean }> = []
    if (liveFile !== undefined && isObject(liveFile.credits)) sources.push({ at: liveFile.at, value: liveFile.credits, own: true })
    const rc = roll?.newest?.snapshot.credits
    if (roll?.newest !== undefined && isObject(rc)) sources.push({ at: roll.newest.at, value: rc, own: true })
    if (seedFile?.credits !== undefined && isObject(seedFile.credits.value) && finite(seedFile.credits.at)) {
      sources.push({ at: seedFile.credits.at, value: seedFile.credits.value, own: false })
    }
    const best = sources.reduce<(typeof sources)[number] | undefined>((a, b) => (a === undefined || b.at > a.at ? b : a), undefined)

    const near = KINDS.some((k) => {
      const p = points[k]
      return p !== undefined && nearTrip(readings[k]?.pct, p.trip, p.floorPoint)
    })

    updateSeed(own, best?.own === true ? { at: best.at, value: best.value } : undefined, seedFile)

    const out: View = { own, seed, readings, present, blind, creditsUsable: usableCredits(best?.value), near }
    if (best !== undefined) out.credits = best.value
    if (liveFile !== undefined) out.live = liveReadOf(liveFile)
    if (liveError !== undefined && (liveFile === undefined || liveError.at > liveFile.at)) out.liveError = { at: liveError.at, error: liveError.error }
    if (roll?.newest !== undefined) out.newest = roll.newest
    return out
  }

  return {
    live,
    view,
    async nearView(sx, points) {
      let v = view(sx, d.clock.now(), points)
      if ((v.near || noRollout(sx)) && routeNow() === 'daemon') {
        await live(LIVE_NEAR_MAX_AGE_MS, A_NEAR_MS)
        v = view(sx, d.clock.now(), points)
      }
      return v
    },
    firstRead,
    async awaitFirstRead() {
      if (waited) return
      const ac = new AbortController()
      try {
        await Promise.race([firstRead, d.clock.sleep(FIRST_READ_WAIT_MS, ac.signal)])
      } finally {
        ac.abort()
        waited = true
      }
    },
  }
}
