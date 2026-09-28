# spare10 in Codex

spare10 also runs in the OpenAI Codex CLI.
It is tested on Codex CLI 0.157.0.
The same repo is a Codex plugin.
It has the same options, questions, rules and texts as in Claude Code.
Some parts work in a different way, because Codex has other hooks.
[Differences in Codex](#differences-in-codex) lists them.

## Install in Codex

You need Node.js 20 or later.
spare10 looks for it in Homebrew, in `/usr/local/bin`, in `/usr/bin` and in Volta.
Then it tries the versions of nvm, mise, asdf and fnm, newest first.
It takes a Node.js from your `PATH` only when none of these is Node.js 20 or later.

```sh
codex plugin marketplace add chrisns/spare10-mod
codex plugin add spare10@spare10
```

Then start `codex`.
Codex shows **Hooks need review**.
Choose **Trust all and continue**.
Codex runs plugin hooks only after you trust them.
`codex exec` never asks you.
So trust the hooks once in the TUI before you use `codex exec`.
An update that changes the spare10 hooks makes Codex ask you again.

spare10 starts one small Node.js process for each Codex thread.
Codex waits for this process before a thread starts.
If spare10 finds no Node.js, Codex cannot start a session.
This includes the Codex desktop app and the IDE extension.
Then remove the plugin with `codex plugin remove spare10@spare10`.
Or set `enabled = false` under `[plugins."spare10@spare10"]` in `~/.codex/config.toml`.

To see the status, type `spare10` as the whole prompt, and press Enter.
spare10 answers in the transcript and sends nothing to the model.

To run a command during a turn, use the Codex shell prefix `!`.
Codex does not use your shell aliases there.
So add the spare10 folder to your `PATH` in `~/.zshrc` or `~/.bashrc`:

```sh
export PATH="$HOME/.codex/plugins/data/spare10-spare10/bin:$PATH"
```

If you set `CODEX_HOME`, use that folder in place of `$HOME/.codex`.
The `cli` row of the `spare10` report shows the path.
spare10 writes your home folder as `~` in a row, and as `$HOME` in a command.
Start a new Codex session after you change the file.
Then `!spare10 status`, `!spare10 resume` and `!spare10 stop` work at any time, also while spare10 holds work.
Codex gives the output of each `!` command to the model.
So spare10 prints only one short line there.
`!spare10 status` prints only the phase line.
To see the full report during a turn, run `!spare10 status --full`.
The model reads this report too.
A command that changes something, such as `!spare10 resume`, prints only that it is done.
Its full answer shows in the transcript at the next step.
If the command changes nothing, spare10 prints its answer in the `!` output.
A `spare10 resume`, `stop` or `simulate` from another terminal that changes something also shows its answer in the transcript.

spare10 has no badge in Codex.
To see the quota in the Codex footer, open `/statusline`, and add `five-hour-limit` and `weekly-limit`.

## Use in Codex

At the reserve, spare10 holds each loop at its next tool call or model request.
This includes the main thread and each subagent.
Codex then shows `Working` with this line:
`spare10 checks the quota reserve. Esc stops a held step.`

The first held step asks one question in a Codex form:

```
  Your 10% weekly reserve is reached: 91% used · 9% left · resets Tue 15:52. All work is on hold. ...

  spare10
  › 1. Stop here
    2. Resume
  enter to submit | esc to cancel
```

Choose with the arrow keys and Enter.
Esc on the form is **Stop here**.
A question of a subagent shows on the main screen too.
If you can spend Codex credits past 100%, the question tells you the balance.

**Resume** works as in Claude Code.
The held work continues from the point where it stopped.

**Stop here** depends on how Codex runs the session:

- By default, the Codex TUI runs its sessions on the Codex daemon.
  Then spare10 ends the turn, and sends no model request.
  spare10 also ends the other running turns of the session, such as subagents.
  Tools that already run in those turns stop too.
  The session stays open and idle.
  When the reserve opens, or after the reset, spare10 starts a new turn with its short message.
- `codex --no-daemon`, and some other options, run the TUI without the daemon.
  Then spare10 holds the work in place until the stop ends.
  After that, the work continues.
  Press Esc to end the turn before that time.
  `!spare10 stop` keeps the stop and the held work, and its reply says that held work waits.
  With **Continue at the reset** off, each running loop gets one more model request.
  In it, the model reads that it must stop.

A prompt that you type inside the reserve asks first, as in Claude Code.
**Stop here** drops the prompt.
Codex does not put the text back in the prompt box.

With approval `never` (for example `--yolo`), Codex cannot show the question.
Then spare10 holds the work, and asks nothing.
Run `!spare10 resume` to continue, or press Esc to stop.
On the Codex daemon, `!spare10 stop` also ends the held work.

At 100% used, spare10 holds all work until the reset, as in [At the quota limit](claude-code.md#at-the-quota-limit).
It does this also while a reserve is open, and after a **Resume**.
The first held step asks the limit question in a Codex form:

```
  The quota limit is reached: 100% used · 0% left · resets 15:00. All work is on hold. ...

  spare10
  › 1. Continue at the reset
    2. Stop here
  enter to submit | esc to cancel
```

**Continue at the reset** is first, and it is selected.
Only **Stop here** stops the work.
Esc on the limit form is **Continue at the reset**.
If the step that asked went away, another held step asks again.
With approval `never`, no form shows, and the work continues at the reset.
`spare10 resume` on the limit form counts as **Continue at the reset**.
At other times at the limit, its reply names `spare10 set limitPause off`.
`spare10 stop` counts as **Stop here**, also on a form at the reserve when the quota is at 100% used.

Codex shows a spare10 line only when a hook of the main thread answers.
At the limit, spare10 holds every such hook.
So after **Continue at the reset**, Codex shows no line until the held work continues.
The form closes, and the work stays on hold. This is not a hang.
When the hold lasts more than 30 minutes, Codex then shows only `spare10: the 5-hour window reset. Held work continues.`

When a turn ends at the limit, Codex shows one of these lines:

```
spare10: the turn ends here, because the quota limit is reached. spare10 asks at your next prompt.
spare10: the turn ends here, because the quota limit is reached. Held work and your next prompt wait until 15:00.
spare10: the turn ends here, because work stopped at the quota limit.
```

The second line comes after **Continue at the reset**.
The third line comes after **Stop here**.

If you can spend Codex credits past 100%, spare10 does not pause at the limit.
Then the question at the reserve names the balance.

## Commands in Codex

Type a command as the whole prompt.
spare10 sends no model request for it.

| Command | What it does |
|---|---|
| `spare10` or `spare10 status` | Shows the status report. |
| `spare10 resume` | Continues on the reserve until the floor, or past the floor until the reset. |
| `spare10 stop` | Stops at the reserve now. |
| `spare10 simulate ...` | Sets a test reading, as `/spare10 simulate` does. On a plan with only a weekly window, it is weekly by default. See [Test reading](claude-code.md#test-reading). |
| `spare10 set` | Shows the options and where each value comes from. |
| `spare10 set <option> <value>` | Changes an option, such as `spare10 set reserve 15`. |
| `spare10 set <option> default` | Puts an option back to its default. |
| `spare10 help` | Lists the commands. |

A prompt of two words that starts with spare10 is always a command, such as `spare10 pause`.
For an unknown word, the reply names `spare10 help`.
`spare10 set <word>` and `spare10 simulate` with at most four more words are always commands too.
For a bad word, the reply says what is wrong.
spare10 answers these prompts itself, as it does for the commands in the table.
Other text that starts with the word spare10 goes to the model as usual.
Only you can run `resume`, `stop`, `simulate` and `set`, and only from the main thread.
A subagent cannot run them.
During a turn, type the command with `!` in front, such as `!spare10 resume`.
If you type a command without `!` during a turn, Codex keeps it until the next step.
Then `spare10 stop` ends the turn, and the other commands run while the turn goes on.

## Options in Codex

Codex has no screen for plugin options.
spare10 keeps its options in `~/.codex/plugins/data/spare10-spare10/config.json`.
Change them with `spare10 set`.
The options, defaults and values are the same as in [Configure](configure.md#options), without **Status badge**.
Their names are `reserve`, `weeklyReserve`, `lastMinutes`, `weeklyLastHours`, `resumeFloor`, `weeklyResumeFloor`, `pausePrompt`, `autoResume`, `limitPause`, `headless` and `scope`.
A `SPARE10_*` variable with a valid value wins over the file, as in Claude Code.
`limitPause` is **Pause at the limit**. Switch it off with `spare10 set limitPause off`.
While it is off, the report warns when a window is at 100% used and no credits can pay:
`past 100% used, Codex refuses each model request until the reset. spare10 does not pause at the limit, because limitPause is off.`
If spare10 cannot read the file, it warns you, and keeps each reserve until the reset.
Correct the file, or remove it to use the defaults.

The Codex TUI runs its sessions on a shared daemon by default.
A daemon session gets its variables from the daemon, not from your terminal.
So `SPARE10=off codex` has no effect there.
For such a run, use `codex --no-daemon`, or change the option with `spare10 set`.
To clear a variable of the daemon, restart the daemon.
With `scope` set to `opt-in`, a daemon session is not guarded, and spare10 tells you so.

Some Codex plans have only a weekly window.
Then spare10 watches the weekly window only, and the report says `Codex reports no 5-hour window for this plan`.
On such a plan, no 5-hour guard holds work in the last hours before the weekly reset.
By default, spare10 lets all work through in the last 8 hours of the weekly window.
To keep the weekly reserve until the reset, run `spare10 set weeklyLastHours 0`.
On such a plan, `spare10 simulate` without a window word sets a weekly test reading.
`SPARE10_SIMULATE` does the same.
By default, a weekly test window shorter than 8 hours is open at once.
To see the question, use `spare10 simulate 92 in 9h`.

After a Codex reset credit, a window starts again early.
Then an earlier **Resume** does not cover the new window.
spare10 asks you again at the reserve.

## Unattended runs in Codex

`codex exec`, the Codex desktop app, the IDE extension and the SDKs are unattended.
On the Codex daemon, a session of an app that spare10 does not know counts as attended.
If that app cannot show the question, spare10 holds its work at the reserve.
The `headless` option works as in [Unattended runs](configure.md#unattended-runs), with these changes:

- `stop`: spare10 denies the next tool call once, and blocks a new prompt.
  A turn that runs then gets one more model request, in which the model reads the stop.
  If the model goes on, spare10 holds its next step until the reserve is no longer reached.
- `wait`: spare10 also holds the first model request of a run.
  When the Codex daemon runs, spare10 reads the live quota before that request.
- The unattended text says `To pick it up later: codex exec resume <session id>`.
- A guarded Codex session gives its `codex exec` children the policy `stop`, as a guarded Claude Code session does.
- `codex exec resume` of a TUI session is unattended.

## Differences in Codex

1. The question is a form with two choices. It has no free text and no "Chat about this".
2. **Stop here** ends a turn with no model request only on the Codex daemon. Without the daemon, spare10 holds the work in place.
3. On the daemon, **Stop here** also stops the tools that already run in that turn. Codex tells the model that you interrupted the turn. spare10 adds a line that says that spare10 did it.
4. spare10 continues stopped work at the reset only on the Codex daemon.
5. Commands are prompts that start with `spare10`. Codex has no `/spare10`. `!spare10` needs the `PATH` line from [Install in Codex](#install-in-codex). The model reads the output of each `!` command.
6. spare10 lines show at the next hook of the main thread, not at once.
7. `/clear` starts a new session. A **Resume** does not carry over to it.
8. On a shared Codex daemon, the first app that connects names all new sessions. spare10 then treats an unknown app as attended.
9. `SPARE10*` variables that you set in a terminal do not reach sessions on the Codex daemon.
10. Codex runs the spare10 hooks only after you trust them, and again after each change of them.
11. Some model requests have no hook, so spare10 cannot hold them. One is the request after a failed tool call. Others are the checks of a shell command that runs longer than 10 seconds. Codex review, title and memory requests, and the internal steps of `/review`, have no hook too. After a daemon restart, the first request of the restored turn also goes through. On the daemon, **Stop here** ends such turns.
12. Without the daemon, spare10 sees the quota one model response later than in Claude Code.
13. The unattended `stop` policy costs one more model request for each running loop.
14. In the Codex sandbox, only you can run `spare10 resume` and `spare10 set`. In some modes the agent can run them by itself. These modes are no sandbox, a sandbox that lets the agent write in `~/.codex`, and the automatic review of approvals. `--sandbox danger-full-access` is one mode with no sandbox. In a guarded session, spare10 warns you once when it sees one of these modes. A command that you approve to run outside the sandbox can also run them. This includes a script that the agent wrote. Another MCP server or tool that runs commands for the agent can also run them. Outside the sandbox, a command can also change or remove the spare10 files. spare10 cannot see these cases, and gives no warning for them.
15. When spare10 continues held work by itself, the question can stay on the screen until the turn ends. Press Esc to close it.
16. If spare10 finds no Node.js 20 or later, Codex cannot start a session. Remove or switch off the plugin to go on.
17. In a TUI without the daemon, Esc during a hold also ends the automatic continue of that stop. Held subagents continue at the end of the stop.
18. spare10 does not guard a session when its process stops, or when you switch it off. The same is true when you do not trust its hooks. Then all work goes through, and a typed `spare10` command goes to the model as a prompt.
19. spare10 does not put a dropped prompt back in the prompt box.
20. Windows is not supported yet.
21. Some sessions keep no session log, such as `/side` and `codex exec --ephemeral`. On the Codex daemon, spare10 reads the quota at each step of such a session. Without the daemon, spare10 has only the last readings of other sessions. Then such a session can use the reserve with no question.
22. A question at the reserve can give way to the limit question while its form is on the screen. A form cannot be withdrawn, so the old form stays. Its answer changes nothing. Answer the limit form that follows.
23. Codex tells spare10 when credits can pay past 100%. Then spare10 does not pause at the limit. Claude Code does not tell spare10 about extra usage.
24. During an upgrade, an older spare10 process can show the question at the reserve for the limit question. Its **Resume** only asks again. Its **Stop here** can continue the work after the reset.
25. Without the Codex daemon, spare10 does not see a reset credit or a plan change at the limit. Held work then waits until the old reset. Run `spare10 set limitPause off` to let it go on. With `autoResume` off, then also run `spare10 resume`.

Codex also gives spare10 some things that Claude Code does not:

- A hold has no time budget. So a hold at the weekly quota limit lasts until the reset, and then the work continues.
- When the Codex daemon runs, a `codex exec` run reads the live quota before its first request.
- Work on Codex's own Luna Reserve model goes through while Codex uses it.

## How spare10 works in Codex

- **Sense.** spare10 reads the quota from the Codex daemon. Without the daemon, it reads the last response in the session log. If a read fails, the step goes on. spare10 uses the daemon socket only when you own it and its folder. If every user can write to that folder, spare10 works as without the daemon.
- **Gate.** Nine Codex hooks call the spare10 process of their thread.
- **Hold.** The spare10 process does not answer the hook. Codex waits, for up to 8 days.
- **Ask.** The first held step shows a Codex form. All other held steps wait on the same answer.
- **Continue.** Timers in the spare10 process release held work. A new turn through the daemon continues stopped work.
- **State.** Consent, stops and questions are files in `~/.codex/plugins/data/spare10-spare10/`. spare10 removes the files of a session 30 days after their last change. It does this only when no spare10 process of that session runs. A running Codex daemon does not keep the files. A computer crash can leave a state file empty. spare10 then reads the file as new, and can ask you again.
