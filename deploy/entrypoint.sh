#!/bin/sh
set -eu
if [ "${1:-}" = start ] || { [ "${1:-}" = admin-key ] && [ "${2:-}" = rotate ]; }; then
  state="${ROUTER4U_STATE_DIR:-/var/lib/router4u}"
  mkdir -p "$state"
  exec flock --no-fork --nonblock "$state/installation.lock" node /app/src/container.js "$@"
fi
exec node /app/src/container.js "$@"
