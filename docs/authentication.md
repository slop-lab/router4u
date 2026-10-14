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

CLIProxyAPI owns OAuth, credential persistence, refresh, and provider translation. Router4u does not implement a second refresher. The Codex provider’s sign-in screen may say “Sign in with ChatGPT”; this is the Codex account login.

Applications use their Router4u project key and `/v1/responses` or another protocol explicitly allowed by their route. Successful fake-provider tests verify the client/gateway contract, not a real account's model entitlement or provider capabilities.

## First-time Codex login

Install using [the Docker guide](docker.md), then open [the web control room](web-ui.md).

1. In Connections, choose Connect Codex for the intended backend. CLIProxyAPI creates the OAuth state and PKCE transaction.
2. Open the provider URL and sign in. If the localhost callback page cannot load, paste its complete URL into the control room's Callback URL field. Do not share or commit this URL.
3. Submit the callback and check the status. A waiting status is not success. Inspect the connection's credentials after completion.
4. Choose Set up models, load and select the available models, and explicitly enable the connection before saving. Discovery alone is not proof of model entitlement.
5. Create a project and issue its application key. A completed real request is still needed to verify provider access.

A stale or failed sign-in should be replaced by explicitly starting a new one. Starting or rebuilding an application never initiates OAuth. The Docker guide also documents optional CLI administration for automation and troubleshooting.

For Responses, consume the terminal event: HTTP 200 alone is not success. Failed/incomplete events and EOF without a terminal event remain distinct. The gateway rejects persistent continuation and background execution; send the necessary conversation history. Model-specific tools, parameters, and modalities still require provider validation. No paid-provider fallback is implied.

## Multiple accounts

Multiple accounts are part of the original design. Accounts with different project eligibility use separate backend partitions, each with its own auth directory and credential lifecycle. See [the multiple-account workflow](docker.md#add-another-account-or-provider-partition).

Use a stable account ID and an exclusive route binding when account-specific attribution or capacity limits are needed. Admission verifies the sole enabled credential in that partition. Never copy one rotating credential into multiple running workers. Reauthorization is scoped to the affected partition; a provider outage must not delete unrelated accounts.

Several credentials may share a backend only when all consuming routes are allowed to use the whole pool. Router4u does not claim exact account attribution or per-account enforcement for such pools. The current web UI manages login and configured routes; creating backend partitions and initial account registry entries still requires deployment setup/advanced configuration. A complete browser-only account-add wizard is not implemented.
