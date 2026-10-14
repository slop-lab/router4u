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

The volume stores `secrets.json`, gateway/backend configuration, OAuth credentials, and `data/` containing the SQLite ledger and payload records. Internal backend keys are implementation details, not user configuration. Never commit or share this volume. Named volumes avoid host UID/GID setup; bind mounts must be writable by the container user (UID/GID 1000 by default). Do not use an anonymous volume or delete the named volume when replacing the container.

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

Bundled mode currently starts one backend. Different project-to-account eligibility requires the separate partition topology below; do not combine differently authorized credential sets into one pool.

## Existing Compose installations

The remaining commands in this document apply to the separate-backend Compose topology, not bundled mode. Before recreating an existing installation, migrate its legacy environment file without changing keys:

```sh
node scripts/migrate-secrets.js
./router4u up -d --build
```

The migration writes private `secrets.json`, verifies the contents, and removes `.runtime/.env`. It refuses conflicting secrets. Do not mount an old Compose runtime into bundled mode: absolute storage/auth paths, backend hostnames, and persisted browser route overrides need an explicit migration, which is not automated.

## Compose first installation

From the repository root, prepare configuration and start the containers:

```sh
sh scripts/setup-docker.sh
./router4u up -d --build
```

No model, account, or provider credential is needed at installation time. The initializer creates a disabled `personal` Codex connection with `models: []`. Authentication and model selection happen in the browser. The script prepares files; `up -d --build` creates and starts containers.

The initializer refuses to overwrite an existing runtime. It downloads and verifies CLIProxyAPI 8.0.28 when necessary, generates private keys without printing them, and creates `.runtime/router4u.json`, `.runtime/cliproxyapi.yaml`, `.runtime/secrets.json`, and `.runtime/compose.env`. Keep `.runtime` and `.tools` out of source control. Do not run the initializer against an existing installation to reset credentials.

Both long-running services use `restart: unless-stopped`. Docker automatically restarts a crashed process and starts an enabled installation after daemon/host restart. An explicit `./router4u stop` leaves it stopped until `./router4u start` or `up -d`. The healthcheck reports liveness; an unhealthy status alone does not restart a running Docker container. `./router4u cli health` separately reports backend management and configured authentication status without making an inference request.

The wrapper is equivalent to `docker compose --env-file .runtime/compose.env`, adding the generated partition override when present. Commands such as `./router4u cli usage my-app` use `docker compose exec gateway node /app/src/cli.js ...`.

## Open the control room

Open `http://127.0.0.1:9470/` and sign in using `ROUTER4U_ADMIN_KEY` from the private `.runtime/secrets.json` file.

1. In **Connections → personal**, click **Connect Codex**, complete provider sign-in, and submit the callback URL if required. Check the returned status.
2. Open **Set up models** and click **Load available models**. Select permitted models and click **Use selected models**. Empty discovery means the account/provider setup still needs attention; it does not authorize a wildcard route.
3. Set **Request routing** to **On** and save. Model selection alone does not activate a connection. Discovery does not prove actual model entitlement.
4. Open **Projects & keys**, create a project, select the enabled connection, and issue a key. Use that key in the consuming application.

For API-key providers, configure the private backend provider first, then change **Backend connection settings → Authentication profile** to `api_key` and select the required protocols before enabling the route. Router4u does not ask for upstream API keys in the browser.

The [web UI](web-ui.md) is the primary interface for everyday administration. The CLI procedures below are optional alternatives for automation and maintenance. Run `./router4u` without arguments for Docker lifecycle help; it is not the account setup interface.

## Optional CLI: connect Codex

```sh
./router4u cli auth codex --route personal
```

Open the returned URL in your browser. If the browser cannot reach the backend's loopback callback, copy the complete callback URL and submit it through standard input:

```sh
./router4u exec -T gateway node /app/src/cli.js auth callback --route personal
```

Paste the callback URL, then send EOF. Do not save authorization codes in a committed file or paste them into a shared issue. Check the returned state:

```sh
./router4u cli auth status STATE --route personal
./router4u cli accounts --route personal
./router4u cli models --route personal
./router4u cli doctor --route personal
```

