import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Store, digest } from './store.js';
import { validateConfig } from './config.js';
import { ServiceError, requireValue, errorBody } from './errors.js';
import { validatePayload, ResponseObserver } from './protocol.js';
import { backendHeaders, dispatch, BackendManagement } from './backend.js';

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}

async function readBody(request, limit) {
  if (Number(request.headers['content-length']) > limit) throw new ServiceError(413, 'payload_too_large', 'Request exceeds the byte limit');
  const parts = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new ServiceError(413, 'payload_too_large', 'Request exceeds the byte limit');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

function parse(raw) {
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw new ServiceError(400, 'invalid_request', 'Malformed JSON'); }
}

function writeChunk(response, chunk, signal) {
  if (signal.aborted || response.destroyed) return Promise.reject(new Error('Delivery cancelled'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Delivery cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    response.write(chunk, error => {
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    });
  });
}

export function createGateway(input, options = {}) {
  const config = validateConfig(input);
  const environment = options.environment ?? process.env;
  const adminKey = environment[config.admin_key_env];
  requireValue(typeof adminKey === 'string' && adminKey.length >= 24, 'Set an operator key of at least 24 characters');
  const store = options.store ?? new Store(config.data_dir, { archiveMaxBytes: config.archive_max_bytes });
  store.recover();
  const active = new Map();
  const routeFor = id => {
    const route = config.routes.find(candidate => candidate.id === id);
    if (!route) throw new ServiceError(404, 'route_not_found', 'Unknown route');
    return route;
  };
  const requireAdmin = request => {
    const supplied = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (!timingSafeEqual(Buffer.from(digest(supplied)), Buffer.from(digest(adminKey)))) throw new ServiceError(401, 'authentication_failed', 'Operator credential required');
  };
  const authorizedRequest = (id, principal) => {
    const record = store.request(id);
    if (!record || (principal && record.project_id !== principal.project_id)) throw new ServiceError(404, 'request_not_found', 'Unknown request');
    return record;
  };
  function capture(id, direction, bytes) {
    const record = store.request(id);
    try { store.append(id, direction, bytes); }
    catch (error) {
      store.captureState(id, 'partial');
      if (record.policy.recording === 'required') throw error instanceof ServiceError ? error : new ServiceError(507, 'recording_failed', 'Required archive write failed');
    }
  }
  async function inference(request, response, principal, url, protocol) {
    const project = store.project(principal.project_id);
    if (request.headers['x-project-id'] && request.headers['x-project-id'] !== project.id) throw new ServiceError(403, 'project_forbidden', 'Credential does not authorize that project');
    const routeId = request.headers['x-router4u-route'] ?? (project.policy.routes.length === 1 ? project.policy.routes[0] : null);
    requireValue(typeof routeId === 'string', 'Select a route using X-Router4u-Route');
    const route = routeFor(routeId);
    if (!project.policy.routes.includes(routeId)) throw new ServiceError(403, 'route_forbidden', 'Route is not authorized');
    requireValue(!url.search, 'Inference query parameters are unsupported');
    requireValue(!request.headers['content-encoding'] || request.headers['content-encoding'] === 'identity', 'Compressed request bodies are unsupported');
    const raw = await readBody(request, config.max_request_bytes);
    const payload = parse(raw);
    validatePayload(payload, route, protocol);
    backendHeaders(route, environment);
    const record = store.admit(principal, route, protocol, config);
    const id = record.id;
    response.setHeader('x-router4u-request-id', id);
    const controller = new AbortController();
    active.set(id, controller);
    const timeout = setTimeout(() => controller.abort('deadline_exceeded'), record.policy.deadline_ms);
    let upstream;
    let dispatched = false;
    let bytesDelivered = 0;
    let observer;
    let finished = false;
    const disconnect = () => { if (!finished) controller.abort('client_disconnected'); };
    response.on('close', disconnect);
    try {
      capture(id, 'request', raw);
      if (controller.signal.aborted) throw new ServiceError(499, 'cancelled', 'Request cancelled before dispatch');
      store.dispatch(id, payload.model);
      dispatched = true;
      upstream = await dispatch(route, protocol, raw, controller.signal, id, environment);
      const streaming = upstream.headers.get('content-type')?.includes('text/event-stream') ?? false;
      observer = new ResponseObserver(protocol, streaming, config.max_response_bytes);
      const manifest = store.manifest(id);
      store.captureState(id, manifest.state, { response_status: upstream.status,
        content_type: upstream.headers.get('content-type'), upstream_request_id: upstream.headers.get('x-request-id') });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no',
        ...(upstream.headers.get('retry-after') ? { 'retry-after': upstream.headers.get('retry-after') } : {}),
        ...(!upstream.ok ? { 'x-router4u-error-category': upstream.status === 429 ? 'upstream_rate_limited' : 'upstream_error' } : {}) });
      if (streaming) store.update(id, { execution: 'streaming' });
      for await (const chunk of upstream.body) {
        observer.push(chunk);
        capture(id, 'response', chunk);
        await writeChunk(response, chunk, controller.signal);
        bytesDelivered += chunk.length;
      }
      observer.finish();
      const captureManifest = store.manifest(id);
      if (captureManifest.state === 'pending') store.captureState(id, 'complete');
      store.settle(id, observer.terminal ? observer.usage : null, {
        execution: upstream.ok ? observer.outcome : 'failed', delivery: 'complete',
        observed_model: observer.observedModel, provider_response_id: observer.responseId,
        error: !upstream.ok ? (upstream.status === 429 ? 'upstream_rate_limited' : 'upstream_error') : !observer.terminal ? 'missing_terminal_event' : null });
      finished = true;
      response.end();
    } catch (error) {
      controller.abort(controller.signal.reason ?? 'execution_failed');
      const reason = typeof controller.signal.reason === 'string' ? controller.signal.reason : 'execution_failed';
      try {
        const manifest = store.manifest(id);
        if (manifest.state === 'pending') store.captureState(id, 'partial');
        store.settle(id, !dispatched ? { total: 0, source: 'not_dispatched' } : observer?.terminal ? observer.usage : null, {
          execution: observer?.terminal ? observer.outcome : dispatched ? 'outcome_unknown' : 'failed',
          delivery: reason === 'client_disconnected' ? 'client_disconnected' : bytesDelivered ? 'partial' : 'not_started',
          error: error instanceof ServiceError ? error.code : reason });
      } catch { process.stderr.write(`Persistence failure for request ${id}; recovery required\n`); }
      if (response.headersSent) response.destroy();
      else json(response, error instanceof ServiceError ? error.status : reason === 'deadline_exceeded' ? 504 : 502,
        errorBody(error instanceof ServiceError ? error : new ServiceError(502, reason, 'Backend execution did not complete'), id));
    } finally {
      finished = true;
      clearTimeout(timeout);
      active.delete(id);
      response.off('close', disconnect);
      if (upstream?.body && !upstream.body.locked) await upstream.body.cancel().catch(() => {});
    }
  }
  const server = createServer(async (request, response) => {
    response.on('error', () => {});
    try {
      const url = new URL(request.url, 'http://router4u.local');
      const path = url.pathname;
      const method = request.method;
      if (path === '/healthz' && method === 'GET') return json(response, 200, { status: 'alive' });
      if (path === '/readyz' && method === 'GET') {
        store.db.prepare('SELECT 1').get();
        return json(response, store.paused() ? 503 : 200, { local_ready: !store.paused(), provider_reachability: 'not_probed' });
      }
      if (path.startsWith('/admin/')) {
        requireAdmin(request);
        const body = ['POST', 'PUT', 'PATCH'].includes(method) ? parse(await readBody(request, config.max_request_bytes)) : {};
        if (path === '/admin/projects' && method === 'GET') return json(response, 200, store.projects());
        const projectPath = path.match(/^\/admin\/projects\/([\w-]+)(\/keys)?$/);
        if (projectPath && method === 'PUT' && !projectPath[2]) {
          requireValue(Array.isArray(body.routes), 'routes is required');
          body.routes.forEach(routeFor);
          return json(response, 200, store.putProject(projectPath[1], body));
        }
        if (projectPath && method === 'POST' && projectPath[2]) return json(response, 201, store.issueKey(projectPath[1]));
        const keyPath = path.match(/^\/admin\/principals\/([\w-]+)$/);
        if (keyPath && method === 'DELETE') { store.revokeKey(keyPath[1]); return json(response, 200, { revoked: true }); }
        if (path === '/admin/pause' && method === 'POST') { store.pause(body.paused); return json(response, 200, { paused: store.paused() }); }
        if (path === '/admin/audit' && method === 'GET') return json(response, 200, store.db.prepare('SELECT * FROM audit WHERE sequence>? ORDER BY sequence LIMIT 200').all(Number(url.searchParams.get('after') ?? 0)));
        if (path === '/admin/events' && method === 'GET') return json(response, 200, store.db.prepare('SELECT * FROM outbox WHERE sequence>? ORDER BY sequence LIMIT 200').all(Number(url.searchParams.get('after') ?? 0)));
        if (path === '/admin/active' && method === 'GET') return json(response, 200, [...active.keys()].map(id => store.request(id)));
        const usagePath = path.match(/^\/admin\/usage\/([\w-]+)$/);
        if (usagePath && method === 'GET') return json(response, 200, store.status(usagePath[1]));
        const recordPath = path.match(/^\/admin\/requests\/([\w-]+)(?:\/(resolve|cancel|exchange))?$/);
        if (recordPath) {
          const id = recordPath[1];
          authorizedRequest(id);
          if (method === 'POST' && recordPath[2] === 'resolve') return json(response, 200, store.resolve(id, body.tokens, body.reason));
          if (method === 'DELETE' && recordPath[2] === 'exchange') return json(response, 200, store.deleteCapture(id, body.expired === true));
          if (method === 'GET' && recordPath[2] === 'exchange') { store.audit('operator', 'capture.read', id); return json(response, 200, store.captured(id)); }
          if (method === 'GET' && !recordPath[2]) return json(response, 200, store.request(id));
          if (method === 'POST' && recordPath[2] === 'cancel') return cancel(id, response, 'operator');
        }
        const backendPath = path.match(/^\/admin\/backends\/([\w-]+)\/(credentials|models|login|status|callback)$/);
        if (backendPath) {
          const backend = new BackendManagement(routeFor(backendPath[1]), environment);
          const action = backendPath[2];
          if (method === 'GET' && ['credentials', 'models'].includes(action)) return json(response, 200, await backend[action]());
          if (method === 'POST' && action === 'login') { store.audit('operator', 'oauth.start', backendPath[1]); return json(response, 200, await backend.login()); }
          if (method === 'POST' && action === 'callback') return json(response, 200, await backend.callback(body.redirect_url));
          if (method === 'GET' && action === 'status') return json(response, 200, await backend.status(url.searchParams.get('state')));
        }
      } else {
        const principal = store.authenticate(request.headers.authorization?.replace(/^Bearer /, ''));
        if (method === 'POST' && ['/v1/responses', '/v1/chat/completions'].includes(path)) return await inference(request, response, principal, url, path.endsWith('/responses') ? 'responses' : 'chat');
        if (path === '/v1/models' && method === 'GET') {
          const project = store.project(principal.project_id);
          const models = [...new Set(config.routes.filter(route => project.policy.routes.includes(route.id)).flatMap(route => route.models))];
          return json(response, 200, { object: 'list', data: models.map(id => ({ id, object: 'model', created: 0, owned_by: 'router4u' })) });
        }
        if (path === '/v1/capabilities' && method === 'GET') {
          const project = store.project(principal.project_id);
          return json(response, 200, { routes: config.routes.filter(route => project.policy.routes.includes(route.id)).map(route => ({ id: route.id,
            profile: route.profile, models: route.models, protocols: route.protocols, streaming: true,
            cancellation: 'best_effort', token_enforcement: ['observe', 'estimate'], continuation: false,
            attempt_visibility: 'request_only', capture_boundary: 'client_application_body' })) });
        }
        if (path === '/v1/usage' && method === 'GET') return json(response, 200, store.status(principal.project_id));
        if (path === '/v1/requests' && method === 'GET') return json(response, 200, store.requests(principal.project_id));
        const recordPath = path.match(/^\/v1\/requests\/([\w-]+)(?:\/(exchange|cancel))?$/);
        if (recordPath) {
          const id = recordPath[1];
          authorizedRequest(id, principal);
          if (method === 'GET' && !recordPath[2]) return json(response, 200, store.request(id));
          if (method === 'GET' && recordPath[2] === 'exchange') { store.audit(principal.id, 'capture.read', id); return json(response, 200, store.captured(id)); }
          if (method === 'POST' && recordPath[2] === 'cancel') return cancel(id, response, principal.id);
        }
      }
      throw new ServiceError(404, 'not_found', 'Endpoint not found');
    } catch (error) {
      if (!response.headersSent) json(response, error instanceof ServiceError ? error.status : 503, errorBody(error));
      else response.destroy();
    }
  });
  function cancel(id, response, actor) {
    const controller = active.get(id);
    if (controller) {
      store.update(id, { cancellation_requested: true });
      store.audit(actor, 'request.cancel', id);
      controller.abort('cancelled');
    }
    json(response, 200, { request_id: id, cancellation_requested: Boolean(controller), upstream_termination_confirmed: false });
  }
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.maxConnections = 256;
  server.on('upgrade', (request, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  return { server, store, config, active, async listen() {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
    return `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${server.address().port}`;
  }, async close() {
    for (const controller of active.values()) controller.abort('service_shutdown');
    await new Promise(resolve => server.close(resolve));
    store.close();
  } };
}
