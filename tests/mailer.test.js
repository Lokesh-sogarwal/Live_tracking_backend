import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMailer } from '../src/services/mailer.js';
import { loadConfig } from '../src/config/index.js';

const base = { NODE_ENV: 'test', MONGODB_URI: 'mongodb://x/y', JWT_SECRET: 'x'.repeat(40) };
const KEY = 're_test_not_a_real_key_123';

describe('mail provider selection and Resend', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is disabled without configuration, Resend with a key, SMTP otherwise', () => {
    expect(createMailer(loadConfig(base)).enabled).toBe(false);
    expect(createMailer(loadConfig({ ...base, RESEND_API_KEY: KEY, MAIL_FROM: 'Live <a@x.example>' })).provider).toBe('resend');
    expect(createMailer(loadConfig({ ...base, SMTP_HOST: 'smtp.x.example', MAIL_FROM: 'a@x.example' })).provider).toBe('smtp');
    expect(() => loadConfig({ ...base, RESEND_API_KEY: KEY })).toThrow(/MAIL_FROM/);
    expect(() => loadConfig({ ...base, RESEND_API_KEY: 'nope', MAIL_FROM: 'a@x.example' })).toThrow(/Resend key/);
  });

  it('posts to Resend with the key, idempotency key and sender, and returns the id', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'em_123' }), { status: 200 }));
    const mailer = createMailer(loadConfig({ ...base, RESEND_API_KEY: KEY, MAIL_FROM: 'Live <a@x.example>' }));
    const out = await mailer.send({ to: 'u@example.com', subject: 'Hi', text: 'Body', idempotencyKey: 'feedback-reply/1' });
    expect(out).toEqual({ id: 'em_123' });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(opts.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, 'Idempotency-Key': 'feedback-reply/1' });
    expect(JSON.parse(opts.body)).toEqual({ from: 'Live <a@x.example>', to: ['u@example.com'], subject: 'Hi', text: 'Body' });
  });

  it('treats any non-accepted answer as a failure, without leaking the key', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ name: 'validation_error', message: 'The domain is not verified' }), { status: 403 }));
    const mailer = createMailer(loadConfig({ ...base, RESEND_API_KEY: KEY, MAIL_FROM: 'a@x.example' }));
    const err = await mailer.send({ to: 'u@example.com', subject: 'Hi', text: 'Body' }).catch((e) => e);
    expect(err.code).toBe('validation_error');
    expect(err.message).not.toContain(KEY);

    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(mailer.send({ to: 'u@example.com', subject: 'Hi', text: 'Body' })).rejects.toThrow(/rejected/);
    vi.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    await expect(mailer.send({ to: 'u@example.com', subject: 'Hi', text: 'Body' })).rejects.toMatchObject({ code: 'RESEND_UNREACHABLE' });
  });
});
