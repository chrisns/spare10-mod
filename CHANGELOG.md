# Changelog

This file records all notable changes to spare10-mod.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Codex.** spare10 now also runs in the OpenAI Codex CLI 0.157.0. It uses the same repo and marketplace. Install it with `codex plugin marketplace add chrisns/spare10-mod` and `codex plugin add spare10@spare10`. Then trust its hooks in the TUI. It has the same reserves, questions, floor, open reserve, stops and unattended policies.
- **Codex question.** At the reserve, spare10 holds the work and asks one question in a Codex form. The choices are **Stop here** and **Resume**. A subagent's question shows on the main screen.
- **Codex stop.** On the Codex daemon, **Stop here** ends the turns of the session with no model request. spare10 starts a new turn when the reserve opens or after the reset. Without the daemon, spare10 holds the work in place until the stop ends.
- **Codex commands.** Type `spare10`, `spare10 resume`, `spare10 stop`, `spare10 simulate ...`, `spare10 set ...` or `spare10 help` as a prompt. spare10 answers with no model request. During a turn, run them as `!spare10 ...`. This needs the `PATH` line from the README.
- **Codex options.** `spare10 set` changes the options in `config.json` in the Codex plugin data folder. The `SPARE10_*` variables still win.
- **Codex warnings.** spare10 warns when a session runs without the Codex daemon or with approval `never`. It also warns about an unknown app on the daemon, and about opt-in scope on the daemon.
- **Weekly-only plans.** On a plan with only a weekly window, spare10 watches that window. The report says that the plan has no 5-hour window.
- **Luna Reserve.** spare10 lets work on Codex's Luna Reserve model through while Codex uses it.
- **Reset credits.** After a Codex reset credit, an earlier **Resume** does not cover the new window.

### Changed

- **Docs.** The README is much shorter. Its quick start covers Claude Code and Codex. It has Codex screenshots. The details moved to pages in `docs/`.
- **Texts.** The texts take their host words, such as `/spare10` and `Claude Code`, from one place. The Claude Code texts do not change.
- **Marketplace.** The marketplace descriptions name both Claude Code and Codex.

## [0.3.0] - 2026-09-25

### Added

- **Resume floor.** A Resume at the reserve now lasts until the floor. By default the floor is 5% left, which is 95% used. If the window resets first, the Resume ends at the reset. At the floor, spare10 holds all work again and asks a second question. A second Resume lasts until the reset. Stop here at either question works as before. The options Resume floor (%) and Weekly resume floor (%) set the floor of each window. Both are 5 by default, and 0 switches a floor off. `SPARE10_RESUME_FLOOR` and `SPARE10_WEEKLY_RESUME_FLOOR` override them for one run. While a reserve is open near the reset, spare10 asks nothing, also past the floor.
- **Second question.** It has its own wording, such as `Your 5% floor is reached: ... Continue on the last 4% until 14:00?`. If the reading is past the floor when spare10 first asks, only this question shows. The stop notice and the texts for Claude then name the floor.
- **Warnings.** spare10 warns about a floor at or above its reserve, because such a floor does nothing. It also warns about bad `SPARE10_RESUME_FLOOR` and `SPARE10_WEEKLY_RESUME_FLOOR` values. The background warning names these variables too.

### Changed

- **Question.** At the reserve, the question says where the Resume ends, such as `Continue on the reserve until 95% used?`. It also says until when spare10 asks again.
- **Consent.** After a Resume at the reserve, `SPARE10_CONSENT` and `SPARE10_WEEKLY_CONSENT` end with the floor point, such as `to:95`. A value from 0.2 has no floor point, so it lasts until the reset.
- **Consent end.** A Resume at the reserve ends for good at the floor point. If the reading falls again in the same window, spare10 asks again.
- **Badge.** `⨯ spare10: resumed until 95% used` shows while a Resume at the reserve applies.
- **Report.** `/spare10` shows the floors and where they come from. It also shows the end of a Resume at the reserve.
- **Commands.** Before the floor, `/spare10 resume` continues until the floor. Past the floor, it continues until the reset. The reply says which.
- **Pause prompt.** Each agent gets the pause prompt again at the floor, with the floor wording. A prompt that you send before the main loop gets it asks the second question.
- **Test reading.** A higher `/spare10 simulate` value without `in` raises the test reading in place, and your answers stay. So `/spare10 simulate 96` after a Resume at 91% shows the second question. The reply warns you when the real reading is in the reserve too.
- **Unattended runs.** They never ask, so the floor changes nothing there. A `claude -p` run can take a Resume at the reserve from its session. It stops using that Resume at the floor point.

## [0.2.0] - 2026-09-25

### Added

