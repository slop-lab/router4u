import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const repository = resolve('.'); const directory = mkdtempSync(join(tmpdir(), 'router4u-compose-')); const runtime = join(directory, '.runtime');
const project = `router4u-test-${process.pid}`;
const nodeImage = 'node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df';
symlinkSync(join(repository, '.tools'), join(directory, '.tools'));
execFileSync(process.execPath, [join(repository, 'scripts/setup-docker.js')], { cwd: directory, stdio: 'pipe' });
const backendPath = join(runtime, 'cliproxyapi.yaml'); const backend = JSON.parse(readFileSync(backendPath, 'utf8'));
backend['api-keys'] = { codex: [{ name: 'inert-fixture', 'base-url': 'http://fake:8899/v1', keys: [{ 'api-key': 'inert-provider-key' }], models: [{ name: 'test-model', alias: 'test-model' }] }] };
writeFileSync(backendPath, JSON.stringify(backend));
execFileSync(process.execPath, [join(repository, 'scripts/add-partition.js'), 'extra'], { cwd: directory, stdio: 'pipe' });
const extraBackend = JSON.parse(readFileSync(join(runtime, 'partitions/extra/cliproxyapi.yaml'), 'utf8'));
assert.equal(extraBackend['api-keys'], undefined);
const override = join(directory, 'compose-test.json');
writeFileSync(override, JSON.stringify({ services: {
  fake: { image: nodeImage, command: ['node', '/fixture.js'], volumes: [`${repository}/test/docker-provider.js:/fixture.js:ro`], networks: ['infrastructure'], read_only: true },
  'project-a': { image: nodeImage, command: ['node', '-e', 'setInterval(()=>{},1000)'], networks: ['applications'], read_only: true },
  'project-b': { image: nodeImage, command: ['node', '-e', 'setInterval(()=>{},1000)'], networks: ['applications'], read_only: true },
}, networks: { applications: { internal: true }, infrastructure: { internal: true } } }));
const environment = { ...process.env, ROUTER4U_RUNTIME_DIR: runtime, ROUTER4U_RESTORE_DIR: join(runtime, 'restores'), ROUTER4U_UID: String(process.getuid()), ROUTER4U_GID: String(process.getgid()), ROUTER4U_PORT: '0' };
const composeArgs = ['compose', '-p', project, '-f', join(repository, 'compose.yaml'), '-f', join(runtime, 'partitions.compose.yaml'), '-f', override];
const compose = (args, input) => execFileSync('docker', [...composeArgs, ...args], { env: environment, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 });
const cli = (...args) => JSON.parse(compose(['exec', '-T', 'gateway', 'node', '/app/src/cli.js', ...args]));
async function waitReady() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { compose(['exec', '-T', 'gateway', 'node', '-e', "fetch('http://127.0.0.1:9470/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]); return; } catch {}
    await delay(250);
  }
  throw new Error('Gateway did not become ready');
}
const client = (service, key, path, body) => JSON.parse(compose(['exec', '-T', service, 'node', '--input-type=module', '-e', `const r=await fetch('http://gateway:9470'+${JSON.stringify(path)},{method:${JSON.stringify(body ? 'POST' : 'GET')},headers:{authorization:'Bearer '+${JSON.stringify(key)},'content-type':'application/json'},body:${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'}});console.log(JSON.stringify({status:r.status,id:r.headers.get('x-router4u-request-id'),body:await r.text()}));`]));
try {
  compose(['up', '-d', '--no-build', 'gateway', 'backend', 'backend-extra', 'fake', 'project-a', 'project-b']);
  await waitReady();
  for (let attempt = 0; attempt < 60; attempt++) { try { cli('models', '--route', 'personal'); break; } catch (error) { if (attempt === 59) throw error; await delay(250); } }
  const initial = cli('api', '/admin/config');
  assert.deepEqual(initial.config.routes[0].models, []); assert.equal(initial.config.routes[0].enabled, false);
  assert.deepEqual(initial.config.routes[1].models, []); assert.equal(initial.config.routes[1].enabled, false);
  const configured = initial.config; delete configured.revision;
  configured.routes[0] = { ...configured.routes[0], profile: 'api_key', enabled: true, models: ['test-model'] };
  compose(['exec', '-T', 'gateway', 'node', '/app/src/cli.js', 'api', '/admin/config', '--method', 'PUT', '--file', '/dev/stdin'], JSON.stringify({ revision: initial.revision, config: configured }));
  // Later file-reload coverage uses the exported active configuration, as documented.
  writeFileSync(join(runtime, 'router4u.json'), JSON.stringify(configured));
  for (const id of ['alpha', 'beta']) cli('project', 'put', id, '--file', '/config/project.json');
  const alpha = cli('project', 'key', 'alpha', '--scopes', 'inference,usage:read,requests:read,requests:cancel,exchange:export');
  const beta = cli('project', 'key', 'beta');
  const body = { model: 'test-model', input: [{ role: 'user', content: 'hello' }], stream: true, store: false };
  const first = client('project-a', alpha.key, '/v1/responses', body); assert.equal(first.status, 200); assert.match(first.body, /response.completed/);
  assert.equal(client('project-b', beta.key, `/v1/requests/${first.id}`).status, 404);
  assert.equal(JSON.parse(client('project-b', beta.key, '/v1/usage').body).settled_tokens, 0);
  assert.equal(JSON.parse(client('project-a', alpha.key, '/v1/usage').body).settled_tokens, 15);
  const backendId = compose(['ps', '-q', 'backend']).trim();
  const inspection = JSON.parse(execFileSync('docker', ['inspect', backendId], { encoding: 'utf8' }))[0];
  const backendIP = Object.values(inspection.NetworkSettings.Networks)[0].IPAddress;
  for (const host of ['backend', backendIP]) {
    const blocked = compose(['exec', '-T', 'project-a', 'node', '-e', `fetch('http://${host}:8317/v1/models',{signal:AbortSignal.timeout(700)}).then(()=>process.exit(1)).catch(()=>console.log('blocked'))`]); assert.match(blocked, /blocked/);
  }
  compose(['up', '-d', '--no-deps', '--force-recreate', 'project-a']);
  assert.equal(JSON.parse(client('project-a', alpha.key, '/v1/usage').body).settled_tokens, 15);
  const configPath = join(runtime, 'router4u.json'); const config = JSON.parse(readFileSync(configPath, 'utf8')); config.routes[0].concurrency = 2; writeFileSync(configPath, JSON.stringify(config));
  assert.equal(cli('reload', '--dry-run').applied, false); assert.equal(cli('reload').applied, true);
  const web = JSON.parse(compose(['exec', '-T', 'gateway', 'node', '--input-type=module'], `
    const base = 'http://127.0.0.1:9470';
    const home = await fetch(base); if (!(await home.text()).includes('Control room')) throw new Error('Web UI missing from image');
    const session = await fetch(base + '/web/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ key: process.env.ROUTER4U_ADMIN_KEY }) });
    const headers = { cookie: session.headers.get('set-cookie').split(';')[0], 'x-csrf-token': (await session.json()).csrf, 'content-type': 'application/json' };
    const snapshot = await (await fetch(base + '/admin/config', { headers })).json();
    delete snapshot.config.revision; snapshot.config.daily_requests = 12345;
    const saved = await fetch(base + '/admin/config', { method: 'PUT', headers, body: JSON.stringify({ revision: snapshot.revision, config: snapshot.config }) });
    console.log(JSON.stringify({ status: saved.status, result: await saved.json() }));
  `));
  assert.equal(web.status, 200); assert.equal(web.result.applied, true);
  // Kill the container during a stream and let unless-stopped restart it automatically.
  const holdingBody = { ...body, input: [{ role: 'user', content: 'hold' }] };
  const pending = spawn('docker', [...composeArgs, 'exec', '-T', 'project-a', 'node', '--input-type=module', '-e', `try {const r=await fetch('http://gateway:9470/v1/responses',{method:'POST',headers:{authorization:'Bearer '+${JSON.stringify(alpha.key)},'content-type':'application/json'},body:${JSON.stringify(JSON.stringify(holdingBody))}});await r.text();} catch {}`], { env: environment, stdio: 'ignore' });
  const discarded = new Promise((done, reject) => { pending.once('error', reject); pending.once('exit', done); });
  let pendingId;
  for (let attempt = 0; attempt < 50; attempt++) { const active = cli('api', '/admin/active'); if (active.length) { pendingId = active[0].id; break; } await delay(100); }
  assert.ok(pendingId);
  console.log('Project isolation, rebuild, and configuration reload passed; testing crash restart.');
  const gatewayId = compose(['ps', '-q', 'gateway']).trim();
  compose(['exec', '-T', 'gateway', 'node', '-e', "const fs=require('node:fs');process.kill(JSON.parse(fs.readFileSync('/state/service.lock','utf8')).pid,'SIGKILL')"]);
  await discarded; await waitReady();
  assert.equal(cli('api', '/admin/config').config.daily_requests, 12345);
  assert.equal(cli('api', '/admin/web-status').configuration_source, 'browser');
  const record = cli('request', pendingId); assert.equal(record.execution, 'outcome_unknown'); assert.equal(record.accounting, 'reconciliation_required'); assert.equal(record.occupancy, 'uncertain');
  assert.equal(cli('usage', 'alpha').settled_tokens, 15);
  const gatewayInspection = JSON.parse(execFileSync('docker', ['inspect', gatewayId], { encoding: 'utf8' }))[0];
  assert.equal(gatewayInspection.HostConfig.RestartPolicy.Name, 'unless-stopped'); assert.ok(gatewayInspection.RestartCount >= 1);
  console.log('Automatic restart and uncertain dispatch recovery passed; testing full backup/restore.');
  cli('release-occupancy', pendingId, '--reason', 'Offline fixture stopped after connection close');
  compose(['stop', 'gateway', 'backend', 'backend-extra']);
  writeFileSync(join(runtime, 'partitions/extra/auth/inert-extra.json'), '{"refresh_token":"inert-extra-credential"}', { mode: 0o600 });
  writeFileSync(join(runtime, 'auth/inert-backup.json'), JSON.stringify({ refresh_token: 'inert-not-a-real-credential' }), { mode: 0o600 });
  compose(['run', '--rm', '--no-deps', 'maintenance', 'backup-installation', '--file', '/backups/check', '--config', '/config/router4u.json', '--backend-config', '/config/cliproxyapi.yaml', '--auth-dir', '/auth', '--env-file', '/config/.env']);
  compose(['run', '--rm', '--no-deps', 'maintenance', 'restore-installation', '--file', '/backups/check', '--destination', '/restores/check']);
  assert.match(readFileSync(join(runtime, 'restores/check/auth/inert-backup.json'), 'utf8'), /inert-not-a-real-credential/);
  assert.match(readFileSync(join(runtime, 'restores/check/partitions/extra/auth/inert-extra.json'), 'utf8'), /inert-extra-credential/);
  const { Store } = await import('../src/store.js');
  const restored = new Store(join(runtime, 'restores/check/data'));
  assert.equal(JSON.parse(restored.db.prepare("SELECT data FROM settings WHERE id='web_configuration'").get().data).daily_requests, 12345);
  assert.equal(restored.request(pendingId).accounting, 'reconciliation_required');
  assert.equal(restored.status('alpha').reserved_tokens, 4096); restored.close();
  console.log('Deployment contracts passed: two projects, network isolation, rebuild, reload, automatic crash restart, durable unknown usage, and full installation backup/restore. No live provider was used.');
} catch (error) {
  process.stderr.write(compose(['logs', '--tail', '50', 'gateway', 'backend']));
  throw error;
} finally {
  try { compose(['down', '--remove-orphans', '--timeout', '5']); } finally { rmSync(directory, { recursive: true, force: true }); }
}
