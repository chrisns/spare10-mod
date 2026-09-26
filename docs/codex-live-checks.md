# Codex live checks

This runbook lists the Codex checks that only a real Codex TUI can settle.
A person or a tmux-driven agent runs them.
The Codex tests (`codex/test/*.spec.ts`) and the end-to-end runs (`codex/e2e/`) cannot show the TUI screen.
They cannot show the form, the status row, the `↳ Hook` lines or the `!` shell prefix.

Every check runs the real `codex` against a local mock provider, in an isolated `CODEX_HOME`.
No check sends a request to a real model, and no check spends quota.
Only LCX-REAL reads the real account, and it makes no model request.

**Release gate.**
LCX1 to LCX8, LCX11, LCX17 and LCX-REAL must pass before the Codex PR leaves draft.
They must also pass before each release and after each update of Codex.
LCX9, LCX10, LCX12 to LCX16, LCX18 and LCX19 belong to the P1 features.
Run each one when its feature ships.
LCX14 and LCX19 are optional.

Run the checks in the order of this file: LCX1, LCX2, LCX17, then LCX3 to LCX8 and LCX11.
Each check states the state that it starts from and the state that it leaves.
Record each result in the [results table](#results), with the date and the Codex version.

## Settled by the probes

The research probes ran these checks on Codex CLI 0.157.0.
They used isolated homes and a mock provider.
Do not run them again for spare10.

- A form from a `UserPromptSubmit`, `PreToolUse` or `PostToolUse` hook shows, and its answer applies.
- A `systemMessage` with several lines shows every line.
- A `!` command does not see shell aliases. An exported `PATH` from the shell profile reaches it.
- A `!` command runs beside a running turn. Its env has `CODEX_SESSION_ID` and `CODEX_THREAD_ID`. The model reads its output at the next request.
- A second client can interrupt a turn of a TUI thread and start a new turn. The interrupt sends no model request.
- An `mcp_tool` hook on `Interrupt` gets the id of the turn that ended. Its line shows above `■ Conversation interrupted`.
- A held hook call lasted 1200 s with no error. LCX15 checks longer holds.

## Safety

- Never use your real `~/.codex` for LCX1 to LCX19.
- Never type a test prompt in a real Codex session. If a gate fails, Codex sends the prompt to the model.
- The isolated home has no `auth.json`. Its model provider is the mock.
- Every command below sets `HOME` and `CODEX_HOME` to the isolated home.

## Setup

You need `codex-cli 0.157.0`, Node.js 22.18 or later, `python3` and `tmux`.
Every `codex` command, also `codex --version`, writes to its `CODEX_HOME`.
So each command below sets `CODEX_HOME`, and never uses `~/.codex`.
Do these steps once, before the first check:

```sh
cd spare10-mod                                    # the repo root
mkdir -p /tmp/s10ver && env HOME=/tmp/s10ver CODEX_HOME=/tmp/s10ver codex --version   # must print codex-cli 0.157.0
npm ci
npm run build:codex                               # codex/dist must match the branch
scripts/check.sh                                  # must be green first
W=$(mktemp -d /tmp/s10lc-XXXXXX)                  # a short work folder, for the socket path limit
H="$W/home"                                       # the isolated HOME and CODEX_HOME
P="$W/project"                                    # the trusted project folder
```

Write the quota that the mock reports.
The 5-hour window is at 10% and resets in 4 hours.
The weekly window is at 50% and resets in 3 days:

```sh
now=$(date +%s)
cat > "$W/limits.json" <<EOF
{"x-codex-primary-used-percent": 10, "x-codex-primary-window-minutes": 300, "x-codex-primary-reset-at": $((now + 14400)),
 "x-codex-secondary-used-percent": 50, "x-codex-secondary-window-minutes": 10080, "x-codex-secondary-reset-at": $((now + 259200))}
EOF
```

The world has a 5-hour window on purpose.
On a plan with only a weekly window, `spare10 simulate` sets a weekly test reading.
The weekly open time then opens a short test window at once, and spare10 does not ask.

Start the mock provider and make the home:

```sh
python3 codex/e2e/mock_responses.py "$W" > "$W/mock.out" 2>&1 &   # writes $W/port, logs to $W/requests.jsonl
echo $! > "$W/mock.pid"
node codex/e2e/home.mjs --keep --no-trust --work "$W"               # makes $H and $P, stages the plugin, trusts no hook
printf '%s\n' "export PATH=\"$H/plugins/data/spare10-spare10/bin:\$PATH\"" > "$H/.zshrc"
tmux -L s10lc new-session -d -s lcx -n tui -x 200 -y 50
tmux -L s10lc new-window -d -t lcx -n daemon
tmux -L s10lc new-window -d -t lcx -n cli
```

The `.zshrc` holds only the `PATH` line, with no alias.
Codex takes a snapshot of this shell for each new session.

The last user text of a prompt picks the reply of the mock:

| Prompt | Reply of the mock |
|---|---|
| `TOOL` | One `exec_command` (`echo e2e`), then a final message. |
| `LONG` | One `exec_command` that sleeps 15 s, then `write_stdin` checks, then a final message. |
| `SLOW` | A final message after 20 s. |
| `SPAWN` | One subagent, whose first message is `CHILDTOOL`. |
| any other text | `ok` |

If Codex asks you to approve a command of the mock, approve it.

This is the **embedded start command**.
It runs the TUI without the Codex daemon:

```sh
tmux -L s10lc send-keys -t lcx:tui "cd $P && env HOME=$H CODEX_HOME=$H SPARE10_CODEX_TEST=1 SPARE10_CODEX_DEBUG=1 codex --no-daemon" Enter
```

This is the **daemon start command**.
It starts an app-server on the socket of the home, then a TUI on that socket:

```sh
tmux -L s10lc send-keys -t lcx:daemon "cd $H && env HOME=$H CODEX_HOME=$H SPARE10_CODEX_TEST=1 SPARE10_CODEX_DEBUG=1 codex app-server --listen unix://" Enter
S=$(realpath "$H/app-server-control/app-server-control.sock")    # wait until the socket exists
tmux -L s10lc send-keys -t lcx:tui "cd $P && env HOME=$H CODEX_HOME=$H SPARE10_CODEX_TEST=1 codex --remote unix://$S" Enter
```

The daemon start command uses `--remote`, because the implicit daemon needs a managed install.
A session on the daemon gets its variables from the app-server, not from the TUI command.

Both start commands set `SPARE10_CODEX_TEST=1`.
Codex passes it to each spare10 broker, and the broker then refuses every path under `~/.codex`.
The broker log says `the test guard is on` when the broker starts.

To start a new session, type `/quit` in the old session, then send a start command again.

This is the **status command**.
It prints the report of the newest session from a plain terminal, outside the TUI:

```sh
tmux -L s10lc send-keys -t lcx:cli "env HOME=$H CODEX_HOME=$H $H/plugins/data/spare10-spare10/bin/spare10 status" Enter
tmux -L s10lc capture-pane -p -t lcx:cli | tail -30
```

It adds no prompt and no turn to the session.
So it cannot change what spare10 does at the end of a stop.

Read the screen, the mock log and the broker log after each step:

```sh
tmux -L s10lc capture-pane -p -t lcx:tui | tail -40
wc -l < "$W/requests.jsonl"                                  # the number of model requests
tail -1 "$W/requests.jsonl"                                  # the last model request
tail -20 "$H"/plugins/data/spare10-spare10/log/broker-*.log  # the debug lines of spare10
```

In the texts below, `HH:MM` is a reset time or the end of a test window.

## P0 checks

### LCX1 Trust the hooks

**Mode:** embedded.

**Start:** the new home from Setup. Nobody trusted the spare10 hooks yet.

**Steps:**

1. Send the embedded start command.
2. Choose **Trust all and continue**.
3. Type `/hooks`.

**Pass when:**

- The TUI shows **Hooks need review** before the session starts.
- **Trust all and continue** starts the session.
- `/hooks` lists nine spare10 hooks, and all nine are trusted.

**Record:** the spare10 lines that the transcript shows at the start.

**Leaves:** the session runs, and the hooks are trusted in this home.

### LCX2 The report

**Mode:** embedded.

**Start:** the session from LCX1.

**Steps:**

1. Send `hello`, so that the session log has a reading.
2. Note the number of model requests.
3. Type `spare10` as the whole prompt, and press Enter.

**Pass when:**

- The TUI shows `• Blocked by hook` with the whole report.
- The first line is `spare10: version` and the plugin version.
- The report has the phase row and these rows: `reserve`, `weekly reserve`, `reserve opens`, `weekly opens`, `resume floor`, `weekly floor`, `at the reserve`, `at the reset`.
- It also has these rows: `reading`, `weekly reading`, `consent`, `weekly consent`, `guarded`, `codex exec`, `daemon`, `live read`, `cli`.
- The option rows say `(from spare10 set)`.
- The `daemon` row reads `no. After Stop here, spare10 holds the work in place.`
- The `cli` row shows `~/plugins/data/spare10-spare10/bin/spare10`, because `$H` is the home folder here.
- The last lines are the help lines for `spare10 resume`, `spare10 stop`, `spare10 set` and `!spare10 status`.
- No line shows `spare10: spare10:`.
- The number of model requests did not change.

**Leaves:** the session runs, with no test reading.

### LCX17 The `PATH` line

**Mode:** embedded.

**Start:** the session from LCX2. The `.zshrc` of the home has only the `PATH` line, with no alias.

**Steps:**

1. Type `/quit`, then send the embedded start command.
2. Type `!spare10 status`, and press Enter.

**Pass when:**

- `!spare10` runs, with no `command not found`.
- The output is one line that starts with `spare10:`.

**Leaves:** a new session runs, with no test reading.

### LCX3 Hold and Resume

**Mode:** embedded.

**Start:** the session from LCX17, with no test reading and no consent.

**Steps:**

1. Type `spare10 simulate 92`.
2. Send `TOOL`.
3. Wait until the form shows. Then choose **Resume**.

**Pass when:**

- The form shows the question, then the field `spare10`, then `› 1. Stop here` and `2. Resume`.
- **Stop here** is first, and it is selected.
- For a moment, the status row shows `spare10 checks the quota reserve. Esc stops a held step.`
- After **Resume**, the tool runs, and `↳ Hook · spare10: continuing on ...` shows.

The question of this check is the prompt question, because the test reading trips before the prompt.
Its text ends with `Stop here drops your prompt and pauses other work until HH:MM.`

**Leaves:** the session runs with a consent. Type `spare10 simulate off` to clear it.

### LCX4 Stop here on the daemon

**Mode:** daemon.

**Start:** a new session from the daemon start command, with no test reading.

**Steps:**

1. Type `spare10 set lastMinutes 0`.
2. Send `LONG`.
3. While the command sleeps, type `!spare10 simulate 92 in 1m`, and press Enter.
4. When the form shows, choose **Stop here** at once.
5. Send the status command.
6. Wait 3 minutes. Do not type in the TUI.

**Pass when:**

- `↳ Hook · spare10: stopped at your 10% reserve until ...` shows above `■ Conversation interrupted`.
- After the interrupt, the mock log gets no new request.
- The report of step 5 shows the phase `stopped`.
- About 2 minutes after step 4, a new turn starts by itself.
- Its prompt starts with `spare10: the note that the user interrupted the previous turn is not right.`
- The B34 text follows: `... so the stop at the quota reserve is over. ...`.
- `↳ Hook · spare10: the test window ended. spare10 continues the stopped work.` shows.
- The model request of that turn has Codex's note `The user interrupted the previous turn on purpose.`, then the spare10 note after it.

**Leaves:** the session runs. Type `spare10 set lastMinutes default` and `spare10 simulate off`.

### LCX5 Stop here without the daemon

**Mode:** embedded.

**Start:** a new session from the embedded start command, with no test reading.

**Steps:** the steps of LCX4.

**Pass when:**

- At the start, the transcript shows `↳ Hook · spare10: this session does not run on the Codex daemon, so spare10 cannot end a turn or start one. ...`
- After **Stop here**, the status row keeps `spare10 checks the quota reserve. Esc stops a held step.` The work is on hold.
- After the test window and its margin, the held work continues by itself.
- `↳ Hook · spare10: the test window ended. Held work continues.` shows.

**Leaves:** the session runs. Type `spare10 set lastMinutes default` and `spare10 simulate off`.

### LCX6 Esc on the form

**Mode:** embedded.

**Start:** the session from LCX5, with no test reading.

**Steps:**

1. Send `LONG`.
2. While the command sleeps, type `!spare10 simulate 92`, and press Enter.
3. When the form shows, press Esc.
4. Wait 30 s. Then press Esc again.

**Pass when:**

- Esc on the form counts as **Stop here**.
- The status row stays, and the work is on hold.
- The second Esc ends the turn.

**Leaves:** the session is idle, with a stop in force. Type `spare10 simulate off` to clear it.

### LCX7 Commands with `!` during a hold

**Mode:** embedded.

**Start:** the session from LCX6.

**Steps:**

1. Make the hold of LCX6 again: send `LONG`, type `!spare10 simulate 92` while the command sleeps, and press Esc on the form.
2. Type `!spare10 status`.
3. Type `!spare10 status --full`.
4. Type `!spare10 resume`.

**Pass when:**

- `!spare10 status` prints one line, and the hold goes on.
- `!spare10 status --full` prints the report, and the hold goes on.
- `!spare10 resume` prints one line: `spare10: resume done. The details show in the Codex transcript.`
- Then the held work continues.
- The full reply of the resume shows as a `↳ Hook · spare10:` line.
- The next mock request has a `<user_shell_command>` text.

**Record:** the size of the `<user_shell_command>` text in bytes.

**Leaves:** the session runs with a consent. Type `spare10 simulate off`.

### LCX8 Approval `never`

**Mode:** embedded, with approval `never`.

**Start:** a new session from the embedded start command, with `-a never` after `--no-daemon`.

**Steps:**

1. Send `LONG`.
2. While the command sleeps, type `!spare10 simulate 92`, and press Enter.
3. Wait 30 s. Then type `!spare10 resume`.
4. When the turn ends, type `spare10 simulate 92`, then send `hello`.

**Pass when:**

- At the start, the transcript shows `↳ Hook · spare10: Codex runs with approval never here, so spare10 cannot show its question. ...`
- No form shows.
- The status row shows `spare10 checks the quota reserve. Esc stops a held step.` The work is on hold.
- `!spare10 resume` releases the held work.
- The prompt `hello` is blocked with `spare10: not started. This session is inside your 10% reserve ...`
- That text ends with `Codex cannot show the spare10 question here. Run spare10 resume, then send the prompt again.`

**Leaves:** the session is idle, with a stop in force. Type `/quit`.

### LCX11 A command during a turn

**Mode:** embedded.

**Start:** a new session from the embedded start command, with no test reading.

**Steps:**

1. Send `SLOW`.
2. While the turn runs, type `spare10 status`, and press Enter.

**Pass when:**

- After the next step, `↳ Hook · spare10: version ...` shows.
- The turn goes on, and it ends as usual.
- The next model request has the text `spare10: the last user line was a command for the spare10 plugin, and spare10 handled it. Ignore that line.`

**Leaves:** the session runs, with no test reading.

### LCX-REAL The real account, with no quota spent

The owner's weekly window can be almost used up.
This check makes no model request. It only reads.
Run it only with the consent of the owner.

1. Build the bundle on the branch: `npm run build:codex`.
2. Check that the real daemon runs: `ls -l ~/.codex/app-server-control/app-server-control.sock`.
   If the socket does not exist, stop here. This version has no other live route, and the check needs one.
3. From a plain terminal, run `node codex/dist/cli.mjs status --codex-home ~/.codex --data /tmp/s10real`.
   The terminal must not set `SPARE10_CODEX_TEST` or `CODEX_THREAD_ID`.
   Wait 31 seconds, and run the same command again.
   spare10 knows that a window is absent only after two live reads.
4. The check passes when all of these are true for the second output:
   - The `live read` row says `from the Codex daemon`.
   - The `reading` row says `none: Codex reports no 5-hour window for this plan`.
   - The `weekly reading` row shows the real percent and the real reset.
   - The phase is `tripped` when the weekly reading is at 90% or more.
   - The `session` row says `none`, and the `daemon` row says `reachable`.
   - `/tmp/s10real` holds only `live.json` and `seed.json`, and `live.lock` is gone. The CLI writes no launcher.
   - Nothing under `~/.codex` changed. This command lists nothing from spare10:
     `find ~/.codex -newer /tmp/s10real/live.json -not -path '*/sessions/*' -not -name '*.sqlite*'`
5. Remove `/tmp/s10real`.

The daemon call is the read-only `account/rateLimits/read`, with `excludeResetCreditDetails: true`, on one short connection.
It spends no quota.

Installing the plugin into the real `~/.codex` is the choice of the owner, after the P0 checks pass.
Until then, no check runs the plugin on the real home.

## P1 checks

These checks belong to the P1 features.
Their steps can change when those features ship.

| Id | Mode | Steps | Pass when |
|---|---|---|---|
| LCX9 | embedded | `spare10 simulate 91 in 1h`, `TOOL`, **Resume**, `spare10 simulate 96`, `TOOL`. | The second question shows: `Your 5% floor is reached: 96% used ... Continue on the last 4% until ...?` |
| LCX10 | embedded | `spare10 simulate 92`, then `SPAWN`. | The form of the subagent shows on the main screen. After **Resume**, the tool of the subagent runs. |
| LCX12 | embedded | `spare10 simulate 92`, then `/compact`. | The form shows before the compaction request. After **Stop here**, `Hook stopped` shows with `spare10: the turn ends here, because work stopped at the quota reserve.`, then `Conversation interrupted`. No request goes out. |
| LCX13 | daemon | Make two lines wait for the next hook, such as the stop line of LCX4 and a warning. | Each line shows with its own `spare10:` prefix. This is a visual check only. |
| LCX14 | managed daemon, optional | Hold at a tool call. Then run `codex app-server daemon restart`. | After the TUI connects again, the form shows again. |
| LCX15 | daemon | Hold for 5 hours with no question, such as `SPARE10_HEADLESS=wait` on an unattended client, or a held stop. | After 5 hours the hook call is still open. It answers at the release. Codex shows no hook error. |
| LCX16 | terminal | Run `codex exec` with each `SPARE10_HEADLESS` policy. | The texts and exit codes of the unattended policies are correct. |
| LCX18 | embedded | Hold at a tool call. Then change `/permissions`. In a second run, change the folder. In a third run, update the plugin to a new version. | Record whether the held hook call stays, lets the work through, or refuses the work. Update docs/codex.md when a case lets the work through. |
| LCX19 | desktop app or IDE, optional | Start a thread from a host whose `PATH` has no `node`, with Node.js in `/opt/homebrew/bin` or in nvm. | `codex/bin/broker.sh` finds Node.js, and the thread starts. With no Node.js at all, the thread fails with the error line of `broker.sh`. |

## Clean up

After the checks, do these steps:

```sh
tmux -L s10lc kill-server
kill "$(cat "$W/mock.pid")"                       # the mock provider
rm -rf "$W"
```

## Results

Add one row for each run of a check.
Keep the old rows.

| Check | Date | Codex version | Result | Notes |
|---|---|---|---|---|
| LCX1 Trust the hooks | 2026-09-26 | codex-cli 0.157.0 | pass | A tmux-driven agent ran LCX1 to LCX11 in a home in its scratchpad folder. The TUI showed "9 hooks are new or changed". `/hooks` listed nine events, each with 1 installed and 1 active hook. The first prompt showed CX6 and CX19. |
| LCX2 The report | 2026-09-26 | codex-cli 0.157.0 | pass | The whole report showed under `• Blocked by hook`. The mock log stayed at 2 requests. No line showed `spare10: spare10:`. |
| LCX17 The `PATH` line | 2026-09-26 | codex-cli 0.157.0 | pass | `!spare10 status` printed `spare10: ● armed ...` on one line. |
| LCX3 Hold and Resume | 2026-09-26 | codex-cli 0.157.0 | pass | The prompt question showed, with **Stop here** first and selected. The agent looked every 0.5 s and did not see the short status row before the form. The same row showed in each hold of LCX5 to LCX8. |
| LCX4 Stop here on the daemon | 2026-09-26 | codex-cli 0.157.0 | pass | The new turn started 1 min 56 s after Stop here. Its request had the Codex note, then the spare10 note. The live read failed, because the test home has no login. |
| LCX5 Stop here without the daemon | 2026-09-26 | codex-cli 0.157.0 | pass | The held work continued 1 min 48 s after Stop here. |
| LCX6 Esc on the form | 2026-09-26 | codex-cli 0.157.0 | pass | Esc wrote the answer `stop` by `dialog`. The hold went on for 52 s. The second Esc ended the turn, and the stop line showed. |
| LCX7 Commands with `!` during a hold | 2026-09-26 | codex-cli 0.157.0 | pass | The `<user_shell_command>` texts: `status` 287 bytes, `status --full` 2191 bytes, `simulate 92` 215 bytes. The report showed the ticker warning while the work was on hold. This stage removed that warning for held work. |
| LCX8 Approval `never` | 2026-09-26 | codex-cli 0.157.0 | pass | The start showed CX6 and CX8. `hello` was blocked with the text of 2.7, and the mock log got no request. |
| LCX11 A command during a turn | 2026-09-26 | codex-cli 0.157.0 | pass | Codex kept `spare10 status` until the model reply of `SLOW`. Then each report line showed with its own prefix, and the next request had CX4. |
| LCX-REAL The real account | 2026-09-26 | Codex 0.157.0 CLI, managed daemon 0.157.1 | pass | Two reads 31 s apart from the Codex daemon. The 5-hour row read `none: Codex reports no 5-hour window for this plan`. The weekly row read 97% used, resets Tue 15:52. The phase was tripped. The data folder held only `live.json` and `seed.json`. Nothing under `~/.codex` changed. Note: the `cli` row names a launcher path that the CLI does not write. |
| LCX9 The second question (P1) | | | | |
| LCX10 A question of a subagent (P1) | | | | |
| LCX12 Compaction (P1) | | | | |
| LCX13 Two lines at one hook (P1) | | | | |
| LCX14 Daemon restart (P1, optional) | | | | |
| LCX15 A hold of 5 hours (P1) | | | | |
| LCX16 `codex exec` policies (P1) | | | | Record the exit code of each run. |
| LCX18 Broker replaced during a hold (P1) | | | | Record what each of the three runs did. |
| LCX19 A host with no `node` on `PATH` (P1, optional) | | | | Record the host. |
