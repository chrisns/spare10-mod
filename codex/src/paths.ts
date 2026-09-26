import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { writeFileAtomic } from './files.ts'

// Paths, the host process and the CLI launcher (Codex design 3.9, gap-1 3). The broker gets no PLUGIN_DATA,
// so it finds CODEX_HOME and the data dir itself. The test guard (D10): with SPARE10_CODEX_TEST=1 no
// resolved CODEX_HOME, data dir or socket may be under ~/.codex, so a slip throws instead of touching the
// real home and its quota.

export type Env = Readonly<Record<string, string | undefined>>

export type Paths = {
  /** The Codex home: `$CODEX_HOME`. */
  codexHome: string
  /** The data dir: `<CODEX_HOME>/plugins/data/spare10-spare10`, or SPARE10_CODEX_DATA. */
  data: string
  /** The plugin root: two folders above the folder of the running file (`codex/dist/<file>.mjs`). */
  pluginRoot: string
  /** The daemon socket: `<CODEX_HOME>/app-server-control/app-server-control.sock`. */
  socket: string
  /** The CLI launcher: `<data dir>/bin/spare10`. */
  launcher: string
  /** The folder of the launcher, for the PATH line of CX19. */
  bin: string
}

/** The folder name of the data dir: `<plugin>-<marketplace>` (`core-plugins/src/store.rs` L141-146). */
export const DATA_NAME = 'spare10-spare10'

const ARG0 = /[\\/]tmp[\\/]arg0[\\/]codex-arg0[^\\/]*[\\/]?$/

const set = (v: string | undefined): v is string => v !== undefined && v !== ''

/** The plugin root: two folders above the folder of `selfFile`. */
export const pluginRootOf = (selfFile: string): string => resolve(dirname(selfFile), '..', '..')

/** CODEX_HOME from the arg0 folder that every Codex host puts on PATH: three folders up from it. */
export function homeFromPath(pathVar: string | undefined): string | undefined {
  if (!set(pathVar)) return undefined
  for (const entry of pathVar.split(delimiter)) {
    if (entry !== '' && ARG0.test(entry)) return resolve(entry, '..', '..', '..')
  }
  return undefined
}

/** CODEX_HOME from a plugin root in the Codex plugin cache: `<CODEX_HOME>/plugins/cache/<mkt>/<plugin>/<version>`. */
export function homeFromPluginRoot(root: string): string | undefined {
  const parts = resolve(root).split(sep)
  const n = parts.length
  if (n < 6 || parts[n - 5] !== 'plugins' || parts[n - 4] !== 'cache') return undefined
  const home = parts.slice(0, n - 5).join(sep)
  return home === '' ? sep : home
}

/** `p` with its longest existing part resolved through its links, so a link cannot hide the real home. */
function realish(p: string): string {
  let head = resolve(p)
  const tail: string[] = []
  for (;;) {
    try {
      if (existsSync(head)) return join(realpathSync(head), ...tail)
    } catch {
      // A part that cannot be resolved: keep it as it is.
    }
    const up = dirname(head)
    if (up === head) return join(head, ...tail)
    tail.unshift(basename(head))
    head = up
  }
}

/** The file systems of macOS and Windows ignore case by default, so the guard compares without case there. */
const fold = (p: string): string => (process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p)

