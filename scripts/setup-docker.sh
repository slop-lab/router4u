#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .runtime .tools
chmod 700 .runtime .tools
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$(pwd),dst=/workspace" --workdir /workspace \
  node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df \
  node scripts/setup-docker.js "$@"
