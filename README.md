# Router4u

A shared, personal LLM access service with project identities, durable usage reservations, original exchange recording, and CLIProxyAPI-managed upstream accounts.

Supports native HTTP Responses and Chat Completions. Sign in with ChatGPT and legacy Codex authentication are distinct supported operator workflows. All upstream OAuth and refresh remain in CLIProxyAPI. Applications use independent Router4u project keys.

**Status:** runnable single-host implementation for personal live validation. Offline fault tests, pinned CLIProxyAPI contracts, and real pi/Vercel SDK clients are automated. A successful test against a fake provider does not establish live OAuth eligibility, quota, refresh behavior, or upstream cancellation. See [validation scope](docs/validation.md).

## Personal use and provider terms

Use ChatGPT/Codex account connections only for yourself and your own applications. Do not share your credentials or project access with other people, resell access, pool unrelated users behind your account, or use this service to bypass provider limits. You are responsible for complying with each provider's current terms, account restrictions, and workspace policies. Technical support for an authentication method is not permission for every deployment. See [authentication and user responsibilities](docs/authentication.md).

## Run with Docker

```sh
sh scripts/setup-docker.sh YOUR_ACCOUNT_MODEL codex
./router4u up -d --build
./router4u cli auth codex
```

Follow [Docker installation and account operations](docs/docker.md) for callback submission, ChatGPT binding, project keys, extra accounts, configuration reload, and complete backups. Both long-running services use `restart: unless-stopped`; state and credentials persist outside containers. Additional isolated accounts can be prepared with `sh scripts/add-partition.sh work YOUR_ACCOUNT_MODEL codex`.

The initializer refuses to overwrite an existing installation. Default application keys cannot export transcripts; issue an explicit `exchange:export` principal when needed.

## Run an offline demo

Requires Node.js **24.19.0 or newer in the 24.x series**. Runtime code has no npm dependencies. SQLite is provided by Node. Keep state on a local filesystem.

```sh
npm run demo
```

In another terminal, from this directory:

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

## Connect your own account

Read [the authentication guide](docs/authentication.md) for the complete Codex and ChatGPT login procedures, callback handling, and model selection.

```sh
npm run backend:install
node src/cli.js init --profile codex --model YOUR_ACCOUNT_MODEL
.tools/cli-proxy-api -config .runtime/cliproxyapi.yaml -local-model
```

In separate terminals:

```sh
npm start
node src/cli.js auth codex
```

Open the returned URL, sign in to your own account, then submit the browser's callback URL using `node src/cli.js auth callback` on stdin. Query `node src/cli.js auth status STATE`, then `node src/cli.js accounts` and `node src/cli.js models`.

Register an application and issue its project key:

```sh
node src/cli.js project put my-app --file examples/policy.json
node src/cli.js project key my-app
```

For ChatGPT plan usage, bind the separate ChatGPT credential and change the route profile to `chatgpt` as described in [the authentication guide](docs/authentication.md). `auth codex` alone creates a legacy Codex connection; it does not complete the separate public Responses authorization.

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
npm run benchmark
```

The Docker test container has no external network, a read-only repository, and writable temporary storage. It contains no real provider credentials in its environment.

## Interfaces and operations

- [Docker setup, additional accounts, and reload](docs/docker.md)
- [API and policy reference](docs/api.md)
- [pi and Vercel AI SDK examples](docs/clients.md)
- [Recovery, backups, retention, and deployment](docs/operations.md)
- [Backend capability evidence and acceptance criteria](docs/validation.md)
- [Implementation decisions](docs/implementation.md)

Router4u records the client-facing application bodies, not application conversation history or backend-translated provider traffic. Full capture preserves sensitive content without silent redaction. Exchange readers can access secrets present in their authorized records. There is no transcript HTML renderer or automatic replay.

Token admission is estimate-based; strict token ceilings are rejected. Missing usage keeps reservations outstanding until an audited operator resolution. Logical request counts and active gateway concurrency have strict local bounds. Provider quota is separate from local allowance. Hidden backend attempts remain unobserved.

Run one gateway per state directory and one active refresher per upstream credential. Only Router4u ingress should be reachable by applications. Keep backend inference, backend management, and credential files inaccessible to project containers. The loopback defaults are intended for a trusted single-user host; see deployment guidance before connecting containers or another host.
