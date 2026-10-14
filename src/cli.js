import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { backup } from 'node:sqlite';
import { createGateway } from './server.js';
import { loadConfig } from './config.js';
import { lockDirectory } from './lock.js';
import { Store } from './store.js';

process.umask(0o077);

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string', default: '.runtime/router4u.json' }, route: { type: 'string', default: 'personal' },
  file: { type: 'string' }, model: { type: 'string', default: 'test-model' },
  'backend-bin': { type: 'string', default: '.tools/cli-proxy-api' },
  'backend-config': { type: 'string', default: '.runtime/cliproxyapi.yaml' },
  'auth-dir': { type: 'string', default: '.runtime/auth' },
  credential: { type: 'string' }, profile: { type: 'string', default: 'codex' },
  url: { type: 'string', default: 'http://127.0.0.1:9470' }, method: { type: 'string', default: 'GET' },
  tokens: { type: 'string' }, reason: { type: 'string' }, help: { type: 'boolean' },
} });

function print(value) { process.stdout.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`); }
function inputJSON() { return JSON.parse(readFileSync(values.file ?? 0, 'utf8')); }
function envFile() {
  const path = resolve('.runtime/.env');
  if (existsSync(path)) process.loadEnvFile(path);
}
async function admin(path, method = 'GET', body) {
  const key = process.env.ROUTER4U_ADMIN_KEY;
  if (!key) throw new Error('Set ROUTER4U_ADMIN_KEY or initialize .runtime/.env');
  const response = await fetch(values.url + path, { method, redirect: 'error', signal: AbortSignal.timeout(35000),
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? `HTTP ${response.status}`);
  return result;
}

function init() {
  if (existsSync('.runtime/router4u.json') || existsSync('.runtime/.env')) throw new Error('Runtime already initialized; existing credentials were preserved');
  if (!['api_key', 'codex', 'chatgpt'].includes(values.profile)) throw new Error('Invalid profile');
  mkdirSync('.runtime/auth', { recursive: true, mode: 0o700 });
  const operator = randomBytes(32).toString('base64url');
  const backend = randomBytes(32).toString('base64url');
  const management = randomBytes(32).toString('base64url');
  writeFileSync('.runtime/.env', `ROUTER4U_ADMIN_KEY=${operator}\nROUTER4U_BACKEND_KEY=${backend}\nROUTER4U_BACKEND_MANAGEMENT_KEY=${management}\n`, { mode: 0o600 });
  const config = { host: '127.0.0.1', port: 9470, data_dir: '.runtime/data', routes: [{ id: values.route, profile: values.profile,
    base_url: 'http://127.0.0.1:8317/v1', key_env: 'ROUTER4U_BACKEND_KEY', management_key_env: 'ROUTER4U_BACKEND_MANAGEMENT_KEY',
    models: [values.model], protocols: values.profile === 'api_key' ? ['responses', 'chat'] : ['responses'] }] };
  writeFileSync('.runtime/router4u.json', JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  writeFileSync('.runtime/cliproxyapi.yaml', `config-version: 8\nserver:\n  host: "127.0.0.1"\n  port: 8317\n  max-request-body-bytes: 2097152\nmanagement:\n  allow-remote: false\n  secret-key: "${management}"\n  disable-control-panel: true\naccess:\n  api-keys: ["${backend}"]\noauth:\n  auth-dir: ${JSON.stringify(resolve('.runtime/auth'))}\n  providers:\n    codex:\n      signin-with-chatgpt-identifier: "router4u"\nrouting:\n  strategy: "fill-first"\n  retry:\n    request-retry: 0\n    max-retry-credentials: 1\n    max-retry-interval: 0\nrequests:\n  streaming:\n    bootstrap-retries: 0\nobservability:\n  logs:\n    request-log: false\n    error-logs-max-files: 1\n  usage:\n    usage-statistics-enabled: false\n`, { mode: 0o600 });
  print('Initialized .runtime. Read docs/authentication.md before connecting an account. Keep one account per backend partition.');
}

async function auth(command) {
  const route = encodeURIComponent(values.route);
  if (command === 'codex') { print(await admin(`/admin/backends/${route}/login`, 'POST', {})); return; }
  if (command === 'status') { print(await admin(`/admin/backends/${route}/status?state=${encodeURIComponent(positionals[2] ?? '')}`)); return; }
  if (command === 'callback') {
    const redirect = readFileSync(values.file ?? 0, 'utf8').trim();
    print(await admin(`/admin/backends/${route}/callback`, 'POST', { redirect_url: redirect })); return;
  }
  if (command === 'chatgpt') {
    if (!values.credential || !/^[a-zA-Z0-9_.@+-]+\.json$/.test(values.credential) || values.credential.includes('..')) throw new Error('Specify a credential filename using --credential');
    const config = loadConfig(values.config);
    const selected = config.routes.find(item => item.id === values.route);
    if (!selected) throw new Error('Unknown route');
    let running = false;
    try { await fetch(`${selected.base_url}/models`, { signal: AbortSignal.timeout(1500) }); running = true; } catch {}
    if (running) throw new Error('Stop this CLIProxyAPI backend before binding ChatGPT credentials, then restart it after login');
    const credentialPath = resolve(values['auth-dir'], values.credential);
    const before = JSON.parse(readFileSync(credentialPath, 'utf8'));
    if (before.type !== 'codex' || !before.access_token || !before.refresh_token) throw new Error('Complete Codex login first; this backend requires a Codex credential file');
    print('Personal use only: use your own account and applications. Do not share account access. You are responsible for provider terms and plan restrictions.');
    const child = spawn(resolve(values['backend-bin']), ['-config', resolve(values['backend-config']), '-siwc-bind', values.credential, '-no-browser', '-local-model'], { stdio: 'inherit', shell: false });
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
    if (code !== 0) throw new Error(`ChatGPT login exited with status ${code}`);
    const after = JSON.parse(readFileSync(credentialPath, 'utf8'));
    if (after.use_siwc !== true || !after.siwc?.access_token || !after.siwc?.refresh_token || !after.siwc?.client_id || after.siwc.access_token === before.siwc?.access_token) throw new Error('Backend did not persist a new ChatGPT credential; inspect its login output');
    print('ChatGPT credential persisted. Select profile "chatgpt" and restart the backend. Live inference is still required to verify account access.');
    return;
  }
  throw new Error('Use auth codex, auth callback, auth status STATE, or auth chatgpt --credential NAME.json');
}

async function main() {
  const [command, target] = positionals;
  if (values.help || !command) return print(`Router4u operator CLI (Node.js 24)

init --model MODEL --profile codex|chatgpt|api_key
serve [--config PATH]
project put ID --file POLICY.json
project key ID
principal revoke ID
usage PROJECT
requests PROJECT
request ID
cancel REQUEST_ID
resolve REQUEST_ID --tokens NUMBER --reason TEXT
exchange REQUEST_ID
delete-exchange REQUEST_ID
pause | resume
doctor [--route ROUTE]
accounts [--route ROUTE]
models [--route ROUTE]
auth codex [--route ROUTE]
auth callback [--file CALLBACK_URL_FILE]
auth status STATE
auth chatgpt --credential NAME.json [--backend-bin PATH] [--backend-config PATH]
backup --file DESTINATION_DIRECTORY
api /admin/PATH [--method METHOD] [--file BODY.json]

All online commands use --url and ROUTER4U_ADMIN_KEY. Local .runtime/.env is loaded if present.
Project keys are displayed only on issuance. Full exchange exports contain sensitive original data.`);
  if (command === 'init') return init();
  envFile();
  if (command === 'serve') {
    const config = loadConfig(values.config);
    const unlock = lockDirectory(config.data_dir);
    let gateway;
    try { gateway = createGateway(config); print(`Router4u listening at ${await gateway.listen()}`); }
    catch (error) { unlock(); throw error; }
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await gateway.close(); unlock(); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    return;
  }
  if (command === 'auth') return auth(target);
  if (command === 'backup') {
    if (!values.file) throw new Error('Specify a new destination directory using --file');
    const config = loadConfig(values.config);
    const unlock = lockDirectory(config.data_dir);
    const store = new Store(config.data_dir);
    try {
      mkdirSync(values.file, { mode: 0o700 });
      await backup(store.db, join(values.file, 'router4u.sqlite'));
      chmodSync(join(values.file, 'router4u.sqlite'), 0o600);
      cpSync(values.config, join(values.file, 'router4u.json'));
      print('Gateway ledger and archive backed up. Separately back up the stopped backend auth directory, configuration, and .env. See docs/operations.md.');
    } finally { store.close(); unlock(); }
    return;
  }
  if (command === 'project' && target === 'put') return print(await admin(`/admin/projects/${encodeURIComponent(positionals[2])}`, 'PUT', inputJSON()));
  if (command === 'project' && target === 'key') return print(await admin(`/admin/projects/${encodeURIComponent(positionals[2])}/keys`, 'POST', {}));
  if (command === 'principal' && target === 'revoke') return print(await admin(`/admin/principals/${encodeURIComponent(positionals[2])}`, 'DELETE'));
  if (command === 'requests') return print(await admin(`/admin/projects/${encodeURIComponent(target)}/requests`));
  if (command === 'usage') return print(await admin(`/admin/usage/${encodeURIComponent(target)}`));
  if (command === 'request') return print(await admin(`/admin/requests/${encodeURIComponent(target)}`));
  if (command === 'cancel') return print(await admin(`/admin/requests/${encodeURIComponent(target)}/cancel`, 'POST', {}));
  if (command === 'resolve') return print(await admin(`/admin/requests/${encodeURIComponent(target)}/resolve`, 'POST', { tokens: Number(values.tokens), reason: values.reason }));
  if (command === 'exchange') return print(await admin(`/admin/requests/${encodeURIComponent(target)}/exchange`));
  if (command === 'delete-exchange') return print(await admin(`/admin/requests/${encodeURIComponent(target)}/exchange`, 'DELETE'));
  if (command === 'pause' || command === 'resume') return print(await admin('/admin/pause', 'POST', { paused: command === 'pause' }));
  if (command === 'doctor') return print(await admin(`/admin/backends/${encodeURIComponent(values.route)}/inspect`));
  if (command === 'accounts' || command === 'models') return print(await admin(`/admin/backends/${encodeURIComponent(values.route)}/${command === 'accounts' ? 'credentials' : 'models'}`));
  if (command === 'api') { if (!target?.startsWith('/admin/')) throw new Error('api requires an /admin/ path'); return print(await admin(target, values.method, values.file ? inputJSON() : undefined)); }
  throw new Error('Unknown command; use --help');
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
