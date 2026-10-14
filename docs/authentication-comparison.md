# Why Router4u retains both Codex and ChatGPT plan authentication

Reviewed on 2026-10-14 against official OpenAI documentation and the pinned CLIProxyAPI 8.0.28 source. This is a documentation and implementation comparison, not a live entitlement test.

## Decision

Keep both profiles. SIWC is not merely a second label for the Codex credential. It provides an explicitly documented OAuth path for eligible open-source and locally hosted applications to use a ChatGPT plan with the public Responses API. Removing it would remove that distinct integration option.

| Property | Router4u `codex` | Router4u `chatgpt` (SIWC) |
| --- | --- | --- |
| Default upstream in the pinned backend | `https://chatgpt.com/backend-api/codex` | `https://api.openai.com/v1/responses` |
| Credential selected by the backend | Codex OAuth credential | Separate SIWC grant, with `use_siwc` enabled |
| Documented third-party public Responses integration | Do not infer this permission from a working Codex token | Explicitly documented for eligible OSS/local applications |
| Account and model eligibility | Requires live verification | Requires live verification and the selected account's model catalog |
| Extra quota or lower cost | No comparison established | No additional allowance or price advantage established |
| Current connection UX | Backend management OAuth start/callback/status | Backend CLI binding, with a Router4u maintenance procedure |

OpenAI also calls the ordinary Codex account login “Sign in with ChatGPT.” Router4u's profile names distinguish the pinned backend's two credential and transport paths, not two unrelated OpenAI identities.

## Sources and limits

- [SIWC quickstart](https://developers.openai.com/siwc/quickstart): eligible Plus/Pro users, OSS integration, explicit Responses scopes, and app usage/access management.
- [OSS overview](https://developers.openai.com/siwc/token-sharing-open-source): client registration is bound to a user and selected workspace; describes the local/OSS integration scope.
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference): account-specific catalog, public Responses endpoint, and terminal-event verification. The public SIWC flow must not target ChatGPT's internal backend endpoints.
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations): `store:false`, `stream:true`, self-contained input, and restricted request capabilities. SIWC is not the unrestricted Platform API.
- [Codex authentication](https://learn.chatgpt.com/docs/auth): Codex supports ChatGPT subscription sign-in and separately billed API-key access.

The pinned backend source confirms the endpoint split in `internal/runtime/executor/codex_executor_auth.go`, `codex_executor_execute.go`, and `codex_executor_stream.go`. It does not prove which models or limits a real account receives. Model catalog presence alone does not prove successful inference. No claim is made that SIWC provides more models, extra independent quota, or lower cost than Codex.

## Why the current SIWC procedure stops the backend

This is a Router4u integration precaution, not a Sign in with ChatGPT protocol requirement. Router4u's `auth chatgpt` command rejects a running backend before invoking CLIProxyAPI's `-siwc-bind`. CLIProxyAPI 8.0.28 exposes this binding as a CLI operation; `internal/cmd/siwc_bind.go` itself uses a file lock and atomic write when persisting the SIWC section.

The current procedure avoids unverified interaction between a separate binding process, the running backend's in-memory credentials, file watching, and refresh/persistence. A future online binding workflow needs a backend-owned operation and contract tests for concurrent refresh and live credential replacement. OAuth registration, exchange, persistence, and refresh must remain in CLIProxyAPI. Stopping the backend should not be described as an inherent SIWC limitation.
