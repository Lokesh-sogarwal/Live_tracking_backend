import pino from 'pino';

// Paths that must never reach log output.
const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  'token',
  '*.password',
  '*.token',
  '*.passwordHash',
  'msg_body',
  '*.current_password',
  '*.new_password',
  '*.temporary_password',
  'SMTP_PASS',
  'RESEND_API_KEY',
  '*.RESEND_API_KEY',
  '*.SMTP_PASS',
];

export function createLogger(level = process.env.LOG_LEVEL || 'info') {
  return pino({
    level,
    redact: { paths: REDACT, censor: '[REDACTED]' },
    base: { service: process.env.SERVICE_NAME || 'live-tracking-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
