import { mkdirSync, openSync, closeSync, writeSync, fsyncSync, readSync, statSync, existsSync, truncateSync, unlinkSync, readdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';

// One writer owns a state directory. Records are synced before a write is acknowledged.
export class JsonlLogs {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const kind of ['requests', 'exchanges']) mkdirSync(join(directory, kind), { mode: 0o700, recursive: true });
    this.sequences = new Map();
  }
  path(name) {
    if (!/^(requests\/[a-f0-9-]+|exchanges\/[a-f0-9-]+|audit|events)$/.test(name)) throw new Error('Invalid log name');
    return join(this.directory, `${name}.jsonl`);
  }
  *read(name) {
    const path = this.path(name);
    if (!existsSync(path)) return;
    const fd = openSync(path, 'r'); const buffer = Buffer.alloc(65536); let pending = '';
    // Logs contain ASCII JSON (payload bytes are base64); string fields can contain UTF-8.
    const decoder = new TextDecoder();
    try {
      let size;
      while ((size = readSync(fd, buffer, 0, buffer.length, null))) {
        pending += decoder.decode(buffer.subarray(0, size), { stream: true });
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (line) yield JSON.parse(line);
        }
      }
      // An interrupted final write is not a committed line.
    } finally { closeSync(fd); }
  }
  append(name, value) {
    const path = this.path(name);
    const existed = existsSync(path);
    const fd = openSync(path, 'a+', 0o600);
    try {
      // Recover a torn final line before appending another record.
      let end = statSync(path).size;
      const bufferTail = Buffer.alloc(65536);
      const original = end;
      while (end) {
        const start = Math.max(0, end - bufferTail.length);
        const size = readSync(fd, bufferTail, 0, end - start, start);
        const newline = bufferTail.subarray(0, size).lastIndexOf(10);
        if (newline >= 0) { end = start + newline + 1; break; }
        end = start;
      }
      if (end !== original) truncateSync(path, end);
      const buffer = Buffer.from(JSON.stringify(value) + '\n');
      try { let offset = 0; while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset); fsyncSync(fd); if (!existed) { const parent = openSync(dirname(path), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); } } }
      catch (error) { truncateSync(path, end); throw error; }
    } finally { closeSync(fd); }
  }
  event(name, value) {
    if (!this.sequences.has(name)) { let sequence = 0; for (const row of this.read(name)) sequence = Math.max(sequence, row.sequence); this.sequences.set(name, sequence); }
    const sequence = this.sequences.get(name) + 1;
    this.append(name, { sequence, ...value }); this.sequences.set(name, sequence);
  }
  rows(name, after = 0, limit = 200) {
    const result = [];
    for (const row of this.read(name)) { if (row.sequence > after) result.push(row); if (result.length === limit) break; }
    return result;
  }
  reconcileExchange(id, expected) {
    const path = this.path(`exchanges/${id}`);
    if (!existsSync(path)) return expected === 0;
    const fd = openSync(path, 'r'); const buffer = Buffer.alloc(65536);
    let position = 0, count = 0, committed = 0;
    try {
      let size;
      while ((size = readSync(fd, buffer, 0, buffer.length, null))) {
        for (let index = 0; index < size; index++) if (buffer[index] === 10) { count++; if (count <= expected) committed = position + index + 1; }
        position += size;
      }
    } finally { closeSync(fd); }
    if (position !== committed) truncateSync(path, committed);
    return count >= expected;
  }
  request(id) {
    let value = null;
    for (const row of this.read(`requests/${id}`)) value = row.type === 'request' ? row.request : row.type === 'update' ? { ...value, ...row.patch } : value;
    return value;
  }
  requestIDs() { return readdirSync(join(this.directory, 'requests')).filter(name => /^[a-f0-9-]+\.jsonl$/.test(name)).map(name => name.slice(0, -6)); }
  removeExchange(id) { const path = this.path(`exchanges/${id}`); if (existsSync(path)) unlinkSync(path); }
  copyTo(directory) { cpSync(this.directory, directory, { recursive: true, errorOnExist: true, force: false }); }
}
