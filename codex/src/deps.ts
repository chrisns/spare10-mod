import type { Clock } from './clock.ts'
import type { Log } from './log.ts'
import type { Paths } from './paths.ts'
import type { Wake } from './wake.ts'

// The dependencies that most adapter modules take (Codex design 7.2, "Deps"). Each module takes them as
// arguments and keeps no module state, so the specs build any number of brokers in one process. A module
// that needs less names a Pick of this type.

export type Deps = {
  paths: Paths
  clock: Clock
  wake: Wake
  log: Log
  /** The owner name in lock files, such as `broker-4242`. */
  owner: string
  /** The pid of this broker (a fake pid in the specs). */
  pid: number
}
