import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createGateway } from '../src/server.js';
import { fakeProvider } from '../test/helpers.js';
import { lockDirectory } from '../src/lock.js';

const directory = resolve('.runtime/demo');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const unlock = lockDirectory(directory);
const backend = await fakeProvider();
const adminKey = randomBytes(32).toString('base64url');
const gateway = createGateway({ data_dir: directory, routes: [{ id: 'demo', profile: 'api_key', base_url: backend.url,
  key_env: 'DEMO_BACKEND_KEY', models: ['test-model'], protocols: ['responses', 'chat'] }] }, {
  environment: { ROUTER4U_ADMIN_KEY: adminKey, DEMO_BACKEND_KEY: 'inert-demo-key' },
});
for (const project of ['alpha', 'beta']) if (!gateway.store.project(project)) gateway.store.putProject(project, { routes: ['demo'] });
const alpha = gateway.store.issueKey('alpha');
const beta = gateway.store.issueKey('beta');
writeFileSync('.runtime/demo.env', `ROUTER4U_ADMIN_KEY=${adminKey}\nALPHA_KEY=${alpha.key}\nBETA_KEY=${beta.key}\n`, { mode: 0o600 });
console.log(`Offline demo listening at ${await gateway.listen()}`);
console.log('Keys are in .runtime/demo.env. No external provider is contacted. See README.md for requests.');
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await backend.close(); await gateway.close(); unlock(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
