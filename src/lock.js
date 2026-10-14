import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function lockDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'service.lock');
  try {
    const descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, String(process.pid));
    closeSync(descriptor);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid service lock; inspect it before removing it');
    try { process.kill(pid, 0); } catch (probe) {
      if (probe.code === 'ESRCH') {
        unlinkSync(path);
        return lockDirectory(directory);
      }
    }
    throw new Error(`State directory is in use by process ${pid}`);
  }
  return () => { if (readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path); };
}
