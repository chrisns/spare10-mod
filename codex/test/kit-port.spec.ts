import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FLOW_CASES } from '../../tests/helpers/flow-cases.ts'
import { testNames } from './helpers/test-names.ts'

// The kit port (Codex design 8.2): codex/test/kit-port.txt names, for every case of tests/kit, the Codex
// cases that test its behaviour, or why it has no Codex form, or that no Codex case tests it yet (a gap).
// This spec keeps the table complete and true: every kit case has one line, every line names a kit case
// that exists, and every target names exactly one Codex case. The number of gaps is pinned, so a new gap
// is a choice that someone makes on purpose, and a closed one lowers the pin.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const KIT = join(ROOT, 'tests', 'kit')
const TABLE = join(ROOT, 'codex', 'test', 'kit-port.txt')

/** The kit cases that no Codex case tests yet (the `gap:` targets). */
const GAPS = 0

type Row = { name: string; targets: string[]; line: number }
type Table = { reasons: Map<string, string>; aliases: Map<string, string>; files: Map<string, Row[]> }

function parseTable(text: string): Table {
  const t: Table = { reasons: new Map(), aliases: new Map(), files: new Map() }
  let rows: Row[] | undefined
  text.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd()
    if (line === '' || line.startsWith('#')) return
    const def = /^([!@])\s*([A-Za-z0-9]+)\s*=\s*(.+)$/.exec(line)
    if (def !== null) {
      const map = def[1] === '!' ? t.reasons : t.aliases
      assert.ok(!map.has(def[2] ?? ''), `line ${i + 1}: ${def[2]} is defined twice`)
      map.set(def[2] ?? '', def[3] ?? '')
      return
    }
    const section = /^\[(.+)\]$/.exec(line)
    if (section !== null) {
      const file = section[1] ?? ''
      assert.ok(!t.files.has(file), `line ${i + 1}: [${file}] twice`)
      rows = []
      t.files.set(file, rows)
      return
    }
    const at = line.indexOf(' => ')
    assert.ok(at > 0 && rows !== undefined, `line ${i + 1} is not a row of a kit file: ${line}`)
    rows.push({ name: line.slice(0, at), targets: line.slice(at + 4).split(' ; ').map((s) => s.trim()), line: i + 1 })
  })
  return t
}

const table = parseTable(readFileSync(TABLE, 'utf8'))
const kitFiles = readdirSync(KIT).filter((f) => f.endsWith('.test.ts')).sort()

/** The case names of a Codex spec: its tests, and for flow.spec.ts the shared flow cases it runs. */
const specNames = new Map<string, string[]>()
function namesOf(spec: string): string[] {
  let names = specNames.get(spec)
  if (names === undefined) {
    const file = join(ROOT, 'codex', 'test', `${spec}.spec.ts`)
    assert.ok(existsSync(file), `no codex/test/${spec}.spec.ts`)
    names = [...testNames(file), ...(spec === 'flow' ? FLOW_CASES.map((c) => c.name) : [])]
    specNames.set(spec, names)
  }
  return names
}

/** Where one target leads: a Codex case, a reason, or a gap. */
function resolveTarget(target: string, where: string, seen: { aliases: Set<string>; reasons: Set<string> }): 'case' | 'none' | 'gap' {
  let t = target
  if (t.startsWith('@')) {
    const alias = t.slice(1)
    const to = table.aliases.get(alias)
    assert.ok(to !== undefined, `${where}: no alias @${alias}`)
    seen.aliases.add(alias)
    assert.ok(!to.startsWith('@'), `@${alias}: an alias names a target, not another alias`)
    t = to
  }
  if (t.startsWith('none:')) {
    const reason = t.slice('none:'.length)
    assert.ok(table.reasons.has(reason), `${where}: no reason ${reason}`)
    seen.reasons.add(reason)
    return 'none'
  }
  if (t.startsWith('gap:')) {
    assert.ok(t.length > 'gap:'.length + 10, `${where}: a gap says what is not tested`)
    return 'gap'
  }
  const bar = t.indexOf('|')
  assert.ok(bar > 0, `${where}: ${t} is not <spec>|<part of a case name>`)
  const spec = t.slice(0, bar)
  const part = t.slice(bar + 1)
  const hits = namesOf(spec).filter((n) => n.includes(part))
  assert.equal(hits.length, 1, `${where}: "${part}" names ${hits.length} cases of ${spec}.spec.ts: ${JSON.stringify(hits)}`)
  return 'case'
}

test('kit port: every tests/kit file has its section, and every section a kit file', () => {
  assert.deepEqual([...table.files.keys()].sort(), kitFiles)
})

test('kit port: every kit case has exactly one line, and every line names a kit case that exists', () => {
  for (const file of kitFiles) {
    const rows = table.files.get(file) ?? []
    if (rows.some((r) => r.name === '*')) {
      assert.equal(rows.length, 1, `${file}: a * line covers the whole file alone`)
      continue
    }
    const kit = testNames(join(KIT, file))
    assert.equal(new Set(kit).size, kit.length, `${file}: two kit cases with one name`)
    const named = rows.map((r) => r.name)
    const dup = named.filter((n, i) => named.indexOf(n) !== i)
    assert.deepEqual(dup, [], `${file}: cases named twice`)
    assert.deepEqual(named.filter((n) => !kit.includes(n)), [], `${file}: lines for no kit case`)
    assert.deepEqual(kit.filter((n) => !named.includes(n)), [], `${file}: kit cases with no line`)
  }
})

test('kit port: every target names exactly one Codex case, a reason or a gap, and the gaps are pinned', (t) => {
  const seen = { aliases: new Set<string>(), reasons: new Set<string>() }
  const count = { rows: 0, tested: 0, partly: 0, none: 0, gap: 0 }
  const gaps: string[] = []
  for (const [file, rows] of table.files) {
    for (const r of rows) {
      const where = `kit-port.txt:${r.line}`
      assert.ok(r.targets.length > 0 && r.targets.every((x) => x !== ''), `${where}: no target`)
      const kinds = r.targets.map((x) => resolveTarget(x, where, seen))
      count.rows += 1
      if (kinds.includes('gap')) {
        count.gap += 1
        gaps.push(`${file}: ${r.name}`)
      } else if (kinds.every((k) => k === 'none')) count.none += 1
      else if (kinds.includes('none')) count.partly += 1
      else count.tested += 1
    }
  }
  assert.deepEqual([...table.aliases.keys()].filter((a) => !seen.aliases.has(a)), [], 'aliases that no line uses')
  assert.deepEqual([...table.reasons.keys()].filter((r) => !seen.reasons.has(r)), [], 'reasons that no line uses')
  t.diagnostic(`kit port: ${count.rows} lines (a * line counts once): ${count.tested} tested on Codex, ${count.partly} tested but for a Claude-only part, ${count.none} with no Codex form, ${count.gap} gaps`)
  for (const g of gaps) t.diagnostic(`gap: ${g}`)
  assert.equal(count.gap, GAPS, `the pinned number of gaps: ${gaps.join(' | ')}`)
})
