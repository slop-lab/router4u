import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireValue } from './errors.js';

export const BACKEND_VERSION = '8.0.28';
export const DEFAULT_POLICY = Object.freeze({
  enabled: true, routes: [], concurrency: 4, requests_per_minute: 60,
  daily_requests: 1000, daily_tokens: 1000000, token_mode: 'estimate',
  token_estimate: 4096, recording: 'required', deadline_ms: 120000, timezone: 'UTC',
});

export function validatePolicy(input) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'Policy must be an object');
  requireValue(Object.keys(input).every(key => key in DEFAULT_POLICY), 'Unknown policy field');
  const policy = { ...DEFAULT_POLICY, ...input };
  requireValue(typeof policy.enabled === 'boolean', 'enabled must be boolean');
  requireValue(Array.isArray(policy.routes) && policy.routes.length > 0 && policy.routes.every(value => typeof value === 'string'), 'routes must list authorized routes');
  requireValue(['observe', 'estimate'].includes(policy.token_mode), 'Strict token budgets are unsupported: upstream consumption has no verified bound');
  requireValue(['required', 'best_effort', 'metadata'].includes(policy.recording), 'Invalid recording policy');
  for (const key of ['concurrency', 'requests_per_minute', 'daily_requests', 'daily_tokens', 'token_estimate', 'deadline_ms']) {
    requireValue(Number.isSafeInteger(policy[key]) && policy[key] > 0, `${key} must be a positive safe integer`);
  }
  requireValue(policy.deadline_ms <= 3600000, 'deadline_ms cannot exceed one hour');
  requireValue(typeof policy.timezone === 'string', 'timezone must be a string');
  try { new Intl.DateTimeFormat('en', { timeZone: policy.timezone }); } catch { requireValue(false, 'Invalid timezone'); }
  return policy;
}

export function validateConfig(input) {
  const config = {
    host: '127.0.0.1', port: 9470, data_dir: '.runtime/data', admin_key_env: 'ROUTER4U_ADMIN_KEY',
    max_request_bytes: 2097152, max_response_bytes: 16777216, archive_max_bytes: 1073741824,
    concurrency: 32, daily_requests: 10000, daily_tokens: 10000000, routes: [], ...input,
  };
  requireValue(typeof config.host === 'string', 'host must be a string');
  requireValue(Number.isInteger(config.port) && config.port >= 0 && config.port <= 65535, 'Invalid port');
  for (const key of ['max_request_bytes', 'max_response_bytes', 'archive_max_bytes', 'concurrency', 'daily_requests', 'daily_tokens']) {
    requireValue(Number.isSafeInteger(config[key]) && config[key] > 0, `${key} must be positive`);
  }
  requireValue(Array.isArray(config.routes) && config.routes.length > 0, 'At least one route is required');
  const seen = new Set();
  for (const route of config.routes) {
    requireValue(/^[a-zA-Z0-9_-]{1,64}$/.test(route.id) && !seen.has(route.id), 'Invalid or duplicate route ID');
    seen.add(route.id);
    requireValue(['api_key', 'codex', 'chatgpt'].includes(route.profile), 'Invalid route profile');
    requireValue(Array.isArray(route.models) && route.models.length > 0 && route.models.every(model => typeof model === 'string' && model.length < 200), 'Explicit model allowlist is required');
    requireValue(Array.isArray(route.protocols) && route.protocols.length > 0 && route.protocols.every(protocol => ['responses', 'chat'].includes(protocol)), 'Invalid protocols');
    requireValue(route.profile !== 'chatgpt' || route.protocols.every(protocol => protocol === 'responses'), 'ChatGPT plan routes only support Responses');
    requireValue(typeof route.key_env === 'string' && route.key_env.length > 0, 'Backend key environment variable is required');
    const backendURL = new URL(route.base_url);
    requireValue(['http:', 'https:'].includes(backendURL.protocol) && !backendURL.username && !backendURL.password && !backendURL.search && !backendURL.hash, 'Invalid backend URL');
    requireValue(backendURL.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(backendURL.hostname) || config.allow_private_http === true, 'Non-loopback HTTP requires allow_private_http');
    requireValue(!route.account_id || (typeof route.account_id === 'string' && route.exclusive_account === true), 'Account attribution requires an exclusive backend partition');
  }
  config.data_dir = resolve(config.data_dir);
  return config;
}

export function loadConfig(path) {
  return validateConfig(JSON.parse(readFileSync(path, 'utf8')));
}

export function periodFor(now, timezone = 'UTC') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}
