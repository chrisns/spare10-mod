import type { Host } from '../../hooks/core/host.ts'

// The Codex host words (Codex design 2.1). The Codex bundle, and the Codex tests through
// codex/test/host-loader.mjs, use this file in place of hooks/core/host.ts.

export const HOST: Host = {
  name: 'Codex',
  command: 'spare10',
  anytime: '!spare10',
  config: 'spare10 set',
  child: 'codex exec',
  resume: 'codex exec resume',
  keepOpen: 'run spare10 set lastMinutes 0, or spare10 set weeklyLastHours 0',
  backIt: 'drops it',
  backPrompt: 'drops your prompt',
  blind: 'Codex reports no quota windows for this login.',
  leadSimulate: 'simulate',
  leadFailed: 'the command',
  stoppedAgent: 'A subagent that was interrupted, or whose result says "spare10: work stopped", did not finish.',
  dialog: 'form',
  optIn: 'Run codex --no-daemon with SPARE10=on to guard a run.',
  unreadSource: 'config.json',
}
