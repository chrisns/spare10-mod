#!/bin/sh
# Starts the spare10 broker with the first Node.js 20 or later that it finds.
# Codex starts it in the plugin root. The broker gets the full path of the bundle, so ps shows the install that it
# runs from. The cleanup of codex/e2e/run.sh uses this path.
# Codex runs this script outside its sandbox, and the agent can write some PATH folders, such as the .venv/bin of a
# project. So the script tries the fixed install places before PATH, and runs its tools only from /usr/bin and /bin.
# The version probe gets no stdin and no stdout, so a candidate cannot write into the MCP stream.
ok() { case $1 in /*) [ -x "$1" ] && "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' </dev/null >/dev/null 2>&1 ;; *) return 1 ;; esac; }
# The nvm versions, newest first. The sort reads only the three numbers of the version folder.
nvm_nodes() { PATH=/usr/bin:/bin; ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sed -n 's#^\(.*/v\([0-9][0-9]*\)\.\([0-9][0-9]*\)\.\([0-9][0-9]*\)/bin/node\)$#\2 \3 \4 \1#p' | sort -k1,1nr -k2,2nr -k3,3nr | cut -d' ' -f4-; }
# One candidate per line, so a folder name with a space stays one path. The Node.js on PATH comes last, and only
# with an absolute path. $(nvm_nodes) runs in a subshell, so its PATH stays there.
IFS='
'
for n in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node \
  "$HOME/.volta/bin/node" $(nvm_nodes) "$(command -v node 2>/dev/null)"; do
  if ok "$n"; then exec "$n" "$PWD/codex/dist/spare10.mjs"; fi
done
echo "spare10: no Node.js 20 or later found. Install Node.js, or switch off the spare10 plugin in ~/.codex/config.toml." >&2
exit 1
