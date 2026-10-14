import { readFileSync, mkdirSync, existsSync, chmodSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { backup } from 'node:sqlite';
import { createGateway } from './server.js';
import { loadConfig } from './config.js';
import { lockDirectory } from './lock.js';
import { backupInstallation, restoreInstallation } from './installation-backup.js';
import { Store } from './store.js';

process.umask(0o077);

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string', default: '.runtime/router4u.json' }, route: { type: 'string', default: 'personal' },
  file: { type: 'string' }, scopes: { type: 'string' }, destination: { type: 'string' },
  'env-file': { type: 'string', default: '.runtime/.env' }, 'dry-run': { type: 'boolean' },
  from: { type: 'string' }, to: { type: 'string' },
  'backend-config': { type: 'string', default: '.runtime/cliproxyapi.yaml' },
  'auth-dir': { type: 'string', default: '.runtime/auth' },
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
  if (!key) throw new Error('Set ROUTER4U_ADMIN_KEY or run Docker setup');
  const response = await fetch(values.url + path, { method, redirect: 'error', signal: AbortSignal.timeout(35000),
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? `HTTP ${response.status}`);
  return result;
}

async function auth(command) {
  const route = encodeURIComponent(values.route);
  if (command === 'codex') { print(await admin(`/admin/backends/${route}/login`, 'POST', {})); return; }
  if (command === 'status') { print(await admin(`/admin/backends/${route}/status?state=${encodeURIComponent(positionals[2] ?? '')}`)); return; }
  if (command === 'callback') {
    const redirect = readFileSync(values.file ?? 0, 'utf8').trim();
    print(await admin(`/admin/backends/${route}/callback`, 'POST', { redirect_url: redirect })); return;
  }
  throw new Error('Use auth codex, auth callback, auth status STATE');
}

async function main() {
  const [command, target] = positionals;
  if (values.help || !command) return print(`Router4u operator CLI (Node.js 24)

serve [--config PATH]
project put ID --file POLICY.json
project key ID [--scopes inference,usage:read,requests:read,requests:cancel,exchange:export]
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
validate-config [--config PATH]
reload [--dry-run]
effective-policy PROJECT
account [inspect|enable|disable|remove|refresh|reconnect ACCOUNT_ID]
health | metrics | alerts | occupancy
release-occupancy REQUEST_ID --reason EVIDENCE
observe-usage REQUEST_ID --file OBSERVATION.json
export-usage PROJECT [--from EPOCH_MS] [--to EPOCH_MS]
retention
backup --file DESTINATION_DIRECTORY
backup-installation --file NEW_DIRECTORY --config PATH --backend-config PATH --auth-dir PATH --env-file PATH
restore-installation --file BACKUP_DIRECTORY --destination NEW_DIRECTORY
api /admin/PATH [--method METHOD] [--file BODY.json]

All online commands use --url and ROUTER4U_ADMIN_KEY. Local .runtime/.env is loaded if present.
Project keys are displayed only on issuance. Full exchange exports contain sensitive original data.`);
  envFile();
  if (command === 'serve') {
    const config = loadConfig(values.config);
    const unlock = lockDirectory(config.data_dir);
    let gateway;
    try { gateway = createGateway(config, { loadConfig: () => loadConfig(values.config) }); print(`Router4u listening at ${await gateway.listen()}`); }
    catch (error) { unlock(); throw error; }
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await gateway.close(); unlock(); };
    process.on('SIGHUP', () => { try { print(gateway.reload()); } catch (error) { process.stderr.write(`Reload rejected: ${error.message}\n`); } });
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    return;
  }
  if (command === 'auth') return auth(target);
  if (command === 'validate-config') { const config = loadConfig(values.config); return print({ valid: true, routes: config.routes.map(route => route.id) }); }
  if (command === 'reload') return print(await admin('/admin/config/reload', 'POST', { dry_run: values['dry-run'] === true }));
  if (command === 'effective-policy') return print(await admin(`/admin/projects/${encodeURIComponent(target)}/effective-policy`));
  if (['health', 'metrics', 'alerts', 'occupancy'].includes(command)) return print(await admin(`/admin/${command}`));
  if (command === 'retention') return print(await admin('/admin/retention/run', 'POST', {}));
  if (command === 'release-occupancy') return print(await admin(`/admin/requests/${encodeURIComponent(target)}/release-occupancy`, 'POST', { reason: values.reason }));
  if (command === 'observe-usage') return print(await admin(`/admin/requests/${encodeURIComponent(target)}/observations`, 'POST', inputJSON()));
  if (command === 'account') {
    if (!target) return print(await admin('/admin/accounts'));
    if (!['inspect', 'disable', 'enable', 'remove', 'refresh', 'reconnect'].includes(target)) throw new Error('Invalid account operation');
    return print(await admin(`/admin/accounts/${encodeURIComponent(positionals[2])}/${target}`, target === 'inspect' ? 'GET' : 'POST', target === 'inspect' ? undefined : {}));
  }
  if (command === 'export-usage') {
    let cursor = 0;
    const query = new URLSearchParams();
    if (values.from) query.set('from', values.from);
    if (values.to) query.set('to', values.to); else query.set('to', String(Date.now()));
    do {
      query.set('cursor', String(cursor));
      const page = await admin(`/admin/projects/${encodeURIComponent(target)}/history?${query}`);
      for (const item of page.items) process.stdout.write(JSON.stringify(item) + '\n');
      cursor = page.next_cursor;
    } while (cursor !== null);
    return;
  }
  if (command === 'restore-installation') {
    if (!values.file || !values.destination) throw new Error('Specify --file BACKUP and --destination NEW_DIRECTORY');
    return print(restoreInstallation(values.file, values.destination));
  }
  if (command === 'backup-installation') {
    if (!values.file) throw new Error('Specify --file NEW_BACKUP_DIRECTORY');
    const config = loadConfig(values.config);
    for (const route of config.routes) {
      let reachable = false;
      try { const response = await fetch(`${route.base_url}/models`, { signal: AbortSignal.timeout(1500) }); await response.body?.cancel(); reachable = true; } catch {}
      if (reachable) throw new Error('Stop all configured backends before installation backup');
    }
    const unlock = lockDirectory(config.data_dir); const store = new Store(config.data_dir);
    try { print(await backupInstallation(store, { destination: values.file, configPath: values.config, backendConfig: values['backend-config'], authDirectory: values['auth-dir'], environmentFile: values['env-file'] })); }
    finally { store.close(); unlock(); }
    return;
  }
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
  if (command === 'project' && target === 'key') return print(await admin(`/admin/projects/${encodeURIComponent(positionals[2])}/keys`, 'POST', values.scopes ? { scopes: values.scopes.split(',') } : {}));
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
