import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, adminKey, backendKey, event, completedResponse } from './helpers.js';

const payload = { model: 'test-model', input: [{ role: 'user', content: 'Inert secret sk-test-only; <script>never execute</script>' }], store: false, stream: true };

test('Responses stream is captured losslessly with separate reported usage and authorization', async context => {
  const setup = await fixture(context);
  const response = await setup.call('/v1/responses', { body: payload });
  assert.equal(response.status, 200);
  const text = await response.text();
  const id = response.headers.get('x-router4u-request-id');
  const record = await (await setup.call(`/v1/requests/${id}`)).json();
  assert.equal(record.execution, 'completed');
  assert.equal(record.accounting, 'settled');
  assert.equal(record.usage.total, 15);
  const capture = await (await setup.call(`/v1/requests/${id}/exchange`)).json();
  const original = direction => Buffer.concat(capture.chunks.filter(chunk => chunk.direction === direction).map(chunk => Buffer.from(chunk.payload, 'base64'))).toString();
  assert.equal(original('request'), JSON.stringify(payload));
  assert.equal(original('response'), text);
  assert.equal(capture.manifest.state, 'complete');
  assert.equal(setup.backend.calls[0].headers.authorization, `Bearer ${backendKey}`);
  assert.equal(setup.backend.calls[0].headers['x-project-id'], undefined);
  assert.equal((await setup.call(`/v1/requests/${id}/exchange`, { key: setup.beta.key })).status, 404);
  assert.equal((await setup.call('/admin/projects')).status, 401);
});

