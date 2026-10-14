import { join } from 'node:path';
import { readSecrets } from './runtime.js';
try {
  const secrets = readSecrets(join(process.env.ROUTER4U_STATE_DIR ?? '/var/lib/router4u', 'secrets.json'));
  for (const [url, headers] of [
    ['http://127.0.0.1:9470/healthz', {}],
    ['http://127.0.0.1:8317/v8/management/credentials', { authorization: `Bearer ${secrets.ROUTER4U_BACKEND_MANAGEMENT_KEY}` }],
  ]) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    if (!response.ok) throw new Error('Not ready');
  }
} catch { process.exitCode = 1; }
