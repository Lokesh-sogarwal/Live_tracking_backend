import 'dotenv/config';
import { z } from 'zod';

const bool = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(5001),
  LOG_LEVEL: z.string().default('info'),
  TRUST_PROXY: int(0),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  JWT_EXPIRES_IN: z.string().default('3h'),

  FRONTEND_ORIGINS: z.string().default('http://localhost:3000'),

  // Wall-clock timezone used for schedule dates ("YYYY-MM-DD"), the 07:00 trip start
  // and the legacy "YYYY-MM-DD HH:MM:SS" strings the React UI renders.
  APP_TIMEZONE: z.string().default('Asia/Kolkata'),

  ORS_API_KEY: z.string().optional().default(''),
  ORS_BASE_URL: z.string().url().default('https://api.openrouteservice.org'),
  NOMINATIM_BASE_URL: z.string().url().default('https://nominatim.openstreetmap.org'),
  GEO_USER_AGENT: z.string().default('LiveTrackingApp/1.0'),
  EXTERNAL_HTTP_TIMEOUT_MS: int(8000),
  EXTERNAL_HTTP_RETRIES: int(2),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  LOCAL_UPLOAD_DIR: z.string().default('./var/uploads'),
  UPLOAD_BUCKET: z.string().optional().default(''),
  S3_REGION: z.string().optional().default('us-east-1'),
  S3_ENDPOINT: z.string().optional().default(''),
  S3_FORCE_PATH_STYLE: bool(false),
  MAX_UPLOAD_BYTES: int(5 * 1024 * 1024),
  DOWNLOAD_LINK_TTL_SECONDS: int(900),

  LOCATION_STALE_SECONDS: int(120),
  LOCATION_MAX_FUTURE_SKEW_SECONDS: int(30),
  LOCATION_HISTORY_ENABLED: bool(false),
  LOCATION_HISTORY_TTL_DAYS: int(7),
  LOCATION_RELAY_MS: int(1000),

  // Worker
  // Also run the worker jobs inside the API process (`node src/server.js`). For hosts without a
  // background-worker service (e.g. a free Render web service). Off: run `npm run start:worker`.
  RUN_WORKER: bool(false),
  SCHEDULER_ENABLED: bool(true),
  // Daily run time (APP_TIMEZONE, default Asia/Kolkata): midnight. Each run (re)fills the
  // window today .. today + SCHEDULE_DAYS_AHEAD.
  SCHEDULE_CRON_TIME: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'SCHEDULE_CRON_TIME must be HH:MM').default('00:00'),
  SCHEDULE_DAYS_AHEAD: int(7).pipe(z.number().int().min(0).max(60)),
  SCHEDULE_CATCHUP_ON_START: bool(true),
  SIMULATION_ENABLED: bool(false),
  SIMULATION_TICK_MS: int(2000),

  RATE_LIMIT_ENABLED: bool(true),
  LOGIN_RATE_LIMIT_MAX: int(10),
  CHAT_RATE_LIMIT_PER_10S: int(10),
  CHAT_MAX_MESSAGE_LENGTH: int(2000),

  PUBLIC_SIGNUP_ENABLED: bool(true),

  // Password reset. With SMTP_HOST and MAIL_FROM set, "forgot password" emails a one-time
  // link; otherwise the request goes to administrators, who issue a temporary password.
  // Resend (https://resend.com) HTTP API. When RESEND_API_KEY is set it is used instead of
  // SMTP. MAIL_FROM must be an address on a domain verified in Resend.
  RESEND_API_KEY: z.string().trim().optional().default(''),
  RESEND_API_URL: z.string().url().default('https://api.resend.com'),
  SMTP_HOST: z.string().trim().optional().default(''),
  SMTP_PORT: int(587),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  MAIL_FROM: z.string().trim().optional().default(''),
  // Base URL of the React app used in reset links; defaults to the first FRONTEND_ORIGINS entry.
  APP_PUBLIC_URL: z.string().trim().optional().default(''),
  PASSWORD_RESET_TTL_MINUTES: int(30).pipe(z.number().int().min(5).max(24 * 60)),

  // Signup email verification (one-time code sent with the mailer above) and driver/operator
  // applications. Without mail, passengers sign up unverified and applications are refused.
  SIGNUP_CODE_TTL_MINUTES: int(10).pipe(z.number().int().min(2).max(60)),
  APPLICATION_SESSION_HOURS: int(12).pipe(z.number().int().min(1).max(72)),
  OPERATOR_OFFER_LETTER_REQUIRED: bool(true),
  // Feedback replies are emailed only to verified addresses unless this is true (accounts
  // created before signup verification existed have no verified email).
  FEEDBACK_EMAIL_UNVERIFIED: bool(false),

  // Default admin account created on startup if the email does not exist yet.
  DEFAULT_ADMIN_EMAIL: z
    .string()
    .optional()
    .transform((v) => (v ? v.trim().toLowerCase() : ''))
    .pipe(z.union([z.literal(''), z.string().email('DEFAULT_ADMIN_EMAIL must be a valid email')])),
  DEFAULT_ADMIN_PASSWORD: z.string().optional().default(''),
  DEFAULT_ADMIN_NAME: z.string().trim().min(1).max(150).default('Administrator'),
  DEFAULT_ADMIN_ROLE: z
    .string()
    .optional()
    .transform((v) => (v || 'superadmin').trim().toLowerCase())
    .pipe(z.enum(['superadmin', 'admin'], { message: 'DEFAULT_ADMIN_ROLE must be superadmin or admin' })),
});

