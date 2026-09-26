import { realpathSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexText, optionOf } from '../../hooks/core/codex.ts'
import type { Command, HostKind } from '../../hooks/core/codex.ts'
import { VERSION, commandFailed } from '../../hooks/core/text.ts'
import { createAttendance } from './attend.ts'
import type { AttendanceSource } from './attend.ts'
import { realClock } from './clock.ts'
import type { Clock } from './clock.ts'
import { createCommands, scratchStore } from './commands.ts'
import type { Commands } from './commands.ts'
import { daemonLink, udsDaemon } from './daemon.ts'
import type { Daemon } from './daemon.ts'
import { ensureDir, pidAlive as realPidAlive, writeFileAtomic } from './files.ts'
import { debugOn, fileLog } from './log.ts'
import type { Log } from './log.ts'
import { findPaths } from './paths.ts'
import type { Env, Paths } from './paths.ts'
import { createQuestions } from './question.ts'
import { createQuota } from './quota.ts'
import { createRollouts } from './rollout.ts'
import { createSense } from './sense.ts'
import type { SessionCtx } from './sense.ts'
import { createSettings } from './settings.ts'
import { listSessions, sessionStore } from './store.ts'
import { createSweep } from './sweep.ts'
import type { Wake } from './wake.ts'

// The CLI (Codex design 2.9, 7.2 cli.ts): `spare10 ...` from the `!` of the Codex prompt, or from another
// terminal. It runs the same commands as a typed prompt, in its own process, on the same data dir. Its
// writes wake the brokers through their Wake source. From `!` (CODEX_THREAD_ID is set) Codex gives the
// output to the model, so the CLI prints one short line and queues the full reply as a transcript line of
// the session. `resume`, `stop` and `simulate` act only on a named session: they never guess. The agent
// cannot run it: a sandbox shows in the env, or in a data dir that it cannot write.

export type CliDeps = {
  env: Env
  stdout: { write(text: string): unknown }
  clock: Clock
  /** The running file (codex/dist/cli.mjs): the plugin root is two folders above it. */
  selfFile: string
  daemon: (paths: Paths) => Daemon | undefined
  pidAlive?: (pid: number) => boolean
  /** The pid in the lock files. Default: process.pid. */
  pid?: number
  log?: Log
  /** The Wake of the specs, so an in-process broker sees the CLI's writes at once. Default: none (the file events do it). */
  wake?: Wake
}

type Args = { verb: string; words: string[]; full: boolean; session?: string; codexHome?: string; data?: string }

const VERBS = ['status', 'help', 'resume', 'stop', 'simulate', 'set']
/** A session state that changed in the last 24 h is a candidate (2.9). */
const RECENT_MS = 24 * 3_600_000

const set = (v: string | undefined): v is string => v !== undefined && v !== ''
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const codeOf = (e: unknown): unknown => (typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined)

/** The arguments of CX37, or undefined when they are bad. */
export function parseArgs(argv: readonly string[]): Args | undefined {
  const words: string[] = []
  const out: Omit<Args, 'verb' | 'words'> = { full: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? ''
    const eq = a.indexOf('=')
    const flag = a.startsWith('--') ? (eq > 0 ? a.slice(0, eq) : a) : undefined
    if (flag === '--full' && eq < 0) {
      out.full = true
      continue
    }
    if (flag === '--session' || flag === '--codex-home' || flag === '--data') {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i]
      if (v === undefined || v === '') return undefined
      if (flag === '--session') out.session = v
      else if (flag === '--codex-home') out.codexHome = v
      else out.data = v
      continue
    }
    if (flag !== undefined) return undefined
    words.push(a)
  }
  const verb = (words[0] ?? 'status').toLowerCase()
  const rest = words.slice(1)
  if (!VERBS.includes(verb)) return undefined
  if (out.full && verb !== 'status') return undefined
  if ((verb === 'status' || verb === 'help' || verb === 'resume' || verb === 'stop') && rest.length > 0) return undefined
  if (verb === 'simulate' && rest.length === 0) return undefined
  return { ...out, verb, words: rest }
}

