#!/bin/sh
# run-hook: start the bundled CLI from the PATH Claude Code gives hooks.
# The /engram:* skills run through this script too, so slash commands work
# wherever the hooks do.
#
# Hooks run under `sh -c` with whatever PATH the Claude Code process had, which on
# macOS is often just /usr/bin:/bin:/usr/sbin:/sbin -- no nvm, no Homebrew, no bun.
# A bare `node` therefore fails with "node: command not found" and every hook goes
# silent. Resolve an interpreter here instead of hoping for PATH:
#   ENGRAM_NODE -> node on PATH -> newest nvm node -> Homebrew/system node -> bun
# bun runs the Node-targeted bundle unchanged, and is the fallback for machines
# where Node lives only behind the bun shim.
set -e

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cli="$here/../dist/cli.mjs"

node_bin=${ENGRAM_NODE:-}
if [ -z "$node_bin" ]; then
  node_bin=$(command -v node 2>/dev/null || true)
fi
if [ -z "$node_bin" ]; then
  node_bin=$(ls -dt "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | head -1 || true)
fi
if [ -z "$node_bin" ]; then
  for candidate in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.bun/bin/bun"; do
    if [ -x "$candidate" ]; then node_bin=$candidate; break; fi
  done
fi

if [ -z "$node_bin" ]; then
  echo "engram: no Node.js interpreter found. Install Node.js 18+ or set ENGRAM_NODE to its full path." >&2
  exit 127
fi

exec "$node_bin" "$cli" "$@"
