import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
process.umask(0o077);
const model = process.argv[2];
const profile = process.argv[3] ?? 'codex';
if (!model || !['codex', 'api_key'].includes(profile)) throw new Error('Usage: setup-docker.sh MODEL [codex|api_key]');
for (const path of ['.runtime/.env', '.runtime/router4u.json', '.runtime/cliproxyapi.yaml']) if (existsSync(path)) throw new Error('Runtime already exists; refusing to overwrite it. See docs/docker.md for migration.');
if (!existsSync('.tools/backend-lock.json')) await import('./install-backend.js');
const lock = JSON.parse(readFileSync('.tools/backend-lock.json', 'utf8'));
if (lock.version !== '8.0.28' || lock.archive_sha256 !== '7d41095b7daaf61ea29cdcc691c238acda4da352acf8babe3f8d8720595f7d35' || createHash('sha256').update(readFileSync('.tools/cli-proxy-api')).digest('hex') !== lock.binary_sha256) throw new Error('Pinned backend integrity check failed; reinstall the backend');
for (const path of ['.runtime', '.runtime/auth', '.runtime/data', '.runtime/backups', '.runtime/restores']) mkdirSync(path, { recursive: true, mode: 0o700 });
const admin = randomBytes(32).toString('base64url'); const backend = randomBytes(32).toString('base64url'); const management = randomBytes(32).toString('base64url');
writeFileSync('.runtime/.env', `ROUTER4U_ADMIN_KEY=${admin}\nROUTER4U_BACKEND_KEY=${backend}\nROUTER4U_BACKEND_MANAGEMENT_KEY=${management}\n`);
writeFileSync('.runtime/compose.env', `ROUTER4U_UID=${process.getuid()}\nROUTER4U_GID=${process.getgid()}\n`);
writeFileSync('.runtime/router4u.json', JSON.stringify({ host: '0.0.0.0', port: 9470, data_dir: '/state', allow_private_http: true,
  accounts: [], routes: [{ id: 'personal', profile, models: [model], protocols: profile === 'api_key' ? ['responses', 'chat'] : ['responses'],
    base_url: 'http://backend:8317/v1', key_env: 'ROUTER4U_BACKEND_KEY', management_key_env: 'ROUTER4U_BACKEND_MANAGEMENT_KEY', concurrency: 4 }] }, null, 2) + '\n');
writeFileSync('.runtime/project.json', JSON.stringify({ routes: ['personal'], recording: 'required', retention_days: 30, archive_max_bytes: 536870912 }, null, 2) + '\n');
// JSON is valid YAML and avoids interpolation of credential material by a template engine.
writeFileSync('.runtime/cliproxyapi.yaml', JSON.stringify({ 'config-version': 8,
  server: { host: '0.0.0.0', port: 8317, 'max-request-body-bytes': 2097152 },
  management: { 'allow-remote': true, 'secret-key': management, 'disable-control-panel': true },
  access: { 'api-keys': [backend] }, oauth: { 'auth-dir': '/auth' },
  routing: { strategy: 'fill-first', retry: { 'request-retry': 0, 'max-retry-credentials': 1, 'max-retry-interval': 0 } },
  requests: { streaming: { 'bootstrap-retries': 0 } }, observability: { logs: { 'request-log': false, 'error-logs-max-files': 1 }, usage: { 'usage-statistics-enabled': false } } }, null, 2) + '\n');
console.log('Docker configuration initialized. Run ./router4u up -d --build, then follow docs/docker.md. Credentials were not printed.');
