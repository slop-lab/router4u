# Validation and capability evidence

## Test boundary

Automated tests use inert credentials and deterministic loopback providers. The complete suite also runs in a Docker container with `--network none`. Dependency and binary installation happen before that isolated run. Live provider accounts are not read from the developer machine or automatically used.

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


## Recorded validation run

On 2026-10-14, the final `sh scripts/test-offline.sh` run passed **58 tests**: 50 core/fault/administration/operation tests, 4 pinned backend contracts, and 4 real SDK client tests. The container used `--network none` and a read-only repository. No tests were skipped.

Both runtime Docker images built successfully. The deployment suite also passed with two isolated application containers, the real pinned backend against a fake upstream, and a generated additional backend partition. It verifies direct-backend network denial, cross-project authorization, project container recreation, config reload, automatic `unless-stopped` restart after a killed gateway process, unknown dispatch recovery, and full installation backup/restore including inert credentials and extra partitions. The README demo and `scripts/live-smoke.js` were exercised against the local fake provider, including separate project usage. Actual account login, provider inference, quota consumption, and real refresh remain unverified.

## Supported capability profile

| Capability | Initial support |
|---|---|
| Protocols | HTTP Responses and Chat Completions, per-route allowlists |
| Streaming | Ordered application-body SSE, incremental delivery and durable capture |
| Codex Responses | Native Responses client contract tested; live account validation pending |
| Legacy Codex OAuth | Backend-managed login start, callback, status; live account validation pending |
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
| Deployment | Compose, private backend network, persistent state, `unless-stopped`, complete installation backup/restore |
| Multi-replica / new bindings | Not enabled |

## Acceptance mapping

The original architecture's scenario IDs are retained here for traceability. A local test is not substituted for a provider guarantee.

| ID | Implemented evidence / remaining boundary |
|---|---|
| A01 | Docker deployment test runs two projects with independent identities, recreates one container, and verifies shared usage and credentials/state remain external. Real upstream login reuse remains a live check. |
| A02 | Key rotation/revocation test preserves shared project usage. |
| A03 | Project spoofing, cross-project reads/cancellation, unknown routes rejected; persistent continuation disabled. |
| A04 | Project-to-route allowlists and dedicated partitions; exclusive-binding verification rejects unverified account configurations. Real account scheduling remains a live partition check. |
| A05 | Single backend credential lifecycle owner; real token expiry/concurrent refresh belongs to live verification. |
| A06 | Concurrent HTTP requests compete for the final allowance; one commits. Shared service budget is applied across projects. |
| A07 | Strict token policy rejected explicitly. |
| A08 | Cancellation, missing usage, early EOF, and terminal failure preserve independent state families. |
| A09 | Gateway makes no automatic retry. Settlement and stable source/event corrections are idempotent; undispatched observable-attempt reservations are released. Internal multiple attempts are explicitly unobserved, so full internal-attempt accounting is excluded. |
| A10 | Cache/reasoning subsets are not double-counted; invalid/conflicting totals remain unknown. |
| A11 | Real pi/AI SDK text streaming for both protocols; raw partial tool arguments, tool IDs, repeated context, opaque fields, and multimodal references round-trip in deterministic fixtures. Actual provider-specific multimodal/tool capabilities require route-specific live checks. |
| A12 | Original request/stream bytes, token-like strings, and executable-looking text round-trip unchanged. |
| A13 | Manifests label the client application boundary and excluded upstream/header/remote-URL data. |
| A14 | Required and best-effort storage exhaustion before dispatch and during streaming tested. |
| A15 | Actual SIGKILL after durable dispatch; reservation retained without replay. Undispatched recovery tested separately. |
| A16 | Missing usage remains unresolved; no destructive queue polling or complete-attempt claim. |
| A17 | Active project/configuration/recording-limit snapshots survive edits. Invalid reloads leave the previous revision active. New budgets include historical traffic; budget identity cannot silently change. |
| A18 | All clients work without Langfuse, session metadata, or tracing SDKs. |
| A19 | Exchange export is JSON with base64 bodies and `nosniff`; no HTML renderer, tool execution, URL fetch, or replay. |
| A20 | Full Docker installation backup/restore preserves inert credentials, extra partitions, payloads, ledger, and unknown reservations. Hash tampering and overwrite are rejected. Schema-v1 identity migration and unsupported schema rejection are tested. Other transports remain disabled. |

