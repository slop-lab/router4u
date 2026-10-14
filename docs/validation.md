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

The ChatGPT CLI test supplies a fake executable to verify delegation, exact arguments, credential persistence checks, failure detection, and absence of token output. The genuine `-siwc-bind` flag and credential/executor paths were inspected in the pinned source and binary. This establishes implementation compatibility, not a live SIWC authentication test.

## Supported capability profile

| Capability | Initial support |
|---|---|
| Protocols | HTTP Responses and Chat Completions, per-route allowlists |
| Streaming | Ordered application-body SSE, incremental delivery and durable capture |
| ChatGPT plan Responses | Native Responses with validated preview constraints; live account validation pending |
| Legacy Codex OAuth | Backend-managed login start, callback, status; live account validation pending |
| Credential refresh | CLIProxyAPI owns it; no second gateway refresher; real rotation not tested here |
| Account isolation | Dedicated partitions; optional verified exclusive file-backed binding |
| Attempt visibility | One observable backend dispatch per logical request; internal attempts remain unknown |
| Usage | Request-level reported fields and raw detail; unknown/conflicting usage not treated as zero |
| Strict limits | Local request rate/count and active gateway requests |
| Token limits | Observe/estimate only; strict configuration rejected |
| Continuation | HTTP persistent handles rejected; send complete history |
| Capture | Client-facing application bodies only; translated upstream exchanges unavailable |
| Cancellation | Best effort, with independent accounting and delivery state |
| Multi-replica / new bindings | Not enabled |

## Acceptance mapping

The original architecture's scenario IDs are retained here for traceability. A local test is not substituted for a provider guarantee.

| ID | Implemented evidence / remaining boundary |
|---|---|
| A01 | Project keys/state are external to applications; gateway restart and restore tests preserve records. Full project-container deployment lifecycle remains an operator deployment check. |
| A02 | Key rotation/revocation test preserves shared project usage. |
| A03 | Project spoofing, cross-project reads/cancellation, unknown routes rejected; persistent continuation disabled. |
| A04 | Project-to-route allowlists and dedicated partitions; exclusive-binding verification rejects unverified account configurations. Real account scheduling remains a live partition check. |
| A05 | Single backend credential lifecycle owner and stopped-backend SIWC binding; real token expiry/concurrent refresh belongs to live verification. |
| A06 | Concurrent HTTP requests compete for the final allowance; one commits. Shared service budget is applied across projects. |
| A07 | Strict token policy rejected explicitly. |
| A08 | Cancellation, missing usage, early EOF, and terminal failure preserve independent state families. |
| A09 | Gateway makes no automatic retry and settlement is idempotent; internal multiple attempts are explicitly unobserved. |
| A10 | Cache/reasoning subsets are not double-counted; invalid/conflicting totals remain unknown. |
| A11 | Real pi/AI SDK text streaming for both protocols; ChatGPT constraints reject incompatible fields. Provider-specific multimodal/tool capabilities require route-specific live checks. |
| A12 | Original request/stream bytes, token-like strings, and executable-looking text round-trip unchanged. |
| A13 | Manifests label the client application boundary and excluded upstream/header/remote-URL data. |
| A14 | Required and best-effort storage exhaustion before dispatch and during streaming tested. |
| A15 | Actual SIGKILL after durable dispatch; reservation retained without replay. Undispatched recovery tested separately. |
| A16 | Missing usage remains unresolved; no destructive queue polling or complete-attempt claim. |
| A17 | Active request policy snapshot survives a project policy change. |
| A18 | All clients work without Langfuse, session metadata, or tracing SDKs. |
| A19 | Exchange export is JSON with base64 bodies and `nosniff`; no HTML renderer, tool execution, URL fetch, or replay. |
| A20 | SQLite backup/restore preserves payload integrity and unresolved reservations. Other transports are disabled; adding one requires the same contract suite. |

## Live validation checklist

Use your own eligible account. Complete Codex OAuth, then separately bind SIWC if testing ChatGPT plan usage. Confirm `profile` and backend credential mode match, run `doctor`, select an available model, issue an application key, and run the explicit live smoke script. Inspect the request's execution, usage quality, capture boundary, and actual provider behavior.

After a successful first request, verify application restart without login, backend restart without credential loss, account-specific reauthorization, and token refresh when applicable. Exercise real cancellation cautiously and inspect any remaining usage. These steps can consume quota. Do not call a route production-verified until the relevant live checks pass.
