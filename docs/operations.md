# Deployment and operations

For the ready-to-run Compose installation, account partition helper, and exact Docker commands, see [Docker operations](docker.md).

## Supported installation

Run one Node.js 24 gateway and one or more dedicated CLIProxyAPI v8.0.28 partitions on a trusted single-user host. SQLite state belongs to the shared installation, outside project container lifecycles. Do not place the database on NFS or share it among gateway replicas. The service lock prevents normal accidental startup of a second CLI process against the same state directory.

Runtime dependencies are Node built-ins. The optional development dependencies are only for real SDK compatibility tests. The no-plugin backend binary is a pinned, checksummed download. Native untrusted plugins are not part of the deployment.

Use `node src/cli.js doctor --route personal` to inspect the backend version, global retry configuration, and credential counts without printing token material. Ordinary health probes never contact a billable model. `/healthz` checks process liveness; `/readyz` checks local store access and the admission pause flag. Neither proves an account is authorized or a provider is reachable.

## Network and credential boundary

Default listeners bind to loopback. For separate project containers, provide a reachable gateway address using your runtime's private networking and explicit discovery configuration. Give each application a separate project key. Do not mount `.runtime`, the backend auth directory, or management credentials into project containers.

Only the gateway should reach backend inference and management. If using containers, give the gateway both an application network and an infrastructure network; attach CLIProxyAPI only to the infrastructure network. Do not publish its management port. Bind gateway ingress to the intended network and set `allow_private_http:true` only for an explicitly trusted private backend connection. Use authenticated TLS for traffic crossing an untrusted network. A host administrator remains outside this isolation guarantee.

`Dockerfile` packages the gateway without dev dependencies:

```sh
docker build -t router4u:local .
```

Mount a protected configuration file at `/config/router4u.json`, durable writable storage at the configured `data_dir`, and provide operator/backend environment secrets. The container runs as the `node` user. Prepare ownership of the state mount for its UID. Update `host`, `data_dir`, and backend address for your container network; a host-loopback backend URL does not reach a different container.

## Route and account isolation

Each route has an explicit model/protocol allowlist, profile, backend base URL, and names of environment variables holding backend keys. Route/account definitions can be validated and atomically reloaded from the configuration file; revisions are durable. Project policy changes are versioned through the admin API. Existing requests retain their policy/route snapshots.

Use a separate backend/auth directory for each different allowed account set. Never toggle global backend account enablement around concurrent requests. Do not use aliases as an authorization boundary or configure model pools that silently change the selected upstream model. Keep paid-provider fallback absent unless explicitly implemented and authorized in a future route contract.

By default, actual upstream account identity is **unknown**: the gateway sees the backend response, not its internal scheduler. To attribute a route to one exclusive file-backed account, configure `account_id`, `exclusive_account:true`, `credential_name`, and `management_key_env`. Before every admission on that route, Router4u verifies the pinned backend version, global retry settings, absence of API-key groups, and exactly one active credential matching `credential_name`. Failure rejects the request. The internal `account_id` is your stable registry identity; the backend filename is a separate reference.

This verifies a dedicated-partition configuration, not an internal per-attempt scheduler hook. Management access is trusted: changing backend credentials during an active dispatch invalidates that operating guarantee. Pause admissions and drain work before account-set changes. Do not run another refresh process against copied rotating credentials.

## Limits and uncertainty

The initial defaults bound request bodies to 2 MiB, response bodies to 16 MiB, an individual SSE event to 1 MiB, active gateway requests to 32, and logical archive payloads to 1 GiB. Requests are rejected rather than placed in an implicit scheduling queue. Streaming uses awaited writes and never buffers the full response to produce a transcript. Required SQLite commits can add latency per chunk; benchmark your local disk before raising concurrency.

SQLite payloads are in a separate table from metadata. Full exports necessarily materialize the selected bounded exchange; at most two exports may be in flight. Local synchronous database work and exports share the process; this installation is intended for modest personal workloads. The operator metrics endpoint reports gateway lifetime, backend time to first byte, and capture time separately. These are request-boundary measurements, not provider-internal execution measurements. Increase scale only after measuring storage and stream behavior.

The archive limit measures retained payload bytes, not database/WAL/index overhead or available disk capacity. Monitor actual disk space too. Logical deletion does not immediately shrink SQLite files. After stopping the service and taking a backup, an operator may checkpoint/vacuum SQLite using standard tools. Physical secure erasure, encrypted backups, and host key recovery are deployment responsibilities. Router4u does not claim encryption at rest.

## Recovery and resolution

