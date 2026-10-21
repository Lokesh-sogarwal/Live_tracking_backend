import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Notification, PasswordReset, User } from '../src/models/index.js';
import { PASSWORD, bearer, createUser, login, setupTestApp, userWithToken } from './helpers.js';

const until = (fn) => vi.waitFor(fn, { timeout: 5000, interval: 50 });

describe('forgot password without email (admin channel)', () => {
  let t;
  beforeAll(async () => {
    t = await setupTestApp('pwreset_admin');
  });
  afterAll(() => t.close());

  it('answers the same for known and unknown emails and queues one request for admins', async () => {
    const admin = await createUser('admin');
    const passenger = await createUser('passenger');
    const known = await request(t.app).post('/auth/forgot_password').send({ email: passenger.email });
    const unknown = await request(t.app).post('/auth/forgot_password').send({ email: 'nobody@example.com' });
    expect(known.status).toBe(200);
    expect(known.body.delivery).toBe('admin');
    expect(unknown.body.message.replace('nobody@example.com', passenger.email)).toBe(known.body.message);

    await until(async () => expect(await PasswordReset.countDocuments({ user: passenger._id, channel: 'admin' })).toBe(1));
    await until(async () =>
      expect(await Notification.countDocuments({ user: admin._id, type: 'password_reset' })).toBe(1),
    );
    // A second request while one is open does not duplicate it or notify again.
    await request(t.app).post('/auth/forgot_password').send({ email: passenger.email });
    await new Promise((r) => setTimeout(r, 200));
    expect(await PasswordReset.countDocuments({ user: passenger._id, channel: 'admin' })).toBe(1);
    expect(await Notification.countDocuments({ user: admin._id, type: 'password_reset' })).toBe(1);
  });

  it('validates the email', async () => {
    const res = await request(t.app).post('/auth/forgot_password').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('lets an admin list requests and issue a temporary password; the user must then change it', async () => {
    const { token: adminToken } = await userWithToken(t.app, 'admin');
    const { user: target, token: oldToken } = await userWithToken(t.app, 'passenger');
    await request(t.app).post('/auth/forgot_password').send({ email: target.email });
    await until(async () => expect(await PasswordReset.exists({ user: target._id, resolvedAt: null })).toBeTruthy());

    const list = await request(t.app).get('/view/password_reset_requests').set(bearer(adminToken));
    expect(list.status).toBe(200);
    expect(list.body.map((u) => u.user_uuid)).toContain(target.userId);
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|tokenHash/);

    const reset = await request(t.app).post('/view/reset_user_password').set(bearer(adminToken)).send({ user_uuid: target.userId });
    expect(reset.status).toBe(200);
    expect(reset.headers['cache-control']).toBe('no-store');
    const temp = reset.body.temporary_password;
    expect(temp).toMatch(/^[A-Za-z2-9]{12}$/);
    expect(await PasswordReset.exists({ user: target._id, channel: 'admin', resolvedAt: null })).toBeNull();

    // Existing sessions are ended; the old password no longer works.
    expect((await request(t.app).get('/auth/profile').set(bearer(oldToken))).status).toBe(401);
    expect((await request(t.app).post('/auth/login').send({ email: target.email, password: PASSWORD })).status).toBe(401);

    const signIn = await request(t.app).post('/auth/login').send({ email: target.email, password: temp });
    expect(signIn.status).toBe(200);
    expect(signIn.body.must_change_password).toBe(true);
    expect(jwt.decode(signIn.body.token).must_change_password).toBe(true);
    const tempToken = signIn.body.token;

    const blocked = await request(t.app).get('/auth/profile').set(bearer(tempToken));
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const wrong = await request(t.app).post('/auth/change_password').set(bearer(tempToken)).send({ current_password: 'nope', new_password: 'Brand-new-1' });
    expect(wrong.status).toBe(400);
    const tooShort = await request(t.app).post('/auth/change_password').set(bearer(tempToken)).send({ current_password: temp, new_password: 'short' });
    expect(tooShort.status).toBe(400);
    const same = await request(t.app).post('/auth/change_password').set(bearer(tempToken)).send({ current_password: temp, new_password: temp });
    expect(same.status).toBe(400);

    const changed = await request(t.app).post('/auth/change_password').set(bearer(tempToken)).send({ current_password: temp, new_password: 'Brand-new-1' });
    expect(changed.status).toBe(200);
    expect(jwt.decode(changed.body.token).must_change_password).toBeUndefined();
    expect((await request(t.app).get('/auth/profile').set(bearer(tempToken))).status).toBe(401);
    expect((await request(t.app).get('/auth/profile').set(bearer(changed.body.token))).status).toBe(200);
    const stored = await User.findById(target._id).lean();
    expect(stored).toMatchObject({ mustChangePassword: false, isPasswordChange: true });
    expect(await login(t.app, target, 'Brand-new-1')).toBeTruthy();
  });

  it('still allows logout while a password change is pending', async () => {
    const { token: adminToken } = await userWithToken(t.app, 'admin');
    const target = await createUser('driver');
    const reset = await request(t.app).post('/view/reset_user_password').set(bearer(adminToken)).send({ user_uuid: target.userId });
    const tempToken = await login(t.app, target, reset.body.temporary_password);
    expect((await request(t.app).post('/auth/logout').set(bearer(tempToken))).status).toBe(200);
  });

  it('enforces role rank: no self reset, no equal rank, operators cannot reset', async () => {
    const { user: admin, token: adminToken } = await userWithToken(t.app, 'admin');
    const otherAdmin = await createUser('admin');
    const { token: opToken } = await userWithToken(t.app, 'operator');
    const { token: rootToken } = await userWithToken(t.app, 'superadmin');
    const passenger = await createUser('passenger');

    const self = await request(t.app).post('/view/reset_user_password').set(bearer(adminToken)).send({ user_uuid: admin.userId });
    expect(self.status).toBe(403);
    const peer = await request(t.app).post('/view/reset_user_password').set(bearer(adminToken)).send({ user_uuid: otherAdmin.userId });
    expect(peer.status).toBe(403);
    const op = await request(t.app).post('/view/reset_user_password').set(bearer(opToken)).send({ user_uuid: passenger.userId });
    expect(op.status).toBe(403);
    expect((await request(t.app).get('/view/password_reset_requests').set(bearer(opToken))).status).toBe(403);
    const root = await request(t.app).post('/view/reset_user_password').set(bearer(rootToken)).send({ user_uuid: otherAdmin.userId });
    expect(root.status).toBe(200);
  });

  it('only lists requests the caller may act on', async () => {
    const { token: adminToken } = await userWithToken(t.app, 'admin');
    const peer = await createUser('admin');
    await request(t.app).post('/auth/forgot_password').send({ email: peer.email });
    await until(async () => expect(await PasswordReset.exists({ user: peer._id })).toBeTruthy());
    const list = await request(t.app).get('/view/password_reset_requests').set(bearer(adminToken));
    expect(list.body.map((u) => u.user_uuid)).not.toContain(peer.userId);
  });

  it('rejects reset links when email is not configured', async () => {
    const res = await request(t.app).post('/auth/reset_password').send({ token: 'x'.repeat(43), password: 'Whatever-123' });
    expect(res.status).toBe(400);
  });
});

describe('forgot password by email', () => {
  let t;
  const sent = [];
  let failNext = false;
  const mailer = {
    enabled: true,
    async send(msg) {
      if (failNext) {
        failNext = false;
        throw new Error('SMTP down');
      }
      sent.push(msg);
    },
  };
  const tokenFrom = (msg) => msg.text.match(/#token=([A-Za-z0-9_-]+)/)[1];

  beforeAll(async () => {
    t = await setupTestApp('pwreset_email', { APP_PUBLIC_URL: 'https://app.example.com', PASSWORD_RESET_TTL_MINUTES: '30' }, { mailer });
  });
  afterAll(() => t.close());

  it('emails a one-time link, stores only its hash, and the link sets a new password once', async () => {
    const { user, token: oldToken } = await userWithToken(t.app, 'passenger');
    const res = await request(t.app).post('/auth/forgot_password').send({ email: user.email.toUpperCase() });
    expect(res.status).toBe(200);
    expect(res.body.delivery).toBe('email');
    expect(res.body.message).toMatch(/30 minutes/);
    await until(() => expect(sent.filter((m) => m.to === user.email)).toHaveLength(1));

    const msg = sent.find((m) => m.to === user.email);
    expect(msg.text).toContain('https://app.example.com/reset-password#token=');
    const token = tokenFrom(msg);
    const doc = await PasswordReset.findOne({ user: user._id, channel: 'email' }).lean();
    expect(doc.tokenHash).not.toBe(token);
    expect(JSON.stringify(doc)).not.toContain(token);

    const ok = await request(t.app).post('/auth/reset_password').send({ token, password: 'Fresh-pass-9' });
    expect(ok.status).toBe(200);
    expect((await request(t.app).get('/auth/profile').set(bearer(oldToken))).status).toBe(401);
    expect(await login(t.app, user, 'Fresh-pass-9')).toBeTruthy();

    const again = await request(t.app).post('/auth/reset_password').send({ token, password: 'Another-pass-9' });
    expect(again.status).toBe(400);
  });

  it('rejects expired links and keeps only the newest link valid', async () => {
    const user = await createUser('passenger');
    await request(t.app).post('/auth/forgot_password').send({ email: user.email });
    await until(() => expect(sent.filter((m) => m.to === user.email)).toHaveLength(1));
    await request(t.app).post('/auth/forgot_password').send({ email: user.email });
    await until(() => expect(sent.filter((m) => m.to === user.email)).toHaveLength(2));
    const [first, second] = sent.filter((m) => m.to === user.email).map(tokenFrom);

    expect((await request(t.app).post('/auth/reset_password').send({ token: first, password: 'Fresh-pass-9' })).status).toBe(400);
    await PasswordReset.updateOne({ user: user._id, usedAt: null }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(t.app).post('/auth/reset_password').send({ token: second, password: 'Fresh-pass-9' })).status).toBe(400);
  });

  it('sends nothing for unknown emails and validates the new password', async () => {
    const before = sent.length;
    await request(t.app).post('/auth/forgot_password').send({ email: 'ghost@example.com' });
    await new Promise((r) => setTimeout(r, 200));
    expect(sent.length).toBe(before);
    const weak = await request(t.app).post('/auth/reset_password').send({ token: 'y'.repeat(43), password: 'short' });
    expect(weak.status).toBe(400);
  });

  it('falls back to the admin queue when sending fails', async () => {
    const user = await createUser('passenger');
    failNext = true;
    const res = await request(t.app).post('/auth/forgot_password').send({ email: user.email });
    expect(res.status).toBe(200);
    await until(async () => expect(await PasswordReset.exists({ user: user._id, channel: 'admin', resolvedAt: null })).toBeTruthy());
  });
});
