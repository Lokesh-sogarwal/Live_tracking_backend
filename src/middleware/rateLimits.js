import { rateLimit } from 'express-rate-limit';

// In-memory stores are per process. With more than one API instance, plug in a shared
// store (e.g. rate-limit-redis) — see docs/ARCHITECTURE.md.
export function createRateLimiters(config) {
  const make = (opts) =>
    config.RATE_LIMIT_ENABLED
      ? rateLimit({
          standardHeaders: 'draft-7',
          legacyHeaders: false,
          handler: (_req, res) =>
            res.status(429).json({ error: 'Too many requests, please try again later', code: 'RATE_LIMITED' }),
          ...opts,
        })
      : (_req, _res, next) => next();

  return {
    api: make({ windowMs: 60_000, limit: 600 }),
    login: make({
      windowMs: 15 * 60_000,
      limit: config.LOGIN_RATE_LIMIT_MAX,
      // Per IP + email so one attacker cannot lock out every account from one IP range.
      keyGenerator: (req) => `${req.ip}:${String(req.body?.email || '').toLowerCase()}`,
    }),
    signup: make({ windowMs: 60 * 60_000, limit: 30 }),
    otp: make({ windowMs: 15 * 60_000, limit: 10 }),
    // Forgot/reset password: per IP + email (or IP for reset links).
    passwordReset: make({
      windowMs: 15 * 60_000,
      limit: 5,
      keyGenerator: (req) => `${req.ip}:${String(req.body?.email || '').toLowerCase()}`,
    }),
    signupCode: make({
      windowMs: 15 * 60_000,
      limit: 10,
      keyGenerator: (req) => `${req.ip}:${String(req.body?.email || '').toLowerCase()}`,
    }),
    application: make({ windowMs: 15 * 60_000, limit: 60, keyGenerator: (req) => req.headers.authorization || req.ip }),
    feedbackReply: make({ windowMs: 10 * 60_000, limit: 60, keyGenerator: (req) => req.user?.userId || req.ip }),
    passwordChange: make({ windowMs: 15 * 60_000, limit: 10, keyGenerator: (req) => req.user?.userId || req.ip }),
    geo: make({ windowMs: 60_000, limit: 60, keyGenerator: (req) => req.user?.userId || req.ip }),
    upload: make({ windowMs: 15 * 60_000, limit: 30, keyGenerator: (req) => req.user?.userId || req.ip }),
  };
}
