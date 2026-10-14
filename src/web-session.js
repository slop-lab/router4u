import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ServiceError } from './errors.js';
import { digest } from './store.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
].map(([path, [file, type]]) => [path, { body: readFileSync(new URL(`./web/${file}`, import.meta.url)), type }]));
const equal = (a, b) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const deny = () => { throw new ServiceError(403, 'browser_request_rejected', 'Same-origin request and a valid CSRF token are required'); };

export function webSessions(adminKey, { json, readBody, parse }) {
  const sessions = new Map();
  let attempts = 0, windowStart = 0;
  function origin(request) {
    if (request.headers['sec-fetch-site'] === 'cross-site') deny();
    if (request.headers.origin) {
      const value = new URL(request.headers.origin);
      if (!['http:', 'https:'].includes(value.protocol) || value.host !== request.headers.host) deny();
    }
  }
  function session(request) {
    const token = request.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('r4u_session='))?.slice(12);
    const value = token && sessions.get(token);
    if (!value || value.expires <= Date.now()) { if (token) sessions.delete(token); return null; }
    return { ...value, token };
  }
  function authorize(request) {
    const value = session(request);
    if (!value) throw new ServiceError(401, 'authentication_failed', 'Sign in with your operator key');
    origin(request);
    if (!equal(request.headers['x-csrf-token'] ?? '', value.csrf)) deny();
  }
  return {
    authorize,
    async handle(request, response, path) {
      const asset = assets.get(path);
      if (asset && ['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
          'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
        response.end(request.method === 'HEAD' ? undefined : asset.body); return true;
      }
      if (path !== '/web/session') return false;
      origin(request);
      if (request.method === 'GET') {
        const value = session(request);
        json(response, 200, { authenticated: !!value, csrf: value?.csrf }); return true;
      }
      if (request.method === 'POST') {
        if (Date.now() - windowStart > 60000) { attempts = 0; windowStart = Date.now(); }
        if (++attempts > 20) throw new ServiceError(429, 'login_rate_limited', 'Too many sign-in attempts; wait one minute');
        if (!request.headers['content-type']?.startsWith('application/json')) deny();
        const body = parse(await readBody(request, 4096));
        if (typeof body.key !== 'string' || !equal(body.key, adminKey)) throw new ServiceError(401, 'authentication_failed', 'Invalid operator key');
        for (const [token, value] of sessions) if (value.expires <= Date.now()) sessions.delete(token);
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        const previous = session(request); if (previous) sessions.delete(previous.token);
        const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
        sessions.set(token, { csrf, expires: Date.now() + 8 * 3600000 });
        // HTTPS may terminate at a proxy. Only an actual HTTPS Origin enables Secure.
        response.setHeader('set-cookie', `r4u_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${request.socket.encrypted || request.headers.origin?.startsWith('https://') ? '; Secure' : ''}`);
        json(response, 200, { authenticated: true, csrf }); return true;
      }
      if (request.method === 'DELETE') {
        authorize(request); sessions.delete(session(request).token);
        response.setHeader('set-cookie', 'r4u_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        json(response, 200, { authenticated: false }); return true;
      }
      throw new ServiceError(405, 'method_not_allowed', 'Unsupported session method');
    },
  };
}
