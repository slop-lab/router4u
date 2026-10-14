# Docker installation and account operations

Docker Engine with Compose v2 is sufficient. The bootstrap runs Node in a container; host Node and Go are not required. The reviewed backend binary is Linux amd64. Other architectures require a separately reviewed build and contract run.

## First installation

From the repository root, replace `MODEL` with a model available to your account:

```sh
sh scripts/setup-docker.sh MODEL codex
./router4u up -d --build
./router4u ps
./router4u cli health
```

The initializer refuses to overwrite an existing runtime. It downloads and verifies CLIProxyAPI 8.0.28 when necessary, generates private keys without printing them, and creates `.runtime/router4u.json`, `.runtime/cliproxyapi.yaml`, `.runtime/.env`, and `.runtime/compose.env`. Keep `.runtime` and `.tools` out of source control. Do not run the initializer against an existing installation to reset credentials.

Both long-running services use `restart: unless-stopped`. Docker automatically restarts a crashed process and starts an enabled installation after daemon/host restart. An explicit `./router4u stop` leaves it stopped until `./router4u start` or `up -d`. The healthcheck reports liveness; an unhealthy status alone does not restart a running Docker container. `./router4u cli health` separately reports backend management and configured authentication status without making an inference request.

The wrapper is equivalent to `docker compose --env-file .runtime/compose.env`, adding the generated partition override when present. Commands such as `./router4u cli usage my-app` use `docker compose exec gateway node /app/src/cli.js ...`.

## Open the control room

Open `http://127.0.0.1:9470/` and sign in using `ROUTER4U_ADMIN_KEY` from the private `.runtime/.env` file. The [web UI](web-ui.md) is the primary interface for everyday administration. The CLI procedures below remain available for automation and maintenance.

## Connect Codex

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

## Bind Sign in with ChatGPT

The pinned backend requires an existing Codex credential before SIWC binding. The stopped-backend procedure below is a Router4u integration precaution, not an inherent OAuth constraint; see [the authentication comparison](authentication-comparison.md). Identify its filename with `accounts`. Pause, drain active work, and stop the relevant backend before binding:

```sh
./router4u cli pause
./router4u cli api /admin/active
./router4u cli occupancy
./router4u stop backend
./router4u run --rm --no-deps backend -config /config/cliproxyapi.yaml -siwc-bind NAME.json -no-browser -local-model
./router4u up -d backend
```

Complete the backend's printed browser instructions. Set the corresponding route's `profile` to `chatgpt`, keep `protocols` as `["responses"]`, and reload Router4u. Use `stream:true`, `store:false`, and self-contained input arrays. Backend credential metadata does not expose the SIWC mode flag; inspect the local file's `use_siwc` boolean without displaying tokens when confirming a binding:

```sh
./router4u exec backend node -e 'const f=require("node:fs"); const c=JSON.parse(f.readFileSync("/auth/NAME.json","utf8")); console.log({type:c.type,use_siwc:c.use_siwc===true,has_siwc_access:!!c.siwc?.access_token,has_siwc_refresh:!!c.siwc?.refresh_token})'
./router4u cli reload
./router4u cli resume
```

These commands establish a local configuration, not proof of live entitlement or working provider inference. Follow the live validation checklist in `validation.md`.

## Authorize an application

Edit `.runtime/project.json`, then apply it and issue a key:

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
sh scripts/add-partition.sh work MODEL codex
./router4u up -d --build
./router4u cli auth codex --route work
./router4u cli accounts --route work
```

The helper creates `.runtime/partitions/work/`, generates separate backend/management keys, adds a `work` route, and writes `.runtime/partitions.compose.yaml`. It does not copy provider keys or credentials from the original partition. Compose recreates the gateway when its environment changes; existing ledger and project keys survive. Pause/drain before this planned restart if active streams must finish.

For API-key providers, choose `api_key`, edit the partition's backend configuration using the pinned CLIProxyAPI v8 schema, and restart that backend. Provider keys belong only in the private backend configuration. For a ChatGPT binding in this partition, use `backend-work` in the SIWC commands above.

Grant the new route only to intended projects by editing and applying their project policies. To record a stable exclusive account identity, add this entry to gateway `accounts` after learning the credential filename:

```json
{"id":"work-owner","route_id":"work","credential_name":"NAME.json","enabled":true,"concurrency":4}
```

Add `"account_id":"work-owner"`, `"exclusive_account":true`, and `"credential_name":"NAME.json"` to the `work` route. Reload, then run `./router4u cli account inspect work-owner`. Exclusive routes verify the pinned version, retry settings, absence of API-key groups, and exactly one enabled matching file-backed credential before admission. Credential filenames are backend references; account IDs remain stable. To change an account binding, create a new account ID.

Several credentials may share a backend only when every consuming route is permitted to use that entire account set. Such a pool has unknown actual account attribution; do not configure an exclusive account ID or claim per-account capacity enforcement for it. Account-specific eligibility requires separate partitions.

## Reload and account lifecycle

Gateway configuration:

```sh
# Edit .runtime/router4u.json on the host.
./router4u cli reload --dry-run
./router4u cli reload
```

Reload is atomic and versioned. Active requests retain their admitted snapshots. Invalid changes leave the current configuration running. Listener, data directory, administrator-key variable, and maintenance interval changes require a restart. Environment-secret changes require `up -d --force-recreate gateway`; reload cannot change an existing process's environment.

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

## Back up, restore, and upgrade

Stop every backend refresh owner before a complete installation backup. With generated partitions, `stop` covers them too:

```sh
./router4u cli pause
./router4u cli api /admin/active
./router4u stop
./router4u run --rm --no-deps maintenance backup-installation --file /backups/before-upgrade --config /config/router4u.json --backend-config /config/cliproxyapi.yaml --auth-dir /auth --env-file /config/.env
```

The bundle contains the SQLite ledger/reservations/archive/audit/outbox, gateway and backend configuration, environment keys, auth directory, generated partitions, and Compose settings. Files have integrity hashes. The bundle contains live credentials and original payloads. Protect it like the running installation and enforce a separate backup retention policy.

Restore into a new staging directory, never over an existing WAL or auth directory:

```sh
./router4u run --rm --no-deps maintenance restore-installation --file /backups/before-upgrade --destination /restores/recovered
```

The result is `.runtime/restores/recovered`. With all old services stopped, install its contents as a new runtime directory, review host UID/GID and volume paths, and start exactly one backend per auth directory. Restored gateway state remains paused when the backup was paused. Check usage, unknown reservations, and exchange integrity before resuming. An old rotating provider token may require reauthorization; inert backup tests cannot validate real refresh.

Before upgrading from schema v1, take a stopped-service backup with the old version, including credentials and configuration. Version 2 migrates the ledger automatically and removes implicit export authority from legacy principals. Issue explicit export principals as needed. Older code must not open a migrated database. Roll back using the **matching pre-upgrade state backup and old image**, with all newer processes stopped; do not merely swap the binary against a newer schema. Retain the old image ID/digest and dependency lock before rebuilding.

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
