# Configure spare10

This page tells you which sessions spare10 guards, how to set its options, and what it does in unattended runs.
The options are the same in Claude Code and Codex.
For the Codex way to set them, see [Options in Codex](codex.md#options-in-codex).

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
See [Background sessions](claude-code.md#background-sessions).

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
spare10 does this only when the `headless` option is `off` or `wait`, and `SPARE10_HEADLESS` is not set.
A `claude -p` that the Bash tool starts ends when the Bash call times out.
That is 2 minutes by default, and 10 minutes at most.
So a child run must not wait for a reset.
The parent session reads the same quota, so it holds at its own next step and asks you.
To choose a different policy, set `SPARE10_HEADLESS` before you start Claude Code.
To let child runs wait, set `SPARE10_HEADLESS=wait`.

## Options

Set the options in `/config`, in the row for spare10.
A change of option reloads the plugin.

| Option | Default | Values | What it does |
|---|---|---|---|
| Reserve (%) | `10` | 1 to 99, one decimal at most | The part of the 5-hour window that you keep. spare10 trips at `100 - reserve` percent used. |
| Weekly reserve (%) | `10` | `0`, or 1 to 99, one decimal at most | The part of the weekly window that you keep. `0` switches the weekly guard off. |
| Open reserve before 5-hour reset (min) | `20` | 0 to 299, one decimal at most | In this many last minutes of the 5-hour window, spare10 lets all work use the reserve. `0` switches this off. |
| Open weekly reserve before weekly reset (h) | `8` | 0 to 167, one decimal at most | The same for the weekly window, in hours. `0` switches this off. |
| Resume floor (%) | `5` | 0 to 99, one decimal at most | After a **Resume** at the 5-hour reserve, spare10 asks again when this much is left. `0` switches this off. A value at or above the reserve does nothing. |
| Weekly resume floor (%) | `5` | 0 to 99, one decimal at most | The same for the weekly window. |
| Pause prompt | empty | any text | Empty: stop and ask you. Text: tell each agent this text and stop nothing. |
| Continue at the reset | on | on, off | On: spare10 continues held and stopped work by itself. It does this when the reserve opens, or a few minutes after the reset. **Stop here** then means "stop until then". Off: work waits for you. |
| Unattended runs (-p, SDK) | `off` | `off`, `prompt`, `stop`, `wait` | What spare10 does inside the reserve when nobody can answer. See [Unattended runs](#unattended-runs). |
| Guarded sessions | `all` | `all`, `opt-in` | `all`: every interactive session. `opt-in`: only runs started with `SPARE10=on`. |
| Status badge | on | on, off | Shows the badge at the right of the prompt footer. |

With a weekly reserve of `0`, spare10 still reads the weekly window.
It never acts on it.

The open time of a window is the time before its reset in which spare10 opens the reserve.
See [Skip near the reset](claude-code.md#skip-near-the-reset).
The largest open times still guard the first minute of the 5-hour window and the first hour of the weekly window.

These variables change one run.
Set them before you start Claude Code.

| Variable | What it does |
|---|---|
| `SPARE10_RESERVE` | Replaces the reserve, 1 to 99. |
| `SPARE10_WEEKLY_RESERVE` | Replaces the weekly reserve: `0`, or 1 to 99. `0` switches the weekly guard off. |
| `SPARE10_LAST_MINUTES` | Replaces the open time of the 5-hour window, 0 to 299 minutes. `0` switches it off. |
| `SPARE10_WEEKLY_LAST_HOURS` | Replaces the open time of the weekly window, 0 to 167 hours. `0` switches it off. |
| `SPARE10_RESUME_FLOOR` | Replaces the resume floor, 0 to 99. `0` switches it off. |
| `SPARE10_WEEKLY_RESUME_FLOOR` | Replaces the weekly resume floor, 0 to 99. `0` switches it off. |
| `SPARE10_PAUSE_PROMPT` | Replaces the pause prompt. A set but empty value forces stop and ask. |
| `SPARE10_AUTO_RESUME` | `on` or `off`. Replaces **Continue at the reset**. |
| `SPARE10_HEADLESS` | Replaces the unattended policy: `off`, `prompt`, `stop` or `wait`. |
| `SPARE10` | `on` or `off`. Switches spare10 on or off for this run, in either scope. |

A variable wins over `/config`.
`/config` wins over the default.
spare10 ignores a bad value and logs a warning at the start of the session.
If spare10 cannot read the variables at all, it sets both open times to 0 until a read succeeds.
Then it keeps each reserve until the reset.
The floors keep their `/config` values.
`/spare10` shows where the reserve, the weekly reserve, the open times, the floors and the scope switch come from.
In an attended session, it also shows where the setting for the reset comes from.
In an unattended run, it also shows where the policy comes from.

spare10 also writes some variables into the process environment:

- `SPARE10_CONSENT` holds the end of the 5-hour window that you chose to continue in.
  It starts with the id of the session that wrote it.
  An interactive session takes only its own value.
  A `claude -p` run takes any value that it inherits, for the current window only.
  After a **Resume** at the reserve, the value ends with the floor point, such as `to:95`.
  Then the consent ends at 95% used, and spare10 removes the value.
  A value without it, such as a value from spare10-mod 0.2, lasts until the reset.
- `SPARE10_WEEKLY_CONSENT` does the same for the weekly window.
  It has the same form as `SPARE10_CONSENT`.
- `SPARE10_STOPPED` records a **Stop here** for this conversation.
  It holds the session id, the end of the stop, the time of the stop and a list of tags.
  The tags name the windows of the stop.
  They also tell spare10 whether the stop held work, and whether to continue it at the reset.
  The tag `skip` tells spare10 that the stop ends when the reserve opens, with no margin.
  The tags `real_five_hour` and `real_seven_day` say that the real reading of that window was in the reserve when the stop took the window.
  Each tag also has the reset time of that reading in milliseconds, such as `real_five_hour:1790262000000`.
  A tag with no time means that spare10 did not know the reset time.
  Only a stop with the tag `skip` or `test` has them.
  With them, a stop can hold past its end, as [The `/spare10` command](claude-code.md#the-spare10-command) explains.
  A value from spare10-mod 0.1 still stops, but never continues by itself.
  It holds no work while a reserve is open.
- `SPARE10_HEADLESS=stop` goes to child processes, as [Scope](#scope) explains.

A `SPARE10_CONSENT` value that lies after the current window has no effect.
A `SPARE10_WEEKLY_CONSENT` value that lies after the current weekly window has no effect.
`/spare10` shows a warning for each.

**Write JSON numbers and booleans, never strings.**
If you edit `pluginConfigs` in a settings file by hand, use the correct JSON types:

```json
{ "pluginConfigs": { "spare10@spare10": { "options": { "reserve": 15, "weeklyReserve": 5, "lastMinutes": 30, "resumeFloor": 3, "weeklyResumeFloor": 2, "autoResume": false, "badge": false } } } }
```

A value of the wrong type, or out of range, stops spare10 from loading.
spare10 is then off for the whole session.

**Question time limits.**
Two settings make Claude Code continue a question by itself after a time:

- the `askUserQuestionTimeout` setting
- the `CLAUDE_AFK_TIMEOUT_MS` variable

With either one set, an unanswered spare10 question counts as **Stop here**.
With **Continue at the reset** on, spare10 then continues the work at the time that the question names.
spare10 warns you about this at the start of a session.
Run `/spare10 resume` to continue before that time.
Neither limit applies in a `--bg` session.

## Unattended runs

An unattended run has no person at a terminal.
`claude -p`, the Agent SDK, and the desktop and IDE hosts are unattended.
spare10 never asks in an unattended run, because nobody can answer.
It holds work only under the `wait` policy.
The `headless` option (Unattended runs in `/config`) sets what spare10 does inside the reserve.

| Policy | Inside the reserve |
|---|---|
| `off` (default) | spare10 changes nothing. It reads the quota and shares the reading with other sessions. |
| `prompt` | Each agent gets the wind-down text once, on its next tool result. With an empty pause prompt, the text has no `User instructions` part. |
| `stop` | spare10 denies tool calls and refuses model requests, and sends no request. Prompts still enter. |
| `wait` | spare10 holds tool calls and model requests, with no question. When the reserve opens, or after the reset, it reads the quota again and continues. Prompts still enter. |

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

While a reserve is open, every policy lets the work through.
Nothing is told, refused or held.
spare10 then writes this line once per window:

```
spare10: unattended run inside the reserve (91% used · 9% left · resets 14:00), but the reset is near. spare10 lets it through.
```

A run that must never spend a reserve sets `SPARE10_LAST_MINUTES=0` and `SPARE10_WEEKLY_LAST_HOURS=0`.
A CI run is an example.
If spare10 cannot read these variables, it keeps each reserve until the reset.

**With `scope: opt-in`, a plain `-p` run without `SPARE10=on` is not enabled.**
spare10 ignores the `headless` policy in that run.
A `claude -p` that a `SPARE10=on` session starts inherits the variable, so the policy applies to it.

A guarded session sets `SPARE10_HEADLESS=stop` for its child runs (see [Scope](#scope)).
It does this also when its own policy is `wait`.

Unattended runs never ask, so the floor changes nothing there.
The `prompt` policy tells each agent once per window, and its text names the reserve.
A `claude -p` run can take a **Resume** at the reserve from the session that started it.
Then that **Resume** ends at the floor point, and the policy of the run applies from there.

The Claude Code desktop and IDE hosts are unattended in this version.
In these hosts, spare10 only watches by default.
To protect such a session, set the policy to `prompt` or `stop`.
A terminal session that you view from the desktop app is attended, and shows the dialog.

### The `wait` policy

A `wait` hold lasts until each window that tripped opens its reserve.
spare10 adds no margin there.
With an open time of 0, the hold lasts until the reset, plus 5 minutes.
That is up to about 5 hours for the 5-hour window.
For the weekly window, it is up to 7 days.
`wait` has no upper bound of its own.
To keep a run from a wait of days, start it with `SPARE10_WEEKLY_RESERVE=0`.

- `wait` ignores **Continue at the reset**. It always continues when the reserve opens, or after the reset.
- A consent that the run inherits from its parent session still applies.
  A consent from a **Resume** at the reserve ends at its floor point.
- After the release, the turn goes on, and the run ends as usual.
- A `-p` run has no quota reading at its start.
  If only the shared reading of another session trips it, spare10 lets one step go.
  The response of that step gives a live reading, and the next step decides on it.
  So an old shared reading cannot hold a run for days.
- In the desktop and IDE hosts, a `wait` hold shows a running turn with no sign of spare10.
  It looks like a hang, so use `prompt` or `stop` there.

Three things can end a `wait` hold before its time:

- **The hook budget.** Each hold uses a little of its time budget.
  Before the budget runs out, spare10 ends the hold as a stop.
  The estimate is more than a day.
  The run then ends with the `stop` answer above.
- **A limit of the caller.** Examples are a CI job timeout, a `timeout` command and an SDK abort.
  The run then ends without a final answer.
- **A respawn of the hooks worker.** Then the held work goes through.
