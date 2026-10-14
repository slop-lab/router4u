import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { backup } from 'node:sqlite';
import { Store } from '../src/store.js';
import { validateConfig } from '../src/config.js';
import { lockDirectory } from '../src/lock.js';
import { BackendManagement } from '../src/backend.js';
import { fakeProvider, fixture, event, completedResponse } from './helpers.js';

function temporary(context) {
  const path = mkdtempSync(join(tmpdir(), 'router4u-operations-'));
  context.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
const route = { id: 'local', profile: 'api_key', models: ['test-model'], protocols: ['responses'], base_url: 'http://127.0.0.1:1/v1', key_env: 'KEY' };
const payload = { model: 'test-model', input: [], stream: true, store: false };

test('SIGKILL after dispatch retains reservations and never replays inference', async context => {
  const directory = temporary(context);
  const source = `import {Store} from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};
    import {validateConfig} from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)};
    const store = new Store(${JSON.stringify(directory)});
    const route = ${JSON.stringify(route)};
    store.putProject('project', {routes:['local']});
    const principal = store.authenticate(store.issueKey('project').key);
    const record = store.admit(principal, route, 'responses', validateConfig({routes:[route]}));
    store.append(record.id,'request',Buffer.from('original request'));
    store.dispatch(record.id,'test-model');
    process.send(record.id);
    setInterval(() => {},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  context.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const [id] = await once(child, 'message');
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
  const store = new Store(directory);
  context.after(() => store.close());
  assert.equal(store.recover(), 1);
  assert.equal(store.request(id).execution, 'outcome_unknown');
  assert.equal(store.status('project').reserved_tokens, 4096);
  assert.equal(store.captured(id).chunks.length, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM ledger WHERE kind='dispatch_intent'").get().count, 1);
});

test('SQLite backup restores payload integrity and unresolved accounting', async context => {
  const directory = temporary(context);
  const restoredDirectory = temporary(context);
  const store = new Store(directory);
  store.putProject('project', { routes: ['local'] });
  const principal = store.authenticate(store.issueKey('project').key);
  const record = store.admit(principal, route, 'responses', validateConfig({ routes: [route] }));
  store.append(record.id, 'request', Buffer.from('sk-inert-test-only <script>no execution</script>'));
  store.dispatch(record.id, 'test-model');
  await backup(store.db, join(restoredDirectory, 'router4u.sqlite'));
  store.close();
  const restored = new Store(restoredDirectory);
  context.after(() => restored.close());
  restored.recover();
  assert.equal(restored.request(record.id).accounting, 'reconciliation_required');
  assert.equal(Buffer.from(restored.captured(record.id).chunks[0].payload, 'base64').toString(), 'sk-inert-test-only <script>no execution</script>');
  restored.db.prepare('UPDATE chunks SET payload=?').run(Buffer.from('corrupt'));
  assert.throws(() => restored.captured(record.id), /integrity/);
});

test('State directory rejects a second active owner and recovers a stale lock', context => {
  const directory = temporary(context);
  const unlock = lockDirectory(directory);
  assert.throws(() => lockDirectory(directory), /in use/);
  unlock();
  writeFileSync(join(directory, 'service.lock'), '2147483647');
  lockDirectory(directory)();
});

test('Management metadata strips credentials and OAuth callback rejects external URLs', async context => {
  const upstream = await fakeProvider((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ files: [{ name: 'owner.json', provider: 'codex', access_token: 'never-return-this', refresh_token: 'never-return-this', status: 'active' }] }));
  });
  context.after(() => upstream.close());
  const backend = new BackendManagement({ base_url: upstream.url, management_key_env: 'KEY' }, { KEY: 'test' });
  assert.doesNotMatch(JSON.stringify(await backend.credentials()), /never-return/);
  assert.throws(() => backend.callback('https://untrusted.example/auth/callback?code=secret&state=test'), /loopback/);
});

test('Global budget competes across projects; estimate overage blocks later work', async context => {
  const setup = await fixture(context, { config: { daily_tokens: 4096 }, policy: { token_estimate: 4096 } });
  const first = await setup.call('/v1/responses', { body: payload });
  await first.text();
  const second = await setup.call('/v1/responses', { body: payload, key: setup.beta.key });
  assert.equal(second.status, 429);
});

test('Early stream EOF preserves the wire bytes but marks execution and accounting unknown', async context => {
  const setup = await fixture(context, { handler(request, response) { response.setHeader('content-type', 'text/event-stream'); response.end(event({ type: 'response.output_text.delta', delta: 'partial' })); } });
  const response = await setup.call('/v1/responses', { body: payload });
  await response.text();
  const record = setup.gateway.store.request(response.headers.get('x-router4u-request-id'));
  assert.equal(record.capture, 'complete');
  assert.equal(record.execution, 'outcome_unknown');
  assert.equal(record.accounting, 'reconciliation_required');
});

test('Terminal provider failure after partial text stays distinct from successful HTTP delivery', async context => {
  const setup = await fixture(context, { handler(request, response) {
    response.setHeader('content-type', 'text/event-stream');
    response.end(event({ type: 'response.output_text.delta', delta: 'partial' }) + event({ type: 'response.failed', response: { ...completedResponse(), status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded' } } }));
  } });
  const response = await setup.call('/v1/responses', { body: payload });
  assert.equal(response.status, 200);
  await response.text();
  const record = setup.gateway.store.request(response.headers.get('x-router4u-request-id'));
  assert.equal(record.execution, 'failed');
  assert.equal(record.delivery, 'complete');
  assert.equal(record.usage.total, 15);
});
