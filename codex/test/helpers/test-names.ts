import { readFileSync } from 'node:fs'

// The names of the tests of a test file, as its source writes them: test('...'), test("...") or test(`...`).
// A template keeps its ${...} parts as written, with any quotes and backticks inside them. The kit port
// (kit-port.spec.ts) keys each tests/kit case by this name, and finds each Codex case by a part of it.

export function testNames(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const out: string[] = []
  const re = /(^|\n)\s*(?:test|it)(?:\.skip|\.only)?\(\s*(['"`])/g
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const quote = m[2]
    let name = ''
    let i = re.lastIndex
    for (; i < src.length; i += 1) {
      const c = src[i] ?? ''
      if (c === '\\') {
        name += src[i + 1] ?? ''
        i += 1
        continue
      }
      if (quote === '`' && c === '$' && src[i + 1] === '{') {
        let depth = 0
        for (; i < src.length; i += 1) {
          const d = src[i] ?? ''
          name += d
          if (d === '{') depth += 1
          else if (d === '}') {
            depth -= 1
            if (depth === 0) break
          }
        }
        continue
      }
      if (c === quote) break
      name += c
    }
    out.push(name)
  }
  return out
}
