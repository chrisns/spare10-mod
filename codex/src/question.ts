import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { answerOf as elicitAnswer, codexDebug, elicitParams } from '../../hooks/core/codex.ts'
import { joinableAt, parseStopped } from '../../hooks/core/decide.ts'
import type { Answered, Outcome } from '../../hooks/core/decide.ts'
import {
  againNotice,
  answeredOf as answeredOfCore,
  answersKind,
  consentOfEnd,
  dueRelease,
  dueStep,
  dueWait,
  namedKinds,
  namedOf,
  questionOf,
  raiseAtFloor,
  resumeNotice,
  sensedNote,
  stopNewer,
  stopNotice,
  stopOpenNotice,
  stopPlan,
  viewedOf,
} from '../../hooks/core/flow.ts'
import type { Acted, KindSense, Late, QuestionCore, Sensed, StopSense, Via } from '../../hooks/core/flow.ts'
import { debugLine, notice, questionText } from '../../hooks/core/text.ts'
import { consentsOf, writeConsent } from './consent.ts'
import type { Deps } from './deps.ts'
import { pidAlive as realPidAlive, readJson } from './files.ts'
import { BEAT_EVERY_MS, addHeld, beat, callId, heldNames, removeHeld, turnEnded, waiterOf } from './held.ts'
import type { HeldCall } from './held.ts'
import type { McpServer } from './mcp.ts'
import type { Quota } from './quota.ts'
import type { Rollouts } from './rollout.ts'
import { noReading } from './sense.ts'
import type { CodexSensed, SenseApi, SessionCtx } from './sense.ts'
import type { SettingsSource } from './settings.ts'
import { clearStopped, noticeIn, writeStopped } from './stop.ts'
import { FORMAT } from './store.ts'
import type { AnswerFile, Leader, QuestionFile, Tx } from './store.ts'
import type { Sweep } from './sweep.ts'
import { BEAT_STALE_MS, CANCEL_CHECK_MS, CHECK_MS, HANDOFF_LIMIT, HOLD_LIMIT_MS, LIVE_POLL_MS, LIVE_RELEASE_MAX_AGE_MS, TICK_MS } from './timing.ts'

// One question per session, on the files of 3.7 (Codex design 4.3, 7.2 question.ts). This ports
// ensureQuestion, hold, raise, lost, forget, decidedElsewhere, dueCheck, settle, settleStop and settleAgain
// of register.tsx. The question lives in question.json and its outcome in answer.json, so every broker
// of the session (the root and each subagent thread) and the CLI see one question. Each step that reads and
// writes a session file does it inside one lock. The open or join and the caller's held entry are one
// critical section, so no broker sees a question without its first waiter. Only the leader, a live held
// call, raises the form (MCP elicitation), and a leader that goes away hands the question on. A missing
// question never counts as Stop here: the waiter decides again.

/** How a wait ends: the answer, or `again` (the question ended with no answer: decide again). */
export type Settled = Outcome | 'again'

/** A question file with the credit balance that the form names (CX46, A23). */
export type QuestionRecord = QuestionFile & { credits?: string }

/** A settle's result: the core Late, and the question as it settled (for the command replies). */
export type SettleResult = Late & { q?: QuestionRecord }

export type QuestionDeps = Pick<Deps, 'clock' | 'wake' | 'log' | 'owner' | 'pid'> & {
  sense: SenseApi
  settings: Pick<SettingsSource, 'get'>
  quota: Pick<Quota, 'live'>
  rollouts: Pick<Rollouts, 'read'>
  mcp: Pick<McpServer, 'canElicit' | 'elicit'> & Partial<Pick<McpServer, 'closed'>>
  sweep: Pick<Sweep, 'sweep'>
  /** The liveness test of a leader's broker pid (default: files.pidAlive). */
  pidAlive?: (pid: number) => boolean
}

