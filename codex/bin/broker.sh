#!/bin/sh
# Starts the spare10 broker with the first Node.js 20 or later that it finds.
# Codex starts it in the plugin root. The broker gets the full path of the bundle, so ps shows the install that it
# runs from. The cleanup of codex/e2e/run.sh uses this path.
# Codex runs this script outside its sandbox, and the agent can write some PATH folders, such as the .venv/bin of a
# project. So the script tries the fixed install places before PATH, and runs its tools only from /usr/bin and /bin.
# The version probe gets no stdin and no stdout, so a candidate cannot write into the MCP stream.
ok() { case $1 in /*) [ -x "$1" ] && "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' </dev/null >/dev/null 2>&1 ;; *) return 1 ;; esac; }
# The versions of nvm, mise, asdf and fnm, newest first. The sort reads only the three numbers of the version folder.
version_nodes() { PATH=/usr/bin:/bin; ls -d "$HOME"/.nvm/versions/node/v*/bin/node "$HOME"/.local/share/mise/installs/node/*/bin/node "$HOME"/.asdf/installs/nodejs/*/bin/node "$HOME"/.local/share/fnm/node-versions/v*/installation/bin/node "$HOME/Library/Application Support/fnm"/node-versions/v*/installation/bin/node "$HOME"/.fnm/node-versions/v*/installation/bin/node 2>/dev/null | sed -n 's#^\(.*/v\{0,1\}\([0-9][0-9]*\)\.\([0-9][0-9]*\)\.\([0-9][0-9]*\)\(/installation\)\{0,1\}/bin/node\)$#\2 \3 \4 \1#p' | sort -k1,1nr -k2,2nr -k3,3nr | cut -d' ' -f4-; }
# The Node.js on PATH, from the absolute PATH folders only. bash makes a node in a relative folder absolute, and an
# empty PATH means the current folder.
path_node() { set -f; IFS=:; p=; for d in $PATH; do case $d in /*) p=$p${p:+:}$d ;; esac; done; [ -n "$p" ] && PATH=$p && command -v node; }
# Runs the broker with the candidate $2 when it is Node.js 20 or later. SPARE10_NODE_FROM ($1) and SPARE10_NODE
# tell the broker where its Node.js came from, so it can warn when the agent can write such a folder (CX58).
start() { if ok "$2"; then export SPARE10_NODE_FROM="$1" SPARE10_NODE="$2"; exec "$2" "$PWD/codex/dist/spare10.mjs"; fi; }
# One candidate per line, so a folder name with a space stays one path. The Node.js on PATH comes last.
# $(version_nodes) and $(path_node) run in a subshell, so their PATH, IFS and set -f stay there.
IFS='
'
for n in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do start fixed "$n"; done
for n in "$HOME/.volta/bin/node" $(version_nodes); do start home "$n"; done
start path "$(path_node 2>/dev/null)"
echo "spare10: no Node.js 20 or later found. Install Node.js, or switch off the spare10 plugin in ~/.codex/config.toml." >&2
exit 1
