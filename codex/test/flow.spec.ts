import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FLOW_CASES } from '../../tests/helpers/flow-cases.ts'

// hooks/core/flow.ts with the Codex host words: every shared case (Codex design 8.2 flow.spec). The Claude
// kit runs the same cases in tests/core/flow.test.ts with the Claude words. A case builds its expected
// texts with the same core text functions, so each host checks its own words.

test('the shared flow cases are all here', () => {
  assert.ok(FLOW_CASES.length > 60)
  assert.equal(new Set(FLOW_CASES.map((c) => c.name)).size, FLOW_CASES.length)
})

for (const c of FLOW_CASES) {
  test(c.name, () => {
    c.run((got, want) => assert.deepStrictEqual(got, want))
  })
}
