# Web control room

Open `http://127.0.0.1:9470/` after starting Router4u. The web interface is included in the gateway image; no frontend build, CDN, or separate web server is needed.

Retrieve the administrator key with `docker exec router4u router4u admin-key show`. For the offline demo, use the operator key in `.runtime/demo.env`. Do not paste this key into project applications: issue a project key in the UI instead.

## Everyday workflow

1. Open **Connections**. A new installation contains a `personal` connection with request routing off and no selected models. Its card shows stored account status from CLIProxyAPI separately from request routing. `personal` is the connection name, not a separate login system. Inspect an existing backend, view credentials or models, or add/edit a route using the form. A route references a backend already installed and environment variables already set on the gateway; it does not create a backend container.
2. Choose **Connect Codex**, open the provider sign-in link, and complete login. If the browser's localhost callback cannot load, paste the full callback URL into the dialog and submit it. The dialog automatically checks CLIProxyAPI for completion or errors. Callback acceptance alone is not login completion. After successful sign-in, the account appears on the connection card and the dialog offers model setup. CLIProxyAPI owns the OAuth transaction and token refresh.
3. Open **Set up models → Load available models**, select the models you need, and click **Use selected models**. Set **Request routing** to **On** and save. The form also accepts explicit model IDs when appropriate; only disabled routes may have an empty allowlist. Discovery is not proof of live entitlement.
4. Open **Projects & keys**, create a project, select its allowed routes, and set limits. Issue a key and copy the one-time result into your application. The client base URL is the gateway's `/v1` address reachable from that application, which can differ from the browser's localhost address.
5. Use **Requests** to inspect project history, cancel work, or explicitly download an original exchange. Exports can contain sensitive prompts and responses.
6. Use **Overview** to pause admissions and **Activity** to inspect audit events or release uncertain occupancy after checking the upstream outcome. Account mutations require paused admissions, drained active work, and no uncertain occupancy.

Leave **Concurrent requests**, **Daily request limit**, or **Daily token estimate limit** blank for no project limit on that dimension. Blank values are saved as JSON `null` and displayed as **Unlimited**. Service, route, per-minute rate, and additional budget limits still apply; inspect **Effective policy** to see them. To remove the corresponding service-wide limits, set `concurrency`, `daily_requests`, and `daily_tokens` to `null` in Settings. Project `requests_per_minute` defaults to 60 and can be set to `null` in Advanced policy when no project request-rate cap is wanted.

Project forms expose common limits and preserve advanced policy fields in a JSON editor. Default issued keys do not include `exchange:export`. The existing admin API and CLI remain available for automation and recovery.

## Configuration and persistence

**Settings → Save & apply** validates the full configuration, checks the revision to prevent stale overwrites, and persists it transactionally in the existing SQLite data volume. Read-only Docker configuration mounts remain supported. Changes survive gateway recreation and are included in database backups.

Once saved in the browser, mutable configuration from SQLite takes precedence over the installation JSON. Host, port, data directory, transcript directory, operator-key environment name, and maintenance interval still come from the installation file at startup. Those fields cannot be changed by a browser save.

**Reload installation file** (or the existing CLI `reload`) explicitly replaces the browser override with the validated file configuration. A dry run does not change the active source. Download the active configuration before switching if you want to keep browser edits. Reload rejects removed routes still referenced by projects and account identity changes.

The UI never saves upstream tokens. Route key fields contain environment-variable names, not their secret values. Secret provisioning and backend container creation remain deployment/backend tasks.

## Authentication boundaries

The operator key is exchanged for an eight-hour, in-memory session using an HttpOnly, SameSite=Strict cookie. The browser does not store it in localStorage or sessionStorage. Every cookie-authenticated admin request also requires a CSRF header. Cross-origin requests are rejected. Logout and gateway restart invalidate sessions. Login is limited to 20 attempts per minute per gateway process; at most 100 live sessions are retained.

Use localhost or HTTPS for administration. HTTPS-origin login adds Secure to the session cookie; a TLS reverse proxy must preserve the original Host and Origin. No proxy-forwarded identity header is trusted. Static assets have a restrictive Content Security Policy and render data as text. Project bearer keys cannot authorize the control room.

## Current limits and release scope

Codex sign-in is delegated to CLIProxyAPI from the browser. Automated browser tests cover pending, failed, and completed sign-in using a fake backend; they do not verify real token exchange, inference, or refresh.

The current UI can log in to existing partitions and edit project route authorization, but it does not create backend containers or provide a complete account-add wizard. The bundled installation supports one backend credential set. Separate account eligibility requires custom backend provisioning and advanced configuration; no provisioning helper is included.

The default installation bundles the gateway and CLIProxyAPI in one container. Docker Hub publication and a `curl ... | sh` installer are deferred; no public image name or working installer URL is claimed. Use `--restart unless-stopped` for long-running containers.

Offline browser tests use inert keys and a fake provider. They do not verify live sign-in, real account eligibility, provider billing, or refresh behavior.

## Development verification

After `npm ci`, run `sh scripts/test-offline.sh` and `npm run test:browser`. The browser test prepares pinned images, then runs the UI and fake provider in a network-isolated container. To validate production packaging and crash recovery, build `router4u:local` and run `npm run test:container`.
