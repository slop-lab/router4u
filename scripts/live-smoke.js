const base = process.env.ROUTER4U_URL ?? 'http://127.0.0.1:9470';
const key = process.env.ROUTER4U_PROJECT_KEY;
const model = process.env.ROUTER4U_MODEL;
if (!key || !model) throw new Error('Set ROUTER4U_PROJECT_KEY and ROUTER4U_MODEL. This explicitly sends one real inference request.');
const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json',
  ...(process.env.ROUTER4U_ROUTE ? { 'x-router4u-route': process.env.ROUTER4U_ROUTE } : {}) };
const response = await fetch(`${base}/v1/responses`, { method: 'POST', headers,
  body: JSON.stringify({ model, input: [{ role: 'user', content: 'Say exactly: Router4u live check passed.' }], store: false, stream: true }),
  signal: AbortSignal.timeout(120000) });
const text = await response.text();
const id = response.headers.get('x-router4u-request-id');
if (!response.ok) throw new Error(`Inference returned HTTP ${response.status}; request ${id ?? 'not admitted'}. Inspect the authorized exchange for details.`);
if (!id) throw new Error('Missing service request ID');
const recordResponse = await fetch(`${base}/v1/requests/${id}`, { headers });
if (!recordResponse.ok) throw new Error('Unable to retrieve the request record');
const record = await recordResponse.json();
console.log(JSON.stringify({ request_id: id, execution: record.execution, delivery: record.delivery,
  accounting: record.accounting, capture: record.capture, usage: record.usage, received_bytes: Buffer.byteLength(text) }, null, 2));
if (record.execution !== 'completed' || record.delivery !== 'complete' || record.capture !== 'complete') process.exitCode = 1;
