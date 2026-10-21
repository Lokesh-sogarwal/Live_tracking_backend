import { randomUUID } from 'node:crypto';
import multer from 'multer';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';

export function requestId() {
  return (req, res, next) => {
    const incoming = req.headers['x-request-id'];
    req.id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  };
}

// validate({ body: schema, params: schema, query: schema }) — parsed values replace the raw ones.
export const validate = (schemas) => (req, _res, next) => {
  try {
    if (schemas.params) req.params = schemas.params.parse(req.params);
    if (schemas.query) req.validatedQuery = schemas.query.parse(req.query);
    if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
    return next();
  } catch (err) {
    return next(err);
  }
};

export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
}

// Legacy-compatible error body: { error: "<message>", code, details? }. The React app
// shows data.error in toasts, so it must stay a string.
export function errorHandler(logger, config) {
  return (err, req, res, _next) => {
    let status = 500;
    let body = { error: 'Internal Server Error', code: 'INTERNAL' };

    if (err instanceof AppError) {
      status = err.status;
      body = { error: err.message, code: err.code };
      if (err.details) body.details = err.details;
    } else if (err instanceof ZodError) {
      status = 400;
      const first = err.issues[0];
      const where = first?.path?.length ? `${first.path.join('.')}: ` : '';
      body = {
        error: `${where}${first?.message || 'Invalid input'}`,
        code: 'VALIDATION_ERROR',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    } else if (err instanceof multer.MulterError) {
      status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      body = { error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large' : err.message, code: 'UPLOAD_ERROR' };
    } else if (err?.type === 'entity.parse.failed') {
      status = 400;
      body = { error: 'Invalid JSON body', code: 'VALIDATION_ERROR' };
    } else if (err?.type === 'entity.too.large') {
      status = 413;
      body = { error: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' };
    } else if (err instanceof mongoose.Error.ValidationError || err instanceof mongoose.Error.CastError) {
      status = 400;
      body = { error: 'Invalid input', code: 'VALIDATION_ERROR' };
    } else if (err?.code === 11000) {
      status = 409;
      body = { error: 'Duplicate record', code: 'CONFLICT' };
    }

    if (status >= 500) {
      req.log?.error({ err: { message: err?.message, stack: config.isProduction ? undefined : err?.stack } }, 'Unhandled error');
      // Unexpected errors only (never in production); deliberate AppErrors carry their own message.
      if (!config.isProduction && !(err instanceof AppError) && err?.message) body.debug = err.message;
    }
    if (res.headersSent) return;
    res.status(status).json(body);
  };
}
