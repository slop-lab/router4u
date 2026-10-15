# Docker installation and account operations

## Single-container installation (recommended)

Docker Engine is sufficient; host Node, Go, Compose, and a host `.env` file are not required. The image includes checksum-pinned CLIProxyAPI 8.0.28 and system CA certificates. Only Linux amd64 is reviewed; other architectures require a separately reviewed build and contract run.

```sh
docker build -t router4u:local .
docker run -d --name router4u --restart unless-stopped \
  -p 127.0.0.1:9470:9470 \
  -v router4u-data:/var/lib/router4u router4u:local
docker exec router4u router4u admin-key show
```

First start generates private keys and a disabled `personal` connection. Sign in at `http://127.0.0.1:9470/` using the explicitly retrieved administrator key, connect the account, select models, and enable routing. Keys are never printed in ordinary startup logs. An optional `ROUTER4U_ADMIN_KEY` environment value is accepted on first initialization and persisted; a conflicting value on later startup is rejected.

The volume stores `secrets.json`, gateway/backend configuration, OAuth credentials, and `data/` containing the SQLite operational state and JSONL logs. Internal backend keys are implementation details, not user configuration. Never commit or share this volume. Named volumes avoid host UID/GID setup; bind mounts must be writable by the container user (UID/GID 1000 by default). Do not use an anonymous volume or delete the named volume when replacing the container.

Gateway listens on `0.0.0.0:9470` inside the container. Set the **host** bind with Docker `-p`, not a container environment variable:

- `-p 127.0.0.1:9470:9470`: local host access only.
- `-p 192.168.1.10:9470:9470`: one host interface.
- `-p 0.0.0.0:8080:9470`: all host IPv4 interfaces, port 8080; use protected HTTPS ingress.

CLIProxyAPI listens on `127.0.0.1:8317` with remote management disabled. Do not publish its port. Application containers may share a Docker network with Router4u and use `http://router4u:9470/v1`, with their own project keys and no mounts of service state.

A supervisor starts Gateway after backend readiness. Either process failing ends the container; `--restart unless-stopped` handles recovery. `docker stop` allows 25 seconds for gateway shutdown before forced cleanup; use `docker stop -t 30 router4u`. Healthchecks probe local Gateway and backend management without provider inference. An unhealthy status alone does not trigger Docker restart.

```sh
docker exec router4u router4u health
docker exec router4u router4u pause
docker exec router4u router4u reload --config /var/lib/router4u/router4u.json --dry-run
```

To rotate the administrator key, first stop the installation; rotation refuses to run while its state lock is held. The command does not print the new key. If the container was created with an explicit `ROUTER4U_ADMIN_KEY`, recreate it without that override after rotation; the old value will be rejected:

```sh
docker stop -t 30 router4u
docker run --rm -v router4u-data:/var/lib/router4u router4u:local admin-key rotate
docker start router4u
docker exec router4u router4u admin-key show
```

For a complete cold backup, pause admissions, inspect active requests, stop the container, then copy the **entire** volume using a temporary container. Keep both processes stopped for the whole copy. The backup includes live credentials and original payloads. Restore into a new volume; start only one installation using those credentials. Do not blindly replay uncertain requests. CLIProxyAPI remains the only OAuth and refresh owner.

Bundled mode currently starts one backend. Different project-to-account eligibility requires the [separate Compose partition topology](compose.md); do not combine differently authorized credential sets into one pool.

## Rebuild and restart

Rebuild the image, stop and replace the container, and reuse its named volume:

```sh
docker build -t router4u:local .
docker stop -t 30 router4u
docker rm router4u
docker run -d --name router4u --restart unless-stopped \
  -p 127.0.0.1:9470:9470 \
  -v router4u-data:/var/lib/router4u router4u:local
```

Preserve any custom network or host-port options when recreating it. Browser sessions expire on gateway restart; retrieve the administrator key with `docker exec router4u router4u admin-key show` and sign in again. A fresh volume creates new keys and requires account setup and new application keys. Reusing the current volume retains configuration, accounts, and project keys. Incompatible database schemas are rejected; no automatic schema conversion is provided.

## Browser setup and application access

1. Open **Connections → personal → Connect Codex**. Complete sign-in and submit the loopback callback URL if necessary. The dialog checks CLIProxyAPI for completion; callback acceptance alone is not success.
2. Choose **Set up models → Load available models**, select the allowed models, and choose **Use selected models**.
3. Set **Request routing** to **On** and save. Account connection and request routing are separate states.
4. Create a project in **Projects & keys**, authorize `personal`, and issue its application key. Blank concurrency and daily limits mean no project limit on that dimension; other limits still apply.
5. Configure the application with `http://127.0.0.1:9470/v1` and the project key. See [client integrations](clients.md), including the pi CLI.

For API-key providers, edit the private CLIProxyAPI configuration in the volume and restart the installation. Select `api_key` in the route's backend settings. Provider keys remain in CLIProxyAPI; do not put them in the browser configuration editor.

## Backup and recovery

Back up the complete stopped volume, including `secrets.json`, both configuration files, `auth/`, and `data/`. Restore to a fresh volume with the same ownership and start exactly one installation. The [operations guide](operations.md) explains uncertain requests and audited corrections. A SQLite-only copy omits JSONL logs, upstream credentials, and the administrator key. See [JSONL storage and conversion](logs.md).

## Multiple account partitions

For separate account eligibility, use the [Compose partition guide](compose.md#add-another-account-or-provider-partition). The bundled supervisor starts one backend and does not create more backend containers from the UI.

## Certificate errors during sign-in

The image installs system CA certificates for CLIProxyAPI's Go TLS client. If an older local image lacks them, rebuild and replace the container, then start a new Codex sign-in attempt. Do not reuse an old authorization code. On a TLS-intercepting network, install the network's trusted CA in the backend's system trust store; do not disable verification.

Docker Hub publication and a `curl ... | sh` installer remain deferred. `router4u:local` refers to the image built from this checkout.
