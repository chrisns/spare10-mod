# Live checks

This runbook lists the checks that only a real interactive session can settle.
The kit (`claude plugin test`) runs the engine in one thread.
It cannot test the dialog on the screen, the 10 s host limit or a real reload.
It acts out a reload with a fresh world and a preset value only.
It cannot run a full `-p` run or a `--bg` session.

Run the checks in tmux, so that an agent can drive the session and read the screen.
Keep the model spend small.
Use the cheapest model and one-line prompts, and use `sleep` to make time windows.

**Release gate.**
LC1, LC2, LC3, LC5, LC4, LC6, LC7 and LC8 must pass before each release.
For 0.2, LC17 to LC24 and LC26 to LC31 must also pass, and LC25 must run once.
For 0.3, LC32 to LC37 must also pass.
LC18b is optional.
LC9 to LC16 are optional or regression checks.

Run the checks in the order of this file.
Each check states the state that it starts from and the state that it leaves.
Record each result in the [results table](#results), with the date and the Claude Code version.

## Settled by the probe

The gatecheck probe is a small test plugin.
It ran these checks in a live session of Claude Code 2.1.281 on 2026-09-24.
Do not run them again for spare10.

- A plugin-noun call has a 10 s limit in the hooks worker. A hold must make the call again after each rejection.
- One dialog holds a parked main loop.
- One dialog holds three parked calls of a background agent, over an idle prompt.
- The question waits behind an open permission dialog, and shows when that dialog closes.
- A withdrawn dialog leaves the screen.
- Esc on the dialog makes `$.ui.ask` reject.
- The first option has the focus.
- Free text returns verbatim.
- `Chat about this` makes `$.ui.ask` reject, the same as Esc.

## The trip seam

A test reading trips spare10 at any time, far from the real reserve.

- `/spare10 simulate {percent}` sets the test reading of the 5-hour window. Only you can run it. It runs at once, also while a turn runs.
- `/spare10 simulate {percent} weekly` sets the test reading of the weekly window.
  The words `5h`, `5-hour`, `five_hour`, `weekly`, `7d` and `seven_day` name a window, in any case.
- `/spare10 simulate {percent} in {n}{s|m|h|d}` sets a test window that ends after that time.
  The time is 10 s at least, and the window length at most.
  A window word and `in` can go together, such as `/spare10 simulate 95 weekly in 2m`.
- Without `in`, the test reading uses the reset time of the live reading of that window.
  Without a live reading, it resets 5 hours from now, or 7 days from now for the weekly window.
- Each window has one test reading.
- `/spare10 simulate off` clears both test readings, both consents and the stop.
- `SPARE10_SIMULATE` at launch takes the same words for a `-p` run, such as `95` or `95 weekly in 2m`.
  spare10 reads it once per load. There, `in` counts from the first gated event.
  It never raises a test reading in place.
- A test reading can only raise the real reading. It never releases a hold that the real reading causes.
- While it applies, `/spare10` shows `test reading`, and the labelled badge rows show `(test)`.
  The rows `⚠ Pausing at next step` and `⚠ Winding down at next step` have no label, so they show no `(test)`.
- A Resume on a test reading stays in spare10's memory.
  It never goes into `SPARE10_CONSENT` or `SPARE10_WEEKLY_CONSENT`.
- A new `/spare10 simulate` value for a window clears the consent and the stop, as `off` does.
- A strictly higher value without `in` raises the test reading in place.
  The test window, the consent and the stop stay.
  So `/spare10 simulate 96` after a Resume at 91 shows the second question.
  The same value again, a lower value or a value with `in` starts a new test.
- A test window has an open time, as a real window has.
  With the default open times, a test window shorter than 20 minutes is open at once.
  For the weekly window, this is a test window shorter than 8 hours.
  `in 22m` opens the reserve 2 minutes later, with no margin. For the weekly window, `in 482m` does the same.
- `simulate 95` without `in` uses the live reset. If that reset is less than 20 minutes away, the reserve is open at once.
- A test reading opens the reserve only when the real reading is below the reserve, or open by itself.
  When the real reading is in the reserve, the work waits until the real reserve opens.
- With an open time of 0, spare10 releases work 60 s after the end of a test window.
  Held work continues within 10 s more. A stop continues within 30 s more.
- When the reserve opens, spare10 adds no margin.
  Held work continues within 10 s. A stop continues within 30 s.

The replies are, as Claude Code shows them:

```
spare10: test reading set to 95% used, resets 14:00. It can only raise the real reading. Run /spare10 simulate off to clear it.
spare10: test reading set to 95% used of the weekly window, resets Thu 14:02. It can only raise the real reading. Run /spare10 simulate off to clear it.
spare10: the weekly reserve is 0, so spare10 does not watch the weekly window. Nothing changed.
spare10: test reading cleared. Consent and stop for this window are cleared too.
spare10: /spare10 simulate takes a percentage from 0 to 100, or off. Add weekly for the weekly window, and in 22m for a test window that resets in 22 minutes.
```

The first two replies are those of the reset start command (see [Setup](#setup)), with open times of 0.
With the default open times, the set reply has one more sentence before `Run /spare10 simulate off to clear it.`:

```
spare10: test reading set to 95% used, resets 14:22. It can only raise the real reading. The reserve opens at 14:02, 20 min before the test window ends. Run /spare10 simulate off to clear it.
spare10: test reading set to 95% used, resets 14:10. It can only raise the real reading. The test window ends within 20 min, so the reserve is open at once. Run /spare10 simulate off to clear it.
spare10: test reading set to 95% used of the weekly window, resets Thu 22:02. It can only raise the real reading. The weekly reserve opens at Thu 14:02, 8 h before the weekly test window ends. Run /spare10 simulate off to clear it.
spare10: test reading set to 95% used, resets 14:22. It can only raise the real reading. The real reading is also in the reserve, so the test window does not open it. A Resume on the test reading also lets real work use the reserve. Run /spare10 simulate off to clear it.
```

A test percentage below the trip point gives no such sentence.
The last reply has the sentence `A Resume on the test reading also lets real work use the reserve.` only when the real reading is below the test reading.

A raise in place has its own reply:

```
spare10: test reading raised to 93% used, resets 14:22. Your earlier answers stay. It can only raise the real reading. The reserve opens at 14:02, 20 min before the test window ends. Run /spare10 simulate off to clear it.
```

With the **floor start command** (see [Setup](#setup)), the default floors apply.
Then a test reading at or past 95% used adds the sentence `This is past your 5% floor.`:

```
spare10: test reading set to 96% used, resets 14:22. It can only raise the real reading. This is past your 5% floor. The reserve opens at 14:02, 20 min before the test window ends. Run /spare10 simulate off to clear it.
spare10: test reading raised to 96% used, resets 14:22. Your earlier answers stay. It can only raise the real reading. This is past your 5% floor. The reserve opens at 14:02, 20 min before the test window ends. Run /spare10 simulate off to clear it.
```

Claude Code puts `spare10: ` in front of each reply and each transcript line of spare10.
spare10 does not write it into these texts itself.
So no line may show `spare10: spare10:`.
The model texts, the dropped-prompt reason and the debug lines carry their own `spare10: `.

## Setup

Do these steps once, before the first check:

```sh
cd spare10-mod                                # the repo root
claude plugin disable spare10@spare10         # if installed: two copies collide on the noun
claude -p "/plugin-types"                     # once per Claude Code version, local, no model request
scripts/check.sh                              # must be green first
tmux new-session -d -s s10 -x 200 -y 50
```

`scripts/check.sh` runs `claude plugin validate --strict .claude-plugin/plugin.json`.
Its hooks line must list these registrations:

```
engine.create, session.start, session.end, session.measure, tool.call, tool.call{tool=/"^AskUserQuestion$"/}, turn.step, prompt.submit, command.run{command=spare10}, ui.render{component=SessionMode}
```

The hooks line did not change in 0.2 or 0.3.
The other lines of the listing must also name these entries, new in 0.2:

- `calls`: `$.prompt.submit`, `$.spare10.auto` and `$.spare10.spans`
- `env reads`: `SPARE10_AUTO_RESUME`, `SPARE10_LAST_MINUTES`, `SPARE10_WEEKLY_CONSENT`, `SPARE10_WEEKLY_LAST_HOURS` and `SPARE10_WEEKLY_RESERVE`
- `env writes`: `SPARE10_WEEKLY_CONSENT`

The `env reads` line must also name `SPARE10_RESUME_FLOOR` and `SPARE10_WEEKLY_RESUME_FLOOR`, new in 0.3.
The `calls` and `env writes` lines did not change in 0.3.

The `session.end` hook redraws the badge after `/clear` and an in-session `/resume` (LC5).

This is the **start command**.
Use it for each new session, unless a check gives a different one:

```sh
: > /tmp/s10.log
tmux send-keys -t s10 'SPARE10_RESUME_FLOOR=0 SPARE10_WEEKLY_RESUME_FLOOR=0 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir . --model haiku --debug-file /tmp/s10.log' Enter
```

This is the **reset start command**.
It sets both open times to 0, so spare10 acts only at the reset.
The checks of the reset path use it:

```sh
: > /tmp/s10.log
tmux send-keys -t s10 'SPARE10_RESUME_FLOOR=0 SPARE10_WEEKLY_RESUME_FLOOR=0 SPARE10_LAST_MINUTES=0 SPARE10_WEEKLY_LAST_HOURS=0 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir . --model haiku --debug-file /tmp/s10.log' Enter
```

Both commands switch the resume floors off.
So the texts of LC1 to LC31 stay as in 0.2, and `/spare10 simulate 95` shows the first question.
Each interactive launch line that LC3 to LC31 spell out also switches the floors off.
The `claude -p` lines stay as they are, because an unattended run has no floor.

This is the **floor start command**.
It keeps the default floors of 5%. LC32 to LC34 use it:

```sh
: > /tmp/s10.log
tmux send-keys -t s10 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir . --model haiku --debug-file /tmp/s10.log' Enter
```

The start command sets the function-hooks flag in the shell on purpose.
So LC1 also sees the warning about a flag that is only in the shell.
Accept the workspace trust prompt if it shows.
To start a new session, type `/exit` in the old session, then send the start command again.

Read the screen and the debug log after each step:

```sh
tmux capture-pane -p -t s10 | tail -40
grep -E 'spare10|hooks worker|hook failed|did not answer|did not settle|overran' /tmp/s10.log | tail -40
```

In the texts below, `HH:MM` is the reset time that the reading or the test window gives.
`ddd HH:MM` is a weekly time, with the short weekday, such as `Thu 14:02`.
`OPEN` is the time when the reserve opens.
With the default open times, it is 20 minutes before a 5-hour `HH:MM`, and 8 hours before a weekly `ddd HH:MM`.

## Release gate checks

**Precondition of LC2 to LC8.**
`/spare10 simulate 95` uses the reset time of the live reading.
So the `reading` row of `/spare10` must show the 5-hour reset more than 40 minutes away.
Check this before LC2, LC3, LC7 and LC8.
The same applies to the optional checks that trip as in LC2.
Else the test reading opens during the check, or is open at once, and spare10 does not ask.
Wait for the reset, or use the reset start command.
With the reset start command, the texts have `HH:MM` where these checks show `OPEN`, and no `20 min before` part.

### LC1 Load and command

**Start:** a new session from the start command. No test reading is set.

**Steps:**

1. Type `/spare10`.
2. If the reading line says `none`, send `Reply with the word ok.` Then type `/spare10` again.

**Expected:**

- The status report prints. Its first line is `spare10: version 0.3.0`.
- No line of the report and no transcript line shows `spare10: spare10:`.
- The phase detail and every field value start in one column.
- The report shows the rows `weekly reserve`, `at the reset`, `weekly reading` and `weekly consent`.
- The report shows `reserve opens  in the last 20 min of the 5-hour window (from /config)`.
- The report shows `weekly opens   in the last 8 h of the weekly window (from /config)`.
- The `at the reset` row reads `continue by itself (from /config)`.
- The report shows `resume floor   off. A Resume lasts until the reset (from SPARE10_RESUME_FLOOR)`.
- The report shows `weekly floor   off. A Resume lasts until the weekly reset (from SPARE10_WEEKLY_RESUME_FLOOR)`.
- The last lines include `/spare10 resume   continue on the reserve until the window resets`.
- In the `● armed` phase, the detail reads `spare10 steps in at 90% used, or at 90% used of the weekly window.`
- The reading line reads `live · NN% used · NN% left · resets HH:MM (in D)`. The word `resets` shows only once.
- The report shows this warning, unless a settings file or a `--settings` file already sets the flag:
  `⚠ function hooks are on only in this shell. Background sessions and pane teammates start without spare10. Put CLAUDE_CODE_ENABLE_FUNCTION_HOOKS in the env block of ~/.claude/settings.json.`
- At the start, the transcript shows the same warning once, as `spare10: function hooks are on only in this shell. ...`.
- The badge shows at the right of the footer: `⧗ spare10` or `● spare10`.
- The debug log has `hooks module spare10@inline loaded (worker`.
- The debug log has `$.command.register (spare10): /spare10 listed`.
- The debug log shows no second copy of spare10.
- After step 2, the reading line says `live · ...`.
- After step 2, the weekly reading line reads `live · NN% used · NN% left · resets ddd HH:MM (in D)`.
  It has a weekday. `D` shows days when the reset is a day or more away, such as `3 d 21 h`.

**Settles:** the load path, which copy loaded, the footer site and the sensor.

**Leaves:** the session runs, with no test reading and no consent.

### LC2 Hold and Resume

**Start:** the session from LC1, with no test reading and no consent.

**Steps:**

1. Send: `Run these two Bash commands one after the other, not in parallel: sleep 25, then touch /tmp/s10-lc2.`
2. While `sleep` runs, type `/spare10 simulate 95`.
3. Wait until the dialog shows. Then wait 30 s more.
4. Choose Resume.

**Expected:**

- Before the dialog shows, the badge blinks `⚠ Pausing at next step`.
- One dialog shows. Its chip is `spare10`, and `Stop here` is above `Resume`.
- The question has the loop wording:
  `Your 10% reserve is reached: 95% used · 5% left · resets HH:MM. All work is on hold. Continue on the reserve until HH:MM? If you choose Stop here or do not answer, the work waits until OPEN, 20 min before the test window ends. Then spare10 continues it, unless a reserve is still reached.`
- `/tmp/s10-lc2` does not exist while the work is held.
- The debug log has `$.spare10.park ... did not answer within 10000ms` about every 10 s.
- The debug log has no `exceeded 10000ms budget` and no `hook failed`.
- After Resume, `/tmp/s10-lc2` exists.
- The badge shows `⨯ spare10 (test)`.
- The transcript shows `spare10: continuing on your 10% reserve. spare10 stays quiet until HH:MM.`, with `spare10: ` only once.
- `SPARE10_CONSENT` stays unset, because a Resume on a test reading stays in spare10's memory. Check it with `! env | grep SPARE10_CONSENT` in the session: it prints nothing.

**Settles:** the hold of the real plugin, one question, and Resume.

**Leaves:** consent for this window, and the test reading at 95%.

### LC3 Stop here, and a Stop hook

**Start:** a new session with the Stop hook fixture.
Type `/exit`, then send this start command:

```sh
: > /tmp/s10.log
tmux send-keys -t s10 'SPARE10_RESUME_FLOOR=0 SPARE10_WEEKLY_RESUME_FLOOR=0 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir . --model haiku --settings .fixtures/stophook.json --debug-file /tmp/s10.log' Enter
```

The new process has no consent and no test reading.
The fixture Stop hook blocks the turn end while `/tmp/s10-block` exists.

**Steps:**

1. In a second shell, run `touch /tmp/s10-block`.
2. Send: `Run these two Bash commands one after the other, not in parallel: sleep 25, then touch /tmp/s10-lc3.`
3. While `sleep` runs, type `/spare10 simulate 95`.
4. Wait until the dialog shows. Choose Stop here.
5. In the second shell, run `rm /tmp/s10-block`.

**Expected:**

- `/tmp/s10-lc3` does not exist.
- The stop lands on the next step of the main loop. Both outcomes below pass. Record which one you see.
  - **On the Bash call:** the Bash call fails with the STOP text. Then spare10 refuses the next model request with the PAUSED text.
  - **On the model request:** spare10 refuses the request with the PAUSED text. No Bash call runs.
- The STOP text starts with `spare10: the user stopped work at the quota reserve`.
- The PAUSED text starts with `spare10: work stopped at the quota reserve`. Record whether it shows in the transcript.
- The transcript shows `spare10: stopped at your 10% reserve until OPEN, 20 min before the test window ends. Then spare10 continues the work, unless a reserve is still reached. Type a prompt to be asked again, or run /spare10 resume.`
- The turn ends and does not loop.
- The debug log shows the `turn.abort`, and at most one run of the Stop hook.
- The debug log has no repeated `turn.step: a hook answered without the request`.
- The badge shows `■ spare10 (test): stopped until OPEN`.
- `/spare10` shows the phase `■ stopped`, with the detail `you chose Stop here. spare10 continues the work at OPEN. Type a prompt to be asked again, or run /spare10 resume.`

**Settles:** Stop here, the turn end, and the protection against a blocking Stop hook.

**Leaves:** the session is stopped until OPEN, the test reading is at 95%, and there is no consent.
Go on to LC5 at once. If this session is still open after OPEN, spare10 continues the stopped work.

### LC5 `/clear`

**Start:** directly after LC3.
The session is stopped, the test reading is at 95%, and there is no consent.

**Steps:**

1. Type `/clear`.
2. Type `/spare10`.
3. Type `/spare10 resume`.
4. Type `/clear`, then `/spare10`.

**Expected:**

- After step 1, within about 2 s and with no other input, the badge blinks `⚠ Pausing at next step`. It does not show `■ spare10 (test): stopped until OPEN`.
- After step 2, the phase line is `⚠ tripped`, not `■ stopped`.
- After step 2, the reading line starts with `test reading`, and the consent line is `none`.
- Step 3 replies `spare10: you can use the reserve until HH:MM.`
- After step 4, the phase line is `⨯ consented`.
- After step 4, the consent line is `until HH:MM (you chose to continue)`.
- After step 4, the badge shows `⨯ spare10 (test)`.
- The stop of the old conversation is dropped at its end, and spare10 sends nothing.
  The end is OPEN, too far away here, so LC22 checks this with a short test window.

**Settles:** the stop belongs to one conversation. The test reading and the consent survive `/clear`. The badge follows `/clear` at once.

**Leaves:** consent for this window, and the test reading at 95%.

### LC4 Prompt question

**Start:** directly after LC5, with consent and the test reading at 95%.

**Steps:**

1. Make a fresh trip. Type `/spare10 simulate off`, then `/spare10 simulate 95`.
2. Type `/spare10`. Make sure that the phase line is `⚠ tripped` and the consent line is `none`.
3. Type `Reply ok` and send it.
4. Choose Stop here.
5. Send the prompt again. The text is back in the prompt box, so press Enter.
6. Choose Resume.
7. Optional, one more request: send `Did you receive a note from spare10?`

**Expected:**

- After step 3, the dialog has the prompt wording:
  `Your 10% reserve is reached: 95% used · 5% left · resets HH:MM. spare10 holds your prompt and any other work. Continue on the reserve until HH:MM? If you do not answer, all of it continues at OPEN, 20 min before the test window ends, unless a reserve is still reached. Stop here gives your prompt back and pauses other work until OPEN.`
- After step 4, Claude Code shows this line:
  `Prompt dropped by a hook: spare10: not started. This session is inside your 10% reserve until HH:MM. Send the prompt again to be asked again, or run /spare10 resume.`
- After step 4, `Reply ok` is back in the prompt box, one time only.
- After step 4, the transcript shows `spare10: stopped at your 10% reserve until OPEN, 20 min before the test window ends. Type a prompt to be asked again, or run /spare10 resume.`
- After step 4, the badge shows `■ spare10 (test): stopped until OPEN`.
- After step 5, the dialog shows again, with the prompt wording.
- After step 6, the prompt runs with one model request.
- After step 6, the transcript shows `spare10: continuing on your 10% reserve. spare10 stays quiet until HH:MM.`
- After step 7, the model reports this note:
  `spare10: earlier work stopped at the 10% quota reserve. The user now chose to continue on the reserve until HH:MM. Follow their message.`

**Settles:** the question from a prompt hook, the text restore, and the resume note.

**Leaves:** consent for this window, and the test reading at 95%.

### LC6 Unattended stop

**Start:** a shell in the repo folder. This check needs no interactive session.
If your `scope` option is `opt-in`, add `SPARE10=on` to the command.

**Steps:**

```sh
SPARE10_SIMULATE=95 SPARE10_HEADLESS=stop CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -p "Run touch /tmp/s10-p" --plugin-dir . --model haiku --output-format json; echo "exit $?"
```

**Expected:**

- The run does not hang.
- `result` starts with `spare10 stopped this unattended run at the quota reserve`.
- `result` ends with `claude --resume <id>`.
- `/tmp/s10-p` does not exist.
- The run sends no model request, because spare10 refuses the first step.
- Record the exit code. The expected code is 0.

**Settles:** a `-p` run with the `stop` policy, from start to end.

**Leaves:** nothing. The `-p` process has ended.

### LC7 Tell mode

**Start:** a new session with a pause prompt.
Type `/exit`, then send this start command:

```sh
: > /tmp/s10.log
tmux send-keys -t s10 "SPARE10_PAUSE_PROMPT='Commit nothing. Stop.' SPARE10_RESUME_FLOOR=0 SPARE10_WEEKLY_RESUME_FLOOR=0 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir . --model haiku --debug-file /tmp/s10.log" Enter
```

**Steps:**

1. Send: `Start a general-purpose subagent that runs Bash sleep 20 then Bash echo done. Meanwhile run Bash sleep 20 then Bash echo main.`
2. During the sleeps, type `/spare10 simulate 95`.

**Expected:**

- The next tool result of each loop carries the instruction one time.
- The debug log has `spare10: told <session id>:main` one time.
- The debug log has `spare10: told <session id>:<agent id>` one time.
- The tools still run.
- No dialog shows.
- After the first tell, the badge shows `⏸ spare10 (test)`.
- The transcript shows `spare10: your 10% reserve is reached. spare10 told the agents to wind down.` one time.

**Settles:** tell mode in a live session.

**Leaves:** a session in tell mode, with the test reading at 95%.

### LC8 Background agent and parallel loops

**Start:** a new session from the start command, in hold mode.

**Steps:**

1. Send: `Start one background agent (run_in_background) that runs Bash sleep 30 and then touch /tmp/s10-lc8. In the same message run Bash sleep 20. End your turn after both.`
2. During the sleeps, type `/spare10 simulate 95`.
3. Wait for the dialog. Choose Resume.

**Expected:**

- One dialog holds both loops.
- After Resume, `/tmp/s10-lc8` exists.

**Settles:** one question across loops in the real plugin.

**Leaves:** consent for this window, and the test reading at 95%.

## Weekly window and reset checks

These checks are new in 0.2.
They use short test windows, so each one takes a few minutes.
LC17 to LC24 are in the release gate for 0.2. LC18b is optional. Run LC25 once.

These checks test the reset path.
With the default open times, a short test window is open at once. Then a check does not see the reset.
So each check starts from the **reset start command**, or adds `SPARE10_LAST_MINUTES=0 SPARE10_WEEKLY_LAST_HOURS=0` to its own command.
The code of the reset path moved with the open times. Run LC17, LC18, LC19 and LC21 again on each build that changes it.

Each check starts from a new session.
Each check ends with `/spare10 simulate off`, so no test reading, test consent or stop stays.
Type `/exit` before the next check.

Most checks use this prompt, with the file name that the check gives:
`Run these two Bash commands one after the other, not in parallel: sleep 25, then touch /tmp/s10-lc17.`
This is the **two-step prompt**.

### LC17 Weekly question

**Start:** a new session from the reset start command.

**Steps:**

1. Send the two-step prompt with `/tmp/s10-lc17`.
2. While `sleep` runs, type `/spare10 simulate 95 weekly in 10m`.
3. Wait until the dialog shows. Choose Resume.
4. Type `/spare10`.
5. Type `! env | grep SPARE10_WEEKLY_CONSENT`.
6. Type `/spare10 simulate off`.

**Expected:**

- Step 2 replies `spare10: test reading set to 95% used of the weekly window, resets ddd HH:MM. It can only raise the real reading. Run /spare10 simulate off to clear it.`
- The dialog has the weekly wording, with a weekday clock:
  `Your 10% weekly reserve is reached: 95% used · 5% left · resets ddd HH:MM. All work is on hold. Continue on the weekly reserve until ddd HH:MM? If you choose Stop here or do not answer, the work waits until ddd HH:MM. Then spare10 continues it, unless a reserve is still reached.`
- After Resume, `/tmp/s10-lc17` exists.
- The transcript shows `spare10: continuing on your 10% weekly reserve. spare10 stays quiet until ddd HH:MM.`
- After step 4, the `weekly consent` line reads `until ddd HH:MM (you chose to continue)`.
- After step 4, the `weekly reading` line starts with `test reading`.
- Step 5 prints nothing, because a Resume on a test reading stays in spare10's memory.

**Settles:** the weekly window on the real plugin.

**Leaves:** no test reading, no consent and no stop.

### LC18 A question continues at the reset

**Start:** a new session from the reset start command.

**Steps:**

1. Send the two-step prompt with `/tmp/s10-lc18`.
2. While `sleep` runs, type `/spare10 simulate 95 in 2m`.
3. When the dialog shows, do not answer.
4. Wait until about 2 minutes after HH:MM.
5. Type `/spare10 simulate off`.

**Expected:**

- The dialog ends `If you choose Stop here or do not answer, the work waits until HH:MM. Then spare10 continues it, unless a reserve is still reached.`
- `HH:MM` is two minutes after step 2.
- About one minute after HH:MM, the dialog leaves the screen by itself.
- Then `/tmp/s10-lc18` exists.
- The transcript shows `spare10: the test window ended. Held work continues.`
- The debug log has no `hook failed` and no `exceeded 10000ms budget`.

**Settles:** an unanswered question continues at the reset. The dialog is withdrawn. The check of a held step runs in the hooks worker.

**Leaves:** no test reading, no consent and no stop.

### LC18b Behind a permission dialog (optional)

**Start:** a new session from the reset start command.

**Steps:**

1. Send: `Run these two Bash commands one after the other, not in parallel: sleep 25, then touch ~/s10-lc18b.`
   The second command writes outside the project, so it needs a permission.
2. When the permission dialog shows, type `/spare10 simulate 95 in 2m`.
3. Do not answer either dialog. Wait until about 2 minutes after HH:MM.
4. Answer the dialogs that are still on the screen. Type `/spare10 simulate off`.

**Expected:**

- Record what you see at the reset.
  The spare10 question waits behind the permission dialog. At the reset, it leaves the queue, or it stays.
- If the prompt box does not take the command while the permission dialog is on the screen, record that.
  The check cannot run in this form then.

**Settles:** what a person sees when a question at the reset waits behind another dialog.

**Leaves:** no test reading, no consent and no stop.

### LC19 Stop here, then the resume prompt

**Start:** a new session from the reset start command.

**Steps:**

1. Send the two-step prompt with `/tmp/s10-lc19`.
2. While `sleep` runs, type `/spare10 simulate 95 in 2m`.
3. Wait until the dialog shows. Choose Stop here.
4. Type `draft` in the prompt box, then delete it again. Leave the box empty.
5. Wait for the resume prompt. It comes about one to one and a half minutes after HH:MM.
6. As soon as the resumed turn starts, type `/spare10 simulate 95 in 2m` again.
7. When the dialog shows, choose Resume.
8. Type `/spare10 simulate off`.

**Expected:**

- After step 3, the Bash call gets the STOP text, or the next request gets the PAUSED text.
- After step 3, the transcript shows `spare10: stopped at your 10% reserve until HH:MM. Then spare10 continues the work, unless a reserve is still reached. Type a prompt to be asked again, or run /spare10 resume.`
- After step 3, the badge shows `■ spare10 (test): stopped until HH:MM`.
- About one to one and a half minutes after HH:MM, the transcript shows `spare10: the test window ended. spare10 continues the stopped work.`
- Then a plugin message with the resume prompt shows. Record how the transcript frames it.
- The model runs `touch /tmp/s10-lc19`, and the file exists.
- After step 6, the next tool call or model request of the resumed turn is held, and the question shows.
- After step 7, the resumed turn goes on.
- The debug log has no `would wait on the turn` refusal and no `$.spare10.poke` failure.
- Record whether the `prompt.submit` hook of spare10 saw the resume prompt. Look for a debug line about it.

**Settles:** a stop continues at the reset through `$.prompt.submit` from the reset timer.
It also settles the frame of the plugin message, and the gate on the resumed turn.

**Leaves:** no test reading, no consent and no stop.

### LC19b The prompt box at the reset

**Start:** a new session from the reset start command.

**Steps:**

1. Do LC19 steps 1 to 3, with `/tmp/s10-lc19b`.
2. Type `new instruction` in the prompt box. Do not send it.
3. Wait until about 7 minutes after HH:MM.
4. Clear the prompt box, if it still has text. Type `/spare10 simulate off`.

**Expected:**

- About one minute after HH:MM, the resume prompt waits.
  The debug log has `spare10: the prompt box has text. The resume prompt waits (1 of 10).`
- The debug log has one such line for each 30 s check, up to `(10 of 10)`.
- About 5 minutes later, the transcript shows `spare10: the test window ended. spare10 continues the stopped work.`
- Then the resume prompt goes, and the model runs `touch /tmp/s10-lc19b`.
- Record whether `new instruction` is still in the prompt box after the resumed turn starts.

**Settles:** the resume prompt waits while the person types, and then goes.

**Leaves:** no test reading, no consent and no stop.

### LC20 Continue at the reset off

**Start:** a new session with the option off.
Type `/exit`, then send this start command:

```sh
: > /tmp/s10.log
tmux send-keys -t s10 'SPARE10_AUTO_RESUME=off SPARE10_LAST_MINUTES=0 SPARE10_WEEKLY_LAST_HOURS=0 SPARE10_RESUME_FLOOR=0 SPARE10_WEEKLY_RESUME_FLOOR=0 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir . --model haiku --debug-file /tmp/s10.log' Enter
```

**Steps:**

1. Send the two-step prompt with `/tmp/s10-lc20a`.
2. While `sleep` runs, type `/spare10 simulate 95 in 2m`.
3. When the dialog shows, do not answer for 4 minutes.
4. Choose Resume.
5. Type `/spare10 simulate 95 in 2m`.
6. Send the two-step prompt with `/tmp/s10-lc20`. Choose Stop here in the new question.
7. Before HH:MM, press Enter to send the prompt again. The text is back in the prompt box. Choose Stop here again.
8. Wait 4 minutes.
9. Type `/spare10 simulate off`.

**Expected:**

- The dialog has no `Then spare10 continues it` sentence. It ends at `Continue on the reserve until HH:MM?`
- After HH:MM, the dialog stays on the screen.
- The transcript shows `spare10: the test window ended. Held work still waits for your answer.` one time.
- After Resume, `/tmp/s10-lc20a` exists.
- After step 6, the transcript shows `spare10: stopped at your 10% reserve. Type a prompt to be asked again, or run /spare10 resume.` It has no `until`.
- After step 6, the badge shows `■ spare10 (test): stopped`, with no time.
- After step 7, the question shows again.
- During step 8, no plugin message comes, and `/tmp/s10-lc20` does not exist.

**Settles:** with the option off, spare10 keeps the behaviour of 0.1.

**Leaves:** no test reading, no consent and no stop. Start the next check from a new session.

### LC21 Unattended wait

**Start:** a shell in the repo folder. This check needs no interactive session.
If your `scope` option is `opt-in`, add `SPARE10=on` to the command.

**Steps:**

```sh
: > /tmp/s10-p.log
time SPARE10_SIMULATE="95 in 2m" SPARE10_HEADLESS=wait SPARE10_LAST_MINUTES=0 SPARE10_WEEKLY_LAST_HOURS=0 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -p "Run touch /tmp/s10-lc21" --plugin-dir . --model haiku --output-format json --debug-file /tmp/s10-p.log; echo "exit $?"
```

**Expected:**

- No dialog shows, and the run shows no error.
- The run takes about 3 minutes.
- `/tmp/s10-lc21` exists.
- The exit code is 0.
- The debug log has `policy wait`.
- The debug log has `$.spare10.park ... did not answer within 10000ms` about every 10 s.
- The debug log has `spare10: the test window ended. Held work continues.`

**Settles:** the `wait` policy holds a `-p` run with no person, and continues it at the reset.

**Leaves:** nothing. The `-p` process has ended.

### LC22 `/clear` and the stop

**Start:** a new session from the reset start command.

**Steps:**

1. Do LC19 steps 1 to 3, with `/tmp/s10-lc22`.
2. Type `/clear` at once.
3. Wait 4 minutes.
4. Send the two-step prompt with `/tmp/s10-lc22b`.
5. While `sleep` runs, type `/spare10 simulate 95 in 2m`. Choose Stop here in the dialog.
6. Note the time `HH:MM` in the stop notice. Type `/clear` in the half minute after HH:MM plus one minute.
7. Wait 3 minutes. Then type `/spare10 simulate off`.

**Expected:**

- After step 3, no resume prompt has come.
- After step 3, the debug log has `spare10: a stop of another conversation ended at its reset. spare10 dropped it.`
- After step 7, record whether a resume prompt reached the new conversation.

**Settles:** `/clear` ends a stop for good, and spare10 checks the conversation before it sends the resume prompt.

**Leaves:** no test reading, no consent and no stop.

### LC23 Reload during a stop

**Start:** a new session from the reset start command.

**Steps:**

1. Do LC19 steps 1 to 3, with `/tmp/s10-lc23`.
2. In another terminal, set `pluginConfigs["spare10@inline"].options.reserve` to `11` in `~/.claude/settings.json`.
3. Wait until about 2 minutes after HH:MM.
4. Restore the setting.
5. Type `/spare10 simulate off`.

**Expected:**

- The debug log shows the reload.
- The reload drops the test reading. Record the badge after the reload.
- One resume prompt comes, from the new copy.
- The model runs `touch /tmp/s10-lc23`, and the file exists.

**Settles:** the new copy starts its own reset timer, and rebuilds the reset times from the environment.
It does not settle the case of a reload during a prompt question. A stopped session has no step in flight, so the old copy unloads at once.

**Leaves:** no test reading, no consent and no stop.

### LC24 Two windows

**Start:** a new session from the reset start command.

**Steps:**

1. Send the two-step prompt with `/tmp/s10-lc24`.
2. While `sleep` runs, type `/spare10 simulate 95 in 2m`. Then type `/spare10 simulate 95 weekly in 4m`.
3. When the dialog shows, do not answer. Wait about 6 minutes.
4. Type `/spare10 simulate off`.
5. Send the two-step prompt with `/tmp/s10-lc24b`.
6. While `sleep` runs, type `/spare10 simulate 95 in 2m`.
7. After the question opens, type `/spare10 simulate 95 weekly in 4m`.
   The dialog holds the keys, so do one of these two things:
   - Start to type the command in the last seconds of the sleep, and keep on typing. The dialog stays hidden while you type (LC10).
   - Type the command from a remote surface.

   Record which way you used.
8. Do not answer. Wait about 6 minutes.
9. Type `/spare10 simulate off`.

**Expected:**

- After step 3, the dialog names both windows:
  `Your 10% reserve and your 10% weekly reserve are reached: 5-hour window 95% used · 5% left · resets HH:MM, weekly window 95% used · 5% left · resets ddd HH:MM. ...`
- About 3 minutes after step 2, the dialog stays, because the weekly test window is still open.
- About 5 minutes after step 2, the dialog goes, and `/tmp/s10-lc24` exists.
- The transcript shows `spare10: the test windows ended. Held work continues.`
- In the second part, the first dialog names only the 5-hour window.
  If it names both, the weekly test reading came too early. Do the second part again.
- About one minute after the 5-hour test window ends, the transcript shows:
  `spare10: the test window ended, but your 10% weekly reserve is reached. Held work still waits.`
- Then a new question shows, with the weekly wording and a weekday clock.
- About one minute after the weekly test window ends, that dialog goes, and `/tmp/s10-lc24b` exists.

**Settles:** a question with two windows continues at the reset.
A new question opens at the reset when another window is still in its reserve.
It also settles the weekly clock.

**Leaves:** no test reading, no consent and no stop.

### LC25 Hold budget

**Start:** a new session with its own debug log.
Type `/exit`, then send this start command:

```sh
: > /tmp/s10-lc25.log
tmux send-keys -t s10 'SPARE10_LAST_MINUTES=0 SPARE10_WEEKLY_LAST_HOURS=0 SPARE10_RESUME_FLOOR=0 SPARE10_WEEKLY_RESUME_FLOOR=0 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir . --model haiku --debug-file /tmp/s10-lc25.log' Enter
```

**Steps:**

1. Send the two-step prompt with `/tmp/s10-lc25`.
2. While `sleep` runs, type `/spare10 simulate 95 in 30m`.
3. When the dialog shows, do not answer. Wait about 32 minutes.
4. Type `/spare10 simulate off`.
5. Run `grep 'spare10: held' /tmp/s10-lc25.log`.

**Expected:**

- The debug log has three lines `spare10: held N min. Budget left MS ms.`, at about 10, 20 and 30 minutes.
- After the test window ends, the dialog goes, and `/tmp/s10-lc25` exists.
- Record the budget in each line.
- Work out the cost of one cycle: the budget that the hold used in 30 minutes, divided by 180 cycles.
- Work out the longest hold: 8 000 ms divided by the cost of one cycle, times 10 s.

**Settles:** the hold time limit, and the estimate that a hold can last more than a day.

**Leaves:** no test reading, no consent and no stop.

## Near the reset checks

These checks test the open reserve near the reset.
LC26 to LC31 are in the release gate for 0.2.
They use the default open times: 20 minutes for the 5-hour window, 8 hours for the weekly window.
A 5-hour test window `in 22m` opens 2 minutes later, and a weekly test window `in 482m` does too.
So each check takes a few minutes.

**Precondition of LC26 to LC31.**
The `reading` row of `/spare10` shows less than 90% used.
For LC30, the `weekly reading` row also shows less than 90% used.
Then the real reading is below the reserve, and the test reading can open it.
Else wait for the reset.

Each check starts from a new session, and ends with `/spare10 simulate off`.
Type `/exit` before the next check.
In these checks, `OPEN` is 2 minutes after the `/spare10 simulate` command, and `HH:MM` is the end of the test window.

### LC26 The reserve opens near the reset

**Start:** a new session from the start command.

**Steps:**

1. Send the two-step prompt with `/tmp/s10-lc26`.
2. While `sleep` runs, type `/spare10 simulate 95 in 22m`.
3. When the dialog shows, do not answer.
4. Wait until about 1 minute after OPEN. Look at the badge.
5. Type `/spare10`.
6. Send the two-step prompt with `/tmp/s10-lc26b`.
7. Type `/spare10 simulate off`.

**Expected:**

- Step 2 replies `spare10: test reading set to 95% used, resets HH:MM. It can only raise the real reading. The reserve opens at OPEN, 20 min before the test window ends. Run /spare10 simulate off to clear it.`
- `HH:MM` is 22 minutes after step 2.
- The dialog ends `If you choose Stop here or do not answer, the work waits until OPEN, 20 min before the test window ends. Then spare10 continues it, unless a reserve is still reached.`
- Within about 40 s after OPEN, the dialog leaves the screen by itself, and `/tmp/s10-lc26` exists.
- The transcript shows `spare10: the test window ends at HH:MM. Your 10% reserve is open until then. Held work continues.`
- After step 4, the badge shows `↻ spare10 (test): reserve open until HH:MM`.
- After step 5, the phase line reads `↻ open           the reset is near. Your 10% reserve is open until HH:MM, so spare10 lets all work through.`
- After step 5, the `reserve opens` and `weekly opens` rows end with `(from /config)`.
- After step 6, no dialog shows, and `/tmp/s10-lc26b` exists.
- The debug log has no `hook failed` and no `exceeded 10000ms budget`.

**Settles:** an open question continues when the reserve opens, with no margin, in the hooks worker.
It also settles the open phase and the open badge.

**Leaves:** no test reading, no consent and no stop.

### LC27 Stop here, then the reserve opens

**Start:** a new session from the start command.

**Steps:**

1. Send the two-step prompt with `/tmp/s10-lc27`.
2. While `sleep` runs, type `/spare10 simulate 95 in 22m`.
3. When the dialog shows, choose Stop here.
4. Wait until about 1 minute after OPEN.
5. Type `/spare10 simulate off`.

**Expected:**

- After step 3, the Bash call gets the STOP text, or the next request gets the PAUSED text.
- After step 3, the transcript shows `spare10: stopped at your 10% reserve until OPEN, 20 min before the test window ends. Then spare10 continues the work, unless a reserve is still reached. Type a prompt to be asked again, or run /spare10 resume.`
- After step 3, the badge shows `■ spare10 (test): stopped until OPEN`.
- Within about 40 s after OPEN, the transcript shows `spare10: the test window ends at HH:MM. Your 10% reserve is open until then. spare10 continues the stopped work.`
- Then a plugin message shows. It starts `The test window ends at HH:MM. Your 10% reserve is open until then, so the stop at the quota reserve is over.`
- The model runs `touch /tmp/s10-lc27`, and the file exists.

**Settles:** a stop ends when the reserve opens, and the resume prompt has the open wording.

**Leaves:** no test reading, no consent and no stop.

### LC28 Continue at the reset off, near the reset

**Start:** a new session with the option off.
Type `/exit`, then send this start command:

```sh
: > /tmp/s10.log
tmux send-keys -t s10 'SPARE10_AUTO_RESUME=off SPARE10_RESUME_FLOOR=0 SPARE10_WEEKLY_RESUME_FLOOR=0 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir . --model haiku --debug-file /tmp/s10.log' Enter
```

**Steps:**

1. Send the two-step prompt with `/tmp/s10-lc28`.
2. While `sleep` runs, type `/spare10 simulate 95 in 22m`.
3. When the dialog shows, do not answer. Wait until about 1 minute after OPEN.
4. Optional: from a remote surface, type `/spare10`. The dialog holds the keys in the terminal.
5. Press Esc on the dialog.
6. Send the two-step prompt with `/tmp/s10-lc28b`.
7. Wait 1 minute. Then type `/spare10 simulate off`.

**Expected:**

- The dialog has no `If you ...` sentence. It ends at `Continue on the reserve until HH:MM?`
- Within about 40 s after OPEN, the transcript shows this line one time:
  `spare10: the test window ends at HH:MM. Your 10% reserve is open until then, but held work still waits for your answer. New work goes on with no question.`
- The dialog stays on the screen.
- After step 4, the asking line of `/spare10` has `Your 10% reserve is open until HH:MM, so new work goes on.`
- After step 5, the transcript shows `spare10: stopped. Held work is refused. The test window ends at HH:MM. Your 10% reserve is open until then, so new work goes on with no question.`
- After step 5, the held Bash call gets the STOP text.
- After step 6, no dialog shows, and `/tmp/s10-lc28b` exists.
- During step 7, no plugin message comes.

**Settles:** with the option off, held work waits for the answer, and new work goes on.
One note says that the reserve is open.
It also settles a Stop here after the reserve opens.

**Leaves:** no test reading, no consent and no stop. Start the next check from a new session.

### LC29 No stop while the reserve is open

**Start:** a new session from the start command.

**Steps:**

1. Type `/spare10 simulate 95 in 10m`.
2. Send the two-step prompt with `/tmp/s10-lc29`.
3. While `sleep` runs, type `/spare10 stop`.
4. Type `/spare10 resume`.
5. Type `/spare10 simulate off`.

**Expected:**

- Step 1 replies `spare10: test reading set to 95% used, resets HH:MM. It can only raise the real reading. The test window ends within 20 min, so the reserve is open at once. Run /spare10 simulate off to clear it.`
- After step 1, the badge shows `↻ spare10 (test): reserve open until HH:MM`.
- No dialog shows.
- Step 3 replies `spare10: nothing to stop. The reset is near, so your 10% reserve is open until HH:MM. To keep a reserve until the reset, set its Open reserve option to 0 in /config.`
- `/tmp/s10-lc29` exists.
- Step 4 replies `spare10: nothing to resume. The reset is near, so your 10% reserve is open until HH:MM.`

**Settles:** a stop never holds an open window. This check has no wait.

**Leaves:** no test reading, no consent and no stop.

### LC30 Unattended wait and the weekly open time

**Start:** a shell in the repo folder. This check needs no interactive session.
If your `scope` option is `opt-in`, add `SPARE10=on` to the command.

**Steps:**

```sh
: > /tmp/s10-p.log
time SPARE10_SIMULATE="95 weekly in 482m" SPARE10_HEADLESS=wait CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -p "Run touch /tmp/s10-lc30" --plugin-dir . --model haiku --output-format json --debug-file /tmp/s10-p.log; echo "exit $?"
```

**Expected:**

- No dialog shows, and the run shows no error.
- The run takes about 2 minutes.
- `/tmp/s10-lc30` exists.
- The exit code is 0.
- The debug log has `policy wait`.
- The debug log has `spare10: the weekly test window ends at ddd HH:MM. Your 10% weekly reserve is open until then. Held work continues.`

**Settles:** the weekly open time in hours, and `wait` when the reserve opens.
`in` counts from the first gated event, so the reserve opens 2 minutes after it.

**Leaves:** nothing. The `-p` process has ended.

### LC31 An option change during a question

**Start:** before the start, set `pluginConfigs["spare10@inline"].options.lastMinutes` to `1` in `~/.claude/settings.json`.
Then start a new session from the start command, without `SPARE10_LAST_MINUTES`.

**Steps:**

1. Send the two-step prompt with `/tmp/s10-lc31`.
2. While `sleep` runs, type `/spare10 simulate 95 in 3m`.
3. When the dialog shows, set `lastMinutes` to `0` in the settings file. This reloads the plugin.
4. Do not answer. Wait until about 2 minutes after HH:MM.
5. Restore the setting. Type `/spare10 simulate off`.

**Expected:**

- Step 2 replies with the sentence `The reserve opens at OPEN, 1 min before the test window ends.`
  Here `HH:MM` is 3 minutes after step 2, and `OPEN` is 2 minutes after step 2.
- The debug log shows the reload.
- At OPEN, nothing runs.
- Within about 40 s after OPEN, the transcript shows `spare10: your 10% reserve is reached. Held work still waits.`
- Then a new dialog shows. It ends `the work waits until HH:MM. Then spare10 continues it, unless a reserve is still reached.`
- About 1 minute after HH:MM, the transcript shows `spare10: the test window ended. Held work continues.`
- Then `/tmp/s10-lc31` exists.

**Settles:** the open times of the newest copy apply to the held work of an older copy.
Cost: about 5 minutes.

**Leaves:** no test reading, no consent and no stop. Make sure that you restored the setting.

## Resume floor checks

These checks are new in 0.3.
They test the resume floor with the default floors of 5%.
LC32 to LC37 are in the release gate for 0.3.
Each check takes less than 5 minutes.
LC34 and LC36 make no model request.

**Precondition of LC32 to LC35.**
The `reading` row and the `weekly reading` row of `/spare10` show less than 90% used.
So neither real reading is in its reserve.
A **Resume** on a test reading also covers the real reading beneath it.
So a real reading in the reserve changes what these checks show.
Else wait for the reset.

The checks use `in 1h`, so the test window opens its reserve 40 minutes later.
In these checks, `HH:MM` is the end of the test window, and `OPEN` is 20 minutes before it.
A raise with `/spare10 simulate 96` keeps the test window, so `HH:MM` and `OPEN` stay.
The checks use the two-step prompt of [Weekly window and reset checks](#weekly-window-and-reset-checks).

LC32 to LC34 run in one session from the **floor start command**.
Each of them ends with `/spare10 simulate off`.

### LC32 The second question

**Start:** a new session from the floor start command. No test reading is set.

**Steps:**

1. Type `/spare10`.
2. Send the two-step prompt with `/tmp/s10-lc32`.
   While `sleep` runs, type `/spare10 simulate 91 in 1h`.
3. When the dialog shows, choose Resume. Look at the badge. Then type `/spare10`.
4. Send the two-step prompt with `/tmp/s10-lc32b`.
   While `sleep` runs, type `/spare10 simulate 96`.
5. When the dialog shows, make sure that `/tmp/s10-lc32b` does not exist yet.
   Choose Resume. Look at the badge. Then type `/spare10`.
6. Type `/spare10 simulate off`.

**Expected:**

- After step 1, the report shows `resume floor   5%: after a Resume, spare10 asks again at 95% used (from /config)`.
- After step 1, the report shows `weekly floor   5%: after a Resume, spare10 asks again at 95% used of the weekly window (from /config)`.
- After step 1, the last lines include `/spare10 resume   continue on the reserve until the floor, or past the floor until the reset`.
- Step 2 replies `spare10: test reading set to 91% used, resets HH:MM. It can only raise the real reading. The reserve opens at OPEN, 20 min before the test window ends. Run /spare10 simulate off to clear it.`
- The first dialog has the first question:
  `Your 10% reserve is reached: 91% used · 9% left · resets HH:MM. All work is on hold. Continue on the reserve until 95% used? Until OPEN, spare10 asks you again at 95% used. If you choose Stop here or do not answer, the work waits until OPEN, 20 min before the test window ends. Then spare10 continues it, unless a reserve is still reached.`
- After step 3, the transcript shows `spare10: continuing on your 10% reserve until 95% used. Until OPEN, spare10 asks you again at 95% used.`
- After step 3, `/tmp/s10-lc32` exists.
- After step 3, the badge shows `⨯ spare10 (test): resumed until 95% used`.
- After step 3, the phase line reads `⨯ consented      you chose to continue. Until OPEN, spare10 asks you again at 95% used.`
- After step 3, the consent row reads `consent        until 95% used or HH:MM (you chose to continue)`.
- In step 4, no dialog shows before the raise.
- Step 4 replies `spare10: test reading raised to 96% used, resets HH:MM. Your earlier answers stay. It can only raise the real reading. This is past your 5% floor. The reserve opens at OPEN, 20 min before the test window ends. Run /spare10 simulate off to clear it.`
- The second dialog has the second question:
  `Your 5% floor is reached: 96% used · 4% left · resets HH:MM. All work is on hold. Continue on the last 4% until HH:MM? If you choose Stop here or do not answer, the work waits until OPEN, 20 min before the test window ends. Then spare10 continues it, unless a reserve is still reached.`
- After step 5, the transcript shows `spare10: continuing on your 5% floor. spare10 stays quiet until HH:MM.`
- After step 5, `/tmp/s10-lc32b` exists.
- After step 5, the badge shows `⨯ spare10 (test)`.
- After step 5, the consent row reads `consent        until HH:MM (you chose to continue)`.

**Settles:** the two questions in the real dialog and the raise in place.
It also settles the consent to the floor, the badge and the report.
Cost: two short turns.

**Leaves:** the session runs, with no test reading, no consent and no stop.

### LC33 Stop here at the second question

**Start:** the session from LC32, with no test reading, no consent and no stop.

**Steps:**

1. Do LC32 steps 2 to 4, with `/tmp/s10-lc33` and `/tmp/s10-lc33b`.
2. When the second dialog shows, choose Stop here.
3. Type `/spare10 resume`.
4. Type `/spare10 simulate off`.

**Expected:**

- After step 2, `/tmp/s10-lc33b` does not exist.
- After step 2, the held Bash call gets the STOP text with the floor:
  `spare10: the user stopped work at the quota reserve (into your 5% floor · 4% of quota left · resets HH:MM). Stop now and wait for the user. Do not call any further tools.`
  Or the next request gets the PAUSED text with the same figures:
  `spare10: work stopped at the quota reserve (into your 5% floor · 4% of quota left · resets HH:MM). No model request was sent, so this task is not finished. Wait for the user.`
- After step 2, the transcript shows `spare10: stopped at your 5% floor until OPEN, 20 min before the test window ends. Then spare10 continues the work, unless a reserve is still reached. Type a prompt to be asked again, or run /spare10 resume.`
- After step 2, the badge shows `■ spare10 (test): stopped until OPEN`.
- Step 3 replies `spare10: resumed. You can use the last 4% until HH:MM. Type a prompt to continue.`
- After step 3, the badge shows `⨯ spare10 (test)`.

**Settles:** Stop here at the floor, the floor names in the model texts, and `/spare10 resume` past the floor.
Cost: two short turns.

**Leaves:** the session runs, with no test reading, no consent and no stop.

### LC34 `/spare10 resume` before and past the floor

**Start:** the session from LC33, with no test reading, no consent and no stop.
This check sends no prompt.

**Steps:**

1. Type `/spare10 simulate 91 in 1h`. Then type `/spare10 resume`.
2. Type `/spare10 resume` again.
3. Type `/spare10 simulate 96`. Then type `/spare10`.
4. Type `/spare10 resume`.
5. Type `/spare10 simulate off`.

**Expected:**

- Step 1 replies `spare10: you can use the reserve until 95% used. Until OPEN, spare10 asks you again at 95% used.`
- Step 2 replies `spare10: already resumed until 95% used. Until OPEN, spare10 asks you again at 95% used.`
- After step 3, the phase line is `⚠ tripped`.
- After step 3, the consent row reads `consent        ended at 95% used (you chose to continue until then)`.
- Step 4 replies `spare10: you can use the last 4% until HH:MM.`

**Settles:** the two tiers of `/spare10 resume`, and the consent rows of the report.
Cost: no model request.

**Leaves:** the session runs, with no test reading, no consent and no stop. Type `/exit` before LC35.

### LC35 Tell mode at the floor

**Start:** a new session with a pause prompt and the default floors.
Send this start command:

```sh
: > /tmp/s10.log
tmux send-keys -t s10 'SPARE10_PAUSE_PROMPT="Say done and stop." CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir . --model haiku --debug-file /tmp/s10.log' Enter
```

**Steps:**

1. Type `/spare10 simulate 91 in 1h`. Then send `Run touch /tmp/s10-lc35a`.
2. When the dialog shows, choose Resume.
3. Send the two-step prompt with `/tmp/s10-lc35b`.
   While `sleep` runs, type `/spare10 simulate 96`.
4. When the turn ends, type `/spare10`.
5. Type `/spare10 simulate off`. Then type `/spare10 simulate 96 in 1h`.
6. Send `Run touch /tmp/s10-lc35c`.
7. When the dialog shows, choose Stop here.
8. Clear the prompt box. Type `/spare10 simulate off`.

**Expected:**

- After step 1, the dialog has the first question in the tell wording:
  `Your 10% reserve is reached: 91% used · 9% left · resets HH:MM. spare10 holds your prompt. Continue on the reserve until 95% used? Until OPEN, spare10 tells the agents to wind down at 95% used. If you do not answer, your prompt goes in at OPEN, 20 min before the test window ends, unless a reserve is still reached. Stop here gives it back to you.`
- After step 2, the transcript shows `spare10: continuing on your 10% reserve until 95% used. Until OPEN, spare10 tells the agents to wind down at 95% used.`
- After step 2, `/tmp/s10-lc35a` exists, and the transcript has no `told the agents` line.
- In step 3, no dialog shows. The `touch` runs, and `/tmp/s10-lc35b` exists.
- After step 3, the transcript shows `spare10: your 5% floor is reached. spare10 told the agents to wind down.` one time.
- After step 3, the debug log has `spare10: told <session id>:main` one time. The debug line does not name the stage.
- After step 3, the model says done and stops.
- After step 4, the phase line reads `⏸ told           the wind-down went to 1 agent(s).`
- Step 5 replies `spare10: test reading set to 96% used, resets HH:MM. It can only raise the real reading. This is past your 5% floor. The reserve opens at OPEN, 20 min before the test window ends. Run /spare10 simulate off to clear it.`
- After step 6, the dialog has the second question in the tell wording:
  `Your 5% floor is reached: 96% used · 4% left · resets HH:MM. spare10 holds your prompt. Continue on the last 4% until HH:MM? If you do not answer, your prompt goes in at OPEN, 20 min before the test window ends, unless a reserve is still reached. Stop here gives it back to you.`
- After step 7, Claude Code shows this line:
  `Prompt dropped by a hook: spare10: not started. This session is inside your 5% floor until HH:MM. Send the prompt again to be asked again, or run /spare10 resume.`
- After step 7, `Run touch /tmp/s10-lc35c` is back in the prompt box, and `/tmp/s10-lc35c` does not exist.

**Settles:** tell mode at the floor in the real host.
Each loop gets a second tell at the floor, and a prompt at the floor asks the second question.
Cost: three short turns.

**Leaves:** no test reading, no consent and no stop. Type `/exit` before LC36.

### LC36 Options and variables

**Start:** a new session with a floor above the reserve and a bad weekly floor.
Send this start command:

```sh
: > /tmp/s10.log
tmux send-keys -t s10 'SPARE10_RESUME_FLOOR=12 SPARE10_WEEKLY_RESUME_FLOOR=x CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir . --model haiku --debug-file /tmp/s10.log' Enter
```

**Steps:**

1. Look at the start of the session. Then type `/spare10`.
2. Type `/spare10 simulate 91 in 1h`. Then type `/spare10 resume`.
3. Type `/spare10 simulate off`. Then type `/exit`.
4. Send this start command. Then type `/spare10`.

   ```sh
   : > /tmp/s10.log
   tmux send-keys -t s10 'SPARE10_RESUME_FLOOR=0 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir . --model haiku --debug-file /tmp/s10.log' Enter
   ```

**Expected:**

- At the start, the transcript shows `spare10: the resume floor (12%) is not below the reserve (10%), so it does nothing. Set it below the reserve, or to 0.`
- At the start, the transcript shows `spare10: SPARE10_WEEKLY_RESUME_FLOOR="x" is not 0 to 99. spare10 uses 5.`
- After step 1, the report shows `resume floor   12% does nothing, because it is not below the reserve (from SPARE10_RESUME_FLOOR)`.
- After step 1, the report shows `weekly floor   5%: after a Resume, spare10 asks again at 95% used of the weekly window (from /config)`.
- After step 1, the report shows both warnings as `⚠` lines.
- Step 2 replies `spare10: you can use the reserve until HH:MM.`, as in 0.2.
- After step 4, the report shows `resume floor   off. A Resume lasts until the reset (from SPARE10_RESUME_FLOOR)`.

**Settles:** a floor that does nothing, a bad value, and the floor rows of the report.
Cost: no model request.

**Leaves:** the session runs, with no test reading, no consent and no stop.

### LC37 Unattended runs with an inherited consent to the floor

**Start:** a shell in the repo folder. This check needs no interactive session.
If your `scope` option is `opt-in`, add `SPARE10=on` to the commands.

**Steps:**

```sh
U=$(date -u -v+1H +%Y-%m-%dT%H:%M:%SZ)   # macOS. GNU date: date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ
: > /tmp/s10-p.log
time SPARE10_SIMULATE="93 in 2h" SPARE10_HEADLESS=stop SPARE10_CONSENT="S0 $U to:95" CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -p "Run touch /tmp/s10-lc37a" --plugin-dir . --model haiku --output-format json --debug-file /tmp/s10-p.log; echo "exit $?"
: > /tmp/s10-p.log
time SPARE10_SIMULATE="96 in 2h" SPARE10_HEADLESS=stop SPARE10_CONSENT="S0 $U to:95" CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -p "Run touch /tmp/s10-lc37b" --plugin-dir . --model haiku --output-format json --debug-file /tmp/s10-p.log; echo "exit $?"
```

**Expected:**

- The first run creates `/tmp/s10-lc37a`.
- The second run does not create `/tmp/s10-lc37b`.
- The `result` of the second run starts `spare10 stopped this unattended run at the quota reserve (into your 10% reserve · 4% of quota left · resets`.
  It names the reserve, never the floor.
- The debug log of the second run has `unattended run inside the reserve (96% used · 4% left · resets HH:MM), policy stop.`

The consent value is real, and a real consent ends only by the real reading.
The real reading is below 95% used, so the second run does not end the value.
It refuses because its test reading of 96% is past the floor point of the value.

**Settles:** the consent form of 0.3 in a real environment, and the floor in unattended runs.
Cost: two small `-p` runs.

**Leaves:** nothing. The `-p` processes have ended.

## Optional and regression checks

### LC9 Keys on the dialog

**Start:** a new session from the start command.

**Steps:**

1. Trip as in LC2, with a new file name. When the dialog shows, press Enter at once.
2. Type `/spare10 simulate off`. This clears the stop.
3. Trip again. When the dialog shows, press `2`.
4. Type `/spare10 simulate off`. Trip again. When the dialog shows, press Ctrl-C.

**Expected:**

- Enter picks Stop here.
- Record what `2` does. The only good result for `2` is Resume.
- Record what Ctrl-C does.

**Settles:** the keys on the dialog.

**Leaves:** unknown. Start the next check from a new session.

### LC10 Lost raiser

**Start:** a new session from the start command.

**Steps:**

1. Send: `Start one background agent (run_in_background) that runs Bash sleep 20 and then touch /tmp/s10-lc10. In the same message run Bash sleep 20 and then Bash echo main.`
2. During the sleeps, type `/spare10 simulate 95`.
3. Type text in the prompt box, and keep on typing. The dialog stays hidden while you type.
4. Press Esc to interrupt the main loop.
5. When the dialog shows, choose Resume.

**Expected:**

- The main loop ends.
- The dialog shows. The background loop raised it again, or it was never withdrawn.
- After Resume, the background agent runs, and `/tmp/s10-lc10` exists.
- The debug log has at most one `spare10: the loop that asked went away` line.

**Settles:** the hand-off of the question when the loop that asked goes away.

**Leaves:** consent for this window, and the test reading at 95%.

### LC11 Question time limit

**Start:** in `/config`, set the question auto-continue timeout to 60 s. Then start a new session from the start command.

**Steps:**

1. Look at the start of the session.
2. Trip as in LC2. Do not answer. Wait 70 s.
3. Reset the timeout setting.
4. Start a new session with `CLAUDE_AFK_TIMEOUT_MS=60000` in the start command. Do steps 1 and 2 again.

**Expected:**

- At the start, the transcript shows `spare10: questions here continue by themselves after a time limit (<name>). An unanswered spare10 question then counts as Stop here, and spare10 continues the work at the time that the question names.`
- The result is Stop here, never Resume.
- The debug log shows the ask rejected with `No response after 60s`.

**Settles:** the question time limits read as Stop here.

**Leaves:** the session is stopped. Start the next check from a new session.

### LC12 Reload with the dialog up

**Start:** a new session from the start command.

**Steps:**

1. Send: `Start one background agent (run_in_background) that runs Bash sleep 40 and then touch /tmp/s10-lc12-bg. In the same message run Bash sleep 15, then touch /tmp/s10-lc12.`
2. During the first sleep, type `/spare10 simulate 95`. Wait until the dialog shows.
3. In another terminal, set `pluginConfigs["spare10@inline"].options.reserve` to `11` in `~/.claude/settings.json`.
4. Wait for the tool call of the background agent.
5. Choose Resume in the dialog.
6. Restore the setting.

**Expected:**

- The debug log shows the reload.
- A second question can wait behind the first one.
- One Resume releases the work of both copies within 10 s.
- No second dialog stays on the screen.
- `/tmp/s10-lc12` and `/tmp/s10-lc12-bg` exist.
- After step 5, `/spare10` shows no test reading, and the consent line is `none`.
  The Resume was on a test reading, so it stayed in the copy that asked, and the reload dropped that copy.

**Settles:** a reload while a question is open.

**Leaves:** no consent and no test reading. Start the next check from a new session.

### LC13 Background session

**Start:** no session.
For this check only, add these two entries to the `env` block of `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "SPARE10_SIMULATE": "95" } }
```

Nobody has yet proved that a settings `env` block reaches the plugin in a `--bg` session.
This check settles it.

**Steps:**

1. Run `claude --bg --plugin-dir . "Run sleep 30 then touch /tmp/s10-bg"`.
2. Run `claude agents`.
3. In the agent view, type `resume` as the answer.
4. Remove the two entries from the settings file.

**Expected:**

- The job shows `blocked`, with the question and both labels.
- After `resume`, `/tmp/s10-bg` exists.
- With the default floors, 95% used is at the floor, so the question is the second question.
  If the floors are off in the job, it is the first question. Both pass. Record which one you see.
- The `claude daemon` can start from a session of the start command or the reset start command.
  Then the job also shows the background warning, and the warning names `SPARE10_RESUME_FLOOR` and `SPARE10_WEEKLY_RESUME_FLOOR`.
  Record whether the warning shows.

**Settles:** the flag in settings reaches a `--bg` session, and a reply in the agent view answers the question.

**Leaves:** no session in tmux. Make sure that you removed the settings entries.

### LC14 Badge paint

**Start:** any session from the checks above.

**Steps:**

1. In each phase that you see, capture the footer with its colours: `tmux capture-pane -e -p -t s10 | tail -3`.
2. Change the theme in `/config`, and capture the footer again.

**Expected:**

- The badge is easy to read in each phase.
- The badge colours follow the theme.

**Settles:** how the badge looks.

**Leaves:** the same state as before.

### LC15 Pane teammate

**Start:** a new session with agent teams on, and teammates in tmux panes.

**Steps:**

1. Give a teammate a task with a `sleep 30`.
2. While the teammate works, trip its own copy of spare10. Type `/spare10 simulate 95` in the pane of the teammate.

**Expected:**

- Record whether the lead gets a request.
- Record whether the lead can answer it.
- Until this check passes, docs/how-it-works.md says that pane teammates stop at the reserve.

**Settles:** what a pane teammate does at the reserve.

**Leaves:** unknown. Start the next check from a new session.

### LC16 Badge option off

**Start:** set the badge option to `false`, as a JSON boolean.
Put `"badge": false` in `pluginConfigs["spare10@inline"].options` in `~/.claude/settings.json`.
Then start a new session from the start command.

**Steps:**

1. Look at the right of the footer.
2. Type `/spare10`.
3. Trip as in LC2. Look at the footer before the dialog shows.
4. Choose Stop here. Look at the footer again.
5. Restore the setting.

**Expected:**

- The footer shows no spare10 badge in any phase.
- Nothing blinks in the footer.
- `/spare10` prints the status report as usual.
- The dialog shows, and Stop here works as in LC3.
- The debug log has no `hook failed` line.

**Settles:** with the badge option off, spare10 draws nothing in the footer, and the gate still works.

**Leaves:** the session is stopped. Start the next check from a new session.

## Clean up

After the checks, do these steps:

```sh
rm -f /tmp/s10-* ~/s10-lc18b
tmux kill-session -t s10
claude plugin enable spare10@spare10          # only if you disabled it in Setup
```

Remove any test entries from `~/.claude/settings.json`.

## Results

Add one row for each run of a check.
Keep the old rows.

| Check | Date | Claude Code version | Result | Notes |
|---|---|---|---|---|
| Probe row 0: the 10 s limit on a plugin-noun call | 2026-09-24 | 2.1.281 | settled by the probe, 2026-09-24, 2.1.281 | The host rejected the call after 10012 ms. One wait is not enough. The hold must make the call again. |
| Probe row 1: hold the main loop | 2026-09-24 | 2.1.281 | settled by the probe, 2026-09-24, 2.1.281 | One dialog. The loop waited 60 s over 7 calls. Resume released all calls, and each tool ran. |
| Probe row 2: a background agent trips while the main loop is idle | 2026-09-24 | 2.1.281 | settled by the probe, 2026-09-24, 2.1.281 | The dialog showed over the idle prompt. Three parallel calls waited on one dialog. Stop here denied all three. |
| Probe row 3: another dialog is open | 2026-09-24 | 2.1.281 | settled by the probe, 2026-09-24, 2.1.281 | Dialogs queue. The question showed after the permission dialog closed. |
| Probe row 4: withdrawal | 2026-09-24 | 2.1.281 | settled by the probe, 2026-09-24, 2.1.281 | The dialog left the screen by itself when the answer came another way. |
| Probe row 5: Esc on the dialog | 2026-09-24 | 2.1.281 | settled by the probe, 2026-09-24, 2.1.281 | `$.ui.ask` rejects. spare10 reads this as Stop here. |
| Dialog: the first option has the focus | 2026-09-24 | 2.1.281 | settled by the probe, 2026-09-24, 2.1.281 | A bare Enter picks the first option, Stop here. |
| Dialog: free text | 2026-09-24 | 2.1.281 | settled by the probe, 2026-09-24, 2.1.281 | Typed text returns verbatim. A typed `Resume` returns `Resume`. |
| Dialog: `Chat about this` | 2026-09-24 | 2.1.281 | settled by the probe, 2026-09-24, 2.1.281 | `$.ui.ask` rejects, the same as Esc. |
| Dialog: prompt and footer | 2026-09-24 | 2.1.281 | settled by the probe, 2026-09-24, 2.1.281 | While the dialog is up, Claude Code hides the prompt input and the footer. |
| LC1 Load and command | 2026-09-24 | 2.1.281 | pass, with defects D1, D2 and D4 | The plugin loaded and `/spare10` printed. D1: each notice, warning and reply that starts with `spare10: ` showed `spare10: spare10: ...`. The engine prefix also made the report header read `spare10: spare10 0.1.0`. D2: the reading line said `resets 18:40 · resets in 4 h 4 min`. D4: the phase detail started in another column than the field values. Fixed after this run: run LC1 again. |
| LC2 Hold and Resume | 2026-09-24 | 2.1.281 | pass, with defect D1 | The hold lasted 40 s. The carrier made its call again about every 10 s. Resume ran the held work. D1: the transcript line read `spare10: spare10: continuing on your 10% reserve. ...`. Fixed after this run: run LC2 again. |
| LC3 Stop here, and a Stop hook | 2026-09-24 | 2.1.281 | pass | The stop landed on the Bash call: the Bash call got the STOP text. spare10 then refused the next model request with the PAUSED text. `turn.abort` ended the turn. The blocking Stop hook did not loop. |
| LC5 `/clear` | 2026-09-24 | 2.1.281 | pass, with defect D3 | After `/clear`, `/spare10` no longer showed stopped. D3: the badge still showed `■ spare10 (test): stopped`, because nothing drew it again. Fixed after this run by the `session.end` hook: run LC5 again. |
| LC4 Prompt question | 2026-09-24 | 2.1.281 | pass | The question came from `prompt.submit`. Stop here dropped the prompt and put the text back in the box. Resume let the prompt in with the resume note. |
| LC6 Unattended stop | 2026-09-24 | 2.1.281 | pass | `result` was the HEADLESS text. The run used 0 tokens. The exit code was 0. |
| LC7 Tell mode | 2026-09-24 | 2.1.281 | pass | spare10 told the subagent and the main loop one time each. No dialog showed. |
| LC8 Background agent and parallel loops | 2026-09-24 | 2.1.281 | pass | spare10 held the background agent over an idle prompt. Resume continued it. |
| LC1 Load and command, after the fixes | 2026-09-24 | 2.1.281 | pass | The header read `spare10: version 0.1.0`. No line showed `spare10: spare10:`. The reading line said `resets 18:40 (in 2 h 21 min)`. Every value started in one column. |
| LC2 Hold and Resume, after the fixes | 2026-09-24 | 2.1.281 | pass | A typed prompt was held for 26 s. The carrier made its call again 2 times. The debug log had no budget error. Resume let the prompt in. |
| LC3 Stop here, after the fixes | 2026-09-24 | 2.1.281 | pass | The held Bash call got the STOP text. The next model request got the PAUSED text. The transcript line read `spare10: stopped at your 10% reserve. ...` with one prefix. |
| LC5 `/clear`, after the fixes | 2026-09-24 | 2.1.281 | pass | The badge changed from `■ spare10 (test): stopped` to a blinking `⚠ Pausing at next step` about 3 s after `/clear`. |
| LC4 Prompt question, after the fixes | 2026-09-24 | 2.1.281 | pass | The prompt question showed. Resume let the prompt in, and the badge showed `⨯ spare10 (test)`. The debug log had no hook failure, overrun or respawn. |
| LC9 Keys on the dialog | | | | Record what `2` and Ctrl-C do. |
| LC10 Lost raiser | | | | |
| LC11 Question time limit | | | | |
| LC12 Reload with the dialog up | | | | |
| LC13 Background session | | | | |
| LC14 Badge paint | | | | |
| LC15 Pane teammate | | | | Record how you tripped the teammate. Record whether the lead gets a request and can answer it. |
| LC16 Badge option off | | | | |
| LC1 Load and command, 0.2 | | | | Record the weekly rows and the weekday in the weekly reading line. |
| LC2 Hold and Resume, 0.2 | | | | |
| LC3 Stop here, and a Stop hook, 0.2 | | | | |
| LC5 `/clear`, 0.2 | | | | |
| LC4 Prompt question, 0.2 | | | | |
| LC6 Unattended stop, 0.2 | | | | |
| LC7 Tell mode, 0.2 | | | | |
| LC8 Background agent and parallel loops, 0.2 | | | | |
| LC17 Weekly question | 2026-09-24 | 2.1.281 | pass | Real REPL, worker host. The dialog had the weekly wording with a weekday clock. Resume ran the held work. The `weekly consent` line of `/spare10` was as expected. |
| LC18 A question continues at the reset | 2026-09-24 | 2.1.281 | pass | Real REPL, worker host. Nobody answered the question on a 2-minute test window. spare10 released it 61 s after the test window ended. The dialog left the screen by itself. The transcript showed `the test window ended. Held work continues.` The held tool call ran. The logs had no hook failure and no budget error. |
| LC18b Behind a permission dialog | | | | Record whether the question leaves the queue at the reset, or stays. |
| LC19 Stop here, then the resume prompt | 2026-09-24 | 2.1.281 | pass | Real REPL, worker host. After Stop here, the test window ended and its margin passed. Then the ticker sent the resume prompt with `$.prompt.submit`. It started a new turn. The transcript framed it as `This is how Claude Code surfaces a prompt a plugin submits between turns`. The model finished the task. The logs had no hook failure and no budget error. |
| LC19b The prompt box at the reset | | | | Record whether `new instruction` stays in the prompt box. |
| LC20 Continue at the reset off | | | | |
| LC21 Unattended wait | 2026-09-24 | 2.1.281 | pass | `-p` run with `SPARE10_HEADLESS=wait`, worker host. The hold lasted about 200 s, with 17 carrier re-arms. spare10 released it after the test window ended. The run ended with exit code 0 and a success result. The logs had no hook failure and no budget error. |
| LC19 Stop here, then the resume prompt, after the review fixes | 2026-09-24 | 2.1.281 | pass | The stop notice said `until 23:46`. The resume prompt came at 23:48:09, 83 s after the test window ended. The model created all three files. No hook failure, budget error or turn-hold refusal. |
| LC21 Unattended wait, after the review fixes | 2026-09-24 | 2.1.281 | pass | The run took 199 s with 17 carrier re-arms, released at the test window end plus the margin, and exited 0. The watch timer did not keep the process alive. |
| LC22 `/clear` and the stop | | | | Record whether a resume prompt reached the new conversation in the second part. |
| LC23 Reload during a stop | | | | Record the badge after the reload. |
| LC24 Two windows | | | | Record how you set the weekly test reading in the second part. |
| LC25 Hold budget | | | | Record the budget in each line, the cost of one cycle and the longest hold. |
| LC17 Weekly question, reset start command | | | | Run again on the build with the open times: the reset path code moved. |
| LC18 A question continues at the reset, reset start command | | | | Run again on the build with the open times. |
| LC19 Stop here, then the resume prompt, reset start command | | | | Run again on the build with the open times. |
| LC21 Unattended wait, reset start command | | | | Run again on the build with the open times. |
| LC26 The reserve opens near the reset | | | | Record the time from OPEN to the release. |
| LC27 Stop here, then the reserve opens | | | | Record the time from OPEN to the resume prompt. |
| LC28 Continue at the reset off, near the reset | | | | Record whether you used a remote surface for step 4. Record whether the turn ended after the STOP text. |
| LC29 No stop while the reserve is open | | | | |
| LC30 Unattended wait and the weekly open time | | | | Record the run time. |
| LC31 An option change during a question | | | | |
| LC1 Load and command, 0.3 | | | | Record the `resume floor` and `weekly floor` rows. |
| LC32 The second question | 2026-09-25 | 2.1.282 | pass, prompt variant | Prompt questions, not a held Bash call. `simulate 91` and a prompt gave the first question, "Continue on the reserve until 95% used?". After Resume the badge read `resumed until 95% used`. `simulate 96` and a prompt gave "Your 5% floor is reached: 96% used · 4% left", with "Continue on the last 4% until 21:20?". A second Resume gave a full consent, and the badge read `⨯ spare10 (test)`. No hook failure or budget error. |
| LC33 Stop here at the second question | | | | Record whether the stop landed on the Bash call or on the model request. |
| LC34 `/spare10 resume` before and past the floor | | | | |
| LC35 Tell mode at the floor | | | | Record whether the model stopped after the floor instruction. |
| LC36 Options and variables | | | | |
| LC37 Unattended runs with an inherited consent to the floor | | | | Record the exit code of each run. |

The run of 2026-09-24 found defects D1 to D4.
The fixes change the texts of LC1, LC2 and LC5, and the badge after `/clear`.
Run LC1, LC2 and LC5 again before the first release, and add a new row for each run.

spare10-mod 0.2 changes the texts of LC1, LC2, LC3, LC4, LC5 and LC11.
Before the 0.2 release, run the release gate again and add a new row for each run.
The open reserve near the reset changes the texts of LC1, LC2, LC3, LC4, LC5 and LC11 again.
It also moves the code of the reset path.
So run LC17, LC18, LC19 and LC21 again with the reset start command, and run LC26 to LC31.

spare10-mod 0.3 adds the resume floor.
The start command and the reset start command switch the floors off.
So the texts of LC1 to LC31 stay as in 0.2, except the version and the floor rows of LC1.
Before the 0.3 release, run the release gate again, with LC32 to LC37.
Add a new row for each run.
