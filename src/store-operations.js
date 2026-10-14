import { randomUUID } from 'node:crypto';
import { ServiceError, requireValue } from './errors.js';
import { periodFor } from './config.js';

const decode = row => row ? JSON.parse(row.data) : null;
const budgetKey = (budget, now) => budget.period === 'rolling' ? 'rolling' : periodFor(now, budget.timezone ?? 'UTC').slice(0, budget.period === 'month' ? 7 : 10);
export const operations = {
  configuration(config) {
    const current = decode(this.db.prepare("SELECT data FROM settings WHERE id='configuration'").get());
    if (current && JSON.stringify(current.config) === JSON.stringify(config)) return current;
    return this.transaction(() => {
      this.ensureBudgetDefinitions('*', config.budgets);
      for (const account of config.accounts) { const previous = this.account(account.id);
        requireValue(!previous || (previous.route_id === account.route_id && previous.credential_name === account.credential_name), 'Account identity is immutable; create a new account ID');
      }
      const snapshot = { revision: randomUUID(), applied_at: this.clock(), config };
      this.db.prepare('INSERT INTO configuration_revisions VALUES(?,?,?)').run(snapshot.revision, snapshot.applied_at, JSON.stringify(config));
      this.db.prepare("INSERT INTO settings VALUES('configuration',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify(snapshot));
      for (const account of config.accounts) {
        const previous = this.account(account.id);
        this.db.prepare('INSERT INTO accounts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(account.id, JSON.stringify({ ...previous, ...account, lifecycle_owner: 'CLIProxyAPI', configured: true }));
      }
      for (const account of this.accounts()) if (!config.accounts.some(item => item.id === account.id)) {
        this.db.prepare('UPDATE accounts SET data=? WHERE id=?').run(JSON.stringify({ ...account, configured: false, enabled: false }), account.id);
      }
      this.audit('operator', 'configuration.apply', snapshot.revision);
      return snapshot;
    });
  },
  accounts() { return this.db.prepare('SELECT data FROM accounts ORDER BY id').all().map(decode); },
  account(id) { return decode(this.db.prepare('SELECT data FROM accounts WHERE id=?').get(id)); },
  accountObservation(id, observation) {
    const account = this.account(id); requireValue(account, 'Unknown account');
    const next = { ...account, observation: { ...observation, observed_at: this.clock() } };
    this.db.prepare('UPDATE accounts SET data=? WHERE id=?').run(JSON.stringify(next), id);
    return next;
  },
  history(projectId, { cursor = 0, limit = 100, from = 0, to = this.clock() } = {}) {
    requireValue([cursor, limit, from, to].every(Number.isSafeInteger) && cursor >= 0 && limit >= 1 && limit <= 200 && from >= 0 && to >= from, 'Invalid history query');
    const rows = this.db.prepare('SELECT rowid AS cursor,data FROM requests WHERE project_id=? AND rowid>? AND created>=? AND created<=? ORDER BY rowid LIMIT ?').all(projectId, cursor, from, to, limit + 1);
    const more = rows.length > limit; const page = rows.slice(0, limit);
    return { items: page.map(row => ({ cursor: row.cursor, ...JSON.parse(row.data) })), next_cursor: more ? page.at(-1).cursor : null, observed_at: this.clock(), collection_gap: 'Backend internal attempts are not observable' };
  },
  usageHistory(projectId, from = 0, to = this.clock()) {
    requireValue(Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to >= from, 'Invalid usage interval');
    return { periods: this.db.prepare(`SELECT period,COUNT(*) AS requests,SUM(tokens) AS settled_tokens,SUM(reserved) AS reserved_tokens,
      SUM(CASE WHEN tokens IS NULL THEN 1 ELSE 0 END) AS provisional_or_unknown FROM requests WHERE project_id=? AND created>=? AND created<=? GROUP BY period ORDER BY period`).all(projectId, from, to),
      observed_at: this.clock(), provider_quota: { status: 'unavailable', source: null, observed_at: null }, completeness: 'request_only' };
  },
  occupancy() { return this.db.prepare("SELECT data FROM requests WHERE json_extract(data,'$.occupancy')='uncertain' ORDER BY created LIMIT 200").all().map(decode); },
  releaseOccupancy(id, reason) {
    requireValue(typeof reason === 'string' && reason.trim().length > 0 && reason.length <= 2000, 'Evidence/reason required');
    return this.transaction(() => {
      const record = this.request(id); requireValue(record?.finished_at && record.occupancy === 'uncertain', 'Only uncertain finished occupancy can be released');
      this.audit('operator', 'occupancy.release', id, { reason });
      return this.update(id, { occupancy: 'operator_released', occupancy_resolution: { reason, observed_at: this.clock() } });
    });
  },
  checkAdditionalLimits(project, route, config, reservation, now) {
    if (route.enabled === false) throw new ServiceError(403, 'route_disabled', 'Route is disabled');
    const account = route.account_id ? this.account(route.account_id) : null;
    if (account && (!account.configured || account.enabled === false)) throw new ServiceError(503, 'account_unavailable', 'Account is disabled');
    const occupied = (field, id) => this.db.prepare(`SELECT COUNT(*) AS count FROM requests WHERE json_extract(data,'$.route.${field}')=? AND (active=1 OR json_extract(data,'$.occupancy')='uncertain')`).get(id).count;
    if ((route.concurrency && occupied('id', route.id) >= route.concurrency) ||
        (account?.concurrency && occupied('account_id', account.id) >= account.concurrency)) {
      throw new ServiceError(429, 'local_capacity_exhausted', 'Route or account occupancy exhausted; inspect uncertain work');
    }
    const sums = scope => this.db.prepare(`SELECT COUNT(*) AS requests,COALESCE(SUM(COALESCE(tokens,reserved)),0) AS tokens FROM requests WHERE created>? ${scope ? 'AND project_id=?' : ''}`).get(...(scope ? [now - 60000, scope] : [now - 60000]));
    for (const [scope, limits] of [[project.id, project.policy], [null, config]]) {
      const rate = sums(scope);
      if ((limits.requests_per_minute && rate.requests >= limits.requests_per_minute) || (limits.tokens_per_minute && limits.token_mode !== 'observe' && rate.tokens + reservation > limits.tokens_per_minute)) {
        throw new ServiceError(429, 'local_quota_exhausted', 'Rolling rate allowance exhausted', scope ?? 'service', true);
      }
      for (const budget of limits.budgets ?? []) {
        if (budget.mode === 'observe') continue;
        const scopeId = scope ?? '*'; const key = budgetKey(budget, now);
        const row = this.db.prepare(`SELECT COALESCE(SUM(COALESCE(amount,reserved)),0) AS amount FROM budget_bookings WHERE scope=? AND budget_id=? AND period=? ${budget.period === 'rolling' ? 'AND created>?' : ''}`)
          .get(...[scopeId, budget.id, key, ...(budget.period === 'rolling' ? [now - budget.duration_ms] : [])]);
        if (row.amount + (budget.resource === 'tokens' ? reservation : 1) > budget.limit) throw new ServiceError(429, 'local_quota_exhausted', `Budget ${budget.id} exhausted`, scopeId, true);
      }
    }
  },
  validateBudgetDefinitions(scope, budgets) {
    for (const budget of budgets ?? []) {
      const definition = { resource: budget.resource, period: budget.period, duration_ms: budget.duration_ms ?? null, timezone: budget.timezone ?? 'UTC' };
      const previous = decode(this.db.prepare('SELECT data FROM budget_definitions WHERE scope=? AND id=?').get(scope, budget.id));
      requireValue(!previous || JSON.stringify(previous) === JSON.stringify(definition), 'Budget resource/period identity is immutable; choose a new ID for a new definition');
    }
  },
  ensureBudgetDefinitions(scope, budgets) {
    this.validateBudgetDefinitions(scope, budgets);
    for (const budget of budgets ?? []) {
      const definition = { resource: budget.resource, period: budget.period, duration_ms: budget.duration_ms ?? null, timezone: budget.timezone ?? 'UTC' };
      const previous = decode(this.db.prepare('SELECT data FROM budget_definitions WHERE scope=? AND id=?').get(scope, budget.id));
      requireValue(!previous || JSON.stringify(previous) === JSON.stringify(definition), 'Budget resource/period identity is immutable; choose a new ID for a new definition');
      if (previous) continue;
      this.db.prepare('INSERT INTO budget_definitions VALUES(?,?,?)').run(scope, budget.id, JSON.stringify(definition));
      const rows = this.db.prepare(`SELECT id,created,reserved,tokens,active,data FROM requests ${scope === '*' ? '' : 'WHERE project_id=?'}`).all(...(scope === '*' ? [] : [scope]));
      for (const row of rows) this.db.prepare('INSERT OR IGNORE INTO budget_bookings VALUES(?,?,?,?,?,?,?,?)').run(row.id, scope, budget.id, budgetKey(budget, row.created), row.created, budget.resource, budget.resource === 'tokens' ? row.reserved : 1, budget.resource === 'tokens' ? row.tokens : budget.resource === 'observed_attempts' ? (JSON.parse(row.data).dispatched_at ? 1 : row.active ? null : 0) : 1);
    }
  },
  budgetStatus(scope, budgets = []) {
    const now = this.clock();
    return budgets.map(budget => {
      const period = budgetKey(budget, now);
      const totals = this.db.prepare(`SELECT COALESCE(SUM(amount),0) AS settled,COALESCE(SUM(CASE WHEN amount IS NULL THEN reserved ELSE 0 END),0) AS reserved FROM budget_bookings WHERE scope=? AND budget_id=? AND period=? ${budget.period === 'rolling' ? 'AND created>?' : ''}`)
        .get(...[scope, budget.id, period, ...(budget.period === 'rolling' ? [now - budget.duration_ms] : [])]);
      return { ...budget, booking_period: period, ...totals, remaining: budget.limit - totals.settled - totals.reserved, observed_at: now };
    });
  },
  bookBudgets(record, config, reservation) {
    for (const [scope, limits] of [[record.project_id, record.policy], ['*', config]]) for (const budget of limits.budgets ?? []) {
      this.db.prepare('INSERT INTO budget_bookings VALUES(?,?,?,?,?,?,?,NULL)').run(record.id, scope, budget.id, budgetKey(budget, record.created), record.created, budget.resource, budget.resource === 'tokens' ? reservation : 1);
    }
  },
  settleBudgets(id, tokens) {
    this.db.prepare("UPDATE budget_bookings SET amount=CASE WHEN resource='tokens' THEN ? WHEN resource='observed_attempts' THEN ? ELSE 1 END WHERE request_id=?").run(tokens, this.request(id).dispatched_at ? 1 : 0, id);
  },
  observeUsage(id, { source, event_id: eventId, tokens, reason }) {
    requireValue(typeof source === 'string' && /^[\w.-]{1,100}$/.test(source) && typeof eventId === 'string' && eventId.length > 0 && eventId.length <= 200, 'Stable source and event_id required');
    requireValue(Number.isSafeInteger(tokens) && tokens >= 0 && typeof reason === 'string' && reason.trim().length > 0 && reason.length <= 2000, 'Nonnegative tokens and evidence required');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT data FROM usage_observations WHERE source=? AND event_id=?').get(source, eventId);
      if (existing) { const observation = JSON.parse(existing.data); requireValue(observation.request_id === id && observation.total === tokens, 'Conflicting repeated observation'); return observation; }
      const record = this.request(id); requireValue(record?.finished_at, 'Only finished requests can receive reconciled observations');
      const observation = { request_id: id, source, event_id: eventId, scope: 'request', total: tokens, reason, observed_at: this.clock(), completeness: 'operator_verified_request_total' };
      const previous = this.db.prepare('SELECT tokens FROM requests WHERE id=?').get(id).tokens ?? 0;
      this.db.prepare('INSERT INTO usage_observations VALUES(?,?,?,?)').run(source, eventId, id, JSON.stringify(observation));
      this.db.prepare('UPDATE requests SET tokens=?,reserved=0 WHERE id=?').run(tokens, id);
      this.settleBudgets(id, tokens);
      this.ledger(randomUUID(), record, 'usage_correction', tokens - previous, observation);
      this.audit('operator', 'usage.observe', id, observation);
      this.update(id, { accounting: 'settled', usage: observation });
      this.db.prepare('INSERT INTO outbox(created,request_id,event) VALUES(?,?,?)').run(this.clock(), id, JSON.stringify({ type: 'usage.corrected', observation }));
      return observation;
    });
  },
  expireCaptures(limit = 100) {
    const rows = this.db.prepare(`SELECT r.id FROM requests r JOIN captures c ON c.request_id=r.id WHERE json_extract(r.data,'$.finished_at') IS NOT NULL
      AND json_extract(c.data,'$.expires_at')<=? AND json_extract(c.data,'$.state') NOT IN ('deleted','expired','disabled_by_policy') LIMIT ?`).all(this.clock(), limit);
    for (const row of rows) this.deleteCapture(row.id, true);
    return { expired: rows.length, observed_at: this.clock() };
  },
  metrics() {
    const totals = this.db.prepare('SELECT COUNT(*) AS requests,COALESCE(SUM(tokens),0) AS settled_tokens,COALESCE(SUM(reserved),0) AS reserved_tokens,SUM(active) AS active FROM requests').get();
    const archive = this.db.prepare('SELECT bytes FROM archive_usage WHERE id=1').get().bytes;
    return { ...totals, archive_bytes: archive, archive_capacity: this.archiveMaxBytes, uncertain_occupancy: this.db.prepare("SELECT COUNT(*) AS count FROM requests WHERE json_extract(data,'$.occupancy')='uncertain'").get().count,
      unknown_usage: this.db.prepare('SELECT COUNT(*) AS count FROM requests WHERE active=0 AND tokens IS NULL').get().count,
      latency: this.db.prepare("SELECT AVG(json_extract(data,'$.finished_at')-created) AS gateway_lifetime_ms,AVG(json_extract(data,'$.first_byte_at')-json_extract(data,'$.dispatched_at')) AS backend_first_byte_ms,AVG(json_extract(data,'$.capture_ms')) AS capture_ms FROM requests WHERE active=0").get(),
      observed_at: this.clock() };
  },
};
