import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Feedback, FeedbackReply, Notification, User } from '../src/models/index.js';
import { invalidatePermissionCache } from '../src/services/roles.js';
import { RolePermission } from '../src/models/index.js';
import { bearer, setupTestApp, userWithToken } from './helpers.js';

const until = (fn) => vi.waitFor(fn, { timeout: 5000, interval: 50 });

describe('feedback conversations', () => {
  let t;
  const sent = [];
  let failNext = 0;
  const mailer = {
    enabled: true,
    async send(m) {
      if (failNext > 0) {
        failNext -= 1;
        const err = new Error('Connection refused by smtp.example.com');
        err.code = 'ECONNECTION';
        throw err;
      }
      sent.push(m);
    },
  };
  let passenger, passengerToken, otherToken, adminToken, opToken, driverToken;

  beforeAll(async () => {
    t = await setupTestApp('feedback', { APP_PUBLIC_URL: 'https://app.example.com' }, { mailer });
    ({ user: passenger, token: passengerToken } = await userWithToken(t.app, 'passenger', { emailVerifiedAt: new Date() }));
    ({ token: otherToken } = await userWithToken(t.app, 'passenger'));
    ({ token: adminToken } = await userWithToken(t.app, 'admin'));
    ({ token: opToken } = await userWithToken(t.app, 'operator'));
    ({ token: driverToken } = await userWithToken(t.app, 'driver'));
  });
  afterAll(() => t.close());

  const submit = async (token = passengerToken, body = {}) => {
    const res = await request(t.app).post('/view/submit_feedback').set(bearer(token)).send({ feedback: 'The 8:10 bus was late', subject: 'Late bus', category: 'service', ...body });
    expect(res.status).toBe(200);
    return res.body;
  };
  const reply = (id, token, key, extra = {}) =>
    request(t.app).post(`/feedback/${id}/replies`).set(bearer(token)).send({ message: 'Sorry about that — we spoke to the depot.', idempotency_key: key, ...extra });

  it('submit keeps the legacy response and adds a reference', async () => {
    const body = await submit();
    expect(body).toMatchObject({ message: 'Feedback submitted successfully', Feedback: 'The 8:10 bus was late' });
    expect(body.reference).toMatch(/^FB-\d{6}$/);
    const legacy = await request(t.app).post('/view/submit_feedback').set(bearer(passengerToken)).send({ feedback: 'Old client body' });
    expect(legacy.status).toBe(200);
  });

  it('only staff with the inbox permission can list, read and reply', async () => {
    const { id } = await submit();
    for (const token of [passengerToken, driverToken]) {
      expect((await request(t.app).get('/feedback').set(bearer(token))).status).toBe(403);
      expect((await request(t.app).get(`/feedback/${id}`).set(bearer(token))).status).toBe(403);
      expect((await reply(id, token, `k-${token.slice(-8)}`)).status).toBe(403);
    }
    const list = await request(t.app).get('/feedback?status=new&category=service').set(bearer(opToken));
    expect(list.status).toBe(200);
    expect(list.body.find((f) => f.id === id)).toMatchObject({ submitter_email: passenger.email, status: 'new' });

    // Revoking "Feedbacks" for operators removes their access server-side.
    await RolePermission.create({ roleKey: 'operator', featureKey: 'Feedbacks', allowed: false });
    invalidatePermissionCache();
    expect((await request(t.app).get(`/feedback/${id}`).set(bearer(opToken))).status).toBe(403);
    await RolePermission.deleteOne({ roleKey: 'operator', featureKey: 'Feedbacks' });
    invalidatePermissionCache();
    expect((await request(t.app).get(`/feedback/${id}`).set(bearer(opToken))).status).toBe(200);
  });

  it('reply: saved, notified with a link, emailed once, and visible to the submitter only', async () => {
    const { id, reference } = await submit();
    const res = await reply(id, opToken, 'reply-key-0001');
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('replied');
    expect(res.body.replies[0].email.status).toBe('pending');

    await until(async () => expect((await FeedbackReply.findOne({ idempotencyKey: 'reply-key-0001' }).lean()).email.status).toBe('sent'));
    const mails = sent.filter((m) => m.subject === `Update on Your Feedback — Reference #${reference}`);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(passenger.email);
    expect(mails[0].text).toContain('https://app.example.com/my_feedback/');
    const detail = await request(t.app).get(`/feedback/${id}`).set(bearer(adminToken));
    expect(detail.body.replies[0].email).toMatchObject({ status: 'sent', attempts: 1 });
    expect(detail.body.history.map((h) => h.action)).toEqual(expect.arrayContaining(['Submitted', 'Replied', 'Reply emailed']));

    // Retrying the same request: no second reply, no second email.
    const again = await reply(id, opToken, 'reply-key-0001');
    expect(again.body.duplicate).toBe(true);
    expect(await FeedbackReply.countDocuments({ feedback: (await Feedback.findOne({ feedbackId: id }))._id })).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(sent.filter((m) => m.subject.includes(reference))).toHaveLength(1);

    const notif = await Notification.findOne({ user: passenger._id, type: 'feedback_reply' }).sort({ createdAt: -1 }).lean();
    expect(notif.link).toBe(`/my_feedback/${id}`);
    expect(notif.message).toContain(reference);
    const notifs = await request(t.app).get('/view/notifications').set(bearer(passengerToken));
    expect(JSON.stringify(notifs.body)).toContain(`/my_feedback/${id}`);

    const mine = await request(t.app).get(`/feedback/mine/${id}`).set(bearer(passengerToken));
    expect(mine.status).toBe(200);
    expect(mine.body.replies[0]).toMatchObject({ author_role: 'Operator' });
    expect(mine.body.replies[0].email).toBeUndefined();
    expect(mine.body.history).toBeUndefined();
    // Someone else's feedback is invisible, whatever ID is sent.
    expect((await request(t.app).get(`/feedback/mine/${id}`).set(bearer(otherToken))).status).toBe(404);
    const otherList = await request(t.app).get('/feedback/mine').set(bearer(otherToken));
    expect(otherList.body.map((f) => f.id)).not.toContain(id);
  });

  it('a failed email keeps the reply, reports the failure, and can be retried once', async () => {
    const { id } = await submit();
    failNext = 1;
    const res = await reply(id, adminToken, 'reply-key-fail', { resolve: true });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('resolved');
    await until(async () => expect((await FeedbackReply.findOne({ idempotencyKey: 'reply-key-fail' }).lean()).email.status).toBe('failed'));
    const stored = await FeedbackReply.findOne({ idempotencyKey: 'reply-key-fail' }).lean();
    expect(stored.message).toContain('Sorry');
    expect(stored.email.lastError).toBe('ECONNECTION');

    const retry = await request(t.app).post(`/feedback/${id}/replies/${stored._id}/retry_email`).set(bearer(adminToken));
    expect(retry.status).toBe(200);
    expect(retry.body.replies[0].email).toMatchObject({ status: 'sent', attempts: 2 });
    const twice = await request(t.app).post(`/feedback/${id}/replies/${stored._id}/retry_email`).set(bearer(adminToken));
    expect(twice.status).toBe(409);
  });

  it('does not email unverified addresses, and says so', async () => {
    const { user, token } = await userWithToken(t.app, 'passenger');
    expect(user.emailVerifiedAt ?? null).toBeNull();
    const { id } = await submit(token);
    const res = await reply(id, adminToken, 'reply-key-unverified');
    expect(res.body.replies[0].email).toMatchObject({ status: 'skipped', skip_reason: 'unverified_email' });
  });

  it('status and priority changes are validated and audited', async () => {
    const { id } = await submit();
    expect((await request(t.app).patch(`/feedback/${id}`).set(bearer(opToken)).send({ status: 'done' })).status).toBe(400);
    const res = await request(t.app).patch(`/feedback/${id}`).set(bearer(opToken)).send({ status: 'in_review', priority: 'high' });
    expect(res.body).toMatchObject({ status: 'in_review', priority: 'high' });
    expect(res.body.history.at(-1)).toMatchObject({ action: 'Updated' });
    expect((await request(t.app).patch(`/feedback/${id}`).set(bearer(passengerToken)).send({ status: 'resolved' })).status).toBe(403);
    expect((await request(t.app).post(`/feedback/${id}/replies`).set(bearer(opToken)).send({ message: ' ', idempotency_key: 'x-123456789' })).status).toBe(400);
  });

  it('older feedback without the new fields still lists as new', async () => {
    const doc = await Feedback.collection.insertOne({ feedbackId: 99999, user: passenger._id, email: passenger.email, message: 'legacy row', createdAt: new Date(), updatedAt: new Date() });
    expect(doc.insertedId).toBeTruthy();
    const list = await request(t.app).get('/feedback?status=new').set(bearer(adminToken));
    expect(list.body.find((f) => f.id === 99999)).toMatchObject({ status: 'new', category: 'general', reference: 'FB-099999' });
    expect(await User.exists({ _id: passenger._id })).toBeTruthy();
  });
});
