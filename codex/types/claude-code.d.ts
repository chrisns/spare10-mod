// The three claude-code types that hooks/core imports, for the Codex type check only.
// The root tsc checks hooks/core against the real .claude/types, so a drift fails there.
declare module 'claude-code' {
  export type SessionRateLimit = { kind: string; percentUsed: number; resetsAt?: string }
  export type PluginOptions = Readonly<Record<string, string | number | boolean | readonly string[]>>
  export type Settings = Readonly<Record<string, unknown>>
}
