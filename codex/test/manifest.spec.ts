import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OPTIONS, codexText } from '../../hooks/core/codex.ts'
import { VERSION } from '../../hooks/core/text.ts'

// The Codex plugin files (Codex design 3.2, 6.5, 6.6): the manifest, the MCP server, the broker wrapper and
// the nine hook handlers. Codex keeps a trust hash per handler, so a change of codex/hooks.json makes people
// trust the hooks again. The pin below stops a change that nobody meant. A change of the file must change
// the pin and add a CHANGELOG line that tells people to trust the hooks again.

const HOOKS_SHA256 = '665f7ca50bcf175bd4623b74511aebee5c5aab53a3b63460dc765ad6098de6ce'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const text = (file: string): string => readFileSync(join(ROOT, file), 'utf8')
const json = (file: string): unknown => JSON.parse(text(file))

type Handler = { type?: unknown; server?: unknown; tool?: unknown; timeout?: unknown; statusMessage?: unknown; input?: Record<string, unknown> }
type Group = { matcher?: unknown; hooks: Handler[] }
type HooksFile = { description?: unknown; hooks: Record<string, Group[]> }

/** Each event, the gate site of its handler, its timeout (s) and its status message. */
const EVENTS: ReadonlyArray<readonly [string, string, number, string | undefined]> = [
  ['SessionStart', 'start', 691200, codexText.statusStart],
  ['UserPromptSubmit', 'prompt', 691200, codexText.statusHold],
  ['PreToolUse', 'tool', 691200, codexText.statusHold],
  ['PostToolUse', 'step', 691200, codexText.statusHold],
  ['PreCompact', 'compact', 691200, codexText.statusHold],
  ['SubagentStart', 'spawn', 60, undefined],
  ['Stop', 'stop', 60, undefined],
  ['SubagentStop', 'stop', 60, undefined],
  ['Interrupt', 'interrupt', 3, undefined],
]

/** The gate input field that each hook placeholder fills (3.3 GateInput). */
const FIELD_OF: Readonly<Record<string, string>> = {
  session_id: 'session',
  turn_id: 'turn',
  transcript_path: 'transcript',
  permission_mode: 'mode',
  model: 'model',
  cwd: 'cwd',
  source: 'source',
  prompt: 'prompt',
  tool_name: 'tool',
  tool_use_id: 'call',
  trigger: 'trigger',
  agent_id: 'agent',
  agent_type: 'agentType',
  stop_hook_active: 'active',
}

test('manifest: .codex-plugin/plugin.json has the fields of design 3.2', () => {
  assert.deepEqual(json('.codex-plugin/plugin.json'), {
    name: 'spare10',
    version: VERSION,
    description:
      'Keeps the last part of your 5-hour and weekly Codex quota for you. At the reserve, spare10 holds all work and asks you whether to continue. After a Resume, it asks again at the floor. Shortly before the reset, it lets work use the reserve.',
    keywords: ['quota', 'rate-limit', 'circuit-breaker'],
    hooks: './codex/hooks.json',
    mcpServers: './codex/mcp.json',
    interface: {
      displayName: 'spare10',
      shortDescription: 'Quota circuit breaker for Codex',
      developerName: 'Chris Nesbitt-Smith',
      category: 'Productivity',
      websiteUrl: 'https://github.com/chrisns/spare10-mod',
    },
  })
})

test('manifest: .claude-plugin/marketplace.json names both hosts (6.1), since Claude Code and Codex both read it', () => {
  assert.deepEqual(json('.claude-plugin/marketplace.json'), {
    name: 'spare10',
    description: 'spare10: a quota circuit breaker for Claude Code and Codex.',
    owner: { name: 'Chris Nesbitt-Smith' },
    plugins: [
      {
        name: 'spare10',
        source: './',
        description: 'Keeps the last part of your 5-hour and weekly quota for you. At the reserve, spare10 holds all work and asks you whether to continue.',
      },
    ],
  })
})

