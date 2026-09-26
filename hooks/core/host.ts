// The words that differ between hosts (Codex design 2.1). Pure: it imports nothing.
// A core text names a host word only through HOST, so each host renders its own words.

/** The words that differ between hosts. The Codex bundle swaps this file for codex/src/host.ts. */
export type Host = {
  name: string // the host, as texts say it
  command: string // the command a person types at an idle prompt
  anytime: string // the command a person runs at any time, also during a turn
  config: string // where options come from, in the report: 'from {config}'
  child: string // the report label of nested unattended runs, 15 characters at most
  resume: string // the command that picks up an unattended run, before its id
  keepOpen: string // the end of 'To keep a reserve until the reset, {keepOpen}.'
  backIt: string // what Stop here does with a held prompt, tell mode
  backPrompt: string // what Stop here does with a held prompt, hold mode
  blind: string // the blind phase detail, first sentence
  leadSimulate: string // the first words of the bad simulate reply
  leadFailed: string // the first words of the failed command reply
  stoppedAgent: string // the RESUME_TAIL sentence about a subagent that did not finish
  dialog: string // the name of the question in the asking phase line
  optIn: string // the guarded row hint under scope opt-in
  unreadSource: string // what spare10 could not read when a span source is 'unread'
}

export const HOST: Host = {
  name: 'Claude Code',
  command: '/spare10',
  anytime: '/spare10',
  config: '/config',
  child: 'claude -p',
  resume: 'claude --resume',
  keepOpen: 'set its Open reserve option to 0 in /config',
  backIt: 'gives it back to you',
  backPrompt: 'gives your prompt back',
  blind: 'Claude Code reports no 5-hour quota.',
  leadSimulate: '/spare10 simulate',
  leadFailed: '/spare10',
  stoppedAgent: 'A subagent whose result says "spare10: work stopped" or "spare10: the user stopped work" did not finish.',
  dialog: 'dialog',
  optIn: 'Start with SPARE10=on to guard a run.',
  unreadSource: 'the env',
}
