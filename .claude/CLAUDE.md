# spare10-mod

spare10 (https://github.com/alesdi/spare10) re-invented as a Claude Code mod: a plugin with a function-hooks module.
It targets Claude Code 2.1.281, where function hooks are early access (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`).

- The repo root is the plugin root and a one-plugin marketplace (`.claude-plugin/`).
- `hooks/register.tsx` is the only file that uses `$`. Every hook and every function that gets `$` lives there.
- `hooks/core/*.ts` is pure. It never names `$`, and imports only types from `claude-code` and other core files.
- `hooks/core/text.ts` holds every text that a person or the model reads. Keep its `VERSION` equal to `plugin.json`.
- The engine puts `spare10: ` in front of each transcript line (`$.ui.log` without `to`) and each `command.run` reply. So never start those texts with `spare10`. Model texts, drop reasons and debug lines keep their own `spare10: `. A pure test and a kit test guard this.
- `SPARE10_CONSENT` is `<session id> <iso>`. The process env reaches every descendant, also the `claude daemon` of `--bg` sessions. An attended session takes only its own stamp. A Resume on a test reading never goes into the env.
- Tests: `tests/core` (pure), `tests/kit` (through the engine), helpers in `tests/helpers` (never `*.test.ts`).
- Check: `scripts/check.sh` (validate twice, `claude plugin test .`, tsc 5.9.3). It must pass before a commit.
- Once per Claude Code version, run `claude -p "/plugin-types"` first. It is local and makes no model request.
- Static rules the engine enforces at load: README.md, "Rules the engine enforces". Obey them all.
- No `setTimeout`, `console` or `$.state`, in hooks or tests. Use `$.clock`, `$.ui.log` and `w.clock.settle()`.
- Live checks for a person or a tmux-driven agent: `docs/live-checks.md`. Record each result there.
- Write all prose (README, docs, CHANGELOG) in ASD-STE100: one idea per sentence, 20 words at most, active voice.
- Never use an em-dash or an en-dash anywhere: code, comments, docs or tests. No semicolons in user-facing prose.
- Add a line under `[Unreleased]` in CHANGELOG.md for each user-facing change.
- Keep this file in `.claude/`. A `CLAUDE.md` at the plugin root makes `validate --strict` fail with a warning.
