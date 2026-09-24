import { mock } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'
import type {
  CommandRunInput,
  CommandSpec,
  On,
  PromptOrigin,
  PromptSubmitInput,
  RenderSurface,
  SessionMeasureInput,
  SessionRateLimit,
  ToolCallResult,
  TurnStepInput,
} from 'claude-code'

// The kit world beneath spare10 (design 11.2). Nothing answers beneath a plugin in the kit, so this
// answers every event and op the plugin can reach: a missing one turns the gate off silently.
// Call world(on, opts) once per test, before the first $ call, and never add a second unmatched hook
// for an event it answers (extend world() instead).
//
// Options (WorldOptions, all optional):
//   pct          live five_hour percentUsed, undefined for no live reading (mutable as w.pct)
//   resetsAt     default RESETS, null for a reading without resetsAt (mutable as w.resetsAt)
//   surfaces     default ['terminal'] (attended), [] for unattended (mutable as w.surfaces)
//   env          the process env the plugin reads and writes (w.env)
//   store        $.store at the start (w.store)
//   settings     settings.read answers: merged (no source), user, project, local, flag, policy (w.settings)
//   agents       ids $.agent.list() names, status running (w.agents)
//   agentListFails  agent.list answers { deny }, so $.agent.list() rejects (w.agentListFails)
//   answer       the dialog: a label (answered at once), 'hang' (default) or 'dismiss' (w.answer)
//   parkRejects  reject the first N $.spare10.park calls at once, as the host's 10 s cap does
//   sessionId    default 'S1' (w.sessionId; change it to act out a /clear)
//   core         how core answers ordinary tool calls: 'ran' (default), 'deny' or 'error' (w.core)
//   coreContext  context that core adds to a 'ran' or 'error' tool result, as a hook beneath would (w.coreContext)
//   box          the prompt box text $.prompt.read returns (w.box)
//   usageFails   session.usage answers { deny }, so $.session.usage() rejects (w.usageFails)
//   envGetFails  env names whose env.get answers { deny } (w.envGetFails)
//   envGetDelayMs  per env name: env.get reads the value at once and answers this many mock ms late
//                (w.envGetDelayMs), to keep a read in flight while other work runs
//   envSetDelayMs  env.set answers this many mock ms late (w.envSetDelayMs), to open a write window
//   storeGetFails  store.get answers { deny }, so $.store.get() rejects (w.storeGetFails)
//   extraLimits  more rate limits listed beside five_hour, such as seven_day (w.extraLimits)
//
// The world records: asked (each dialog), ran, requests, prompts, fills, aborts, logs, invalidations,
// renders, commands (names), commandSpecs (whole) and parkCalls. w.release(label?) ends every hung dialog with that label, or as
// gone without one. w.cap() rejects every pending $.spare10.park call, as the host does at 10 s.
// A dialog whose dispatch aborts records the reason in w.dialogAborted ('no' until then).
// "Chat about this" and Esc reject live: act them out with answer 'dismiss'.
// ui.invalidate is counted and passed on to the kit, which redraws a mounted badge:
//   $.ui.mount({ plugin: 'spare10', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
//
// Helpers: begin($, w) raises session.start (attended per w.surfaces). clear($, w, id, reason?) acts
// out a /clear (or an in-session /resume): session.end for the old id, then the new id. bash($, agentId?, command?)
// makes a Bash call. step(agentId?, turnId?) builds a TurnStepInput and drain($, input) runs it to
// { chunks, text }. measure(pct?, changed?, resetsAt?) builds a SessionMeasureInput. typed(text,
// kind?, turnId?) builds a whole PromptSubmitInput, cmd(args, kind?) a whole CommandRunInput.
// Inline plugins: `above` (prepend) settles above a Bash call whose command starts with `abandon`
// after 1000 mock ms. `stepAbove` (prepend) does the same to a model request whose turn id starts
// with `abandon`. `slowAsk` (prepend) holds each AskUserQuestion 1000 mock ms before its next, as a
// slow hook above spare10 does. `auditor` calls $.tool.call of Read on every AskUserQuestion before its next.
//
// Timing idiom: start a gated call without awaiting it, then `await w.clock.settle()`, then answer,
// release, cap or advance. Lessons from the kit:
// - A decision's env writes and notices land after the held calls return: settle before reading
//   w.env or w.logs.
// - Three w.cap() calls in a row inside one real second fail the hold closed (fast rejections).
// - A subagent id that never stepped and is not in `agents` is an engine fork, and the gate passes it.
// - The auditor proves the origin exemption only when a held step raised the dialog (a raise from the
//   tool gate skips the gate's own registration).
// - A mounted badge in the tripped phase pulses every 1000 mock ms, so a long advance runs many redraws.

