import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceError, requireValue } from './errors.js';
import { JsonlLogs } from './jsonl.js';
import { operations } from './store-operations.js';
import { validatePolicy, periodFor, validateScopes, DEFAULT_SCOPES } from './config.js';

export const digest = value => createHash('sha256').update(value).digest('hex');
const decode = row => row ? JSON.parse(row.data) : null;

export class Store {
  constructor(directory, { clock = Date.now, archiveMaxBytes = 1073741824 } = {}) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'router4u.sqlite');
    this.db = new DatabaseSync(this.path);
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    const hasTables = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get();
    if (version !== 3 && (version !== 0 || hasTables)) { this.db.close(); throw new Error('Unsupported database schema; automatic conversion is not available'); }
    chmodSync(this.path, 0o600);
    this.logs = new JsonlLogs(join(directory, 'logs'));
    this.pendingLogs = null;
    this.activeRecords = new Map();
    this.captureDetails = new Map();
    this.logFailures = 0;
    this.clock = clock;
    this.archiveMaxBytes = archiveMaxBytes;
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    if (version === 0) this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE projects(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE principals(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), hash TEXT UNIQUE NOT NULL, enabled INTEGER NOT NULL);
      CREATE TABLE policies(revision TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE requests(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, period TEXT NOT NULL, service_period TEXT NOT NULL, created INTEGER NOT NULL, active INTEGER NOT NULL, reserved INTEGER NOT NULL, tokens INTEGER, data TEXT NOT NULL);
      CREATE INDEX requests_project_period ON requests(project_id,period);
      CREATE INDEX requests_created ON requests(created);
      CREATE INDEX requests_service_period ON requests(service_period);
      CREATE INDEX requests_route ON requests(json_extract(data,'$.route.id'));
      CREATE INDEX requests_account ON requests(json_extract(data,'$.route.account_id'));
      CREATE INDEX requests_occupancy ON requests(json_extract(data,'$.occupancy'));
      CREATE TABLE ledger(id TEXT PRIMARY KEY, request_id TEXT, project_id TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE captures(request_id TEXT PRIMARY KEY REFERENCES requests(id), data TEXT NOT NULL);
      CREATE TABLE archive_usage(id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL);
      INSERT OR IGNORE INTO archive_usage VALUES(1,0);
      CREATE TABLE settings(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE principal_scopes(principal_id TEXT PRIMARY KEY REFERENCES principals(id), data TEXT NOT NULL);
      CREATE TABLE configuration_revisions(revision TEXT PRIMARY KEY, created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE accounts(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE usage_observations(source TEXT NOT NULL,event_id TEXT NOT NULL,request_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(source,event_id));
      CREATE TABLE budget_definitions(scope TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,id));
      CREATE TABLE budget_bookings(request_id TEXT NOT NULL,scope TEXT NOT NULL,budget_id TEXT NOT NULL,period TEXT NOT NULL,created INTEGER NOT NULL,resource TEXT NOT NULL,reserved INTEGER NOT NULL,amount INTEGER,PRIMARY KEY(request_id,scope,budget_id));
      CREATE INDEX budgets_scope ON budget_bookings(scope,budget_id,period,created);
      PRAGMA user_version=3; COMMIT;`);
    for (const row of this.db.prepare('SELECT request_id,data FROM captures').all()) {
      const manifest = decode(row);
      if (!this.logs.reconcileExchange(row.request_id, manifest.chunks)) {
        this.captureState(row.request_id, 'partial');
      }
    }
  }

  close() { this.db.close(); }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    this.pendingLogs = [];
    this.rollbackFiles = [];
    const previous = new Map(this.activeRecords);
    const previousDetails = new Map(this.captureDetails);
    let result, logs;
    try { result = work(); this.db.exec('COMMIT'); logs = this.pendingLogs; }
    catch (error) { this.db.exec('ROLLBACK'); for (const undo of this.rollbackFiles) { try { undo(); } catch { this.logFailures++; } } this.activeRecords = previous; this.captureDetails = previousDetails; throw error; }
    finally { this.pendingLogs = null; this.rollbackFiles = null; }
    // Accounting commits independently of analysis logs. Log failures never replay work.
    for (const write of logs) this.writeLog(write);
    return result;
  }
  writeLog(write) {
    if (this.pendingLogs) { this.pendingLogs.push(write); return; }
    try { write(); }
    catch { this.logFailures++; process.stderr.write('JSONL analysis log write failed; operational state remains committed\n'); }
  }
  operational(record) {
    const keys = ['id', 'principal_id', 'project_id', 'period', 'service_period', 'created', 'policy_revision', 'policy', 'service_limits', 'route', 'protocol', 'execution', 'occupancy', 'accounting', 'usage', 'capture', 'dispatched_at', 'finished_at'];
    return Object.fromEntries(keys.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
  }
  audit(actor, operation, target, data = {}) {
    const row = { created: this.clock(), actor, operation, target, data: JSON.stringify(data) };
    this.writeLog(() => this.logs.event('audit', row));
  }
  event(id, event) {
    const row = { created: this.clock(), request_id: id, event: JSON.stringify(event) };
    this.writeLog(() => this.logs.event('events', row));
  }
  project(id) { return decode(this.db.prepare('SELECT data FROM projects WHERE id=?').get(id)); }
  projects() { return this.db.prepare('SELECT data FROM projects ORDER BY id').all().map(decode); }
  putProject(id, input) {
    requireValue(/^[a-zA-Z0-9_-]{1,64}$/.test(id), 'Invalid project ID');
    const policy = validatePolicy(input);
    return this.transaction(() => {
      this.ensureBudgetDefinitions(id, policy.budgets);
      const revision = randomUUID();
      const project = { id, policy, revision };
      this.db.prepare('INSERT INTO policies VALUES(?,?,?)').run(revision, id, JSON.stringify(policy));
      this.db.prepare('INSERT INTO projects VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(project));
      this.audit('operator', 'project.policy', id, { revision });
      return project;
    });
  }
  issueKey(projectId, scopes = DEFAULT_SCOPES) {
    validateScopes(scopes);
    requireValue(this.project(projectId), 'Unknown project');
    const key = `r4u_${randomBytes(32).toString('base64url')}`;
    const id = randomUUID();
    this.transaction(() => {
      this.db.prepare('INSERT INTO principals VALUES(?,?,?,1)').run(id, projectId, digest(key));
      this.db.prepare('INSERT INTO principal_scopes VALUES(?,?)').run(id, JSON.stringify(scopes));
      this.audit('operator', 'principal.issue', id, { project_id: projectId, scopes });
    });
    return { principal_id: id, project_id: projectId, key, scopes };
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
    principal.scopes = decode(this.db.prepare('SELECT data FROM principal_scopes WHERE principal_id=?').get(principal.id));
    try { validateScopes(principal.scopes); }
    catch { throw new ServiceError(401, 'authentication_failed', 'Project credential has invalid scope metadata'); }
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
      additional_budgets: this.budgetStatus(projectId, project.policy.budgets),
      provider_quota_snapshots: this.accounts().filter(account => account.configured && project.policy.routes.includes(account.route_id)).map(account => ({ account_id: account.id, quota: account.observation?.quota ?? { status: 'unavailable', observed_at: null, source: null } })),
      observed_at: this.clock(), paused: this.paused() };
  }
  admit(principal, route, protocol, config, metadata = {}) {
    return this.transaction(() => {
      const project = this.project(principal.project_id);
      const policy = project.policy;
      if (this.paused() || !policy.enabled) throw new ServiceError(403, 'admission_paused', 'New work is paused', project.id);
      if (!policy.routes.includes(route.id)) throw new ServiceError(403, 'route_forbidden', 'Route is not authorized', project.id);
      const now = this.clock();
      const period = periodFor(now, policy.timezone);
      const servicePeriod = periodFor(now);
      const reservation = policy.token_estimate;
      this.checkAdditionalLimits(project, route, config, reservation, now);
      const projectTotals = this.totals(project.id, period);
      const serviceTotals = this.totals(null, servicePeriod, true);
      const active = this.db.prepare('SELECT COUNT(*) AS count FROM requests WHERE active=1').get().count;
      const projectActive = this.db.prepare('SELECT COUNT(*) AS count FROM requests WHERE project_id=? AND active=1').get(project.id).count;
      const rate = this.db.prepare('SELECT COUNT(*) AS count FROM requests WHERE project_id=? AND created>?').get(project.id, now - 60000).count;
      if ((config.concurrency != null && active >= config.concurrency) || (policy.concurrency != null && projectActive >= policy.concurrency)) throw new ServiceError(429, 'local_capacity_exhausted', 'Active request limit reached', project.id, true);
      if ((policy.requests_per_minute != null && rate >= policy.requests_per_minute) || (policy.daily_requests != null && projectTotals.requests >= policy.daily_requests) || (config.daily_requests != null && serviceTotals.requests >= config.daily_requests)) throw new ServiceError(429, 'local_quota_exhausted', 'Local request allowance exhausted', project.id, true);
      if ((policy.token_mode === 'estimate' && policy.daily_tokens != null && projectTotals.settled_tokens + projectTotals.reserved_tokens + reservation > policy.daily_tokens)
        || (config.daily_tokens != null && serviceTotals.settled_tokens + serviceTotals.reserved_tokens + reservation > config.daily_tokens)) {
        throw new ServiceError(429, 'local_quota_exhausted', 'Estimated token allowance exhausted', project.id, true);
      }
      const id = randomUUID();
      const record = { ...metadata, id, principal_id: principal.id, project_id: project.id, period, service_period: servicePeriod,
        policy_revision: project.revision, policy, service_limits: { archive_max_bytes: config.archive_max_bytes, max_response_bytes: config.max_response_bytes }, configuration_revision: config.revision ?? null, route: { id: route.id, profile: route.profile, account_id: route.account_id ?? null,
          account_attribution: route.account_id ? 'verified_exclusive_partition' : 'unknown', base_url: route.base_url },
        occupancy: 'local', capture_ms: 0, protocol, created: now, admission: 'admitted', execution: 'pending', delivery: 'not_started', accounting: 'reserved',
        capture: policy.recording === 'metadata' ? 'disabled_by_policy' : 'pending', attempt_id: randomUUID(),
        attempt_visibility: 'request_only', usage: null, error: null, cancellation_requested: false };
      this.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,1,?,NULL,?)').run(id, project.id, period, servicePeriod, now, reservation, JSON.stringify(this.operational(record)));
      record.cursor = Number(this.db.prepare('SELECT rowid FROM requests WHERE id=?').get(id).rowid);
      this.activeRecords.set(id, record);
      this.writeLog(() => this.logs.append(`requests/${id}`, { type: 'request', request: record }));
      this.db.prepare('INSERT INTO captures VALUES(?,?)').run(id, JSON.stringify({ request_id: id, boundary: 'client_application_body',
        excluded: ['authentication_headers', 'upstream_translation', 'remote_referenced_bytes', 'network_packets'],
        expires_at: policy.retention_days ? now + policy.retention_days * 86400000 : null, recording: policy.recording, state: record.capture, bytes: 0, chunks: 0, response_status: null, content_type: null }));
      this.bookBudgets(record, config, reservation);
      this.ledger(`${id}:reserve`, record, 'reservation', reservation);
      return record;
    });
  }
  ledger(id, record, kind, amount, data = {}) {
    this.db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?,?)').run(id, record.id, record.project_id, kind, amount, this.clock(), JSON.stringify(data));
  }
  request(id) {
    const row = this.db.prepare('SELECT data,active FROM requests WHERE id=?').get(id);
    if (!row) return null;
    const operational = decode(row);
    const logged = this.activeRecords.get(id) ?? this.logs.request(id);
    const record = { ...logged, ...operational, ...(logged ? {} : { history_unavailable: true }) };
    if (row.active) this.activeRecords.set(id, record);
    return record;
  }
  update(id, patch) {
    let record = this.request(id);
    requireValue(record, 'Unknown request');
    record = { ...record, ...patch };
    this.db.prepare('UPDATE requests SET data=? WHERE id=?').run(JSON.stringify(this.operational(record)), id);
    if (this.db.prepare('SELECT active FROM requests WHERE id=?').get(id).active) this.activeRecords.set(id, record);
    else this.activeRecords.delete(id);
    this.writeLog(() => this.logs.append(`requests/${id}`, { type: 'update', patch }));
    return record;
  }
  requests(projectId, after = 0) {
    return this.logHistory(projectId).filter(record => record.created >= after).sort((a, b) => b.created - a.created).slice(0, 200);
  }
  dispatch(id, model) {
    return this.transaction(() => {
      const record = this.update(id, { execution: 'dispatched', requested_model: model, resolved_model: model, dispatched_at: this.clock() });
      this.ledger(`${id}:dispatch`, record, 'dispatch_intent', 0);
      return record;
    });
  }
  settle(id, observation, patch = {}) {
    return this.transaction(() => {
      const current = this.request(id);
      if (current.finished_at) return current;
      const tokens = observation?.total ?? null;
      const record = this.update(id, { ...patch, usage: observation ? { ...observation, scope: 'request', observed_at: this.clock() } : null, finished_at: this.clock(),
        occupancy: patch.execution === 'outcome_unknown' ? 'uncertain' : 'released',
        accounting: tokens === null ? 'reconciliation_required' : 'settled' });
      this.db.prepare('UPDATE requests SET active=0,tokens=?,reserved=CASE WHEN ? IS NULL THEN reserved ELSE 0 END WHERE id=?').run(tokens, tokens, id);
      this.settleBudgets(id, tokens);
      if (observation) this.db.prepare('INSERT OR IGNORE INTO usage_observations VALUES(?,?,?,?)').run(observation.source ?? 'backend_response', id, id, JSON.stringify(record.usage));
      this.ledger(`${id}:settle`, record, tokens === null ? 'unknown_usage' : 'settlement', tokens ?? 0, { unknown: tokens === null, observation });
      this.event(id, { type: 'request.finished', request: record });
      this.writeLog(() => { this.activeRecords.delete(id); this.captureDetails.delete(id); });
      return record;
    });
  }
  resolve(id, tokens, reason) {
    requireValue(Number.isSafeInteger(tokens) && tokens >= 0 && typeof reason === 'string' && reason.trim().length > 0, 'Nonnegative tokens and a reason are required');
    return this.transaction(() => {
      const record = this.request(id);
      requireValue(record?.finished_at && record.accounting === 'reconciliation_required', 'Only finished unresolved requests can be reconciled');
      this.db.prepare('UPDATE requests SET tokens=?,reserved=0 WHERE id=?').run(tokens, id);
      this.settleBudgets(id, tokens);
      this.ledger(randomUUID(), record, 'operator_adjustment', tokens, { reason });
      this.audit('operator', 'usage.resolve', id, { tokens, reason });
      const updated = this.update(id, { accounting: 'settled', usage: { total: tokens, source: 'operator_adjustment', scope: 'request', completeness: 'operator_resolved', observed_at: this.clock(), reason } });
      this.event(id, { type: 'usage.resolved', request: updated });
      this.writeLog(() => { this.activeRecords.delete(id); this.captureDetails.delete(id); });
      return updated;
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
  captureControl(manifest) {
    return Object.fromEntries(['request_id', 'boundary', 'excluded', 'expires_at', 'recording', 'state', 'bytes', 'chunks', 'sequences'].filter(key => manifest[key] !== undefined).map(key => [key, manifest[key]]));
  }
  manifest(id) {
    const control = decode(this.db.prepare('SELECT data FROM captures WHERE request_id=?').get(id));
    if (!control) return null;
    let details = this.captureDetails.get(id);
    if (!details) { details = {}; for (const row of this.logs.read(`requests/${id}`)) if (row.type === 'manifest') Object.assign(details, row.patch); }
    if (this.activeRecords.has(id)) this.captureDetails.set(id, details);
    return { ...details, ...control };
  }
  captureState(id, state, patch = {}) {
    const manifest = { ...this.manifest(id), ...patch, state };
    this.db.prepare('UPDATE captures SET data=? WHERE request_id=?').run(JSON.stringify(this.captureControl(manifest)), id);
    this.captureDetails.set(id, { ...manifest });
    this.writeLog(() => this.logs.append(`requests/${id}`, { type: 'manifest', patch: manifest }));
    this.update(id, { capture: state });
    if (!this.db.prepare('SELECT active FROM requests WHERE id=?').get(id).active) this.writeLog(() => this.captureDetails.delete(id));
    return manifest;
  }
  append(id, direction, payload) {
    return this.transaction(() => {
      const manifest = this.manifest(id);
      if (manifest.recording === 'metadata' || ['partial', 'failed'].includes(manifest.state)) return;
      const used = this.db.prepare('SELECT bytes FROM archive_usage WHERE id=1').get().bytes;
      const record = this.request(id);
      if (used + payload.length > (record.service_limits?.archive_max_bytes ?? this.archiveMaxBytes)) throw new ServiceError(507, 'recording_failed', 'Archive capacity exhausted');
      if (record.policy.archive_max_bytes) {
        const projectBytes = this.db.prepare("SELECT COALESCE(SUM(json_extract(c.data,'$.bytes')),0) AS bytes FROM captures c JOIN requests r ON r.id=c.request_id WHERE r.project_id=?").get(record.project_id).bytes;
        if (projectBytes + payload.length > record.policy.archive_max_bytes) throw new ServiceError(507, 'recording_failed', 'Project archive capacity exhausted');
      }
      const sequence = manifest.sequences?.[direction] ?? 0;
      const committedChunks = manifest.chunks;
      this.rollbackFiles.push(() => this.logs.reconcileExchange(id, committedChunks));
      this.logs.append(`exchanges/${id}`, { direction, sequence, payload: Buffer.from(payload).toString('base64'), hash: digest(payload), created: this.clock() });
      manifest.sequences = { ...manifest.sequences, [direction]: sequence + 1 };
      this.db.prepare('UPDATE archive_usage SET bytes=bytes+? WHERE id=1').run(payload.length);
      manifest.bytes += payload.length;
      manifest.chunks += 1;
      this.db.prepare('UPDATE captures SET data=? WHERE request_id=?').run(JSON.stringify(this.captureControl(manifest)), id);
    });
  }
  captured(id) {
    const manifest = this.manifest(id);
    const chunks = [];
    if (!['deleted', 'expired'].includes(manifest.state)) for (const row of this.logs.read(`exchanges/${id}`)) {
      const payload = Buffer.from(row.payload, 'base64');
      if (digest(payload) !== row.hash) throw new ServiceError(500, 'capture_integrity_failed', 'Archive integrity verification failed');
      chunks.push(row);
    }
    if (chunks.length !== manifest.chunks) throw new ServiceError(500, 'capture_integrity_failed', 'Archive integrity verification failed');
    chunks.sort((a, b) => a.direction.localeCompare(b.direction) || a.sequence - b.sequence);
    return { manifest, chunks };
  }
  deleteCapture(id, expired = false) {
    return this.transaction(() => {
      const record = this.request(id);
      requireValue(record?.finished_at, 'Only finished captures can be removed');
      const manifest = this.manifest(id);
      if (['deleted', 'expired'].includes(manifest.state)) return manifest;
      this.logs.removeExchange(id);
      this.db.prepare('UPDATE archive_usage SET bytes=bytes-? WHERE id=1').run(manifest.bytes);
      this.audit('operator', expired ? 'capture.expire' : 'capture.delete', id);
      return this.captureState(id, expired ? 'expired' : 'deleted', { bytes: 0, chunks: 0 });
    });
  }
}

Object.assign(Store.prototype, operations);
