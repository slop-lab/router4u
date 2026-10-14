import { ServiceError, requireValue } from './errors.js';

export function validatePayload(payload, route, protocol) {
  requireValue(payload && typeof payload === 'object' && !Array.isArray(payload), 'Expected a JSON object');
  requireValue(typeof payload.model === 'string' && route.models.includes(payload.model), 'Model is not allowed on this route');
  if (!route.protocols.includes(protocol)) throw new ServiceError(400, 'unsupported_capability', 'Protocol is not supported on this route');
  if (payload.previous_response_id != null || payload.conversation != null || payload.background === true) {
    throw new ServiceError(400, 'unsupported_capability', 'Persistent continuation and background execution are unavailable; send complete input history');
  }
  requireValue(payload.stream === undefined || typeof payload.stream === 'boolean', 'stream must be boolean');
}

export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw.input_tokens ?? raw.prompt_tokens;
  const output = raw.output_tokens ?? raw.completion_tokens;
  if (![input, output].every(value => Number.isSafeInteger(value) && value >= 0) || !Number.isSafeInteger(input + output)) return null;
  if (raw.total_tokens != null && raw.total_tokens !== input + output) return null;
  return { input, output, total: input + output, raw, source: 'backend_response', quality: 'reported_request_usage',
    detail_semantics: 'Cached input and reasoning detail fields are subsets; never added to totals', completeness: 'request_only' };
}

export class ResponseObserver {
  constructor(protocol, streaming, maxBytes) {
    Object.assign(this, { protocol, streaming, maxBytes, bytes: 0, pending: '', terminal: false,
      outcome: 'outcome_unknown', usage: null, observedModel: null, responseId: null, invalid: false, usageConflict: false, error: null });
    this.decoder = new TextDecoder();
  }
  push(chunk) {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) throw new ServiceError(502, 'response_too_large', 'Response exceeds the configured byte limit');
    this.pending += this.decoder.decode(chunk, { stream: true });
    if (!this.streaming) return;
    let boundary;
    while ((boundary = this.pending.search(/\r?\n\r?\n/)) !== -1) {
      const frame = this.pending.slice(0, boundary);
      const separator = this.pending.slice(boundary).match(/^\r?\n\r?\n/)[0];
      this.pending = this.pending.slice(boundary + separator.length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      if (data === '[DONE]') { if (this.protocol === 'chat') { this.terminal = true; this.outcome = 'completed'; } continue; }
      try { this.observe(JSON.parse(data)); } catch { this.invalid = true; }
    }
    if (Buffer.byteLength(this.pending) > 1048576) throw new ServiceError(502, 'invalid_stream', 'SSE event exceeds one MiB');
  }
  observe(event) {
    const response = event.response ?? event;
    this.observedModel = response.model ?? this.observedModel;
    this.responseId = response.id ?? this.responseId;
    if (response.usage) {
      const observation = normalizeUsage(response.usage);
      if (this.terminal && this.usage && observation && (this.usage.input !== observation.input || this.usage.output !== observation.output)) this.usageConflict = true;
      this.usage = this.usageConflict ? null : observation;
    }
    if (response.error || event.type === 'error') this.error = String(response.error?.code ?? event.code ?? 'upstream_stream_error').slice(0, 200);
    if (this.protocol === 'responses') {
      const status = event.type ?? response.status;
      if (['response.completed', 'completed', 'response.failed', 'failed', 'response.incomplete', 'incomplete'].includes(status)) {
        this.terminal = true;
        this.outcome = ['response.completed', 'completed'].includes(status) ? 'completed' : 'failed';
      }
    } else if (!this.streaming && Array.isArray(response.choices)) {
      this.terminal = true;
      this.outcome = 'completed';
    }
  }
  finish() {
    this.pending += this.decoder.decode();
    if (!this.streaming) {
      try { this.observe(JSON.parse(this.pending)); } catch { this.invalid = true; }
    }
    if (this.invalid) this.outcome = 'outcome_unknown';
    return this;
  }
}
