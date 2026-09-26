import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import {
  DATA_NAME,
  findPaths,
  guardTestPath,
  homeFromPath,
  homeFromPluginRoot,
  launcherText,
  parentArgs,
  pluginRootOf,
  shQuote,
  testGuardOn,
  underRealCodexHome,
  writeLauncher,
} from '../src/paths.ts'
import { codexText } from '../../hooks/core/codex.ts'
import { tempDir } from './helpers/tmp.ts'

// Paths, the host process and the launcher (Codex design 3.9), with the test guard of D10. No case here reads
// or writes the real ~/.codex: a case that names it expects the guard to throw first.

const GUARD = { SPARE10_CODEX_TEST: '1' }
const REAL = resolve(homedir(), '.codex')

test('findPaths: CODEX_HOME from the env, and every path below it', (t) => {
  const home = tempDir(t)
  const self = join(home, 'repo', 'codex', 'dist', 'spare10.mjs')
  const p = findPaths({ ...GUARD, CODEX_HOME: home, HOME: join(home, 'me') }, self)
  const data = join(home, 'plugins', 'data', 'spare10-spare10')
  assert.deepEqual(p, {
    codexHome: home,
    data,
    pluginRoot: join(home, 'repo'),
    socket: join(home, 'app-server-control', 'app-server-control.sock'),
    launcher: join(data, 'bin', 'spare10'),
    bin: join(data, 'bin'),
    home: join(home, 'me'),
  })
  assert.equal(DATA_NAME, 'spare10-spare10')
  // The home folder of the texts: HOME, made absolute, else the home of the user.
  assert.equal(findPaths({ ...GUARD, CODEX_HOME: home, HOME: `${join(home, 'me')}/` }, self).home, join(home, 'me'))
  assert.equal(findPaths({ ...GUARD, CODEX_HOME: home }, self).home, resolve(homedir()))
})

test('findPaths: CODEX_HOME from the arg0 folder on PATH, three folders up, also when it is not first', (t) => {
  const home = tempDir(t)
  const arg0 = join(home, 'tmp', 'arg0', 'codex-arg0Ab12Cd')
  const PATH = ['/usr/bin', `${arg0}/`, '/bin'].join(delimiter)
  const p = findPaths({ ...GUARD, PATH }, join(home, 'x', 'codex', 'dist', 'spare10.mjs'))
  assert.equal(p.codexHome, home)
  assert.equal(homeFromPath(['/usr/bin', '/opt/tmp/arg0/other'].join(delimiter)), undefined)
  assert.equal(homeFromPath(undefined), undefined)
})

test('findPaths: CODEX_HOME from the plugin root in the plugin cache', (t) => {
  const home = tempDir(t)
  const root = join(home, 'plugins', 'cache', 'spare10', 'spare10', '0.3.0')
  const p = findPaths({ ...GUARD, PATH: '/usr/bin' }, join(root, 'codex', 'dist', 'spare10.mjs'))
  assert.equal(p.pluginRoot, root)
  assert.equal(p.codexHome, home)
  assert.equal(homeFromPluginRoot('/repo/spare10-mod'), undefined)
  assert.equal(homeFromPluginRoot('/plugins/cache/a/b/c'), '/')
})

test('findPaths: the env wins over PATH, and PATH wins over the plugin root', (t) => {
  const a = tempDir(t, 'a')
  const b = tempDir(t, 'b')
  const c = tempDir(t, 'c')
  const self = join(c, 'plugins', 'cache', 'm', 'p', '1', 'codex', 'dist', 'spare10.mjs')
  const PATH = join(b, 'tmp', 'arg0', 'codex-arg0x')
  assert.equal(findPaths({ ...GUARD, CODEX_HOME: a, PATH }, self).codexHome, a)
  assert.equal(findPaths({ ...GUARD, PATH }, self).codexHome, b)
  assert.equal(findPaths({ ...GUARD }, self).codexHome, c)
})

