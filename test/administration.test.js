import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, adminKey } from './helpers.js';
import { backupInstallation, restoreInstallation } from '../src/installation-backup.js';
import { Store } from '../src/store.js';
import { lockDirectory } from '../src/lock.js';
import { DEFAULT_SCOPES } from '../src/config.js';
const payload = { model: 'test-model', input: [], stream: true, store: false };
const infer = setup => setup.call('/v1/responses', { body: payload });

test('Project keys separate inference, metadata reads, cancellation and sensitive exports', async context => {
  const setup = await fixture(context);
  const key = setup.gateway.store.issueKey('alpha').key;
  const response = await setup.call('/v1/responses', { key, body: payload }); await response.text();
  const id = response.headers.get('x-router4u-request-id');
  assert.equal((await setup.call(`/v1/requests/${id}/exchange`, { key })).status, 403);
  assert.equal((await setup.call(`/v1/requests/${id}`, { key })).status, 200);
  const reader = setup.gateway.store.issueKey('alpha', ['usage:read']).key;
  assert.equal((await setup.call('/v1/responses', { key: reader, body: payload })).status, 403);
  assert.equal((await setup.call(`/v1/requests/${id}/cancel`, { key: reader, body: {} })).status, 403);
  assert.equal((await setup.call('/v1/usage', { key: reader })).status, 200);
  const exporter = setup.gateway.store.issueKey('beta', ['exchange:export']).key;
  assert.equal((await setup.call(`/v1/requests/${id}/exchange`, { key: exporter })).status, 404);
});

test('Configuration reload is validated, durable, atomic, and preserves admitted snapshots', async context => {
  const setup = await fixture(context);
  const original = structuredClone(setup.gateway.config); delete original.revision;
  // Embedders opt into reload with a reader; production CLI supplies the config file reader.
  const { createGateway } = await import('../src/server.js');
  let next = original;
  const other = createGateway({ ...original, data_dir: join(setup.directory, 'reload') }, { environment: { ROUTER4U_ADMIN_KEY: adminKey, TEST_BACKEND_KEY: 'test' }, loadConfig: () => next });
  context.after(() => other.close());
  other.store.putProject('alpha', { routes: ['local'] });
  const principal = other.store.authenticate(other.store.issueKey('alpha').key);
  const old = other.store.admit(principal, other.config.routes[0], 'responses', other.config);
  const revision = other.config.revision;
  next = { ...original, data_dir: other.config.data_dir, routes: [{ ...original.routes[0], concurrency: 1 }] };
  assert.equal(other.reload(true).applied, false); assert.equal(other.config.revision, revision);
  other.reload(); assert.notEqual(other.config.revision, revision);
  assert.equal(other.store.request(old.id).configuration_revision, revision);
  const good = other.config.revision;
  next = { ...next, routes: [] };
  assert.throws(() => other.reload()); assert.equal(other.config.revision, good);
  const persisted = JSON.parse(other.store.db.prepare("SELECT data FROM settings WHERE id='configuration'").get().data);
  assert.equal(persisted.revision, good);
});

test('Calendar and rolling reservations settle once and retain original booking periods', async context => {
  const setup = await fixture(context, { policy: { token_estimate: 10, budgets: [{ id: 'monthly', resource: 'tokens', period: 'month', limit: 20, mode: 'estimate' }] } });
  const first = await infer(setup); await first.text(); assert.equal(first.status, 200);
  assert.equal((await infer(setup)).status, 429);
  const row = setup.gateway.store.db.prepare('SELECT * FROM budget_bookings').get();
  assert.equal(row.amount, 15); assert.match(row.period, /^\d{4}-\d{2}$/);
  const id = first.headers.get('x-router4u-request-id');
  const observation = { source: 'operator_evidence', event_id: 'stable-1', tokens: 5, reason: 'Verified request total in inert fixture' };
  const apply = () => setup.call(`/admin/requests/${id}/observations`, { key: adminKey, body: observation });
  assert.equal((await apply()).status, 200); assert.equal((await apply()).status, 200);
  assert.equal(setup.gateway.store.status('alpha').settled_tokens, 5);
  assert.equal(setup.gateway.store.db.prepare("SELECT COUNT(*) AS count FROM ledger WHERE kind='usage_correction'").get().count, 1);
  const conflict = await setup.call(`/admin/requests/${id}/observations`, { key: adminKey, body: { ...observation, tokens: 9 } }); assert.equal(conflict.status, 400);
  const second = await infer(setup); await second.text(); assert.equal(second.status, 200);
});

