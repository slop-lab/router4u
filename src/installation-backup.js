import { mkdirSync, readdirSync, lstatSync, readFileSync, writeFileSync, copyFileSync, chmodSync, existsSync, renameSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { BACKEND_VERSION } from './config.js';

function hash(path) {
  const state = createHash('sha256'); const descriptor = openSync(path, 'r'); const buffer = Buffer.alloc(65536);
  try { let bytes; while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) state.update(buffer.subarray(0, bytes)); return state.digest('hex'); }
  finally { closeSync(descriptor); }
}
function requireSeparate(source, destination) {
  const root = resolve(source); const target = resolve(destination);
  if (root === target || target.startsWith(root + '/')) throw new Error('Destination must be outside the source tree');
}
function copyTree(source, target) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('Backup paths must not contain symlinks');
  if (stat.isDirectory()) { mkdirSync(target, { recursive: true, mode: 0o700 }); for (const entry of readdirSync(source).sort()) copyTree(join(source, entry), join(target, entry)); }
  else if (stat.isFile()) { copyFileSync(source, target); chmodSync(target, 0o600); }
  else throw new Error('Only regular files and directories are supported in backups');
}
function inventory(directory, relative = '') {
  return readdirSync(join(directory, relative)).sort().flatMap(name => {
    const path = join(relative, name); const stat = lstatSync(join(directory, path));
    if (stat.isSymbolicLink()) throw new Error('Backup contains a symlink');
    return stat.isDirectory() ? inventory(directory, path) : [{ path, sha256: hash(join(directory, path)) }];
  });
}
export async function backupInstallation(store, { destination, configPath, backendConfig, authDirectory, environmentFile }) {
  if (existsSync(destination)) throw new Error('Backup destination already exists');
  requireSeparate(authDirectory, destination); requireSeparate(join(dirname(configPath), 'partitions'), destination);
  const temporary = `${destination}.pending-${randomUUID()}`;
  mkdirSync(temporary, { mode: 0o700 });
  try {
    mkdirSync(join(temporary, 'data'), { mode: 0o700 });
    await backup(store.db, join(temporary, 'data/router4u.sqlite'));
    chmodSync(join(temporary, 'data/router4u.sqlite'), 0o600);
    store.logs.copyTo(join(temporary, 'data/logs'));
    for (const [source, name] of [[configPath, 'router4u.json'], [backendConfig, 'cliproxyapi.yaml'], [authDirectory, 'auth'], [environmentFile, environmentFile.endsWith('.json') ? 'secrets.json' : '.env']]) copyTree(source, join(temporary, name));
    for (const name of ['partitions', 'partitions.compose.yaml', 'compose.env']) {
      const source = join(dirname(configPath), name); if (existsSync(source)) copyTree(source, join(temporary, name));
    }
    const manifest = { format: 1, schema_version: 3, backend_version: BACKEND_VERSION, created_at: Date.now(), files: inventory(temporary) };
    writeFileSync(join(temporary, 'backup-manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    renameSync(temporary, destination);
    return { destination, files: manifest.files.length, credentials_included: true };
  } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error; }
}
export function restoreInstallation(source, destination) {
  if (existsSync(destination)) throw new Error('Restore destination must not exist');
  requireSeparate(source, destination);
  const manifest = JSON.parse(readFileSync(join(source, 'backup-manifest.json'), 'utf8'));
  if (manifest.format !== 1 || manifest.schema_version !== 3) throw new Error('Unsupported backup format or schema');
  const actual = inventory(source).filter(file => file.path !== 'backup-manifest.json');
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Backup integrity verification failed');
  const db = new DatabaseSync(join(source, 'data/router4u.sqlite'), { readOnly: true });
  try { if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Database integrity verification failed'); } finally { db.close(); }
  const temporary = join(dirname(resolve(destination)), `.restore-${randomUUID()}`);
  try { copyTree(source, temporary); renameSync(temporary, destination); }
  catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error; }
  return { destination, backend_version: manifest.backend_version, note: 'Start exactly one backend refresh owner. Review restored paths and credentials before starting.' };
}
