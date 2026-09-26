import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realClock } from '../src/clock.ts'
import { tempDir } from './helpers/tmp.ts'

// The developer scripts: the dependency step of scripts/check.sh, the cleanup of codex/e2e/run.sh with the
// broker that codex/bin/broker.sh starts, and the --only check of codex/e2e/scenarios.mjs. No case here runs
// Codex, npm or a pattern kill: each process that a case stops is one that it started, in its own temp folder.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8')

/** The shell function `name` of `file`: from its `name() {` line to the first line that is only `}`. */
function shellFunction(file: string, name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, 'm').exec(read(file))
  assert.ok(m !== null, `${file} has the function ${name}`)
  return m[0]
}

type Ran = { code: number; stdout: string; stderr: string }

/** Runs `cmd` and gives its exit code and output. The event loop stays free, so Node reaps a child that ends. */
function ran(cmd: string, args: readonly string[], o: { cwd: string; env: Record<string, string> }): Promise<Ran> {
  return new Promise((done) => {
    execFile(cmd, args, { cwd: o.cwd, env: o.env, timeout: 20_000 }, (e, stdout, stderr) => {
      done({ code: e === null ? 0 : typeof e.code === 'number' ? e.code : -1, stdout, stderr })
    })
  })
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('scripts: check.sh runs npm ci when tsc is missing or a dependency file changed, and stops with the npm error when npm ci fails', async (t) => {
  const shasum = ['/usr/bin/shasum', '/bin/shasum'].find((f) => existsSync(f))
  if (shasum === undefined) {
    t.skip('this machine has no shasum')
    return
  }
  const dir = tempDir(t, 's10deps')
  const repo = join(dir, 'repo')
  const bin = join(dir, 'bin')
  const log = join(dir, 'npm.log')
  mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(repo, 'package.json'), '{"devDependencies":{"typescript":"7.0.2"}}\n')
  writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n')
  // A stand-in for npm. It logs each call. With NPM_FAIL it fails as npm ci does when package.json and the
  // lockfile disagree. Else it installs a new node_modules with tsc and esbuild.
  writeFileSync(
    join(bin, 'npm'),
    [
      '#!/bin/sh',
      'echo "$*" >> "$NPM_LOG"',
      'if [ -n "${NPM_FAIL:-}" ]; then echo "npm error the lockfile does not match package.json" >&2; exit 1; fi',
      'rm -rf node_modules && mkdir -p node_modules/.bin && : > node_modules/.bin/tsc && : > node_modules/.bin/esbuild',
      'chmod +x node_modules/.bin/tsc node_modules/.bin/esbuild',
      '',
    ].join('\n'),
  )
  chmodSync(join(bin, 'npm'), 0o755)
  const script = `set -eu\n${shellFunction('scripts/check.sh', 'deps')}\ndeps\necho after`
  const deps = (fail = false): Promise<Ran> =>
    ran('/bin/sh', ['-c', script], { cwd: repo, env: { PATH: `${bin}:/usr/bin:/bin`, NPM_LOG: log, ...(fail ? { NPM_FAIL: '1' } : {}) } })
  const calls = (): number => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l !== '').length : 0)
  const hashFile = join(repo, 'node_modules', '.spare10-lock-hash')

  // No tsc and no esbuild, and npm ci fails: the check stops at once, and the npm error shows.
  let r = await deps(true)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /npm error the lockfile does not match package\.json/)
  assert.equal(r.stdout, '', 'no later step runs')
  assert.equal(readFileSync(log, 'utf8'), 'ci --no-audit --no-fund --loglevel=error\n')
  assert.ok(!existsSync(hashFile), 'a failed install writes no hash')

  // npm ci passes: the check goes on. The next run installs nothing.
  r = await deps()
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, 'after\n')
  assert.equal(calls(), 2)
  r = await deps()
  assert.equal(r.code, 0, r.stderr)
  assert.equal(calls(), 2, 'nothing changed')

  // Only package.json changes, such as a new esbuild pin without npm install: npm ci runs.
  writeFileSync(join(repo, 'package.json'), '{"devDependencies":{"typescript":"7.0.3"}}\n')
  r = await deps()
  assert.equal(r.code, 0, r.stderr)
  assert.equal(calls(), 3, 'package.json changed')

  // Only package-lock.json changes: npm ci runs.
  writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n')
  r = await deps()
  assert.equal(calls(), 4, 'package-lock.json changed')

  // tsc is missing: npm ci runs before the first tsc.
  rmSync(join(repo, 'node_modules', '.bin', 'tsc'))
  r = await deps()
  assert.equal(r.code, 0, r.stderr)
  assert.equal(calls(), 5, 'tsc is missing')

  // A dependency file changed and npm ci fails: the check stops, and the next run tries again.
  writeFileSync(join(repo, 'package.json'), '{"devDependencies":{"typescript":"7.0.4"}}\n')
  r = await deps(true)
  assert.equal(r.code, 1)
  assert.equal(r.stdout, '')
  r = await deps(true)
  assert.equal(r.code, 1)
  assert.equal(calls(), 7)
})

