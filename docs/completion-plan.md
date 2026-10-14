# Development status and remaining work

This is an initial development project. The owner reports successful real-provider use through pi. Automated checks and this manual validation have distinct scopes; see [validation evidence](validation.md).

## Implemented for local verification

- Project identities, explicit principal scopes, policy revisions, admission, durable usage reservations, capture, retention, and audited corrections.
- CLIProxyAPI-owned OAuth and refresh delegation, route/account metadata, diagnostics, and conservative account constraints.
- A bundled container with private persistent keys, loopback-only backend, process supervision, and restart support; optional Compose partitions and current-schema backup/restore.
- Model-free installation and browser login, model selection, route enablement, project/key management, request inspection, and saved settings.
- Offline fixtures, pinned backend contracts, SDK client tests, Chromium tests, and isolated container lifecycle checks.

See [validation boundaries](validation.md) for what these tests establish. The installation flow is Docker plus the web UI. The offline demo and maintenance CLI are development/operations tools. There is no separate host initializer, automatic schema upgrade, previous-release migration path, or compatibility permission fallback.

## Remaining work

Multiple upstream accounts with distinct project eligibility use isolated partitions. Partitions, project route authorization, exclusive bindings, and scoped lifecycle operations exist. Creating partitions, provisioning secrets, and registering accounts are not yet a complete browser-only workflow.

Further live checks include credential reuse after restart, account-specific reauthorization, refresh rotation, cancellation, provider quota, and tool/multimodal behavior. The reported pi check does not establish every model or workflow, and it predates the fresh bundled installation. Docker Hub publication and an installation script are deferred.

## Capability boundaries

The backend exposes request-level observations. Internal attempts and translated upstream captures are unavailable. Strict token ceilings, stateful continuation, additional transports, queues, multiple replicas, monetary estimates, and application orchestration are not enabled. Missing usage remains unknown; provider quota is not inferred from local totals.

Behavioral changes require the offline suite. Backend adapter changes require pinned executable contracts. Automated tests use inert credentials and must not consume real provider quota.
