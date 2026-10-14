import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fakeProvider, adminKey, backendKey } from './helpers.js';
import { createGateway } from '../src/server.js';
import { BackendManagement } from '../src/backend.js';

const binary = resolve(process.env.CLIPROXY_BINARY ?? '.tools/cli-proxy-api');
if (!existsSync(binary)) throw new Error('Run npm run backend:install before this suite');

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function backendFixture(context, providerType = 'codex', handler) {
  const directory = mkdtempSync(join(tmpdir(), 'router4u-backend-'));
  const upstream = await fakeProvider(handler);
  const port = await freePort();
  const config = {
    'config-version': 8,
    server: { host: '127.0.0.1', port },
    management: { 'secret-key': adminKey, 'allow-remote': false, 'disable-control-panel': true },
    access: { 'api-keys': [backendKey] },
    oauth: { 'auth-dir': join(directory, 'auth') },
    routing: { retry: { 'request-retry': 0, 'max-retry-credentials': 1, 'max-retry-interval': 0 } },
    requests: { streaming: { 'bootstrap-retries': 0 } },
    'api-keys': { [providerType]: [{ name: 'fake', 'base-url': upstream.url, 'disable-cooling': true,
      keys: [{ 'api-key': 'inert-upstream-key' }], models: [{ name: 'test-model', alias: 'test-model' }] }] },
  };
  const configPath = join(directory, 'backend.json');
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(binary, ['-config', configPath, '-local-model'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: directory, NO_PROXY: '127.0.0.1,localhost' } });
  let logs = '';
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-16000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-16000); });
  const route = { id: 'backend', profile: 'api_key', base_url: `http://127.0.0.1:${port}/v1`, key_env: 'TEST_BACKEND_KEY', management_key_env: 'TEST_MANAGEMENT_KEY', models: ['test-model'], protocols: ['responses', 'chat'] };
  const environment = { ROUTER4U_ADMIN_KEY: adminKey, TEST_BACKEND_KEY: backendKey, TEST_MANAGEMENT_KEY: adminKey };
  let gateway;
  context.after(async () => {
    if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; }
    await upstream.close();
    if (gateway) await gateway.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${route.base_url}/models`, { headers: { authorization: `Bearer ${backendKey}` } });
      if (response.ok) break;
    } catch {}
    if (attempt === 99 || child.exitCode !== null) throw new Error(`Backend failed to start: ${logs}`);
    await delay(50);
  }
  gateway = createGateway({ data_dir: join(directory, 'gateway'), port: 0, routes: [route] }, { environment });
  gateway.store.putProject('client', { routes: ['backend'] });
  const { key } = gateway.store.issueKey('client');
  const url = await gateway.listen();
  return { upstream, child, logs: () => logs, gateway, url, key, route, management: new BackendManagement(route, environment), configPath };
}

test('Pinned CLIProxyAPI preserves the native Responses endpoint through the full gateway', async context => {
  const setup = await backendFixture(context);
  const response = await fetch(`${setup.url}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${setup.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', input: [{ role: 'user', content: 'hello' }], stream: true, store: false }) });
  const body = await response.text();
  assert.equal(response.status, 200, body + setup.logs());
  assert.match(body, /response.completed/);
  assert.equal(setup.upstream.calls[0].url, '/v1/responses');
  assert.equal(setup.upstream.calls[0].headers.authorization, 'Bearer inert-upstream-key');
  const record = setup.gateway.store.request(response.headers.get('x-router4u-request-id'));
  assert.equal(record.usage.total, 15);
  assert.equal(record.capture, 'complete');
  assert.match(setup.logs(), /Version: 8\.0\.28/);
});

test('Pinned compatible provider supports Chat Completions and no extra retry rounds', async context => {
  const setup = await backendFixture(context, 'openai-compatibility', (request, response) => { response.writeHead(429, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Fake quota exhausted', type: 'rate_limit_error' } })); });
  const response = await fetch(`${setup.url}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${setup.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }], stream: true }) });
  await response.text();
  assert.equal(response.status, 429);
  assert.equal(setup.upstream.calls.length, 1);
  assert.equal(setup.gateway.store.request(response.headers.get('x-router4u-request-id')).accounting, 'reconciliation_required');
});

test('Pinned v8 management supports Codex PKCE initiation without live sign-in', async context => {
  const setup = await backendFixture(context);
  assert.deepEqual(await setup.management.credentials(), []);
  const diagnostic = await setup.management.inspect();
  assert.equal(diagnostic.version_matches, true);
  assert.equal(diagnostic.retry_configuration_verified, true);
  assert.equal(diagnostic.configured_api_keys, 1);
  await assert.rejects(setup.management.verifyExclusiveAccount(), /could not be verified/);
  const login = await setup.management.login();
  const url = new URL(login.url);
  assert.equal(url.hostname, 'auth.openai.com');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), login.state);
  assert.equal((await setup.management.status(login.state)).status, 'wait');
  await setup.management.call(`/oauth/session?state=${encodeURIComponent(login.state)}`, 'DELETE');
  assert.equal((await setup.management.models()).some(model => model.id === 'test-model'), true);
});
