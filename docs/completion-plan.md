# Remaining architecture implementation

The private architecture is the requirements baseline. This increment completes the single-host operational path without moving OAuth, refresh, protocol translation, application tools, or conversation ownership into Router4u.

## Implementation groups

1. Durable account/configuration revisions, validated reload, principal scopes, historical exports, retention, additional budget dimensions, auditable corrections, and uncertain execution occupancy.
2. Pinned backend lifecycle operations and passive quota observations, effective-policy/capability inspection, metrics and actionable alerts.
3. Docker Compose with `restart: unless-stopped`, private backend networking, persistent state/authentication, restart-safe locking, and CLI-driven administration.
4. Complete installation backup/restore, schema migration protections, automated container lifecycle verification, and representative streaming/cancellation overhead measurements.

## Deliberate capability boundaries

The pinned backend exposes request-level observations. Internal attempts and translated upstream captures remain unavailable; the service must not advertise exact accounting for them. Strict token ceilings remain rejected. Stateful continuation, additional transports, queues, multiple replicas, cost estimation, and application orchestration are not enabled. These are explicit architecture-permitted exclusions, not placeholder implementations.

Live account eligibility requires operator verification; management metadata is not proof of successful inference. OAuth callbacks and refresh remain backend-owned. Provider behavior cannot be proven using inert credentials.

All operational additions require offline behavioral tests. Backend mutations require the pinned executable contract suite. Deployment tests use network-isolated fake upstreams and must not consume a real account's quota.


## Recorded completion

The operational implementation groups above are delivered. The final isolated suite passed 58 tests (50 core/operation, four pinned-backend contracts, four SDK contracts), and the Docker lifecycle suite passed with generated extra partitions and full installation recovery. See `validation.md` for measured overhead and the exact provider-dependent exclusions. All generated credentials, auth directories, runtime state, and private reference material remain outside Git.

## Multiple-account UI gap

Multiple upstream accounts are required by the original architecture (§4.2 and §5.2). Dedicated backend partitions, project route authorization, exclusive account binding, and scoped lifecycle operations exist. Creating a partition, provisioning its environment secrets, and initial account registration are not yet a complete browser-only workflow. The web UI must not be described as completing account onboarding until that flow is implemented and tested.
