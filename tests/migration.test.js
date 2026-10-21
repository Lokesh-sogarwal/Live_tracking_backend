import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import {
  BusLocation, ChatMessage, Counter, DriverDocument, Notification, Schedule, Stop, User, nextSeq,
} from '../src/models/index.js';
import { migrate } from '../src/migration/sqlToMongo.js';
import { setupTestApp } from './helpers.js';

const WZ = 'pbkdf2:sha256:1000$O08MQozaHdcW89on$2f57b88d1958a36f5cc1e28c3835dda3f0d7fbf76f50c5d50156a05397e51389'; // "Legacy#Pass1"
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';

// Synthetic rows shaped like the SQLAlchemy tables in website/model.py.
const FIXTURE = {
  roles: [{ role_id: 1, role_name: 'SuperAdmin' }, { role_id: 2, role_name: 'Admin' }, { role_id: 3, role_name: 'driver' }, { role_id: 4, role_name: 'Passenger' }],
  users: [
    { id: 1, user_id: U1, fullname: 'Super Root', email: 'Root@Example.com', password: WZ, phone_no: null, is_password_change: 1, date_created: '2026-01-05 09:00:00', date_updated: '2026-01-05 09:00:00' },
    { id: 2, user_id: U2, fullname: 'Dev Driver', email: 'dev@example.com', password: WZ, is_password_change: 0, date_created: '2026-02-01 10:00:00' },
    { id: 3, user_id: U3, fullname: 'Pat Passenger', email: 'pat@example.com', password: WZ, is_password_change: 1, date_created: '2026-03-01 08:00:00' },
    { id: 4, user_id: '44444444-4444-4444-8444-444444444444', fullname: 'Dup', email: 'ROOT@example.com', password: WZ },
    { id: 5, user_id: '55555555-5555-4555-8555-555555555555', fullname: '', email: 'bad@example.com', password: WZ },
  ],
  user_roles: [{ id: 1, user_id: 1, role_id: 1 }, { id: 2, user_id: 2, role_id: 3 }, { id: 3, user_id: 3, role_id: 4 }, { id: 4, user_id: 3, role_id: 2 }],
  role_permissions: [{ id: 1, role_id: 4, feature_key: 'chat', allowed: 0 }],
  active_user: [{ id: 'x', user_id: 1 }],
  buses: [{ bus_id: 7, bus_number: 'UP16-1234', capacity: 40, operator: 'UPSRTC' }, { bus_id: 8, bus_number: 'UP16-1234' }],
  routes: [
    { route_id: 3, route_name: 'Pari Chowk-Saket', start_point: 'Pari Chowk', start_lat: 28.4646, start_lng: 77.5113, end_point: 'Saket Metro', end_lat: 28.5206, end_lng: 77.2013 },
    { route_id: 4, route_name: 'Broken', start_point: 'A', start_lat: 128.0, start_lng: 77, end_point: 'B', end_lat: 1, end_lng: 1 },
  ],
  stops: [{ stop_id: 1, route_id: 3, name: 'Botanical Garden', latitude: 28.564, longitude: 77.334, sequence: 1 }, { stop_id: 2, route_id: 99, name: 'Orphan', latitude: 1, longitude: 1, sequence: 1 }],
  schedules: [
    { schedule_id: 10, route_id: 3, bus_id: 7, driver_id: 2, stop_id: null, arrival_time: '2026-10-20 07:30:00', departure_time: '2026-10-20 07:35:00', status: 'on_time', current_index: 0, date: '2026-10-20', is_reached: 0 },
    { schedule_id: 11, route_id: 3, bus_id: 7, driver_id: 2, stop_id: null, arrival_time: '2026-10-20 07:30:00', departure_time: '2026-10-20 07:35:00', status: 'on_time', current_index: 0, date: '2026-10-20', is_reached: 0 },
    { schedule_id: 12, route_id: 3, bus_id: 7, driver_id: 999, stop_id: null, arrival_time: '2026-10-20 08:00:00', departure_time: '2026-10-20 08:05:00', date: '2026-10-20' },
  ],
  bus_locations: [{ id: 1, bus_id: 7, latitude: 28.5, longitude: 77.4, timestamp: '2026-10-20 07:40:00' }, { id: 2, bus_id: 42, latitude: 1, longitude: 1 }],
  driver_documents: [
    { doc_id: 5, user_id: U2, document_type: 'license', document_path: '/opt/render/project/src/uploads/dev_license.pdf', upload_time: '2026-04-01 12:00:00', expiry_date: null, is_verified: 1, is_rejected: 0 },
    { doc_id: 6, user_id: U2, document_type: 'rc', document_path: 'C:\\app\\uploads\\gone.pdf', is_verified: 0, is_rejected: 0 },
  ],
  notifications: [
    { notification_id: 20, user_id: 3, message: 'New message from Dev Driver', type: 'chat', timestamp: '2026-10-19 10:00:00', is_read: 0 },
    { notification_id: 21, user_id: 77, message: 'orphan', type: 'info' },
  ],
  feedback: [{ feedback_id: 30, user_id: 3, message: 'Nice', email: 'pat@example.com', timestamp: '2026-10-18 10:00:00' }],
  chat_messages: [{ id: 40, message_id: 'aaaaaaaa-0000-4000-8000-000000000040', sender_id: U2, receiver_id: U3, message: 'Bus is late', timestamp: '2026-10-19 10:00:00' }],
};

const source = { kind: 'memory', readTable: async (n) => FIXTURE[n] ?? null, close: async () => {} };
const quiet = { info: () => {} };
let t;
let uploadsDir;

