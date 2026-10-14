import { ServiceError, requireValue } from './errors.js';
import { BACKEND_VERSION } from './config.js';

export function backendHeaders(route, environment = process.env) {
  const key = environment[route.key_env];
  if (!key) throw new ServiceError(503, 'account_unavailable', 'Backend access credential is not configured');
  return { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'accept-encoding': 'identity' };
}

export function dispatch(route, protocol, raw, signal, requestId, environment = process.env) {
  const path = protocol === 'responses' ? '/responses' : '/chat/completions';
  return fetch(route.base_url.replace(/\/$/, '') + path, { method: 'POST',
    headers: { ...backendHeaders(route, environment), 'x-request-id': requestId }, body: raw, signal, redirect: 'error' });
}

export class BackendManagement {
  constructor(route, environment = process.env) { this.route = route; this.environment = environment; }
  async call(path, method = 'GET', payload) {
    const route = this.route;
    const key = this.environment[route.management_key_env];
    if (!key) throw new ServiceError(503, 'management_unavailable', 'Backend management credential is not configured');
    const origin = new URL(route.base_url).origin;
    let response;
    try {
      response = await fetch(`${origin}/v8/management${path}`, { method, redirect: 'error',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
    } catch { throw new ServiceError(503, 'management_unavailable', 'Backend management request failed'); }
    if (!response.ok) { await response.body?.cancel(); throw new ServiceError(502, 'management_error', `Backend management returned HTTP ${response.status}`); }
    this.version = response.headers.get('x-cpa-version');
    return response.json();
  }
  async credentials() {
    const result = await this.call('/credentials');
    return (result.files ?? []).map(file => ({ name: file.name, id: file.id, provider: file.provider,
      disabled: file.disabled, status: file.status, unavailable: file.unavailable,
      quota: passiveQuota(file.quota), credential_mode: 'not_exposed_by_management' }));
  }
  async inspect() {
    const config = await this.call('/config');
    const version = this.version;
    const credentials = await this.credentials();
    const groups = Object.values(config['api-keys'] ?? {}).flatMap(value => Array.isArray(value) ? value : []);
    const keys = groups.flatMap(group => group.keys ?? []);
    const retry = config.routing?.retry ?? {};
    const overrides = [...groups, ...keys].some(item => item['request-retry'] != null && item['request-retry'] !== 0);
    return { version, pinned_version: BACKEND_VERSION, version_matches: version === BACKEND_VERSION,
      retry_configuration_verified: retry['request-retry'] === 0 && retry['max-retry-credentials'] === 1 &&
        (config.requests?.streaming?.['bootstrap-retries'] ?? 0) === 0 && !overrides,
      active_file_credentials: credentials.filter(item => !item.disabled),
      configured_api_keys: keys.length, observation: 'request_only' };
  }
  async verifyExclusiveAccount() {
    const status = await this.inspect();
    if (!status.version_matches || !status.retry_configuration_verified || status.configured_api_keys !== 0 ||
      status.active_file_credentials.length !== 1 || status.active_file_credentials[0].name !== this.route.credential_name) {
      throw new ServiceError(503, 'route_constraint_unverified', 'Exclusive account partition could not be verified');
    }
    return status;
  }
  async credentialAction(name, action) {
    requireValue(typeof name === 'string' && /^[a-zA-Z0-9_.@+-]+\.json$/.test(name) && !name.includes('..'), 'Invalid credential filename');
    requireValue(['enable', 'disable', 'remove', 'refresh'].includes(action), 'Invalid credential operation');
    if (action === 'enable' || action === 'disable') await this.call('/credentials/status', 'PATCH', { name, disabled: action === 'disable' });
    if (action === 'remove') await this.call(`/credentials?name=${encodeURIComponent(name)}`, 'DELETE');
    if (action === 'refresh') await this.call('/credentials/refresh', 'POST', { name });
    // Refresh responses can contain full credential objects. Never return them.
    return { name, action, completed: true, lifecycle_owner: 'CLIProxyAPI' };
  }
  login() { return this.call('/oauth/auth-url?provider=codex'); }
  status(state) { requireValue(typeof state === 'string' && state.length <= 256, 'Invalid OAuth state'); return this.call(`/oauth/status?state=${encodeURIComponent(state)}`); }
  callback(redirectURL) {
    const url = new URL(redirectURL);
    requireValue(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/auth/callback', 'Expected the loopback OAuth callback URL');
    return this.call('/oauth/callback', 'POST', { provider: 'codex', redirect_url: redirectURL });
  }
  async models() {
    const response = await fetch(`${this.route.base_url.replace(/\/$/, '')}/models`, {
      headers: backendHeaders(this.route, this.environment), redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new ServiceError(502, 'account_unavailable', `Backend model discovery returned HTTP ${response.status}`);
    const result = await response.json();
    return result.data ?? result.models ?? [];
  }
}

function passiveQuota(raw) {
  const signals = Object.fromEntries(Object.entries(raw?.signals ?? {}).filter(([key, value]) =>
    /^(retry-after|anthropic-ratelimit-unified-[a-z0-9-]+|x-ratelimit-[a-z0-9-]+|x-codex-(active-limit|plan-type|credits-[a-z0-9-]+|[a-z0-9-]+-(allowed|limit-reached|limit-name|used-percent|window-minutes|reset-after-seconds|reset-at|over-secondary-limit-percent)))$/i.test(key)
    && typeof value === 'string' && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value)).slice(0, 64));
  const observed = typeof raw?.observed_at === 'string' && Number.isFinite(Date.parse(raw.observed_at)) ? raw.observed_at : null;
  return { status: observed ? 'observed' : 'unavailable', source: 'CLIProxyAPI_passive_provider_headers', observed_at: observed, collected_at: Date.now(), signals, exact_remaining_capacity: 'not_inferred' };
}