/**
 * What is wrong with the order of `src`, a text of check.sh: deps must be a line of its own, and it must come
 * before the first tsc, `node_modules/.bin/tsc -p .` and `claude plugin validate`. Empty when the order is right.
 */
function depsOrder(src: string): string[] {
  const lines = src.split('\n')
  const call = lines.indexOf('deps')
  if (call < 0) return ['no line is only deps']
  const out: string[] = []
  const firstRun = (step: string): number => lines.findIndex((l) => l.trimStart().startsWith(step))
  for (const step of ['node_modules/.bin/tsc', 'node_modules/.bin/tsc -p .', 'claude plugin validate']) {
    const at = firstRun(step)
    if (at < 0) out.push(`no line runs ${step}`)
    else if (at < call) out.push(`${step} runs before deps`)
  }
  return out
}

test('scripts: check.sh calls deps on a line of its own, before the first tsc and the first validate', () => {
  const src = read('scripts/check.sh')
  assert.deepEqual(depsOrder(src), [])
  assert.ok(src.split('\n').indexOf('deps') > src.split('\n').indexOf('deps() {'), 'the call comes after the function')
  // The same check finds a wrong order in a copy. check.sh itself does not change.
  const lines = src.split('\n')
  const without = lines.filter((l) => l !== 'deps')
  /** The copy with the deps call on the line after the first line that starts with `step`. */
  const movedAfter = (step: string): string => {
    const at = without.findIndex((l) => l.startsWith(step))
    assert.ok(at >= 0, `check.sh runs ${step}`)
    return [...without.slice(0, at + 1), 'deps', ...without.slice(at + 1)].join('\n')
  }
  assert.deepEqual(depsOrder(without.join('\n')), ['no line is only deps'])
  assert.deepEqual(depsOrder(src.replace(/^deps$/m, 'deps || true')), ['no line is only deps'])
  assert.deepEqual(depsOrder(movedAfter('claude plugin validate --strict .')), ['claude plugin validate runs before deps'])
  assert.deepEqual(depsOrder(movedAfter('node_modules/.bin/tsc -p .')), [
    'node_modules/.bin/tsc runs before deps',
    'node_modules/.bin/tsc -p . runs before deps',
    'claude plugin validate runs before deps',
  ])
})

type Broker = { pid: number; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }

/**
 * Starts codex/bin/broker.sh from a plugin copy in `root`/plugin, as Codex does: with the plugin root as its cwd.
 * The bundle is a stand-in that says `ready` and then waits until a signal ends it. Resolves when it is ready.
 */
