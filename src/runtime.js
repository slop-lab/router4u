import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export function readSecrets(path) {
  let secrets;
  try { secrets = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('Cannot read valid runtime secrets'); }
  if (!secrets || Array.isArray(secrets) || typeof secrets !== 'object' || Object.entries(secrets).some(([key, value]) => !/^ROUTER4U_[A-Z0-9_]+$/.test(key) || typeof value !== 'string' || !value)) throw new Error('Invalid runtime secrets');
  return secrets;
}
export function loadSecrets(path, environment = process.env) {
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(readSecrets(path))) environment[key] ??= value;
}
export function writePrivateJSON(path, value) {
  writeFileSync(path + '.pending', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path + '.pending', 0o600);
  renameSync(path + '.pending', path);
}
export function initializeRuntime(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const name of ['data', 'auth']) mkdirSync(join(directory, name), { recursive: true, mode: 0o700 });
  const secretsPath = join(directory, 'secrets.json');
  const configPath = join(directory, 'router4u.json');
  const backendPath = join(directory, 'cliproxyapi.yaml');
  if (!existsSync(secretsPath)) {
    if (existsSync(configPath) || existsSync(backendPath)) throw new Error('Existing runtime has no secrets.json; migrate credentials before starting');
    writePrivateJSON(secretsPath, Object.fromEntries(['ROUTER4U_ADMIN_KEY', 'ROUTER4U_BACKEND_KEY', 'ROUTER4U_BACKEND_MANAGEMENT_KEY'].map(key => [key, key === 'ROUTER4U_ADMIN_KEY' && process.env[key] ? process.env[key] : randomBytes(32).toString('base64url')])));
  }
  const secrets = readSecrets(secretsPath);
  for (const key of ['ROUTER4U_ADMIN_KEY', 'ROUTER4U_BACKEND_KEY', 'ROUTER4U_BACKEND_MANAGEMENT_KEY']) if (!secrets[key]) throw new Error(`Missing ${key}`);
  if (process.env.ROUTER4U_ADMIN_KEY && process.env.ROUTER4U_ADMIN_KEY !== secrets.ROUTER4U_ADMIN_KEY) throw new Error('Administrator key differs from persisted key; remove the override');
  if (!existsSync(backendPath)) writePrivateJSON(backendPath, {
    'config-version': 8, server: { host: '127.0.0.1', port: 8317, 'max-request-body-bytes': 2097152 },
    management: { 'allow-remote': false, 'secret-key': secrets.ROUTER4U_BACKEND_MANAGEMENT_KEY, 'disable-control-panel': true },
    access: { 'api-keys': [secrets.ROUTER4U_BACKEND_KEY] }, oauth: { 'auth-dir': join(directory, 'auth') },
    routing: { strategy: 'fill-first', retry: { 'request-retry': 0, 'max-retry-credentials': 1, 'max-retry-interval': 0 } },
    requests: { streaming: { 'bootstrap-retries': 0 } }, observability: { logs: { 'request-log': false, 'error-logs-max-files': 1 }, usage: { 'usage-statistics-enabled': false } },
  });
  if (!existsSync(configPath)) writePrivateJSON(configPath, { host: '0.0.0.0', port: 9470, data_dir: join(directory, 'data'), transcript_dir: process.env.ROUTER4U_TRANSCRIPT_DIR ?? '/var/lib/router4u-transcripts', accounts: [], routes: [{ id: 'personal', profile: 'codex', enabled: false, models: [], protocols: ['responses'], base_url: 'http://127.0.0.1:8317/v1', key_env: 'ROUTER4U_BACKEND_KEY', management_key_env: 'ROUTER4U_BACKEND_MANAGEMENT_KEY', concurrency: 4 }] });
  return { secrets, configPath, backendPath };
}
