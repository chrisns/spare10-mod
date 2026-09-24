# spare10-mod

A quota circuit breaker for Claude Code, built as a mod.
It keeps the last part of your 5-hour quota window for you.

The idea comes from [spare10](https://github.com/alesdi/spare10) by Alessandro Diano.
spare10 wraps the `claude` command and stops Claude Code before the quota runs out.
spare10-mod keeps the idea and moves it into Claude Code, as a plugin with function hooks.
Many texts and rules come from spare10.
Thank you, Alessandro.

spare10-mod is early access software.
It uses function hooks, an early access feature of Claude Code 2.1.281.
The plugin name is `spare10`.

## Quick start

1. Switch on function hooks. Add this to `~/.claude/settings.json`:

   ```json
   { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
   ```

2. Install the plugin:

   ```sh
   claude plugin marketplace add chrisns/spare10-mod
   claude plugin install spare10@spare10
   ```

3. Start a new Claude Code session. Type `/spare10` to see the status.

To see the question without spending quota, type `/spare10 simulate 95`, then send a prompt.
Type `/spare10 simulate off` to clear the test reading.
[Before you start](#before-you-start) tells you what the settings change does.

## Screenshots

The badge at the right of the prompt footer, and the `/spare10` report:

![The /spare10 report](docs/images/status.png)

At the reserve, spare10 holds the work and asks you:

![The question at the reserve](docs/images/question.png)

After **Stop here**, the work ends at its next step and the session stays open:

![The session after Stop here](docs/images/stopped.png)

## What spare10 does

At the reserve (by default the last 10% of the 5-hour window), spare10 holds all work at the next step.
It then asks you one question in the Claude Code dialog: **Stop here** or **Resume**.
**Resume** continues all held work from the point where it stopped.
**Stop here** ends the work at its next step, but the session stays open.
The question waits for your answer with no time limit, also after the window resets.


## Before you start

You need Claude Code 2.1.281.
spare10-mod targets this version only.
Function hooks are early access.
A later version can change their API without notice.

Function hooks are off by default.
To switch them on, put this block in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

This setting switches on function hooks for **every** installed plugin that has a hooks module.
It applies in every session.
spare10 did not change `~/.claude`, so this step is new in spare10-mod.

You can use a narrower route, but each route has a cost:

- `claude --settings <file>` switches on function hooks for one launch only.
  A `claude --bg` launch also needs `--settings`.
  Pane teammates probably get the `--settings` file of the lead too.
- The `env` block of a project's `.claude/settings.json` switches them on for that project only.
- A flag that you set only in the shell does not reach `--bg` sessions or pane teammates.
  spare10 warns you about this at the start of a session.
  A flag in a settings file or a `--settings` file gives no warning.

## Install

Add the marketplace, then install the plugin:

```sh
claude plugin marketplace add chrisns/spare10-mod   # or the path to a local clone
claude plugin install spare10@spare10
```

Start a new session and type `/spare10` to see the status.

To develop, load the plugin from the repo folder.
First disable the installed copy, if you have one:

```sh
claude plugin disable spare10@spare10
claude --plugin-dir .
```

Both copies add the same `$.spare10` noun.
When both load, one of them unloads.

## Use

### The question

At the reserve, spare10 holds each loop at its next tool call or model request.
This includes the main loop, subagents, background agents, workflow agents and in-process teammates.
A tool that already runs is never cut.
The first held step opens one question for the whole session.
All other held steps join it.

```
 ☐ spare10
Your 10% reserve is reached: 91% used · 9% left · resets 14:00. All work is on hold. Continue on the reserve until 14:00?
❯ 1. Stop here
  2. Resume
  3. Type something.
  4. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
```

**Stop here** has the focus, so a stray Enter never spends the reserve.
Only the exact label `Resume` continues.
A typed `Resume` under `Type something.` also continues.
All other answers are **Stop here**: Esc, `Chat about this`, other text, and a dialog that closes with no answer.

**Resume**:

- Each held tool call runs.
- Each held model request goes out.
- A held prompt enters.
- The model reads nothing extra, because it does not know that it waited.
- spare10 stays quiet until the window resets.
- The transcript shows `spare10: continuing on your 10% reserve. spare10 stays quiet until 14:00.`

**Stop here**:

- spare10 denies each held tool call.
- spare10 answers each held model request itself, and sends no request.
- spare10 ends the main turn, so a Stop hook cannot start the loop again.
- spare10 refuses all later steps until the window resets or you continue.
- The session stays open and idle.
- The transcript shows `spare10: stopped at your 10% reserve. Type a prompt to be asked again, or run /spare10 resume.`

The model reads one of these texts after a Stop:

```
spare10: the user stopped work at the quota reserve (into your 10% reserve · 9% of quota left · resets 14:00). Stop now and wait for the user. Do not call any further tools.
spare10: work stopped at the quota reserve (into your 10% reserve · 9% of quota left · resets 14:00). No model request was sent, so this task is not finished. Wait for the user.
```

If nobody answers, the held work waits.
The window reset does not release it and does not stop it.
At the reset, the transcript shows `spare10: the 5-hour window reset. Held work still waits for your answer.`

A question time limit turns an unanswered question into **Stop here**.
See [Configure](#configure).

### Your prompts

Inside the reserve, spare10 asks before your prompt enters.
The question then says `spare10 holds your prompt and any other work.`
**Resume** lets the prompt enter.
After a stop, the prompt also carries a short note.
The note tells the model that you chose to continue.
**Stop here** drops the prompt, and Claude Code shows this line:

```
Prompt dropped by a hook: spare10: not started. This session is inside your 10% reserve until 14:00. Send the prompt again to be asked again, or run /spare10 resume.
```

spare10 then puts your text back in the prompt box, if the box is empty.

spare10 never asks about prompts that nobody typed, such as task notifications or scheduled prompts.
These prompts enter.
spare10 then gates their model requests like all other steps.

### The pause prompt

Set a pause prompt to tell the agents to wind down instead of stopping them.
Then spare10 does not hold the agents.
It holds only a prompt that you send before the main loop gets the instruction.
Each loop gets this text once per window, on its next tool result:

```
spare10 budget guard. You have reached the safe usage limit for this session (into your 10% reserve · 9% of quota left · resets 14:00). Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.

User instructions: Finish this block, commit, then stop.
```

The tool still runs.
The transcript shows `spare10: your 10% reserve is reached. spare10 told the agents to wind down.` once per window.
Until the main loop gets the instruction, a prompt that you send still asks first.
Its question says `spare10 holds your prompt.`
If you choose **Resume**, no agent gets the instruction in that window.
If you choose **Stop here**, spare10 drops the prompt and puts the text back.
Nothing else stops.

### The badge

The badge is at the right of the prompt footer, in the terminal and the desktop app.
Its colours follow your theme.
The label is `spare10`, or `spare10 (15%)` when the reserve is not 10.
While a test reading applies, the label ends with ` (test)`.
The rows without a label, such as `⚠ Pausing at next step`, show no ` (test)`.

| Badge | Meaning |
|---|---|
| `○ spare10 off` | spare10 is not enabled in this run. It only watches. |
| `? spare10: waiting for you` | A question is open. Held work waits for your answer. |
| `⚠ spare10 quota unavailable` | Claude Code reports no 5-hour quota. spare10 lets all work through. |
| `⧗ spare10` | There is no reading yet. spare10 lets all work through. |
| `● spare10` | Usage is below the reserve. |
| `⨯ spare10` | You chose to continue. spare10 is quiet until the window resets. |
| `■ spare10: stopped` | You chose **Stop here**. |
| `⏸ spare10` | At least one agent got the pause prompt. |
| `⚠ spare10: in the reserve` | An unattended run is inside the reserve. |
| `⚠ Pausing at next step` | Usage reached the reserve. spare10 holds the next step and asks you. The glyph blinks. |
| `⚠ Winding down at next step` | Usage reached the reserve. Each agent gets the pause prompt at its next tool result. The glyph blinks. |

While the dialog is on the screen, Claude Code hides the footer.
So the `?` badge shows only when the dialog waits behind another dialog, or when no dialog could show.
The vscode and mobile surfaces have no footer, so there the dialog is the only sign.

### The `/spare10` command

| Command | What it does |
|---|---|
| `/spare10` or `/spare10 status` | Shows the phase, the reserve, the reading, the consent and any warnings. |
| `/spare10 resume` | Continues on the reserve until the window resets. It answers an open question with **Resume**. |
| `/spare10 stop` | Stops at the reserve now. It answers an open question with **Stop here**. |

`/spare10` runs at once, also while a turn runs.
Only you can run `resume` and `stop`, from the prompt box or a remote surface.
You cannot type `/spare10` while the dialog is on the screen, because the dialog holds the keys.
Use `/spare10 resume` or `/spare10 stop` when no dialog shows, or from a remote surface.

`/spare10` prints a report like this:

```
spare10: version 0.1.0

  ● armed          spare10 steps in at 90% used.
  · reserve        10% of the 5-hour window (from /config)
  · at the reserve stop and ask you
  · reading        live · 42% used · 58% left · resets 14:00 (in 2 h 14 min)
  · consent        none
  · guarded        yes (scope all)
  · claude -p      runs started here: stop

/spare10 resume   continue on the reserve until the window resets
/spare10 stop     stop at the reserve now
```

Claude Code puts `spare10: ` in front of each reply and each transcript line of spare10.

`/spare10 stop` works only inside the reserve, when spare10 is tripped or you chose to continue.
Below the trip point it changes nothing.

### How long a choice lasts

- **Resume** lasts until the window resets.
  It applies to this process and to the `claude -p` runs that it starts.
  `/clear` and `/resume` inside the session keep it.
- A **Resume** on a test reading applies only while that test reading applies.
  A reload, a new `/spare10 simulate` value or `/spare10 simulate off` ends it.
- **Stop here** lasts until the window resets, for this conversation only.
  `/clear`, or `/resume` to another conversation, ends it.
  The next prompt then asks again.
- An open question stays open after `/clear`.
  Your answer still applies to all held work.
- After `/clear`, each loop gets the wind-down text again.
  This applies to the pause prompt and to the unattended `prompt` policy.
- A new terminal starts armed, and asks on its own.
- At the reset, spare10 arms again by itself.

### Background sessions

Each `claude --bg` session runs its own copy of spare10.
Its question waits with no time limit.
`claude agents` shows the job as `blocked`, with the question and both labels.
Type `resume` in the agent view to answer **Resume**.
Any other reply is **Stop here**.

A background session does not take the consent of another session.
It asks on its own.
A background session gets its environment from the `claude daemon`, not from your terminal.
The daemon can start from a session that you started with `SPARE10=off`, `SPARE10_RESERVE` or `SPARE10_PAUSE_PROMPT`.
Then every background session that the daemon starts gets these values.
spare10 shows a warning in each background session that has them.

## Scope

By default, spare10 guards every interactive session.
This includes your important sessions.
You can change this in two ways.

To leave one session unguarded, start it with `SPARE10=off`:

```sh
SPARE10=off claude
```

Every process that the session starts gets the variable, also a long-lived one.
These include the `claude daemon` that serves background sessions, and a tmux server.
See [Background sessions](#background-sessions).

To guard only some runs, set the `scope` option to `opt-in`.
Then start each run to guard with `SPARE10=on`:

```sh
SPARE10=on claude
```

spare10 uses two terms:

- A run is **enabled** when the scope or `SPARE10` switches spare10 on.
- An enabled run is **guarded** when it is attended: an interactive session in a terminal.

A run that is not enabled still reads the quota and shows `○ spare10 off`.
It never asks, holds, tells or refuses.
Child processes inherit `SPARE10`.

A guarded session also protects the `claude -p` runs that it starts.
It sets `SPARE10_HEADLESS=stop` for its child processes.
So a nested `claude -p` stops at its own trip.
spare10 does this only when the `headless` option is `off` and `SPARE10_HEADLESS` is not set.
To choose a different policy, set `SPARE10_HEADLESS` before you start Claude Code.

## Configure

Set the options in `/config`, in the row for spare10.
A change of option reloads the plugin.

| Option | Default | Values | What it does |
|---|---|---|---|
| Reserve (%) | `10` | 1 to 99, one decimal at most | The part of the 5-hour window that you keep. spare10 trips at `100 - reserve` percent used. |
| Pause prompt | empty | any text | Empty: stop and ask you. Text: tell each agent this text and stop nothing. |
| Unattended runs (-p, SDK) | `off` | `off`, `prompt`, `stop` | What spare10 does inside the reserve when nobody can answer. See [Unattended runs](#unattended-runs). |
| Guarded sessions | `all` | `all`, `opt-in` | `all`: every interactive session. `opt-in`: only runs started with `SPARE10=on`. |
| Status badge | on | on, off | Shows the badge at the right of the prompt footer. |

These variables change one run.
Set them before you start Claude Code.

| Variable | What it does |
|---|---|
| `SPARE10_RESERVE` | Replaces the reserve, 1 to 99. |
| `SPARE10_PAUSE_PROMPT` | Replaces the pause prompt. A set but empty value forces stop and ask. |
| `SPARE10_HEADLESS` | Replaces the unattended policy: `off`, `prompt` or `stop`. |
| `SPARE10` | `on` or `off`. Switches spare10 on or off for this run, in either scope. |

A variable wins over `/config`.
`/config` wins over the default.
spare10 ignores a bad value and logs a warning at the start of the session.
`/spare10` shows where the reserve and the scope switch come from.
In an unattended run, it also shows where the policy comes from.

spare10 also writes some variables into the process environment:

- `SPARE10_CONSENT` holds the end of the window that you chose to continue in.
  It starts with the id of the session that wrote it.
  An interactive session takes only its own value.
  A `claude -p` run takes any value that it inherits, for the current window only.
- `SPARE10_STOPPED` records a **Stop here** for this conversation.
- `SPARE10_HEADLESS=stop` goes to child processes, as [Scope](#scope) explains.

A `SPARE10_CONSENT` value that lies after the current window has no effect.
`/spare10` shows a warning for it.

**Write JSON numbers and booleans, never strings.**
If you edit `pluginConfigs` in a settings file by hand, use the correct JSON types:

```json
{ "pluginConfigs": { "spare10@spare10": { "options": { "reserve": 15, "badge": false } } } }
```

A value of the wrong type, or out of range, stops spare10 from loading.
spare10 is then off for the whole session.

**Question time limits.**
Two settings make Claude Code continue a question by itself after a time:

- the `askUserQuestionTimeout` setting
- the `CLAUDE_AFK_TIMEOUT_MS` variable

With either one set, an unanswered spare10 question counts as **Stop here**.
spare10 warns you about this at the start of a session.
Run `/spare10 resume` to continue after such a stop.
Neither limit applies in a `--bg` session.

## Unattended runs

An unattended run has no person at a terminal.
`claude -p`, the Agent SDK, and the desktop and IDE hosts are unattended.
spare10 never asks and never holds in an unattended run, because nobody can answer.
The `headless` option (Unattended runs in `/config`) sets what spare10 does inside the reserve.

| Policy | Inside the reserve |
|---|---|
| `off` (default) | spare10 changes nothing. It reads the quota and shares the reading with other sessions. |
| `prompt` | Each agent gets the wind-down text once, on its next tool result. With an empty pause prompt, the text has no `User instructions` part. |
| `stop` | spare10 denies tool calls and refuses model requests, and sends no request. Prompts still enter. |

Under `stop`, the run ends with this answer:

```
spare10 stopped this unattended run at the quota reserve (into your 10% reserve · 9% of quota left · resets 14:00). No further model requests were sent. To pick it up later: claude --resume <session id>
```

At the first trip in each window, spare10 writes one line to the debug log:

```
spare10: unattended run inside the reserve (91% used · 9% left · resets 14:00), policy off.
```

Use `--debug-file <path>` to see it.
In a `-p` run, spare10 notices go only to the debug log.

**With `scope: opt-in`, a plain `-p` run without `SPARE10=on` is not enabled.**
spare10 ignores the `headless` policy in that run.
A `claude -p` that a `SPARE10=on` session starts inherits the variable, so the policy applies to it.

A guarded session sets `SPARE10_HEADLESS=stop` for its child runs (see [Scope](#scope)).

The Claude Code desktop and IDE hosts are unattended in this version.
In these hosts, spare10 only watches by default.
To protect such a session, set the policy to `prompt` or `stop`.
A terminal session that you view from the desktop app is attended, and shows the dialog.

## How it works

spare10 wraps Claude Code in a launcher.
It reads the quota from the status line.
At the reserve, it stops the process with a signal.
Then it asks you in its own panel.
On a yes, it starts the session again with `claude --resume`.
spare10-mod runs inside Claude Code as a mod.
It never stops or starts the process.
It has four parts.

**Sense.**
On each gated event, spare10 reads the 5-hour window with `$.session.usage()`.
This read costs nothing.
The responses of every loop keep it current.
A new session starts from the last reading of another session in the same window.
spare10 keeps that reading in `$.store`.

**Gate.**
Three hooks see every step of work.
`tool.call` sees each tool call in every loop.
`turn.step` sees each model request, also in turns that make no tool call.
`prompt.submit` sees your prompts.
Below the trip point, each hook lets the step through at once.

**Hold.**
At the trip point, the hook does not return.
It waits on a call to spare10's own `$.spare10.park`.
A wait on a `$` call does not use the 10 s time budget of the hook.
The host ends the call after 10 s, so spare10 makes the call again.
The held step keeps its place.
The model does not know that it waited.

**Ask.**
The first held step raises the question in Claude Code's own dialog.
All other held steps wait on the same question.
If the step that asked goes away, another held step asks again.
The answer then releases or refuses all held steps.

spare10 fails open when it senses and fails closed when it acts.
If it cannot read the quota, it lets work through.
After the reading trips, a failure holds or refuses the step.

| Need | spare10 | spare10-mod |
|---|---|---|
| Switch on | `spare10 claude` wraps one launch | Install the plugin and switch on function hooks |
| Guarded runs | Only runs that `spare10` launches | Every interactive session, or opt-in with `SPARE10=on` |
| Sense the quota | A status-line command reads it every 2 s | `$.session.usage()` on every gated event |
| Share state | `state.json` across three processes | Module variables, the process environment and `$.store` |
| Gate | A `PreToolUse` hook on each tool call | `tool.call`, `turn.step` and `prompt.submit` hooks |
| Stop at the reserve | `SIGTERM` to the claude process | Hold each step in place on a `$` call that costs no budget |
| Ask | Its own panel, after Claude Code exits | Claude Code's own question dialog |
| Continue | Start `claude --resume` again | The held step runs |
| Pre-flight | A panel before the process starts | The same question at your prompt |
| Consent for the window | `disarmedUntil` in `state.json` | `SPARE10_CONSENT` in the process environment |
| Pause prompt | `PreToolUse` additional context | `tool.call` result context, once per loop |
| Background sessions | `claude stop` and a batch panel | Each `--bg` session asks in the agent view |
| Diagnostics | `spare10 doctor` | `/spare10` |
| Badge | Status-line text | Text at the right of the prompt footer |

## What spare10 does not do

### Not in this version

- spare10 does not continue by itself at the window reset. It waits for your answer.
- spare10 watches only the 5-hour window, not the weekly window.
- spare10 asks one question per process. It does not share one question across terminals, `--bg` sessions and pane teammates.
- spare10 does not switch to a cheaper model instead of stopping.
- spare10 keeps no list of stopped runs across sessions. To see stopped background jobs, use `claude agents`.

### Known limitations

1. **Early access.** The function-hooks API of 2.1.281 can change without notice. Run `claude -p "/plugin-types"` again after each update.
2. **A worker respawn fails open.** Another plugin can crash the shared hooks worker. Then every held call runs and every held request goes out. spare10 asks again at the next step.
3. **One response of lag.** spare10 does not hold a request that already streams at the trip. A tool can start before its response ends. spare10 then gates it on the previous reading.
4. **spare10 does not gate the first `-p` request**, unless the shared reading from another session trips it.
5. **No hook can refuse some model requests.** Compaction, memory extraction and observer subagents make requests that no hook sees.
6. **A running tool is never cut.** Stop takes effect at the next step of each loop. A tool that spends quota itself, such as a Bash command that drives other agents, finishes. A nested `claude -p` stops at its own trip. Other quota spenders do not.
7. **A long hold expires the prompt cache.** The first request after a long hold caches the context again.
8. **Consent is per session.** Another terminal, a new session and each `--bg` session ask on their own. After `/clear` or `/resume` in the same process, your consent stays.
9. **Desktop and IDE hosts are unattended** in this version. By default spare10 only watches there. The vscode and mobile surfaces show no badge.
10. **Some setups turn every question into Stop.** These are `dontAsk` mode and a disallowed AskUserQuestion tool. A question time limit turns an unanswered question into Stop. Use `/spare10 resume` to continue.
11. **You cannot type `/spare10` while the dialog is on the screen.** Answer the dialog, or use a remote surface.
12. **A reload while a question is open** can show a second question for new work. One answer releases both within 10 s. On a test reading, each copy asks on its own.
13. **The shared reading is not keyed by account.** After you change account on one machine, a new session can ask once too early.
14. **The function-hooks flag must be in settings**, not only in the shell, for `--bg` sessions and pane teammates.
15. **A reload of spare10 reloads every hooks module.** spare10 hooks `engine.create`, so the engine builds all modules again.
16. **A limit reset in the middle of a window** shows at the next response, not at once.
17. **A held loop writes one error line to the debug log every 10 s.** This line comes from the call that spare10 makes again.
18. **Anything that answers AskUserQuestion for you also answers spare10.** This includes other plugins and setups that answer questions for autonomous runs. spare10 takes an exact `Resume` as your consent.
19. **Pane teammates probably stop at the reserve.** Their question goes to the lead as a request. An allow with no answer counts as Stop.
20. **A subagent with a blocking `SubagentStop` hook repeats its refused step.** This costs nothing, unless the hook is prompt-type. Then each repeat makes one request.
21. **After a reload, the tool calls of a workflow agent pass until its next model request.** spare10 gates that request. Tool calls spend no quota.
22. **An installed copy and a `--plugin-dir` copy cannot run together.** One of them unloads.
23. **spare10 guards every interactive session by default**, and this includes your important sessions. Use `SPARE10=off`, or `scope: opt-in` with `SPARE10=on`.
24. **There is no list of stopped runs across sessions.** spare10 doctor listed each stopped background run. Use `claude agents`.

## Develop

spare10-mod is pinned to Claude Code 2.1.281.
The types come from the version that you run, so use this version.

```sh
claude -p "/plugin-types"   # writes .claude/types/. A local command, with no model request.
npm install                 # installs TypeScript 5.9.3
scripts/check.sh            # or: npm run check
```

Run `claude -p "/plugin-types"` again after each update of Claude Code.
Never commit `.claude/types/`.

`scripts/check.sh` runs four checks.
All four must pass before a commit:

1. `claude plugin validate --strict .` checks the marketplace file only.
2. `claude plugin validate --strict .claude-plugin/plugin.json` checks the plugin and its hooks module.
3. `claude plugin test .` runs the tests in `tests/`.
4. `tsc` 5.9.3 checks the types of the hooks and the tests.

### Layout

```
.claude-plugin/plugin.json       the plugin manifest and its options
.claude-plugin/marketplace.json  the one-plugin marketplace
types.d.ts                       the types contract: the $.spare10 noun
hooks/hooks.json                 names the hooks module
hooks/register.tsx               every hook and every $ call
hooks/core/config.ts             pure: options, per-run variables, scope, start-up checks
hooks/core/reading.ts            pure: the reading, the shared seed, blind count, test reading
hooks/core/decide.ts             pure: the decision table, the phase, answers, consent, stopped
hooks/core/text.ts               pure: every text that a person or the model reads
hooks/core/badge.ts              pure: the badge view
tests/helpers/world.ts           the kit world beneath the plugin
tests/core/*.test.ts             pure tests
tests/kit/*.test.ts              tests through the engine
.fixtures/stophook.json          a Stop hook for live check LC3
docs/live-checks.md              the live checks, as a runbook
.claude/CLAUDE.md                notes for Claude Code. Not at the root, where validate --strict warns.
```

### Rules the engine enforces

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

### Test reading

A test reading trips spare10 at any time, far from the real reserve.

- `/spare10 simulate 95` sets a test reading of 95% used. Only you can run it.
- `/spare10 simulate off` clears the test reading, and also the consent and the stop.
- A new `/spare10 simulate` value also clears the consent and the stop.
- `SPARE10_SIMULATE=95` at launch does the same for a `-p` run.

A test reading can only raise the real reading.
It never releases a hold.
While it applies, `/spare10` shows `test reading`, and the labelled badge rows show `(test)`.
The rows `⚠ Pausing at next step` and `⚠ Winding down at next step` have no label.
A **Resume** on a test reading never goes into `SPARE10_CONSENT`.
So a reload or a real trip past the test reading asks you again.

### Live checks

The kit cannot test the dialog, the 10 s host limit, a reload or a `--bg` session.
Only a real interactive session can.
Run the checks in [docs/live-checks.md](docs/live-checks.md) before each release and after each update of Claude Code.

## License

MIT. See [LICENSE](LICENSE).
spare10-mod ports texts and design from spare10 by Alessandro Diano, also under the MIT license.
