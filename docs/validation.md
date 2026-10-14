# Validation and capability evidence

## Test boundary

Automated tests use inert credentials and deterministic loopback providers. The unit, pinned-backend, and SDK suites run together in a Docker container with `--network none`; browser checks also run without external networking. Container lifecycle tests use temporary installations with inert credentials. Dependency and binary installation happen before that isolated run. Live provider accounts are not read from the developer machine or automatically used.

Pinned versions:

| Component | Version |
|---|---|
| Node.js | 24.19.0 |
| CLIProxyAPI | 8.0.28, reported commit `0d18d3b3` |
| CLIProxyAPI Linux x64 no-plugin archive | SHA-256 `7d41095b7daaf61ea29cdcc691c238acda4da352acf8babe3f8d8720595f7d35` |
| Vercel `ai` | 7.0.140 |
| `@ai-sdk/openai` | 4.0.93 |
| `@earendil-works/pi-ai` | 1.2.0 |

The backend suite exercises the actual released executable. It proves native `/v1/responses` forwarding through its Codex executor to a fake upstream, a single observed failed attempt for the configured compatible-provider route, v8 management schemas, PKCE login initiation, and local usage/capture. It does not complete a real browser login or exchange a real authorization code.


## Development verification scope

Local automated tests exercise the gateway with deterministic providers and inert credentials. They are not end-user acceptance or live-provider verification. The project remains in initial development. The owner reports successful real-provider use through the pi CLI; exact client/model versions and tool coverage were not supplied. This manual check predates the fresh bundled installation and is not reproduced by the automated suites.

The offline suite covers durable accounting, failure recovery, authorization, configuration, model-free setup, pinned backend contracts, and SDK clients. Browser tests cover onboarding and administration. Compose tests cover isolation, additional partitions, crash restart, and backup/restore. Run the commands below against the current checkout instead of treating earlier test counts as a release guarantee.

## Supported capability profile

| Capability | Initial support |
|---|---|
| Protocols | HTTP Responses and Chat Completions, per-route allowlists |
| Streaming | Ordered application-body SSE, incremental delivery and durable capture |
| Codex Responses | Native Responses contract tested; owner reports real-provider pi use |
| Codex OAuth | Backend-managed login start, callback, status; connected active Codex credential observed during owner validation |
| Credential refresh | CLIProxyAPI owns it; no second gateway refresher; real rotation not tested here |
| Account isolation | Dedicated partitions; optional verified exclusive file-backed binding |
| Attempt visibility | One observable backend dispatch per logical request; internal attempts remain unknown |
| Usage | Request-level reported fields and raw detail; unknown/conflicting usage not treated as zero |
| Strict limits | Local request rate/count and active gateway requests |
| Token limits | Observe/estimate only; strict configuration rejected |
| Continuation | HTTP persistent handles rejected; send complete history |
| Capture | Client-facing application bodies only; translated upstream exchanges unavailable |
| Cancellation | Best effort; uncertain physical occupancy survives until explicit audited resolution, independently of token accounting |
| Administration | Versioned reload, account registry/lifecycle delegation, scopes, effective policy, retention, paginated exports, metrics and pull alerts |
| Additional budgets | Calendar day/month and rolling request/token/observable-dispatch budgets; request/token rates and project archive limits |
| Deployment | Bundled supervisor and loopback backend; optional Compose partitions; persistent state, `unless-stopped`, backup/restore |
| Multi-replica / new bindings | Not enabled |

## Behavior checks

The checks below describe supported behavior and its verification boundaries. A local test is not a provider guarantee.

