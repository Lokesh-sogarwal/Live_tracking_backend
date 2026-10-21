import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { User, Session } from '../src/models/index.js';
import { verifyPassword } from '../src/services/passwords.js';
import { loadConfig } from '../src/config/index.js';
import { createApp } from '../src/app.js';
import { JWT_SECRET, PASSWORD, bearer, createUser, login, setupTestApp, userWithToken } from './helpers.js';

// Generated with Werkzeug's generate_password_hash('Legacy#Pass1', ...).
const WERKZEUG = {
  scrypt: 'scrypt:32768:8:1$16j25oUKYvpqeMui$94b7c8a9514c61ee3032a133210cbca6828af302d04adc19d07f394d698d66a489a832d195c42b871c57be34340cc37922391edaf3e62274fb182eaab035a25b',
  pbkdf2_256: 'pbkdf2:sha256:1000$O08MQozaHdcW89on$2f57b88d1958a36f5cc1e28c3835dda3f0d7fbf76f50c5d50156a05397e51389',
  pbkdf2_512: 'pbkdf2:sha512:1000$5VsbzZxGObHJhI3i$6ab71ee634a8f8dc3538a84923936418854e429cc5b70c29fb3e2f6f0bde7ffe89d29b0905ff9b35732b23e96e9e4d1b6d9e231fa28be767fe048aad25f346e1',
};

let t;
beforeAll(async () => {
  t = await setupTestApp('auth');
});
afterAll(() => t.close());

describe('password hashing', () => {
  it.each(Object.entries(WERKZEUG))('verifies legacy Werkzeug %s hashes and flags rehash', async (_n, hash) => {
    expect(await verifyPassword('Legacy#Pass1', hash)).toEqual({ ok: true, needsRehash: true });
    expect((await verifyPassword('wrong', hash)).ok).toBe(false);
  });
});

describe('POST /auth/signup', () => {
  it('creates a passenger and never returns a hash', async () => {
    const res = await request(t.app).post('/auth/signup').send({ fullname: 'Asha', email: ' Asha@Example.com ', password: 'Abcdef#1', role: 'Passenger', is_password_change: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: 'asha@example.com', role: 'Passenger' });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    const stored = await User.findOne({ email: 'asha@example.com' }).select('+passwordHash').lean();
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
  });

  it('rejects duplicate email (case-insensitive) with 409', async () => {
    const res = await request(t.app).post('/auth/signup').send({ fullname: 'Asha 2', email: 'ASHA@example.com', password: 'Abcdef#1' });
    expect(res.status).toBe(409);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects missing fields and short passwords with 400', async () => {
    expect((await request(t.app).post('/auth/signup').send({ email: 'x@example.com', password: 'Abcdef#1' })).status).toBe(400);
    expect((await request(t.app).post('/auth/signup').send({ fullname: 'X', email: 'bad', password: 'Abcdef#1' })).status).toBe(400);
    expect((await request(t.app).post('/auth/signup').send({ fullname: 'X', email: 'x@example.com', password: 'short' })).status).toBe(400);
  });

  it.each(['Admin', 'SuperAdmin', 'superadmin', 'Driver', 'operator'])('blocks anonymous signup as %s', async (role) => {
    const res = await request(t.app).post('/auth/signup').send({ fullname: 'Mallory', email: `m-${role}@example.com`, password: 'Abcdef#1', role });
    expect(res.status).toBe(403);
    expect(await User.exists({ email: `m-${role.toLowerCase()}@example.com` })).toBeNull();
  });

  it('lets an admin create a driver but not a superadmin', async () => {
    const { token } = await userWithToken(t.app, 'admin');
    const ok = await request(t.app).post('/auth/signup').set(bearer(token)).send({ fullname: 'Ravi', email: 'ravi@example.com', password: 'Ravi123', role: 'Driver', is_password_change: false });
    expect(ok.status).toBe(200);
    expect(ok.body.role).toBe('Driver');
    const bad = await request(t.app).post('/auth/signup').set(bearer(token)).send({ fullname: 'Boss', email: 'boss@example.com', password: 'Boss1234', role: 'Superadmin' });
    expect(bad.status).toBe(403);
  });

  it('does not let a passenger token escalate', async () => {
    const { token } = await userWithToken(t.app, 'passenger');
    const res = await request(t.app).post('/auth/signup').set(bearer(token)).send({ fullname: 'E', email: 'e@example.com', password: 'Abcdef#1', role: 'Admin' });
    expect(res.status).toBe(403);
  });
});

