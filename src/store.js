import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceError, requireValue } from './errors.js';
import { validatePolicy, periodFor } from './config.js';

export const digest = value => createHash('sha256').update(value).digest('hex');
const decode = row => row ? JSON.parse(row.data) : null;

export class Store {
  constructor(directory, { clock = Date.now, archiveMaxBytes = 1073741824 } = {}) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'router4u.sqlite');
    this.db = new DatabaseSync(this.path);
    if (this.db.prepare('PRAGMA user_version').get().user_version > 1) { this.db.close(); throw new Error('Database schema is newer than this service'); }
    chmodSync(this.path, 0o600);
    this.clock = clock;
    this.archiveMaxBytes = archiveMaxBytes;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS principals(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), hash TEXT UNIQUE NOT NULL, enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS policies(revision TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, period TEXT NOT NULL, service_period TEXT NOT NULL, created INTEGER NOT NULL, active INTEGER NOT NULL, reserved INTEGER NOT NULL, tokens INTEGER, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_project_period ON requests(project_id,period);
      CREATE INDEX IF NOT EXISTS requests_created ON requests(created);
      CREATE INDEX IF NOT EXISTS requests_service_period ON requests(service_period);
      CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY, request_id TEXT, project_id TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS captures(request_id TEXT PRIMARY KEY REFERENCES requests(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks(request_id TEXT NOT NULL REFERENCES captures(request_id), direction TEXT NOT NULL, sequence INTEGER NOT NULL, payload BLOB NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(request_id,direction,sequence));
      CREATE TABLE IF NOT EXISTS archive_usage(id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL);
      INSERT OR IGNORE INTO archive_usage VALUES(1,0);
      CREATE TABLE IF NOT EXISTS audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, actor TEXT NOT NULL, operation TEXT NOT NULL, target TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, request_id TEXT NOT NULL, event TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }

  close() { this.db.close(); }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(actor, operation, target, data = {}) {
    this.db.prepare('INSERT INTO audit(created,actor,operation,target,data) VALUES(?,?,?,?,?)').run(this.clock(), actor, operation, target, JSON.stringify(data));
  }
  project(id) { return decode(this.db.prepare('SELECT data FROM projects WHERE id=?').get(id)); }
  projects() { return this.db.prepare('SELECT data FROM projects ORDER BY id').all().map(decode); }
  putProject(id, input) {
    requireValue(/^[a-zA-Z0-9_-]{1,64}$/.test(id), 'Invalid project ID');
    const policy = validatePolicy(input);
    return this.transaction(() => {
      const revision = randomUUID();
      const project = { id, policy, revision };
      this.db.prepare('INSERT INTO policies VALUES(?,?,?)').run(revision, id, JSON.stringify(policy));
      this.db.prepare('INSERT INTO projects VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(project));
      this.audit('operator', 'project.policy', id, { revision });
      return project;
    });
  }
  issueKey(projectId) {
    requireValue(this.project(projectId), 'Unknown project');
    const key = `r4u_${randomBytes(32).toString('base64url')}`;
    const id = randomUUID();
    this.transaction(() => {
      this.db.prepare('INSERT INTO principals VALUES(?,?,?,1)').run(id, projectId, digest(key));
      this.audit('operator', 'principal.issue', id, { project_id: projectId });
    });
    return { principal_id: id, project_id: projectId, key };
  }
  revokeKey(id) {
    this.transaction(() => {
      const result = this.db.prepare('UPDATE principals SET enabled=0 WHERE id=?').run(id);
      requireValue(result.changes === 1, 'Unknown principal');
      this.audit('operator', 'principal.revoke', id);
    });
  }
  authenticate(key) {
    if (!key) throw new ServiceError(401, 'authentication_failed', 'Project credential required');
    const principal = this.db.prepare('SELECT id,project_id FROM principals WHERE hash=? AND enabled=1').get(digest(key));
    if (!principal) throw new ServiceError(401, 'authentication_failed', 'Invalid project credential');
    return principal;
  }
  paused() { return decode(this.db.prepare("SELECT data FROM settings WHERE id='paused'").get()) ?? false; }
  pause(value) {
    requireValue(typeof value === 'boolean', 'paused must be boolean');
    this.transaction(() => {
      this.db.prepare("INSERT INTO settings VALUES('paused',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify(value));
      this.audit('operator', 'admission.pause', 'service', { paused: value });
    });
  }
  totals(projectId, period, service = false) {
    return this.db.prepare(`SELECT COUNT(*) AS requests, COALESCE(SUM(tokens),0) AS settled_tokens,
      COALESCE(SUM(reserved),0) AS reserved_tokens, COALESCE(SUM(CASE WHEN tokens IS NULL AND reserved>0 THEN 1 ELSE 0 END),0) AS unresolved
      FROM requests WHERE ${service ? 'service_period=?' : 'project_id=? AND period=?'}`).get(...(service ? [period] : [projectId, period]));
  }
  status(projectId) {
    const project = this.project(projectId);
    requireValue(project, 'Unknown project');
    const period = periodFor(this.clock(), project.policy.timezone);
    return { project, period, ...this.totals(projectId, period),
      active: this.db.prepare('SELECT COUNT(*) AS count FROM requests WHERE project_id=? AND active=1').get(projectId).count,
      outstanding_all_periods: this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(reserved),0) AS reserved_tokens FROM requests WHERE project_id=? AND tokens IS NULL').get(projectId),
      uncertainty: 'Usage is observed at the backend response boundary; internal attempts may be hidden.',
      observed_at: this.clock(), paused: this.paused() };
  }
  admit(principal, route, protocol, config) {
    return this.transaction(() => {
      const project = this.project(principal.project_id);
      const policy = project.policy;
      if (this.paused() || !policy.enabled) throw new ServiceError(403, 'admission_paused', 'New work is paused', project.id);
      if (!policy.routes.includes(route.id)) throw new ServiceError(403, 'route_forbidden', 'Route is not authorized', project.id);
      const now = this.clock();
      const period = periodFor(now, policy.timezone);
      const servicePeriod = periodFor(now);
      const reservation = policy.token_estimate;
      const projectTotals = this.totals(project.id, period);
      const serviceTotals = this.totals(null, servicePeriod, true);
      const active = this.db.prepare('SELECT COUNT(*) AS count FROM requests WHERE active=1').get().count;
      const projectActive = this.db.prepare('SELECT COUNT(*) AS count FROM requests WHERE project_id=? AND active=1').get(project.id).count;
      const rate = this.db.prepare('SELECT COUNT(*) AS count FROM requests WHERE project_id=? AND created>?').get(project.id, now - 60000).count;
      if (active >= config.concurrency || projectActive >= policy.concurrency) throw new ServiceError(429, 'local_capacity_exhausted', 'Active request limit reached', project.id, true);
      if (rate >= policy.requests_per_minute || projectTotals.requests >= policy.daily_requests || serviceTotals.requests >= config.daily_requests) throw new ServiceError(429, 'local_quota_exhausted', 'Local request allowance exhausted', project.id, true);
      if ((policy.token_mode === 'estimate' && projectTotals.settled_tokens + projectTotals.reserved_tokens + reservation > policy.daily_tokens)
        || serviceTotals.settled_tokens + serviceTotals.reserved_tokens + reservation > config.daily_tokens) {
        throw new ServiceError(429, 'local_quota_exhausted', 'Estimated token allowance exhausted', project.id, true);
      }
      const id = randomUUID();
      const record = { id, principal_id: principal.id, project_id: project.id, period, service_period: servicePeriod,
        policy_revision: project.revision, policy, route: { id: route.id, profile: route.profile, account_id: route.account_id ?? null,
          account_attribution: route.account_id ? 'verified_exclusive_partition' : 'unknown', base_url: route.base_url },
        protocol, created: now, admission: 'admitted', execution: 'pending', delivery: 'not_started', accounting: 'reserved',
        capture: policy.recording === 'metadata' ? 'disabled_by_policy' : 'pending', attempt_id: randomUUID(),
        attempt_visibility: 'request_only', usage: null, error: null, cancellation_requested: false };
      this.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,1,?,NULL,?)').run(id, project.id, period, servicePeriod, now, reservation, JSON.stringify(record));
      this.db.prepare('INSERT INTO captures VALUES(?,?)').run(id, JSON.stringify({ request_id: id, boundary: 'client_application_body',
        excluded: ['authentication_headers', 'upstream_translation', 'remote_referenced_bytes', 'network_packets'],
        recording: policy.recording, state: record.capture, bytes: 0, chunks: 0, response_status: null, content_type: null }));
      this.ledger(`${id}:reserve`, record, 'reservation', reservation);
      return record;
    });
  }
  ledger(id, record, kind, amount, data = {}) {
    this.db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?,?)').run(id, record.id, record.project_id, kind, amount, this.clock(), JSON.stringify(data));
  }
  request(id) { return decode(this.db.prepare('SELECT data FROM requests WHERE id=?').get(id)); }
  update(id, patch) {
    const record = this.request(id);
    requireValue(record, 'Unknown request');
    Object.assign(record, patch);
    this.db.prepare('UPDATE requests SET data=? WHERE id=?').run(JSON.stringify(record), id);
    return record;
  }
  requests(projectId, after = 0) {
    return this.db.prepare('SELECT data FROM requests WHERE project_id=? AND created>=? ORDER BY created DESC LIMIT 200').all(projectId, after).map(decode);
  }
  dispatch(id, model) {
    return this.transaction(() => {
      const record = this.update(id, { execution: 'dispatched', requested_model: model, dispatched_at: this.clock() });
      this.ledger(`${id}:dispatch`, record, 'dispatch_intent', 0);
      return record;
    });
  }
  settle(id, observation, patch = {}) {
    return this.transaction(() => {
      const current = this.request(id);
      if (current.finished_at) return current;
      const tokens = observation?.total ?? null;
      const record = this.update(id, { ...patch, usage: observation ?? null, finished_at: this.clock(),
        accounting: tokens === null ? 'reconciliation_required' : 'settled' });
      this.db.prepare('UPDATE requests SET active=0,tokens=?,reserved=CASE WHEN ? IS NULL THEN reserved ELSE 0 END WHERE id=?').run(tokens, tokens, id);
      this.ledger(`${id}:settle`, record, tokens === null ? 'unknown_usage' : 'settlement', tokens ?? 0, { unknown: tokens === null, observation });
      this.db.prepare('INSERT INTO outbox(created,request_id,event) VALUES(?,?,?)').run(this.clock(), id, JSON.stringify({ type: 'request.finished', request: record }));
      return record;
    });
  }
  resolve(id, tokens, reason) {
    requireValue(Number.isSafeInteger(tokens) && tokens >= 0 && typeof reason === 'string' && reason.trim().length > 0, 'Nonnegative tokens and a reason are required');
    return this.transaction(() => {
      const record = this.request(id);
      requireValue(record?.finished_at && record.accounting === 'reconciliation_required', 'Only finished unresolved requests can be reconciled');
      this.db.prepare('UPDATE requests SET tokens=?,reserved=0 WHERE id=?').run(tokens, id);
      this.ledger(randomUUID(), record, 'operator_adjustment', tokens, { reason });
      this.audit('operator', 'usage.resolve', id, { tokens, reason });
      return this.update(id, { accounting: 'settled', usage: { total: tokens, source: 'operator_adjustment', reason } });
    });
  }
  recover() {
    const unfinished = this.db.prepare('SELECT id FROM requests WHERE active=1').all();
    for (const { id } of unfinished) {
      const record = this.request(id);
      this.captureState(id, record.capture === 'disabled_by_policy' ? record.capture : 'partial');
      this.settle(id, record.execution === 'pending' ? { total: 0, source: 'not_dispatched' } : null,
        { execution: record.execution === 'pending' ? 'failed' : 'outcome_unknown', delivery: 'client_disconnected', error: 'service_restart' });
    }
    return unfinished.length;
  }
  manifest(id) { return decode(this.db.prepare('SELECT data FROM captures WHERE request_id=?').get(id)); }
  captureState(id, state, patch = {}) {
    const manifest = { ...this.manifest(id), ...patch, state };
    this.db.prepare('UPDATE captures SET data=? WHERE request_id=?').run(JSON.stringify(manifest), id);
    this.update(id, { capture: state });
    return manifest;
  }
  append(id, direction, payload) {
    return this.transaction(() => {
      const manifest = this.manifest(id);
      if (manifest.recording === 'metadata' || ['partial', 'failed'].includes(manifest.state)) return;
      const used = this.db.prepare('SELECT bytes FROM archive_usage WHERE id=1').get().bytes;
      if (used + payload.length > this.archiveMaxBytes) throw new ServiceError(507, 'recording_failed', 'Archive capacity exhausted');
      const sequence = this.db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE request_id=? AND direction=?').get(id, direction).count;
      this.db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?,?)').run(id, direction, sequence, payload, digest(payload), this.clock());
      this.db.prepare('UPDATE archive_usage SET bytes=bytes+? WHERE id=1').run(payload.length);
      manifest.bytes += payload.length;
      manifest.chunks += 1;
      this.db.prepare('UPDATE captures SET data=? WHERE request_id=?').run(JSON.stringify(manifest), id);
    });
  }
  captured(id) {
    const manifest = this.manifest(id);
    const chunks = this.db.prepare('SELECT direction,sequence,payload,hash,created FROM chunks WHERE request_id=? ORDER BY direction,sequence').all(id).map(row => {
      const payload = Buffer.from(row.payload);
      if (digest(payload) !== row.hash) throw new ServiceError(500, 'capture_integrity_failed', 'Archive integrity verification failed');
      return { ...row, payload: payload.toString('base64') };
    });
    return { manifest, chunks };
  }
  deleteCapture(id, expired = false) {
    return this.transaction(() => {
      const record = this.request(id);
      requireValue(record?.finished_at, 'Only finished captures can be removed');
      const manifest = this.manifest(id);
      this.db.prepare('DELETE FROM chunks WHERE request_id=?').run(id);
      this.db.prepare('UPDATE archive_usage SET bytes=bytes-? WHERE id=1').run(manifest.bytes);
      this.audit('operator', expired ? 'capture.expire' : 'capture.delete', id);
      return this.captureState(id, expired ? 'expired' : 'deleted', { bytes: 0, chunks: 0 });
    });
  }
}