| Check | Implemented evidence / remaining boundary |
|---|---|
| 1 | Docker deployment test runs two projects with independent identities, recreates one container, and verifies shared usage and credentials/state remain external. Real upstream login reuse remains a live check. |
| 2 | Key rotation/revocation test preserves shared project usage. |
| 3 | Project spoofing, cross-project reads/cancellation, unknown routes rejected; persistent continuation disabled. |
| 4 | Project-to-route allowlists and dedicated partitions; exclusive-binding verification rejects unverified account configurations. Real account scheduling remains a live partition check. |
| 5 | Single backend credential lifecycle owner; real token expiry/concurrent refresh belongs to live verification. |
| 6 | Concurrent HTTP requests compete for the final allowance; one commits. Shared service budget is applied across projects. |
| 7 | Strict token policy rejected explicitly. |
| 8 | Cancellation, missing usage, early EOF, and terminal failure preserve independent state families. |
| 9 | Gateway makes no automatic retry. Settlement and stable source/event corrections are idempotent; undispatched observable-attempt reservations are released. Internal multiple attempts are explicitly unobserved, so full internal-attempt accounting is excluded. |
| 10 | Cache/reasoning subsets are not double-counted; invalid/conflicting totals remain unknown. |
| 11 | Real pi/AI SDK text streaming for both protocols; raw partial tool arguments, tool IDs, repeated context, opaque fields, and multimodal references round-trip in deterministic fixtures. Actual provider-specific multimodal/tool capabilities require route-specific live checks. |
| 12 | Original request/stream bytes, token-like strings, and executable-looking text round-trip unchanged. |
| 13 | Manifests label the client application boundary and excluded upstream/header/remote-URL data. |
| 14 | Required and best-effort storage exhaustion before dispatch and during streaming tested. |
| 15 | Actual SIGKILL after durable dispatch; reservation retained without replay. Undispatched recovery tested separately. |
| 16 | Missing usage remains unresolved; no destructive queue polling or complete-attempt claim. |
| 17 | Active project/configuration/recording-limit snapshots survive edits. Invalid reloads leave the previous revision active. New budgets include historical traffic; budget identity cannot silently change. |
| 18 | All clients work without Langfuse, session metadata, or tracing SDKs. |
| 19 | Exchange export is JSON with base64 bodies and `nosniff`; no HTML renderer, tool execution, URL fetch, or replay. |
| 20 | Full Docker installation backup/restore preserves inert credentials, extra partitions, payloads, ledger, and unknown reservations. Hash tampering and overwrite are rejected. Unsupported schema rejection without modification is tested. Other transports remain disabled. |

## Live validation checklist

Use your own eligible account. Complete Codex OAuth for the intended backend partition. Confirm `profile` and backend credential mode match, run `doctor`, select an available model, issue an application key, and run the explicit live smoke script. Inspect the request's execution, usage quality, capture boundary, and actual provider behavior.

After a successful first request, verify application restart without login, backend restart without credential loss, account-specific reauthorization, and token refresh when applicable. Exercise real cancellation cautiously and inspect any remaining usage. These steps can consume quota. Do not call a route production-verified until the relevant live checks pass.


## Reproducible deployment and overhead checks

After building the bundled image, run `npm run test:container` to verify initialization, private keys, local backend health, state locking, shutdown, process failures, replacement, and administrator-key rotation. It uses temporary state and no live account credentials.

For the optional Compose topology, download dependencies/backend and build both images before running:

```sh
npm run test:deployment
npm run benchmark
```

The deployment suite creates temporary runtime state and Docker networks, starts the actual Compose services, and removes its test installation afterward. Both application and infrastructure test networks are internal; control probes also run inside containers. No real account credentials are used. The backend's unrelated background update attempts cannot reach the Internet in this suite.

The final local Linux x64 / Node 24.19.0 benchmark measured 50 sequential fake-provider requests per scenario:

| Scenario | Median | p95 |
|---|---:|---:|
| Direct fake provider | 1.71 ms | 2.83 ms |
| Gateway with required durable capture | 5.02 ms | 6.34 ms |
| Midstream client cancellation | 2.85 ms | 4.92 ms |

The median increment was approximately 3.30 ms on this host. Capture work averaged about 0.21 ms per gateway request in this fixture. All 50 interrupted streams retained unknown usage and uncertain occupancy; no cancelled stream was silently counted as free. These are synthetic local measurements, not a production latency target, concurrent-throughput guarantee, or evidence of actual provider cancellation. Re-run on the intended disk and workload before increasing capacity.

## Remaining provider-dependent or excluded capabilities

Beyond the reported Codex/pi connection check, refresh rotation, model-specific entitlement, provider tools/modalities, real quota semantics, and cancellation after upstream consumption still require explicit live checks. Credential restoration uses inert fixtures and cannot prove that an old rotating token will remain accepted.

Full hidden-attempt journaling, translated upstream capture, strict token ceilings, stateful continuation, additional transports, distributed workers, monetary estimates, and an application/agent control plane are not enabled. These exclusions must not be represented as live-verified implementations.

## Reproduce browser and offline checks

After installing dependencies and the pinned backend:

```sh
sh scripts/test-offline.sh
npm run test:browser
```

The browser test prepares pinned Node and Playwright images, then runs with `--network none`, a read-only repository, and temporary browser state. It starts with a disabled connection and no models, discovers/selects a model, enables the connection, creates a project and key, sends a fake-provider request, and checks history, settings, audit, responsive layout, and logout.

The current storage implementation initializes empty databases and reopens only its exact supported schema. Tests verify unsupported schemas are left unchanged and principals with missing scope metadata cannot authenticate. No schema migration or compatibility-default permissions are implemented.

A complete browser-only account provisioning wizard is still missing. Backend partitions can be provisioned through deployment scripts, then connected in the UI. New installations and account/model combinations still need their own live checks. The reported pi success does not verify token refresh, provider quota, or every application workflow.