The backend owns OAuth state, PKCE, token exchange, credential persistence, and refresh. Router4u does not run another refresh loop.

## Authorize an application

Normally use **Projects & keys** in the browser after enabling a connection. For CLI automation, edit `.runtime/project.json`, then apply it and issue a key:

```sh
./router4u cli project put my-app --file /config/project.json
./router4u cli project key my-app
./router4u cli effective-policy my-app
```

Save the issued project key in the application's secret configuration. Default keys allow inference, usage/metadata reads, and cancellation but **not transcript export**. Issue an explicit export principal only when needed:

```sh
./router4u cli project key my-app --scopes usage:read,requests:read,exchange:export
```

Application containers join only the Compose `applications` network (normally `router4u_applications`) and use `http://gateway:9470/v1`. Give each project its own key. Do not join application containers to `infrastructure`, publish port 8317, or mount runtime/auth directories into them. The default host endpoint is `http://127.0.0.1:9470/v1`. Change `ROUTER4U_BIND` and `ROUTER4U_PORT` in `.runtime/compose.env` when necessary; protect nonlocal ingress with authenticated TLS at your chosen reverse proxy.

## Add another account or provider partition

A separate partition is the default when accounts have different project eligibility. It owns its own auth directory and refresh lifecycle:

```sh
sh scripts/add-partition.sh work
./router4u up -d --build
```

The helper creates `.runtime/partitions/work/`, generates separate backend/management keys, adds a disabled `work` route with no models, and writes `.runtime/partitions.compose.yaml`. It does not copy provider keys or credentials from the original partition. Recreate the gateway after changing its secrets file; existing ledger and project keys survive. Pause/drain before this planned restart if active streams must finish.

For API-key providers, use `sh scripts/add-partition.sh work --profile api_key`, edit the partition's backend configuration using the pinned CLIProxyAPI v8 schema, and restart that backend. Provider keys belong only in the private backend configuration.

If browser settings are active, the saved SQLite configuration still takes precedence over the file changed by the helper. Add the generated route through Connections using its generated environment-variable names, or first export your browser configuration into the installation file and then explicitly reload that file after the helper runs. Do not reload a stale file and discard unrelated browser edits.

In Connections, sign in for `work`, load and select its models, and enable it. Creating a partition does not select a model or authorize any project. The browser form uses `http://backend-work:8317/v1`, `ROUTER4U_WORK_BACKEND_KEY`, and `ROUTER4U_WORK_BACKEND_KEY_MANAGEMENT` for a generated `work` partition when a browser override requires adding the route manually.

Grant the new route only to intended projects by editing and applying their project policies. To record a stable exclusive account identity, add this entry to gateway `accounts` after learning the credential filename:

```json
{"id":"work-owner","route_id":"work","credential_name":"NAME.json","enabled":true,"concurrency":4}
```

Add `"account_id":"work-owner"`, `"exclusive_account":true`, and `"credential_name":"NAME.json"` to the `work` route. Reload, then run `./router4u cli account inspect work-owner`. Exclusive routes verify the pinned version, retry settings, absence of API-key groups, and exactly one enabled matching file-backed credential before admission. Credential filenames are backend references; account IDs remain stable. To change an account binding, create a new account ID.

Several credentials may share a backend only when every consuming route is permitted to use that entire account set. Such a pool has unknown actual account attribution; do not configure an exclusive account ID or claim per-account capacity enforcement for it. Account-specific eligibility requires separate partitions.

## Rebuild during development

Use `./router4u up -d --build` to rebuild and recreate containers. Do not rerun the initializer to change settings. Both setup scripts provide `--help` without starting Docker or provisioning files. There is no released-version upgrade or migration path during initial development.

## Reload and account lifecycle

Gateway configuration:

```sh
# Edit .runtime/router4u.json on the host.
./router4u cli reload --dry-run
./router4u cli reload
```

Reload is atomic and versioned. Active requests retain their admitted snapshots. Invalid changes leave the current configuration running. Listener, data directory, administrator-key variable, and maintenance interval changes require a restart. Secret-file changes require `up -d --force-recreate gateway`; reload cannot change an existing process's environment.