test('findPaths: a relative CODEX_HOME takes the arg0 folder on PATH, then the plugin root, and only then the cwd (CX-R3)', (t) => {
  // Codex makes a relative CODEX_HOME absolute against its own cwd and never exports that form. The broker
  // runs in the plugin root (codex/mcp.json cwd "."), so the cwd would put the home inside the plugin.
  const home = tempDir(t)
  const arg0 = join(home, 'tmp', 'arg0', 'codex-arg0AbC')
  const cache = join(home, 'plugins', 'cache', 'spare10', 'spare10', '0.3.0')
  const repo = join(tempDir(t, 'repo'), 'spare10-mod')
  const PATH = [arg0, '/usr/bin'].join(delimiter)
  assert.equal(findPaths({ ...GUARD, CODEX_HOME: 'scratch-home', PATH }, join(repo, 'codex', 'dist', 'spare10.mjs')).codexHome, home, 'the arg0 folder')
  assert.equal(findPaths({ ...GUARD, CODEX_HOME: './scratch-home', PATH: '/usr/bin' }, join(cache, 'codex', 'dist', 'spare10.mjs')).codexHome, home, 'the plugin root')
  assert.equal(findPaths({ ...GUARD, CODEX_HOME: 'scratch-home', PATH: '/usr/bin' }, join(repo, 'codex', 'dist', 'spare10.mjs')).codexHome, resolve('scratch-home'), 'the cwd')
  // An absolute CODEX_HOME wins over both, as before, and SPARE10_CODEX_DATA follows the same rule.
  const other = tempDir(t, 'other')
  assert.equal(findPaths({ ...GUARD, CODEX_HOME: other, PATH }, join(cache, 'codex', 'dist', 'spare10.mjs')).codexHome, other)
  assert.equal(findPaths({ ...GUARD, CODEX_HOME: 'scratch-home', SPARE10_CODEX_DATA: join(home, 'd'), PATH }, join(repo, 'codex', 'dist', 'spare10.mjs')).codexHome, home)
})

test('findPaths: with nothing else, $HOME/.codex', (t) => {
  const home = tempDir(t)
  const p = findPaths({ ...GUARD, HOME: home, PATH: '/usr/bin' }, join(home, 'r', 'codex', 'dist', 'cli.mjs'))
  assert.equal(p.codexHome, join(home, '.codex'))
})

test('findPaths: SPARE10_CODEX_DATA sets the data dir and needs an explicit CODEX_HOME, with no fallback', (t) => {
  const home = tempDir(t)
  const data = tempDir(t, 'data')
  const PATH = join(home, 'tmp', 'arg0', 'codex-arg0x')
  const self = join(home, 'r', 'codex', 'dist', 'spare10.mjs')
  assert.throws(() => findPaths({ ...GUARD, SPARE10_CODEX_DATA: data, PATH, HOME: home }, self), /needs CODEX_HOME/)
  const p = findPaths({ ...GUARD, SPARE10_CODEX_DATA: data, CODEX_HOME: home }, self)
  assert.equal(p.data, data)
  assert.equal(p.codexHome, home)
  assert.equal(p.launcher, join(data, 'bin', 'spare10'))
})

test('test guard: SPARE10_CODEX_TEST=1 throws for a CODEX_HOME, data dir or socket under ~/.codex', (t) => {
  const tmp = tempDir(t)
  const self = join(tmp, 'r', 'codex', 'dist', 'spare10.mjs')
  assert.throws(() => findPaths({ ...GUARD, CODEX_HOME: REAL }, self), /SPARE10_CODEX_TEST is set, and the CODEX_HOME/)
  assert.throws(() => findPaths({ ...GUARD, CODEX_HOME: join(REAL, 'sub') }, self), /under ~\/\.codex/)
  assert.throws(
    () => findPaths({ ...GUARD, CODEX_HOME: tmp, SPARE10_CODEX_DATA: join(REAL, 'plugins', 'data', 'x') }, self),
    /the data dir/,
  )
  // No env CODEX_HOME, no arg0 folder, no cache root: the fallback is the real ~/.codex, and the guard stops it.
  assert.throws(() => findPaths({ ...GUARD, HOME: homedir(), PATH: '/usr/bin' }, self), /under ~\/\.codex/)
  assert.throws(() => findPaths({ ...GUARD, PATH: join(REAL, 'tmp', 'arg0', 'codex-arg0z') }, self), /CODEX_HOME/)
  assert.throws(() => guardTestPath(GUARD, 'daemon socket', join(REAL, 'app-server-control', 'app-server-control.sock')), /daemon socket/)
})

test('test guard: a name that only starts like ~/.codex is not under it', () => {
  assert.equal(underRealCodexHome(`${REAL}-other`), false)
  assert.equal(underRealCodexHome(REAL), true)
  assert.equal(underRealCodexHome(join(REAL, 'a', '..', 'b')), true)
  assert.equal(underRealCodexHome(join(REAL, '..', 'elsewhere')), false)
})

