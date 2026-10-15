# Router4u

A shared, personal LLM access service with project identities, durable usage reservations, JSONL exchange logging, and CLIProxyAPI-managed upstream accounts.

Supports native HTTP Responses and Chat Completions. Codex account OAuth and provider API-key connections are supported. All upstream OAuth and refresh remain in CLIProxyAPI. Applications use independent Router4u project keys.

**Status:** initial development. The owner reports successful real-provider use through the pi CLI. Automated offline, browser, SDK, backend-contract, and container checks cover separate behaviors; this is not a production-readiness or universal provider-compatibility claim. See [validation scope](docs/validation.md).

## Personal use and provider terms

Use ChatGPT/Codex account connections only for yourself and your own applications. Do not share your credentials or project access with other people, resell access, pool unrelated users behind your account, or use this service to bypass provider limits. You are responsible for complying with each provider's current terms, account restrictions, and workspace policies. Technical support for an authentication method is not permission for every deployment. See [authentication and user responsibilities](docs/authentication.md).

## Run with Docker

```sh
docker build -t router4u:local .
docker run -d --name router4u --restart unless-stopped \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
  -p 127.0.0.1:9470:9470 \
  -v router4u-data:/var/lib/router4u \
  -v router4u-transcripts:/var/lib/router4u-transcripts router4u:local
docker exec router4u router4u admin-key show
```

The Linux amd64 image includes checksum-pinned CLIProxyAPI. No host setup script, `.env`, model, or provider credential is needed. Initial configuration and private keys are generated in the persistent volume. Open **http://127.0.0.1:9470/** and sign in with the administrator key from the explicit command above. Do not share its output.

Set the host bind address and port with Docker `-p`: for example `-p 192.168.1.10:8080:9470`. The default example exposes only localhost; protect nonlocal ingress with HTTPS. Do not publish backend port 8317.

1. In **Connections → personal**, choose **Connect Codex** and finish sign-in.
2. Choose **Set up models → Load available models**, select the models you want, and click **Use selected models**.
3. Set **Request routing** to **On** and **Save route**.
4. In **Projects & keys**, create a project, allow its connection, and issue an application key.

The initial connection is disabled and has no model allowlist. No inference is admitted until it is configured and enabled. Use the [web control room](docs/web-ui.md) for everyday administration. Use `docker exec router4u router4u health` for passive operational status.

Follow [Docker installation and account operations](docs/docker.md) for persistence, callback submission, project keys, and complete backups. The container supervises Gateway and CLIProxyAPI; failure of either ends the container so Docker can restart it. Operational state and credentials persist in `router4u-data`; sensitive JSONL records persist separately in `router4u-transcripts`. Runtime diagnostics use Docker logging with bounded rotation.

Use the [Compose partition topology](docs/compose.md) when projects need separate backend account sets. The default single-container installation runs one backend.

Runtime initialization retains existing configuration and keys. Default application keys cannot export transcripts; issue an explicit `exchange:export` principal when needed.

## Run an offline demo

Requires Node.js **24.19.0 or newer in the 24.x series**. Runtime code has no npm dependencies. SQLite is provided by Node. Keep state on a local filesystem.

```sh
npm run demo
```

Open **http://127.0.0.1:9470/** and use `ROUTER4U_ADMIN_KEY` from `.runtime/demo.env` to try the UI without any provider connection.

To exercise inference from another terminal:

```sh
set -a
. .runtime/demo.env
set +a
curl -N http://127.0.0.1:9470/v1/responses \
  -H "Authorization: Bearer $ALPHA_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"test-model","input":[{"role":"user","content":"Hello"}],"store":false,"stream":true}'
curl http://127.0.0.1:9470/v1/usage -H "Authorization: Bearer $ALPHA_KEY"
```

The demo creates two projects and a loopback fake provider. It preserves its SQLite state across restarts. Keys are saved in `.runtime/demo.env`, not source control. Inspect `GET /v1/requests` and `GET /v1/requests/REQUEST_ID/exchange` with the same project key. The second project's key cannot retrieve the first project's records. Stop with Ctrl-C.

## Live validation

Connect accounts and issue project keys through the Docker-hosted web UI above. The offline demo is a development fixture, not a second installation method.

To deliberately send one real request after setup:

```sh
export ROUTER4U_PROJECT_KEY='the-issued-project-key'
export ROUTER4U_MODEL='your-account-model'
node scripts/live-smoke.js
```

This consumes real provider quota and records the exchange. It verifies completed inference, delivery, and capture; it prints accounting completeness separately. No live inference runs as part of ordinary tests or health probes.

## Test

```sh
npm test
npm ci --ignore-scripts
npm run test:clients
npm run backend:install
npm run test:backend
```

`npm test` uses only Node built-ins and loopback fakes. Client tests use pinned `ai`, `@ai-sdk/openai`, and `@earendil-works/pi-ai` dev dependencies. Backend tests execute the checksum-pinned CLIProxyAPI v8.0.28 binary against local fake providers. Installing dependencies and downloading artifacts need network access; executing the suites does not.

For an enforced network-free test run after downloads:

```sh
sh scripts/test-offline.sh
docker build -t router4u:local .
docker build -f deploy/backend.Dockerfile -t router4u-backend:8.0.28 .tools
npm run test:deployment
npm run test:container
npm run benchmark
```

The Docker test container has no external network, a read-only repository, and writable temporary storage. It contains no real provider credentials in its environment.

## Interfaces and operations

- [Docker setup, additional accounts, and reload](docs/docker.md)
- [JSONL logs and on-demand analysis](docs/logs.md)
- [API and policy reference](docs/api.md)
- [pi and Vercel AI SDK examples](docs/clients.md)
- [Recovery, backups, retention, and deployment](docs/operations.md)
- [Backend capability evidence and acceptance criteria](docs/validation.md)
- [Architecture and implementation](docs/implementation.md)
- [Development status and remaining work](docs/completion-plan.md)

Router4u records the client-facing application bodies, not application conversation history or backend-translated provider traffic. Full capture preserves sensitive content without silent redaction. Exchange readers can access secrets present in their authorized records. There is no transcript HTML renderer or automatic replay.

Token admission is estimate-based; strict token ceilings are rejected. Missing usage keeps reservations outstanding until an audited operator resolution. Logical request counts and active gateway concurrency have strict local bounds. Provider quota is separate from local allowance. Hidden backend attempts remain unobserved.

Run one gateway per state directory and one active refresher per upstream credential. Only Router4u ingress should be reachable by applications. Keep backend inference, backend management, and credential files inaccessible to project containers. The loopback defaults are intended for a trusted single-user host; see deployment guidance before connecting containers or another host.
