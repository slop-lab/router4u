# API and policy reference

All inference, reads, and cancellation require the relevant principal scope and `Authorization: Bearer PROJECT_KEY`. Operator endpoints require the separate operator key. No cookies or browser session authentication are used. Health endpoints are unauthenticated and disclose no credentials or project data.

## Application endpoints

| Method | Path | Behavior |
|---|---|---|
| POST | `/v1/responses` | Native Responses request and JSON/SSE response |
| POST | `/v1/chat/completions` | Chat Completions on routes allowing `chat` |
| GET | `/v1/models` | Authorized enabled-route model allowlists; not entitlement verification |
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

Set `concurrency`, `daily_requests`, `daily_tokens`, or `requests_per_minute` to JSON `null` to remove that limit at the project or service scope. Omitted fields retain their defaults; zero, empty strings, and negative values are invalid. Unlimited limits do not disable usage accounting, reservations, other scopes, additional budgets, or provider restrictions. The web project form saves blank concurrency and daily-limit fields as `null`.

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


## Principal scopes

Issue keys with `{"scopes":["inference","usage:read"]}` on the key endpoint, or use CLI `--scopes`. Allowed scopes are `inference`, `usage:read`, `requests:read`, `requests:cancel`, and `exchange:export`. Defaults include all except `exchange:export`. Project ownership checks apply in addition to scope checks. Administrator credentials remain separate. Export accesses are audited; scoped metadata access does not grant the original bodies.

## Additional operational endpoints

| Method | Path | Behavior |
|---|---|---|
| GET | `/admin/config` | Current configuration and revision |
| POST | `/admin/config/reload` | Read configured file; `{"dry_run":true}` validates without applying |
| GET | `/admin/config/revisions` | Latest 200 revision identifiers and timestamps |
| GET | `/admin/accounts` | Stable configured account metadata and last observations |
| GET | `/admin/accounts/ID/inspect` | Query backend, record sanitized health/quota/drift |
| POST | `/admin/accounts/ID/enable` or `/disable` | Delegate status change to backend |
| POST | `/admin/accounts/ID/remove` | Remove the referenced backend credential |
| POST | `/admin/accounts/ID/refresh` | Ask backend lifecycle owner to refresh; tokens are not returned |
| POST | `/admin/accounts/ID/reconnect` | Start backend-owned Codex login |
| GET | `/admin/projects/ID/effective-policy` | Applicable scopes, limits, and capability boundaries |
| GET | `/admin/projects/ID/history` | Cursor-paginated request metadata |
| GET | `/admin/projects/ID/usage-history` | Period usage aggregates over a specified interval |
| GET | `/admin/occupancy` | Uncertain physical executions |
| POST | `/admin/requests/ID/release-occupancy` | Audited physical occupancy release, requiring `reason` |
| POST | `/admin/requests/ID/observations` | Idempotent verified usage correction |
| POST | `/admin/retention/run` | Expire up to 100 completed captures |
| GET | `/admin/service-usage` | Service metrics and remaining additional budgets |
| GET | `/admin/metrics` | Counts, uncertainty, archive use, and latency measurements |
| GET | `/admin/alerts` | Actionable uncertainty, archive capacity, and account drift alerts |
| GET | `/admin/health` | Local, management, and configured-authentication status |

Project equivalents `/v1/history`, `/v1/usage-history`, and `/v1/effective-policy` are authorized to the caller's project. History accepts `cursor` (default 0), `limit` (1–200), `from`, and `to` (UTC epoch milliseconds). Responses include `next_cursor`; null ends iteration. Pin `to` for a stable time range. History is ordered by an insertion cursor, so equal timestamps do not lose records. Aggregates group by the request's originally booked project period.

A usage correction body is `{"source":"provider_record","event_id":"stable-source-id","tokens":123,"reason":"Evidence for this request total"}`. Only finished requests can be corrected. Repeating the same source/event is idempotent; conflicting totals or request IDs are rejected. The total replaces the previous request total through an audited ledger delta, never an additional duplicate charge. Token reservation settlement does not release uncertain physical occupancy.

