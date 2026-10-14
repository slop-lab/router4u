# Development status and remaining work

The private architecture is the requirements baseline. This is an initial development project, not a released service with existing users. Automated local checks do not constitute live-provider or end-user acceptance.

## Implemented for local verification

- Project identities, explicit principal scopes, policy revisions, admission, durable usage reservations, capture, retention, and audited corrections.
- CLIProxyAPI-owned OAuth and refresh delegation, route/account metadata, diagnostics, and conservative account constraints.
- Docker Compose with private backend networking, persistent state, `restart: unless-stopped`, and current-schema backup/restore.
- Model-free installation and browser login, model selection, route enablement, project/key management, request inspection, and saved settings.
- Offline fixtures, pinned backend contracts, SDK client tests, Chromium tests, and isolated container lifecycle checks.

See [validation boundaries](validation.md) for what these tests establish. The installation flow is Docker plus the web UI. The offline demo and maintenance CLI are development/operations tools. There is no separate host initializer, automatic schema upgrade, previous-release migration path, or compatibility permission fallback.

## Remaining work

Multiple upstream accounts are required by the architecture (§4.2 and §5.2). Partitions, project route authorization, exclusive bindings, and scoped lifecycle operations exist. Creating partitions, provisioning secrets, and registering accounts are not yet a complete browser-only workflow.

The owner still needs to validate setup, actual account login, available models, real inference, SDK/application compatibility, restart behavior, account-specific reauthorization, and refresh against intended providers. Docker Hub publication and an installation script are deferred.

## Capability boundaries

The backend exposes request-level observations. Internal attempts and translated upstream captures are unavailable. Strict token ceilings, stateful continuation, additional transports, queues, multiple replicas, monetary estimates, and application orchestration are not enabled. Missing usage remains unknown; provider quota is not inferred from local totals.

Behavioral changes require the offline suite. Backend adapter changes require pinned executable contracts. Automated tests use inert credentials and must not consume real provider quota.
