# spare10 in Codex

spare10 also runs in the OpenAI Codex CLI.
It is tested on Codex CLI 0.157.0.
The same repo is a Codex plugin.
It has the same options, questions, rules and texts as in Claude Code.
Some parts work in a different way, because Codex has other hooks.
[Differences in Codex](#differences-in-codex) lists them.

## Install in Codex

You need Node.js 20 or later.
spare10 looks for it on your `PATH`, in Homebrew, in Volta and in nvm.

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
The full answer shows in the transcript.

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

## Commands in Codex

Type a command as the whole prompt.
spare10 sends no model request for it.

| Command | What it does |
|---|---|
| `spare10` or `spare10 status` | Shows the status report. |
| `spare10 resume` | Continues on the reserve until the floor, or past the floor until the reset. |
| `spare10 stop` | Stops at the reserve now. |
| `spare10 simulate ...` | Sets a test reading, as `/spare10 simulate` does. See [Test reading](claude-code.md#test-reading). |
| `spare10 set` | Shows the options and where each value comes from. |
| `spare10 set <option> <value>` | Changes an option, such as `spare10 set reserve 15`. |
| `spare10 set <option> default` | Puts an option back to its default. |
| `spare10 help` | Lists the commands. |

A prompt is a command only in these forms.
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
Their names are `reserve`, `weeklyReserve`, `lastMinutes`, `weeklyLastHours`, `resumeFloor`, `weeklyResumeFloor`, `pausePrompt`, `autoResume`, `headless` and `scope`.
A `SPARE10_*` variable with a valid value wins over the file, as in Claude Code.

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
14. In the Codex sandbox, only you can run `spare10 resume` and `spare10 set`. In some modes the agent can run them by itself. These modes are no sandbox, a writable folder that holds `~/.codex`, and the automatic review of approvals. `--sandbox danger-full-access` is one mode with no sandbox. This version of spare10 does not warn you about these modes.
15. When spare10 continues held work by itself, the question can stay on the screen until the turn ends. Press Esc to close it.
16. If spare10 finds no Node.js 20 or later, Codex cannot start a session. Remove or switch off the plugin to go on.
17. In a TUI without the daemon, Esc during a hold also ends the automatic continue of that stop. Held subagents continue at the end of the stop.
18. spare10 does not guard a session when its process stops, or when you switch it off. The same is true when you do not trust its hooks. Then all work goes through, and a typed `spare10` command goes to the model as a prompt.
19. spare10 does not put a dropped prompt back in the prompt box.
20. Windows is not supported yet.
21. Some sessions keep no session log, such as `/side` and `codex exec --ephemeral`. On the Codex daemon, spare10 reads the quota at each step of such a session. Without the daemon, spare10 has only the last readings of other sessions. Then such a session can use the reserve with no question.

Codex also gives spare10 some things that Claude Code does not:

- A hold has no time budget.
- When the Codex daemon runs, a `codex exec` run reads the live quota before its first request.
- Work on Codex's own Luna Reserve model goes through while Codex uses it.
- After a Codex reset credit, an old **Resume** does not cover the new window.

## How spare10 works in Codex

- **Sense.** spare10 reads the quota from the Codex daemon. Without the daemon, it reads the last response in the session log. If a read fails, the step goes on. spare10 uses the daemon socket only when you own it and its folder. If every user can write to that folder, spare10 works as without the daemon.
- **Gate.** Nine Codex hooks call the spare10 process of their thread.
- **Hold.** The spare10 process does not answer the hook. Codex waits, for up to 8 days.
- **Ask.** The first held step shows a Codex form. All other held steps wait on the same answer.
- **Continue.** Timers in the spare10 process release held work. A new turn through the daemon continues stopped work.
- **State.** Consent, stops and questions are files in `~/.codex/plugins/data/spare10-spare10/`. spare10 removes the files of a session 30 days after their last change, when no process of that session runs. A computer crash can leave a state file empty. spare10 then reads the file as new, and can ask you again.