Account mutations require paused admissions, drained work, and no uncertain occupancy. Configured desired state is not silently rewritten by a backend operation. Inspection is explicit; cached observations retain their collection timestamp and do not claim continuous drift detection. Update configuration deliberately and inspect drift. Passive quota snapshots contain their backend source, original observation time, collection time, and allowlisted signals; missing snapshots remain unavailable. They are never calculated from local token use.

## Extended limits and retention

Project policy additionally accepts nullable positive `tokens_per_minute`, `archive_max_bytes`, `retention_days`, and a `budgets` array. Service configuration accepts request/token rates and budgets. Routes accept `concurrency` and `enabled`; registered exclusive accounts may have concurrency limits. No implicit waiting queue is introduced.

```json
{
  "routes": ["personal"],
  "retention_days": 30,
  "archive_max_bytes": 536870912,
  "tokens_per_minute": 50000,
  "budgets": [
    {"id":"month-tokens","resource":"tokens","period":"month","timezone":"Asia/Seoul","limit":2000000,"mode":"estimate"},
    {"id":"hour-requests","resource":"requests","period":"rolling","duration_ms":3600000,"limit":100,"mode":"strict"}
  ]
}
```

Budget resources are `requests`, `tokens`, and `observed_attempts`; periods are `day`, `month`, or `rolling`. A conservative observable-attempt reservation is made with admission and is released if the request never reaches dispatch. A dispatched backend call counts once even if its usage is unknown. It does not count hidden backend retries. Only local request budgets can use `strict`; token and observable-attempt budgets cannot establish a strict upstream bound. Observe-mode budgets record without rejecting for that budget. Explicit additional budgets apply independently of built-in daily limits.

The resource, period, duration, and timezone of a budget ID are immutable. Limits and enforcement mode may change. New budget IDs backfill existing request usage/reservations so policy edits do not reset history. Calendar bookings remain in their admission period; rolling bookings use admission time. All mandatory scopes reserve in one transaction.

Retention expiry is booked from admission time and applies only after local execution finishes. Expiry, explicit deletion, incomplete recording, and intentional metadata-only capture remain distinct. Account/route occupancy may outlive local execution; token reservations are independent. The capture manifest inventories observable input multimodal items without fetching references; the original body remains authoritative, and inventory completeness is explicit.

`X-Correlation-Ref` and `X-Installation-Id` are optional diagnostic metadata, each limited to 256 bytes. They do not affect authorization or budget ownership. The uncertain-occupancy endpoint returns up to 200 oldest unresolved items; releasing them exposes the next batch. Metrics count all unresolved items.

## Browser administration

`GET /` serves the control room. `POST /web/session` accepts `{ "key": "OPERATOR_KEY" }` and returns an HttpOnly session cookie and CSRF token; `GET /web/session` reports session state; `DELETE /web/session` invalidates it. Cookie-authenticated `/admin/*` calls and logout require `X-CSRF-Token`. Existing operator Bearer authentication is unchanged.

- `GET /admin/web-status`: admission pause state and active configuration source (`file` or `browser`).
- `GET /admin/principals`: key IDs, project IDs, and enabled flags; never keys or hashes.
- `PUT /admin/config`: `{ "revision": "CURRENT_REVISION", "config": { ... }, "dry_run": false }`. Validates and saves a durable browser override. A stale revision returns 409; restart-only changes are rejected. Strip the read-only `revision` field from the nested config returned by GET before submitting it.
- Existing `POST /admin/config/reload` replaces the browser override with the installation file only on a successful non-dry-run apply.

See [web administration](web-ui.md) for session and configuration precedence details.

## Unconfigured connections

A route with `enabled:false` may have `models:[]` for account onboarding. Its management login and model discovery remain available to operators. An enabled route requires a nonempty allowlist; empty or whitespace-only model IDs are rejected. Disabled routes do not contribute to the client `/v1/models` catalog and cannot admit inference. Model discovery never enables a route automatically.
