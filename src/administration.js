import { BackendManagement } from './backend.js';
import { capabilities } from './config.js';
import { requireValue, ServiceError } from './errors.js';

export function historyQuery(url) {
  const result = {};
  for (const name of ['cursor', 'limit', 'from', 'to']) if (url.searchParams.has(name)) result[name] = Number(url.searchParams.get(name));
  return result;
}
export function requireScope(principal, scope) {
  if (!principal.scopes.includes(scope)) throw new ServiceError(403, 'scope_forbidden', `Credential requires ${scope}`);
}
export function effectivePolicy(store, config, projectId) {
  const project = store.project(projectId); requireValue(project, 'Unknown project');
  return { project, configuration_revision: config.revision,
    service: { concurrency: config.concurrency, daily_requests: config.daily_requests, daily_tokens: config.daily_tokens,
      requests_per_minute: config.requests_per_minute, tokens_per_minute: config.tokens_per_minute, budgets: config.budgets,
      archive_max_bytes: config.archive_max_bytes, max_request_bytes: config.max_request_bytes, max_response_bytes: config.max_response_bytes },
    routes: config.routes.filter(route => project.policy.routes.includes(route.id)).map(route => ({ id: route.id, enabled: route.enabled !== false, concurrency: route.concurrency ?? null, account_id: route.account_id ?? null, capabilities: capabilities(route) })),
    enforcement: { strict: ['local_request_counts', 'local_request_rates', 'local_active_requests'], estimate: ['tokens'],
      uncertain_occupancy: 'Retained for route/account capacity until explicit resolution', queue: 'disabled', retries: 'gateway_disabled',
      provider_quota: 'Passive backend header observations only; never inferred from local usage', cost_estimates: 'disabled' } };
}
export async function administration({ path, method, body, url, store, config, environment, routeFor, reload, reply, active }) {
  if (path === '/admin/config' && method === 'GET') { reply({ revision: config.revision, config }); return true; }
  if (path === '/admin/config/reload' && method === 'POST') { reply(reload(body.dry_run === true)); return true; }
  if (path === '/admin/config/revisions' && method === 'GET') { reply(store.db.prepare('SELECT revision,created FROM configuration_revisions ORDER BY created DESC LIMIT 200').all()); return true; }
  if (path === '/admin/accounts' && method === 'GET') { reply(store.accounts()); return true; }
  const accountPath = path.match(/^\/admin\/accounts\/([\w-]+)\/(inspect|disable|enable|remove|refresh|reconnect)$/);
  if (accountPath) {
    const account = store.account(accountPath[1]); requireValue(account?.configured, 'Unknown configured account');
    const route = routeFor(account.route_id); const backend = new BackendManagement(route, environment);
    const action = accountPath[2];
    if (action === 'inspect' && method === 'GET') {
      try {
        const inspection = await backend.inspect();
        const credential = (await backend.credentials()).find(item => item.name === account.credential_name);
        const drift = !credential || credential.disabled === (account.enabled !== false) || (route.account_id && (inspection.active_file_credentials.length !== 1 || inspection.configured_api_keys !== 0));
        reply(store.accountObservation(account.id, { status: !credential ? 'missing' : credential.disabled ? 'disabled' : credential.unavailable ? 'reauthorization_or_provider_check_required' : credential.status ?? 'available', drift: Boolean(drift), backend_version: inspection.version, provider_reachability: 'not_probed', quota: credential?.quota ?? { status: 'unavailable', source: null, observed_at: null }, credential_mode: 'not_exposed_by_management' }));
      } catch (error) { store.accountObservation(account.id, { status: 'unavailable', drift: true, error: error.code ?? 'management_unavailable' }); throw error; }
      return true;
    }
    if (method === 'POST') {
      requireValue(store.paused() && active.size === 0 && store.occupancy().length === 0, 'Pause admissions, drain active work, and resolve uncertain occupancy before credential mutations');
      store.audit('operator', `account.${action}.intent`, account.id);
      let result;
      try { result = action === 'reconnect' ? await backend.login() : await backend.credentialAction(account.credential_name, action); }
      catch (error) { store.audit('operator', `account.${action}.uncertain`, account.id); throw error; }
      store.audit('operator', `account.${action}.complete`, account.id);
      store.accountObservation(account.id, { status: action === 'remove' ? 'removed' : 'inspection_required', drift: true });
      reply(result); return true;
    }
  }
  const policyPath = path.match(/^\/admin\/projects\/([\w-]+)\/effective-policy$/);
  if (policyPath && method === 'GET') { reply(effectivePolicy(store, config, policyPath[1])); return true; }
  const historyPath = path.match(/^\/admin\/projects\/([\w-]+)\/(history|usage-history)$/);
  if (historyPath && method === 'GET') {
    requireValue(store.project(historyPath[1]), 'Unknown project'); const query = historyQuery(url);
    store.audit('operator', 'usage.export', historyPath[1], query);
    reply(historyPath[2] === 'history' ? store.history(historyPath[1], query) : store.usageHistory(historyPath[1], query.from, query.to)); return true;
  }
  if (path === '/admin/occupancy' && method === 'GET') { reply(store.occupancy()); return true; }
  const resolution = path.match(/^\/admin\/requests\/([\w-]+)\/(release-occupancy|observations)$/);
  if (resolution && method === 'POST') { reply(resolution[2] === 'observations' ? store.observeUsage(resolution[1], body) : store.releaseOccupancy(resolution[1], body.reason)); return true; }
  if (path === '/admin/retention/run' && method === 'POST') { reply(store.expireCaptures()); return true; }
  if (path === '/admin/metrics' && method === 'GET') { reply(store.metrics()); return true; }
  if (path === '/admin/alerts' && method === 'GET') {
    const metrics = store.metrics(); const alerts = [];
    if (metrics.unknown_usage) alerts.push({ kind: 'unknown_usage', count: metrics.unknown_usage });
    if (metrics.uncertain_occupancy) alerts.push({ kind: 'uncertain_occupancy', count: metrics.uncertain_occupancy });
    if (metrics.archive_bytes >= metrics.archive_capacity * 0.8) alerts.push({ kind: 'archive_capacity', fraction: metrics.archive_bytes / metrics.archive_capacity });
    for (const account of store.accounts()) if (account.observation?.drift) alerts.push({ kind: 'account_drift', account_id: account.id, observed_at: account.observation.observed_at });
    reply({ alerts, observed_at: metrics.observed_at }); return true;
  }
  if (path === '/admin/health' && method === 'GET') {
    const routes = await Promise.all(config.routes.map(async route => {
      try { const inspection = await new BackendManagement(route, environment).inspect(); return { id: route.id, management: 'reachable', authentication: inspection.active_file_credentials.length || inspection.configured_api_keys ? 'configured_not_live_verified' : 'missing', version_matches: inspection.version_matches, provider_reachability: 'not_probed' }; }
      catch { return { id: route.id, management: 'unavailable', authentication: 'unknown', provider_reachability: 'not_probed' }; }
    }));
    reply({ local_ready: !store.paused(), routes, observed_at: Date.now(), performs_inference: false }); return true;
  }
  return false;
}