On restart, undispatched reservations are settled as zero with `source:not_dispatched`. Durable dispatch intents without completion become `outcome_unknown`, retain token reservations, and are never replayed. Client disconnect, requested cancellation, delivered output, accounting state, and recording state stay independent.

```sh
node src/cli.js requests my-app
node src/cli.js request REQUEST_ID
node src/cli.js exchange REQUEST_ID
node src/cli.js resolve REQUEST_ID --tokens 123 --reason 'Verified using the provider record'
```

Resolve only when you have a basis for the adjustment. The service records the reason and actor in the audit/ledger; it never deletes an unknown charge to make totals look exact. Missing usage remains reserved even if a request's local deadline elapsed. Backend internal attempts may consume additional tokens not visible in a final response; a settled request observation does not establish complete upstream consumption.

Revoking a principal or disabling a project affects new work. To stop existing work, inspect `/admin/active` and explicitly cancel selected requests. Cancellation asks the backend to stop and does not prove it stopped upstream consumption.

## Backups and restore

1. Pause new admissions and drain/cancel active requests. Stop Router4u and the relevant backend before making an installation backup.
2. Run `node src/cli.js backup --file /protected/path/new-backup`. This requires a stopped gateway and creates a consistent SQLite snapshot containing ledger, reservations, manifests, payloads, audit, and outbox, plus gateway configuration.
3. Separately copy `.runtime/.env`, the backend configuration, and its entire auth directory into the protected backup. The gateway backup command deliberately does not infer custom backend credential paths. Keep exactly one live refresh owner. Treat all backup files as secrets.
4. To restore, stop all old processes. Restore the SQLite snapshot into the configured state directory as `router4u.sqlite`, restore gateway/backend configuration and credentials, and preserve file ownership/permissions. Use an empty state directory; never mix an old WAL/SHM file with a restored database. Restore any externally managed encryption keys before starting.
5. Start one backend and one gateway. Startup reconciliation retains ambiguous work and never replays it. Check usage and representative authorized exchange exports. Run a deliberate live smoke request only after inspecting the recovered state.

The gateway backup test restores payloads and unresolved reservations and verifies integrity. `backup-installation` additionally bundles credentials, backend configuration, environment keys, and generated extra partitions; `restore-installation` verifies all file hashes and stages an entirely new runtime. The Docker lifecycle suite exercises this complete path using inert credentials. Live provider refresh after credential restoration requires an operator validation; restoring an old rotating refresh token can require reauthorization.

## Retention and upgrade

Retention supports per-project `retention_days`, booked at admission. A bounded maintenance sweep expires completed payloads automatically; `retention` triggers a sweep manually. Existing request retention snapshots do not change when policy is edited. `node src/cli.js delete-exchange REQUEST_ID` deletes a completed exchange's payloads while preserving accounting and a deletion manifest. No automatic eviction occurs when the archive fills. Required capture rejects/stops work; best-effort capture reports gaps. Backups retain deleted content until their own expiry policy removes it.

Before changing CLIProxyAPI, back up state, inspect the new source/release, update the pinned version and checksum intentionally, and run `npm test`, `npm run test:backend`, and `npm run test:clients`. Test the original and upgraded configuration before rolling back. Router4u rejects database schema versions newer than it understands; it does not silently downgrade the database.

All committed documentation is English. `.local` is private reference material excluded from Git and the Docker context. Runtime tokens, project keys, backend binaries, and SQLite files are also excluded.


## Operational administration

`reload --dry-run` validates the edited gateway file; `reload` commits a new revision. Invalid changes leave the current service configuration intact. The data directory/listener/admin-key-variable/maintenance interval require a process restart. Replacing environment secrets requires recreating the container. Existing streams retain their policy and route snapshot.

`effective-policy PROJECT` explains applicable project, service, and route limits and capability exclusions. `metrics`, `alerts`, and `health` are authenticated operator reads. Account inspection stores sanitized observations with freshness and drift; passive provider quota headers are separate from local token budgets. No health probe performs inference. Pull alerts into your monitoring system; Router4u does not send external notifications.

`export-usage PROJECT` walks cursor-paginated request metadata and emits NDJSON. Original payload export separately requires `exchange:export`. A default principal or a usage-only principal cannot retrieve original transcripts.

Unknown physical occupancy survives cancellation/crash independently from token reservations. Configured route/account concurrency counts uncertain occupancy until `release-occupancy ID --reason EVIDENCE`. This is an operator assertion, not proof synthesized from a timeout. `observe-usage ID --file FILE` accepts a stable source/event ID and a verified request total, corrects the ledger by the delta, and deduplicates retries. Conflicting repeats are rejected. It is not a backend attempt journal and does not imply hidden attempt visibility.