describe('POST /auth/login and tokens', () => {
  it('logs in, returns legacy claims', async () => {
    const user = await createUser('driver');
    const token = await login(t.app, user);
    const claims = jwt.decode(token);
    expect(claims).toMatchObject({ user_id: user.userId, role: 'Driver', is_password_change: false });
    expect(claims.exp - claims.iat).toBe(3 * 3600);
  });

  it('rejects wrong password and unknown email with the same 401', async () => {
    const user = await createUser();
    const a = await request(t.app).post('/auth/login').send({ email: user.email, password: 'nope' });
    const b = await request(t.app).post('/auth/login').send({ email: 'nobody@example.com', password: 'nope' });
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(a.body.error).toBe(b.body.error);
  });

  it('rejects missing credentials with 400', async () => {
    expect((await request(t.app).post('/auth/login').send({ email: 'a@example.com' })).status).toBe(400);
  });

  it('logs in a migrated Werkzeug user and upgrades the hash to bcrypt', async () => {
    const user = await createUser('passenger', { passwordHash: WERKZEUG.scrypt });
    await login(t.app, user, 'Legacy#Pass1');
    const stored = await User.findById(user._id).select('+passwordHash').lean();
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
    await login(t.app, user, 'Legacy#Pass1');
  });

  it('protects routes: missing, malformed, forged and expired tokens get 401', async () => {
    expect((await request(t.app).get('/view/profile')).status).toBe(401);
    expect((await request(t.app).get('/view/profile').set('Authorization', 'Token abc')).status).toBe(401);
    const user = await createUser();
    const forged = jwt.sign({ user_id: user.userId, role: 'Superadmin', jti: 'x' }, 'not-the-secret');
    expect((await request(t.app).get('/view/profile').set(bearer(forged))).status).toBe(401);
    const token = await login(t.app, user);
    const { jti } = jwt.decode(token);
    const expired = jwt.sign({ user_id: user.userId, jti, exp: Math.floor(Date.now() / 1000) - 10 }, JWT_SECRET);
    const res = await request(t.app).get('/view/profile').set(bearer(expired));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Token expired');
  });

  it('ignores the role claim in a token: role is read from the database', async () => {
    const user = await createUser('passenger');
    const token = await login(t.app, user);
    const { jti } = jwt.decode(token);
    const tampered = jwt.sign({ user_id: user.userId, role: 'Superadmin', jti }, JWT_SECRET);
    expect((await request(t.app).get('/permissions/matrix').set(bearer(tampered))).status).toBe(403);
  });

  it('logout revokes the session server-side', async () => {
    const { token } = await userWithToken(t.app, 'passenger');
    expect((await request(t.app).get('/view/profile').set(bearer(token))).status).toBe(200);
    expect((await request(t.app).post('/auth/logout').set(bearer(token))).status).toBe(200);
    const after = await request(t.app).get('/view/profile').set(bearer(token));
    expect(after.status).toBe(401);
    const { jti } = jwt.decode(token);
    expect((await Session.findOne({ jti }).lean()).revokedAt).toBeTruthy();
  });
});

describe('profile', () => {
  it('GET/PUT profile; role in body is ignored; /auth/profile alias works', async () => {
    const { user, token } = await userWithToken(t.app, 'passenger');
    const get = await request(t.app).get('/auth/profile').set(bearer(token));
    expect(get.body).toMatchObject({ email: user.email, role: 'Passenger' });
    const put = await request(t.app).put('/auth/profile').set(bearer(token)).send({ fullname: 'New Name', fathername: 'Dad', role: 'Superadmin' });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ fullname: 'New Name', fathername: 'Dad', role: 'Passenger' });
    const multipart = await request(t.app).put('/view/profile').set(bearer(token)).field('fullname', 'Multi').attach('profileimg', Buffer.from('x'), 'a.png');
    expect(multipart.status).toBe(200);
    expect(multipart.body.fullname).toBe('Multi');
  });

  it('OTP endpoint is explicitly not implemented', async () => {
    expect((await request(t.app).post('/auth/verify_otp').send({ otp: '1' })).status).toBe(501);
  });
});

describe('rate limiting and config', () => {
  it('limits repeated login attempts', async () => {
    const config = { ...t.config, RATE_LIMIT_ENABLED: true, LOGIN_RATE_LIMIT_MAX: 3 };
    const app = createApp({ ...t.ctx, config });
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await request(app).post('/auth/login').send({ email: 'x@example.com', password: 'bad' })).status);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
  });

  it('fails fast on unsafe production configuration', () => {
    const base = { NODE_ENV: 'production', MONGODB_URI: 'mongodb://x', STORAGE_DRIVER: 's3', UPLOAD_BUCKET: 'b', FRONTEND_ORIGINS: 'https://a.example' };
    expect(() => loadConfig({ ...base, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...base, JWT_SECRET: JWT_SECRET, STORAGE_DRIVER: 'local' })).toThrow(/STORAGE_DRIVER/);
    expect(() => loadConfig({ ...base, JWT_SECRET: JWT_SECRET, FRONTEND_ORIGINS: '*' })).toThrow(/wildcard/);
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/MONGODB_URI/);
    expect(loadConfig({ ...base, JWT_SECRET: JWT_SECRET }).isProduction).toBe(true);
    expect(PASSWORD).toBeTruthy();
  });
});
