# Changelog

This file records all notable changes to spare10-mod.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-24

The first version.
spare10-mod re-invents spare10 v0.5.0 by Alessandro Diano as a Claude Code mod.
It needs Claude Code 2.1.281 with function hooks, an early access feature.

### Added

- **Hold at the reserve.** At the reserve, spare10 holds every agent loop at its next tool call or model request.
- **One question.** The first held step asks one question in the Claude Code dialog: **Stop here** or **Resume**. All other held steps wait on it.
- **Resume in place.** Each held step continues from the point where it stopped. spare10 then stays quiet until the window resets.
- **Stop here.** spare10 denies held tool calls, refuses held model requests and ends the main turn. The session stays open.
- **No time limit.** The question waits for your answer, also after the window resets.
- **A question at your prompt.** Inside the reserve, spare10 asks before your prompt enters. **Stop here** puts the text back in the prompt box.
- **Tell mode.** With a pause prompt, each loop gets the wind-down instruction once per window, on its next tool result.
- **Unattended runs.** The `headless` option sets the policy for `-p`, SDK, desktop and IDE runs: `off`, `prompt` or `stop`.
- **Child runs.** A guarded session makes the `claude -p` runs that it starts stop at their own trip.
- **Scope.** The `scope` option guards every interactive session, or only runs started with `SPARE10=on`. `SPARE10=off` switches spare10 off for one run.
- **Badge.** A status badge at the right of the prompt footer. The `badge` option switches it off.
- **Commands.** `/spare10` shows the status. `/spare10 resume` and `/spare10 stop` answer from the prompt box.
- **Test reading.** `/spare10 simulate` and `SPARE10_SIMULATE` trip spare10 for tests.
- **Warnings.** spare10 warns about bad per-run values, a function-hooks flag set only in the shell, and question time limits.
- **Shared reading.** A new session starts from the last reading of another session in the same window.
- **Checks.** Pure tests, kit tests, `scripts/check.sh` and the live checks in `docs/live-checks.md`.

- **Background warning.** A `--bg` session with `SPARE10`, `SPARE10_RESERVE` or `SPARE10_PAUSE_PROMPT` in its environment shows a warning. The daemon or a settings file gave it these values.
- **Checks.** New kit tests cover these cases:
  - a late dialog and the hand-off limit
  - a failed agent list and an abandoned held step
  - sense failures and a stale consent read
  - stops from another copy
  - tell mode in a new window
  - prompts from a remote surface

### Fixed before the first release

These fixes came from live checks and a code review before the first release.

- **No double prefix.** Claude Code puts `spare10: ` in front of each notice, warning and `/spare10` reply. spare10 no longer adds a second one.
- **Report header.** The `/spare10` report starts with `version 0.1.0`, so it reads `spare10: version 0.1.0`.
- **Reading line.** The `/spare10` reading line says `resets 14:00 (in 2 h 14 min)`, with `resets` only once.
- **Report columns.** The phase detail and every field value of `/spare10` start in one column.
- **Badge after `/clear`.** A `session.end` hook draws the badge again after `/clear` and an in-session `/resume`. A stop of the ended conversation no longer shows.
- **Late dialog.** A dialog that reaches spare10 after its question is settled is withdrawn. Before, it stayed on the screen, and its answer did nothing.
- **Stop during a crossing.** `/spare10 stop` also settles a question that a loop opened while the stop was written.
- **Hand-off.** A question that is handed on while the only held loop reads the environment is asked again at once.
- **`--settings` flag.** A function-hooks flag in a `--settings` file no longer gives the warning about a flag set only in the shell.
- **Consent stays in its session.** `SPARE10_CONSENT` now starts with the session id. The `claude daemon` inherits the environment, so a background session got the consent of another terminal. An interactive session now takes only its own consent. A `claude -p` run takes any consent that it inherits, for the current window only.
- **Consent on a test reading.** A Resume on a test reading stays in memory and never goes into `SPARE10_CONSENT`. A reload, a new `/spare10 simulate` value or a real trip past the test reading asks again.

### Removed

These parts of spare10 v0.5.0 are not in spare10-mod, because the mod runs inside Claude Code:

- the `spare10 claude` launcher, the stop with `SIGTERM` and the start again with `claude --resume`
- the status-line sensor, the state files and `SPARE10_HOME`
- `spare10 doctor`. Use `/spare10` instead.
- the `--refresh` option, bundle pinning and status-line chaining
- the list of stopped background runs. Use `claude agents` instead.

[Unreleased]: https://github.com/chrisns/spare10-mod/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/chrisns/spare10-mod/releases/tag/v0.1.0
