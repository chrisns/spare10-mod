#!/bin/sh
# Runs the spare10 end-to-end set (Codex design 8.3) with the real Codex and the mock provider.
# usage: sh codex/e2e/run.sh [--smoke] [--keep] [--only E1,E2]
# No run sends a model request to a real provider, and no run reads or writes ~/.codex: each run gets a new
# CODEX_HOME in a work folder under $SPARE10_E2E_TMP (default /tmp, short for the socket path limit).
# --smoke runs the smoke set only. --keep keeps the work folder. A failed run keeps it too, for its logs.
set -eu
cd "$(dirname "$0")/../.."
export SPARE10_CODEX_TEST=1

smoke=
keep=
only=
while [ $# -gt 0 ]; do
  case "$1" in
    --smoke) smoke=--smoke ;;
    --keep) keep=1 ;;
    --only) only="$2"; shift ;;
    *) echo "usage: sh codex/e2e/run.sh [--smoke] [--keep] [--only E1,E2]" >&2; exit 2 ;;
  esac
  shift
done

# Even codex --version makes a folder in $CODEX_HOME/tmp/arg0, so it runs in a throwaway home, never in ~/.codex.
vhome=$(mktemp -d "${SPARE10_E2E_TMP:-/tmp}/s10ver-XXXXXX")
version=$(env HOME="$vhome" CODEX_HOME="$vhome" codex --version 2>/dev/null || true)
rm -rf "$vhome"
if [ "$version" != "codex-cli 0.157.0" ]; then
  echo "e2e: needs codex-cli 0.157.0, and codex --version says \"$version\"" >&2
  exit 2
fi
command -v python3 >/dev/null 2>&1 || { echo "e2e: needs python3" >&2; exit 2; }
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'; then
  echo "e2e: needs Node.js 22.18 or later. This is Node.js $(node --version)." >&2
  exit 2
fi
real_codex_home=$(cd "$HOME" 2>/dev/null && pwd -P)/.codex
if [ -n "${CODEX_HOME:-}" ]; then
  given=$(cd "$CODEX_HOME" 2>/dev/null && pwd -P || echo "$CODEX_HOME")
  case "$given" in
    "$real_codex_home" | "$real_codex_home"/* | "$HOME/.codex" | "$HOME/.codex"/*)
      echo "e2e: CODEX_HOME points at ~/.codex. Unset it: each run makes its own home." >&2
      exit 2 ;;
  esac
fi

work=$(mktemp -d "${SPARE10_E2E_TMP:-/tmp}/s10e2e-XXXXXX")
work=$(cd "$work" && pwd -P)
case "$work" in
  "$real_codex_home" | "$real_codex_home"/*) echo "e2e: the work folder $work is under ~/.codex" >&2; exit 2 ;;
esac

# Stops each process that has a path under the folder $1 in its command line, and waits up to 3 s for it to end.
# These are the brokers and the CLI launchers of one run: broker.sh starts a broker with the full path of its
# bundle. The path is plain text, not a pattern, so a broker of another folder never matches.
stop_under() {
  stop_pids=$(ps -A -ww -o pid= -o args= | STOP_UNDER="$1/" awk -v self="$$" '$1 != self && index($0, ENVIRON["STOP_UNDER"]) > 0 { print $1 }')
  [ -n "$stop_pids" ] || return 0
  kill $stop_pids 2>/dev/null || true
  stop_tries=0
  while [ "$stop_tries" -lt 30 ]; do
    stop_left=
    for p in $stop_pids; do
      if kill -0 "$p" 2>/dev/null; then stop_left="$stop_left $p"; fi
    done
    [ -n "$stop_left" ] || return 0
    stop_pids=$stop_left
    stop_tries=$((stop_tries + 1))
    sleep 0.1
  done
  kill -9 $stop_pids 2>/dev/null || true
}

mock=
cleanup() {
  status=$?
  [ -n "$mock" ] && kill "$mock" 2>/dev/null || true
  # A broker of a run that failed can outlive its host for a moment. It runs from the plugin cache under $work.
  # It must end before rm removes the folder, because its shutdown writes there.
  stop_under "$work"
  if [ -z "$keep" ] && [ "$status" -eq 0 ]; then
    rm -rf "$work"
  else
    echo "e2e: the work folder is $work"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

python3 codex/e2e/mock_responses.py "$work" > "$work/mock.out" 2>&1 &
mock=$!
tries=0
while [ ! -s "$work/port" ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 50 ] || ! kill -0 "$mock" 2>/dev/null; then
    echo "e2e: the mock did not start" >&2
    cat "$work/mock.out" >&2
    exit 1
  fi
  sleep 0.1
done

if [ -n "$only" ]; then
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./codex/test/host-loader.mjs \
    codex/e2e/scenarios.mjs --work "$work" --only "$only"
else
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./codex/test/host-loader.mjs \
    codex/e2e/scenarios.mjs --work "$work" $smoke
fi
