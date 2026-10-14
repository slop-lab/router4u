import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { initializeRuntime, readSecrets, loadSecrets } from '../src/runtime.js';
import { validateConfig } from '../src/config.js';

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'router4u-runtime-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
test('Bundled runtime initializes private persistent keys and loopback backend without enabling inference', t => {
  const path = directory(t);
  const first = initializeRuntime(path);
  const configuration = validateConfig(JSON.parse(readFileSync(first.configPath)));
  assert.equal(configuration.host, '0.0.0.0');
  assert.equal(configuration.routes[0].base_url, 'http://127.0.0.1:8317/v1');
  assert.equal(configuration.routes[0].enabled, false);
  assert.deepEqual(configuration.routes[0].models, []);
  const backend = JSON.parse(readFileSync(first.backendPath));
  assert.equal(backend.server.host, '127.0.0.1');
  assert.equal(backend.management['allow-remote'], false);
  assert.equal(backend.management['secret-key'], first.secrets.ROUTER4U_BACKEND_MANAGEMENT_KEY);
  assert.deepEqual(backend.access['api-keys'], [first.secrets.ROUTER4U_BACKEND_KEY]);
  assert.equal(statSync(join(path, 'secrets.json')).mode & 0o777, 0o600);
  const before = readFileSync(first.configPath, 'utf8');
  assert.deepEqual(initializeRuntime(path).secrets, first.secrets);
  assert.equal(readFileSync(first.configPath, 'utf8'), before);
  assert.equal(existsSync(join(path, '.env')), false);
  const environment = {};
  loadSecrets(join(path, 'secrets.json'), environment);
  assert.deepEqual(environment, first.secrets);
});
test('Secret loading preserves explicit CLI overrides and malformed secrets never appear in errors', t => {
  const path = directory(t);
  const secretsPath = join(path, 'secrets.json');
  const initial = initializeRuntime(path);
  const environment = { ROUTER4U_ADMIN_KEY: 'inert-explicit-override' };
  loadSecrets(secretsPath, environment);
  assert.equal(environment.ROUTER4U_ADMIN_KEY, 'inert-explicit-override');
  assert.equal(environment.ROUTER4U_BACKEND_KEY, initial.secrets.ROUTER4U_BACKEND_KEY);
  writeFileSync(secretsPath, '{\"ROUTER4U_ADMIN_KEY\": \"inert-secret-not-to-log\"');
  assert.throws(() => readSecrets(secretsPath), error => error.message === 'Cannot read valid runtime secrets');
});
test('Existing configuration without secrets is never assigned replacement credentials', t => {
  const path = directory(t);
  writeFileSync(join(path, 'router4u.json'), '{}');
  assert.throws(() => initializeRuntime(path), /migrate credentials/);
  assert.equal(existsSync(join(path, 'secrets.json')), false);
});
test('Migration preserves all keys, removes .env, and refuses conflicting secrets', t => {
  const path = directory(t);
  const run = () => execFileSync(process.execPath, [resolve('scripts/migrate-secrets.js'), path], { encoding: 'utf8', stdio: 'pipe' });
  const legacy = join(path, '.env');
  writeFileSync(legacy, 'ROUTER4U_ADMIN_KEY=inert-admin\nROUTER4U_BACKEND_KEY=inert-backend\nROUTER4U_WORK_BACKEND_KEY=inert-partition\n');
  const output = run();
  assert.equal(output.includes('inert-admin'), false);
  assert.equal(existsSync(legacy), false);
  const secrets = readSecrets(join(path, 'secrets.json'));
  assert.equal(secrets.ROUTER4U_ADMIN_KEY, 'inert-admin');
  assert.equal(secrets.ROUTER4U_WORK_BACKEND_KEY, 'inert-partition');
  writeFileSync(legacy, 'ROUTER4U_ADMIN_KEY=different\n');
  assert.throws(run, /refusing to overwrite/);
  assert.equal(existsSync(legacy), true);
  assert.deepEqual(readSecrets(join(path, 'secrets.json')), secrets);
});
