#!/bin/sh
set -eu
# The kernel releases this lock after crashes, including PID namespace replacement.
exec flock --nonblock /state/installation.lock node /app/src/cli.js "$@"
