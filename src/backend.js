import { ServiceError, requireValue } from './errors.js';

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
    return response.json();
  }
  async credentials() {
    const result = await this.call('/credentials');
    return (result.files ?? []).map(file => ({ name: file.name, id: file.id, provider: file.provider,
      disabled: file.disabled, status: file.status, unavailable: file.unavailable }));
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