test('manifest: codex/mcp.json equals design 3.2, and passes every option variable, the test guard and no consent variable', () => {
  const envVars = [
    'CODEX_HOME', 'CODEX_SESSION_ID',
    'SPARE10', 'SPARE10_RESERVE', 'SPARE10_WEEKLY_RESERVE', 'SPARE10_LAST_MINUTES', 'SPARE10_WEEKLY_LAST_HOURS',
    'SPARE10_RESUME_FLOOR', 'SPARE10_WEEKLY_RESUME_FLOOR', 'SPARE10_PAUSE_PROMPT', 'SPARE10_AUTO_RESUME',
    'SPARE10_HEADLESS', 'SPARE10_SIMULATE', 'SPARE10_CODEX_DEBUG', 'SPARE10_CODEX_TEST',
  ]
  assert.deepEqual(json('codex/mcp.json'), {
    mcpServers: {
      spare10: {
        command: '/bin/sh',
        args: ['./codex/bin/broker.sh'],
        cwd: '.',
        required: true,
        startup_timeout_sec: 30,
        tool_timeout_sec: 691200,
        env_vars: envVars,
      },
    },
  })
  for (const o of OPTIONS) assert.ok(envVars.includes(o.env), `${o.env} reaches the broker`)
  // D10: Codex gives a stdio MCP server only a few names of its own env plus `env_vars` (rmcp-client
  // create_env_for_mcp_server), and a name reaches it only when it is set. So the test guard of every spec,
  // E2E run and live check reaches the brokers that Codex starts, and a person's session never has it.
  assert.ok(envVars.includes('SPARE10_CODEX_TEST'), 'the test guard reaches the broker')
  for (const name of ['SPARE10_CONSENT', 'SPARE10_WEEKLY_CONSENT', 'SPARE10_STOPPED', 'SPARE10_CODEX_DATA']) {
    assert.ok(!envVars.includes(name), `${name} never reaches the broker`)
  }
})

test('manifest: codex/bin/broker.sh is an executable POSIX sh script that runs ./codex/dist/spare10.mjs', () => {
  const file = 'codex/bin/broker.sh'
  assert.equal(statSync(join(ROOT, file)).mode & 0o755, 0o755)
  const sh = text(file)
  assert.ok(sh.startsWith('#!/bin/sh\n'))
  assert.match(sh, /exec "\$n" \.\/codex\/dist\/spare10\.mjs/)
  assert.match(sh, /process\.versions\.node\.split\("\."\)\[0\] >= 20/)
  assert.match(sh, /^echo "spare10: no Node\.js 20 or later found\. .*" >&2\nexit 1\n$/m)
})

test('manifest: codex/bin/broker.sh tries the nvm versions newest first, by the version numbers only (CX-R6)', (t) => {
  const m = /^(nvm_nodes\(\) \{.*\})$/m.exec(text('codex/bin/broker.sh'))
  assert.ok(m !== null, 'broker.sh has the nvm_nodes function on one line')
  // A 'v' in the home folder and in the version folders: only the numbers of the version folder count.
  const home = join(mkdtempSync(join(tmpdir(), 's10v')), 'dave v1')
  t.after(() => rmSync(dirname(home), { recursive: true, force: true }))
  const versions = ['v20.1.0', 'v9.0.0', 'v22.19.0', 'v24.21.0', 'v22.9.0']
  for (const v of versions) {
    mkdirSync(join(home, '.nvm', 'versions', 'node', v, 'bin'), { recursive: true })
    writeFileSync(join(home, '.nvm', 'versions', 'node', v, 'bin', 'node'), '')
  }
  const out = execFileSync('/bin/sh', ['-c', `${m[1]}\nnvm_nodes`], { env: { PATH: '/usr/bin:/bin', HOME: home }, encoding: 'utf8' })
  const node = (v: string) => join(home, '.nvm', 'versions', 'node', v, 'bin', 'node')
  assert.deepEqual(out.split('\n').filter((l) => l !== ''), ['v24.21.0', 'v22.19.0', 'v22.9.0', 'v20.1.0', 'v9.0.0'].map(node))
  // No nvm folder: nothing.
  assert.equal(execFileSync('/bin/sh', ['-c', `${m[1]}\nnvm_nodes`], { env: { PATH: '/usr/bin:/bin', HOME: dirname(home) }, encoding: 'utf8' }), '')
})

