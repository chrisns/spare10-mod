import { test, expect } from 'claude-code/testing'
import { FLOW_CASES } from '../helpers/flow-cases.ts'

// hooks/core/flow.ts with the Claude host words: every shared case (Codex design 8.1). The Codex build
// runs the same cases in codex/test/flow.spec.ts with its own words.

test('the shared flow cases are all here', () => {
  expect(FLOW_CASES.length).toBeGreaterThan(60)
  expect(new Set(FLOW_CASES.map((c) => c.name)).size).toBe(FLOW_CASES.length)
})

for (const c of FLOW_CASES) {
  test(c.name, () => {
    c.run((got, want) => expect(got).toEqual(want))
  })
}
