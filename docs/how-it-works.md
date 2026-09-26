# How spare10 works

This page tells you how spare10 works in Claude Code.
For Codex, see [How spare10 works in Codex](codex.md#how-spare10-works-in-codex).

## Five parts

spare10 wraps Claude Code in a launcher.
It reads the quota from the status line.
At the reserve, it stops the process with a signal.
Then it asks you in its own panel.
On a yes, it starts the session again with `claude --resume`.
spare10-mod runs inside Claude Code as a mod.
It never stops or starts the process.
It has five parts.

**Sense.**
On each gated event, spare10 reads the 5-hour window and the weekly window with `$.session.usage()`.
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
While a reserve is open, it does the same.

**Hold.**
At the trip point, the hook does not return.
It waits on a call to spare10's own `$.spare10.park`.
A wait on a `$` call does not use the 10 s time budget of the hook.
The host ends the call after 10 s, so spare10 makes the call again.
The held step keeps its place.
The model does not know that it waited.
Each cycle of the wait uses a little of the budget.
Before the budget runs low, spare10 ends the hold as **Stop here**.

**Ask.**
The first held step raises the question in Claude Code's own dialog.
All other held steps wait on the same question.
If the step that asked goes away, another held step asks again.
The answer then releases or refuses all held steps.

**Continue.**
Nothing in Claude Code fires at a quota reset, so spare10 keeps its own clock.
At the start of a session, spare10 starts a timer that runs every 30 s.
The timer continues a stop when the reserve opens, or after the reset, with a short message to Claude.
A second timer runs every 5 minutes.
If a hook of another plugin stops one timer, the other timer starts it again.
Each held step also checks the time on each cycle of its wait.
So an open question ends when the reserve opens, or after the reset, also after a reload.
Before it releases work by itself, spare10 reads the quota again.
If that read fails, spare10 does not release the work.

spare10 fails open when it senses and fails closed when it acts.
If it cannot read the quota, it lets work through.
After the reading trips, a failure holds or refuses the step.

## spare10 and spare10-mod

The table compares spare10 and spare10-mod in Claude Code.

| Need | spare10 | spare10-mod |
|---|---|---|
| Switch on | `spare10 claude` wraps one launch | Install the plugin and switch on function hooks |
| Guarded runs | Only runs that `spare10` launches | Every interactive session, or opt-in with `SPARE10=on` |
| Windows | The 5-hour window | The 5-hour window and the weekly window |
| Sense the quota | A status-line command reads it every 2 s | `$.session.usage()` on every gated event |
| Share state | `state.json` across three processes | Module variables, the process environment and `$.store` |
| Gate | A `PreToolUse` hook on each tool call | `tool.call`, `turn.step` and `prompt.submit` hooks |
| Stop at the reserve | `SIGTERM` to the claude process | Hold each step in place on a `$` call that costs no budget |
| Ask | Its own panel, after Claude Code exits | Claude Code's own question dialog |
| Continue | Start `claude --resume` again | The held step runs |
| After the reset | You run `claude --resume` yourself | spare10 continues held and stopped work, unless you switch this off |
| Pre-flight | A panel before the process starts | The same question at your prompt |
| Consent for the window | `disarmedUntil` in `state.json` | `SPARE10_CONSENT` and `SPARE10_WEEKLY_CONSENT` in the process environment, with the floor point |
| Pause prompt | `PreToolUse` additional context | `tool.call` result context, once per loop at the reserve and once at the floor |
| Background sessions | `claude stop` and a batch panel | Each `--bg` session asks in the agent view |
| Diagnostics | `spare10 doctor` | `/spare10` |
| Badge | Status-line text | Text at the right of the prompt footer |

## What spare10 does not do

### Not in this version

- spare10 asks one question per process. It does not share one question across terminals, `--bg` sessions and pane teammates.
- spare10 does not switch to a cheaper model instead of stopping.
- The dialog has no choice between "stop until the reset" and "stop for good". Use the **Continue at the reset** option, `/clear` or `/exit`.
- The dialog has no choice between "until the floor" and "until the reset". Use the **Resume floor** option.
- spare10 keeps no list of stopped runs across sessions. To see stopped background jobs, use `claude agents`.

### Known limitations

These limitations apply in Claude Code.
For Codex, see [Differences in Codex](codex.md#differences-in-codex).

1. **Early access.** The function-hooks API can change in any Claude Code version, without notice. Run `claude -p "/plugin-types"` again after each update.
2. **A worker respawn fails open.** Another plugin can crash the shared hooks worker. Then every held call runs and every held request goes out. spare10 asks again at the next step.
3. **One response of lag.** spare10 does not hold a request that already streams at the trip. A tool can start before its response ends. spare10 then gates it on the previous reading.
4. **spare10 does not gate the first `-p` request**, unless the shared reading from another session trips it. Under `wait`, the shared reading alone lets one more request go.
5. **No hook can refuse some model requests.** Compaction, memory extraction and observer subagents make requests that no hook sees.
6. **A running tool is never cut.** Stop takes effect at the next step of each loop. A tool that spends quota itself, such as a Bash command that drives other agents, finishes. A nested `claude -p` stops at its own trip. Other quota spenders do not.
7. **A long hold expires the prompt cache.** The first request after a long hold caches the context again.
8. **Consent is per session.** Another terminal, a new session and each `--bg` session ask on their own. After `/clear` or `/resume` in the same process, your consent stays.
9. **Desktop and IDE hosts are unattended** in this version. By default spare10 only watches there. The vscode and mobile surfaces show no badge.
10. **Some setups turn every question into Stop.** These are `dontAsk` mode and a disallowed AskUserQuestion tool. A question time limit turns an unanswered question into Stop. With **Continue at the reset** on, the work then continues at the time that the question names. Use `/spare10 resume` to continue before that.
11. **You cannot type `/spare10` while the dialog is on the screen.** Answer the dialog, or use a remote surface.
12. **A reload while a question is open** can show a second question for new work. One answer releases both within 10 s. On a test reading, each copy asks on its own.
13. **The shared reading is not keyed by account.** After you change account on one machine, a new session can ask once too early.
14. **The function-hooks flag must be in settings**, not only in the shell, for `--bg` sessions and pane teammates.
15. **A reload of spare10 reloads every hooks module.** spare10 hooks `engine.create`, so the engine builds all modules again.
16. **A limit reset in the middle of a window** shows at the next response, not at once.
17. **A held loop writes one error line to the debug log every 10 s.** This line comes from the call that spare10 makes again. A weekly hold can write these lines for days. Without a debug flag, Claude Code writes no log.
18. **Anything that answers AskUserQuestion for you also answers spare10.** This includes other plugins and setups that answer questions for autonomous runs. spare10 takes an exact `Resume` as your consent.
19. **Pane teammates probably stop at the reserve.** Their question goes to the lead as a request. An allow with no answer counts as Stop.
20. **A subagent with a blocking `SubagentStop` hook repeats its refused step.** This costs nothing, unless the hook is prompt-type. Then each repeat makes one request.
21. **After a reload, the tool calls of a workflow agent pass until its next model request.** spare10 gates that request. Tool calls spend no quota.
22. **An installed copy and a `--plugin-dir` copy cannot run together.** One of them unloads.
23. **spare10 guards every interactive session by default**, and this includes your important sessions. Use `SPARE10=off`, or `scope: opt-in` with `SPARE10=on`.
24. **There is no list of stopped runs across sessions.** spare10 doctor listed each stopped background run. Use `claude agents`.
25. **spare10 continues 5 minutes after a real reset, not at the exact time.** When the reserve opens before the reset, spare10 adds no margin. After a test window, it waits 60 s. A test window can end less than 5 minutes after the reset of a real reading in the reserve. Then spare10 waits until 5 minutes after that reset. The release uses the clock of your computer.
26. **A held loop continues within about 10 s after that time.** A stopped session waits for the next 30 s check.
27. **The message at the reset starts a new turn.** While the prompt box holds new text, the message waits up to 5 minutes. Then it goes.
28. **A hold ends as Stop here when it has used most of its hook budget.** The estimate is more than a day. With **Continue at the reset** on, the work then continues when the reserve opens, or at the reset. Under `wait`, the run ends with the `stop` answer.
29. **`wait` has no upper bound of its own.** A weekly trip can hold a run for up to seven days. Use `SPARE10_WEEKLY_RESERVE=0` for runs that must not wait.
30. **The badge does not show which window tripped.** It never shows the weekly reserve. Use `/spare10` to see both windows.
31. **spare10 does not restart a stopped subagent.** The message at the reset tells the model to run it again if it needs the result.
32. **Stop here on a prompt question of an idle session gives the prompt back.** spare10 does not send that prompt when the stop ends. Type it again.
33. **Continue at the reset spends quota while nobody watches.** When the reserve opens, the work uses the reserve. After the reset, it uses the new window. spare10 stops again at the reserve of the new window. To stop for good, use `/exit` or `/clear`, or switch the option off.
34. **After an upgrade from 0.1 while a question is open, answer that question once.** The old copy has no reset check, so its held work does not continue by itself. A **Stop here** from the new copy does not close the old dialog.
35. **A reload while a prompt question is open in a stopped session can start two turns at the reset.** One turn is the message of spare10. The other is your released prompt.
36. **A question that opens just before the reserve opens shows for a short time only.** spare10 does not hide it. A **Stop here** in that time does not stop the open window.
37. **Agents that got the pause prompt do not get a message when the reserve opens.** Type a prompt to continue them.
38. **You cannot stop at a reserve while it is open.** `/spare10 stop` stops nothing then. To keep a reserve until the reset, set its open time to 0.
39. **A stop from spare10 0.1 does not hold work while a reserve is open.**
40. **With Continue at the reset off, new work can run while older work waits.** When the reserve opens, new work goes on with no question. Work that a question from before holds still waits for your answer.
41. **The weekly open time spends the weekly reserve at the pace of the 5-hour window.** In the last 8 hours of the weekly window, only the 5-hour guard holds the work.
42. **Unattended `stop` and `prompt` runs spend an open reserve.** Set `SPARE10_LAST_MINUTES=0` and `SPARE10_WEEKLY_LAST_HOURS=0` for runs that must never spend a reserve.
43. **The open time uses the clock of your computer.** A clock that runs fast opens the reserve early by the same amount. The work then still uses the reserve of the window that ends.
44. **spare10 opens a reserve only when it knows the reset time.** A reading without a reset time keeps the guard until the reset.
45. **With a pause prompt, a stop can end while a window is still in its reserve.** This can happen when a stop covers both windows, or a test window over the real quota. It can also happen after you lower an open time, or when a reset time moves. A quota read that fails as you type `/spare10 stop` can also end it. Without a pause prompt, spare10 then asks you again. With a pause prompt, spare10 tells Claude again to wind down, and the work continues.
46. **If the reading passes the floor while the first question waits, a Resume shows the second question at once.**
47. **A Resume at the reserve ends for good at the floor point.** If the reading falls again in the same window, spare10 asks again.
48. **After an upgrade from 0.2 while a question is open, answer that question once.** The old copy cannot read a consent to the floor.
49. **With a pause prompt, each agent gets the text twice per window**: at the reserve and at the floor.
50. **With a reserve of 5% or less, the default floor does nothing.** spare10 warns at each start. Set the floor lower, or to 0.
51. **A Resume on a test reading also covers the real reading beneath it.** This holds while the test reading is the higher one. `/spare10 simulate` warns you when the real reading is in the reserve.
52. **An early limit reset can leave an old consent in force.** A Resume lasts until the reset time that spare10 read then. When a window resets early, that consent can cover the new window until the old reset time.
53. **A failed quota read can keep an ended floor consent.** This needs a failed read, a reset time that moved, and then a fall of the reading. Then held work below the floor can continue without a second Resume.
54. **After a Resume, a fall and a new trip in the same window, spare10 can ask each copy again.** This happens after a plugin reload, when two copies of spare10 run. Answer each question once.
