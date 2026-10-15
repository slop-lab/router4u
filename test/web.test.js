import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, adminKey } from './helpers.js';
import { createGateway } from '../src/server.js';

test('browser assets, login, CSRF, logout, and project credentials stay isolated', async t => {
  const f = await fixture(t);
  const home = await fetch(f.url);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await home.text(), /Control room/);
  assert.equal((await fetch(f.url + '/admin/projects')).status, 401);
  const cross = await fetch(f.url + '/web/session', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ key: adminKey }) });
  assert.equal(cross.status, 403);
  const login = await fetch(f.url + '/web/session', { method: 'POST', headers: { origin: f.url, 'content-type': 'application/json' }, body: JSON.stringify({ key: adminKey }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const { csrf } = await login.json();
  assert.equal((await fetch(f.url + '/admin/projects', { headers: { cookie } })).status, 403);
  const headers = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };
  assert.equal((await fetch(f.url + '/admin/projects', { headers })).status, 200);
  assert.equal((await fetch(f.url + '/admin/projects', { headers: { ...headers, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.call('/admin/projects')).status, 401);
  for (const id of ['my app', 'my.app', '프로젝트', 'bad/id', 'x'.repeat(65)]) {
    const invalid = await fetch(f.url + '/admin/projects/' + encodeURIComponent(id), { method: 'PUT', headers, body: JSON.stringify({ routes: ['local'] }) });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error.message, /Project ID must contain/);
    assert.equal(f.gateway.store.project(id), null);
  }
  const create = await fetch(f.url + '/admin/projects/browser-app', { method: 'PUT', headers, body: JSON.stringify({ routes: ['local'] }) });
  assert.equal(create.status, 200);
  const issued = await fetch(f.url + '/admin/projects/browser-app/keys', { method: 'POST', headers, body: '{}' });
  const key = await issued.json();
  assert.match(key.key, /^r4u_/);
  const principals = await (await fetch(f.url + '/admin/principals', { headers })).json();
  assert.ok(principals.some(p => p.id === key.principal_id));
  assert.ok(principals.every(p => !('hash' in p) && !('key' in p)));
  assert.equal((await fetch(f.url + '/web/session', { method: 'DELETE', headers })).status, 200);
  assert.equal((await fetch(f.url + '/admin/projects', { headers })).status, 401);
});

test('browser config is validated, conflict checked, and restored from persistent state', async t => {
  const f = await fixture(t);
  const snapshot = await (await f.call('/admin/config', { key: adminKey })).json();
  const { revision, ...config } = snapshot.config;
  const candidate = { ...config, daily_requests: 4567 };
  const put = body => f.call('/admin/config', { key: adminKey, method: 'PUT', body });
  assert.equal((await put({ config: { ...candidate, routes: [{ ...candidate.routes[0], profile: 'unsupported' }] }, revision })).status, 400);
  assert.equal(f.gateway.config.routes[0].profile, config.routes[0].profile);
  assert.equal((await put({ config: candidate, revision: 'stale' })).status, 409);
  assert.equal((await put({ config: { ...candidate, port: 5555 }, revision })).status, 400);
  assert.equal((await put({ config: candidate, revision, dry_run: true })).status, 200);
  assert.equal(f.gateway.config.daily_requests, config.daily_requests);
  assert.equal((await put({ config: candidate, revision })).status, 200);
  assert.equal(f.gateway.config.daily_requests, 4567);
  assert.equal((await put({ config: candidate, revision })).status, 409);
  // Open another Store on the same persisted database to exercise startup configuration.
  const restarted = createGateway(config, { environment: { ROUTER4U_ADMIN_KEY: adminKey }, loadConfig: () => config });
  assert.equal(restarted.config.daily_requests, 4567);
  assert.equal(restarted.reload(true).applied, false);
  assert.ok(restarted.store.db.prepare("SELECT data FROM settings WHERE id='web_configuration'").get());
  assert.equal(restarted.reload().applied, true);
  assert.equal(restarted.config.daily_requests, config.daily_requests);
  assert.equal(restarted.store.db.prepare("SELECT data FROM settings WHERE id='web_configuration'").get(), undefined);
  await restarted.listen(); await restarted.close();
});

test('invalid credentials are bounded by a login attempt limit', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 20; i++) assert.equal((await fetch(f.url + '/web/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"key":"wrong"}' })).status, 401);
  assert.equal((await fetch(f.url + '/web/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: adminKey }) })).status, 429);
});
