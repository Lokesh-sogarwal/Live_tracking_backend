import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Application, DriverDocument, EmailVerification, Notification, User } from '../src/models/index.js';
import { bearer, createBus, createRoute, createUser, setupTestApp, userWithToken, JWT_SECRET } from './helpers.js';
import { Schedule, nextSeq } from '../src/models/index.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function makeMailer() {
  const sent = [];
  return { sent, mailer: { enabled: true, async send(m) { sent.push(m); } } };
}
const codeFor = (sent, email) => sent.filter((m) => m.to === email).at(-1).text.match(/code is (\d{6})/)[1];

describe('onboarding with email verification', () => {
  let t;
  const { sent, mailer } = makeMailer();
  let admin, adminToken, opToken, rootToken;

  beforeAll(async () => {
    t = await setupTestApp('onboarding', {}, { mailer });
    ({ user: admin, token: adminToken } = await userWithToken(t.app, 'admin'));
    ({ token: opToken } = await userWithToken(t.app, 'operator'));
    ({ token: rootToken } = await userWithToken(t.app, 'superadmin'));
  });
  afterAll(() => t.close());

  const verify = async (email) => {
    await EmailVerification.deleteMany({ email }); // isolate cooldowns between tests
    expect((await request(t.app).post('/auth/signup/send_code').send({ email })).status).toBe(200);
    const res = await request(t.app).post('/auth/signup/verify_code').send({ email, code: codeFor(sent, email) });
    expect(res.status).toBe(200);
    return res.body.verification_token;
  };
  const apply = async (role, email = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`) => {
    const verification_token = await verify(email);
    const res = await request(t.app).post('/onboarding/applications').send({ verification_token, email, role, fullname: `Applicant ${role}`, phone_no: '+91 98765 43210', password: 'Applicant-pass-1' });
    expect(res.status).toBe(201);
    return { email, token: res.body.application_token, id: res.body.application.application_id };
  };
  const upload = (token, type, buf = PDF, name = 'doc.pdf') =>
    request(t.app).post('/onboarding/me/documents').set(bearer(token)).field('document_type', type).attach('file', buf, name);

  describe('verification codes', () => {
    it('stores only a hash, enforces cooldown, attempts and single use', async () => {
      const email = 'codes@example.com';
      await request(t.app).post('/auth/signup/send_code').send({ email });
      const doc = await EmailVerification.findOne({ email }).lean();
      const code = codeFor(sent, email);
      expect(JSON.stringify(doc)).not.toContain(code);
      expect((await request(t.app).post('/auth/signup/send_code').send({ email })).status).toBe(429);

      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) expect((await request(t.app).post('/auth/signup/verify_code').send({ email, code: wrong })).status).toBe(400);
      expect((await request(t.app).post('/auth/signup/verify_code').send({ email, code })).status).toBe(429);
    });

    it('expired codes are refused', async () => {
      const email = 'expired@example.com';
      await request(t.app).post('/auth/signup/send_code').send({ email });
      await EmailVerification.updateOne({ email }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await request(t.app).post('/auth/signup/verify_code').send({ email, code: codeFor(sent, email) });
      expect(res.status).toBe(400);
    });

    it('refuses codes for existing accounts', async () => {
      expect((await request(t.app).post('/auth/signup/send_code').send({ email: admin.email })).status).toBe(409);
    });
  });

  describe('passenger', () => {
    it('requires a verification ticket for public signup and creates a normal passenger', async () => {
      const email = `pass-${Date.now()}@example.com`;
      const without = await request(t.app).post('/auth/signup').send({ fullname: 'P', email, password: 'Passenger-1' });
      expect(without.status).toBe(400);
      const forged = jwt.sign({ typ: 'email_verified', email, vid: '000000000000000000000000' }, JWT_SECRET, { audience: 'signup' });
      expect((await request(t.app).post('/auth/signup').send({ fullname: 'P', email, password: 'Passenger-1', verification_token: forged })).status).toBe(400);

      const ticket = await verify(email);
      const ok = await request(t.app).post('/auth/signup').send({ fullname: 'P', email, password: 'Passenger-1', role: 'Admin', verification_token: ticket });
      expect(ok.status).toBe(403); // role escalation refused
      const res = await request(t.app).post('/auth/signup').send({ fullname: 'P', email, password: 'Passenger-1', verification_token: ticket });
      expect(res.status).toBe(200);
      expect(res.body.role).toBe('Passenger');
      expect((await User.findOne({ email }).lean()).emailVerifiedAt).toBeTruthy();
      // The ticket is single use.
      const again = await request(t.app).post('/auth/signup').send({ fullname: 'P', email: `x${email}`, password: 'Passenger-1', verification_token: ticket });
      expect(again.status).toBe(400);
      const login = await request(t.app).post('/auth/login').send({ email, password: 'Passenger-1' });
      expect(login.body.token).toBeTruthy();
    });
  });

  describe('driver', () => {
    it('cannot apply without verified email or as admin', async () => {
      const res = await request(t.app).post('/onboarding/applications').send({ verification_token: 'x'.repeat(40), email: 'nov@example.com', role: 'driver', fullname: 'No V', phone_no: '9876543210', password: 'Applicant-pass-1' });
      expect(res.status).toBe(400);
      const email = `adm-${Date.now()}@example.com`;
      const ticket = await verify(email);
      const bad = await request(t.app).post('/onboarding/applications').send({ verification_token: ticket, email, role: 'admin', fullname: 'Sneaky', phone_no: '9876543210', password: 'Applicant-pass-1' });
      expect(bad.status).toBe(400);
    });

    it('full lifecycle: restricted access, review, rejection, resubmission, approval, idempotent activation', async () => {
      const { email, token, id } = await apply('driver');
      expect(id).toMatch(/^DRV-[0-9A-Z]{12}$/);
      expect(await User.exists({ email })).toBeNull(); // no permanent account yet

      // The application token cannot reach operational APIs; a normal login gives no user token.
      for (const path of ['/auth/profile', '/bus/schedules', '/view/driver_details', '/data/get_documents']) {
        expect((await request(t.app).get(path).set(bearer(token))).status).toBe(401);
      }
      const login = await request(t.app).post('/auth/login').send({ email, password: 'Applicant-pass-1' });
      expect(login.status).toBe(200);
      expect(login.body.token).toBeUndefined();
      expect(login.body.application_id).toBe(id);
      expect((await request(t.app).post('/auth/login').send({ email, password: 'wrong' })).status).toBe(401);

      // Submitting needs every required document.
      expect((await request(t.app).post('/onboarding/me/submit').set(bearer(token))).status).toBe(400);
      expect((await upload(token, 'license', Buffer.from('not a real file'), 'x.pdf')).status).toBe(400);
      expect((await upload(token, 'offer_letter')).status).toBe(400); // not on the driver checklist
      expect((await upload(token, 'license')).status).toBe(201);
      expect((await upload(token, 'aadhaar', PNG, 'id.png')).status).toBe(201);
      const own = await request(t.app).get('/onboarding/me/documents/license/file').set(bearer(token));
      expect(own.status).toBe(200);
      expect(own.headers['cache-control']).toContain('no-store');
      expect((await request(t.app).post('/onboarding/me/submit').set(bearer(token))).status).toBe(200);
      expect((await upload(token, 'license')).status).toBe(409); // locked while under review
      expect(await Notification.exists({ user: admin._id, type: 'application' })).toBeTruthy();

      // Another applicant cannot see this application or its files.
      const other = await apply('driver');
      const me = await request(t.app).get('/onboarding/me').set(bearer(other.token));
      expect(me.body.application_id).toBe(other.id);
      expect((await request(t.app).get(`/onboarding/applications/${id}`).set(bearer(other.token))).status).toBe(401);

      // Operator may review driver documents but not decide; passengers/drivers may not look.
      const { token: passengerToken } = await userWithToken(t.app, 'passenger');
      expect((await request(t.app).get(`/onboarding/applications/${id}`).set(bearer(passengerToken))).status).toBe(403);
      const detail = await request(t.app).get(`/onboarding/applications/${id}`).set(bearer(opToken));
      expect(detail.status).toBe(200);
      expect(detail.body.permissions).toEqual({ review_documents: true, decide: false });
      expect(JSON.stringify(detail.body)).not.toMatch(/passwordHash|storageKey|applications\//);
      expect((await request(t.app).get(`/onboarding/applications/${id}/documents/license/file`).set(bearer(opToken))).status).toBe(200);
      expect((await request(t.app).post(`/onboarding/applications/${id}/approve`).set(bearer(opToken)).send({})).status).toBe(403);

      const rejectNoReason = await request(t.app).post(`/onboarding/applications/${id}/documents/aadhaar/review`).set(bearer(opToken)).send({ decision: 'reject' });
      expect(rejectNoReason.status).toBe(400);
      await request(t.app).post(`/onboarding/applications/${id}/documents/license/review`).set(bearer(opToken)).send({ decision: 'approve' });
      await request(t.app).post(`/onboarding/applications/${id}/documents/aadhaar/review`).set(bearer(opToken)).send({ decision: 'reject', reason: 'Photo is blurry' });
      // Rejected document blocks approval.
      expect((await request(t.app).post(`/onboarding/applications/${id}/approve`).set(bearer(adminToken)).send({})).status).toBe(400);
      const back = await request(t.app).post(`/onboarding/applications/${id}/request_changes`).set(bearer(opToken)).send({ comment: 'Upload a clearer ID photo' });
      expect(back.body.status).toBe('ACTION_REQUIRED');

      const view = await request(t.app).get('/onboarding/me').set(bearer(token));
      expect(view.body.documents.find((d) => d.type === 'aadhaar')).toMatchObject({ status: 'rejected', reason: 'Photo is blurry' });
      expect((await upload(token, 'license')).status).toBe(409); // approved documents stay
      expect((await upload(token, 'aadhaar', PNG, 'id2.png')).status).toBe(201);
      expect((await request(t.app).post('/onboarding/me/submit').set(bearer(token))).status).toBe(200);
      await request(t.app).post(`/onboarding/applications/${id}/documents/aadhaar/review`).set(bearer(opToken)).send({ decision: 'approve' });

      // Two approvals at once: exactly one account.
      const [a1, a2] = await Promise.all([
        request(t.app).post(`/onboarding/applications/${id}/approve`).set(bearer(adminToken)).send({}),
        request(t.app).post(`/onboarding/applications/${id}/approve`).set(bearer(rootToken)).send({}),
      ]);
      expect([a1.status, a2.status].every((s) => s === 200 || s === 409)).toBe(true);
      expect([a1.status, a2.status]).toContain(200);
      const again = await request(t.app).post(`/onboarding/applications/${id}/approve`).set(bearer(adminToken)).send({});
      expect(again.status).toBe(200);
      expect(await User.countDocuments({ email })).toBe(1);

      const user = await User.findOne({ email }).lean();
      expect(user).toMatchObject({ roleKey: 'driver', applicationId: id });
      expect(await DriverDocument.countDocuments({ user: user._id, isVerified: true })).toBe(2);
      // The applicant session ended; the normal login now yields a driver token.
      expect((await request(t.app).get('/onboarding/me').set(bearer(token))).status).toBe(401);
      const driverLogin = await request(t.app).post('/auth/login').send({ email, password: 'Applicant-pass-1' });
      expect(jwt.decode(driverLogin.body.token).role).toBe('Driver');
      const history = (await Application.findOne({ applicationId: id }).lean()).history.map((h) => h.action);
      expect(history).toEqual(expect.arrayContaining(['Document rejected', 'Changes requested', 'Resubmitted for review', 'Application approved']));
    });

    it('rejection keeps the record and lets the applicant see the reason', async () => {
      const { token, id, email } = await apply('driver');
      await upload(token, 'license');
      await upload(token, 'aadhaar');
      await request(t.app).post('/onboarding/me/submit').set(bearer(token));
      expect((await request(t.app).post(`/onboarding/applications/${id}/reject`).set(bearer(opToken)).send({ reason: 'Not hiring' })).status).toBe(403);
      const res = await request(t.app).post(`/onboarding/applications/${id}/reject`).set(bearer(adminToken)).send({ reason: 'Licence class does not match' });
      expect(res.body.status).toBe('REJECTED');
      const login = await request(t.app).post('/auth/login').send({ email, password: 'Applicant-pass-1' });
      expect(login.body.application_status).toBe('REJECTED');
      const me = await request(t.app).get('/onboarding/me').set(bearer(login.body.application_token));
      expect(me.body.decision_reason).toBe('Licence class does not match');
      expect((await upload(login.body.application_token, 'license')).status).toBe(409);
      expect(await User.exists({ email })).toBeNull();
      expect(await Application.exists({ applicationId: id })).toBeTruthy();
    });
  });

  describe('operator', () => {
    it('needs the offer letter, admin approval and an employment confirmation', async () => {
      const { token, id, email } = await apply('operator');
      expect(id).toMatch(/^OPR-/);
      await upload(token, 'aadhaar');
      expect((await request(t.app).post('/onboarding/me/submit').set(bearer(token))).status).toBe(400);
      await upload(token, 'offer_letter');
      expect((await request(t.app).post('/onboarding/me/submit').set(bearer(token))).status).toBe(200);

      // Operators cannot even open operator applications.
      expect((await request(t.app).get(`/onboarding/applications/${id}`).set(bearer(opToken))).status).toBe(403);
      const list = await request(t.app).get('/onboarding/applications').set(bearer(opToken));
      expect(list.body.map((a) => a.application_id)).not.toContain(id);

      for (const type of ['aadhaar', 'offer_letter']) {
        expect((await request(t.app).post(`/onboarding/applications/${id}/documents/${type}/review`).set(bearer(adminToken)).send({ decision: 'approve' })).status).toBe(200);
      }
      expect((await request(t.app).post(`/onboarding/applications/${id}/approve`).set(bearer(adminToken)).send({})).status).toBe(400);
      expect(await User.exists({ email })).toBeNull();
      const ok = await request(t.app).post(`/onboarding/applications/${id}/approve`).set(bearer(adminToken)).send({ employment_verified: true });
      expect(ok.status).toBe(200);
      expect(ok.body.employment_verified).toBe(true);
      expect((await User.findOne({ email }).lean()).roleKey).toBe('operator');
    });
  });

  describe('public data', () => {
    it('serves routes and departures without login and without driver details', async () => {
      const route = await createRoute({ routeName: 'Campus Loop' });
      const bus = await createBus();
      const driver = await createUser('driver', { fullname: 'Secret Driver Name' });
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: t.config.APP_TIMEZONE }).format(new Date());
      await Schedule.create({ scheduleId: await nextSeq('schedules'), route: route._id, bus: bus._id, driver: driver._id, arrivalTime: new Date(), departureTime: new Date(Date.now() + 3600e3), date: today });
      const routes = await request(t.app).get('/public/routes?q=campus');
      expect(routes.status).toBe(200);
      expect(routes.body[0]).toMatchObject({ route_name: 'Campus Loop' });
      const deps = await request(t.app).get('/public/departures');
      expect(deps.status).toBe(200);
      expect(deps.body.departures.length).toBeGreaterThan(0);
      expect(JSON.stringify(deps.body)).not.toMatch(/Secret Driver Name|driver|user_id|@/i);
      expect((await request(t.app).get('/public/departures?date=2001-01-01')).status).toBe(400);
    });
  });
});

describe('onboarding without email configured', () => {
  let t;
  beforeAll(async () => {
    t = await setupTestApp('onboarding_nomail');
  });
  afterAll(() => t.close());

  it('keeps passenger signup working and refuses applications honestly', async () => {
    const opts = await request(t.app).get('/auth/signup_options');
    expect(opts.body).toMatchObject({ email_verification: false, applications_open: false });
    expect((await request(t.app).post('/auth/signup/send_code').send({ email: 'a@example.com' })).status).toBe(503);
    const res = await request(t.app).post('/onboarding/applications').send({ verification_token: 'x'.repeat(40), email: 'a@example.com', role: 'driver', fullname: 'A B', phone_no: '9876543210', password: 'Applicant-pass-1' });
    expect(res.status).toBe(503);
    const signup = await request(t.app).post('/auth/signup').send({ fullname: 'P', email: 'p-nomail@example.com', password: 'Passenger-1' });
    expect(signup.status).toBe(200);
  });
});
