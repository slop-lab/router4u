# API and policy reference

All inference, reads, and cancellation require `Authorization: Bearer PROJECT_KEY`. Operator endpoints require the separate operator key. No cookies or browser session authentication are used. Health endpoints are unauthenticated and disclose no credentials or project data.

## Application endpoints

| Method | Path | Behavior |
|---|---|---|
| POST | `/v1/responses` | Native Responses request and JSON/SSE response |
| POST | `/v1/chat/completions` | Chat Completions on routes allowing `chat` |
| GET | `/v1/models` | Authorized configured model allowlists; not entitlement verification |
| GET | `/v1/capabilities` | Authorized route profiles and explicitly supported features |
| GET | `/v1/usage` | Current project period, settled usage, reservations, outstanding prior-period work |
| GET | `/v1/requests` | Latest 200 project request records |
| GET | `/v1/requests/ID` | Authorized request state and accounting |
| GET | `/v1/requests/ID/exchange` | Manifest and ordered base64 payload chunks with SHA-256 hashes |
| POST | `/v1/requests/ID/cancel` | Best-effort upstream cancellation; no confirmed-stop promise |

Select a route with `X-Router4u-Route`. It may be omitted when the project has exactly one route. Route selection is never inferred from an untrusted project name. A supplied `X-Project-Id` must match the authenticated project. All project principals share the same project allowance.

The service returns its logical request ID in `X-Router4u-Request-Id`. Provider response IDs and tool-call IDs are unchanged. Raw JSON bodies, unknown supported-protocol fields, and SSE data are forwarded without normalization. Upstream translation by CLIProxyAPI is a different boundary and is not included in the client archive.

HTTP continuation handles (`previous_response_id`, `conversation`), background jobs, WebSocket, uploads, and protocols other than Responses/Chat Completions are not enabled. They cannot bypass admission through a generic proxy endpoint. Send complete conversation context on each HTTP request.

## Operator endpoints

| Method | Path | Behavior |
|---|---|---|
| GET | `/admin/projects` | List projects and effective committed policies |
| PUT | `/admin/projects/ID` | Validate and atomically replace a project's policy revision |
| POST | `/admin/projects/ID/keys` | Issue a principal; return its random key once |
| GET | `/admin/projects/ID/requests` | Latest 200 requests for the project |
| DELETE | `/admin/principals/ID` | Revoke future authentication |
| GET | `/admin/usage/PROJECT` | Project usage view |
| POST | `/admin/pause` | `{"paused":true}` or `false`; persists across restart |
| GET | `/admin/active` | Active requests and policy snapshots |
| GET | `/admin/requests/ID` | Inspect request |
| POST | `/admin/requests/ID/cancel` | Cancel selected active request |
| POST | `/admin/requests/ID/resolve` | Audited resolution: `{"tokens":42,"reason":"verified externally"}` |
| GET | `/admin/requests/ID/exchange` | Audited original exchange export |
| DELETE | `/admin/requests/ID/exchange` | Delete finished payloads; keep accounting and deletion state |
| GET | `/admin/audit?after=SEQUENCE` | Up to 200 ordered audit rows |
| GET | `/admin/events?after=SEQUENCE` | Up to 200 committed request-finished outbox rows |
| GET | `/admin/backends/ROUTE/credentials` | Safe metadata only, no tokens |
| GET | `/admin/backends/ROUTE/models` | Explicit backend model discovery |
| GET | `/admin/backends/ROUTE/inspect` | Pinned version, retry configuration, credential-count diagnostics |
| POST | `/admin/backends/ROUTE/login` | Start backend-owned Codex OAuth |
| POST | `/admin/backends/ROUTE/callback` | Submit loopback callback: `{"redirect_url":"..."}` |
| GET | `/admin/backends/ROUTE/status?state=STATE` | Read OAuth progress |

Audit/outbox polling is non-destructive. Persist the last processed sequence after processing; repeated reads may deliver duplicates. Sequence cursors provide replay over retained rows. No push subscription is implemented. Outbox events are committed with request settlement; dashboards are not accounting authorities.

`node src/cli.js --help` lists operator commands. `api /admin/PATH --method METHOD --file BODY.json` provides access to the same authenticated surface without writing database rows manually.

## Policy

Use [the example policy](../examples/policy.json). Unknown policy fields and unsupported enforcement modes are rejected.

| Field | Meaning |
|---|---|
| `enabled` | Permit new admissions; changing it does not cancel existing work |
| `routes` | Explicit route ID allowlist |
| `concurrency` | Strict bound on active gateway requests for this project |
| `requests_per_minute` | Strict local admitted-request rate over the previous 60 seconds |
| `daily_requests` | Strict count of admitted requests in the project's calendar day |
| `daily_tokens` | Project allowance for observed plus estimated reserved tokens |
| `token_mode` | `estimate` or `observe`; `strict` is rejected |
| `token_estimate` | Declared fixed reservation per request, not a measured upper bound |
| `recording` | `required`, `best_effort`, or `metadata` |
| `deadline_ms` | Request lifetime through stream delivery, at most one hour |
| `timezone` | Explicit calendar timezone; timestamps remain UTC |

Service-wide `concurrency`, `daily_requests`, and `daily_tokens` are configured in the gateway JSON file. The service calendar is UTC. Service token admission is always estimate-based; project `observe` mode does not disable the service budget. All applicable reservations commit together using `BEGIN IMMEDIATE`.

Reservations and completed charges remain in their original period. Unknown prior-period work remains visible under `outstanding_all_periods`. Policy revisions preserve history. An estimate can be exceeded by actual usage; the overage remains charged and later admissions are blocked when their reservation cannot fit. `input_tokens` plus `output_tokens` forms the normalized total; cache/reasoning detail fields are not added twice. Missing or inconsistent totals remain unknown. Operator estimates are labeled as adjustments, never provider-reported usage.

Cancellation releases gateway concurrency when the local request ends, but an unknown token reservation remains. Physical upstream occupancy is not known after a disconnect. A gateway concurrency limit is therefore not a promise about already-orphaned upstream work.

## Recording and errors

`required` captures the request before dispatch and durably commits received response chunks before writing them to the client connection. If storage fails, the gateway stops forwarding and requests cancellation. `best_effort` continues with an explicit incomplete manifest. `metadata` deliberately stores no full bodies. There is no automatic masking, summarization, or semantic deduplication.

The archive stores chunk order within `request` and `response`, timestamps, body bytes, hashes, status, and content type. It excludes credentials/HTTP headers, network packet framing, provider-internal data, and bytes behind remote URLs. Fetch may decode HTTP transfer/content encodings; the boundary is application-body bytes, not a full wire capture. A complete body capture can contain a failed or prematurely ended provider stream. Execution and capture completeness are independent.

Service rejections use `error.type=router4u_error` with `code`, `scope`, `retryable`, and `request_id` when assigned. They distinguish authorization, local quota/capacity, unsupported capability, recording failure, deadline, cancellation, and unavailable backend. Upstream error bodies and HTTP status are forwarded; `X-Router4u-Error-Category` distinguishes an upstream 429 from a local rejection. After response headers have been sent, gateway failures terminate the connection instead of appending a different protocol's JSON error or replacement completion. Inspect the request record for the local failure.
