// Registers host-hooks.mjs, so every import of hooks/core/host.ts gets the Codex words, as in the bundle.
// Run the specs with: node --import ./codex/test/host-loader.mjs --test codex/test/*.spec.ts
import { register } from 'node:module'

register('./host-hooks.mjs', import.meta.url)
