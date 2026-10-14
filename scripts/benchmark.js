import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../src/server.js';
import { setTimeout as delay } from 'node:timers/promises';
import { fakeProvider, responseEvents, event } from '../test/helpers.js';
const directory = mkdtempSync(join(tmpdir(), 'router4u-benchmark-'));
const upstream = await fakeProvider(async (request, response, body) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const events = responseEvents(body.model); response.write(event(events.shift()));
  if (body.input === 'cancel-fixture') {
    await new Promise(done => { const timer = setTimeout(done, 1000); response.once('close', () => { clearTimeout(timer); done(); }); });
  }
  if (!response.destroyed) { for (const item of events) response.write(event(item)); response.end(); }
});
const gateway = createGateway({ data_dir: directory, port: 0, routes: [{ id: 'local', profile: 'api_key', base_url: upstream.url, key_env: 'KEY', models: ['test-model'], protocols: ['responses'] }] }, { environment: { ROUTER4U_ADMIN_KEY: 'inert-benchmark-operator-credential', KEY: 'inert' } });
gateway.store.putProject('benchmark', { routes: ['local'], requests_per_minute: 10000 });
const key = gateway.store.issueKey('benchmark').key; const base = await gateway.listen();
const body = JSON.stringify({ model: 'test-model', input: [], stream: true, store: false });
async function measure(url, authorization, cancel = false) {
  const durations = [];
  for (let index = 0; index < 50; index++) {
    const started = performance.now(); const controller = new AbortController();
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${authorization}`, 'content-type': 'application/json' }, body: cancel ? JSON.stringify({ model: 'test-model', input: 'cancel-fixture', stream: true, store: false }) : body, signal: controller.signal });
    if (cancel) { const reader = response.body.getReader(); await reader.read(); controller.abort(); await reader.cancel().catch(() => {}); }
    else { if (!response.ok) throw new Error(`Benchmark request failed: ${response.status}`); await response.text(); }
    durations.push(performance.now() - started);
  }
  durations.sort((a, b) => a - b);
  return { requests: durations.length, median_ms: durations[25], p95_ms: durations[47] };
}
try {
  const direct = await measure(upstream.url + '/responses', 'inert');
  const recorded = await measure(base + '/v1/responses', key);
  const cancellation = await measure(base + '/v1/responses', key, true);
  for (let attempt = 0; gateway.active.size && attempt < 100; attempt++) await delay(10);
  console.log(JSON.stringify({ environment: { node: process.version, platform: process.platform, arch: process.arch }, direct_fake_provider: direct, required_capture_gateway: recorded, cancellation,
    median_increment_ms: recorded.median_ms - direct.median_ms, metrics: gateway.store.metrics(), qualification: 'Local sequential synthetic workload; not a provider latency or production throughput guarantee.' }, null, 2));
} finally { await upstream.close(); await gateway.close(); rmSync(directory, { recursive: true, force: true }); }
