# Testing and verification scope

Automated tests use deterministic fake providers and inert credentials. They verify local behavior, not live-provider login, model entitlement, token refresh, quota, billing, or cancellation after upstream consumption. Test execution must not use real provider credentials.

Runtime and test versions are pinned in the Dockerfile, package files, and backend installer. Use Node.js 24.19.0 or newer in the 24.x series. Native development tests assume Linux; Windows users should use the [Docker PowerShell commands](docker.md#windows-powershell).

## Offline suites

The built-in suite needs no npm dependencies:

```sh
npm test
```

It covers authorization, admission and accounting, capture, retention, configuration, model-free onboarding, recovery, and backup integrity using temporary state and loopback providers.

Install the pinned development dependencies and backend before running the additional suites:

```sh
npm ci --ignore-scripts
npm run backend:install
npm run test:backend
npm run test:clients
```

Backend contracts run the checksum-pinned CLIProxyAPI executable against local fake providers. They cover forwarding and management contracts, including OAuth initiation; they do not exchange real authorization codes. SDK tests exercise the pinned pi and Vercel clients over HTTP.

After downloading prerequisites, run all three suites with external networking disabled:

```sh
sh scripts/test-offline.sh
```

The test container mounts the repository read-only and uses temporary writable storage.

## Browser and container checks

```sh
npm run test:browser
docker build -t router4u:local .
npm run test:container
```

Browser checks build their pinned images before running in a network-isolated container. They exercise sign-in states, model discovery and selection, route enablement, project keys, request inspection, saved settings, and responsive layouts using a fake backend.

The container suite creates and removes temporary containers and volumes. It covers initialization, private keys, backend health, state locking, shutdown, process failures, replacement, persistence, and administrator-key rotation. It uses no live provider account.

Run `npm run benchmark` for synthetic gateway overhead measurements on the intended host. Results depend on the filesystem and workload and do not establish provider latency or concurrent capacity.

## Live-provider verification

Use an explicitly configured account and project key with `node scripts/live-smoke.js`; see the [application connection guide](docker.md#verify-an-application-connection). This sends a real request, consumes provider quota, and records the exchange. Ordinary tests and health probes do not send live inference.

Verify each account, model, and application workflow separately. Login completion, inference, credential reuse after restart, refresh rotation, provider tools and modalities, quota semantics, and cancellation need their own live checks. Offline backup tests cannot establish that restored rotating tokens remain valid.

Strict token ceilings, hidden backend attempt accounting, translated upstream capture, stateful continuation, additional transports, and multiple gateway replicas are unsupported. See [API limits](api.md) and [implementation boundaries](implementation.md).