- **Open reserve near the reset.** Shortly before a window resets, spare10 lets all work use its reserve and asks nothing, because the quota refreshes soon. By default this is the last 20 minutes of the 5-hour window and the last 8 hours of the weekly window. Each window has its own time. A weekly trip still holds work in the last 20 minutes of the 5-hour window. The new options Open reserve before 5-hour reset (min) and Open weekly reserve before weekly reset (h) set these times. 0 switches each one off. `SPARE10_LAST_MINUTES` and `SPARE10_WEEKLY_LAST_HOURS` override them for one run. A reading without a reset time keeps the guard.
- **No margin when the reserve opens.** With Continue at the reset on, held and stopped work continues at the time when the reserve opens. spare10 adds no 5-minute margin there, because the reset is still ahead. The question, the stop notice and the badge show that time. With the option off, held work still waits for your answer. When the reserve opens, the transcript says so once. New work then goes on with no question, unless the other window still holds work.
- **Nothing to stop.** While every window in its reserve is open, `/spare10 stop` and `/spare10 resume` change nothing and say that the reserve is open. To keep a reserve until the reset, set its open time to 0.
- **Unattended runs near the reset.** While a reserve is open, every unattended policy lets the work through. A run that must never spend a reserve sets `SPARE10_LAST_MINUTES=0` and `SPARE10_WEEKLY_LAST_HOURS=0`. If spare10 cannot read these variables, it keeps each reserve until the reset.
- **Weekly window.** spare10 also watches the weekly window. The new option Weekly reserve (%) sets its reserve, 10 by default. 0 switches it off. `SPARE10_WEEKLY_RESERVE` overrides it for one run.
- **Continue at the reset.** spare10 continues held work and stopped work by itself. It does this when the reserve of the window that tripped opens, or a few minutes after its reset. A stopped session gets a short resume prompt. The new option Continue at the reset is on by default. `SPARE10_AUTO_RESUME=off` switches it off for one run. A second timer starts the reset timer again if a hook of another plugin stops it.
- **Unattended wait.** The unattended policy `wait` holds a `-p` or SDK run at the reserve. It continues the run when the reserve opens, or at the reset.
- **Test windows.** `/spare10 simulate` takes `weekly` and a short test window, such as `/spare10 simulate 95 weekly in 2m`. `SPARE10_SIMULATE` takes the same words. After the reset of a real reading in the reserve, a test window also waits 5 minutes. A test window has an open time too. `/spare10 simulate 95 in 22m` opens the reserve 2 minutes later, and the reply says when. A test window never opens a reserve while the real reading is in it.
- **Weekly consent.** A Resume on a weekly trip goes into `SPARE10_WEEKLY_CONSENT`. `SPARE10_CONSENT` keeps its form and means the 5-hour window.
- **A prompt after the reset.** A prompt that you send after the reset ends the stop. When the stop held work, the prompt carries a note. The note tells the model to continue the stopped task after your message.
- **Warnings.** spare10 warns about bad `SPARE10_WEEKLY_RESERVE`, `SPARE10_AUTO_RESUME`, `SPARE10_LAST_MINUTES` and `SPARE10_WEEKLY_LAST_HOURS` values, and about a `SPARE10_WEEKLY_CONSENT` after the weekly window. The background warning also names the four new variables.

### Changed

- **Claude Code 2.1.282.** spare10-mod passes all its checks on 2.1.282 too. The README now names the tested versions.
- **Stop here.** With Continue at the reset on, Stop here stops the work until the reserve opens, or until the reset. The question and the notice say so. With Continue at the reset off, a Stop here ends when the reserve opens. A later Stop here keeps the work of an earlier stop that spare10 did not continue yet. The notice and the `/spare10 stop` reply promise to continue the work only when the stop holds work.
- **Long holds.** A hold that lasts too long for one hook ends as Stop here. Before, it let the work through.
- **Badge.** A stopped session shows the time when the stop ends: `■ spare10: stopped until 14:40`. A new row `↻ spare10: reserve open until 15:00` shows while a reserve is open.
- **Report.** `/spare10` shows the weekly reserve, the weekly reading, the weekly consent and what happens at the reset. It also shows the open times and where they come from. It has a new phase `open`. Times more than a day away show days.
- **Child runs.** A guarded session also gives its `claude -p` children `SPARE10_HEADLESS=stop` when its own policy is `wait`.
- **Stop record.** `SPARE10_STOPPED` has a new form. The tag `skip` marks a stop that ends when the reserve opens. The tags `real_five_hour` and `real_seven_day` mark a real reading that was in the reserve when the stop took that window. Each tag keeps the reset time of that reading, such as `real_five_hour:1790262000000`. A tag with no time has an unknown reset time. A value from 0.1 still stops, and never continues by itself. It holds no work while a reserve is open.
- **Unanswered question.** With Continue at the reset on, spare10 closes an unanswered question when the reserve opens or shortly after the reset. Held work then continues, unless a reserve is still reached. Before, the question waited with no time limit.
- **Question time limits.** With Continue at the reset on, the warning says that spare10 continues the work at the time in the question.
- **A stop that ends too early.** A test window can end over a real reading in the reserve. You can also lower an open time after a stop. If the stop then ends while its window still holds work, the stop continues to hold. This also applies with a pause prompt. spare10 refuses the calls of Claude, and a prompt asks you first. With Continue at the reset on, spare10 extends the stop at its next check. The extension stops each window that is in its reserve then, also a window that started after the stop. With Continue at the reset off, the stop holds until the reserve of that window opens, or until the reset. `/spare10 resume` ends it and continues on the reserve. `/spare10 stop` keeps it. The stop holds only while the real reading is in the reserve, in the window of the stop. A stop takes a window when you choose it, when spare10 extends it, or at a later `/spare10 stop`. spare10 knows the window from the reset time in the stop record. So the stop still holds after a plugin reload or a change of an open time. A trip in a later window asks again, and so does a later trip. With a pause prompt, spare10 tells Claude again.
- **`/spare10 stop` after the end of a stop.** A stop can be past its end before spare10 continues it. If a window is in its reserve then, `/spare10 stop` stops that window at once, also with a pause prompt. The new stop keeps the stopped work of the old stop. During a stop, `/spare10 stop` adds each window that reached its reserve after the stop. The reply names a reset or an open reserve only when one came.

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

[Unreleased]: https://github.com/chrisns/spare10-mod/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/chrisns/spare10-mod/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/chrisns/spare10-mod/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/chrisns/spare10-mod/releases/tag/v0.1.0
