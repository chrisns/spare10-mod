// The spare10 type contract (plugin.json "types"). Types only: no import, export-from or reference.

/** The budget-free carrier a held dispatch waits on, and its wake-up (section 4.4 of the design). */
export type Spare10Hold = {
  /** Parks the caller until spare10 wakes its waiters, or until the same waiter parks again. */
  park: (args: { waiter: string }) => Promise<string>
  /** Wakes every waiter parked in the newest copy of spare10. */
  poke: (args: { from: string }) => Promise<string>
  /** The autoResume setting in force: noun calls route to the newest copy of spare10. */
  auto: () => Promise<boolean>
  /** The spans in force: noun calls route to the newest copy of spare10. */
  spans: () => Promise<{ lastMinutes: number; weeklyLastHours: number }>
}

declare module 'claude-code' {
  interface EngineInterface {
    spare10: Spare10Hold
  }
}
