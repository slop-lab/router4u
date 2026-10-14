# Deployment and operations

Start with the [single-container Docker guide](docker.md). Use [Compose partitions](compose.md) when projects need different backend credential sets.

## Supported installation

Run one Node.js 24 gateway and one or more dedicated CLIProxyAPI v8.0.28 partitions on a trusted single-user host. SQLite state belongs to the shared installation, outside project container lifecycles. Do not place the database on NFS or share it among gateway replicas. The service lock prevents normal accidental startup of a second CLI process against the same state directory.

Runtime dependencies are Node built-ins. The optional development dependencies are only for real SDK compatibility tests. The no-plugin backend binary is a pinned, checksummed download. Native untrusted plugins are not part of the deployment.

Use `docker exec router4u router4u doctor --route personal` to inspect the backend version, global retry configuration, and credential counts without printing token material. Ordinary health probes never contact a billable model. `/healthz` checks process liveness; `/readyz` checks local store access and the admission pause flag. Neither proves an account is authorized or a provider is reachable.

## Network and credential boundary

The bundled backend binds to container loopback. The gateway listens on port 9470 inside the container; the documented Docker port mapping restricts host access to loopback. For separate project containers, provide a reachable gateway address using your runtime's private networking and explicit discovery configuration. Give each application a separate project key. Do not mount `.runtime`, the backend auth directory, or management credentials into project containers.

Only the gateway should reach backend inference and management. In the separate Compose topology, give the gateway both an application network and an infrastructure network; attach CLIProxyAPI only to the infrastructure network. Do not publish its management port. Bind gateway ingress to the intended network and set `allow_private_http:true` only for an explicitly trusted private backend connection. Use authenticated TLS for traffic crossing an untrusted network. A host administrator remains outside this isolation guarantee.

The image contains the gateway, pinned backend, CA certificates, and process supervisor without development dependencies. Its named volume at `/var/lib/router4u` holds private keys, configuration, OAuth credentials, and SQLite data. Bind mounts must be writable by the container user (UID/GID 1000 by default). In Compose, configuration is mounted at `/config` and gateway data at `/state`; do not mix these layouts.

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
docker exec router4u router4u requests my-app
docker exec router4u router4u request REQUEST_ID
docker exec router4u router4u exchange REQUEST_ID
docker exec router4u router4u resolve REQUEST_ID --tokens 123 --reason 'Verified using the provider record'
```

Resolve only when you have a basis for the adjustment. The service records the reason and actor in the audit/ledger; it never deletes an unknown charge to make totals look exact. Missing usage remains reserved even if a request's local deadline elapsed. Backend internal attempts may consume additional tokens not visible in a final response; a settled request observation does not establish complete upstream consumption.

Revoking a principal or disabling a project affects new work. To stop existing work, inspect `/admin/active` and explicitly cancel selected requests. Cancellation asks the backend to stop and does not prove it stopped upstream consumption.

## Backups and restore

For bundled mode, pause admissions, inspect active work, stop the container, and copy the entire named volume. Restore into a fresh volume with the same ownership. This preserves `secrets.json`, gateway/backend configuration, OAuth files, and SQLite data together. Do not copy a live SQLite database without a supported snapshot operation or mix restored files with an old WAL. Keep exactly one active refresh owner.

The separate Compose topology has explicit `backup-installation` and `restore-installation` commands with integrity checks; see [the Compose backup procedure](compose.md#back-up-and-restore). The database-only `backup` command does not include backend credentials. Synthetic backup tests cannot prove that restored rotating provider tokens will remain accepted.

After recovery, inspect usage, unknown reservations, and authorized exchange records before resuming admissions. Never replay ambiguous work automatically.

## Retention and upgrade

Retention supports per-project `retention_days`, booked at admission. A bounded maintenance sweep expires completed payloads automatically; `retention` triggers a sweep manually. Existing request retention snapshots do not change when policy is edited. `docker exec router4u router4u delete-exchange REQUEST_ID` deletes a completed exchange's payloads while preserving accounting and a deletion manifest. No automatic eviction occurs when the archive fills. Required capture rejects/stops work; best-effort capture reports gaps. Backups retain deleted content until their own expiry policy removes it.

Before changing CLIProxyAPI, back up state, inspect the new source/release, update the pinned version and checksum intentionally, and run `npm test`, `npm run test:backend`, and `npm run test:clients`. Test the original and upgraded configuration before rolling back. Router4u rejects incompatible database schema versions without converting them.

Runtime tokens, project keys, SQLite files, and downloaded backend artifacts must remain outside source control. Keep application `.env` files private as well.


## Operational administration

`reload --dry-run` validates the edited gateway file; `reload` commits a new revision. Invalid changes leave the current service configuration intact. The data directory/listener/admin-key-variable/maintenance interval require a process restart. Changing the secrets file requires restarting its consumers; administrator-key rotation in bundled mode requires a stopped installation. Existing streams retain their policy and route snapshot.

`effective-policy PROJECT` explains applicable project, service, and route limits and capability exclusions. `metrics`, `alerts`, and `health` are authenticated operator reads. Account inspection stores sanitized observations with freshness and drift; passive provider quota headers are separate from local token budgets. No health probe performs inference. Pull alerts into your monitoring system; Router4u does not send external notifications.

`export-usage PROJECT` walks cursor-paginated request metadata and emits NDJSON. Original payload export separately requires `exchange:export`. A default principal or a usage-only principal cannot retrieve original transcripts.

Unknown physical occupancy survives cancellation/crash independently from token reservations. Configured route/account concurrency counts uncertain occupancy until `release-occupancy ID --reason EVIDENCE`. This is an operator assertion, not proof synthesized from a timeout. `observe-usage ID --file FILE` accepts a stable source/event ID and a verified request total, corrects the ledger by the delta, and deduplicates retries. Conflicting repeats are rejected. It is not a backend attempt journal and does not imply hidden attempt visibility.
