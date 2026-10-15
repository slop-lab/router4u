import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireValue } from './errors.js';

export const BACKEND_VERSION = '8.0.28';
export const DEFAULT_POLICY = Object.freeze({
  enabled: true, routes: [], concurrency: 4, requests_per_minute: 60,
  daily_requests: 1000, daily_tokens: 1000000, token_mode: 'estimate',
  token_estimate: 4096, recording: 'required', deadline_ms: 120000, timezone: 'UTC',
  tokens_per_minute: null, archive_max_bytes: null, retention_days: null, budgets: [],
});

export function validatePolicy(input) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'Policy must be an object');
  requireValue(Object.keys(input).every(key => key in DEFAULT_POLICY), 'Unknown policy field');
  const policy = { ...DEFAULT_POLICY, ...input };
  requireValue(typeof policy.enabled === 'boolean', 'enabled must be boolean');
  requireValue(Array.isArray(policy.routes) && policy.routes.length > 0 && policy.routes.every(value => typeof value === 'string'), 'routes must list authorized routes');
  requireValue(['observe', 'estimate'].includes(policy.token_mode), 'Strict token budgets are unsupported: upstream consumption has no verified bound');
  requireValue(['required', 'best_effort', 'metadata'].includes(policy.recording), 'Invalid recording policy');
  for (const key of ['token_estimate', 'deadline_ms']) {
    requireValue(Number.isSafeInteger(policy[key]) && policy[key] > 0, `${key} must be a positive safe integer`);
  }
  validateOptionalLimits(policy);
  validateBudgets(policy.budgets);
  requireValue(policy.deadline_ms <= 3600000, 'deadline_ms cannot exceed one hour');
  requireValue(typeof policy.timezone === 'string', 'timezone must be a string');
  try { new Intl.DateTimeFormat('en', { timeZone: policy.timezone }); } catch { requireValue(false, 'Invalid timezone'); }
  return policy;
}

export function validateConfig(input) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'Configuration must be an object');
  requireValue(Object.keys(input).every(key => ['host', 'port', 'data_dir', 'transcript_dir', 'admin_key_env', 'max_request_bytes', 'max_response_bytes', 'archive_max_bytes', 'concurrency', 'daily_requests', 'daily_tokens', 'routes', 'requests_per_minute', 'tokens_per_minute', 'budgets', 'maintenance_interval_ms', 'accounts', 'allow_private_http'].includes(key)), 'Unknown configuration field');
  const config = {
    host: '127.0.0.1', port: 9470, data_dir: '.runtime/data', admin_key_env: 'ROUTER4U_ADMIN_KEY',
    max_request_bytes: 2097152, max_response_bytes: 16777216, archive_max_bytes: 1073741824,
    concurrency: 32, daily_requests: 10000, daily_tokens: 10000000, routes: [],
    requests_per_minute: null, tokens_per_minute: null, budgets: [], maintenance_interval_ms: 60000,
    accounts: [], ...input,
  };
  requireValue(typeof config.host === 'string', 'host must be a string');
  requireValue(Number.isInteger(config.port) && config.port >= 0 && config.port <= 65535, 'Invalid port');
  for (const key of ['max_request_bytes', 'max_response_bytes', 'archive_max_bytes']) {
    requireValue(Number.isSafeInteger(config[key]) && config[key] > 0, `${key} must be positive`);
  }
  requireValue(Array.isArray(config.routes) && config.routes.length > 0, 'At least one route is required');
  validateOptionalLimits(config);
  validateBudgets(config.budgets);
  requireValue(Number.isSafeInteger(config.maintenance_interval_ms) && config.maintenance_interval_ms >= 1000, 'Invalid maintenance interval');
  requireValue(Array.isArray(config.accounts), 'accounts must be an array');
  const accountIDs = new Set();
  for (const account of config.accounts) {
    requireValue(/^[a-zA-Z0-9_-]{1,64}$/.test(account.id) && !accountIDs.has(account.id), 'Invalid or duplicate account ID');
    accountIDs.add(account.id);
    requireValue(typeof account.route_id === 'string' && typeof account.credential_name === 'string' && /^[a-zA-Z0-9_.@+-]+\.json$/.test(account.credential_name) && !account.credential_name.includes('..'), 'Account requires route_id and safe credential_name');
    requireValue(account.enabled === undefined || typeof account.enabled === 'boolean', 'Invalid account enabled flag');
    requireValue(Object.keys(account).every(key => ['id', 'route_id', 'credential_name', 'enabled', 'concurrency'].includes(key)), 'Account metadata cannot contain credentials or unknown fields');
    validateOptionalLimits(account);
  }
  const seen = new Set();
  for (const route of config.routes) {
    requireValue(typeof route.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(route.id) && !seen.has(route.id), 'Invalid or duplicate route ID');
    seen.add(route.id);
    validateOptionalLimits(route);
    requireValue(route.enabled === undefined || typeof route.enabled === 'boolean', 'Invalid route enabled flag');
    requireValue(Object.keys(route).every(key => ['id', 'profile', 'models', 'protocols', 'base_url', 'key_env', 'management_key_env', 'account_id', 'exclusive_account', 'credential_name', 'concurrency', 'enabled'].includes(key)), 'Unsupported route field');
    requireValue(['api_key', 'codex'].includes(route.profile), 'Unsupported route profile; use codex or api_key');
    requireValue(Array.isArray(route.models) && (route.enabled === false || route.models.length > 0) && route.models.every(model => typeof model === 'string' && model.trim().length > 0 && model.length < 200), 'Enabled routes require a nonempty model allowlist; only disabled routes may have no models');
    requireValue(Array.isArray(route.protocols) && route.protocols.length > 0 && route.protocols.every(protocol => ['responses', 'chat'].includes(protocol)), 'Invalid protocols');
    requireValue(typeof route.key_env === 'string' && route.key_env.length > 0, 'Backend key environment variable is required');
    const backendURL = new URL(route.base_url);
    requireValue(['http:', 'https:'].includes(backendURL.protocol) && !backendURL.username && !backendURL.password && !backendURL.search && !backendURL.hash, 'Invalid backend URL');
    requireValue(backendURL.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(backendURL.hostname) || config.allow_private_http === true, 'Non-loopback HTTP requires allow_private_http');
    requireValue(!route.account_id || (typeof route.account_id === 'string' && route.exclusive_account === true && typeof route.credential_name === 'string' && typeof route.management_key_env === 'string'), 'Account attribution requires an exclusive backend partition');
  }
  for (const account of config.accounts) {
    requireValue(seen.has(account.route_id), 'Account references unknown route');
    if (account.concurrency) requireValue(config.routes.some(route => route.id === account.route_id && route.account_id === account.id && route.exclusive_account === true), 'Account concurrency requires a verified exclusive route');
  }
  for (const route of config.routes) if (route.account_id && config.accounts.length) {
    const account = config.accounts.find(item => item.id === route.account_id);
    requireValue(account && account.route_id === route.id && account.credential_name === route.credential_name, 'Exclusive route must match its account registry binding');
  }
  config.data_dir = resolve(config.data_dir);
  requireValue(config.transcript_dir === undefined || (typeof config.transcript_dir === 'string' && config.transcript_dir.trim().length > 0), 'transcript_dir must be a nonempty path');
  config.transcript_dir = resolve(config.transcript_dir ?? resolve(config.data_dir, 'transcripts'));
  requireValue(config.transcript_dir !== config.data_dir, 'Transcript directory must differ from database directory');
  return config;
}