test('Unknown physical occupancy blocks bounded routes until an audited explicit resolution', async context => {
  const setup = await fixture(context, { handler: (request, response) => { response.setHeader('content-type', 'text/event-stream'); response.end('data: {}\n\n'); } });
  setup.gateway.config.routes[0].concurrency = 1;
  const first = await infer(setup); await first.text(); const id = first.headers.get('x-router4u-request-id');
  assert.equal(setup.gateway.store.request(id).occupancy, 'uncertain');
  assert.equal((await infer(setup)).status, 429);
  assert.equal((await setup.call(`/admin/requests/${id}/release-occupancy`, { key: adminKey, body: { reason: 'Backend process stopped and verified' } })).status, 200);
  assert.equal(setup.gateway.store.status('alpha').reserved_tokens, 4096);
  const second = await infer(setup); await second.text(); assert.equal(second.status, 200);
});

test('History pagination covers more than 200 records without cross-project disclosure', async context => {
  const setup = await fixture(context);
  const store = setup.gateway.store; const principal = store.authenticate(setup.alpha.key);
  store.putProject('alpha', { routes: ['local'], requests_per_minute: 1000 });
  for (let index = 0; index < 205; index++) { const record = store.admit(principal, setup.gateway.config.routes[0], 'responses', setup.gateway.config); store.settle(record.id, { total: 0, source: 'fixture' }, { execution: 'completed' }); }
  const first = await (await setup.call('/v1/history?limit=200')).json(); assert.equal(first.items.length, 200);
  const second = await (await setup.call(`/v1/history?limit=200&cursor=${first.next_cursor}`)).json(); assert.equal(second.items.length, 5); assert.equal(second.next_cursor, null);
  assert.equal((await (await setup.call('/v1/history', { key: setup.beta.key })).json()).items.length, 0);
  assert.equal((await setup.call('/v1/history?limit=100000')).status, 400);
});

test('Retention expires only completed payloads and leaves accounting and audit records', async context => {
  const setup = await fixture(context, { policy: { retention_days: 1 } });
  const response = await infer(setup); await response.text(); const id = response.headers.get('x-router4u-request-id');
  const created = setup.gateway.store.request(id).created;
  setup.gateway.store.clock = () => created + 86400001;
  assert.equal(setup.gateway.store.expireCaptures().expired, 1);
  assert.equal(setup.gateway.store.captured(id).manifest.state, 'expired');
  assert.equal(setup.gateway.store.captured(id).chunks.length, 0);
  assert.equal(setup.gateway.store.request(id).usage.total, 15);
  assert.equal(setup.gateway.store.expireCaptures().expired, 0);
});

test('Project archive quota and service token rate are enforced independently', async context => {
  const setup = await fixture(context, { policy: { archive_max_bytes: 1 } });
  assert.equal((await infer(setup)).status, 507); assert.equal(setup.backend.calls.length, 0);
  const rate = await fixture(context, { config: { tokens_per_minute: 4096 } });
  const first = await infer(rate); await first.text();
  assert.equal((await rate.call('/v1/responses', { key: rate.beta.key, body: payload })).status, 429);
});

