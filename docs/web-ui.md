# Web control room

Open `http://127.0.0.1:9470/` after starting Router4u. The web interface is included in the gateway image; no frontend build, CDN, or separate web server is needed.

Sign in with `ROUTER4U_ADMIN_KEY` from your installation's private environment file. For the offline demo, use the operator key in `.runtime/demo.env`. Do not paste this key into project applications: issue a project key in the UI instead.

## Everyday workflow

1. Open **Connections**. Inspect an existing backend, view credentials or models, or add/edit a route using the form. A route references a backend already installed and environment variables already set on the gateway; it does not create a backend container.
2. Choose **Connect Codex**, open the provider sign-in link, and complete login. If the browser's localhost callback cannot load, paste the full callback URL into the dialog and submit it. Check status before closing the dialog. CLIProxyAPI owns the OAuth transaction and token refresh.
3. Open **Projects & keys**, create a project, select its allowed routes, and set limits. Issue a key and copy the one-time result into your application. The client base URL is the gateway's `/v1` address reachable from that application, which can differ from the browser's localhost address.
4. Use **Requests** to inspect project history, cancel work, or explicitly download an original exchange. Exports can contain sensitive prompts and responses.
5. Use **Overview** to pause admissions and **Activity** to inspect audit events or release uncertain occupancy after checking the upstream outcome. Account mutations require paused admissions, drained active work, and no uncertain occupancy.

Project forms expose common limits and preserve advanced policy fields in a JSON editor. Default issued keys do not include `exchange:export`. The existing admin API and CLI remain available for automation and recovery.

## Configuration and persistence

**Settings → Save & apply** validates the full configuration, checks the revision to prevent stale overwrites, and persists it transactionally in the existing SQLite data volume. Read-only Docker configuration mounts remain supported. Changes survive gateway recreation and are included in database backups.

Once saved in the browser, mutable configuration from SQLite takes precedence over the installation JSON. Host, port, data directory, operator-key environment name, and maintenance interval still come from the installation file at startup. Those fields cannot be changed by a browser save.

**Reload installation file** (or the existing CLI `reload`) explicitly replaces the browser override with the validated file configuration. A dry run does not change the active source. Download the active configuration before switching if you want to keep browser edits. Reload rejects removed routes still referenced by projects and account identity changes.

The UI never saves upstream tokens. Route key fields contain environment-variable names, not their secret values. Secret provisioning and backend container creation remain deployment/backend tasks.

## Authentication boundaries

The operator key is exchanged for an eight-hour, in-memory session using an HttpOnly, SameSite=Strict cookie. The browser does not store it in localStorage or sessionStorage. Every cookie-authenticated admin request also requires a CSRF header. Cross-origin requests are rejected. Logout and gateway restart invalidate sessions. Login is limited to 20 attempts per minute per gateway process; at most 100 live sessions are retained.

Use localhost or HTTPS for administration. HTTPS-origin login adds Secure to the session cookie; a TLS reverse proxy must preserve the original Host and Origin. No proxy-forwarded identity header is trusted. Static assets have a restrictive Content Security Policy and render data as text. Project bearer keys cannot authorize the control room.

## Current limits and release scope

Codex sign-in is available in the browser. The separate SIWC binding has been removed; see [migration guidance](authentication.md#migration-from-the-retired-siwc-profile).

Multiple accounts are a design requirement. The current UI can log in to existing partitions and edit project route authorization, but it does not create backend containers or provide a complete account-add wizard. Prepare isolated accounts with [the partition workflow](docker.md#add-another-account-or-provider-partition); register exclusive account metadata in Settings when exact account eligibility is needed.

The existing repository Compose deployment remains the installation mechanism for this change. Docker Hub publication and a `curl ... | sh` installer are deferred; no public image name or working installer URL is claimed. Both long-running Compose services retain `restart: unless-stopped`.

Offline browser tests use inert keys and a fake provider. They do not verify live sign-in, real account eligibility, provider billing, or refresh behavior.

## Development verification

After `npm ci`, run `sh scripts/test-offline.sh` and `npm run test:browser`. The browser test prepares pinned images, then runs the UI and fake provider in a network-isolated container. To validate production packaging and crash recovery, build `router4u:local` and the pinned backend image, then run `npm run test:deployment`.
