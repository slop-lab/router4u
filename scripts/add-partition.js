import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
process.umask(0o077);
const [id, model, profile = 'codex'] = process.argv.slice(2);
if (!/^[a-z][a-z0-9-]{0,31}$/.test(id ?? '') || !model || !['codex', 'api_key'].includes(profile)) throw new Error('Usage: add-partition.sh ID MODEL [codex|api_key]');
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
config.routes.push({ id, profile, models: [model], protocols: profile === 'api_key' ? ['responses', 'chat'] : ['responses'], base_url: `http://backend-${id}:8317/v1`, key_env: keyName, management_key_env: managementName, concurrency: 4 });
for (const [file, content] of [['.runtime/.env', env + `\n${keyName}=${backendKey}\n${managementName}=${management}\n`], [composePath, JSON.stringify(compose, null, 2) + '\n'], ['.runtime/router4u.json', JSON.stringify(config, null, 2) + '\n']]) {
  writeFileSync(file + '.pending', content); renameSync(file + '.pending', file);
}
console.log(`Created isolated backend-${id}. Run ./router4u up -d --build, then ./router4u cli auth codex --route ${id}. Review and grant the route to selected projects.`);