test('Full installation backup restores inert credentials, payloads, ledger and reservations; tampering is rejected', async context => {
  const setup = await fixture(context);
  const response = await infer(setup); await response.text();
  const configuration = join(setup.directory, 'config.json'); const backend = join(setup.directory, 'backend.yaml'); const env = join(setup.directory, '.env'); const auth = join(setup.directory, 'auth');
  writeFileSync(configuration, JSON.stringify(setup.gateway.config)); writeFileSync(backend, 'config-version: 8'); writeFileSync(env, 'INERT=test-only'); mkdirSync(auth); writeFileSync(join(auth, 'inert.json'), '{"refresh_token":"inert-test-value"}');
  const dest = join(setup.directory, 'bundle');
  await backupInstallation(setup.gateway.store, { destination: dest, configPath: configuration, backendConfig: backend, authDirectory: auth, environmentFile: env });
  const restored = join(setup.directory, 'restored'); restoreInstallation(dest, restored);
  assert.match(readFileSync(join(restored, 'auth/inert.json'), 'utf8'), /inert-test-value/);
  const store = new Store(join(restored, 'data')); assert.equal(store.status('alpha').settled_tokens, 15); store.close();
  assert.throws(() => restoreInstallation(dest, restored), /must not exist/);
  writeFileSync(join(dest, 'auth/inert.json'), 'tampered');
  assert.throws(() => restoreInstallation(dest, join(setup.directory, 'bad')), /integrity/);
  assert.equal(existsSync(join(setup.directory, 'bad')), false);
});

test('Schema upgrade preserves v1 identities and rejects unsupported downgrade; legacy keys lose export scope', async context => {
  const setup = await fixture(context); const dir = join(setup.directory, 'migration');
  let store = new Store(dir); store.putProject('legacy', { routes: ['local'] }); const issued = store.issueKey('legacy');
  store.db.exec('DROP TABLE principal_scopes; PRAGMA user_version=1'); store.close();
  store = new Store(dir); assert.deepEqual(store.authenticate(issued.key).scopes, DEFAULT_SCOPES); assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2); store.close();
  const db = new DatabaseSync(join(dir, 'router4u.sqlite')); db.exec('PRAGMA user_version=999'); db.close();
  assert.throws(() => new Store(dir), /newer/);
});

test('PID reuse after container restart does not preserve a stale lock', async context => {
  const setup = await fixture(context); const dir = join(setup.directory, 'locking'); mkdirSync(dir);
  writeFileSync(join(dir, 'service.lock'), JSON.stringify({ pid: process.pid, start: 'previous-boot:1' }));
  const unlock = lockDirectory(dir); assert.throws(() => lockDirectory(dir), /in use/); unlock();
});

test('New budgets count earlier traffic and budget edits cannot change historical identity', async context => {
  const setup = await fixture(context); const response = await infer(setup); await response.text();
  const policy = { routes: ['local'], budgets: [{ id: 'month', resource: 'tokens', period: 'month', limit: 15 }] };
  setup.gateway.store.putProject('alpha', policy);
  assert.equal((await infer(setup)).status, 429);
  assert.throws(() => setup.gateway.store.putProject('alpha', { ...policy, budgets: [{ ...policy.budgets[0], period: 'day' }] }), /immutable/);
  assert.equal(setup.gateway.store.project('alpha').policy.budgets[0].period, 'month');
});

test('Credential refresh delegates once and strips token-bearing backend results', async context => {
  const { BackendManagement } = await import('../src/backend.js');
  const { fakeProvider } = await import('./helpers.js');
  const provider = await fakeProvider((request, response, body) => {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v8/management/credentials/refresh'); assert.deepEqual(body, { name: 'owner.json' });
    response.end(JSON.stringify({ ok: true, auth: { refresh_token: 'inert-never-return', access_token: 'inert-never-return' } }));
  }); context.after(() => provider.close());
  const adapter = new BackendManagement({ base_url: provider.url, management_key_env: 'KEY' }, { KEY: 'inert' });
  const result = await adapter.credentialAction('owner.json', 'refresh');
  assert.equal(result.completed, true); assert.equal(provider.calls.length, 1); assert.doesNotMatch(JSON.stringify(result), /inert-never-return/);
});

