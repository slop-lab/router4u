import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, event, completedResponse, fakeProvider, adminKey } from './helpers.js';
import { ResponseObserver } from '../src/protocol.js';
import { BackendManagement } from '../src/backend.js';

const payload = { model: 'test-model', input: [{ role: 'user', content: 'hello' }], stream: true, store: false };

test('Tool identifiers, partial arguments, multimodal references and repeated context round-trip without execution', async context => {
  const tool = { id: 'fc_original', type: 'function_call', call_id: 'call_original', name: 'edit_document', arguments: '{"text":"<script>inert</script>"}', status: 'completed' };
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { ...tool, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', item_id: tool.id, output_index: 0, delta: '{"text":' },
    { type: 'response.function_call_arguments.delta', item_id: tool.id, output_index: 0, delta: '"<script>inert</script>"}' },
    { type: 'response.output_item.done', output_index: 0, item: tool },
    { type: 'response.completed', response: { ...completedResponse(), output: [tool] } },
  ].map(event).join('');
  const setup = await fixture(context, { handler(request, response) { response.setHeader('content-type', 'text/event-stream'); response.end(events); } });
  const requestPayload = { ...payload, tools: [{ type: 'function', name: 'edit_document', parameters: { type: 'object' } }],
    input: [...payload.input, ...payload.input, { role: 'user', content: [{ type: 'input_image', image_url: 'https://never-fetch.invalid/image.png' }] }], extension_test: { opaque: 'unchanged' } };
  const response = await setup.call('/v1/responses', { body: requestPayload });
  assert.equal(await response.text(), events);
  assert.deepEqual(setup.backend.calls[0].body, requestPayload);
  const id = response.headers.get('x-router4u-request-id');
  const capture = setup.gateway.store.captured(id);
  assert.equal(capture.manifest.state, 'complete');
  assert.ok(capture.manifest.excluded.includes('remote_referenced_bytes'));
  assert.equal(setup.gateway.store.request(id).execution, 'completed');
});

test('Unavailable admission store fails closed without contacting the backend', async context => {
  const setup = await fixture(context);
  setup.gateway.store.db.exec('PRAGMA query_only=ON');
  const response = await setup.call('/v1/responses', { body: payload });
  assert.equal(response.status, 503);
  assert.equal(setup.backend.calls.length, 0);
  setup.gateway.store.db.exec('PRAGMA query_only=OFF');
});

test('Request and response byte limits reject work or terminate delivery explicitly', async context => {
  const smallRequest = await fixture(context, { config: { max_request_bytes: 10 } });
  assert.equal((await smallRequest.call('/v1/responses', { body: payload })).status, 413);
  assert.equal(smallRequest.backend.calls.length, 0);
  const smallResponse = await fixture(context, { config: { max_response_bytes: 10 } });
  const response = await smallResponse.call('/v1/responses', { body: payload }).catch(() => null);
  if (response) await response.text().catch(() => {});
  const [record] = smallResponse.gateway.store.requests('alpha');
  assert.equal(record.error, 'response_too_large');
  assert.equal(record.capture, 'partial');
});

test('Metadata policy intentionally captures no payload bytes', async context => {
  const setup = await fixture(context, { policy: { recording: 'metadata' } });
  const response = await setup.call('/v1/responses', { body: payload });
  await response.text();
  const capture = setup.gateway.store.captured(response.headers.get('x-router4u-request-id'));
  assert.equal(capture.manifest.state, 'disabled_by_policy');
  assert.equal(capture.chunks.length, 0);
});

test('Repeated terminal usage is charged once; conflicting observations stay unknown', () => {
  const observer = new ResponseObserver('responses', true, 10000);
  const terminal = { type: 'response.completed', response: completedResponse() };
  observer.push(Buffer.from(event(terminal) + event(terminal)));
  assert.equal(observer.usage.total, 15);
  observer.push(Buffer.from(event({ ...terminal, response: { ...terminal.response, usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } })));
  assert.equal(observer.usage, null);
  assert.equal(observer.usageConflict, true);
});

test('Account binding requires the expected sole credential and rejects backend drift', async context => {
  let credentials = [{ name: 'owner.json', provider: 'codex', disabled: false }];
  const upstream = await fakeProvider((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('x-cpa-version', '8.0.28');
    response.end(JSON.stringify(request.url.endsWith('/config') ? { routing: { retry: { 'request-retry': 0, 'max-retry-credentials': 1 } }, 'api-keys': {} } : { files: credentials }));
  });
  context.after(() => upstream.close());
  const management = new BackendManagement({ base_url: upstream.url, management_key_env: 'KEY', credential_name: 'owner.json' }, { KEY: adminKey });
  await management.verifyExclusiveAccount();
  credentials = [...credentials, { name: 'other-owner.json', provider: 'codex', disabled: false }];
  await assert.rejects(management.verifyExclusiveAccount(), /could not be verified/);
});

test('Active request limits reject a second request until local execution ends', async context => {
  let finish;
  const setup = await fixture(context, { policy: { concurrency: 1 }, handler(request, response) {
    response.setHeader('content-type', 'text/event-stream'); response.write(': started\n\n');
    finish = () => response.end(event({ type: 'response.completed', response: completedResponse() }));
  } });
  const first = await setup.call('/v1/responses', { body: payload });
  const second = await setup.call('/v1/responses', { body: payload });
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, 'local_capacity_exhausted');
  finish();
  await first.text();
  assert.equal(setup.gateway.store.status('alpha').active, 0);
});
