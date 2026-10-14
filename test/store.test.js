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
