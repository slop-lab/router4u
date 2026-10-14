import { createServer } from 'node:http';
const response = model => ({ id: 'resp_docker', object: 'response', status: 'completed', model, output: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
let calls = 0;
createServer(async (request, reply) => {
  if (request.url === '/calls') { reply.end(JSON.stringify({ calls })); return; }
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  calls++;
  reply.writeHead(200, { 'content-type': 'text/event-stream' });
  reply.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_docker', status: 'in_progress', model: body.model } })}\n\n`);
  if (body.input?.some?.(item => item.content === 'hold')) { const timer = setTimeout(() => reply.end(), 60000); reply.once('close', () => clearTimeout(timer)); return; }
  reply.end(`data: ${JSON.stringify({ type: 'response.completed', response: response(body.model) })}\n\n`);
}).listen(8899, '0.0.0.0');