beforeAll(async () => {
  t = await setupTestApp('migration');
  uploadsDir = await mkdtemp(path.join(tmpdir(), 'legacy-uploads-'));
  await writeFile(path.join(uploadsDir, 'dev_license.pdf'), Buffer.from('%PDF-1.4\nlegacy\n%%EOF'));
});
afterAll(async () => {
  await rm(uploadsDir, { recursive: true, force: true });
  await t.close();
});

describe('SQL -> MongoDB migration', () => {
  it('dry-run validates and reports without writing anything', async () => {
    const report = await migrate({ source, apply: false, uploadsDir, storage: t.ctx.storage, logger: quiet });
    expect(report.mode).toBe('dry-run');
    expect(await User.countDocuments({ legacyId: { $exists: true } })).toBe(0);
    expect(await Schedule.countDocuments()).toBe(0);
    expect(report.tables.users.duplicates).toEqual([expect.objectContaining({ id: 4, keptId: 1 })]);
    expect(report.tables.users.rejected).toEqual([expect.objectContaining({ id: 5 })]);
  });

  it('applies: maps ids, roles, coordinates, timestamps; rejects bad rows; reconciles', async () => {
    const report = await migrate({ source, apply: true, uploadsDir, storage: t.ctx.storage, sourceTz: 'Asia/Kolkata', logger: quiet });

    const root = await User.findOne({ legacyId: 1 }).lean();
    expect(root).toMatchObject({ userId: U1, email: 'root@example.com', roleKey: 'superadmin', isPasswordChange: true });
    expect(root.createdAt.toISOString()).toBe('2026-01-05T03:30:00.000Z'); // 09:00 IST
    expect((await User.findOne({ legacyId: 2 }).lean()).roleKey).toBe('driver');
    expect((await User.findOne({ legacyId: 3 }).lean()).roleKey).toBe('passenger'); // first role row wins
    expect(report.tables.user_roles.warnings[0]).toMatch(/multiple roles/);

    expect(report.tables.buses.duplicates).toHaveLength(1);
    expect(report.tables.routes.rejected).toEqual([{ id: 4, reason: 'invalid coordinates' }]);
    expect(report.tables.stops.rejected[0].reason).toMatch(/route_id 99/);
    expect((await Stop.findOne({ stopId: 1 }).lean()).location.coordinates).toEqual([77.334, 28.564]);

    expect(report.tables.schedules.duplicates).toEqual([expect.objectContaining({ id: 11, keptId: 10 })]);
    expect(report.tables.schedules.rejected[0]).toMatchObject({ id: 12 });
    const s = await Schedule.findOne({ scheduleId: 10 }).lean();
    expect(s.arrivalTime.toISOString()).toBe('2026-10-20T02:00:00.000Z');
    expect(report.tables.bus_locations.rejected).toHaveLength(1);
    expect((await BusLocation.findOne({ busId: 7 }).lean()).location.coordinates).toEqual([77.4, 28.5]);

    const lic = await DriverDocument.findOne({ docId: 5 }).lean();
    expect(lic).toMatchObject({ fileMissing: false, mimeType: 'application/pdf', isVerified: true });
    expect(await t.ctx.storage.exists(lic.storageKey)).toBe(true);
    expect((await DriverDocument.findOne({ docId: 6 }).lean()).fileMissing).toBe(true);

    const n = await Notification.findOne({ notificationId: 20 }).lean();
    expect(String(n.sender)).toBe(String((await User.findOne({ legacyId: 2 }).lean())._id));
    expect((await ChatMessage.findOne({ legacyId: 40 }).lean()).conversationKey).toBe([U2, U3].sort().join('_'));

    expect(report.reconciliation.schedule_reference_integrity.ok).toBe(true);
    for (const [table, r] of Object.entries(report.reconciliation)) {
      if (r && "ok" in r && table !== "schedule_reference_integrity") expect(r.ok, `${table} ${JSON.stringify(r)}`).toBe(true);
    }
    expect(report.reconciliation.user_samples.every((x) => x.ok)).toBe(true);

    // New ids continue after the highest legacy id.
    expect((await Counter.findById('schedules').lean()).seq).toBe(12);
    expect(await nextSeq('buses')).toBe(9);
  });

  it('is idempotent on re-run', async () => {
    const before = await Promise.all([User, Schedule, Notification, ChatMessage].map((m) => m.countDocuments()));
    const report = await migrate({ source, apply: true, uploadsDir, storage: t.ctx.storage, logger: quiet });
    const after = await Promise.all([User, Schedule, Notification, ChatMessage].map((m) => m.countDocuments()));
    expect(after).toEqual(before);
    expect(report.tables.schedules.inserted ?? 0).toBe(0);
  });

  it('resume skips tables completed by an earlier run', async () => {
    const first = await migrate({ source, apply: true, storage: t.ctx.storage, logger: quiet });
    const resumed = await migrate({ source, apply: true, storage: t.ctx.storage, resumeRunId: first.runId, logger: quiet });
    expect(resumed.tables.schedules.skipped).toMatch(/completed/);
  });

  it('migrated users log in with their legacy Werkzeug password', async () => {
    const res = await request(t.app).post('/auth/login').send({ email: 'dev@example.com', password: 'Legacy#Pass1' });
    expect(res.status).toBe(200);
    const perms = await request(t.app).get('/permissions/my').set('Authorization', `Bearer ${(await request(t.app).post('/auth/login').send({ email: 'pat@example.com', password: 'Legacy#Pass1' })).body.token}`);
    expect(perms.body.permissions.chat).toBe(false); // migrated role_permissions row
  });
});
