#!/bin/sh
# Runs every static and kit check. Needs .claude/types/claude-code.d.ts (see docs/develop.md).
set -eu
cd "$(dirname "$0")/.."
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
claude plugin validate --strict .
claude plugin validate --strict .claude-plugin/plugin.json
claude plugin test .
[ -x node_modules/.bin/tsc ] || npm ci --silent
node_modules/.bin/tsc -p .
# Dependencies: npm ci when esbuild is missing or package-lock.json changed since the last install
lock=$(shasum -a 256 package-lock.json | cut -d' ' -f1)
if [ ! -x node_modules/.bin/esbuild ] || [ "$(cat node_modules/.spare10-lock-hash 2>/dev/null)" != "$lock" ]; then
  npm ci --silent && echo "$lock" > node_modules/.spare10-lock-hash
fi
# Codex. The specs need Node.js 22.18 or later (type stripping). The bundle itself needs Node.js 20.
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'; then
  echo "check: the Codex specs need Node.js 22.18 or later. This is Node.js $(node --version)." >&2
  exit 1
fi
node scripts/versions.mjs                      # VERSION == .claude-plugin/plugin.json == .codex-plugin/plugin.json
node scripts/build-codex.mjs --check           # codex/dist is fresh
node_modules/.bin/tsc -p codex                 # the adapter, its tests and the core against the shim
SPARE10_CODEX_TEST=1 node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  --import ./codex/test/host-loader.mjs --test codex/test/*.spec.ts
if [ "${SPARE10_E2E:-off}" = smoke ]; then
  # Even codex --version makes a folder in $CODEX_HOME/tmp/arg0, so it runs in a throwaway home, never in ~/.codex.
  vhome=$(mktemp -d "${TMPDIR:-/tmp}/s10ver-XXXXXX")
  version=$(env HOME="$vhome" CODEX_HOME="$vhome" codex --version 2>/dev/null || true)
  rm -rf "$vhome"
  if [ "$version" = "codex-cli 0.157.0" ] && command -v python3 >/dev/null 2>&1; then
    sh codex/e2e/run.sh --smoke                # model-free, isolated CODEX_HOME, about 40 s
  else
    echo "check: Codex end-to-end smoke skipped (needs codex-cli 0.157.0 and python3)"
  fi
fi
