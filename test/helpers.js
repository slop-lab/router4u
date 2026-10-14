import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRINCIPAL_SCOPES } from '../src/config.js';
import { createGateway } from '../src/server.js';

export const adminKey = 'test-only-operator-key-at-least-24-characters';
export const backendKey = 'test-only-backend-key';
export const textItem = { id: 'msg_test', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Hello from Router4u', annotations: [] }] };
export const completedResponse = (model = 'test-model') => ({ id: 'resp_test', object: 'response', created_at: 1, status: 'completed', model,
  output: [textItem], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } } });
export const event = object => `event: ${object.type}\ndata: ${JSON.stringify(object)}\n\n`;

export function responseEvents(model = 'test-model') {
  const response = completedResponse(model);
  return [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null }, sequence_number: 0 },
    { type: 'response.output_item.added', output_index: 0, item: { ...textItem, status: 'in_progress', content: [] }, sequence_number: 1 },
    { type: 'response.content_part.added', item_id: textItem.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] }, sequence_number: 2 },
    { type: 'response.output_text.delta', item_id: textItem.id, output_index: 0, content_index: 0, delta: 'Hello from Router4u', sequence_number: 3 },
    { type: 'response.output_text.done', item_id: textItem.id, output_index: 0, content_index: 0, text: 'Hello from Router4u', sequence_number: 4 },
    { type: 'response.content_part.done', item_id: textItem.id, output_index: 0, content_index: 0, part: textItem.content[0], sequence_number: 5 },
    { type: 'response.output_item.done', output_index: 0, item: textItem, sequence_number: 6 },
    { type: 'response.completed', response, sequence_number: 7 },
  ];
}

export async function fakeProvider(handler) {
  const calls = [];
  const server = createServer(async (request, response) => {
    response.on('error', () => {});
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const body = raw.length ? JSON.parse(raw) : {};
      calls.push({ url: request.url, headers: request.headers, body, raw });
      if (handler) return await handler(request, response, body, raw);
      if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); return response.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model', object: 'model', owned_by: 'fake' }] })); }
      const isChat = request.url.endsWith('/chat/completions');
      if (!body.stream) {
        response.setHeader('content-type', 'application/json');
        return response.end(JSON.stringify(isChat ? { id: 'chatcmpl_test', object: 'chat.completion', created: 1, model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from Router4u' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : completedResponse(body.model)));
      }
      response.setHeader('content-type', 'text/event-stream');
      if (isChat) {
        const chunk = { id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 1, model: body.model };
        response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello from Router4u' }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
        return response.end('data: [DONE]\n\n');
      }
      for (const item of responseEvents(body.model)) response.write(event(item));
      response.end();
    } catch { response.destroy(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, server, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

export async function fixture(context, { handler, policy = {}, profile = 'api_key', config: overrides = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'router4u-test-'));
  const backend = await fakeProvider(handler);
  const config = { data_dir: directory, port: 0, routes: [{ id: 'local', profile, base_url: backend.url,
    key_env: 'TEST_BACKEND_KEY', models: ['test-model'], protocols: profile === 'chatgpt' ? ['responses'] : ['responses', 'chat'] }], ...overrides };
  const gateway = createGateway(config, { environment: { ROUTER4U_ADMIN_KEY: adminKey, TEST_BACKEND_KEY: backendKey } });
  gateway.store.putProject('alpha', { routes: ['local'], ...policy });
  gateway.store.putProject('beta', { routes: ['local'] });
  const alpha = gateway.store.issueKey('alpha', PRINCIPAL_SCOPES);
  const beta = gateway.store.issueKey('beta', PRINCIPAL_SCOPES);
  const url = await gateway.listen();
  context.after(async () => { await backend.close(); await gateway.close(); rmSync(directory, { recursive: true, force: true }); });
  return { gateway, backend, url, directory, alpha, beta,
    call(path, { key = alpha.key, body, method = body ? 'POST' : 'GET', headers = {} } = {}) {
      return fetch(url + path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    } };
}