test('test guard: a link to the home folder does not hide ~/.codex', (t) => {
  const tmp = tempDir(t)
  const link = join(tmp, 'home-link')
  symlinkSync(homedir(), link)
  assert.equal(underRealCodexHome(join(link, '.codex')), true)
  assert.throws(() => findPaths({ ...GUARD, CODEX_HOME: join(link, '.codex') }, join(tmp, 'r', 'c', 'd.mjs')), /under ~\/\.codex/)
})

test('test guard: on with SPARE10_CODEX_TEST=1 in the env it gets', () => {
  assert.equal(testGuardOn(GUARD), true)
  // The specs run with SPARE10_CODEX_TEST=1 in the process env, so the guard is on for any env here.
  if (process.env.SPARE10_CODEX_TEST === '1') assert.equal(testGuardOn({}), true)
  guardTestPath(GUARD, 'CODEX_HOME', '/tmp/s10-not-home')
})

test('pluginRootOf: two folders above the folder of the running file', () => {
  assert.equal(pluginRootOf('/p/root/codex/dist/spare10.mjs'), '/p/root')
  assert.equal(pluginRootOf('/p/root/codex/src/main.ts'), '/p/root')
})

test('parentArgs: the command line of a process, and an empty line when ps finds none', () => {
  assert.match(parentArgs(process.pid), /node/)
  assert.equal(parentArgs(0), '')
  assert.equal(parentArgs(-5), '')
  assert.equal(parentArgs(99_999_999), '')
})

test('launcher: single quotes around both paths, with each quote escaped', () => {
  assert.equal(shQuote("it's"), `'it'\\''s'`)
  assert.equal(
    launcherText('/opt/node 22/bin/node', "/Users/o'neil/.codex/plugins/cache/spare10/spare10/0.3.0"),
    "#!/bin/sh\nexec '/opt/node 22/bin/node' '/Users/o'\\''neil/.codex/plugins/cache/spare10/spare10/0.3.0/codex/dist/cli.mjs' \"$@\"\n",
  )
})

test('CX19: its ! command and its PATH line run in sh and zsh, under the home folder and with a space, a quote or a $ in the path', (t) => {
  const shells = ['/bin/sh', '/bin/zsh'].filter((s) => existsSync(s))
  for (const at of ['home', 'other'] as const) {
    const root = tempDir(t)
    const home = join(root, 'my home')
    const dir = at === 'home' ? join(home, "it's $x", 'bin') : join(root, "a b'$c", 'bin')
    mkdirSync(dir, { recursive: true })
    const launcher = join(dir, 'spare10')
    writeFileSync(launcher, '#!/bin/sh\necho "ran $1"\n', { mode: 0o755 })
    const hint = codexText.cliHint(launcher, dir, home)
    assert.ok(at === 'other' || !hint.includes(home), `${at}: the hint never names the home folder`)
    const bang = /type !(.+) status in the prompt\./.exec(hint)?.[1] ?? ''
    const line = /add (export PATH=".+:\$PATH") to/.exec(hint)?.[1] ?? ''
    const env = { PATH: '/usr/bin:/bin', HOME: home }
    for (const sh of shells) {
      const args = sh.endsWith('zsh') ? ['-f', '-c'] : ['-c']
      assert.equal(execFileSync(sh, [...args, `${bang} status`], { env, encoding: 'utf8' }), 'ran status\n', `${at} ${sh}: the ! command`)
      assert.equal(execFileSync(sh, [...args, `${line}\nspare10 status`], { env, encoding: 'utf8' }), 'ran status\n', `${at} ${sh}: the PATH line`)
    }
  }
})

test('launcher: written with mode 0755 when its content differs, else left alone', (t) => {
  const home = tempDir(t)
  const p = findPaths({ ...GUARD, CODEX_HOME: home }, join(home, 'root', 'codex', 'dist', 'spare10.mjs'))
  assert.equal(writeLauncher(p, '/usr/local/bin/node'), true)
  assert.equal(readFileSync(p.launcher, 'utf8'), launcherText('/usr/local/bin/node', p.pluginRoot))
  assert.equal(statSync(p.launcher).mode & 0o777, 0o755)
  assert.equal(statSync(p.bin).mode & 0o777, 0o700)
  assert.equal(writeLauncher(p, '/usr/local/bin/node'), false)
  assert.equal(writeLauncher(p, '/opt/node/bin/node'), true)
  assert.match(readFileSync(p.launcher, 'utf8'), /\/opt\/node\/bin\/node/)
})
