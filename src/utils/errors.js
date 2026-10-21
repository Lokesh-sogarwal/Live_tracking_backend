// Errors carry an HTTP status and a stable code. The response body keeps the legacy
// `error: "<message>"` string because every React screen renders `data.error` directly.
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, 'VALIDATION_ERROR', message, details);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message) => new AppError(409, 'CONFLICT', message);
export const notImplemented = (message) => new AppError(501, 'NOT_IMPLEMENTED', message);
export const upstreamError = (message) => new AppError(502, 'UPSTREAM_ERROR', message);