/** The command of the arguments (2.8 forms, with the words of the shell). */
function commandOf(a: Args): Command {
  if (a.verb === 'simulate') return { verb: 'simulate', words: a.words, rest: a.words.join(' ') }
  if (a.verb === 'set') {
    if (a.words.length === 0) return { verb: 'set', words: [], rest: '' }
    const o = optionOf(a.words[0] ?? '')
    if (o === undefined) return { verb: 'unknownOption', word: a.words[0] ?? '' }
    const value = a.words.slice(1)
    return { verb: 'set', words: [o.name, ...value], rest: value.join(' ') }
  }
  return { verb: a.verb as 'status' | 'help' | 'resume' | 'stop', words: [], rest: '' }
}

/** The paths, with `--codex-home` and `--data` over 3.9. */
function pathsOf(env: Env, a: Args, selfFile: string): Paths {
  const e: Record<string, string | undefined> = { ...env }
  // The flags are the person's own words, so a relative one resolves against the person's cwd.
  if (a.codexHome !== undefined) e.CODEX_HOME = resolve(a.codexHome)
  if (a.data !== undefined) e.SPARE10_CODEX_DATA = resolve(a.data)
  return findPaths(e, selfFile)
}

/** The CLI. The bundle entry calls it and sets process.exitCode. */
export async function main(argv: string[], d: CliDeps): Promise<number> {
  const print = (text: string): void => void d.stdout.write(`${text}\n`)
  const a = parseArgs(argv)
  if (a === undefined) {
    print(codexText.cliUsage) // CX37
    return 2
  }
  const verb = a.verb
  // 2.9: the agent runs it (CX35). CODEX_SANDBOX is set only by the macOS seatbelt.
  const agent = set(d.env.CODEX_SANDBOX) || d.env.CODEX_SANDBOX_NETWORK_DISABLED === '1'
  if (agent && verb !== 'help') {
    print(codexText.cliSandbox(verb))
    return 2
  }
  let paths: Paths
  try {
    paths = pathsOf(d.env, a, d.selfFile)
  } catch (e) {
    print(`spare10: ${commandFailed(errText(e))}`)
    return 1
  }
  const pid = d.pid ?? process.pid
  const log = d.log ?? fileLog(paths.data, debugOn(d.env), d.clock, { tag: `cli ${pid}` })
  // The write check: a data dir that the agent's sandbox keeps read-only.
  if (verb !== 'help') {
    try {
      ensureDir(paths.data)
      const probe = join(paths.data, `.cli-${pid}.probe`)
      writeFileAtomic(probe, '')
      unlinkSync(probe)
    } catch (e) {
      const code = codeOf(e)
      if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
        print(codexText.cliSandbox(verb))
        return 2
      }
      print(`spare10: ${commandFailed(errText(e))}`)
      return 1
    }
    // No launcher write here (3.9): each broker keeps it on its own copy and its own Node.js. A CLI of another
    // copy (a checkout, an older cached version) or another Node.js must not take the person's launcher over.
  }
  const fromBang = set(d.env.CODEX_THREAD_ID)
  const named = a.session ?? (set(d.env.CODEX_SESSION_ID) ? d.env.CODEX_SESSION_ID : undefined)
  const alive = d.pidAlive ?? realPidAlive
  const wake: Wake = d.wake ?? { watch: () => () => {}, fire() {} }
  const owner = `cli-${pid}`
  // The env of the settings: SPARE10_SIMULATE is for a launch of its own, never for a command.
  const env: Env = { ...d.env, SPARE10_SIMULATE: undefined }

  /** The commands of one session (or of none: the report with no session). */
  const partsFor = (sid: string | undefined): { cmds: Commands; sx: SessionCtx | undefined } => {
    const state = sid === undefined ? undefined : sessionStore(paths, sid, owner, wake, { clock: d.clock }).read()
    const hostPid = state?.hostPid ?? 0
    const hostKind: HostKind = state?.hostKind ?? 'unknown'
    const rollouts = createRollouts()
    const link = daemonLink(() => d.daemon(paths), d.clock, { log })
    const settings = createSettings({ paths, log, env, parentChild: () => undefined, simulateKind: () => 'five_hour', hostKind })
    const quota = createQuota({ paths, clock: d.clock, log, owner, daemon: link, rollouts, pidAlive: alive })
    const base = createAttendance({ hostKind, rollouts })
    // The CLI takes the attendance that the root broker wrote (3.7), else the rollout's.
    const attendance: AttendanceSource = {
      attended(c, mode) {
        const got = base.attended(c, mode)
        return state?.attended === undefined ? got : { ...got, attended: state.attended }
      },
    }
    const sense = createSense({ clock: d.clock, log, settings, quota, attendance })
    const sweep = createSweep({ clock: d.clock, log, daemon: link })
    const mcp = { canElicit: () => false, elicit: () => Promise.reject(new Error('the CLI shows no form')) }
    const questions = createQuestions({ clock: d.clock, wake, log, owner, pid, sense, settings, quota, rollouts, mcp, sweep, pidAlive: alive })
    const cmds = createCommands({ paths, clock: d.clock, log, owner, env, settings, quota, sense, questions, sweep, daemon: link, attendance, pidAlive: alive })
    if (sid === undefined) return { cmds, sx: undefined }
    const sx: SessionCtx = {
      sid,
      thread: sid,
      root: true,
      transcript: state?.transcript ?? null,
      hostPid,
      store: sessionStore(paths, sid, owner, wake, { clock: d.clock, hostPid }),
    }
    return { cmds, sx }
  }

  try {
    if (verb === 'help') {
      print(`spare10: ${codexText.help(paths.bin)}`)
      return 0
    }
    const cmd = commandOf(a)
    const changes = verb === 'resume' || verb === 'stop' || verb === 'simulate' || (verb === 'set' && cmd.verb === 'set' && cmd.words.length > 0)
    if ((verb === 'resume' || verb === 'stop' || verb === 'simulate') && named === undefined) {
      // CX36: never guess the session. The sessions of the last 24 h, newest first.
      const now = d.clock.now()
      const rows: Array<readonly [string, string, string]> = []
      for (const r of listSessions(paths, now - RECENT_MS)) {
        let phase = 'unknown'
        try {
          const p = partsFor(r.sid)
          if (p.sx !== undefined) phase = await p.cmds.phase(p.sx)
        } catch {
          phase = 'unknown'
        }
        rows.push([r.sid, r.cwd ?? '-', phase])
      }
      print(codexText.cliNoSession(verb, rows))
      return 2
    }
    if (verb === 'status') {
      const sid = named ?? listSessions(paths, d.clock.now() - RECENT_MS)[0]?.sid
      const p = partsFor(sid)
      if (fromBang && !a.full) print(`spare10: ${await p.cmds.phaseLine(p.sx)}`)
      else print(`spare10: ${await p.cmds.statusText(p.sx, { cli: true, full: true })}`)
      return 0
    }
    const p = partsFor(named)
    // `set` and `help` need no session: a report of no session writes nothing.
    const sx = p.sx ?? { sid: 'none', thread: 'none', root: true, transcript: null, hostPid: 0, store: scratchStore(paths.data) }
    const reply = await p.cmds.exec(sx, cmd, { cli: true })
    if (fromBang && changes && p.sx !== undefined) {
      // CX44: the model reads this line only. The full reply rides the next root gate (2.4).
      p.sx.store.queueNotice(reply)
      print(codexText.cliDone(verb))
      return 0
    }
    print(`spare10: ${reply}`)
    return 0
  } catch (e) {
    print(`spare10: ${commandFailed(errText(e))}`)
    return 1
  }
}

/** True when this file runs as the main module: the bundle `codex/dist/cli.mjs`, through the launcher. */
function isMain(): boolean {
  const script = process.argv[1]
  if (script === undefined) return false
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  main(process.argv.slice(2), {
    env: process.env,
    stdout: process.stdout,
    clock: realClock,
    selfFile: fileURLToPath(import.meta.url),
    daemon: (paths) => udsDaemon(paths, VERSION, realClock),
  }).then(
    (code) => {
      process.exitCode = code
    },
    (e: unknown) => {
      process.stdout.write(`spare10: ${commandFailed(errText(e))}\n`)
      process.exitCode = 1
    },
  )
}
