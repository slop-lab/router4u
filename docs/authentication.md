# Authentication and user responsibilities

## Account ownership

ChatGPT and Codex connections in Router4u are intended for personal use: your account, your workloads, and your independently developed applications. Do not give other people access through your account, distribute upstream credentials, resell access, or treat several project keys as permission to serve unrelated users. Users are responsible for compliance with current provider terms and restrictions. Router4u cannot establish contractual eligibility from a successful login.

Follow the provider's current terms and workspace rules. The official [Sign in with ChatGPT overview](https://developers.openai.com/siwc/token-sharing-open-source) distinguishes open-source/local applications from paid or remotely hosted offerings. This repository does not broaden those permissions. Public multi-user hosting is outside its supported deployment scope.

Project authentication and upstream authentication are different. Router4u hashes project keys in its ledger; CLIProxyAPI retains OAuth credentials in its private auth directory. OAuth access tokens never become project keys, and rotating a project key does not reset its allowance.

## Pinned implementation

The tested backend is CLIProxyAPI **v8.0.28**, release commit reported by its binary as `0d18d3b3`. Its management API is v8. Install the Linux x64 no-plugin executable with `npm run backend:install`; the installer checks the release checksum against a digest pinned in source.

Two supported connection modes:

| Mode | Operator command | Route profile | Backend behavior |
|---|---|---|---|
| Legacy Codex OAuth | `auth codex`, callback, status | `codex` | Backend owns Codex OAuth and uses its Codex executor |
| Sign in with ChatGPT | `auth chatgpt --credential NAME.json` | `chatgpt` | Backend binds separate SIWC credentials and uses the public Responses endpoint |

In this backend release, the ChatGPT binding command requires an existing Codex credential file. Therefore complete Codex login first, then perform the separate ChatGPT authorization. This is an upstream integration constraint, not a claim that the official ChatGPT protocol requires Codex sign-in. Router4u does not invent a parallel credential refresh implementation.

## First-time Codex login

1. Run `node src/cli.js init --profile codex --model YOUR_ACCOUNT_MODEL`. This creates protected `.runtime/.env`, backend configuration, and gateway configuration. Existing initialization is never overwritten.
2. Start `.tools/cli-proxy-api -config .runtime/cliproxyapi.yaml -local-model` and `npm start` in separate terminals.
3. Run `node src/cli.js auth codex`. Open its URL in your browser. CLIProxyAPI generates and checks OAuth state and PKCE.
4. After consent, the browser may show a connection error at `http://localhost:1455/auth/callback?...`. That is expected for the manual callback workflow. Copy the full URL, run `node src/cli.js auth callback`, paste it into stdin, and finish with Ctrl-D. Do not put the callback URL into a shell command, issue, chat message, or committed file.
5. Run `node src/cli.js auth status STATE` using the state printed in step 3. A waiting status is not success. Continue only after `status: ok`; inspect `node src/cli.js accounts` for the resulting credential filename.
6. Run `node src/cli.js models` and put an available model ID into `.runtime/router4u.json` under the route's `models`. Restart Router4u after route edits. Model discovery is not proof of model entitlement; completed inference is the final check.

`auth callback --file PATH` also accepts a protected file containing only the callback URL. Remove that temporary file after use. A stale or failed state should be replaced by starting a new login. Signing in is an explicit operator action; starting or rebuilding an application never initiates OAuth.

## Connect Sign in with ChatGPT

1. Complete the Codex login above and identify the credential filename using `accounts`.
2. Pause new work with `node src/cli.js pause`, wait for active requests to finish (`node src/cli.js api /admin/active`), and stop the corresponding CLIProxyAPI backend. The command refuses to bind while that backend endpoint is reachable, avoiding competing credential lifecycle owners.
3. Run:

   ```sh
   node src/cli.js auth chatgpt --credential YOUR_CREDENTIAL.json
   ```

   The CLI delegates to the pinned backend's `-siwc-bind` operation. Follow its browser instructions. It owns callback handling, registration, token exchange, and credential storage. Router4u checks that a new SIWC credential was actually persisted, since a backend process exiting with status zero alone does not prove login success.
4. Set `profile` to `chatgpt` and `protocols` to `["responses"]` for this partition in `.runtime/router4u.json`. Restart CLIProxyAPI and Router4u, then `node src/cli.js resume`.
5. Verify the available models and run `node scripts/live-smoke.js` with a project key and model. Only a completed real request proves this account has access to that model.

For custom paths, pass `--config`, `--backend-bin`, `--backend-config`, and `--auth-dir`. `--auth-dir` must match `oauth.auth-dir` in the backend configuration. Keep the credential filename unchanged when reconnecting to preserve the backend's own stable metadata.

## Responses contract for ChatGPT plan usage

Use `POST /v1/responses`, `stream: true`, `store: false`, and an `input` array containing the needed history. Unsupported preview fields produce a structured rejection before dispatch. Do not set `max_output_tokens` as a supposed hard budget; it is not supported on this route. Use instructions/developer messages instead of system-role input items. Native function/custom tools must follow the provider's supported namespace representation. The gateway forwards supported original bodies without changing them.

An HTTP 200 stream is not enough: require `response.completed`. Failed/incomplete terminal events and EOF without a terminal event remain distinct. A ChatGPT plan limit can arrive after streaming begins. No fallback to a paid provider is configured or implied.

Public SIWC Responses authorization is distinct from legacy Codex tokens. Never point SIWC requests at ChatGPT's internal backend endpoints. Router4u's `chatgpt` profile validates the client contract; CLIProxyAPI's persisted `use_siwc` credential setting selects the actual upstream path. The operator must keep these two settings consistent.

Sources: [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [pinned backend implementation](https://github.com/router-for-me/CLIProxyAPI/tree/v8.0.28/internal/auth/codex).

## Refresh, reconnect, and remote hosts

CLIProxyAPI is the sole active refresher. Never copy a rotating credential into several running workers. Account reauthorization is scoped to the affected partition. The gateway neither logs users in automatically nor deletes credentials during a provider outage.

The first validated deployment is same-host. A remote browser's loopback callback does not reach the server. Follow the provider's [self-hosted VM guidance](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) before transferring credentials, preserving the correct host identity and a single refresh owner. Remote transfer and host-specific revocation semantics are not verified by this repository's offline suite.
