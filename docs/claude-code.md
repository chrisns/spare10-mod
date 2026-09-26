# spare10 in Claude Code

This page tells you how spare10 works in Claude Code.
For the options, see [Configure](configure.md).
For Codex, see [spare10 in Codex](codex.md).

## Before you start

You need Claude Code 2.1.281 or later.
spare10-mod is tested on 2.1.281 and 2.1.282.
Function hooks are early access.
A later version can change their API without notice.

Function hooks are off by default.
To switch them on, put this `env` entry in `~/.claude/settings.json`:

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

## The question

At the reserve, spare10 holds each loop at its next tool call or model request.
This includes the main loop, subagents, background agents, workflow agents and in-process teammates.
A tool that already runs is never cut.
The first held step opens one question for the whole session.
All other held steps join it.

```
 ☐ spare10
Your 10% reserve is reached: 91% used · 9% left · resets 14:00. All work is on hold. Continue on the reserve until 95% used? Until 13:40, spare10 asks you again at 95% used. If you choose Stop here or do not answer, the work waits until 13:40, 20 min before the reset. Then spare10 continues it, unless a reserve is still reached.
❯ 1. Stop here
  2. Resume
  3. Type something.
  4. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
```

This is the first question.
A **Resume** here lasts until the floor, by default 95% used.
At the floor, spare10 asks a second question.
See [The resume floor](#the-resume-floor).

At 13:40 the reserve opens, 20 minutes before the reset.
From then on, spare10 asks nothing, also past the floor.
See [Skip near the reset](#skip-near-the-reset).
With an open time of 0, the question says `the work waits until 14:00`.
It also says `At 95% used, spare10 asks you again.`, because no reserve opens before the reset.
With **Continue at the reset** off, the question ends at `Until 13:40, spare10 asks you again at 95% used.`
With a floor of 0, the question asks `Continue on the reserve until 14:00?`, as in spare10-mod 0.2.

The weekly window has the same question, with the weekly wording.
Its times show the weekday, such as `Mon 09:00`.
A reset more than 6 days away also shows the date, such as `Thu 1 Oct 11:00`.
When both windows are in the reserve, one question names both:

```
Your 10% reserve and your 10% weekly reserve are reached: 5-hour window 91% used · 9% left · resets 14:00, weekly window 92% used · 8% left · resets Mon 09:00. All work is on hold. Continue on both reserves until 95% used? Until its reserve opens, spare10 asks you again at 95% used of either window. If you choose Stop here or do not answer, the work waits until Mon 01:00, 8 h before the weekly reset. Then spare10 continues it, unless a reserve is still reached.
```

The question names the windows that are in the reserve when it opens.
Another window can reach its reserve while the question waits.
**Resume** does not apply to that window.
After a **Resume**, spare10 asks you again about it.
**Stop here** also stops the work on that window.
With **Continue at the reset** on, the stop then also waits for that window.
It lasts until that window opens its reserve, or resets.

**Stop here** has the focus, so a stray Enter never spends the reserve.
Only the exact label `Resume` continues.
A typed `Resume` under `Type something.` also continues.
All other answers are **Stop here**: Esc, `Chat about this`, other text, and a dialog that closes with no answer.

**Resume**:

- Each held tool call runs.
- Each held model request goes out.
- A held prompt enters.
- The model reads nothing extra, because it does not know that it waited.
- spare10 stays quiet until the floor, by default 95% used.
  If the window resets first, it stays quiet until the reset.
  At the floor, it asks you again. See [The resume floor](#the-resume-floor).
- The transcript shows `spare10: continuing on your 10% reserve until 95% used. Until 13:40, spare10 asks you again at 95% used.`

**Stop here**:

- spare10 denies each held tool call.
- spare10 answers each held model request itself, and sends no request.
- spare10 ends the main turn, so a Stop hook cannot start the loop again.
- spare10 refuses all later steps until the reserve opens, or until you continue.
  With an open time of 0, this lasts until the reset.
- The session stays open and idle.
- With **Continue at the reset** on, spare10 continues the stopped work when the reserve opens.
  It sends Claude a short message that the stop is over.
- The transcript shows `spare10: stopped at your 10% reserve until 13:40, 20 min before the reset. Then spare10 continues the work, unless a reserve is still reached. Type a prompt to be asked again, or run /spare10 resume.`
- With the option off, the transcript shows `spare10: stopped at your 10% reserve until 13:40, 20 min before the reset. Type a prompt to be asked again, or run /spare10 resume.`
  At 13:40 the stop ends, and your next prompt goes in with no question.
  spare10 sends nothing.
- With the option off and an open time of 0, the transcript shows `spare10: stopped at your 10% reserve. Type a prompt to be asked again, or run /spare10 resume.`

The model reads one of these texts after a Stop:

```
spare10: the user stopped work at the quota reserve (into your 10% reserve · 9% of quota left · resets 14:00). Stop now and wait for the user. Do not call any further tools.
spare10: work stopped at the quota reserve (into your 10% reserve · 9% of quota left · resets 14:00). No model request was sent, so this task is not finished. Wait for the user.
```

## The resume floor

A **Resume** at the reserve does not spend the whole reserve.
It lasts until the floor.
By default the floor is 5% left, which is 95% used.
If the window resets first, the **Resume** lasts until the reset.

At the floor, spare10 holds all work again and asks the second question:

```
 ☐ spare10
Your 5% floor is reached: 96% used · 4% left · resets 14:00. All work is on hold. Continue on the last 4% until 14:00? If you choose Stop here or do not answer, the work waits until 13:40, 20 min before the reset. Then spare10 continues it, unless a reserve is still reached.
```

The second question names what is left now.
This can be less than the floor, because the reading can pass the floor between two steps.
A second **Resume** lets the work use the rest, until the reset.
spare10 does not ask again about that window before the reset.
The transcript shows `spare10: continuing on your 5% floor. spare10 stays quiet until 14:00.`
**Stop here** works as at the first question.
The stop notice and the texts for Claude then name `your 5% floor`.

Example: the reserve is 10%, the floor is 5%, and the 5-hour window resets at 14:00.

- At 91% used, spare10 holds the work and asks the first question. You choose **Resume**.
- The work goes on with no question. The badge shows `⨯ spare10: resumed until 95% used`.
- The reading passes the floor, for example to 96% used.
  At the next step, spare10 holds the work and asks the second question. You choose **Resume**.
- The work goes on until 14:00 with no question. The badge shows `⨯ spare10`.

To see the two questions with a test reading, type `/spare10 simulate 91 in 1h`.
Send a prompt, and choose **Resume**.
Then type `/spare10 simulate 96`, and send a prompt again.
The higher value keeps your first answer, so the second question shows.

The first **Resume** ends for good at the floor.
If the reading falls again before the reset, spare10 asks the first question again.

If the reading is past the floor when spare10 first asks, you get only the second question.
Its **Resume** lasts until the reset.
If the reading passes the floor while the first question waits, a **Resume** shows the second question at once.

Each window has its own floor.
The weekly floor is 5% of the weekly window by default.
Set the floors in `/config`. `0` switches a floor off. Then a **Resume** lasts until the reset.
A floor at or above its reserve does nothing, and spare10 warns you.

`/spare10 resume` follows the reading at the time of the command:

- Before the floor, it continues until the floor.
  It replies `spare10: you can use the reserve until 95% used. Until 13:40, spare10 asks you again at 95% used.`
- Past the floor, it continues until the reset.
  It replies `spare10: you can use the last 4% until 14:00.`

You cannot skip the second question with it. Set the floor to `0` for that.

While a reserve is open near the reset, spare10 asks nothing, also past the floor.
So the question says until when spare10 asks again, such as `Until 13:40`.

With a pause prompt, spare10 does not hold the work at the floor.
It tells each agent again, with the text `You have reached the floor of the quota reserve for this session`.
The transcript shows `spare10: your 5% floor is reached. spare10 told the agents to wind down.`
A prompt that you send before the main loop gets that text asks the second question.
See [The pause prompt](#the-pause-prompt).

Unattended runs never ask, so the floor changes nothing there.
See [Unattended runs](configure.md#unattended-runs).

## Skip near the reset

The quota refreshes at the reset.
A reserve that you do not use by then is lost.
So by default spare10 skips the reserve check shortly before the reset, and opens the reserve:

- in the last 20 minutes of the 5-hour window
- in the last 8 hours of the weekly window

These are the open times. You can change them in `/config`.
While a reserve is open, spare10 lets all work use it and asks nothing.
Each window has its own time.
A weekly trip still holds the work in the last 20 minutes of the 5-hour window.
Before that time, spare10 guards the reserve as usual.

Example: the reserve is 10%, and the 5-hour window resets at 16:40.

- At 14:00, with 92% used, spare10 holds the work and asks you.
  The question says `the work waits until 16:20, 20 min before the reset`.
- At 16:25, with 93% used, the work goes on with no question.
  The badge shows `↻ spare10: reserve open until 16:40`.

**With Continue at the reset on**, held and stopped work continues when the reserve opens.
The question, the stop notice and the badge give that time.
spare10 adds no margin here, because the reset is still ahead.
If the clock of your computer runs fast, the reserve opens early by the same amount.
The work then still uses the reserve of the window that ends.
When the reserve opens, the transcript shows `spare10: the 5-hour window resets at 16:40. Your 10% reserve is open until then. Held work continues.`
After a stop, Claude gets a short message that starts `The 5-hour window resets at 16:40. Your 10% reserve is open until then, so the stop at the quota reserve is over.`

**With Continue at the reset off**, held work still waits for your answer.
When the reserve opens, the transcript tells you once:
`spare10: the 5-hour window resets at 16:40. Your 10% reserve is open until then, but held work still waits for your answer. New work goes on with no question.`
If the other window still holds work at its reserve, new work waits too. Then the line does not have the part `New work goes on with no question.`
A **Stop here** ends when the reserve opens.
Your next prompt then goes in with no question, and spare10 sends nothing.

A question can stay on the screen for a short time after the reserve opens.
A **Stop here** in that time does not stop the open window:

- With **Continue at the reset** on, spare10 continues the held work at its next check, within about 30 s.
- With the option off, spare10 refuses the held work, and new work goes on with no question.

While a reserve is open:

- `/spare10 stop` stops only a window that is in its reserve and not open. This includes a window that you chose to continue on.
  If every window in its reserve is open, it stops nothing and says that the reserve is open.
- `/spare10 resume` has nothing to do, unless another window holds the work.
- In tell mode, no agent gets the pause prompt.
- Every unattended policy lets the work through. See [Unattended runs](configure.md#unattended-runs).

To keep a reserve until the reset, set its open time to `0`. See [Configure](configure.md#options).
The change also applies to work that spare10 holds now.

spare10 opens a reserve only when it knows the reset time.
A reading without a reset time keeps the guard until the reset.

## At the reset

This part applies with **Continue at the reset** on, which is the default.
It applies to a window that does not open its reserve before the reset.
That is a window with an open time of 0, or a reading without a reset time.
spare10 does not act at the exact time of the reset.
It waits 5 minutes after the reset, and then reads the quota again.
A window that is still in its reserve keeps the work on hold.

**An open question.**
If nobody answers, the held work continues after the reset, unless a reserve is still reached.
spare10 removes the dialog and writes no consent.
The transcript shows `spare10: the 5-hour window reset. Held work continues.`
If another window is still in its reserve, a new question holds the work.
The transcript then shows `spare10: the 5-hour window reset, but your 10% weekly reserve is reached. Held work still waits.`

The quota can leave the reserve before the reset, for example after a limit reset.
Then the held work continues within about a minute.
The transcript shows `spare10: the quota is no longer in the reserve. Held work continues.`

**A stop.**
After a **Stop here** that stopped work, spare10 continues that work.
A **Stop here** on a later question keeps the work of an earlier stop that spare10 did not continue yet.
The transcript shows `spare10: the 5-hour window reset. spare10 continues the stopped work.`
Then spare10 sends Claude this message, and a new turn starts:

```
The 5-hour window reset, so the stop at the quota reserve is over. spare10 is set to continue the work at the reset, so do not wait for the user. Continue the task from the point where it stopped. A subagent whose result says "spare10: work stopped" or "spare10: the user stopped work" did not finish. Run it again if you still need its result.
```

The message names no figures, because the new window has none yet.
spare10 does not start a stopped subagent again.
The model does this if it still needs the result.

If a window is still in its reserve, the stop continues until that window opens its reserve or resets.
The transcript then shows `spare10: the 5-hour window reset, but your 10% weekly reserve is reached. The stop lasts until Mon 01:00, 8 h before the weekly reset.`
If you type in the prompt box at the reset, the message waits.
After 5 minutes, it goes anyway.
If the message fails, the transcript shows `spare10: could not continue the stopped work: <reason>. Type a prompt to continue.`

**With the option off.**
Switch off **Continue at the reset** to get the behaviour of spare10-mod 0.1 at the reset.
Then an open question waits for your answer with no time limit.
The window reset does not release the work and does not stop it.
At the reset, the transcript shows `spare10: the 5-hour window reset. Held work still waits for your answer.`
A stop ends at the reset, and spare10 sends nothing.
A stop made while the option was off never continues by itself.
This is also true after you switch the option on.

A question time limit turns an unanswered question into **Stop here**.
See [Configure](configure.md#options).

## Your prompts

Inside the reserve, spare10 asks before your prompt enters.
The question then says `spare10 holds your prompt and any other work.`
With **Continue at the reset** on, the question ends like this:
`If you do not answer, all of it continues at 13:40, 20 min before the reset, unless a reserve is still reached. Stop here gives your prompt back and pauses other work until 13:40.`
**Resume** lets the prompt enter.
After a stop, the prompt also carries a short note.
The note tells the model that you chose to continue.
**Stop here** drops the prompt, and Claude Code shows this line:

```
Prompt dropped by a hook: spare10: not started. This session is inside your 10% reserve until 14:00. Send the prompt again to be asked again, or run /spare10 resume.
```

spare10 then puts your text back in the prompt box, if the box is empty.
When the stop ends, spare10 does not send that text for you.
If no other work stopped, the transcript shows `spare10: the 5-hour window resets at 14:00. Your 10% reserve is open until then, and the stop is over. Type a prompt to continue.`
After a reset, it shows `spare10: the 5-hour window reset, and the stop is over. Type a prompt to continue.`

You can send a prompt after the stop ends, before spare10 continues the stopped work.
Your prompt then ends the stop, and spare10 sends no message of its own.
The transcript shows `spare10: the 5-hour window resets at 14:00. Your 10% reserve is open until then, and the stop is over.`
After a reset, it shows `spare10: the 5-hour window reset, and the stop is over.`
If the stop held work, your prompt carries a short note.
The note tells the model to continue the stopped task after your message.

spare10 never asks about prompts that nobody typed, such as task notifications or scheduled prompts.
These prompts enter.
spare10 then gates their model requests like all other steps.

## The pause prompt

Set a pause prompt to tell the agents to wind down instead of stopping them.
Then spare10 does not hold the agents.
It holds only a prompt that you send before the main loop gets the instruction.
Each loop gets this text at the reserve, on its next tool result:

```
spare10 budget guard. You have reached the safe usage limit for this session (into your 10% reserve · 9% of quota left · resets 14:00). Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.

User instructions: Finish this block, commit, then stop.
```

The tool still runs.
The transcript shows `spare10: your 10% reserve is reached. spare10 told the agents to wind down.` once per window.
Until the main loop gets the instruction, a prompt that you send still asks first.
Its question says `spare10 holds your prompt.`
It also says `Until 13:40, spare10 tells the agents to wind down at 95% used.`
With **Continue at the reset** on, the question ends like this:
`If you do not answer, your prompt goes in at 13:40, 20 min before the reset, unless a reserve is still reached. Stop here gives it back to you.`
If you choose **Resume**, no agent gets the instruction until the floor.
If you choose **Stop here**, spare10 drops the prompt and puts the text back.
Nothing else stops.

At the floor, each loop gets the instruction again, once.
Its first sentence then reads `You have reached the floor of the quota reserve for this session (into your 5% floor · 4% of quota left · resets 14:00).`
The transcript shows `spare10: your 5% floor is reached. spare10 told the agents to wind down.` once per window.
Until the main loop gets this second instruction, a prompt that you send asks the second question.
If you choose **Resume** there, no agent gets the instruction again in that window.
With a floor of 0, each loop gets the instruction once per window, as in spare10-mod 0.2.

While the reserve is open, no agent gets the instruction, and your prompts go in with no question.
An agent that got the instruction before that time gets no message to go on.
Type a prompt to continue it.

## The badge

The badge is at the right of the prompt footer, in the terminal and the desktop app.
Its colours follow your theme.
The label is `spare10`, or `spare10 (15%)` when the reserve is not 10.
The weekly reserve never shows in the label.
While a test reading applies, the label ends with ` (test)`.
The rows without a label, such as `⚠ Pausing at next step`, show no ` (test)`.

| Badge | Meaning |
|---|---|
| `○ spare10 off` | spare10 is not enabled in this run. It only watches. |
| `? spare10: waiting for you until 13:40` | A question is open. Held work waits for your answer, or until 13:40, when the reserve opens. |
| `? spare10: waiting for you` | A question is open, and **Continue at the reset** is off. Held work waits for your answer. |
| `⚠ spare10 quota unavailable` | Claude Code reports no 5-hour quota. spare10 lets all work through. |
| `⧗ spare10` | There is no reading yet. spare10 lets all work through. |
| `● spare10` | Usage is below each reserve. |
| `⨯ spare10: resumed until 95% used` | You chose to continue at the reserve. At 95% used, spare10 asks you again. |
| `⨯ spare10` | You chose to continue until the window resets. |
| `↻ spare10: reserve open until 14:00` | The reset is near. spare10 lets all work use the reserve until 14:00. |
| `■ spare10: stopped until 13:40` | You chose **Stop here**. The stop ends at 13:40, when the reserve opens. With **Continue at the reset** on, spare10 then continues any stopped work. |
| `■ spare10: stopped` | You chose **Stop here**. spare10 does not continue the work by itself. **Continue at the reset** is off, or was off at the stop. The stop ends at the reset. |
| `⏸ spare10` | At least one agent got the pause prompt. |
| `⚠ spare10: in the reserve` | An unattended run is inside the reserve. |
| `⚠ Pausing at next step` | Usage reached a reserve. spare10 holds the next step and asks you. The glyph blinks. |
| `⚠ Winding down at next step` | Usage reached a reserve. Each agent gets the pause prompt at its next tool result. The glyph blinks. |

The time in a `?` or `■` row is the time when the hold or the stop ends.
That is the time when the reserve opens, or the reset.
After a reset, spare10 continues the work about 5 minutes later.
A stop that ends when the reserve opens always shows its time, also with **Continue at the reset** off.
The time in the `↻` row is the reset.
The `⨯` row with `resumed until` names the floor point that comes first.
A weekly time shows the weekday, such as `Mon 09:00`.
The badge does not tell you which window tripped.
Type `/spare10` to see both windows.

While the dialog is on the screen, Claude Code hides the footer.
So the `?` badge shows only when the dialog waits behind another dialog, or when no dialog could show.
The vscode and mobile surfaces have no footer, so there the dialog is the only sign.

## The `/spare10` command

| Command | What it does |
|---|---|
| `/spare10` or `/spare10 status` | Shows the phase, the reserves, the open times, the floors, the readings, the consents, what happens at the reset and any warnings. |
| `/spare10 resume` | Continues on the reserve until the floor, or past the floor until the window resets. It answers an open question with **Resume**. |
| `/spare10 stop` | Stops at the reserve now. It answers an open question with **Stop here**. |

`/spare10` runs at once, also while a turn runs.
Only you can run `resume` and `stop`, from the prompt box or a remote surface.
You cannot type `/spare10` while the dialog is on the screen, because the dialog holds the keys.
Use `/spare10 resume` or `/spare10 stop` when no dialog shows, or from a remote surface.

`/spare10` prints a report like this:

```
spare10: version 0.3.0

  ● armed          spare10 steps in at 90% used, or at 90% used of the weekly window.
  · reserve        10% of the 5-hour window (from /config)
  · weekly reserve 10% of the weekly window (from /config)
  · reserve opens  in the last 20 min of the 5-hour window (from /config)
  · weekly opens   in the last 8 h of the weekly window (from /config)
  · resume floor   5%: after a Resume, spare10 asks again at 95% used (from /config)
  · weekly floor   5%: after a Resume, spare10 asks again at 95% used of the weekly window (from /config)
  · at the reserve stop and ask you
  · at the reset   continue by itself (from /config)
  · reading        live · 42% used · 58% left · resets 14:00 (in 2 h 14 min)
  · weekly reading live · 61% used · 39% left · resets Mon 09:00 (in 3 d 21 h)
  · consent        none
  · weekly consent none
  · guarded        yes (scope all)
  · claude -p      runs started here: stop

/spare10 resume   continue on the reserve until the floor, or past the floor until the reset
/spare10 stop     stop at the reserve now
```

Claude Code puts `spare10: ` in front of each reply and each transcript line of spare10.

- The `reserve opens` and `weekly opens` rows show the open times and where they come from.
  `only at the reset` means that the open time is 0.
  `spare10 could not read the env` means that spare10 uses an open time of 0 until it can read the variables.
- The `resume floor` and `weekly floor` rows show the floors and where they come from.
  `off` means that a **Resume** lasts until the reset.
  `does nothing` means that the floor is at or above its reserve, such as `12% does nothing, because it is not below the reserve`.
  In an unattended run, the rows say that the floor does nothing, because the run never asks.
- The `consent` row shows the end of a **Resume** at the reserve, such as `until 95% used or 14:00`.
  When the reading reaches it, the row says `ended at 95% used`.
- The `at the reset` row says `continue by itself` or `wait for your answer`.
- With a weekly reserve of 0, the `weekly reserve` row says `off`.
  Then the `weekly opens`, `weekly floor`, `weekly reading` and `weekly consent` rows do not show.
- When neither floor applies, the last lines say `/spare10 resume   continue on the reserve until the window resets`.
- If the reset check does not run in this session, the report shows this warning:
  `⚠ spare10 cannot check the reset in this session. Type a prompt to continue after the reset.`

While a reserve is open, the phase line reads like this:

```
  ↻ open           the reset is near. Your 10% reserve is open until 14:00, so spare10 lets all work through.
```

After a **Resume** at the reserve, the phase line and the consent row read like this:

```
  ⨯ consented      you chose to continue. Until 13:40, spare10 asks you again at 95% used.
  · consent        until 95% used or 14:00 (you chose to continue)
```

A second `/spare10 resume` before the floor replies `spare10: already resumed until 95% used. Until 13:40, spare10 asks you again at 95% used.`

`/spare10 stop` works only inside the reserve, when spare10 is tripped or you chose to continue.
Below the trip point it changes nothing.

While a reserve is open, `/spare10 stop` and `/spare10 resume` have nothing to do.
They write nothing, and reply like this:

```
spare10: nothing to stop. The reset is near, so your 10% reserve is open until 14:00. To keep a reserve until the reset, set its Open reserve option to 0 in /config.
spare10: nothing to resume. The reset is near, so your 10% reserve is open until 14:00.
```

If the other window is in its reserve and not open, `/spare10 stop` stops that window only.

A stop can be past its end before spare10 continues it.
If the stop no longer holds work, `/spare10 resume` ends it, and spare10 sends no message to Claude.
If no window is in its reserve and not open, `/spare10 stop` does the same.
After a reset, `/spare10 resume` replies `spare10: the 5-hour window reset, and the stop is over. Type a prompt to continue.`
After a reset, `/spare10 stop` replies `spare10: the stop ended at the reset. spare10 will not continue the stopped work.`
When the reserve opened, the replies are these:

```
spare10: the 5-hour window resets at 14:00. Your 10% reserve is open until then, and the stop is over. Type a prompt to continue.
spare10: the stop is over, because the reset is near. Your 10% reserve is open until 14:00. spare10 will not continue the stopped work.
```

A window can be in its reserve again at that time.
For example, a real reading reached the reserve after the stop.
Then `/spare10 stop` ends the old stop and stops that window at once, also with a pause prompt.
The new stop keeps the stopped work of the old stop.
The reply names no reset and no open reserve, because none came:

```
spare10: stopped at the reserve until 13:40, 20 min before the reset. Then spare10 continues any stopped work. Type a prompt to be asked again, or run /spare10 resume.
```

During a stop, `/spare10 stop` also adds each window that reached its reserve after the stop.

A stop can reach its end while its window still holds work.
This happens when a test window ends over a real reading in the reserve.
It also happens when you lower an open time after the stop, for example to 0.
Then the stop continues to hold, also with a pause prompt.
spare10 refuses the calls of Claude, and a prompt asks you first, as during the stop.
With **Continue at the reset** on, spare10 extends the stop at its next check.
The extension stops each window that is in its reserve at that time.
This can be a window that started after the stop, such as the next 5-hour window during a weekly stop.
With **Continue at the reset** off, the stop holds until the reserve of that window opens, or until the reset.
`/spare10 resume` ends the stop and lets you continue on the reserve.
`/spare10 stop` keeps the stop and replies with its end, such as `spare10: already stopped until 13:40.`
With **Continue at the reset** off, the stop can now last until the reset.
Then the reply is `spare10: already stopped.`

A stop holds past its end only when all of these are true:

- The stop ends when a reserve opens, or you chose it on a test reading.
- The real reading of the window was in the reserve when the stop took that window.
  The stop takes a window when you choose the stop, or when spare10 extends it.
  A `/spare10 stop` during the stop also takes each window in its reserve.
  A test reading on top of it does not count.
- The real reading is still in the same window and in the reserve.
  Its reserve is not open, and you did not choose **Resume**.

The stop record keeps the reset time of that real reading.
spare10 compares it with the reset time of the real reading now, so it knows the window.
If one of the two reset times is not known, spare10 cannot see the window.
Then the stop holds while that reading is in the reserve.

So the stop still holds after a plugin reload, and after you change an open time.
A change in `/config` reloads the plugin.
A trip in a later window asks you again.
A real reading that reaches the reserve after the stop also asks you again.
With a pause prompt, spare10 tells Claude again in these two cases.
To stop that work too, run `/spare10 stop`.

## How long a choice lasts

- **Resume** at the reserve lasts until the floor, by default 95% used.
  If the window resets first, it lasts until the reset.
  A second **Resume** at the floor lasts until the window resets.
  A **Resume** on a weekly trip does the same with the weekly floor and the weekly reset.
  When the question names both windows, **Resume** covers each window on its own.
  It applies to this process and to the `claude -p` runs that it starts.
  `/clear` and `/resume` inside the session keep it.
- A **Resume** on a test reading applies only while that test reading applies.
  A reload, a new `/spare10 simulate` value or `/spare10 simulate off` ends it.
  A higher value without `in` keeps it.
- **Stop here** lasts until the reserve opens, or until the window resets when it does not open before.
  It applies to this conversation only.
  With **Continue at the reset** on, spare10 then continues the stopped work.
  With the option off, the stop ends, and spare10 sends nothing.
- `/exit` ends a stop for good.
- `/clear` ends a stop for good, unless you `/resume` that conversation before the stop ends.
  `/resume` to another conversation does the same.
  The next prompt then asks again.
- An open question stays open after `/clear`.
  Your answer still applies to all held work.
  With **Continue at the reset** on, the held work still continues when the reserve opens, or after the reset.
- After `/clear`, each loop gets the wind-down text again.
  This applies to the pause prompt and to the unattended `prompt` policy.
- A new terminal starts armed, and asks on its own.
- At the reset, spare10 arms again by itself.

## Background sessions

Each `claude --bg` session runs its own copy of spare10.
No question time limit applies to its question.
With **Continue at the reset** on, held work continues as in a terminal, when the reserve opens or after the reset.
`claude agents` shows the job as `blocked`, with the question and both labels.
Type `resume` in the agent view to answer **Resume**.
Any other reply is **Stop here**.

A background session does not take the consent of another session.
It asks on its own.
A background session gets its environment from the `claude daemon`, not from your terminal.
The daemon can start from a session that you started with one of these variables:
`SPARE10=off`, `SPARE10_RESERVE`, `SPARE10_WEEKLY_RESERVE`, `SPARE10_LAST_MINUTES`, `SPARE10_WEEKLY_LAST_HOURS`, `SPARE10_RESUME_FLOOR`, `SPARE10_WEEKLY_RESUME_FLOOR`, `SPARE10_PAUSE_PROMPT` or `SPARE10_AUTO_RESUME`.
Then every background session that the daemon starts gets these values.
spare10 shows a warning in each background session that has them.

## Test reading

A test reading trips spare10 at any time, far from the real reserve.

The command takes this form:

```
/spare10 simulate off
/spare10 simulate <percent> [5h|weekly] [in <n>s|m|h|d]
```

- `/spare10 simulate 92` sets a test reading of 92% used for the 5-hour window. Only you can run it.
- `/spare10 simulate 92 weekly` sets a test reading for the weekly window.
  The words `5h`, `5-hour`, `five_hour`, `weekly`, `7d` and `seven_day` name a window, in any case.
  Without a window word, the test reading is for the 5-hour window.
- `/spare10 simulate 92 in 22m` sets a test window that ends in 22 minutes.
  The time is 10 s at least, and the window length at most.
- A test window has an open time too.
  With the default open time, `in 22m` opens the reserve 2 minutes later, with no margin.
  For the weekly window, use `in 482m`.
  A test window shorter than 20 minutes (8 hours for the weekly window) is open at once.
- To see the reset itself, start Claude Code with `SPARE10_LAST_MINUTES=0 SPARE10_WEEKLY_LAST_HOURS=0`.
  Then spare10 waits 60 s after the end of a test window, so `in 2m` continues about 3 minutes later.
- Without `in`, the test window ends at the reset of the live reading.
  If that reset is less than 20 minutes away, the reserve is open at once.
  If that live reading is in the reserve, spare10 waits 5 minutes after the reset, not 60 s.
  Without a live reading, it ends 5 hours from now, or 7 days for the weekly window.
- Each window has one test reading.
  A new value for a window clears the consent and the stop.
  A higher value without `in` is different: it raises the test reading in place, and your answers stay.
  So `/spare10 simulate 96` after a **Resume** at 91% shows the second question.
  The same value again, a lower value or a value with `in` starts a new test.
- `/spare10 simulate off` clears both test readings, both consents and the stop.
- With a weekly reserve of 0, `/spare10 simulate 92 weekly` changes nothing.
- `SPARE10_SIMULATE` at launch takes the same words for a `-p` run, such as `92`, `92 weekly` or `92 weekly in 2m`.
  There, `in` counts from the first gated event.
  spare10 reads it once per load, so it never raises a test reading in place.

A test reading can only raise the real reading.
It never releases a hold that the real reading causes, because spare10 reads the real quota before each release.
A test reading opens the reserve only when the real reading is below the reserve, or open by itself.
When the real reading is in the reserve, the work waits until the real reserve opens.
While it applies, `/spare10` shows `test reading`, and the labelled badge rows show `(test)`.
The rows `⚠ Pausing at next step` and `⚠ Winding down at next step` have no label.
A **Resume** on a test reading never goes into `SPARE10_CONSENT` or `SPARE10_WEEKLY_CONSENT`.
So a reload or a real trip past the test reading asks you again.
While the test reading is the higher one, a **Resume** on it also covers the real reading beneath it.
So run a test only while the real reading is below the reserve.
A stop on a test reading reads the real quota at its end.
If the real quota is in the reserve, the stop continues.

The reply to `/spare10 simulate` says when the reserve opens:

```
spare10: test reading set to 92% used, resets 14:22. It can only raise the real reading. The reserve opens at 14:02, 20 min before the test window ends. Run /spare10 simulate off to clear it.
spare10: test reading set to 92% used, resets 14:10. It can only raise the real reading. The test window ends within 20 min, so the reserve is open at once. Run /spare10 simulate off to clear it.
spare10: test reading set to 92% used, resets 14:22. It can only raise the real reading. The real reading is also in the reserve, so the test window does not open it. A Resume on the test reading also lets real work use the reserve. Run /spare10 simulate off to clear it.
```

The last reply warns you that a **Resume** on the test reading also covers the real reading.
It gives this warning when the real reading is in the reserve and below the test reading.

A value at or past the floor adds `This is past your 5% floor.` to the reply.
A raise in place has its own reply:

```
spare10: test reading raised to 96% used, resets 14:22. Your earlier answers stay. It can only raise the real reading. This is past your 5% floor. The reserve opens at 14:02, 20 min before the test window ends. Run /spare10 simulate off to clear it.
```