test('manifest: codex/hooks.json has the nine gate handlers of design 3.2', () => {
  const file = json('codex/hooks.json') as HooksFile
  assert.deepEqual(Object.keys(file).sort(), ['description', 'hooks'])
  assert.deepEqual(Object.keys(file.hooks), EVENTS.map(([event]) => event))
  for (const [event, site, timeout, status] of EVENTS) {
    const groups = file.hooks[event] ?? []
    assert.equal(groups.length, 1, event)
    const group = groups[0] as Group
    assert.equal(group.matcher, undefined, `${event}: no matcher, so every tool and every source`)
    assert.equal(group.hooks.length, 1, event)
    const h = group.hooks[0] as Handler
    assert.equal(h.type, 'mcp_tool', event)
    assert.equal(h.server, 'spare10', event)
    assert.equal(h.tool, 'gate', event)
    assert.equal(h.timeout, timeout, event)
    assert.equal(h.statusMessage, status, event)
    const input = h.input ?? {}
    assert.equal(input.site, site, event)
    for (const [field, value] of Object.entries(input)) {
      if (field === 'site') continue
      const m = /^\$\{([a-z_]+)\}$/.exec(String(value))
      assert.ok(m !== null, `${event}.${field} is one whole placeholder, so it keeps its JSON type`)
      assert.equal(FIELD_OF[m[1] as string], field, `${event}.${field} takes \${${m[1]}}`)
    }
    assert.equal(input.session, '${session_id}', event)
    assert.equal(input.model, '${model}', event)
    assert.equal(input.cwd, '${cwd}', event)
    assert.equal(input.transcript, '${transcript_path}', event)
    assert.equal('turn' in input, event !== 'SessionStart', `${event}: a turn id, except at the start`)
    assert.equal('mode' in input, event !== 'PreCompact', `${event}: a permission mode, except at a compaction`)
  }
})

test('manifest: no handler names ${agent_id} outside SubagentStart and SubagentStop', () => {
  const file = json('codex/hooks.json') as HooksFile
  for (const [event, groups] of Object.entries(file.hooks)) {
    const names = JSON.stringify(groups).includes('${agent_id}')
    assert.equal(names, event === 'SubagentStart' || event === 'SubagentStop', event)
  }
})

test('manifest: codex/hooks.json matches its pin, so a change asks every person to trust the hooks again (6.5)', () => {
  const sha = createHash('sha256').update(readFileSync(join(ROOT, 'codex/hooks.json'))).digest('hex')
  assert.equal(sha, HOOKS_SHA256, 'codex/hooks.json changed: update the pin and add a CHANGELOG line to trust the hooks again')
})

test('manifest: the three versions are equal (6.6)', () => {
  const claude = (json('.claude-plugin/plugin.json') as { version?: unknown }).version
  const codex = (json('.codex-plugin/plugin.json') as { version?: unknown }).version
  assert.equal(claude, VERSION)
  assert.equal(codex, VERSION)
  assert.match(text('hooks/core/text.ts'), new RegExp(`export const VERSION: string = '${VERSION.replace(/\./g, '\\.')}'`))
})

test('manifest: every codex --version of the scripts runs in a throwaway CODEX_HOME, never in ~/.codex (D10)', () => {
  // Even `codex --version` makes a folder in $CODEX_HOME/tmp/arg0.
  for (const file of ['scripts/check.sh', 'codex/e2e/run.sh']) {
    const lines = text(file).split('\n').filter((l) => /\bcodex --version\b/.test(l) && !l.trimStart().startsWith('#') && !l.includes('echo '))
    assert.ok(lines.length > 0, `${file} checks the Codex version`)
    for (const l of lines) assert.match(l, /CODEX_HOME="\$vhome" codex --version/, `${file}: ${l.trim()}`)
  }
  assert.match(text('codex/e2e/home.mjs'), /spawnSync\(codex, \['--version'\], \{ encoding: 'utf8', env: \{ \.\.\.process\.env, HOME: home, CODEX_HOME: home \} \}\)/)
})
