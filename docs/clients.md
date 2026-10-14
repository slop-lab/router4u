# Client integration

No Router4u tracing SDK is required. Point a provider-compatible client at the gateway and supply a project key. Only the operator holds upstream credentials. Examples use a single-route project; add `X-Router4u-Route` when selecting among several routes.

## Vercel AI SDK

Tested with `ai@7.0.140` and `@ai-sdk/openai@4.0.93`.

```js
import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const provider = createOpenAI({
  baseURL: 'http://127.0.0.1:9470/v1',
  apiKey: process.env.ROUTER4U_PROJECT_KEY,
});

const result = streamText({
  model: provider.responses(process.env.ROUTER4U_MODEL),
  prompt: 'Hello',
  maxRetries: 0,
  providerOptions: { openai: { store: false } },
});

for await (const text of result.textStream) process.stdout.write(text);
await result.finishReason;
```

On ChatGPT plan routes, use streaming Responses and omit unsupported provider fields such as `maxOutputTokens` and temperature. Agent tool definitions must follow the current ChatGPT plan tool contract; SDK availability of a tool does not establish backend support. A normal API-key route may use `provider.chat(model)` for Chat Completions.

## pi-ai

Tested with `@earendil-works/pi-ai@1.2.0`, the current package following the older `@mariozechner/pi-ai` name. Pin the package before adopting examples from a different release.

```js
import { createModels, createProvider } from '@earendil-works/pi-ai';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';

const model = {
  id: process.env.ROUTER4U_MODEL,
  name: 'Personal gateway model',
  provider: 'router4u',
  api: 'openai-responses',
  baseUrl: 'http://127.0.0.1:9470/v1',
  reasoning: false,
  input: ['text'],
  contextWindow: 32000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const models = createModels();
models.setProvider(createProvider({
  id: 'router4u',
  baseUrl: model.baseUrl,
  models: [model],
  auth: {
    apiKey: {
      name: 'Router4u project key',
      resolve: async () => ({ auth: { apiKey: process.env.ROUTER4U_PROJECT_KEY } }),
    },
  },
  api: openAIResponsesApi(),
}));

const stream = models.stream(model, {
  messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
}, { apiKey: process.env.ROUTER4U_PROJECT_KEY });
for await (const event of stream) {
  if (event.type === 'text_delta') process.stdout.write(event.delta);
}
const result = await stream.result();
if (result.stopReason === 'error' || result.stopReason === 'aborted') throw new Error('Inference did not complete');
```

Set model metadata to the actual model's capabilities. Zero cost metadata above is an example placeholder, not a subscription billing estimate. The pinned pi Responses implementation sends `store:false` and streams. For ChatGPT plan routes, do not supply the request option `maxTokens`, which emits the unsupported `max_output_tokens` field. Tools and agent loops remain application-owned.

## Codex as an application client

Codex authentication managed by the backend is separate from configuring a Codex client to call Router4u. A Responses-compatible Codex provider can use the gateway URL and project key. Disable unsupported WebSocket/continuation behavior and verify the exact client version's request contract before using it against a ChatGPT plan route. This repository tests HTTP SDK clients, not a complete Codex app-server agent session.

## Retry responsibility

Router4u does not automatically replay inference. The generated backend configuration disables extra retry rounds, limits credential attempts, and disables stream bootstrap retries. Vercel examples set `maxRetries:0`. Inspect other clients' own retry settings. A client retry is a new logical request and consumes allowance. Ambiguous dispatch and partial output are not safely replayable just because a connection was lost.

References: [AI SDK testing](https://ai-sdk.dev/docs/ai-sdk-core/testing), [pi provider APIs](https://github.com/earendil-works/pi/tree/main/packages/ai). SDK mocks are useful for client tests, but the gateway test suites also exercise real HTTP, SQLite durability, and the pinned backend binary.
