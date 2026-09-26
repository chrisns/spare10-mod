#!/bin/sh
# Starts the spare10 broker with the first Node.js 20 or later that it finds.
ok() { [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null; }
# The nvm versions, newest first. The sort reads only the three numbers of the version folder.
nvm_nodes() { ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sed -n 's#^\(.*/v\([0-9][0-9]*\)\.\([0-9][0-9]*\)\.\([0-9][0-9]*\)/bin/node\)$#\2 \3 \4 \1#p' | sort -k1,1nr -k2,2nr -k3,3nr | cut -d' ' -f4-; }
# One candidate per line, so a folder name with a space stays one path.
IFS='
'
for n in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node \
  "$HOME/.volta/bin/node" $(nvm_nodes); do
  if ok "$n"; then exec "$n" ./codex/dist/spare10.mjs; fi
done
echo "spare10: no Node.js 20 or later found. Install Node.js, or switch off the spare10 plugin in ~/.codex/config.toml." >&2
exit 1