export function loadConfig(path) {
  return validateConfig(JSON.parse(readFileSync(path, 'utf8')));
}

export function periodFor(now, timezone = 'UTC') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

export function validateOptionalLimits(value) {
  for (const key of ['tokens_per_minute', 'requests_per_minute', 'archive_max_bytes', 'retention_days', 'concurrency', 'daily_requests', 'daily_tokens']) {
    if (value[key] != null) requireValue(Number.isSafeInteger(value[key]) && value[key] > 0, `${key} must be a positive safe integer or null`);
  }
}
export function validateBudgets(budgets) {
  requireValue(Array.isArray(budgets) && budgets.length <= 32, 'At most 32 budgets are allowed');
  const ids = new Set();
  for (const budget of budgets) {
    requireValue(/^[a-zA-Z0-9_-]{1,64}$/.test(budget.id) && !ids.has(budget.id), 'Invalid budget ID'); ids.add(budget.id);
    requireValue(['requests', 'tokens', 'observed_attempts'].includes(budget.resource), 'Invalid budget resource');
    requireValue(['day', 'month', 'rolling'].includes(budget.period), 'Invalid budget period');
    requireValue(Number.isSafeInteger(budget.limit) && budget.limit > 0, 'Invalid budget limit');
    requireValue(['observe', 'estimate', 'strict'].includes(budget.mode ?? 'estimate'), 'Invalid enforcement mode');
    requireValue(budget.mode !== 'strict' || budget.resource === 'requests', 'Only local request budgets have strict bounds');
    if (budget.period === 'rolling') requireValue(Number.isSafeInteger(budget.duration_ms) && budget.duration_ms > 0, 'Rolling budget needs duration_ms');
    try { new Intl.DateTimeFormat('en', { timeZone: budget.timezone ?? 'UTC' }); } catch { requireValue(false, 'Invalid budget timezone'); }
    requireValue(Object.keys(budget).every(key => ['id', 'resource', 'period', 'limit', 'mode', 'duration_ms', 'timezone'].includes(key)), 'Unknown budget field');
  }
}
export const PRINCIPAL_SCOPES = ['inference', 'usage:read', 'requests:read', 'requests:cancel', 'exchange:export'];
export const DEFAULT_SCOPES = PRINCIPAL_SCOPES.filter(scope => scope !== 'exchange:export');
export function validateScopes(scopes) {
  requireValue(Array.isArray(scopes) && scopes.length > 0 && scopes.every(scope => PRINCIPAL_SCOPES.includes(scope)) && new Set(scopes).size === scopes.length, 'Invalid principal scopes');
  return scopes;
}
export function capabilities(route) {
  return { id: route.id, backend_version: BACKEND_VERSION, profile: route.profile, models: route.models,
    protocols: route.protocols, streaming: true, cancellation: 'best_effort', token_enforcement: ['observe', 'estimate'],
    continuation: false, attempt_visibility: 'request_only', usage_visibility: 'backend_response',
    capture_boundary: 'client_application_body', account_selection: route.account_id ? 'verified_exclusive_partition' : 'backend_partition',
    tool_representation: 'native_protocol_passthrough',
    modalities: { text: 'offline_contract_tested', images: 'reference_passthrough_only', audio: 'unverified', video: 'unverified' },
    provider_verification: 'operator_live_validation_required', hidden_attempts: 'unavailable', translated_upstream_capture: false };
}
