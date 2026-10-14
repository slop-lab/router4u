import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateConfig } from '../src/config.js';
import { fixture, adminKey } from './helpers.js';

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'router4u-setup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, '.tools'));
  // Inert scaffolding fixture: never executed as a backend.
  const binary = Buffer.from('inert scaffold fixture');
  writeFileSync(join(directory, '.tools/cli-proxy-api'), binary);
  writeFileSync(join(directory, '.tools/backend-lock.json'), JSON.stringify({ version: '8.0.28', archive_sha256: '7d41095b7daaf61ea29cdcc691c238acda4da352acf8babe3f8d8720595f7d35', binary_sha256: createHash('sha256').update(binary).digest('hex') }));
  return directory;
}
const run = (directory, script, ...args) => execFileSync(process.execPath, [resolve(script), ...args], { cwd: directory, encoding: 'utf8', stdio: 'pipe' });

test('Docker setup and additional partitions need no models and preserve existing installations', t => {
  const directory = workspace(t);
  assert.match(run(directory, 'scripts/setup-docker.js'), /choose models/);
  const config = JSON.parse(readFileSync(join(directory, '.runtime/router4u.json')));
  validateConfig(config);
  assert.deepEqual(config.routes[0].models, []);
  assert.equal(config.routes[0].enabled, false);
  assert.equal(config.routes[0].profile, 'codex');
  const secret = readFileSync(join(directory, '.runtime/.env'), 'utf8');
  assert.throws(() => run(directory, 'scripts/setup-docker.js'), /refusing to overwrite/);
  assert.equal(readFileSync(join(directory, '.runtime/.env'), 'utf8'), secret);
  run(directory, 'scripts/add-partition.js', 'work');
  const routes = JSON.parse(readFileSync(join(directory, '.runtime/router4u.json'))).routes;
  assert.equal(routes.length, 2);
  assert.deepEqual(routes[1].models, []);
  assert.equal(routes[1].enabled, false);
  assert.equal(routes[1].base_url, 'http://backend-work:8317/v1');
  assert.notEqual(routes[0].key_env, routes[1].key_env);
  assert.ok(existsSync(join(directory, '.runtime/partitions/work/auth')));
  run(directory, 'scripts/add-partition.js', 'paid', '--profile', 'api_key');
  assert.equal(JSON.parse(readFileSync(join(directory, '.runtime/router4u.json'))).routes[2].profile, 'api_key');
});

test('Obsolete setup arguments fail before runtime creation and help does not provision state', t => {
  const directory = workspace(t);
  assert.throws(() => run(directory, 'scripts/setup-docker.js', 'test-model', 'codex'), /no longer accepts/);
  assert.equal(existsSync(join(directory, '.runtime')), false);
  assert.match(run(directory, 'scripts/setup-docker.js', '--help'), /web UI/);
  assert.match(run(directory, 'scripts/add-partition.js', '--help'), /web UI/);
  assert.equal(existsSync(join(directory, '.runtime')), false);
});

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
