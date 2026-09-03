#!/bin/sh

set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: run-node.sh <script> [args...]" >&2
  exit 64
fi

if [ -n "${GIT_KB_NODE_BIN:-}" ] && [ -x "${GIT_KB_NODE_BIN}" ]; then
  NODE_BIN="${GIT_KB_NODE_BIN}"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  NODE_BIN=""
  for candidate in \
    "$HOME/.local/share/mise/shims/node" \
    "$HOME/.local/share/mise/installs/node"/*/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.nvm/versions/node"/*/bin/node \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node
  do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "${NODE_BIN}" ]; then
  echo "ERROR: node not found. Install Node.js or set GIT_KB_NODE_BIN." >&2
  exit 127
fi

exec "$NODE_BIN" "$@"