export const T0 = Date.parse('2026-09-24T12:00:00Z')
export const RESETS = '2026-09-24T15:00:00.000Z' // 3 h after T0
export const LATER = '2026-09-24T20:00:00.000Z' // a later window
export const TZ = 'UTC' // pass to text functions in pure tests
export const HOUR = 3_600_000
export const CAP = '$.spare10.park: spare10 did not answer within 10000ms'

export type Core = 'ran' | 'deny' | 'error'
export type SettingsWorld = {
  merged?: Record<string, unknown>
  user?: Record<string, unknown>
  project?: Record<string, unknown>
  local?: Record<string, unknown>
  flag?: Record<string, unknown>
  policy?: Record<string, unknown>
}

export type WorldOptions = {
  pct?: number
  resetsAt?: string | null
  surfaces?: RenderSurface[]
  env?: Record<string, string>
  store?: Record<string, unknown>
  settings?: SettingsWorld
  agents?: string[]
  agentListFails?: boolean
  answer?: string
  parkRejects?: number
  sessionId?: string
  core?: Core
  coreContext?: string[]
  box?: string
  usageFails?: boolean
  envGetFails?: string[]
  envGetDelayMs?: Record<string, number>
  envSetDelayMs?: number
  storeGetFails?: boolean
  extraLimits?: SessionRateLimit[]
}

export type Asked = { question: string; header?: string; labels: string[] }

export type World = {
  clock: MockClock
  pct: number | undefined
  resetsAt: string | null
  answer: string
  sessionId: string
  surfaces: RenderSurface[]
  agents: string[]
  agentListFails: boolean
  core: Core
  coreContext: string[] | undefined
  box: string
  usageFails: boolean
  envGetFails: string[]
  envGetDelayMs: Record<string, number>
  envSetDelayMs: number
  storeGetFails: boolean
  extraLimits: SessionRateLimit[]
  settings: SettingsWorld
  env: Map<string, string>
  store: Map<string, unknown>
  asked: Asked[]
  dialogAborted: string // the abort reason a hung dialog saw ('no' until then)
  release: (label?: string) => void // end every hung dialog: with a label, or as gone
  cap: () => void // reject every pending $.spare10.park call, as the host does at 10 s
  ran: string[] // `${tool}:${agentId ?? 'main'}` that reached core
  requests: number // model requests that reached core
  prompts: PromptSubmitInput[] // prompts that reached core
  fills: string[] // $.prompt.fill texts
  aborts: string[] // $.turn.abort turn ids
  logs: Array<{ text: string; to?: string }> // $.ui.log lines
  invalidations: number
  renders: number // SessionMode renders beneath the plugin
  commands: string[] // $.command.register names
  commandSpecs: CommandSpec[] // $.command.register inputs, whole
  parkCalls: number
}

type AskInput = { questions?: Array<{ question?: string; header?: string; options?: Array<{ label?: string }> }> }