test('Rolling budgets use admission time while calendar bookings survive month rollover', async context => {
  const setup = await fixture(context); const store = setup.gateway.store;
  let now = Date.parse('2026-01-31T23:59:59Z'); store.clock = () => now;
  store.putProject('alpha', { routes: ['local'], budgets: [{ id: 'rolling', resource: 'requests', period: 'rolling', duration_ms: 1000, limit: 1, mode: 'strict' }, { id: 'calendar', resource: 'tokens', period: 'month', limit: 10000 }] });
  const principal = store.authenticate(setup.alpha.key);
  const first = store.admit(principal, setup.gateway.config.routes[0], 'responses', setup.gateway.config);
  assert.throws(() => store.admit(principal, setup.gateway.config.routes[0], 'responses', setup.gateway.config), /exhausted/);
  now += 1001; store.settle(first.id, { total: 15, source: 'fixture' }, { execution: 'completed' });
  assert.equal(store.db.prepare("SELECT period FROM budget_bookings WHERE request_id=? AND budget_id='calendar'").get(first.id).period, '2026-01');
  assert.equal(store.status('alpha').additional_budgets.find(item => item.id === 'calendar').remaining, 10000);
  assert.ok(store.admit(principal, setup.gateway.config.routes[0], 'responses', setup.gateway.config));
});

test('Correlation metadata remains bounded diagnostics and cannot change the accounting owner', async context => {
  const setup = await fixture(context);
  const response = await setup.call('/v1/responses', { body: payload, headers: { 'x-correlation-ref': 'beta', 'x-installation-id': 'instance-2' } }); await response.text();
  const record = setup.gateway.store.request(response.headers.get('x-router4u-request-id'));
  assert.equal(record.project_id, 'alpha'); assert.equal(record.correlation_ref, 'beta'); assert.equal(record.installation_id, 'instance-2');
  assert.equal((await setup.call('/v1/responses', { body: payload, headers: { 'x-correlation-ref': 'x'.repeat(257) } })).status, 400);
});

test('Passive quota snapshots retain source time and filter nonquota credential fields', async context => {
  const { BackendManagement } = await import('../src/backend.js'); const { fakeProvider } = await import('./helpers.js');
  const provider = await fakeProvider((request, response) => response.end(JSON.stringify({ files: [{ name: 'owner.json', quota: { observed_at: '2026-01-01T00:00:00Z', signals: { 'X-Codex-Primary-Used-Percent': '12', Authorization: 'inert-secret', 'X-Codex-Turn-State': 'inert-secret' } }, refresh_token: 'inert-secret' }] })));
  context.after(() => provider.close());
  const metadata = await new BackendManagement({ base_url: provider.url, management_key_env: 'KEY' }, { KEY: 'inert' }).credentials();
  assert.equal(metadata[0].quota.observed_at, '2026-01-01T00:00:00Z'); assert.equal(metadata[0].quota.signals['X-Codex-Primary-Used-Percent'], '12');
  assert.doesNotMatch(JSON.stringify(metadata), /inert-secret/);
});

test('Global archive edits affect new admissions without mutating existing capture snapshots', async context => {
  const setup = await fixture(context); const store = setup.gateway.store; const principal = store.authenticate(setup.alpha.key);
  const config = setup.gateway.config;
  const first = store.admit(principal, config.routes[0], 'responses', config);
  const next = { ...config, archive_max_bytes: 1 }; store.archiveMaxBytes = 1;
  assert.doesNotThrow(() => store.append(first.id, 'request', Buffer.from('older admitted body')));
  const second = store.admit(principal, next.routes[0], 'responses', next);
  assert.throws(() => store.append(second.id, 'request', Buffer.from('new body')), /capacity exhausted/);
});

test('Observable-attempt budgets release reservations for work that never dispatches', async context => {
  const setup = await fixture(context, { policy: { budgets: [{ id: 'attempts', resource: 'observed_attempts', period: 'day', limit: 1 }] } });
  const store = setup.gateway.store; const principal = store.authenticate(setup.alpha.key); const config = setup.gateway.config;
  const first = store.admit(principal, config.routes[0], 'responses', config);
  store.settle(first.id, { total: 0, source: 'not_dispatched' }, { execution: 'failed' });
  const second = store.admit(principal, config.routes[0], 'responses', config); store.dispatch(second.id, 'test-model');
  store.settle(second.id, null, { execution: 'outcome_unknown' });
  assert.equal(store.status('alpha').additional_budgets[0].settled, 1);
  assert.throws(() => store.admit(principal, config.routes[0], 'responses', config), /exhausted/);
});
