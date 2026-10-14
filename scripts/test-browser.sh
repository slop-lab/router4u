#!/bin/sh
set -eu
# Image preparation may use the network; the browser and gateway run offline.
docker build -f deploy/browser-test.Dockerfile -t router4u-browser-test:local .
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=512m --shm-size=256m \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$(pwd),dst=/workspace,readonly" \
  router4u-browser-test:local
