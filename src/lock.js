import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function lockDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'service.lock');
  try {
    const descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, start: processStart(process.pid) }));
    closeSync(descriptor);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const content = JSON.parse(readFileSync(path, 'utf8'));
    const pid = typeof content === 'number' ? content : content.pid;
    if (typeof content === 'object' && content.start && processStart(pid) && content.start !== processStart(pid)) {
      unlinkSync(path); return lockDirectory(directory);
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid service lock; inspect it before removing it');
    try { process.kill(pid, 0); } catch (probe) {
      if (probe.code === 'ESRCH') {
        unlinkSync(path);
        return lockDirectory(directory);
      }
    }
    throw new Error(`State directory is in use by process ${pid}`);
  }
  return () => { const content = JSON.parse(readFileSync(path, 'utf8')); if (content.pid === process.pid && content.start === processStart(process.pid)) unlinkSync(path); };
}

function processStart(pid) {
  try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]; } catch { return null; }
}
