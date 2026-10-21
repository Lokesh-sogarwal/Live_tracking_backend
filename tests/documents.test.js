import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DriverDocument, Notification, nextSeq } from '../src/models/index.js';
import { sniffFile } from '../src/utils/fileSniff.js';
import { bearer, setupTestApp, userWithToken } from './helpers.js';

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 0x20), Buffer.from('%%EOF')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50)]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]);

let t;
let admin;
let driver;
let passenger;
beforeAll(async () => {
  t = await setupTestApp('documents');
  admin = await userWithToken(t.app, 'admin');
  driver = await userWithToken(t.app, 'driver');
  passenger = await userWithToken(t.app, 'passenger');
});
afterAll(() => t.close());

const upload = (token, userUuid, buf, name, type = 'license', expiry = '') =>
  request(t.app).post(`/view/upload/${userUuid}`).set(bearer(token)).field('document_type', type).field('expiry_date', expiry).attach('file', buf, name);

describe('file sniffing', () => {
  it('detects content and rejects extension mismatches', () => {
    expect(sniffFile(PDF, 'a.pdf')).toMatchObject({ ext: 'pdf' });
    expect(sniffFile(PNG, 'a.jpeg')).toBeNull();
    expect(sniffFile(EXE, 'a.pdf')).toBeNull();
  });
});

describe('driver documents', () => {
  it('admin uploads for a driver; driver uploads own; generated storage key', async () => {
    const res = await upload(admin.token, driver.user.userId, PDF, 'licence.pdf', 'license', '2027-01-31');
    expect(res.status).toBe(201);
    const doc = await DriverDocument.findOne({ docId: res.body.id }).lean();
    expect(doc.storageKey).toMatch(new RegExp(`^driver-docs/${driver.user.userId}/[0-9a-f-]{36}\\.pdf$`));
    expect(doc.mimeType).toBe('application/pdf');
    expect((await upload(driver.token, driver.user.userId, PNG, 'rc.png', 'rc')).status).toBe(201);
  });

  it('rejects duplicates, bad types, oversize files, path-like document types and unauthorized uploaders', async () => {
    expect((await upload(admin.token, driver.user.userId, PDF, 'again.pdf', 'license')).status).toBe(409);
    expect((await upload(admin.token, driver.user.userId, EXE, 'evil.pdf', 'insurance')).status).toBe(400);
    expect((await upload(admin.token, driver.user.userId, Buffer.concat([PDF, Buffer.alloc(70 * 1024)]), 'big.pdf', 'big')).status).toBe(413);
    expect((await upload(admin.token, driver.user.userId, PDF, 'x.pdf', '../../etc/passwd')).status).toBe(400);
    expect((await upload(passenger.token, driver.user.userId, PDF, 'x.pdf', 'permit')).status).toBe(403);
    expect((await upload(driver.token, admin.user.userId, PDF, 'x.pdf', 'permit')).status).toBe(403);
    expect((await request(t.app).post(`/view/upload/${driver.user.userId}`).field('document_type', 'x').attach('file', PDF, 'x.pdf')).status).toBe(401);
    expect((await request(t.app).post(`/view/upload/${driver.user.userId}`).set(bearer(admin.token)).field('document_type', 'x')).status).toBe(400);
  });

  it('lists documents for reviewers only, with signed download links', async () => {
    expect((await request(t.app).get('/data/get_documents').set(bearer(passenger.token))).status).toBe(403);
    expect((await request(t.app).get('/data/get_documents').set(bearer(driver.token))).status).toBe(403);
    expect((await request(t.app).get('/data/get_documents')).status).toBe(401);
    const res = await request(t.app).get('/data/get_documents').set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.total_documents).toBe(2);
    const d = res.body.documents.find((x) => x.document_name === 'license');
    expect(d).toMatchObject({ driver_id: driver.user.userId, status: 'pending', is_verified: false, is_rejected: false });

    const link = `/data/uploads/${d.document_path}`;
    const dl = await request(t.app).get(link).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(dl.body, PDF)).toBe(0);

    const tampered = link.replace(/sig=([a-f0-9])/, (_m, c) => `sig=${c === 'a' ? 'b' : 'a'}`);
    expect((await request(t.app).get(tampered)).status).toBe(403);
    const otherDoc = link.replace(/doc-\d+/, `doc-${d.id + 1}`);
    expect((await request(t.app).get(otherDoc)).status).toBe(403);
    const expired = link.replace(/exp=\d+/, 'exp=1000');
    expect((await request(t.app).get(expired)).status).toBe(403);
    expect((await request(t.app).get(`/data/uploads/doc-${d.id}`)).status).toBe(401);
    expect((await request(t.app).get(`/data/uploads/doc-${d.id}`).set(bearer(driver.token))).status).toBe(200);
    expect((await request(t.app).get(`/data/uploads/doc-${d.id}`).set(bearer(passenger.token))).status).toBe(403);
    expect((await request(t.app).get('/data/uploads/..%2F..%2Fetc%2Fpasswd')).status).toBe(400);
  });

  it('verify / reject require a reviewer and are mutually exclusive', async () => {
    const doc = await DriverDocument.findOne({ documentType: 'license' }).lean();
    expect((await request(t.app).post(`/data/verify_document/${doc.docId}`)).status).toBe(401);
    expect((await request(t.app).post(`/data/verify_document/${doc.docId}`).set(bearer(passenger.token))).status).toBe(403);
    expect((await request(t.app).post(`/data/verify_document/${doc.docId}`).set(bearer(admin.token))).status).toBe(200);
    expect((await request(t.app).post(`/data/reject_document/${doc.docId}`).set(bearer(admin.token))).status).toBe(200);
    const after = await DriverDocument.findById(doc._id).lean();
    expect([after.isVerified, after.isRejected]).toEqual([false, true]);
    expect((await request(t.app).post('/data/verify_document/99999').set(bearer(admin.token))).status).toBe(404);
  });
});