test('Chat Completions and non-stream Responses work without tracing metadata', async context => {
  const setup = await fixture(context);
  for (const [path, body] of [['/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'Hi' }] }], ['/v1/responses', { ...payload, stream: false }]]) {
    const response = await setup.call(path, { body });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(setup.gateway.store.request(response.headers.get('x-router4u-request-id')).usage.total, 15);
  }
});

test('Project spoofing, cross-route calls and unknown continuation are rejected before dispatch', async context => {
  const setup = await fixture(context);
  assert.equal((await setup.call('/v1/responses', { body: payload, headers: { 'x-project-id': 'beta' } })).status, 403);
  assert.equal((await setup.call('/v1/responses', { body: { ...payload, previous_response_id: 'someone-elses-response' } })).status, 400);
  assert.equal((await setup.call('/v1/responses', { body: payload, headers: { 'x-router4u-route': 'unknown' } })).status, 404);
  assert.equal(setup.backend.calls.length, 0);
});

test('Final daily request allowance is reserved atomically under concurrent HTTP requests', async context => {
  const setup = await fixture(context, { policy: { daily_requests: 1 } });
  const results = await Promise.all(Array.from({ length: 12 }, () => setup.call('/v1/responses', { body: payload })));
  await Promise.all(results.map(response => response.text()));
  assert.equal(results.filter(response => response.status === 200).length, 1);
  assert.equal(results.filter(response => response.status === 429).length, 11);
  assert.equal(setup.backend.calls.length, 1);
});

test('Missing usage stays reserved, operator resolution is audited, duplicate settlement is harmless', async context => {
  const setup = await fixture(context, { handler(request, response) {
    response.setHeader('content-type', 'text/event-stream');
    response.end(event({ type: 'response.completed', response: { ...completedResponse(), usage: null } }));
  } });
  const response = await setup.call('/v1/responses', { body: payload });
  await response.text();
  const id = response.headers.get('x-router4u-request-id');
  assert.equal(setup.gateway.store.status('alpha').reserved_tokens, 4096);
  assert.equal(setup.gateway.store.request(id).accounting, 'reconciliation_required');
  const resolution = await setup.call(`/admin/requests/${id}/resolve`, { key: adminKey, body: { tokens: 27, reason: 'Verified externally by operator' } });
  assert.equal(resolution.status, 200);
  setup.gateway.store.settle(id, { total: 999 });
  assert.equal(setup.gateway.store.status('alpha').settled_tokens, 27);
  assert.equal(setup.gateway.store.status('alpha').reserved_tokens, 0);
});

test('Required capture fails before dispatch; best effort marks gaps', async context => {
  const required = await fixture(context, { config: { archive_max_bytes: 1 } });
  const rejected = await required.call('/v1/responses', { body: payload });
  assert.equal(rejected.status, 507);
  assert.equal(required.backend.calls.length, 0);
  assert.equal(required.gateway.store.status('alpha').reserved_tokens, 0);
  const bestEffort = await fixture(context, { config: { archive_max_bytes: 1 }, policy: { recording: 'best_effort' } });
  const response = await bestEffort.call('/v1/responses', { body: payload });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(bestEffort.gateway.store.request(response.headers.get('x-router4u-request-id')).capture, 'partial');
});

test('Midstream recording failure aborts delivery and preserves uncertain accounting', async context => {
  const setup = await fixture(context, { config: { archive_max_bytes: Buffer.byteLength(JSON.stringify(payload)) + 5 } });
  const response = await setup.call('/v1/responses', { body: payload }).catch(() => null);
  if (response) await response.text().catch(() => {});
  const [record] = setup.gateway.store.requests('alpha');
  assert.equal(record.capture, 'partial');
  assert.notEqual(record.delivery, 'complete');
  assert.equal(setup.backend.calls.length, 1);
});

test('Key rotation preserves usage; revocation and pause block future admissions', async context => {
  const setup = await fixture(context);
  await (await setup.call('/v1/responses', { body: payload })).text();
  const newKey = setup.gateway.store.issueKey('alpha');
  setup.gateway.store.revokeKey(setup.alpha.principal_id);
  assert.equal((await setup.call('/v1/usage')).status, 401);
  assert.equal((await (await setup.call('/v1/usage', { key: newKey.key })).json()).settled_tokens, 15);
  await setup.call('/admin/pause', { key: adminKey, body: { paused: true } });
  assert.equal((await setup.call('/v1/responses', { key: newKey.key, body: payload })).status, 403);
});

test('ChatGPT profile preserves native Responses and rejects preview-incompatible parameters', async context => {
  const setup = await fixture(context, { profile: 'chatgpt' });
  for (const change of [{ stream: false }, { store: true }, { input: 'text' }, { max_output_tokens: 12 }, { temperature: 1 }, { tools: [{ type: 'file_search' }] }]) {
    const response = await setup.call('/v1/responses', { body: { ...payload, ...change } });
    assert.equal(response.status, 400);
  }
  assert.equal(setup.backend.calls.length, 0);
  const response = await setup.call('/v1/responses', { body: payload });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(setup.backend.calls[0].url, '/v1/responses');
});

test('Deadline ends a hanging request without silently releasing its allowance', async context => {
  const setup = await fixture(context, { policy: { deadline_ms: 40 }, handler(request, response) { response.setHeader('content-type', 'text/event-stream'); response.write(': waiting\n\n'); } });
  const response = await setup.call('/v1/responses', { body: payload });
  await assert.rejects(response.text());
  const [record] = setup.gateway.store.requests('alpha');
  assert.equal(record.error, 'deadline_exceeded');
  assert.equal(record.execution, 'outcome_unknown');
  assert.equal(record.accounting, 'reconciliation_required');
});

test('Policy changes do not mutate an admitted request snapshot', async context => {
  let complete;
  const setup = await fixture(context, { handler(request, response) {
    response.setHeader('content-type', 'text/event-stream');
    response.write(': started\n\n');
    complete = () => response.end(event({ type: 'response.completed', response: completedResponse() }));
  } });
  const response = await setup.call('/v1/responses', { body: payload });
  const id = response.headers.get('x-router4u-request-id');
  const original = setup.gateway.store.request(id).policy_revision;
  setup.gateway.store.putProject('alpha', { routes: ['local'], enabled: false });
  complete();
  await response.text();
  assert.equal(setup.gateway.store.request(id).policy_revision, original);
  assert.equal(setup.gateway.store.request(id).execution, 'completed');
});

test('Cancellation requires request ownership and reports best effort semantics', async context => {
  const setup = await fixture(context, { handler(request, response) { response.setHeader('content-type', 'text/event-stream'); response.write(': started\n\n'); } });
  const response = await setup.call('/v1/responses', { body: payload });
  const id = response.headers.get('x-router4u-request-id');
  assert.equal((await setup.call(`/v1/requests/${id}/cancel`, { key: setup.beta.key, body: {} })).status, 404);
  const cancelled = await (await setup.call(`/v1/requests/${id}/cancel`, { body: {} })).json();
  assert.equal(cancelled.cancellation_requested, true);
  assert.equal(cancelled.upstream_termination_confirmed, false);
  await assert.rejects(response.text());
});

test('Explicit retention deletion does not delete accounting', async context => {
  const setup = await fixture(context);
  const response = await setup.call('/v1/responses', { body: payload });
  await response.text();
  const id = response.headers.get('x-router4u-request-id');
  setup.gateway.store.deleteCapture(id, true);
  assert.equal(setup.gateway.store.captured(id).manifest.state, 'expired');
  assert.equal(setup.gateway.store.captured(id).chunks.length, 0);
  assert.equal(setup.gateway.store.status('alpha').settled_tokens, 15);
});
