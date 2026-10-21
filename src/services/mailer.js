import nodemailer from 'nodemailer';

// Outgoing mail: password-reset links, signup codes, application updates, feedback replies.
// Provider: Resend's HTTP API when RESEND_API_KEY is set, otherwise SMTP (nodemailer), otherwise
// disabled (enabled: false). Tests and alternative transports can pass ctx.mailer instead.
//
// send() resolves only after the provider accepted the message and rejects otherwise, so
// callers never record a message as sent when it was not. idempotencyKey (optional) stops the
// provider from sending twice when the same logical message is retried.
export class MailError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function resendMailer(config) {
  const url = `${config.RESEND_API_URL.replace(/\/$/, '')}/emails`;
  return {
    enabled: true,
    provider: 'resend',
    async send({ to, subject, text, html, idempotencyKey }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          },
          body: JSON.stringify({ from: config.MAIL_FROM, to: [to], subject, text, ...(html ? { html } : {}) }),
          signal: controller.signal,
        });
      } catch (err) {
        throw new MailError(err.name === 'AbortError' ? 'Resend request timed out' : 'Could not reach Resend', { code: 'RESEND_UNREACHABLE' });
      } finally {
        clearTimeout(timer);
      }
      const data = await res.json().catch(() => ({}));
      // Resend answers 200 with { id } when it accepted the email; anything else is a failure.
      // The error text comes from Resend's response ({ name, message }) and never includes the key.
      if (!res.ok || !data.id) {
        throw new MailError(`Resend rejected the email (${res.status}${data.name ? ` ${data.name}` : ''})`, { code: data.name || `RESEND_${res.status}`, status: res.status });
      }
      return { id: data.id };
    },
  };
}

function smtpMailer(config) {
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
    // Messages are built from our own text only; never let content pull in files or URLs.
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    enabled: true,
    provider: 'smtp',
    async send({ to, subject, text, html, idempotencyKey }) {
      const info = await transport.sendMail({
        from: config.MAIL_FROM,
        to,
        subject,
        text,
        html,
        ...(idempotencyKey ? { messageId: `<${idempotencyKey}@live-tracking>` } : {}),
      });
      return { id: info.messageId };
    },
  };
}

export function createMailer(config) {
  if (!config.mailEnabled) return { enabled: false, provider: null, async send() { throw new MailError('Mail is not configured', { code: 'NOT_CONFIGURED' }); } };
  return config.mailProvider === 'resend' ? resendMailer(config) : smtpMailer(config);
}