describe('notifications', () => {
  it('lists own notifications, scopes mark_read to the owner, supports both mark-all paths', async () => {
    const mk = async (user, message) => Notification.create({ notificationId: await nextSeq('notifications'), user: user._id, message });
    const mine = await mk(passenger.user, 'hello');
    await mk(passenger.user, 'second');
    const theirs = await mk(admin.user, 'admin only');

    const list = await request(t.app).get('/view/notifications').set(bearer(passenger.token));
    expect(list.status).toBe(200);
    expect(list.body.map((n) => n.message)).toEqual(expect.arrayContaining(['hello', 'second']));
    expect(list.body.map((n) => n.message)).not.toContain('admin only');
    expect(list.body[0]).toMatchObject({ is_read: false, type: 'info', timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) });

    expect((await request(t.app).post(`/view/notifications/mark_read/${theirs.notificationId}`).set(bearer(passenger.token))).status).toBe(404);
    expect((await Notification.findById(theirs._id).lean()).isRead).toBe(false);
    expect((await request(t.app).post(`/view/notifications/mark_read/${mine.notificationId}`).set(bearer(passenger.token))).status).toBe(200);

    expect((await request(t.app).post('/view/notifications/mark_read_all').set(bearer(passenger.token))).body.message).toBe('All notifications marked as read');
    expect((await request(t.app).post('/view/notifications/mark_all_read').set(bearer(passenger.token))).body.message).toBe('No unread notifications');
    expect(await Notification.countDocuments({ user: passenger.user._id, isRead: false })).toBe(0);
  });

  it('admins are notified of new signups', async () => {
    const before = await Notification.countDocuments({ user: admin.user._id });
    await request(t.app).post('/auth/signup').send({ fullname: 'Nina', email: 'nina@example.com', password: 'Abcdef#1' });
    expect(await Notification.countDocuments({ user: admin.user._id })).toBe(before + 1);
  });
});

describe('feedback', () => {
  it('validates before saving and restricts listing to reviewers', async () => {
    expect((await request(t.app).post('/view/submit_feedback').set(bearer(passenger.token)).send({ feedback: '   ' })).status).toBe(400);
    const ok = await request(t.app).post('/view/submit_feedback').set(bearer(passenger.token)).send({ feedback: 'Great app' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ Feedback: 'Great app', email: passenger.user.email });
    expect((await request(t.app).get('/data/get_feedback')).status).toBe(401);
    expect((await request(t.app).get('/data/get_feedback').set(bearer(passenger.token))).status).toBe(403);
    const list = await request(t.app).get('/data/get_feedback').set(bearer(admin.token));
    expect(list.body[0]).toMatchObject({ user_name: passenger.user.fullname, feedback: 'Great app' });
  });
});
