import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LIMIT_UNREAD } from '../../hooks/core/config.ts'

// Pins of the Claude glue in hooks/register.tsx that no kit case can act out. The kit loads spare10 with
// the defaults of its manifest, so no kit case can set an option. A kit file cannot read a file either.
// Node reads the source here, as kit-port.spec.ts reads tests/kit.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REGISTER = readFileSync(join(ROOT, 'hooks', 'register.tsx'), 'utf8')

test('register.tsx: $.spare10.limit() answers on until the first successful settings read, never the option alone', () => {
  // A copy that started at the option would fail open: before its first read, the newest copy would give
  // the held loops of older copies the /config value, and ignore SPARE10_LIMIT_PAUSE=on (as NO_SPANS, B47).
  assert.equal(LIMIT_UNREAD, true)
  const sets = [...REGISTER.matchAll(/\blimitNow(?::\s*boolean)?\s*=\s*([\w.]+)/g)].map((m) => m[1])
  assert.deepEqual(sets, ['LIMIT_UNREAD', 'eff.limitPause', 'LIMIT_UNREAD'], 'the declaration, the successful settings read, and register()')
  assert.match(REGISTER, /limit: \(\) => Promise\.resolve\(limitNow\)/)
})
