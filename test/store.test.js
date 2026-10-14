import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { validateConfig, validatePolicy } from '../src/config.js';
import { normalizeUsage, ResponseObserver } from '../src/protocol.js';
import { event, completedResponse } from './helpers.js';

test('Recovery distinguishes undispatched work from ambiguous dispatch across midnight', context => {
  const directory = mkdtempSync(join(tmpdir(), 'router4u-store-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-10-14T23:59:59Z');
  let store = new Store(directory, { clock: () => now });
  const route = { id: 'test', profile: 'api_key', models: ['test-model'], protocols: ['responses'], base_url: 'http://localhost/v1', key_env: 'KEY' };
  const config = validateConfig({ routes: [route] });
  store.putProject('project', { routes: ['test'] });
  const credential = store.issueKey('project');
  const principal = store.authenticate(credential.key);
  const pending = store.admit(principal, route, 'responses', config);
  const dispatched = store.admit(principal, route, 'responses', config);
  store.dispatch(dispatched.id, 'test-model');
  store.close();
  now += 2000;
  store = new Store(directory, { clock: () => now });
  assert.equal(store.recover(), 2);
  assert.equal(store.request(pending.id).usage.total, 0);
  assert.equal(store.request(dispatched.id).execution, 'outcome_unknown');
  assert.equal(store.request(dispatched.id).accounting, 'reconciliation_required');
  assert.equal(store.request(dispatched.id).period, '2026-10-14');
  assert.equal(store.totals('project', '2026-10-14').reserved_tokens, 4096);
  assert.equal(store.recover(), 0);
  store.close();
});

test('Strict token enforcement is explicitly rejected', () => {
  assert.throws(() => validatePolicy({ routes: ['test'], token_mode: 'strict' }), /no verified bound/);
});

test('Usage details are subsets and malformed or conflicting usage remains unknown', () => {
  assert.equal(normalizeUsage(completedResponse().usage).total, 15);
  assert.equal(normalizeUsage({ input_tokens: 1 }), null);
  assert.equal(normalizeUsage({ input_tokens: -1, output_tokens: 3 }), null);
  assert.equal(normalizeUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 100 }), null);
});

test('SSE parser preserves UTF-8 across arbitrary transport boundaries', () => {
  const observer = new ResponseObserver('responses', true, 100000);
  const bytes = Buffer.from(event({ type: 'response.output_text.delta', delta: '안녕 🙂' }) + event({ type: 'response.completed', response: completedResponse() }));
  for (const byte of bytes) observer.push(Buffer.from([byte]));
  observer.finish();
  assert.equal(observer.outcome, 'completed');
  assert.equal(observer.usage.total, 15);
});

test('Unlimited limits retain reservations and still enforce explicit project and service limits', context => {
  const directory = mkdtempSync(join(tmpdir(), 'router4u-unlimited-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory); context.after(() => store.close());
  const route = { id: 'test', profile: 'api_key', models: ['test-model'], protocols: ['responses'], base_url: 'http://localhost/v1', key_env: 'KEY' };
  const unlimited = { concurrency: null, requests_per_minute: null, daily_requests: null, daily_tokens: null };
  const config = validateConfig({ routes: [route], ...unlimited });
  const policy = { routes: ['test'], ...unlimited, token_estimate: 2000000 };
  store.putProject('project', policy);
  const principal = store.authenticate(store.issueKey('project').key);
  for (let index = 0; index < 70; index++) store.admit(principal, route, 'responses', config);
  assert.equal(store.status('project').reserved_tokens, 140000000);
  assert.equal(store.project('project').policy.daily_tokens, null);
  for (const key of Object.keys(unlimited)) {
    store.putProject('project', { ...policy, [key]: 1 });
    assert.throws(() => store.admit(principal, route, 'responses', config), error => error.status === 429);
    store.putProject('project', policy);
    assert.throws(() => store.admit(principal, route, 'responses', { ...config, [key]: 1 }), error => error.status === 429);
  }
  assert.throws(() => store.admit(principal, { ...route, concurrency: 1 }, 'responses', config), error => error.status === 429);
  store.putProject('project', { ...policy, budgets: [{ id: 'daily', resource: 'requests', period: 'day', limit: 1 }] });
  assert.throws(() => store.admit(principal, route, 'responses', config), error => error.status === 429);
});

test('Nullable limits accept positive integers and null while omitted fields retain defaults', () => {
  const route = { id: 'test', profile: 'api_key', models: ['test-model'], protocols: ['responses'], base_url: 'http://localhost/v1', key_env: 'KEY' };
  for (const key of ['concurrency', 'requests_per_minute', 'daily_requests', 'daily_tokens']) {
    for (const value of [null, 1]) {
      assert.equal(validatePolicy({ routes: ['test'], [key]: value })[key], value);
      assert.equal(validateConfig({ routes: [route], [key]: value })[key], value);
    }
    for (const value of [0, -1, 1.5, '', 'unlimited', false]) {
      assert.throws(() => validatePolicy({ routes: ['test'], [key]: value }));
      assert.throws(() => validateConfig({ routes: [route], [key]: value }));
    }
  }
  assert.equal(validatePolicy({ routes: ['test'] }).concurrency, 4);
  assert.equal(validateConfig({ routes: [route] }).concurrency, 32);
});
