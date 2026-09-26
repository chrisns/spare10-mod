import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { underRealCodexHome } from '../../src/paths.ts'

// A temp folder under os.tmpdir() for one test, removed after it. Never under the real ~/.codex (D10).

export function tempDir(t: TestContext, prefix = 's10'): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`))
  if (underRealCodexHome(dir)) throw new Error(`spare10 test: the temp folder ${dir} is under ~/.codex`)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
