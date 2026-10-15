import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlLogs } from '../src/jsonl.js';
import { fixture } from './helpers.js';
import { migrateJsonl } from '../src/migrate-jsonl.js';
import { Store } from '../src/store.js';

test('JSONL records preserve UTF-8, recover partial tails and keep private permissions', t => {
  const dir = mkdtempSync(join(tmpdir(), 'r4u-jsonl-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logs = new JsonlLogs(dir);
  const message = '안녕🙂'.repeat(20000);
  logs.event('audit', { message });
  appendFileSync(logs.path('audit'), '{"sequence":2');
  assert.deepEqual(logs.rows('audit'), [{ sequence: 1, message }]);
  const reopened = new JsonlLogs(dir); reopened.event('audit', { message: 'next' });
  assert.equal(reopened.rows('audit', 1)[0].sequence, 2);
  assert.equal(statSync(logs.path('audit')).mode & 0o777, 0o600);
  assert.throws(() => logs.request('../secrets'));
});

test('History, raw exchanges and audits are files, and failed transactions produce no audit event', async t => {
  const setup = await fixture(t);
  const store = setup.gateway.store;
  const response = await setup.call('/v1/responses', { body: { model: 'test-model', input: 'JSONL sentinel', store: false } });
  const id = response.headers.get('x-router4u-request-id'); await response.text();
  assert.equal(response.status, 200);
  const names = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  for (const table of ['chunks', 'audit', 'outbox']) assert.ok(!names.includes(table));
  const operational = JSON.parse(store.db.prepare('SELECT data FROM requests WHERE id=?').get(id).data);
  assert.equal(operational.delivery, undefined);
  assert.equal(operational.provider_response_id, undefined);
  assert.equal(store.logs.request(id).delivery, 'complete');
  assert.equal(store.history('alpha').items[0].id, id);
  assert.match(Buffer.from([...store.logs.read(`exchanges/${id}`)][0].payload, 'base64').toString(), /JSONL sentinel/);
  const before = store.logs.rows('audit').length;
  assert.throws(() => store.transaction(() => { store.audit('test', 'rolled-back', 'test'); throw new Error('rollback'); }));
  assert.equal(store.logs.rows('audit').length, before);
  const reservation = store.status('alpha').settled_tokens;
  const append = store.logs.append;
  store.logs.append = () => { throw new Error('disk full'); };
  store.putProject('alpha', { routes: ['local'], daily_requests: 123 });
  assert.equal(store.project('alpha').policy.daily_requests, 123);
  assert.ok(store.metrics().analysis_log_failures > 0);
  assert.equal(store.status('alpha').settled_tokens, reservation);
  store.logs.append = append;
});

test('Stopped schema conversion preserves keys, usage, payloads and audit records', async t => {
  const setup = await fixture(t);
  const store = setup.gateway.store;
  const response = await setup.call('/v1/responses', { body: { model: 'test-model', input: 'Conversion check', store: false } });
  const id = response.headers.get('x-router4u-request-id'); await response.text();
  const record = store.request(id); const exchange = store.captured(id); const audit = store.logs.rows('audit');
  store.db.exec('CREATE TABLE chunks(request_id TEXT,direction TEXT,sequence INTEGER,payload BLOB,hash TEXT,created INTEGER); CREATE TABLE audit(sequence INTEGER,created INTEGER,actor TEXT,operation TEXT,target TEXT,data TEXT); CREATE TABLE outbox(sequence INTEGER,created INTEGER,request_id TEXT,event TEXT)');
  for (const chunk of exchange.chunks) store.db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?,?)').run(id, chunk.direction, chunk.sequence, Buffer.from(chunk.payload, 'base64'), chunk.hash, chunk.created);
  for (const row of audit) store.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?)').run(row.sequence, row.created, row.actor, row.operation, row.target, row.data);
  store.db.prepare('UPDATE requests SET data=? WHERE id=?').run(JSON.stringify(record), id);
  store.db.exec('PRAGMA user_version=2');
  const directory = setup.gateway.config.data_dir;
  await setup.gateway.close();
  setup.gateway.close = async () => {};
  rmSync(join(directory, 'logs'), { recursive: true });
  assert.deepEqual(migrateJsonl(directory), { converted: true, schema: 3 });
  const converted = new Store(directory);
  try {
    assert.equal(converted.authenticate(setup.alpha.key).project_id, 'alpha');
    assert.equal(converted.status('alpha').settled_tokens, 15);
    assert.deepEqual(converted.captured(id).chunks, exchange.chunks);
    assert.equal(converted.request(id).delivery, 'complete');
    assert.equal(converted.logs.rows('audit').length, audit.length);
  } finally { converted.close(); }
});


test('A rolled-back capture append leaves no extra JSONL line', async t => {
  const setup = await fixture(t); const store = setup.gateway.store;
  const principal = store.authenticate(setup.alpha.key);
  const record = store.admit(principal, setup.gateway.config.routes[0], 'responses', setup.gateway.config);
  store.db.exec("CREATE TRIGGER reject_capture BEFORE UPDATE ON captures BEGIN SELECT RAISE(ABORT,'test rejection'); END");
  assert.throws(() => store.append(record.id, 'request', Buffer.from('discarded')), /test rejection/);
  assert.equal([...store.logs.read(`exchanges/${record.id}`)].length, 0);
  store.db.exec('DROP TRIGGER reject_capture');
  store.append(record.id, 'request', Buffer.from('retained'));
  assert.equal(Buffer.from(store.captured(record.id).chunks[0].payload, 'base64').toString(), 'retained');
});
