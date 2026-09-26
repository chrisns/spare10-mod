# spare10-mod

spare10 (https://github.com/alesdi/spare10) re-invented as a Claude Code mod: a plugin with a function-hooks module.
It targets Claude Code 2.1.281 and later (tested on 2.1.282), where function hooks are early access (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`).

- The repo root is the plugin root and a one-plugin marketplace (`.claude-plugin/`).
- `hooks/register.tsx` is the only file that uses `$`. Every hook and every function that gets `$` lives there.
- `hooks/core/*.ts` is pure. It never names `$`, and imports only types from `claude-code` and other core files.
- `hooks/core/text.ts` holds every text that a person or the model reads in both hosts. `hooks/core/codex.ts` holds the texts that only Codex shows.
- The engine puts `spare10: ` in front of each transcript line (`$.ui.log` without `to`) and each `command.run` reply. So never start those texts with `spare10`. Model texts, drop reasons and debug lines keep their own `spare10: `. A pure test and a kit test guard this.
- `SPARE10_CONSENT` (the 5-hour window) and `SPARE10_WEEKLY_CONSENT` (the weekly window) are `<session id> <iso>` or `<session id> <iso> to:<pct>`. The first is a full consent, until the reset. The second is a consent to the floor. A value from 0.2 has no `to` and is full. A junk `to` is no consent (fail closed). The process env reaches every descendant, also the `claude daemon` of `--bg` sessions. An attended session takes only its own stamp. A Resume on a test reading never goes into the env.
- A Resume at the reserve consents to the floor (`resumeFloor`, `weeklyResumeFloor`, default 5). The consent applies while the reading (live or the higher test reading) is below `min(to, 100 - floor)`. Then spare10 holds and asks again, and a second Resume consents until the reset. `splitOf` ends a consent to the floor for good when its own basis reaches its point (B52): the slot at once, the env value by compare-and-set. A floor of 0, a floor at or above its reserve, and an unattended run have no floor in force. The told set keys each loop per stage (`:floor`).
- Safety rule for an attended session in hold mode: a reserve is spent only in three cases. These are an explicit Resume for its stage, an actual reset, and the skip window of that window. No work runs past the floor without a second Resume. Skip wins over the floor.
- A strictly higher `/spare10 simulate` value without `in` raises the test reading in place and keeps its answers. The same value, a lower value or `in` starts a new test.
- `SPARE10_STOPPED` is `<session id> <untilMs> <atMs> <tags>`. The tags are a comma list of kinds (`five_hour`, `seven_day`) and `work`, `auto`, `test`, `skip`, then the real tags. `skip` means that the until is a skip start: no margin. A 0.1 value (three tokens) still stops the 5-hour window, and never continues or extends.
- A real tag is `real_<kind>:<resetMs>` (TS1): the real reading of that kind was in the reserve when the stop took the kind, and `resetMs` is its reset then, the identity of its window. A bare `real_<kind>` (or `:0`) has an unknown reset. Only a `skip` or `test` stop writes them. A stop holds past its until while such a kind's real reading gates with a reset less than half a window from `resetMs`, or either reset is unknown. `atMs` plays no part. An extension writes the current reset of each gating kind. A merge keeps the later window per kind and drops a tag whose reset has passed.
- A kind in the last `lastMinutes` or `weeklyLastHours` before its reset is open. An open kind never gates, and no stop holds it. A kind with no reset time is never open. The spans come from the newest copy (`$.spare10.spans()`), and are 0 when that call or the env read fails.
- The kit world runs the shipped spans (20 min, 8 h). The reset-path kit files pass `spans: 'off'` to `world()`. So does a test that must keep the reset timing past a skip start.
- The kit world runs the shipped floors (5, 5). Twelve 0.2 kit files import `world02 as world` (floors off). The five stop files run the shipped floors. A test there takes `floors: 'off'` only for a text or value that the floor changes by design.
- Arm timers only from `session.start` (the ticker and its watch timer), from those two timers, or from the watchdog in `session.measure` and `ui.render`. A timer armed in a gate can die with its dispatch and shares its turn hold. The only other timers are `restoreDraft`, the `session.end` redraws and the badge pulse (`$.clock.every` in `ui.render`).
- A hold parks first and reads `next.budget` on each cycle (B40).
- Tests: `tests/core` (pure), `tests/kit` (through the engine), helpers in `tests/helpers` (never `*.test.ts`).
- Check: `scripts/check.sh` (validate twice, `claude plugin test .`, tsc from package-lock.json, then the Codex checks: `scripts/versions.mjs`, `build-codex.mjs --check`, `tsc -p codex`, `node --test codex/test/*.spec.ts`). It must pass before a commit.
- Once per Claude Code version, run `claude -p "/plugin-types"` first. It is local and makes no model request.
- Static rules the engine enforces at load: docs/develop.md, "Rules the engine enforces". Obey them all.
- No `setTimeout`, `console` or `$.state`, in `hooks/` or `tests/`. Use `$.clock`, `$.ui.log` and `w.clock.settle()`.
- Live checks for a person or a tmux-driven agent: `docs/live-checks.md`. Record each result there.
- Write all prose (README, docs, CHANGELOG) in ASD-STE100: one idea per sentence, 20 words at most, active voice.
- Never use an em-dash or an en-dash anywhere: code, comments, docs or tests. No semicolons in user-facing prose.
- Add a line under `[Unreleased]` in CHANGELOG.md for each user-facing change.
- Keep this file in `.claude/`. A `CLAUDE.md` at the plugin root makes `validate --strict` fail with a warning.

## Codex

- The repo is also a Codex plugin: `.codex-plugin/plugin.json`, `codex/hooks.json`, `codex/mcp.json`, `codex/bin/broker.sh`. Codex never reads `hooks/hooks.json`.
- `hooks/core/flow.ts` holds the host-free steps of the Claude hooks. `register.tsx` and `codex/src` both call it. Put a new decision step there, not in `register.tsx`.
- `codex/src/*.ts` is the Codex adapter. It is the only code that talks to Codex, the files and the daemon socket. It may use Node built-ins, and Node timers through its Clock seam. The "no setTimeout" rule is for the Claude hooks and tests.
- `hooks/core/host.ts` holds the words that differ between hosts. The Codex bundle swaps it for `codex/src/host.ts`. Write a host word in a core text only through `HOST`.
- `hooks/core/codex.ts` holds the Codex-only pure rules and texts. `register.tsx` never imports it.
- `codex/dist/` is generated by `npm run build:codex` and committed. `scripts/check.sh` fails when it is stale.
- Keep `VERSION` equal in `hooks/core/text.ts`, `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`. `scripts/versions.mjs` checks it.
- Change `codex/hooks.json` only when you must. Each change makes every person trust the hooks again. Update the pin in `codex/test/manifest.spec.ts` and add a CHANGELOG line.
- Codex tests are `codex/test/*.spec.ts` (node --test), never `*.test.ts`, so `claude plugin test` never collects them. Helpers go in `codex/test/helpers/`. End-to-end runs go in `codex/e2e/`.
- No Codex test reads or writes `~/.codex`, uses an `auth.json`, or sends a request to a real model. `SPARE10_CODEX_TEST=1` makes a slip throw. The owner's Codex quota is nearly used up.
- The prefix rule holds on Codex too: the Codex adapter adds `spare10: ` to each transcript line, warning and command reply. `codex/test/text.spec.ts` guards it with the Codex words.
- Codex live checks: `docs/codex-live-checks.md`. Record each result there.
- Each `tests/kit` case needs a line in `codex/test/kit-port.txt`: the Codex spec that covers it, or why it has no Codex form. `codex/test/kit-port.spec.ts` fails on a missing line.