## Live validation checklist

Use your own eligible account. Complete Codex OAuth for the intended backend partition. Confirm `profile` and backend credential mode match, run `doctor`, select an available model, issue an application key, and run the explicit live smoke script. Inspect the request's execution, usage quality, capture boundary, and actual provider behavior.

After a successful first request, verify application restart without login, backend restart without credential loss, account-specific reauthorization, and token refresh when applicable. Exercise real cancellation cautiously and inspect any remaining usage. These steps can consume quota. Do not call a route production-verified until the relevant live checks pass.


## Reproducible deployment and overhead checks

After downloading dependencies/backend and building both images:

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

Real Codex token exchange, entitlement, refresh rotation, provider tools/modalities, real quota semantics, and cancellation after upstream consumption still require explicit live checks. Credential restoration uses inert fixtures and cannot prove that an old rotating token will remain accepted.

Full hidden-attempt journaling, translated upstream capture, strict token ceilings, stateful continuation, additional transports, distributed workers, monetary estimates, and an application/agent control plane are not enabled. The architecture permits these narrower capabilities when their limits are explicit. These exclusions must not be represented as live-verified implementations.

## Web administration acceptance (2026-10-14)

The web increment passed 61 offline tests: 53 core tests (including session authentication, CSRF, project/admin separation, configuration conflicts, durable browser overrides, and explicit file-reset behavior), four pinned CLIProxyAPI contracts, and four real SDK client tests. Run `sh scripts/test-offline.sh` after installing the pinned development dependencies and backend fixture.

Run `npm ci` followed by `npm run test:browser` for the actual Chromium smoke test. The script prepares pinned Node and Playwright container images, then runs with `--network none`, a read-only repository, and temporary writable browser state. Browser coverage includes login, project creation, one-time key issuance, fake-provider inference, request history, route editing, persistent configuration, audit rendering, pause/resume, reload with an existing session, a 390px viewport, and logout. Browser dependencies are development-only and are not copied into the production image.

The real Compose deployment test additionally confirmed that the production image serves the web UI, accepts an operator session and CSRF-authenticated settings save, and retains browser settings across automatic `unless-stopped` crash restart and full installation backup/restore. Existing project network isolation and unknown-usage recovery checks also passed.

No live provider authentication, SIWC token exchange, actual quota comparison, or real credential refresh was performed. The earlier authentication comparison was based on fetched official documentation and pinned source, not provider execution; its retention decision has since been superseded by SIWC removal.

## SIWC removal acceptance (2026-10-14)

The supported profiles are now `codex` and `api_key`. The offline suite passes 61 tests, including rejection of retired profiles through configuration validation and browser settings, rejection of the removed CLI command without altering an inert existing credential, and Responses streaming through Codex-profile fixtures with Vercel AI SDK and pi-ai. Chromium confirms that only the supported profiles are selectable and the administration workflow remains functional. The Compose suite confirms additional partition provisioning, project isolation, crash restart, and backup/restore after removal.

These are offline/local contracts, not live Codex entitlement or refresh verification. Multiple-account backend support remains in scope; the complete browser-only account provisioning workflow remains an explicit implementation gap.

## Model-free setup acceptance (2026-10-14)

The offline suite passes 64 tests (56 core, four pinned backend contracts, four SDK client tests). New coverage verifies argument-free Docker initialization, disabled model-free connections, additional partitions without model arguments, rejection of obsolete positional arguments, preservation of existing runtime secrets, and discovery followed by explicit enablement. An enabled route without models is rejected; a disabled route never contributes to the project model catalog or dispatches inference.

Chromium starts with an empty, disabled connection and completes model discovery, allowlist selection, explicit activation, project creation, and a fake-provider request. The Compose deployment suite starts generated model-free configurations, enables the fixture through the admin API, then verifies isolation, restart, and backup/restore. No live account login or provider inference was performed.
