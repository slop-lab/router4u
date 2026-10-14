import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readSecrets, initializeRuntime, loadSecrets, writePrivateJSON } from './runtime.js';
import { randomBytes } from 'node:crypto';

process.umask(0o077);
const directory = process.env.ROUTER4U_STATE_DIR ?? '/var/lib/router4u';
const args = process.argv.slice(2);
if (args[0] === 'admin-key' && args[1] === 'show' && args.length === 2) {
  console.log(readSecrets(join(directory, 'secrets.json')).ROUTER4U_ADMIN_KEY);
} else if (args[0] === 'admin-key' && args[1] === 'rotate' && args.length === 2) {
  const path = join(directory, 'secrets.json');
  const secrets = readSecrets(path);
  secrets.ROUTER4U_ADMIN_KEY = randomBytes(32).toString('base64url');
  writePrivateJSON(path, secrets);
  console.log('Administrator key rotated. Start the service and use admin-key show to retrieve it.');
} else if (args[0] !== 'start') {
  loadSecrets(join(directory, 'secrets.json'));
  loadSecrets('/config/secrets.json');
  const child = spawn(process.execPath, ['/app/src/cli.js', ...args], { stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { console.error('Could not start operator CLI'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  if (args.length !== 1) throw new Error('Usage: router4u start. Configure host publication with docker -p.');
  const children = new Set();
  let stopping = false;
  let timer;
  function stop(code) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    // Stop admission before stopping the credential owner.
    const gateway = [...children].find(child => child.role === 'gateway');
    if (gateway) gateway.kill('SIGTERM');
    else for (const child of children) child.kill('SIGTERM');
    timer = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 25000);
    timer.unref();
    if (!children.size) clearTimeout(timer);
  }
  function launch(command, arguments_, role, environment) {
    const child = spawn(command, arguments_, { stdio: 'inherit', env: environment });
    child.role = role;
    children.add(child);
    child.on('error', () => { console.error(`Could not start ${role}`); stop(1); });
    child.on('exit', () => {
      children.delete(child);
      if (!stopping) stop(1);
      if (role === 'gateway') for (const remaining of children) remaining.kill('SIGTERM');
      if (!children.size) clearTimeout(timer);
    });
    return child;
  }
  process.on('SIGTERM', () => stop(0));
  process.on('SIGINT', () => stop(0));
  try {
    const { secrets, configPath, backendPath } = initializeRuntime(directory);
    const environment = { ...process.env, ...secrets };
    const backendEnvironment = { ...process.env };
    for (const key of Object.keys(secrets)) delete backendEnvironment[key];
    launch('/usr/local/bin/cli-proxy-api', ['-config', backendPath, '-local-model'], 'backend', backendEnvironment);
    let ready = false;
    for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
      try {
        const response = await fetch('http://127.0.0.1:8317/v8/management/credentials', { headers: { authorization: `Bearer ${secrets.ROUTER4U_BACKEND_MANAGEMENT_KEY}` }, signal: AbortSignal.timeout(500) });
        ready = response.ok;
        await response.body?.cancel();
        if (ready) break;
      } catch { /* Backend is still starting. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!stopping && !ready) throw new Error('Backend readiness timed out');
    if (!stopping) launch(process.execPath, ['/app/src/cli.js', 'serve', '--config', configPath], 'gateway', environment);
  } catch (error) { console.error(error.message); stop(1); }
}