export function world(on: On, opts: WorldOptions = {}): World {
  const clock = mock.clock(on, { now: T0 })
  const hung: Array<(label: string | undefined) => void> = []
  const pending = new Set<() => void>()
  let rejectsLeft = opts.parkRejects ?? 0
  const w: World = {
    clock,
    pct: opts.pct,
    resetsAt: opts.resetsAt === undefined ? RESETS : opts.resetsAt,
    answer: opts.answer ?? 'hang',
    sessionId: opts.sessionId ?? 'S1',
    surfaces: opts.surfaces ?? ['terminal'],
    agents: opts.agents ?? [],
    agentListFails: opts.agentListFails ?? false,
    core: opts.core ?? 'ran',
    coreContext: opts.coreContext,
    box: opts.box ?? '',
    usageFails: opts.usageFails ?? false,
    envGetFails: opts.envGetFails ?? [],
    envGetDelayMs: opts.envGetDelayMs ?? {},
    envSetDelayMs: opts.envSetDelayMs ?? 0,
    storeGetFails: opts.storeGetFails ?? false,
    extraLimits: opts.extraLimits ?? [],
    settings: opts.settings ?? {},
    env: new Map(Object.entries(opts.env ?? {})),
    store: new Map(Object.entries(opts.store ?? {})),
    asked: [],
    dialogAborted: 'no',
    release: (label) => {
      for (const end of hung.splice(0)) end(label)
    },
    cap: () => {
      for (const reject of [...pending]) reject()
      pending.clear()
    },
    ran: [],
    requests: 0,
    prompts: [],
    fills: [],
    aborts: [],
    logs: [],
    invalidations: 0,
    renders: 0,
    commands: [],
    commandSpecs: [],
    parkCalls: 0,
  }

  const five = (): SessionRateLimit[] => [
    ...w.extraLimits,
    ...(w.pct === undefined
      ? []
      : [{ kind: 'five_hour', percentUsed: w.pct, ...(w.resetsAt === null ? {} : { resetsAt: w.resetsAt }) }]),
  ]

  // Session and reading.
  on('session.usage', () =>
    w.usageFails ? { deny: 'usage unavailable' } : { value: { startedAt: T0, context: { window: 200_000 }, rateLimits: five() } },
  )
  on('session.id', () => ({ value: w.sessionId }))
  on('session.surfaces', () => ({ value: [...w.surfaces] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.measure', (_$, e) => ({ changed: [...e.changed] }))

  // Env, settings, store, agents, commands.
  on('env.get', async (_$, e) => {
    if (w.envGetFails.includes(e.name)) return { deny: `env.get ${e.name} failed` }
    const value = w.env.get(e.name) // read now, answered late: the answer can be stale
    const delay = w.envGetDelayMs[e.name] ?? 0
    if (delay > 0) await clock.sleep(delay)
    return { value }
  })
  on('env.set', async (_$, e) => {
    if (w.envSetDelayMs > 0) await clock.sleep(w.envSetDelayMs)
    if (e.value === undefined) w.env.delete(e.name)
    else w.env.set(e.name, e.value)
    return { value: undefined }
  })
  on('settings.read', (_$, e) => ({ value: (e.source === undefined ? w.settings.merged : w.settings[e.source as keyof SettingsWorld]) ?? {} }))
  on('store.get', (_$, e) => (w.storeGetFails ? { deny: 'store unavailable' } : { value: w.store.get(e.key) }))
  on('store.set', (_$, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('agent.list', () =>
    w.agentListFails
      ? { deny: 'agent list unavailable' }
      : { value: w.agents.map((id) => ({ id, description: id, type: 'general-purpose', status: 'running' })) },
  )
  on('command.register', (_$, e) => {
    w.commands.push(e.name)
    w.commandSpecs.push({ ...e })
    return { value: { command: e.name } }
  })
  on('command.run', () => ({ text: 'bottom' }))

  // Prompt box, turn end, UI.
  on('prompt.read', () => ({ value: { text: w.box, cursor: w.box.length } }))
  on('prompt.fill', (_$, e) => {
    w.fills.push(e.text)
    w.box = e.text
    return { isFilled: true }
  })
  on('turn.abort', (_$, e) => {
    w.aborts.push(e.turnId)
    return { value: undefined }
  })
  on('ui.render', (_$, e) => {
    if (e.component === 'SessionMode') w.renders += 1
    return { type: 'engine', ref: 0 } as never
  })
  on('ui.invalidate', async (_$, e, next) => {
    w.invalidations += 1
    return next(e) // the kit's own redraw of mounted drawings lies beneath: answering here would swallow it
  })
  on('ui.log', (_$, e) => {
    w.logs.push({ text: e.text, to: e.to })
    return { value: undefined }
  })

  // The dialog: $.ui.ask arrives as a tool.call of AskUserQuestion.
  on('tool.call', { tool: /^AskUserQuestion$/ }, async (_$, e, next) => {
    const q = (e as unknown as AskInput).questions?.[0]
    const question = q?.question ?? ''
    w.asked.push({
      question,
      ...(q?.header === undefined ? {} : { header: q.header }),
      labels: (q?.options ?? []).map((o) => o.label ?? ''),
    })
    const answered = (label: string) => ({ result: { answers: { [question]: label } } })
    if (w.answer === 'dismiss') return { deny: 'the person dismissed the dialog' }
    if (w.answer !== 'hang') return answered(w.answer)
    const end = await new Promise<{ label?: string; aborted?: string }>((resolve) => {
      hung.push((label) => resolve(label === undefined ? {} : { label }))
      next.signal.addEventListener('abort', () => resolve({ aborted: String(next.signal.reason) }), { once: true })
    })
    if (end.aborted !== undefined) {
      w.dialogAborted = end.aborted
      return { deny: 'dialog gone' }
    }
    return end.label === undefined ? { deny: 'dialog gone' } : answered(end.label)
  })

  // Core: ordinary tool calls, model requests, prompts.
  on('tool.call', (_$, e) => {
    w.ran.push(`${e.tool}:${e.agentId ?? 'main'}`)
    if (w.core === 'deny') return { deny: 'no (a permission rule)' }
    const context = w.coreContext === undefined ? {} : { context: [...w.coreContext] }
    if (w.core === 'error') return { isError: true, result: 'boom', text: 'boom', ...context } as never
    return { result: 'ran', ...context }
  })
  on('turn.step', async function* (_$, e) {
    w.requests += 1
    yield { kind: 'text', index: 0, text: 'hi' }
    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('prompt.submit', (_$, e) => {
    w.prompts.push(e)
    return e.context === undefined ? { text: e.text } : { text: e.text, context: e.context }
  })

  // The carrier: passes to spare10's provider, rejects as the host's 10 s cap does.
  on('spare10.park', async (_$, e, next) => {
    w.parkCalls += 1
    if (rejectsLeft > 0) {
      rejectsLeft -= 1
      return { deny: CAP }
    }
    let reject: () => void = () => undefined
    const capped = new Promise<'cap'>((resolve) => {
      reject = () => resolve('cap')
      pending.add(reject)
    })
    const r = await Promise.race([next(e), capped])
    pending.delete(reject)
    return r === 'cap' ? { deny: CAP } : r
  })

  return w
}

/** Raises session.start: attended when w.surfaces lists one, else as a -p run. */
export function begin($: Engine, w: World): Promise<unknown> {
  const surface = w.surfaces[0] ?? null
  return $.session.start({ cwd: '/tmp', surface, isInteractive: surface !== null })
}

/** A /clear (reason 'clear') or an in-session /resume: session.end for the old id, then the process goes on under `id`. */
export async function clear($: Engine, w: World, id: string, reason: 'clear' | 'resume' = 'clear'): Promise<void> {
  await $.session.end({ reason, sessionId: w.sessionId, resume: { id: w.sessionId } })
  w.sessionId = id
}

/** A Bash call from main (no agentId) or a subagent. */
export function bash($: Engine, agentId?: string, command = 'ls'): Promise<ToolCallResult> {
  return $.tool.call({ tool: 'Bash', command, ...(agentId === undefined ? {} : { agentId }) } as never) as Promise<ToolCallResult>
}

/** One model request of main (no agentId) or a subagent. */
export function step(agentId?: string, turnId = 't'): TurnStepInput {
  return { turnId, index: 0, model: 'm', messageCount: 1, ...(agentId === undefined ? {} : { agentId }) }
}

/** Runs a step to its end: its chunks, and the text they carried. */
export async function drain($: Engine, s: TurnStepInput): Promise<{ chunks: unknown[]; text: string }> {
  const chunks: unknown[] = []
  let text = ''
  for await (const c of $.turn.step(s)) {
    chunks.push(c)
    if (c.kind === 'text') text += c.text
  }
  return { chunks, text }
}

/** A session.measure: the five_hour window at pct (none when undefined), with what changed. */
export function measure(
  pct?: number,
  changed: SessionMeasureInput['changed'] = ['rateLimits', 'cost'],
  resetsAt: string | null = RESETS,
): SessionMeasureInput {
  const rateLimits: SessionRateLimit[] =
    pct === undefined ? [] : [{ kind: 'five_hour', percentUsed: pct, ...(resetsAt === null ? {} : { resetsAt }) }]
  return { context: { window: 200_000 }, rateLimits, cost: { usd: 0.1 }, changed }
}

/** Where a prompt or a command came from, whole. */
export function originOf(kind: PromptOrigin['kind']): PromptOrigin {
  if (kind === 'plugin') return { kind: 'plugin', name: 'other' }
  if (kind === 'channel') return { kind: 'channel', server: 'other' }
  return { kind } as PromptOrigin
}

/** A whole PromptSubmitInput: the person's Enter by default. */
export function typed(text: string, kind: PromptOrigin['kind'] = 'composer', turnId?: string): PromptSubmitInput {
  return { text, wait: false, origin: originOf(kind), ...(turnId === undefined ? {} : { turnId }) }
}

/** A whole CommandRunInput for /spare10 (the short form reaches the plugin without origin). */
export function cmd(args: string, kind: PromptOrigin['kind'] = 'composer'): CommandRunInput {
  return { command: 'spare10', args, origin: originOf(kind), presentation: { isFullscreen: false, columns: 80 } }
}

/** A prepend plugin that settles above a Bash call whose command starts with `abandon`, after 1000 mock ms. */
export const above: Plugin = {
  name: 'above',
  tier: 'prepend',
  register: (on) => {
    on('tool.call', { command: /^abandon/ } as never, async ($, e, next) => {
      const p = next(e)
      void p.catch(() => undefined)
      await $.clock.sleep(1000)
      return { deny: 'a hook above settled first' }
    })
  },
}

/**
 * A prepend plugin that settles above a model request whose turn id starts with `abandon`, after 1000
 * mock ms. It keeps reading the step beneath in the background, so whatever that step does after its
 * dispatch is abandoned (a request, a turn abort) still shows in the world.
 */
export const stepAbove: Plugin = {
  name: 'step-above',
  tier: 'prepend',
  register: (on) => {
    on('turn.step', async function* ($, e, next) {
      if (!e.turnId.startsWith('abandon')) return yield* next(e)
      const beneath = next(e)
      void (async () => {
        for await (const _chunk of beneath); // read the step beneath to its end, whatever it yields
      })().catch(() => undefined)
      await $.clock.sleep(1000)
      yield { kind: 'text', index: 0, text: 'above' }
      return { turnId: e.turnId, index: e.index, answer: 'above', toolUses: [], stopReason: 'end_turn', usage: null }
    })
  },
}

/** A prepend plugin that holds each AskUserQuestion 1000 mock ms before its next, as a slow hook above spare10 does. */
export const slowAsk: Plugin = {
  name: 'slow-ask',
  tier: 'prepend',
  register: (on) => {
    on('tool.call', { tool: /^AskUserQuestion$/ }, async ($, e, next) => {
      await $.clock.sleep(1000)
      return next(e)
    })
  },
}

/** A plugin whose tool.call hook calls $.tool.call of Read on every AskUserQuestion before its own next. */
export const auditor: Plugin = {
  name: 'auditor',
  register: (on) => {
    on('tool.call', async ($, e, next) => {
      if ((e.tool as string) === 'AskUserQuestion') await $.tool.call({ tool: 'Read', file_path: '/tmp/x' } as never)
      return next(e)
    })
  },
}
