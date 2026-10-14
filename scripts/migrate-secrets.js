import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import { readSecrets, writePrivateJSON } from '../src/runtime.js';

process.umask(0o077);
const directory = resolve(process.argv[2] ?? '.runtime');
const legacy = join(directory, '.env');
const target = join(directory, 'secrets.json');
if (!existsSync(legacy)) throw new Error('No legacy runtime .env found');
const secrets = parseEnv(readFileSync(legacy, 'utf8'));
if (Object.entries(secrets).some(([key, value]) => !/^ROUTER4U_[A-Z0-9_]+$/.test(key) || !value)) throw new Error('Unexpected legacy environment entries; review manually');
if (existsSync(target)) {
  const existing = readSecrets(target);
  if (Object.keys(existing).length !== Object.keys(secrets).length || Object.entries(secrets).some(([key, value]) => existing[key] !== value)) throw new Error('Existing secrets differ; refusing to overwrite');
} else writePrivateJSON(target, secrets);
readSecrets(target);
unlinkSync(legacy);
console.log('Migrated runtime keys to secrets.json and removed .env. Keys were preserved and were not printed.');
