import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { buildRouter } from './routes/index.js';
import { errorHandler, notFoundHandler, requestId } from './middleware/common.js';
import { createRateLimiters } from './middleware/rateLimits.js';

// Allowlist entries are exact origins or scoped patterns (see validateOriginPattern in
// config/index.js): "*" matches [a-z0-9-]+ within one host label, never a dot.
const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
export function originMatcher(allowlist) {
  const exact = new Set(allowlist.filter((o) => !o.includes('*')));
  const patterns = allowlist.filter((o) => o.includes('*') && o !== '*').map((o) => new RegExp(`^${escapeRe(o).replace('*', '[a-z0-9-]+')}$`, 'i'));
  const any = allowlist.includes('*');
  return (origin) => any || exact.has(origin) || patterns.some((re) => re.test(origin));
}

export function corsOriginCheck(allowlist) {
  const allowed = originMatcher(allowlist);
  return (origin, cb) => {
    // Requests without an Origin header (curl, server-to-server, same-origin navigation).
    if (!origin) return cb(null, true);
    return cb(null, allowed(origin.replace(/\/$/, '')));
  };
}

// ctx: { config, logger, geo, storage }
export function createApp(ctx) {
  const { config, logger } = ctx;
  const app = express();

  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', config.TRUST_PROXY);

  app.use(requestId());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      autoLogging: { ignore: (req) => req.url.startsWith('/health') },
      serializers: {
        // Query strings are dropped: signed download links carry credentials.
        req: (req) => ({ id: req.id, method: req.method, url: req.url.split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: corsOriginCheck(config.frontendOrigins),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  const limiters = createRateLimiters(config);
  app.use(limiters.api);
  app.use(buildRouter(ctx, limiters));

  app.use(notFoundHandler);
  app.use(errorHandler(logger, config));
  return app;
}