const isUnder = (p: string, base: string): boolean => {
  const a = fold(p)
  const b = fold(base)
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

/**
 * The real `~/.codex` folders, by name only: of os.homedir() and of the home in the user record (a test can
 * change HOME, not the user record). A HOME in the env that a caller passes is not one: a spec may point it
 * at a temp folder to test the `$HOME/.codex` fallback.
 */
function realCodexHomes(): string[] {
  const homes = new Set<string>()
  const add = (h: string | undefined): void => {
    if (set(h)) homes.add(resolve(h, '.codex'))
  }
  add(homedir())
  try {
    add(userInfo().homedir)
  } catch {
    // No user record: os.homedir() covers it.
  }
  return [...homes]
}

/** True when the test guard is on: SPARE10_CODEX_TEST=1 in `env` or in the env of this process. */
export const testGuardOn = (env: Env): boolean =>
  env.SPARE10_CODEX_TEST === '1' || process.env.SPARE10_CODEX_TEST === '1'

/**
 * True when `p` is the real `~/.codex` or under it, also through a link. The names decide first, with no file
 * system call. Only a path that names another folder is resolved through its links, and so is `~/.codex`.
 */
export function underRealCodexHome(p: string): boolean {
  const homes = realCodexHomes()
  const named = resolve(p)
  if (homes.some((home) => isUnder(named, home))) return true
  const real = realish(p)
  return homes.some((home) => isUnder(real, home) || isUnder(named, realish(home)) || isUnder(real, realish(home)))
}

/**
 * The test guard (3.9, D10): with SPARE10_CODEX_TEST=1, `p` must not be under the real `~/.codex`. `what` names
 * the path in the error. The daemon client calls it too, for the socket it opens.
 */
export function guardTestPath(env: Env, what: string, p: string): void {
  if (testGuardOn(env) && underRealCodexHome(p)) {
    throw new Error(`spare10: SPARE10_CODEX_TEST is set, and the ${what} ${p} is under ~/.codex`)
  }
}

/**
 * CODEX_HOME of the env. Codex makes a relative one absolute against its own cwd, and never exports that form
 * (`utils/home-dir`). The broker runs in the plugin root, so a relative value takes the arg0 folder on PATH
 * first (absolute and canonical), then the plugin root in the plugin cache, and only then the cwd.
 */
const homeOfEnv = (raw: string, env: Env, pluginRoot: string): string =>
  isAbsolute(raw) ? resolve(raw) : (homeFromPath(env.PATH) ?? homeFromPluginRoot(pluginRoot) ?? resolve(raw))

/**
 * The paths of the broker and the CLI (3.9). CODEX_HOME comes from the env (`env_vars`), else from the arg0
 * folder on PATH, else from the plugin root in the plugin cache, else `$HOME/.codex`. A relative CODEX_HOME
 * in the env takes those first too. With SPARE10_CODEX_DATA set (tests, the real-account check), the data dir
 * is that folder, and CODEX_HOME must be in the env: there is no fallback. With SPARE10_CODEX_TEST=1, a
 * CODEX_HOME, data dir or socket under ~/.codex throws.
 */
export function findPaths(env: Env, selfFile: string): Paths {
  const pluginRoot = pluginRootOf(selfFile)
  let codexHome: string
  let data: string
  if (set(env.SPARE10_CODEX_DATA)) {
    if (!set(env.CODEX_HOME)) throw new Error('spare10: SPARE10_CODEX_DATA needs CODEX_HOME in the env')
    codexHome = homeOfEnv(env.CODEX_HOME, env, pluginRoot)
    data = resolve(env.SPARE10_CODEX_DATA)
  } else {
    codexHome = set(env.CODEX_HOME)
      ? homeOfEnv(env.CODEX_HOME, env, pluginRoot)
      : (homeFromPath(env.PATH) ?? homeFromPluginRoot(pluginRoot) ?? resolve(set(env.HOME) ? env.HOME : homedir(), '.codex'))
    data = join(codexHome, 'plugins', 'data', DATA_NAME)
  }
  const socket = join(codexHome, 'app-server-control', 'app-server-control.sock')
  guardTestPath(env, 'CODEX_HOME', codexHome)
  guardTestPath(env, 'data dir', data)
  guardTestPath(env, 'daemon socket', socket)
  const bin = join(data, 'bin')
  return { codexHome, data, pluginRoot, socket, launcher: join(bin, 'spare10'), bin }
}

/** The command line of the process `ppid` (`ps -ww -o args=`), or an empty string when `ps` fails. */
export function parentArgs(ppid: number): string {
  if (!Number.isSafeInteger(ppid) || ppid <= 0) return ''
  try {
    return execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(ppid)], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

/** `s` as one single-quoted shell word: each `'` becomes `'\''`. */
export const shQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`

/** The CLI launcher (3.9): the Node.js that runs the broker, on the CLI of this plugin root. */
export const launcherText = (nodePath: string, pluginRoot: string): string =>
  `#!/bin/sh\nexec ${shQuote(nodePath)} ${shQuote(join(pluginRoot, 'codex', 'dist', 'cli.mjs'))} "$@"\n`

/**
 * Writes the launcher when its content differs (a temp file, mode 0755, rename), so a plugin upgrade updates it
 * at the first new broker. True when it wrote the file.
 */
export function writeLauncher(paths: Paths, nodePath: string): boolean {
  const text = launcherText(nodePath, paths.pluginRoot)
  try {
    if (readFileSync(paths.launcher, 'utf8') === text) return false
  } catch {
    // No launcher yet.
  }
  writeFileAtomic(paths.launcher, text, 0o755)
  return true
}
