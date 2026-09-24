#!/bin/sh
# Runs every static and kit check. Needs .claude/types/claude-code.d.ts (see README, Develop).
set -eu
cd "$(dirname "$0")/.."
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
claude plugin validate --strict .
claude plugin validate --strict .claude-plugin/plugin.json
claude plugin test .
[ -x node_modules/.bin/tsc ] || npm ci --silent
node_modules/.bin/tsc -p .