For backend configuration or credential-set changes, pause and drain first. CLIProxyAPI watches its configuration/auth directory, but a deliberate `./router4u restart backend-work` is the deterministic reload procedure. Do not mutate global account selection while requests are in flight.

Registered account operations are available without editing database rows:

```sh
./router4u cli pause
./router4u cli api /admin/active
./router4u cli occupancy
./router4u cli account disable work-owner
./router4u cli account enable work-owner
./router4u cli account refresh work-owner
./router4u cli account reconnect work-owner
./router4u cli account inspect work-owner
./router4u cli resume
```

Mutation commands require paused admissions, no active work, and no uncertain occupancy. `refresh` delegates to CLIProxyAPI; it can contact the provider. Reconnect returns the backend OAuth URL. `account remove ID` deliberately removes the referenced credential; update or disable its route/account configuration as well. Configuration is desired state; inspection reports backend drift instead of silently overwriting it.

## Back up and restore

Stop every backend refresh owner before a complete installation backup. With generated partitions, `stop` covers them too:

```sh
./router4u cli pause
./router4u cli api /admin/active
./router4u stop
./router4u run --rm --no-deps maintenance backup-installation --file /backups/checkpoint --config /config/router4u.json --backend-config /config/cliproxyapi.yaml --auth-dir /auth --env-file /config/secrets.json
```

The bundle contains the SQLite ledger/reservations/archive/audit/outbox, gateway and backend configuration, environment keys, auth directory, generated partitions, and Compose settings. Files have integrity hashes. The bundle contains live credentials and original payloads. Protect it like the running installation and enforce a separate backup retention policy.

Restore into a new staging directory, never over an existing WAL or auth directory:

```sh
./router4u run --rm --no-deps maintenance restore-installation --file /backups/checkpoint --destination /restores/recovered
```

The result is `.runtime/restores/recovered`. With all old services stopped, install its contents as a new runtime directory, review host UID/GID and volume paths, and start exactly one backend per auth directory. Restored gateway state remains paused when the backup was paused. Check usage, unknown reservations, and exchange integrity before resuming. An old rotating provider token may require reauthorization; inert backup tests cannot validate real refresh.

Backup/restore is tested against the current schema using inert credentials. Opening an incompatible database is rejected without converting it. There is no automatic schema migration or previous-release compatibility contract.

## Operational checks

```sh
./router4u cli metrics
./router4u cli alerts
./router4u cli health
./router4u cli account inspect work-owner
./router4u cli occupancy
./router4u cli export-usage my-app > usage.ndjson
./router4u cli retention
```

Use `exec -T gateway node /app/src/cli.js export-usage my-app` for redirected automation. Automatic retention runs in bounded batches at the configured maintenance interval. Expiry removes payloads while keeping accounting and explicit manifests. It does not erase old backups or shrink SQLite immediately.

After ambiguous dispatch, token reservations and uncertain occupancy remain. Verify the upstream process has stopped before `release-occupancy REQUEST_ID --reason EVIDENCE`. Resolve usage separately using `resolve` or `observe-usage`; releasing physical occupancy does not release token reservations. Alerts are pull-based JSON for an operator/monitoring job; no email or chat notification service is configured.

Use only your own eligible accounts and applications. Do not share or resell account access or bypass provider restrictions. You are responsible for provider terms and plan restrictions.

## Codex login fails with an unknown certificate authority

The backend image must include the system CA bundle. CLIProxyAPI uses Go's system trust store; Node's built-in roots do not supply trust roots to the backend executable. The backend Dockerfile installs `ca-certificates`, and deployment tests check the bundle in both default and additional account containers.

If an image built without the bundle reports `x509: certificate signed by unknown authority` during token exchange, rebuild and recreate the services:

```sh
./router4u up -d --build
```

Then start a new **Connect Codex** attempt. Do not reuse the previous authorization code. Rebuilding preserves the mounted configuration and auth directories. This certificate repair does not establish that account authorization or inference will succeed.

If the error persists on a network with TLS interception, the backend also needs the network's trusted CA installed in its system trust store. Do not disable TLS certificate verification.
