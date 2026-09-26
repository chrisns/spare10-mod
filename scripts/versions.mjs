// Checks that the three versions are equal (Codex design 6.6): VERSION in hooks/core/text.ts,
// .claude-plugin/plugin.json and .codex-plugin/plugin.json. A difference prints the three values and exits 1.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(resolve(root, file), 'utf8')
const manifest = (file) => {
  try {
    return String(JSON.parse(read(file)).version)
  } catch (e) {
    return `unreadable (${e instanceof Error ? e.message : String(e)})`
  }
}

const found = /export const VERSION: string = '([^']+)'/.exec(read('hooks/core/text.ts'))
const values = [
  ['hooks/core/text.ts VERSION', found === null ? 'not found' : found[1]],
  ['.claude-plugin/plugin.json version', manifest('.claude-plugin/plugin.json')],
  ['.codex-plugin/plugin.json version', manifest('.codex-plugin/plugin.json')],
]
if (found === null || new Set(values.map(([, v]) => v)).size !== 1) {
  process.stderr.write('versions: the three versions differ.\n')
  for (const [name, v] of values) process.stderr.write(`  ${name}: ${v}\n`)
  process.exit(1)
}
