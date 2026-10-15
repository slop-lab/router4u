# Implementation decisions

Router4u provides shared personal LLM access for independent applications. The gateway owns application access and accounting; CLIProxyAPI owns provider integration. This document describes those boundaries without requiring external design documents.

The gateway is one Node.js 24 process with SQLite WAL and FULL synchronous durability on a local disk. Transactions serialize admission across project and service scopes. Payload chunks, detailed request history, audit actions, and notification events are JSONL files. SQLite retains transactional operational state; see [log storage](logs.md). This makes a complete offline installation possible without a database server. Multiple service replicas and network filesystems are unsupported.

CLIProxyAPI v8.0.28 owns upstream credentials, OAuth, refresh, and protocol translation. Router4u owns project identity, immutable policy snapshots, admission, reservations, client-boundary capture, and operator audit records. No agent or tool execution takes place in Router4u.

The backend adapter exposes request-level observation only. It never polls the destructive management usage queue as an authoritative ledger. Missing usage remains unknown. Strict token budgets are rejected; estimate-based token budgets and strict local request/concurrency limits are supported. Internal attempts and upstream translated payloads are not claimed to be fully observed.

Initial routes target dedicated backend partitions. Account-specific attribution requires a verified exclusive credential binding; configured bindings are checked against backend version, retry settings, and the sole active credential before admission. Backend management is available only to operators. Configuration/account records are versioned, project principals carry explicit scopes, and operational commands provide reload, retention, reconciliation, diagnostics, and paginated exports. Client projects receive their own Router4u key, never an upstream credential.

## Authentication baseline

CLIProxyAPI 8.0.28 exposes Codex OAuth through `/v8/management/oauth/auth-url?provider=codex`. Router4u delegates login, callbacks, credential storage, and refresh. Supported profiles are `codex` and `api_key`.

## Durable state and operations

The current SQLite schema includes principal scopes, account registry metadata, configuration revisions, budget definitions/bookings, and stable usage observations. Only an empty database is initialized; incompatible schema versions are rejected without automatic conversion. Every principal must have persisted scope metadata; missing scopes do not inherit permissions. Account IDs and budget resource/period definitions are immutable; creating a new budget definition includes existing matching traffic rather than resetting history.

The default image bundles the gateway and CLIProxyAPI, with backend inference and management bound to loopback. A supervisor starts the gateway after backend readiness and ends the container if either process fails. Private keys, configuration, and SQLite state are kept in the state volume. Request/response records, history, and audit JSONL use a separate transcript volume selected by the restart-only `transcript_dir`. Runtime diagnostics go to Docker-managed stdout/stderr logs. Long-running services use `--restart unless-stopped`; a kernel file lock prevents competing gateway/maintenance containers, while PID/start-time identity protects local CLI use. Only one service process and one refresh owner per credential are supported.

The installation file supplies initial configuration and restart-only fields. A browser save establishes a durable SQLite override for mutable route/account/service configuration; explicit file reload replaces that override and versions its validated contents; backend credential mutations are delegated and audited, and later inspection reports drift. Principal keys default to inference and metadata access without payload-export authority.

Calendar day/month and rolling budgets support local request counts, estimated tokens, and conservatively reserved observable dispatches. Internal backend attempts remain excluded from exactness claims. Request-boundary usage corrections have stable source/event identity, durable replay-safe insertion, audited ledger deltas, and JSONL notification events.

## Web administration

The gateway serves a dependency-free browser UI and exchanges the operator key for a bounded, expiring HttpOnly session. Cookie-authenticated admin calls require same-origin validation and a CSRF header. Existing bearer authentication remains available to CLI automation. Browser settings use the same validators and a revision precondition, with configuration revisions and the saved override committed in one SQLite transaction. Read-only Docker configuration mounts remain supported. See [the web guide](web-ui.md).

## Installation and account setup

Docker bootstrap prepares infrastructure and a disabled `personal` connection without requiring a model or account. An empty model allowlist is valid only while a route is disabled. Operators sign in through CLIProxyAPI, discover/select model IDs in the browser, and explicitly enable the route. Discovery does not grant project authorization or establish real model entitlement. Recreating a container retains saved model choices. The bundled installation provisions one backend. Additional backends require custom deployment and advanced configuration.
