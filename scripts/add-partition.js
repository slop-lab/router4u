import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
process.umask(0o077);
const { values, positionals } = parseArgs({ allowPositionals: true, options: { profile: { type: 'string', default: 'codex' }, help: { type: 'boolean' } } });
if (values.help) { console.log('Usage: sh scripts/add-partition.sh ID [--profile codex|api_key]\nPrepare an isolated backend. Select models in the web UI after connecting the account.'); process.exit(0); }
const [id] = positionals, profile = values.profile;
if (positionals.length !== 1 || !/^[a-z][a-z0-9-]{0,31}$/.test(id ?? '') || !['codex', 'api_key'].includes(profile)) throw new Error('Usage: add-partition.sh ID [--profile codex|api_key]. Models are selected in the web UI.');
const config = JSON.parse(readFileSync('.runtime/router4u.json', 'utf8'));
if (config.routes.some(route => route.id === id)) throw new Error('Route already exists');
const keyName = `ROUTER4U_${id.toUpperCase().replaceAll('-', '_')}_BACKEND_KEY`; const managementName = `${keyName}_MANAGEMENT`;
const env = readFileSync('.runtime/.env', 'utf8');
if (env.includes(`${keyName}=`)) throw new Error('Partition environment name already exists');
const path = `.runtime/partitions/${id}`;
if (existsSync(path)) throw new Error('Partition already exists; inspect it before retrying');
const backendKey = randomBytes(32).toString('base64url'); const management = randomBytes(32).toString('base64url');
const backend = JSON.parse(readFileSync('.runtime/cliproxyapi.yaml', 'utf8'));
// Each generated partition starts with no copied provider keys or credentials.
delete backend['api-keys']; backend.access = { 'api-keys': [backendKey] }; backend.management['secret-key'] = management; backend.oauth['auth-dir'] = '/auth';
mkdirSync(`${path}/auth`, { recursive: true, mode: 0o700 });
writeFileSync(`${path}/cliproxyapi.yaml`, JSON.stringify(backend, null, 2) + '\n');
const composePath = '.runtime/partitions.compose.yaml';
const compose = existsSync(composePath) ? JSON.parse(readFileSync(composePath, 'utf8')) : { services: {} };
compose.services[`backend-${id}`] = { extends: { file: './compose.yaml', service: 'backend' }, volumes: [
  `\${ROUTER4U_RUNTIME_DIR:-./.runtime}/partitions/${id}/cliproxyapi.yaml:/config/cliproxyapi.yaml:ro`,
  `\${ROUTER4U_RUNTIME_DIR:-./.runtime}/partitions/${id}/auth:/auth`,
] };
config.routes.push({ id, profile, enabled: false, models: [], protocols: profile === 'api_key' ? ['responses', 'chat'] : ['responses'], base_url: `http://backend-${id}:8317/v1`, key_env: keyName, management_key_env: managementName, concurrency: 4 });
for (const [file, content] of [['.runtime/.env', env + `\n${keyName}=${backendKey}\n${managementName}=${management}\n`], [composePath, JSON.stringify(compose, null, 2) + '\n'], ['.runtime/router4u.json', JSON.stringify(config, null, 2) + '\n']]) {
  writeFileSync(file + '.pending', content); renameSync(file + '.pending', file);
}
console.log(`Created isolated backend-${id}. Run ./router4u up -d --build, then connect and configure ${id} in the web UI. No models are preselected; inference is disabled. If browser settings are active, add this route in Connections as described in docs/docker.md before login.`);
