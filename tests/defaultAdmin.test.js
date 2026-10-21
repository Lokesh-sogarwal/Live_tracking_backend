import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { User } from '../src/models/index.js';
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/config/logger.js';
import { ensureDefaultAdmin } from '../src/services/defaultAdmin.js';
import { bearer, createUser, setupTestApp } from './helpers.js';

const logger = createLogger('silent');
const ADMIN = { DEFAULT_ADMIN_EMAIL: ' Root.Admin@Example.com ', DEFAULT_ADMIN_PASSWORD: 'Default-Admin-Pass-2026', DEFAULT_ADMIN_NAME: 'Root Admin' };

let t;
beforeAll(async () => {
  t = await setupTestApp('default_admin', ADMIN);
});
afterAll(() => t.close());

describe('default admin from environment', () => {
  it('is created once, as superadmin, with a normalized email, and can log in', async () => {
    expect(await ensureDefaultAdmin(t.config, logger)).toEqual({ status: 'created' });
    expect(await ensureDefaultAdmin(t.config, logger)).toEqual({ status: 'exists' });
    expect(await User.countDocuments({ email: 'root.admin@example.com' })).toBe(1);

    const login = await request(t.app).post('/auth/login').send({ email: 'root.admin@example.com', password: 'Default-Admin-Pass-2026' });
    expect(login.status).toBe(200);
    const me = await request(t.app).get('/view/profile').set(bearer(login.body.token));
    expect(me.body).toMatchObject({ fullname: 'Root Admin', role: 'Superadmin' });
    expect((await request(t.app).get('/permissions/matrix').set(bearer(login.body.token))).status).toBe(200);
  });

  it('concurrent startups create exactly one account', async () => {
    const config = loadConfig({ ...process.env, NODE_ENV: 'test', MONGODB_URI: t.config.MONGODB_URI, JWT_SECRET: t.config.JWT_SECRET, DEFAULT_ADMIN_EMAIL: 'race.admin@example.com', DEFAULT_ADMIN_PASSWORD: 'Race-Admin-Pass-2026' });
    const results = await Promise.all([1, 2, 3, 4].map(() => ensureDefaultAdmin(config, logger)));
    expect(results.filter((r) => r.status === 'created')).toHaveLength(1);
    expect(await User.countDocuments({ email: 'race.admin@example.com' })).toBe(1);
  });

  it('never changes an existing account (password and role kept)', async () => {
    const existing = await createUser('passenger', { email: 'taken@example.com' });
    const config = { ...t.config, DEFAULT_ADMIN_EMAIL: 'taken@example.com', DEFAULT_ADMIN_PASSWORD: 'Another-Admin-Pass-1', DEFAULT_ADMIN_ROLE: 'superadmin' };
    expect(await ensureDefaultAdmin(config, logger)).toEqual({ status: 'exists' });
    const after = await User.findById(existing._id).select('+passwordHash').lean();
    expect(after.roleKey).toBe('passenger');
    expect(after.passwordHash).toBe(existing.passwordHash);
    const login = await request(t.app).post('/auth/login').send({ email: 'taken@example.com', password: 'Another-Admin-Pass-1' });
    expect(login.status).toBe(401);
  });

  it('does nothing when not configured', async () => {
    expect(await ensureDefaultAdmin({ ...t.config, DEFAULT_ADMIN_EMAIL: '' }, logger)).toEqual({ status: 'not_configured' });
  });

  it('validates the configuration', () => {
    const base = { NODE_ENV: 'test', MONGODB_URI: 'mongodb://x', JWT_SECRET: 'x' };
    expect(() => loadConfig({ ...base, DEFAULT_ADMIN_EMAIL: 'a@example.com' })).toThrow(/both DEFAULT_ADMIN_EMAIL and DEFAULT_ADMIN_PASSWORD/);
    expect(() => loadConfig({ ...base, DEFAULT_ADMIN_PASSWORD: 'Long-Enough-Pass-1' })).toThrow(/both/);
    expect(() => loadConfig({ ...base, DEFAULT_ADMIN_EMAIL: 'not-an-email', DEFAULT_ADMIN_PASSWORD: 'Long-Enough-Pass-1' })).toThrow(/valid email/);
    expect(() => loadConfig({ ...base, DEFAULT_ADMIN_EMAIL: 'a@example.com', DEFAULT_ADMIN_PASSWORD: 'short' })).toThrow(/at least 12/);
    expect(() => loadConfig({ ...base, DEFAULT_ADMIN_EMAIL: 'a@example.com', DEFAULT_ADMIN_PASSWORD: 'change-me-please' })).toThrow(/placeholder/);
    expect(() => loadConfig({ ...base, DEFAULT_ADMIN_EMAIL: 'a@example.com', DEFAULT_ADMIN_PASSWORD: 'Long-Enough-Pass-1', DEFAULT_ADMIN_ROLE: 'driver' })).toThrow(/superadmin or admin/);
    const ok = loadConfig({ ...base, DEFAULT_ADMIN_EMAIL: 'A@Example.com', DEFAULT_ADMIN_PASSWORD: 'Long-Enough-Pass-1', DEFAULT_ADMIN_ROLE: 'Admin' });
    expect(ok).toMatchObject({ DEFAULT_ADMIN_EMAIL: 'a@example.com', DEFAULT_ADMIN_ROLE: 'admin', DEFAULT_ADMIN_NAME: 'Administrator' });
    expect(loadConfig(base).DEFAULT_ADMIN_EMAIL).toBe('');
  });
});