const UNSAFE_SECRETS = new Set([
  'changeme',
  'change-me',
  'secret',
  'replace-with-a-secure-secret',
  'replace-with-jwt-secret',
  '--default-secret--',
]);

const UNSAFE_ADMIN_PASSWORDS = new Set([
  'change-me-please',
  'replace-with-a-strong-password',
  'password1234',
  'admin1234567',
  'administrator',
]);

// FRONTEND_ORIGINS entries are exact origins or *scoped* patterns for preview deployments, e.g.
// https://live-tracking-frontend-*-lokesh-sogarwals-projects.vercel.app — "*" matches letters,
// digits and dashes inside the first host label only (never a dot), and must be followed by
// fixed text in that label (your team suffix), so it can't match someone else's site.
const PATTERN_RULE = /^https:\/\/[a-z0-9-]*\*[a-z0-9-]*[a-z0-9]-?[a-z0-9-]*\.[a-z0-9.-]+$/i;
export function validateOriginPattern(entry) {
  if (!entry.includes('*')) return null;
  if ((entry.match(/\*/g) || []).length !== 1) return 'only one "*" is allowed per origin pattern';
  if (!PATTERN_RULE.test(entry)) return 'patterns must be https://<label-with-*>.<domain> with "*" in the first label';
  const label = entry.slice('https://'.length).split('.')[0];
  if (!/\*[a-z0-9-]*[a-z0-9]{3,}/i.test(label)) return 'a pattern needs fixed text after "*" in its first label (e.g. your Vercel team suffix)';
  return null;
}

export function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;

  if (cfg.DEFAULT_ADMIN_EMAIL || cfg.DEFAULT_ADMIN_PASSWORD) {
    if (!cfg.DEFAULT_ADMIN_EMAIL || !cfg.DEFAULT_ADMIN_PASSWORD) {
      throw new Error('Invalid configuration: set both DEFAULT_ADMIN_EMAIL and DEFAULT_ADMIN_PASSWORD, or neither');
    }
    if (cfg.DEFAULT_ADMIN_PASSWORD.length < 12) {
      throw new Error('Invalid configuration: DEFAULT_ADMIN_PASSWORD must be at least 12 characters');
    }
    if (UNSAFE_ADMIN_PASSWORDS.has(cfg.DEFAULT_ADMIN_PASSWORD.toLowerCase())) {
      throw new Error('Invalid configuration: DEFAULT_ADMIN_PASSWORD is a placeholder; choose a real password');
    }
  }

  if ((cfg.SMTP_HOST || cfg.RESEND_API_KEY) && !cfg.MAIL_FROM) {
    throw new Error('Invalid configuration: MAIL_FROM is required when RESEND_API_KEY or SMTP_HOST is set');
  }
  if (cfg.RESEND_API_KEY && !cfg.RESEND_API_KEY.startsWith('re_')) {
    throw new Error('Invalid configuration: RESEND_API_KEY does not look like a Resend key (it starts with "re_")');
  }
  if (Boolean(cfg.SMTP_USER) !== Boolean(cfg.SMTP_PASS)) {
    throw new Error('Invalid configuration: set both SMTP_USER and SMTP_PASS, or neither');
  }

  for (const o of cfg.FRONTEND_ORIGINS.split(',').map((x) => x.trim()).filter(Boolean)) {
    if (o === '*') continue; // handled below (refused in production)
    const problem = validateOriginPattern(o);
    if (problem) throw new Error(`Invalid configuration: FRONTEND_ORIGINS entry "${o}": ${problem}`);
  }

  if (cfg.NODE_ENV === 'production') {
    if (cfg.JWT_SECRET.length < 32 || UNSAFE_SECRETS.has(cfg.JWT_SECRET.toLowerCase())) {
      throw new Error('Invalid configuration: JWT_SECRET must be a random value of at least 32 characters in production');
    }
    if (cfg.STORAGE_DRIVER !== 's3') {
      throw new Error('Invalid configuration: STORAGE_DRIVER=s3 is required in production (local disk is ephemeral)');
    }
    if (!cfg.UPLOAD_BUCKET) {
      throw new Error('Invalid configuration: UPLOAD_BUCKET is required when STORAGE_DRIVER=s3');
    }
    if (cfg.FRONTEND_ORIGINS.split(',').some((o) => o.trim() === '*')) {
      throw new Error('Invalid configuration: wildcard FRONTEND_ORIGINS is not allowed in production');
    }
  }

  return {
    ...cfg,
    isProduction: cfg.NODE_ENV === 'production',
    isTest: cfg.NODE_ENV === 'test',
    frontendOrigins: cfg.FRONTEND_ORIGINS.split(',')
      .map((o) => o.trim().replace(/\/$/, ''))
      .filter(Boolean),
    mailProvider: cfg.RESEND_API_KEY ? 'resend' : cfg.SMTP_HOST ? 'smtp' : null,
    mailEnabled: Boolean((cfg.RESEND_API_KEY || cfg.SMTP_HOST) && cfg.MAIL_FROM),
    // Emailed links need a real address: never a pattern entry.
    appPublicUrl: (cfg.APP_PUBLIC_URL || cfg.FRONTEND_ORIGINS.split(',').map((o) => o.trim()).find((o) => o && !o.includes('*')) || '').trim().replace(/\/$/, ''),
  };
}
