import { DatabaseSync } from 'node:sqlite';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { JsonlLogs } from './jsonl.js';
import { Store } from './store.js';
import { lockDirectory } from './lock.js';

// Run only while the installation is stopped. The schema switch is transactional;
// deterministic per-request files make an interrupted pre-commit run repeatable.
export function migrateJsonl(directory) {
  const unlock = lockDirectory(directory);
  let db;
  const temporary = join(directory, 'logs-conversion');
  try {
    db = new DatabaseSync(join(directory, 'router4u.sqlite'));
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version === 3) return { converted: false, schema: 3 };
    if (version !== 2) throw new Error('JSONL conversion requires schema 2');
    rmSync(temporary, { recursive: true, force: true });
    const logs = new JsonlLogs(temporary);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of db.prepare('SELECT rowid AS cursor,id,data FROM requests').iterate()) {
        const record = JSON.parse(row.data);
        logs.append(`requests/${row.id}`, { type: 'request', request: { ...record, cursor: row.cursor } });
        const sequences = {};
        for (const chunk of db.prepare('SELECT direction,sequence,payload,hash,created FROM chunks WHERE request_id=? ORDER BY direction,sequence').iterate(row.id)) {
          logs.append(`exchanges/${row.id}`, { ...chunk, payload: Buffer.from(chunk.payload).toString('base64') });
          sequences[chunk.direction] = chunk.sequence + 1;
        }
        db.prepare('UPDATE requests SET data=? WHERE id=?').run(JSON.stringify(Store.prototype.operational(record)), row.id);
        const capture = db.prepare('SELECT data FROM captures WHERE request_id=?').get(row.id);
        if (capture) {
          const manifest = { ...JSON.parse(capture.data), sequences };
          logs.append(`requests/${row.id}`, { type: 'manifest', patch: manifest });
          db.prepare('UPDATE captures SET data=? WHERE request_id=?').run(JSON.stringify(Store.prototype.captureControl(manifest)), row.id);
        }
      }
      for (const row of db.prepare('SELECT * FROM audit ORDER BY sequence').iterate()) logs.append('audit', row);
      for (const row of db.prepare('SELECT * FROM outbox ORDER BY sequence').iterate()) logs.append('events', row);
      const destination = join(directory, 'logs');
      // Schema 2 never owns this path; a previous interrupted conversion can be replaced.
      if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
      renameSync(temporary, destination);
      db.exec('DROP TABLE chunks; DROP TABLE audit; DROP TABLE outbox; PRAGMA user_version=3; COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
    return { converted: true, schema: 3 };
  } finally { db?.close(); unlock(); }
}