export type Questions = {
  /** 4.3 open or join, in one critical section with the caller's held entry. The question's key. */
  ensureQuestion(sx: SessionCtx, call: HeldCall, opener: 'loop' | 'prompt', s: Sensed & Partial<Pick<CodexSensed, 'credits' | 'creditsUsable'>>, a: Pick<Acted, 'gating' | 'holders'>): string
  /** 4.3 the Codex form of hold(): the outcome, `again`, or `dropped` when Codex dropped the call. */
  waitQuestion(sx: SessionCtx, call: HeldCall, key: string): Promise<Settled | 'dropped'>
  /**
   * 4.3 ports settle and settleStop. `raiseAt` (B50 item 4, a resume command): a fresh sense, so a kind at
   * the floor is raised to a full Resume first. `noDialog`: the question could not show (a held stop, A5).
   */
  settle(sx: SessionCtx, key: string, outcome: Outcome, via: Via, o?: { noDialog?: boolean; raiseAt?: Pick<Sensed, 'kinds' | 'now'> }): Promise<SettleResult>
  /** B50: what the settled Resume of `key` answered. */
  answeredOf(sx: SessionCtx, key: string): Answered[]
  /** The answer of `key`, when it is the last settled question (the gate reads `noDialog` for CX5). */
  answerFor(sx: SessionCtx, key: string): AnswerFile | undefined
  /** The open question of the session, if any. */
  openQuestion(sx: SessionCtx): QuestionRecord | undefined
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A session file read with no lock: the value, undefined when absent, or 'unknown' for another format (fail closed when acting). */
function readFile<T>(dir: string, name: string): T | undefined | 'unknown' {
  const v = readJson<unknown>(join(dir, name))
  if (v === undefined) return undefined
  if (!isObject(v) || v['v'] !== FORMAT) return 'unknown'
  return v as T
}

/** The leader names this broker's call of this thread. */
const leaderIs = (l: Leader | null, owner: string, pid: number, sx: Pick<SessionCtx, 'thread'>, call: Pick<HeldCall, 'id'>): boolean =>
  l !== null && l.brokerId === owner && l.pid === pid && l.threadId === sx.thread && l.call === callId(call)

export function createQuestions(d: QuestionDeps): Questions {
  const alive = d.pidAlive ?? realPidAlive
  const checking = new Set<string>() // 4.3: one waiter of this broker runs the due check of a key at a time

  const readQuestion = (sx: SessionCtx): QuestionRecord | undefined | 'unknown' => readFile<QuestionRecord>(sx.store.dir, 'question.json')
  const readAnswer = (sx: SessionCtx): AnswerFile | undefined => {
    const a = readFile<AnswerFile>(sx.store.dir, 'answer.json')
    return a === 'unknown' ? undefined : a
  }

  /**
   * 4.3 step 2: a question is stale when its leader's broker is dead and no live held entry waits on it. A
   * question with no leader is live while it is younger than BEAT_STALE_MS, or while a live held entry waits
   * on it. A held entry is live while its broker's pid is alive and its thread's beat is fresh (heldNames).
   */
  const stale = (tx: Tx, sx: SessionCtx, q: QuestionRecord, now: number): boolean => {
    const waited = heldNames(tx, sx.store, q.key, now, alive)
    if (q.leader !== null) return !alive(q.leader.pid) && !waited
    return !(now - q.createdAt < BEAT_STALE_MS || waited)
  }

  const ensureQuestion: Questions['ensureQuestion'] = (sx, call, opener, s, a) => {
    const now = d.clock.now()
    return sx.store.locked((tx) => {
      let q = tx.question() as QuestionRecord | undefined
      if (q !== undefined && stale(tx, sx, q, now)) {
        tx.setQuestion(undefined) // for example the question of a broker that died at a daemon restart
        q = undefined
      }
      let key: string | undefined
      if (q !== undefined) {
        const ans = tx.answer()
        const outcome = ans?.key === q.key ? ans.outcome : undefined
        if (joinableAt(outcome, answeredOfCore(q), namedKinds(s, a).map(viewedOf))) {
          if (opener === 'loop') tx.setQuestion({ ...q, loops: q.loops + 1 })
          key = q.key
        }
      }
      if (key === undefined) {
        const core: QuestionCore = questionOf(opener, s, a, s.now)
        key = `${sx.sid}:${now}:${randomBytes(4).toString('hex')}`
        // CX46: past 100%, work spends credits, so the form names the balance.
        const balance = s.creditsUsable === true && typeof s.credits?.balance === 'string' ? s.credits.balance : undefined
        const rec: Omit<QuestionRecord, 'v' | 'by'> = { ...core, key, leader: null, createdAt: now, ...(balance === undefined ? {} : { credits: balance }) }
        tx.setQuestion(rec)
      }
      addHeld(tx, sx.thread, call, { brokerPid: d.pid, hostPid: sx.hostPid }, now, key)
      return key
    })
  }

  /** Under the lock: this live call takes the lead of an open question with no live leader. True when it did. */
  const takeLead = (sx: SessionCtx, call: HeldCall, key: string): boolean =>
    sx.store.locked((tx) => {
      const q = tx.question() as QuestionRecord | undefined
      if (q === undefined || q.key !== key || q.silent) return false
      if (q.leader !== null && alive(q.leader.pid)) return false
      const leader: Leader = {
        brokerId: d.owner,
        pid: d.pid,
        threadId: sx.thread,
        ...(call.turn === undefined ? {} : { turn: call.turn }),
        transcript: sx.transcript,
        call: callId(call),
      }
      tx.setQuestion({ ...q, leader })
      return true
    })

  /**
   * 4.3 lost(): the leader's step went away with no answer. While the question is open and still led by
   * this call, the hand-off count goes up and the question has no leader, so a live held call raises again.
   * Past HANDOFF_LIMIT it settles as Stop here. Whichever comes first, the form's cancel or the leader's
   * leave, counts once.
   */
  const lostIn = (tx: Tx, sx: SessionCtx, call: HeldCall, key: string): 'handed' | 'limit' | undefined => {
    const q = tx.question() as QuestionRecord | undefined
    if (q === undefined || q.key !== key || !leaderIs(q.leader, d.owner, d.pid, sx, call)) return undefined
    if (q.handoffs >= HANDOFF_LIMIT) return 'limit'
    const handoffs = q.handoffs + 1
    tx.setQuestion({ ...q, leader: null, handoffs })
    d.log.debug(debugLine.handedOn(handoffs))
    return 'handed'
  }

  const lost = async (sx: SessionCtx, call: HeldCall, key: string): Promise<void> => {
    const r = sx.store.locked((tx) => lostIn(tx, sx, call, key))
    if (r === 'limit') await settle(sx, key, 'stop', 'dialog ended without an answer')
  }

  /** 2.2: after `cancel`, the leader's turn ended in its rollout within CANCEL_CHECK_MS (or Codex dropped the call): the step that asked went away. */
  const turnWentAway = async (sx: SessionCtx, call: HeldCall): Promise<boolean> => {
    const step = 100
    for (let waited = 0; ; waited += step) {
      if (call.dropped.aborted || turnEnded(d.rollouts, sx.transcript, call.turn)) return true
      if (sx.transcript === null || sx.transcript === '' || call.turn === undefined || waited >= CANCEL_CHECK_MS) return false
      await d.clock.sleep(step)
    }
  }

  /** The answer of a form still applies: the question is open and this call still leads it. */
  const stillLeads = (sx: SessionCtx, call: HeldCall, key: string): boolean => {
    const q = readQuestion(sx)
    const a = readAnswer(sx)
    return a?.key !== key && q !== undefined && q !== 'unknown' && q.key === key && leaderIs(q.leader, d.owner, d.pid, sx, call)
  }

  /** 4.3 raise, by the leader only: one form, and its answer mapped by 2.2. */
  const raise = async (sx: SessionCtx, call: HeldCall, key: string): Promise<void> => {
    const q = readQuestion(sx)
    if (q === undefined || q === 'unknown' || q.key !== key) return
    if (!d.mcp.canElicit()) {
      await settle(sx, key, 'stop', 'could not ask', { noDialog: true }) // A5: no form can show
      return
    }
    let result: unknown
    let failed = false
    try {
      result = await d.mcp.elicit(elicitParams(questionText(q.facts, q.opener, q.mode, q.auto), q.credits))
    } catch (e) {
      failed = true
      if (d.mcp.closed?.() === true) return // the broker shuts down: no answer, and the next broker asks
      d.log.debug(codexDebug.readFailed('the answer of the form', errText(e)))
    }
    if (!stillLeads(sx, call, key)) return // a stale form: settled meanwhile, or handed on
    const answer = elicitAnswer(result, failed)
    if (answer === 'resume' || answer === 'stop') await settle(sx, key, answer, 'dialog')
    else if (answer === 'decline') await settle(sx, key, 'stop', 'could not ask', { noDialog: true })
    else if (await turnWentAway(sx, call)) await lost(sx, call, key)
    else await settle(sx, key, 'stop', 'dialog') // Esc on the form: the turn still runs
  }

  /** 4.3 decided elsewhere: a consent that answers every kind of the question, or a stop of this session newer than it. */
  const decidedElsewhere = (sx: SessionCtx, q: QuestionRecord, now: number): Outcome | undefined => {
    let covered = q.kinds.length > 0
    for (const kind of q.kinds) {
      const end = q.ends[kind]
      // B50 item 3: a consent answers a kind at a matching tier. A22: a consent of an earlier window is void.
      const list = end === undefined ? [] : consentsOf(sx, { kind, attended: !q.silent, testBasis: end.test, realEnd: end.test ? null : end.end }, d.log)
      if (!answersKind(end, list, now)) {
        covered = false
        break
      }
    }
    if (covered) return 'resume'
    const st = parseStopped(sx.store.read().stopped)
    return stopNewer(st, q, now) && st.sessionId === sx.sid ? 'stop' : undefined // R6
  }

  /** 4.3 settle with no answer (register.tsx settleAgain): answer `again`, and every held step decides again. */
  const settleAgain = (sx: SessionCtx, key: string, via: 'reset' | 'quota', gatingNow: readonly KindSense[], s: Sensed): boolean =>
    sx.store.locked((tx) => {
      const q = tx.question() as QuestionRecord | undefined
      const a = tx.answer()
      if (q === undefined || q.key !== key || a?.key === key) return false
      tx.setAnswer({ key, outcome: 'again', via, at: s.now, answered: [] })
      tx.setQuestion(undefined)
      noticeIn(tx.state, againNotice(q, via, gatingNow, s), s.now)
      return true
    })

  /** Under the lock, when the key is still open: changes the question, and returns it. */
  const update = (sx: SessionCtx, key: string, fn: (q: QuestionRecord, tx: Tx) => QuestionRecord | undefined): QuestionRecord | undefined =>
    sx.store.locked((tx) => {
      const q = tx.question() as QuestionRecord | undefined
      if (q === undefined || q.key !== key || tx.answer()?.key === key) return undefined
      const next = fn(q, tx)
      if (next !== undefined) tx.setQuestion(next)
      return next
    })

  /**
   * 4.3 due check (register.tsx dueCheck): flow.dueStep and flow.dueRelease, one waiter of this broker at a
   * time. The check moves `nextCheck` under the lock first, so the brokers of a session share one check per
   * CHECK_MS. A check reads the daemon first (`live(60 s)`), and a release reads it again (`live(30 s)`). True
   * when the question ended as `again`.
   */
  const dueCheck = async (sx: SessionCtx, key: string, q0: QuestionRecord): Promise<boolean> => {
    if (checking.has(key)) return false
    checking.add(key)
    try {
      const now = d.clock.now()
      if (dueWait(q0, now)) return false
      const q = update(sx, key, (cur) => (dueWait(cur, now) ? undefined : { ...cur, nextCheck: now + CHECK_MS }))
      if (q === undefined) return false // another broker checks, or the question ended
      const step = dueStep(q, now, q.silent || d.settings.get().autoResume)
      if (step === 'note') {
        update(sx, key, (cur, tx) => {
          if (cur.noted) return undefined
          noticeIn(tx.state, notice.resetWaitingFor(namedOf(cur)), now) // D0.2, byte for byte
          return { ...cur, noted: true }
        })
        return false
      }
      if (step === 'noteSensed') {
        // B43: the note names what opened or reset, so it senses. A throw: the catch logs, the next check tries again.
        const s = await d.sense.sense(sx)
        const n = sensedNote(q, s, d.sense.split(sx, s).gating, now)
        update(sx, key, (cur, tx) => {
          if ('noteAt' in n) return { ...cur, noteAt: n.noteAt } // B45: nothing of the question opened yet
          if (cur.noted) return undefined
          noticeIn(tx.state, n.text, now)
          return { ...cur, noted: true }
        })
        return false
      }
      if (step === 'wait') return false
      const first = await d.quota.live(LIVE_POLL_MS)
      let s = await d.sense.sense(sx)
      let gatingNow = d.sense.split(sx, s).gating
      let via = dueRelease(q, now, gatingNow, d.sense.resetTooRecent(sx, s))
      if (via === undefined) return false
      const again = await d.quota.live(LIVE_RELEASE_MAX_AGE_MS)
      if (again !== undefined && again.at !== first?.at) {
        s = await d.sense.sense(sx)
        gatingNow = d.sense.split(sx, s).gating
        via = dueRelease(q, now, gatingNow, d.sense.resetTooRecent(sx, s))
        if (via === undefined) return false
      }
      if (noReading(s)) return false // 3.6: no reading at all, nothing is released at this cycle
      return settleAgain(sx, key, via, gatingNow, s)
    } catch (e) {
      d.log.debug(debugLine.checkFailed(errText(e)))
      return false
    } finally {
      checking.delete(key)
    }
  }

  const settle: Questions['settle'] = async (sx, key, outcome, via, o = {}) => {
    // A Stop here senses first, outside the lock: the kinds that gate now (B46) and the real ones (TS1).
    let sNow: StopSense | undefined
    if (outcome === 'stop') {
      try {
        const s = await d.sense.sense(sx)
        const split = d.sense.split(sx, s)
        sNow = { s, split, holders: d.sense.holders(sx, s, split.gating) }
      } catch {
        sNow = undefined // fail closed: the question's real kinds (flow.ts stopPlan)
      }
    }
    let auto: boolean | undefined
    try {
      auto = d.settings.get().autoResume // the setting in force
    } catch {
      auto = sNow?.s.cfg.autoResume
    }
    const now = d.clock.now()
    let stopWritten = false
    const r = sx.store.locked((tx): SettleResult | undefined => {
      const q = tx.question() as QuestionRecord | undefined
      if (q === undefined || q.key !== key || tx.answer()?.key === key) return undefined
      if (o.raiseAt !== undefined) raiseAtFloor(q, o.raiseAt)
      tx.setAnswer({ key, outcome, via, at: now, answered: answeredOfCore(q), ...(o.noDialog === true ? { noDialog: true } : {}) })
      tx.setQuestion(undefined)
      // Elsewhere: the consent or the stop is already written, as register.tsx.
      if (via === 'elsewhere') return { q }
      if (outcome === 'resume') {
        for (const kind of q.kinds) {
          const end = q.ends[kind]
          if (end !== undefined) writeConsent(tx.state, kind, consentOfEnd(end), now, end.test) // B49: each kind at its tier
        }
        clearStopped(tx.state)
        if (via !== 'command') noticeIn(tx.state, resumeNotice(q, now), now)
        return { q }
      }
      if (q.silent || !(q.mode === 'hold' || via === 'command')) return { q }
      const plan = stopPlan(q, now, auto ?? q.auto, sNow)
      if (plan.kind === 'open') {
        // B46 open: nothing is stopped. Held work is refused, new work passes.
        const text = stopOpenNotice(q, plan.ended, via)
        if (text !== undefined) noticeIn(tx.state, text, now, 'stop')
        return { q, ended: plan.ended }
      }
      const written = writeStopped(tx.state, plan.record, now)
      if (o.noDialog === true) tx.state.stopMeta = { noDialog: true }
      else delete tx.state.stopMeta
      stopWritten = true
      const n = stopNotice(q, plan, written, via, now, auto ?? q.auto)
      if (n.text !== undefined) noticeIn(tx.state, n.text, now, 'stop')
      return { q, ...n.late }
    })
    if (r === undefined) return {}
    if (stopWritten) await d.sweep.sweep(sx) // 4.23: every other running turn of the session
    return r
  }

  /**
   * The leave of a held call (the finally of waitQuestion, under the lock): its held entry goes. A leader
   * of an open question hands it on (lost). A question that no fresh held entry waits on, that has no
   * leader, and that is older than BEAT_STALE_MS goes (forget).
   */
  const leave = async (sx: SessionCtx, call: HeldCall, key: string): Promise<void> => {
    const now = d.clock.now()
    let r: 'handed' | 'limit' | undefined
    try {
      r = sx.store.locked((tx) => {
        removeHeld(tx, sx.thread, call, d.pid)
        const out = lostIn(tx, sx, call, key)
        const q = tx.question() as QuestionRecord | undefined
        if (q !== undefined && q.key === key && q.leader === null && now - q.createdAt >= BEAT_STALE_MS && !heldNames(tx, sx.store, key, now, alive)) {
          tx.setQuestion(undefined)
        }
        return out
      })
    } catch (e) {
      // A stale held entry stays: the next gate of this thread removes it, and a stale question goes at the next open.
      d.log.debug(codexDebug.writeFailed('the held entry', errText(e)))
      return
    }
    if (r !== 'limit') return
    try {
      await settle(sx, key, 'stop', 'dialog ended without an answer')
    } catch (e) {
      d.log.debug(codexDebug.writeFailed('the answer', errText(e))) // the question stays: the next waiter or open decides
    }
  }

  const waitQuestion: Questions['waitQuestion'] = async (sx, call, key) => {
    const w = waiterOf(d, sx.store.dir, call.dropped)
    let lastBeat = d.clock.now()
    try {
      for (;;) {
        // The question first, then the answer: a settle writes the answer before it deletes the question.
        const q = readQuestion(sx)
        const a = readAnswer(sx)
        if (a?.key === key) return a.outcome
        if (call.dropped.aborted) return 'dropped'
        if (turnEnded(d.rollouts, sx.transcript, call.turn)) {
          call.drop() // 4.12 item 3: the turn ended in the rollout (a subagent gets no Interrupt hook)
          return 'dropped'
        }
        const now = d.clock.now()
        // Another format: no settle can write it. At the hold limit the call refuses before Codex drops it (fail closed).
        if (q === 'unknown' && now >= call.since + HOLD_LIMIT_MS) return 'stop'
        if (q !== 'unknown') {
          if (q === undefined || q.key !== key) return 'again' // decide again: sense, then open or join
          if (now >= call.since + HOLD_LIMIT_MS) {
            // Before Codex drops the call and fails open. A settle that fails still refuses (fail closed).
            await settle(sx, key, 'stop', 'time limit').catch((e: unknown) => d.log.debug(codexDebug.writeFailed('the answer', errText(e))))
            const after = readAnswer(sx)
            return after?.key === key ? after.outcome : 'stop'
          }
          if (!q.silent && !call.dropped.aborted && (q.leader === null || !alive(q.leader.pid)) && takeLead(sx, call, key)) {
            void raise(sx, call, key).catch((e: unknown) => d.log.debug(codexDebug.gateError(errText(e))))
          }
          const elsewhere = decidedElsewhere(sx, q, now)
          if (elsewhere !== undefined) {
            // The consent or the stop is on disk already: the settle only closes the question.
            await settle(sx, key, elsewhere, 'elsewhere').catch((e: unknown) => d.log.debug(codexDebug.writeFailed('the answer', errText(e))))
            return elsewhere
          }
          if (await dueCheck(sx, key, q)) continue // the top returns `again`
        }
        const t = d.clock.now()
        if (t - lastBeat >= BEAT_EVERY_MS) {
          beat(sx.store, sx.thread, t, d.log)
          lastBeat = t
        }
        await w.next(nextWait(q === 'unknown' ? undefined : q, call, t))
      }
    } finally {
      w.close()
      await leave(sx, call, key)
    }
  }

  return {
    ensureQuestion,
    waitQuestion,
    settle,
    answeredOf(sx, key) {
      const a = readAnswer(sx)
      return a?.key === key ? a.answered : []
    },
    answerFor(sx, key) {
      const a = readAnswer(sx)
      return a?.key === key ? a : undefined
    },
    openQuestion(sx) {
      const q = readQuestion(sx)
      if (q === undefined || q === 'unknown') return undefined
      return readAnswer(sx)?.key === q.key ? undefined : q
    },
  }
}

/** The next cycle of a waiter: TICK_MS, or the first of the question's due, check and note times and the hold limit that lie ahead. */
function nextWait(q: QuestionRecord | undefined, call: Pick<HeldCall, 'since'>, now: number): number {
  const times = [call.since + HOLD_LIMIT_MS]
  if (q !== undefined) times.push(q.due, q.nextCheck, ...(q.noted ? [] : [q.noteAt]))
  const ahead = times.map((t) => t - now).filter((ms) => ms > 0)
  return Math.min(TICK_MS, ...ahead)
}

