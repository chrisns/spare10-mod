# Develop spare10-mod

spare10-mod is tested on Claude Code 2.1.281 and 2.1.282.
The types come from the version that you run.
After each update of Claude Code, write the types again and run the checks.

```sh
claude -p "/plugin-types"   # writes .claude/types/. A local command, with no model request.
npm ci                      # installs the TypeScript version in package-lock.json
scripts/check.sh            # or: npm run check
```

Run `claude -p "/plugin-types"` again after each update of Claude Code.
Never commit `.claude/types/`.

`scripts/check.sh` runs four checks for Claude Code.
Then it runs the Codex checks in [Develop for Codex](#develop-for-codex).
All checks must pass before a commit.
These are the four checks for Claude Code:

1. `claude plugin validate --strict .` checks the marketplace file only.
2. `claude plugin validate --strict .claude-plugin/plugin.json` checks the plugin and its hooks module.
3. `claude plugin test .` runs the tests in `tests/`.
4. `tsc`, at the version in `package-lock.json`, checks the types of the hooks and the tests.

## Load the plugin from the repo

To develop, load the plugin from the repo folder.
First disable the installed copy, if you have one:

```sh
claude plugin disable spare10@spare10
claude --plugin-dir .
```

Both copies add the same `$.spare10` noun.
When both load, one of them unloads.

To install from a local clone, give its path to `claude plugin marketplace add`.

## Layout

```
.claude-plugin/plugin.json       the plugin manifest and its options
.claude-plugin/marketplace.json  the one-plugin marketplace
types.d.ts                       the types contract: the $.spare10 noun
hooks/hooks.json                 names the hooks module
hooks/register.tsx               every hook and every $ call
hooks/core/config.ts             pure: options, per-run variables, scope, start-up checks
hooks/core/reading.ts            pure: the readings of both windows, shared seeds, blind count, test readings, hold ends, open times
hooks/core/decide.ts             pure: the decision table, the phase, answers, consent, stopped
hooks/core/text.ts               pure: every text that a person or the model reads in both hosts
hooks/core/badge.ts              pure: the badge view
hooks/core/host.ts               pure: the words that differ between hosts. The Codex bundle swaps it for codex/src/host.ts.
hooks/core/flow.ts               pure: the host-free steps of the hooks. register.tsx and codex/src both call them.
hooks/core/codex.ts              pure: the rules and texts that only Codex uses. register.tsx never imports it.
.codex-plugin/plugin.json        the Codex plugin manifest. Codex reads it before the Claude manifest.
codex/hooks.json                 the nine Codex hooks. Each one calls the gate tool of the spare10 MCP server.
codex/mcp.json                   the spare10 MCP server of each Codex thread (the broker)
codex/bin/broker.sh              starts the broker with the first Node.js 20 or later that it finds
codex/src/*.ts                   the Codex adapter: the only code that talks to Codex, the files and the daemon
codex/dist/spare10.mjs           the broker bundle. npm run build:codex writes it. Commit it.
codex/dist/cli.mjs               the CLI bundle, for spare10 commands from a shell
codex/types/claude-code.d.ts     the claude-code types that hooks/core imports, for the Codex type check
codex/test/*.spec.ts             Codex tests (node --test), also the pure tests of hooks/core/codex.ts
codex/e2e/                       end-to-end runs with the real Codex and a mock provider, with no model request
tests/helpers/world.ts           the kit world beneath the plugin
tests/core/*.test.ts             pure tests
tests/core/flow.test.ts          pure tests of flow.ts, with the cases in tests/helpers/flow-cases.ts
tests/helpers/flow-cases.ts      the flow.ts cases that the Claude and the Codex tests both run
tests/kit/*.test.ts              tests through the engine
tests/kit/weekly.test.ts         kit tests of the weekly window
tests/kit/reset.test.ts          kit tests of an open question at the reset
tests/kit/reset-stop.test.ts     kit tests of a stop at the reset, and of what ends it
tests/kit/headless-wait.test.ts  kit tests of the unattended wait policy
tests/kit/skip.test.ts           kit tests of the reserve that opens near the reset
tests/kit/skip-hold.test.ts      kit tests of held work and questions near the reset
tests/kit/skip-stop.test.ts      kit tests of stops, commands, the badge and the report near the reset
tests/kit/stop-past.test.ts      kit tests of a stop that holds past its end, also after a reload, and of /spare10 stop over a stop
tests/kit/floor.test.ts          kit tests of the resume floor: both questions, stops, the badge, the report and the open reserve
tests/kit/floor-gate.test.ts     kit tests of the floor at each gate: both windows, the options, stops, the open reserve, a pause prompt and unattended runs
tests/kit/floor-state.test.ts    kit tests of the consent value with the floor, the commands, the report, the badge and the test seam
.fixtures/stophook.json          a Stop hook for live check LC3
scripts/check.sh                 runs every check (see Develop)
scripts/build-codex.mjs          bundles codex/src and hooks/core into codex/dist
scripts/versions.mjs             checks that the three version values are equal
docs/claude-code.md              how spare10 works in Claude Code, for users
docs/codex.md                    how spare10 works in Codex, for users
docs/configure.md                scope, options, variables and unattended runs
docs/how-it-works.md             the design, a comparison with spare10, and the known limitations
docs/develop.md                  this page
docs/images/                     the screenshots in the README
docs/live-checks.md              the live checks, as a runbook
docs/codex-live-checks.md        the Codex live checks, as a runbook
.github/workflows/codex.yml      runs the Codex checks on each push and pull request
.claude/CLAUDE.md                notes for Claude Code. Not at the root, where validate --strict warns.
```

## Rules the engine enforces

The engine scans the hooks module when it loads it.
A module that breaks a rule does not load.
`claude plugin validate` finds most of these problems.
`claude plugin test` finds the rest.

1. Put pure logic in `hooks/core/*.ts`. These files never name `$`. They import only types from `claude-code`, and only each other.
2. Put all `$` code in `hooks/register.tsx`. Never pass `$` across an import.
3. Write each `$` call as `$.noun.method(...)` at the call site. Pass `$` only as a plain argument to a top-level function of `register.tsx`.
4. Call `next(e)` or read a member of `next`. Never store `next` or pass it on.
5. Write each registration as `on("<literal event>", ...)`. Register an event only once without a matcher.
6. Chain at most one `.catch` on a registration. Never chain a `.catch` on `engine.create`.
7. Use JSX only in `.tsx` files. Take the tags only from `$.ui.resolve(e)`. Never declare or import `h` or `Fragment`.
8. Never use `setTimeout` or `console`, in hooks or in tests. Use `$.clock`, `$.ui.log` and `w.clock.settle()`.
9. Give a matcher RegExp no `g` or `y` flag and no nested quantifier. Only a load finds these problems.
10. Give `$.env.get` and `$.env.set` a string-literal name.
11. Do not use `$.state`. It gives one snapshot per dispatch.
12. Do not end the name of a test helper in `.test.ts`.

## Live checks

The kit cannot test the dialog, the 10 s host limit or a `--bg` session.
Only a real interactive session can.
The kit acts out a reload with a fresh world and a preset value, as `tests/kit/stop-past.test.ts` does.
A real reload is still a live check.
Run the checks in [docs/live-checks.md](live-checks.md) before each release and after each update of Claude Code.

## Develop for Codex

The Codex plugin is `codex/src/*.ts` plus the shared `hooks/core/*.ts`.
`npm run build:codex` bundles them into `codex/dist/`.
Commit `codex/dist/` with the change.
`scripts/check.sh` fails when it is out of date.

```sh
npm ci
npm run build:codex   # writes codex/dist
npm run test:codex    # node --test, needs Node 22.18 or later
npm run e2e:codex     # codex-cli 0.157.0 with a mock provider, in a temporary CODEX_HOME
```

After the four checks for Claude Code, `scripts/check.sh` runs these Codex checks:

1. `node scripts/versions.mjs` checks that `VERSION` in `hooks/core/text.ts` and the version in both manifests are equal.
2. `node scripts/build-codex.mjs --check` checks that `codex/dist/` is up to date.
3. `tsc -p codex` checks the types of the Codex adapter, its tests and the shared core.
4. `node --test` runs the tests in `codex/test/`, with `SPARE10_CODEX_TEST=1`.

Before these checks, `scripts/check.sh` runs `npm ci` when esbuild is missing.
It also runs `npm ci` when `package-lock.json` changed since the last install.

`codex/test/kit-port.txt` gives each test in `tests/kit` a line.
The line names the Codex test for the same behaviour, or says why Codex has no such behaviour.
`codex/test/kit-port.spec.ts` fails when a test in `tests/kit` has no line.
So when you add a test to `tests/kit`, add its line too.

No Codex test uses your `~/.codex` or makes a request to a real model.
`SPARE10_E2E=smoke scripts/check.sh` also runs the short end-to-end set.
`sh codex/e2e/run.sh --smoke` runs only that set, and `--keep` keeps the work folder with its logs.
A failed run also keeps its work folder.
The work folder is in `/tmp`. Set `SPARE10_E2E_TMP` to use another folder.
Run the checks in [docs/codex-live-checks.md](codex-live-checks.md) before each release and after each update of Codex.
