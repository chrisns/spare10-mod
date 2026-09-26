import type { Log } from '../../src/log.ts'

// A log that keeps its lines in memory, for the specs that assert a debug line.

export type MemoryLog = Log & { readonly lines: string[] }

export function memoryLog(): MemoryLog {
  const lines: string[] = []
  return { lines, debug: (line) => void lines.push(line) }
}
