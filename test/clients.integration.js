import test from 'node:test';
import assert from 'node:assert/strict';
import { streamText, generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createModels, createProvider } from '@earendil-works/pi-ai';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { fixture } from './helpers.js';

test('Vercel AI SDK streams native Responses using a project credential', async context => {
  const setup = await fixture(context, { profile: 'codex' });
  const openai = createOpenAI({ baseURL: `${setup.url}/v1`, apiKey: setup.alpha.key });
  const result = streamText({ model: openai.responses('test-model'), prompt: 'Hello', maxRetries: 0,
    providerOptions: { openai: { store: false } } });
  assert.equal(await result.text, 'Hello from Router4u');
  assert.equal(setup.backend.calls.length, 1);
  assert.equal(setup.backend.calls[0].body.store, false);
  assert.equal(setup.gateway.store.status('alpha').settled_tokens, 15);
});

test('Vercel AI SDK uses Chat Completions without a gateway SDK', async context => {
  const setup = await fixture(context);
  const openai = createOpenAI({ baseURL: `${setup.url}/v1`, apiKey: setup.alpha.key });
  const result = await generateText({ model: openai.chat('test-model'), prompt: 'Hello', maxRetries: 0 });
  assert.equal(result.text, 'Hello from Router4u');
});

for (const protocol of ['responses', 'chat']) {
  test(`pi-ai streams ${protocol} through a custom provider`, async context => {
    const setup = await fixture(context, { profile: protocol === 'responses' ? 'codex' : 'api_key' });
    const api = protocol === 'responses' ? 'openai-responses' : 'openai-completions';
    const model = { id: 'test-model', name: 'Router4u test model', api, provider: 'router4u', baseUrl: `${setup.url}/v1`,
      reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 };
    const models = createModels();
    models.setProvider(createProvider({ id: 'router4u', baseUrl: `${setup.url}/v1`, models: [model],
      auth: { apiKey: { name: 'Router4u project key', resolve: async () => ({ auth: { apiKey: setup.alpha.key } }) } },
      api: protocol === 'responses' ? openAIResponsesApi() : openAICompletionsApi() }));
    const result = await models.complete(model, { messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }] }, { apiKey: setup.alpha.key });
    assert.equal(result.stopReason, 'stop', JSON.stringify(result));
    assert.equal(result.content.filter(part => part.type === 'text').map(part => part.text).join(''), 'Hello from Router4u');
    assert.equal(setup.backend.calls.length, 1);
  });
}