async function startBroker(t: TestContext, root: string): Promise<Broker> {
  const plugin = join(root, 'plugin')
  mkdirSync(join(plugin, 'codex', 'bin'), { recursive: true })
  mkdirSync(join(plugin, 'codex', 'dist'), { recursive: true })
  copyFileSync(join(ROOT, 'codex', 'bin', 'broker.sh'), join(plugin, 'codex', 'bin', 'broker.sh'))
  writeFileSync(join(plugin, 'codex', 'dist', 'spare10.mjs'), "process.stdout.write('ready\\n')\nsetInterval(() => undefined, 60_000)\n")
  const child = spawn('/bin/sh', ['./codex/bin/broker.sh'], {
    cwd: plugin,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Only this child: the case stops no process by name.
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => child.once('exit', (code, signal) => done({ code, signal })))
  await new Promise<void>((done, fail) => {
    let out = ''
    let err = ''
    const limit = realClock.after(10_000, () => fail(new Error(`broker.sh in ${plugin} was not ready in 10 s. stderr: ${err}`)))
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (s: string) => (err += s))
    child.stdout.on('data', (s: string) => {
      out += s
      if (out.includes('ready\n')) {
        limit.cancel()
        done()
      }
    })
    child.once('exit', (code) => {
      limit.cancel()
      fail(new Error(`broker.sh in ${plugin} ended with ${code} before it was ready. stderr: ${err}`))
    })
  })
  assert.ok(child.pid !== undefined)
  return { pid: child.pid, exited }
}

test('scripts: the cleanup of run.sh stops the broker of its work folder, which broker.sh starts by its full path, and no other broker', async (t) => {
  const dir = realpathSync(tempDir(t, 's10stop'))
  const work = join(dir, 'work')
  // A folder whose name starts with the name of the work folder. Its broker is not under the work folder.
  const other = join(dir, 'workx')
  const mine = await startBroker(t, work)
  const theirs = await startBroker(t, other)

  // broker.sh starts the broker by the full path of its bundle, so the argv of the broker names its install.
  const args = execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(mine.pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).trim()
  assert.ok(args.endsWith(` ${join(work, 'plugin', 'codex', 'dist', 'spare10.mjs')}`), args)

  const r = await ran('/bin/sh', ['-c', `${shellFunction('codex/e2e/run.sh', 'stop_under')}\nstop_under "$1"`, 'sh', work], { cwd: dir, env: { PATH: '/usr/bin:/bin' } })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(await mine.exited, { code: null, signal: 'SIGTERM' }, 'the broker under the work folder got SIGTERM')
  assert.ok(alive(theirs.pid), 'the broker of the other folder still runs')
})

test('scripts: an e2e run with an --only id that no scenario has fails before it starts Codex', async (t) => {
  const dir = tempDir(t, 's10only')
  const work = join(dir, 'work')
  const empty = join(dir, 'empty')
  mkdirSync(work)
  mkdirSync(empty)
  writeFileSync(join(work, 'port'), '1\n')
  // A PATH with no codex: if the id check let a run through, it would stop at the Codex version check.
  const env = { PATH: empty, HOME: dir, SPARE10_CODEX_TEST: '1', SPARE10_E2E_TMP: dir }
  const e2e = (only: string): Promise<Ran> =>
    ran(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', './codex/test/host-loader.mjs', 'codex/e2e/scenarios.mjs', '--work', work, '--only', only], { cwd: ROOT, env })

  // A lowercase id and an id past the last scenario: the run fails and names both. No run reports a pass.
  let r = await e2e('e6,E6,E14')
  assert.equal(r.code, 1)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /^Error: e2e: no scenario has the id "e6", "E14"\. The ids are E1, E2, E3, E4, E5, E5s, E6, .*, E13\.$/m)
  assert.ok(!existsSync(join(work, 'stage')), 'no plugin is staged')

  // Known ids pass the check and reach the Codex version check, which fails here with no codex on PATH.
  r = await e2e('E1,E6')
  assert.equal(r.code, 1)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /^Error: e2e: needs codex-cli /m)
})
