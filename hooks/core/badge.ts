import type { Mode, Phase } from './decide.ts'
import { fmtPct } from './text.ts'

// The footer badge (design B21), one row per phase. No $ here.

export type View = { text: string; color?: 'inactive' | 'success' | 'warning'; pulse: boolean }

/** 'spare10', or 'spare10 (40%)' when the reserve is not 10, plus ' (test)' under a test reading. */
export function badgeLabel(reserve: number, test: boolean): string {
  const label = reserve === 10 ? 'spare10' : `spare10 (${fmtPct(reserve)}%)`
  return test ? `${label} (test)` : label
}

/** The table in B21. Only the tripped row pulses, by swapping its glyph for one space. */
export function badgeView(phase: Phase, i: { reserve: number; test: boolean; mode: Mode; blink: boolean }): View {
  const label = badgeLabel(i.reserve, i.test)
  switch (phase) {
    case 'off':
      return { text: `○ ${label} off`, color: 'inactive', pulse: false }
    case 'blind':
      return { text: '⚠ spare10 quota unavailable', pulse: false }
    case 'waiting':
      return { text: `⧗ ${label}`, color: 'inactive', pulse: false }
    case 'armed':
      return { text: `● ${label}`, color: 'success', pulse: false }
    case 'consented':
      return { text: `⨯ ${label}`, color: 'warning', pulse: false }
    case 'stopped':
      return { text: `■ ${label}: stopped`, color: 'warning', pulse: false }
    case 'asking':
      return { text: `? ${label}: waiting for you`, color: 'warning', pulse: false }
    case 'told':
      return { text: `⏸ ${label}`, color: 'warning', pulse: false }
    case 'reserve':
      return { text: `⚠ ${label}: in the reserve`, color: 'warning', pulse: false }
    case 'tripped': {
      const glyph = i.blink ? '⚠' : ' '
      const what = i.mode === 'tell' ? 'Winding down at next step' : 'Pausing at next step'
      return { text: `${glyph} ${what}`, color: 'warning', pulse: true }
    }
  }
}
