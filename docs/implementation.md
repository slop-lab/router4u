# Implementation decisions

The architecture in `.local/shared-llm-access-service-architecture.en.md` is the requirements baseline.

The initial deployment is one Node.js 24 process with SQLite WAL and FULL synchronous durability on a local disk. Transactions serialize admission across project and service scopes. Payload chunks occupy a separate table; metadata reads never select payloads. This makes a complete offline installation possible without a database server. Multiple service replicas and network filesystems are unsupported.

CLIProxyAPI v8.0.28 owns upstream credentials, OAuth, refresh, and protocol translation. Router4u owns project identity, immutable policy snapshots, admission, reservations, client-boundary capture, and operator audit records. No agent or tool execution takes place in Router4u.

The backend adapter exposes request-level observation only. It never polls the destructive management usage queue as an authoritative ledger. Missing usage remains unknown. Strict token budgets are rejected; estimate-based token budgets and strict local request/concurrency limits are supported. Internal attempts and upstream translated payloads are not claimed to be fully observed.

Initial routes target dedicated backend partitions. Account-specific attribution requires a verified exclusive credential binding; configured bindings are checked against backend version, retry settings, and the sole active credential before admission. Backend management is available only to operators. Client projects receive their own Router4u key, never an upstream credential.

## Milestones

1. Pin backend contracts and establish the executable repository.
2. Implement durable policy, admission, accounting, and HTTP streaming capture.
3. Add Codex and Sign in with ChatGPT operator workflows, recovery, and deployment tooling.
4. Exercise offline fault tests, pinned backend contracts, real SDK clients, and document live verification steps.

## Authentication baseline

The public Sign in with ChatGPT flow supports Responses at `https://api.openai.com/v1/responses`, with `stream: true`, `store: false`, and self-contained input arrays. Its preview limitations differ from API-key requests and legacy Codex authentication. In v8.0.28, CLIProxyAPI exposes Codex OAuth through `/v8/management/oauth/auth-url?provider=codex`; its `-siwc-bind` CLI attaches ChatGPT plan credentials to an existing Codex credential file. Router4u delegates these operations rather than implementing a second token refresher.

Sources checked on 2026-10-14:

- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://github.com/router-for-me/CLIProxyAPI/tree/v8.0.28
- https://help.router-for.me/management/apiv8
