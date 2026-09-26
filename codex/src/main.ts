import { fileURLToPath } from 'node:url'
import { codexDebug } from '../../hooks/core/codex.ts'
import { VERSION } from '../../hooks/core/text.ts'
import { createBroker } from './broker.ts'
import type { Broker } from './broker.ts'
import { realClock } from './clock.ts'
import { udsDaemon } from './daemon.ts'
import { pidAlive } from './files.ts'
import { parentArgs } from './paths.ts'

// The broker entry of the bundle (codex/dist/spare10.mjs, Codex design 3.4, 7.2 main.ts): createBroker with
// the real dependencies, and the shutdown. SIGTERM, SIGINT and stdin EOF answer every held call with its
// refusal, then the process exits 0 within 1.5 s (Codex sends SIGKILL 2 s after SIGTERM). An error that
// nothing caught writes a debug line, and the broker keeps serving. A broker that cannot start (an old
// Node.js, a guard) writes one stderr line and exits 1 before `initialize`, so Codex fails the thread loudly.

/** The broker exits this long after the shutdown starts, whatever still runs. */
const EXIT_MS = 1_500

function start(): void {
  let broker: Broker
  try {
    broker = createBroker({
      input: process.stdin,
      output: process.stdout,
      env: process.env,
      clock: realClock,
      pid: process.pid,
      ppid: process.ppid,
      selfFile: fileURLToPath(import.meta.url),
      parentArgs,
      daemon: (paths) => udsDaemon(paths, VERSION, realClock),
      pidAlive,
      nodePath: process.execPath,
    })
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  }
  const b = broker
  process.on('uncaughtException', (e) => b.log.debug(codexDebug.gateError(`uncaught: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)))
  process.on('unhandledRejection', (e) => b.log.debug(codexDebug.gateError(`unhandled: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)))
  let exiting = false
  const exit = (): void => {
    if (exiting) return
    exiting = true
    realClock.after(EXIT_MS, () => process.exit(0))
    void b.stop().finally(() => process.exit(0))
  }
  process.on('SIGTERM', exit)
  process.on('SIGINT', exit)
  void b.done.then(exit, exit)
}

start()
