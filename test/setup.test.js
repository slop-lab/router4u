import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.js';
import { fixture, adminKey } from './helpers.js';

test('Unconfigured connections allow discovery but cannot infer until models are selected and enabled', async t => {
  const f = await fixture(t);
  const snapshot = await (await f.call('/admin/config', { key: adminKey })).json();
  const { revision, ...config } = snapshot.config;
  config.routes[0] = { ...config.routes[0], enabled: false, models: [] };
  assert.equal((await f.call('/admin/config', { key: adminKey, method: 'PUT', body: { revision, config } })).status, 200);
  assert.deepEqual((await (await f.call('/v1/models')).json()).data, []);
  assert.equal((await f.call('/v1/responses', { body: { model: 'test-model', input: 'hello' } })).status, 400);
  assert.equal(f.backend.calls.length, 0);
  const models = await (await f.call('/admin/backends/local/models', { key: adminKey })).json();
  assert.equal(models[0].id, 'test-model');
  assert.throws(() => validateConfig({ ...config, routes: [{ ...config.routes[0], enabled: true }] }), /nonempty model allowlist/);
  assert.throws(() => validateConfig({ ...config, routes: [{ ...config.routes[0], enabled: true, models: [' '] }] }), /nonempty model allowlist/);
  config.routes[0].models = ['test-model'];
  const update = () => f.call('/admin/config', { key: adminKey, method: 'PUT', body: { revision: f.gateway.config.revision, config } });
  assert.equal((await update()).status, 200);
  assert.equal((await f.call('/v1/responses', { body: { model: 'test-model', input: 'hello' } })).status, 403);
  assert.equal(f.backend.calls.length, 1); // Only the explicit model-discovery request.
  config.routes[0].enabled = true;
  assert.equal((await update()).status, 200);
  assert.equal((await f.call('/v1/responses', { body: { model: 'test-model', input: 'hello' } })).status, 200);
});
