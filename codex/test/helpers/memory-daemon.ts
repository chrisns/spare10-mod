import type { Clock } from '../../src/clock.ts'
import type { Daemon, TurnInfo } from '../../src/daemon.ts'

// The in-memory Daemon of the logic specs (Codex design 8.2): every call answers from a script, and every call
// is recorded. A script entry is a value, an Error (the call rejects with it), or a function of the call's
// arguments. `interrupt` can wait on the given clock first, as the real reply comes after the abort (3.5).

type Answer<A extends unknown[], R> = R | Error | ((...args: A) => R | Promise<R>)

export type DaemonScript = {
  rateLimits: Answer<[timeoutMs?: number], unknown>
  loaded: Answer<[], string[]>
  status: Answer<[threadId: string], string>
  newestTurn: Answer<[threadId: string], TurnInfo | undefined>
  interrupt: Answer<[threadId: string, turnId: string], void>
  start: Answer<[threadId: string, text: string], string>
  hooksList: Answer<[cwd: string], unknown>
  /** `interrupt` answers after this long on the clock. */
  interruptDelayMs: number
}

export type DaemonCall = { method: keyof Daemon; args: unknown[] }

export type MemoryDaemon = Daemon & {
  readonly script: DaemonScript
  readonly calls: DaemonCall[]
  /** The calls of one method, as their argument lists. */
  callsOf(method: keyof Daemon): unknown[][]
}

async function answer<A extends unknown[], R>(a: Answer<A, R>, args: A): Promise<R> {
  if (a instanceof Error) throw a
  if (typeof a === 'function') return (a as (...args: A) => R | Promise<R>)(...args)
  return a
}

export function memoryDaemon(clock: Clock, init: Partial<DaemonScript> = {}): MemoryDaemon {
  const script: DaemonScript = {
    rateLimits: new Error('no rate limits scripted'),
    loaded: [],
    status: 'idle',
    newestTurn: undefined,
    interrupt: undefined,
    start: 'U-NEW',
    hooksList: { data: [] },
    interruptDelayMs: 0,
    ...init,
  }
  const calls: DaemonCall[] = []
  const rec = (method: keyof Daemon, args: unknown[]): void => void calls.push({ method, args })
  return {
    script,
    calls,
    callsOf: (method) => calls.filter((c) => c.method === method).map((c) => c.args),
    rateLimits: async (timeoutMs) => {
      rec('rateLimits', timeoutMs === undefined ? [] : [timeoutMs])
      return answer(script.rateLimits, [timeoutMs])
    },
    loaded: async () => {
      rec('loaded', [])
      return answer(script.loaded, [])
    },
    status: async (threadId) => {
      rec('status', [threadId])
      return answer(script.status, [threadId])
    },
    newestTurn: async (threadId) => {
      rec('newestTurn', [threadId])
      return answer(script.newestTurn, [threadId])
    },
    interrupt: async (threadId, turnId) => {
      rec('interrupt', [threadId, turnId])
      if (script.interruptDelayMs > 0) await clock.sleep(script.interruptDelayMs)
      return answer(script.interrupt, [threadId, turnId])
    },
    start: async (threadId, text) => {
      rec('start', [threadId, text])
      return answer(script.start, [threadId, text])
    },
    hooksList: async (cwd) => {
      rec('hooksList', [cwd])
      return answer(script.hooksList, [cwd])
    },
  }
}
