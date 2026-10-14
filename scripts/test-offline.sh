#!/bin/sh
set -eu
docker run --rm --network none --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=512m \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$(pwd),dst=/workspace,readonly" \
  --workdir /workspace \
  node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df \
  sh -c 'node --test test/*.test.js && node --test test/backend.integration.js && node --test test/clients.integration.js'
