# Authentication and user responsibilities

## Account ownership

Codex account connections are intended for personal use: accounts you own, your workloads, and your independently developed applications. Do not give other people access through your account, distribute upstream credentials, resell access, or treat several project keys as permission to serve unrelated users. Users are responsible for compliance with current provider terms and restrictions. Successful login does not establish contractual eligibility. Public multi-user hosting is outside this repository's supported deployment scope.

Project authentication and upstream authentication are different. Router4u hashes project keys in its ledger; CLIProxyAPI retains OAuth credentials in its private auth directory. Upstream tokens never become project keys, and rotating a project key does not reset its allowance.

## Supported connections

The pinned backend is CLIProxyAPI **v8.0.28**, release commit reported by its binary as `0d18d3b3`. Its management API is v8. Install the Linux x64 no-plugin executable with `npm run backend:install`; the installer checks the release checksum against a digest pinned in source.

| Mode | Connection workflow | Route profile |
| --- | --- | --- |
| Codex account OAuth | Connections → Connect Codex, or `auth codex`, callback, status | `codex` |
| Provider API key | Configure the provider key privately in CLIProxyAPI | `api_key` |

CLIProxyAPI owns OAuth, credential persistence, refresh, and provider translation. Router4u does not implement a second refresher. The Codex provider's sign-in screen may say “Sign in with ChatGPT”; that ordinary Codex account login remains supported. The separate SIWC public-Responses binding and `chatgpt` profile have been removed.

Applications use their Router4u project key and `/v1/responses` or another protocol explicitly allowed by their route. They do not need a separate SIWC binding to use Router4u's Responses endpoint. Successful fake-provider tests verify the client/gateway contract, not a real account's model entitlement or provider capabilities.

## First-time Codex login

For Docker, follow [the Docker guide](docker.md). Once installed, use the [web control room](web-ui.md) to start Codex login for a specific route. The equivalent local CLI workflow is:

1. Run `node src/cli.js init`. This prepares a disabled connection with no models. Existing initialization is never overwritten.
2. Start `.tools/cli-proxy-api -config .runtime/cliproxyapi.yaml -local-model` and `npm start` in separate terminals.
3. Run `node src/cli.js auth codex`. Open its URL in your browser. CLIProxyAPI generates and checks OAuth state and PKCE.
4. If the browser cannot reach `http://localhost:1455/auth/callback?...`, copy the full callback URL, run `node src/cli.js auth callback`, paste it into stdin, and finish with Ctrl-D. Do not put the callback URL into a shell command, issue, chat message, or committed file.
5. Run `node src/cli.js auth status STATE` with the returned state. Continue only after `status: ok`; inspect `node src/cli.js accounts` for the credential filename.
6. In Connections, open Set up models, load the available models, select the allowlist, and enable the connection before saving. A model catalog is not proof of entitlement; completed real inference is the final check.

`auth callback --file PATH` also accepts a protected file containing only the callback URL. Remove that temporary file after use. A stale or failed state should be replaced by starting a new login. Starting or rebuilding an application never initiates OAuth.

For Responses, consume the terminal event: HTTP 200 alone is not success. Failed/incomplete events and EOF without a terminal event remain distinct. The gateway rejects persistent continuation and background execution; send the necessary conversation history. Model-specific tools, parameters, and modalities still require provider validation. No paid-provider fallback is implied.

## Multiple accounts

Multiple accounts are part of the original design. Accounts with different project eligibility use separate backend partitions, each with its own auth directory and credential lifecycle. See [the multiple-account workflow](docker.md#add-another-account-or-provider-partition).

Use a stable account ID and an exclusive route binding when account-specific attribution or capacity limits are needed. Admission verifies the sole enabled credential in that partition. Never copy one rotating credential into multiple running workers. Reauthorization is scoped to the affected partition; a provider outage must not delete unrelated accounts.

Several credentials may share a backend only when all consuming routes are allowed to use the whole pool. Router4u does not claim exact account attribution or per-account enforcement for such pools. The current web UI manages login and configured routes; creating backend partitions and initial account registry entries still requires deployment setup/advanced configuration. A complete browser-only account-add wizard is not implemented.

## Migration from the retired SIWC profile

Removal does not modify or delete credentials, runtime files, archived requests, or historical configuration revisions. Unsupported active `chatgpt` profiles fail validation rather than silently becoming Codex routes. The pinned upstream binary may still contain its own SIWC implementation; Router4u no longer exposes or supports it.

Before upgrading an existing SIWC installation:

1. Back up the installation and export the active configuration using the previous version. If browser settings are active, use Settings → Download configuration; editing the installation file alone will not replace the stored browser override.
2. Provision a fresh Codex backend partition with an empty auth directory and complete Codex login. Do not copy the retired bound credential into the new partition. Merely changing `profile` does not remove the backend's persisted `use_siwc` selection.
3. Update affected routes to target the fresh partition and use `profile: "codex"`. If the upstream account binding changes, allocate a new stable account ID and update the registry. Preserve project route authorization deliberately.
4. Apply the supported configuration in both the active browser override (if present) and the installation file before upgrading. Keep the old credential backup private and inactive; Router4u does not edit it automatically.
5. After upgrading, inspect backend health and complete a real request using an authorized project key. Live model access, quota, and refresh remain unverified until tested with your account.

If already upgraded and startup rejects a saved `chatgpt` profile, temporarily use the preceding version to export and replace the active configuration. Do not delete the database or erase usage history to bypass migration. See [the removal decision](authentication-comparison.md).
