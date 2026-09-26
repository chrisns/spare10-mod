#!/usr/bin/env node
// Makes an isolated Codex home for the end-to-end runs and the live checks (Codex design 8.3, 9.1).
//
// usage: node codex/e2e/home.mjs [--work <dir>] [--keep] [--no-trust]
//
// <work> holds the mock provider (its port file, limits.json and requests.jsonl, see mock_responses.py). The
// home is <work>/home: HOME and CODEX_HOME both point there. The trusted project folder is <work>/project, an
// empty git repo (codex exec runs only in a git repo).
// The home talks only to the mock: its provider and its ChatGPT base URL are the mock, it keeps auth in a
// file and has no auth.json, and it never starts the Codex daemon. The plugin files that ship are staged
// into <work>/stage, a git repo, which the home adds as a local marketplace. Then the home installs
// spare10@spare10 and trusts its nine hooks the way the TUI does: `hooks/list`, then `config/batchWrite`
// over a stdio `codex app-server`. `--no-trust` leaves the hooks untrusted (LCX1 trusts them in the TUI).
// Without `--keep`, the command removes the home, the project and the stage again after it has checked them.
//
// No Codex run here reads or writes ~/.codex: every one gets the env of `codexEnv`, and `guardHome` throws
// for a home under ~/.codex or with an auth.json.

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppServer } from './client.mjs'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The Codex version that the runs are written for (Codex design 6.4). */
export const CODEX_VERSION = 'codex-cli 0.157.0'

/** The plugin files that ship to Codex, relative to the repo root (Codex design 6.1). */
export const SHIPPED = ['.claude-plugin/marketplace.json', '.codex-plugin', 'codex/hooks.json', 'codex/mcp.json', 'codex/bin', 'codex/dist']

/** The id of the plugin, and the prefix of the key of each of its hooks. */
export const PLUGIN_ID = 'spare10@spare10'
export const HOOK_KEY_PREFIX = `${PLUGIN_ID}:codex/hooks.json:`

/** The data dir of the plugin in a home (Codex design 3.9). */
export const dataDir = (home) => join(home, 'plugins', 'data', 'spare10-spare10')

const realCodexHomes = () => {
  const out = new Set([resolve(homedir(), '.codex')])
  try {
    out.add(resolve(userInfo().homedir, '.codex'))
  } catch {
    // No user record: homedir() covers it.
  }
  for (const h of [...out]) {
    try {
      out.add(realpathSync(h))
    } catch {
      // No ~/.codex: its name is enough.
    }
  }
  return [...out]
}

const fold = (p) => (process.platform === 'darwin' ? p.toLowerCase() : p)

/** True when `p` is the real ~/.codex or under it, also through a link. */
export function underRealCodexHome(p) {
  const named = resolve(p)
  let real = named
  try {
    real = realpathSync(named)
  } catch {
    // Not there yet: the name decides.
  }
  return realCodexHomes().some((h) => [named, real].some((x) => fold(x) === fold(h) || fold(x).startsWith(fold(h) + sep)))
}

/** Throws unless `home` is a test home: not under ~/.codex, and with no auth.json. */
export function guardHome(home) {
  if (underRealCodexHome(home)) throw new Error(`e2e: the home ${home} is under ~/.codex`)
  if (existsSync(join(home, 'auth.json'))) throw new Error(`e2e: the home ${home} has an auth.json`)
}

/**
 * Throws unless `codex --version` is the version these runs are for. Even `--version` makes a folder in
 * `$CODEX_HOME/tmp/arg0`, so it runs in a throwaway home, never in ~/.codex.
 */
export function checkCodexVersion(codex = 'codex') {
  const home = mkdtempSync(join(process.env.SPARE10_E2E_TMP || '/tmp', 's10ver-'))
  let r
  try {
    r = spawnSync(codex, ['--version'], { encoding: 'utf8', env: { ...process.env, HOME: home, CODEX_HOME: home } })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  const v = (r.stdout ?? '').trim()
  if (v !== CODEX_VERSION) throw new Error(`e2e: needs ${CODEX_VERSION}, and codex --version says ${JSON.stringify(v || r.error?.message || '')}`)
}

/** The whole env of a Codex run in `home`: no variable of the caller's Codex, OpenAI or spare10 setup leaks in. */
export function codexEnv(home, extra = {}) {
  guardHome(home)
  const keep = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ']
  const env = {}
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k]
  return {
    ...env,
    HOME: home,
    CODEX_HOME: home,
    CODEX_SQLITE_HOME: home,
    SPARE10_CODEX_TEST: '1',
    NO_COLOR: '1',
    ...extra,
  }
}

const tomlString = (s) => JSON.stringify(s)

