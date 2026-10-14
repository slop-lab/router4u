export class ServiceError extends Error {
  constructor(status, code, message, scope = 'service', retryable = false) {
    super(message);
    Object.assign(this, { status, code, scope, retryable });
  }
}

export function requireValue(condition, message) {
  if (!condition) throw new ServiceError(400, 'invalid_request', message);
}

export function errorBody(error, requestId = null) {
  return { error: { message: error instanceof ServiceError ? error.message : 'Service storage or execution unavailable',
    type: 'router4u_error', code: error.code ?? 'service_unavailable',
    scope: error.scope ?? 'service', retryable: error.retryable ?? false, request_id: requestId } };
}
