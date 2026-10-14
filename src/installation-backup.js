import { mkdirSync, readdirSync, lstatSync, readFileSync, writeFileSync, copyFileSync, chmodSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { BACKEND_VERSION } from './config.js';

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function copyTree(source, target) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('Backup paths must not contain symlinks');
  if (stat.isDirectory()) { mkdirSync(target, { recursive: true, mode: 0o700 }); for (const entry of readdirSync(source)) copyTree(join(source, entry), join(target, entry)); }
  else if (stat.isFile()) { copyFileSync(source, target); chmodSync(target, 0o600); }
  else throw new Error('Only regular files and directories are supported in backups');
}
function inventory(directory, relative = '') {
  return readdirSync(join(directory, relative)).flatMap(name => {
    const path = join(relative, name); const stat = lstatSync(join(directory, path));
    if (stat.isSymbolicLink()) throw new Error('Backup contains a symlink');
    return stat.isDirectory() ? inventory(directory, path) : [{ path, sha256: hash(join(directory, path)) }];
  });
}
export async function backupInstallation(store, { destination, configPath, backendConfig, authDirectory, environmentFile }) {
  if (existsSync(destination)) throw new Error('Backup destination already exists');
  const temporary = `${destination}.pending-${randomUUID()}`;
  mkdirSync(temporary, { mode: 0o700 });
  try {
    mkdirSync(join(temporary, 'data'), { mode: 0o700 });
    await backup(store.db, join(temporary, 'data/router4u.sqlite'));
    chmodSync(join(temporary, 'data/router4u.sqlite'), 0o600);
    for (const [source, name] of [[configPath, 'router4u.json'], [backendConfig, 'cliproxyapi.yaml'], [authDirectory, 'auth'], [environmentFile, '.env']]) copyTree(source, join(temporary, name));
    const manifest = { format: 1, schema_version: 2, backend_version: BACKEND_VERSION, created_at: Date.now(), files: inventory(temporary) };
    writeFileSync(join(temporary, 'backup-manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    renameSync(temporary, destination);
    return { destination, files: manifest.files.length, credentials_included: true };
  } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error; }
}
export function restoreInstallation(source, destination) {
  if (existsSync(destination)) throw new Error('Restore destination must not exist');
  const manifest = JSON.parse(readFileSync(join(source, 'backup-manifest.json'), 'utf8'));
  if (manifest.format !== 1 || manifest.schema_version > 2) throw new Error('Unsupported backup format or schema');
  const actual = inventory(source).filter(file => file.path !== 'backup-manifest.json');
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Backup integrity verification failed');
  const db = new DatabaseSync(join(source, 'data/router4u.sqlite'), { readOnly: true });
  try { if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Database integrity verification failed'); } finally { db.close(); }
  const temporary = join(dirname(resolve(destination)), `.restore-${randomUUID()}`);
  try { copyTree(source, temporary); renameSync(temporary, destination); }
  catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error; }
  return { destination, backend_version: manifest.backend_version, note: 'Start exactly one backend refresh owner. Review restored paths and credentials before starting.' };
}