/** The config.toml of a test home (Codex design 8.3). */
export function configText(port, project) {
  const base = `http://127.0.0.1:${port}`
  return [
    'model = "mock-model"',
    'model_provider = "mock"',
    'approval_policy = "on-request"',
    'sandbox_mode = "read-only"',
    'cli_auth_credentials_store = "file"',
    `chatgpt_base_url = ${tomlString(`${base}/`)}`,
    'check_for_update_on_startup = false',
    '',
    '[features]',
    'daemon_auto_start = false',
    '',
    '[model_providers.mock]',
    'name = "mock"',
    `base_url = ${tomlString(`${base}/v1`)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
    `[projects.${tomlString(project)}]`,
    'trust_level = "trusted"',
    '',
  ].join('\n')
}

const git = (cwd, args) =>
  execFileSync('git', ['-c', 'user.name=spare10 e2e', '-c', 'user.email=e2e@spare10.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })

/** Copies the shipped plugin files of the repo into `stage`, a new git repo with one commit. */
export function stagePlugin(stage, repo = REPO) {
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  for (const rel of SHIPPED) {
    const from = join(repo, rel)
    if (!existsSync(from)) throw new Error(`e2e: ${rel} is missing. Run npm run build:codex first.`)
    cpSync(from, join(stage, rel), { recursive: true })
  }
  chmodSync(join(stage, 'codex', 'bin', 'broker.sh'), statSync(join(repo, 'codex', 'bin', 'broker.sh')).mode & 0o777)
  git(stage, ['init', '-q'])
  git(stage, ['add', '-A'])
  git(stage, ['commit', '-q', '-m', 'spare10 e2e stage'])
  return stage
}

const run = (env, cwd, args) => {
  const r = spawnSync('codex', args, { env, cwd, encoding: 'utf8', timeout: 60000 })
  if (r.status !== 0) throw new Error(`e2e: codex ${args.join(' ')} failed (${r.status ?? r.signal}): ${(r.stderr || r.stdout || r.error?.message || '').trim()}`)
  return r.stdout
}

/** The spare10 hooks of `hooks/list` for `project`, and the warnings. */
export async function listHooks(server, project) {
  const r = await server.request('hooks/list', { cwds: [project] })
  const entry = r.data.find((d) => d.cwd === project) ?? r.data[0]
  return { hooks: (entry?.hooks ?? []).filter((h) => h.key.startsWith(HOOK_KEY_PREFIX)), warnings: entry?.warnings ?? [], errors: entry?.errors ?? [] }
}

/** Trusts every spare10 hook of `project` the way the TUI does (hooks 2): `hooks/list`, then `config/batchWrite`. */
export async function trustHooks(server, project) {
  const { hooks } = await listHooks(server, project)
  if (hooks.length === 0) throw new Error('e2e: hooks/list shows no spare10 hook to trust')
  const value = Object.fromEntries(hooks.map((h) => [h.key, { trusted_hash: h.currentHash }]))
  await server.request('config/batchWrite', {
    edits: [{ keyPath: 'hooks.state', value, mergeStrategy: 'upsert' }],
    filePath: null,
    expectedVersion: null,
    reloadUserConfig: true,
  })
  return hooks.length
}

/**
 * Makes the home `<dir>/home` and the project `<dir>/project` for the mock of `work` (its port file must
 * exist), installs the plugin from `stage` (staged now when absent) and, with `trust`, trusts its hooks.
 */
export async function makeHome({ work, dir = work, stage = join(work, 'stage'), trust = true, log } = {}) {
  const port = readFileSync(join(work, 'port'), 'utf8').trim()
  if (!/^\d+$/.test(port)) throw new Error(`e2e: no mock port in ${join(work, 'port')}`)
  mkdirSync(join(dir, 'home'), { recursive: true })
  mkdirSync(join(dir, 'project'), { recursive: true })
  const home = realpathSync(join(dir, 'home'))
  const project = realpathSync(join(dir, 'project'))
  guardHome(home)
  if (!existsSync(join(project, '.git'))) git(project, ['init', '-q']) // codex exec runs only in a git repo
  writeFileSync(join(home, 'config.toml'), configText(port, project))
  if (!existsSync(join(stage, '.codex-plugin', 'plugin.json'))) stagePlugin(stage)
  const env = codexEnv(home)
  run(env, project, ['plugin', 'marketplace', 'add', realpathSync(stage)])
  run(env, project, ['plugin', 'add', PLUGIN_ID])
  if (trust) {
    const server = AppServer.stdio({ env, cwd: project, log, stderr: log === undefined ? undefined : `${log}.stderr` })
    try {
      await server.initialize()
      await trustHooks(server, project)
    } finally {
      await server.close()
    }
  }
  guardHome(home)
  return { home, project, env, stage, port: Number(port) }
}

/** A new work folder: `$SPARE10_E2E_TMP` (default /tmp, short for the socket path limit), `s10e2e-XXXXXX`. */
export const newWork = () => realpathSync(mkdtempSync(join(process.env.SPARE10_E2E_TMP || '/tmp', 's10e2e-')))

async function main(argv) {
  const args = [...argv]
  const flag = (name) => {
    const i = args.indexOf(name)
    if (i < 0) return false
    args.splice(i, 1)
    return true
  }
  const keep = flag('--keep')
  const noTrust = flag('--no-trust')
  let work
  const wi = args.indexOf('--work')
  if (wi >= 0) {
    work = args[wi + 1]
    args.splice(wi, 2)
  }
  if (args.length > 0 || work === '') {
    process.stderr.write('usage: node codex/e2e/home.mjs [--work <dir>] [--keep] [--no-trust]\n')
    return 2
  }
  checkCodexVersion()
  work = work === undefined ? newWork() : realpathSync(work)
  if (!existsSync(join(work, 'port'))) {
    process.stderr.write(`e2e: start the mock first: python3 codex/e2e/mock_responses.py ${work}\n`)
    return 2
  }
  const made = await makeHome({ work, trust: !noTrust })
  const server = AppServer.stdio({ env: made.env, cwd: made.project })
  try {
    await server.initialize()
    const { hooks, warnings } = await listHooks(server, made.project)
    const trusted = hooks.filter((h) => h.trustStatus === 'trusted').length
    process.stdout.write(`home     ${made.home}\nproject  ${made.project}\nhooks    ${hooks.length} spare10 hooks, ${trusted} trusted, ${warnings.length} warnings\n`)
  } finally {
    await server.close()
  }
  if (!keep) for (const d of [made.home, made.project, made.stage]) rmSync(d, { recursive: true, force: true })
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
      process.exitCode = 1
    },
  )
}
