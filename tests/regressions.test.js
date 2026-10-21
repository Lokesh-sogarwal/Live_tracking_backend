import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Notification, nextSeq } from '../src/models/index.js';
import { startLoop } from '../src/jobs/loop.js';
import { parsePagination } from '../src/utils/pagination.js';
import { bearer, setupTestApp, userWithToken } from './helpers.js';

// Regression tests for bugs found in the second audit (docs/BUG_FIX_LOG.md).
let t;
let admin;
beforeAll(async () => {
  t = await setupTestApp('regressions');
  admin = await userWithToken(t.app, 'admin');
});
afterAll(() => t.close());

describe('BF-11: invalid pagination values never reach MongoDB', () => {
  it.each(['-5', '0', 'abc', '99999'])('GET /data/get_data with active_limit/limit = %s → 200', async (v) => {
    const res = await request(t.app).get(`/data/get_data?active_limit=${v}&limit=${v}`).set(bearer(admin.token));
    expect(res.status).toBe(200);
  });

  it('parsePagination clamps limit/page', () => {
    expect(parsePagination({ limit: '-1', page: '-3' })).toMatchObject({ limit: 200, page: 1, skip: 0 });
    expect(parsePagination({ limit: '5000' }, { maxLimit: 100 }).limit).toBe(100);
    expect(parsePagination({ per_page: '10', page: '3' })).toMatchObject({ limit: 10, skip: 20 });
  });
});

describe('BF-08: chat notifications carry sender_id in the REST list', () => {
  it('lets the UI open the right conversation', async () => {
    const sender = await userWithToken(t.app, 'passenger');
    await Notification.create({
      notificationId: await nextSeq('notifications'), user: admin.user._id, message: 'New message from X', type: 'chat', sender: sender.user._id,
    });
    await Notification.create({ notificationId: await nextSeq('notifications'), user: admin.user._id, message: 'plain', type: 'info' });
    const res = await request(t.app).get('/view/notifications').set(bearer(admin.token));
    const chat = res.body.find((n) => n.type === 'chat');
    const info = res.body.find((n) => n.message === 'plain');
    expect(chat.sender_id).toBe(sender.user.userId);
    expect(info).not.toHaveProperty('sender_id');
  });
});

describe('BF-12: worker loop keeps a single pending timer and stops cleanly', () => {
  it('runs repeatedly, survives errors, never overlaps, and stops', async () => {
    let calls = 0;
    let running = 0;
    let overlapped = false;
    const errors = [];
    const loop = startLoop(
      async () => {
        calls += 1;
        running += 1;
        if (running > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        if (calls === 2) throw new Error('boom');
      },
      1,
      { onError: (e) => errors.push(e.message) },
    );
    await new Promise((r) => setTimeout(r, 120));
    loop.stop();
    const after = calls;
    expect(after).toBeGreaterThan(3);
    expect(errors).toEqual(['boom']);
    expect(overlapped).toBe(false);
    expect(loop.pending).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(after);
  });

  it('skips work when shouldRun() is false (not the lease holder)', async () => {
    let calls = 0;
    const loop = startLoop(() => { calls += 1; }, 1, { shouldRun: () => false });
    await new Promise((r) => setTimeout(r, 30));
    loop.stop();
    expect(calls).toBe(0);
  });
});

describe('BF-13: concurrent duplicate requests resolve to one success + clean 409s', () => {
  const statuses = (results) => results.map((r) => r.status).sort();

  it('signup with the same email', async () => {
    const body = { fullname: 'Race', email: 'race@example.com', password: 'Abcdef#1' };
    const res = await Promise.all(Array.from({ length: 6 }, () => request(t.app).post('/auth/signup').send(body)));
    expect(statuses(res)).toEqual([200, 409, 409, 409, 409, 409]);
  });

  it('register the same bus number', async () => {
    const res = await Promise.all(
      Array.from({ length: 5 }, () => request(t.app).post('/bus/register_bus').set(bearer(admin.token)).send({ bus_number: 'RACE-1' })),
    );
    expect(statuses(res)).toEqual([201, 409, 409, 409, 409]);
  });

  it('upload the same document type: one stored record, no orphaned files', async () => {
    const { DriverDocument } = await import('../src/models/index.js');
    const { readdir } = await import('node:fs/promises');
    const driver = await userWithToken(t.app, 'driver');
    const pdf = Buffer.from('%PDF-1.4\nrace\n%%EOF');
    const res = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(t.app).post(`/view/upload/${driver.user.userId}`).set(bearer(admin.token)).field('document_type', 'license').attach('file', pdf, 'l.pdf'),
      ),
    );
    expect(statuses(res)).toEqual([201, 409, 409, 409]);
    expect(await DriverDocument.countDocuments({ user: driver.user._id })).toBe(1);
    const files = await readdir(`${t.config.LOCAL_UPLOAD_DIR}/driver-docs/${driver.user.userId}`);
    expect(files).toHaveLength(1);
  });

  it('simultaneous location updates for one bus never 500', async () => {
    const { createBus } = await import('./helpers.js');
    const bus = await createBus();
    const now = Date.now();
    const res = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(t.app)
          .post('/view/update_location')
          .set(bearer(admin.token))
          .send({ bus_id: bus.busId, latitude: 12.9 + i / 1000, longitude: 77.6, timestamp: new Date(now - i * 100).toISOString() }),
      ),
    );
    expect(res.every((r) => [200, 409].includes(r.status))).toBe(true);
    expect(res.some((r) => r.status === 200)).toBe(true);
  });
});

describe('BF-14: geocoding service failures are not reported as bad input', () => {
  it('real geo service turns a Nominatim 403 into an upstream error (not "not found"), uncached', async () => {
    const { vi } = await import('vitest');
    const { createGeoService } = await import('../src/services/geo.js');
    const { createLogger } = await import('../src/config/logger.js');
    const fetchMock = vi.fn(async () => new Response('blocked', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const geo = createGeoService({ ...t.config, EXTERNAL_HTTP_RETRIES: 0 }, createLogger('silent'));
      await expect(geo.geocodePlace('India Gate')).rejects.toMatchObject({ status: 502 });
      await expect(geo.geocodePlace('India Gate')).rejects.toMatchObject({ status: 502 });
      expect(fetchMock).toHaveBeenCalledTimes(2); // failure was not cached

      fetchMock.mockImplementation(async () => new Response('[]', { status: 200 }));
      expect(await geo.geocodePlace('Nowhere At All')).toBeNull(); // genuinely not found
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('POST /bus/bus_route answers 502 when the geocoder is down, 400 when a place is unknown', async () => {
    const { createApp } = await import('../src/app.js');
    const { upstreamError } = await import('../src/utils/errors.js');
    const down = createApp({ ...t.ctx, geo: { ...t.ctx.geo, geocodePlace: async () => { throw upstreamError('Geocoding service unavailable, please try again later'); } } });
    const body = { route_name: 'R', starting: 'Pari Chowk', destination: 'Saket Metro' };
    const r1 = await request(down).post('/bus/bus_route').set(bearer(admin.token)).send(body);
    expect(r1.status).toBe(502);
    expect(r1.body.error).toMatch(/unavailable/);
    const r2 = await request(t.app).post('/bus/bus_route').set(bearer(admin.token)).send({ ...body, starting: 'Atlantis' });
    expect(r2.status).toBe(400);
  });

  it('.env.example does not ship a User-Agent Nominatim rejects', async () => {
    const { readFile } = await import('node:fs/promises');
    const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
    expect(example).not.toMatch(/^GEO_USER_AGENT=.*example\.com/m);
  });
});

describe('BF-15: a day skipped for missing data is retried, not marked done', () => {
  it('generates once routes/buses/drivers appear, then runs exactly once', async () => {
    const { JobRun, Schedule, Route, Bus, User } = await import('../src/models/index.js');
    const { runDailyScheduleJob } = await import('../src/jobs/scheduleJob.js');
    const { createLogger } = await import('../src/config/logger.js');
    const { createBus, createRoute, createUser } = await import('./helpers.js');
    const logger = createLogger('silent');
    const config = { ...t.config, SCHEDULE_CRON_TIME: '00:01', SCHEDULE_CATCHUP_ON_START: true };
    const base = new Date('2026-11-02T06:00:00Z'); // 11:30 IST

    // Empty fleet for this check (this file's DB has no routes; drivers are removed for it).
    await Promise.all([Route.deleteMany({}), Bus.deleteMany({}), User.deleteMany({ roleKey: 'driver' })]);
    const r1 = await runDailyScheduleJob({ now: base, config, logger });
    expect(r1.result.skipped).toBe(true);
    expect((await JobRun.findOne({ runKey: '2026-11-02' }).lean()).status).toBe('skipped');

    const soon = await runDailyScheduleJob({ now: new Date(base.getTime() + 60_000), config, logger });
    expect(soon.reason).toBe('skipped_recently');

    await createRoute();
    await createBus();
    await createUser('driver');
    const later = await runDailyScheduleJob({ now: new Date(base.getTime() + 11 * 60_000), config, logger });
    expect(later.ran).toBe(true);
    // One trip per day for the whole window (today + SCHEDULE_DAYS_AHEAD), one on this date.
    expect(later.result.created).toBe(config.SCHEDULE_DAYS_AHEAD + 1);
    expect(await Schedule.countDocuments({ date: '2026-11-02' })).toBe(1);

    const again = await runDailyScheduleJob({ now: new Date(base.getTime() + 30 * 60_000), config, logger });
    expect(again.reason).toBe('already_succeeded');
  });
});

describe('SIM-04: location reports which trip produced it and whether that trip finished', () => {
  it('trip_completed is false mid-trip and true after arrival; status becomes "arrived"', async () => {
    const { Schedule } = await import('../src/models/index.js');
    const { runSimulationTick } = await import('../src/jobs/simulationJob.js');
    const { createLogger } = await import('../src/config/logger.js');
    const { todayInTz } = await import('../src/utils/time.js');
    const { createBus, createRoute, createUser, fakeGeo } = await import('./helpers.js');
    const route = await createRoute();
    const bus = await createBus();
    const driver = await createUser('driver');
    const trip = await Schedule.create({
      scheduleId: await nextSeq('schedules'), route: route._id, bus: bus._id, driver: driver._id,
      date: todayInTz('Asia/Kolkata'), arrivalTime: new Date(Date.now() - 60_000), departureTime: new Date(Date.now() + 60_000),
    });
    const tick = () => runSimulationTick({ config: t.config, logger: createLogger('silent'), geo: fakeGeo() });
    const get = () => request(t.app).get(`/view/get_location/${bus.busId}`).set(bearer(admin.token));

    await tick();
    const mid = await get();
    expect(mid.body).toMatchObject({ schedule_id: trip.scheduleId, trip_completed: false });

    for (let i = 0; i < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      await tick();
    }
    const done = await get();
    expect(done.body).toMatchObject({ schedule_id: trip.scheduleId, trip_completed: true, latitude: 28.5206, longitude: 77.2013 });
    expect((await Schedule.findById(trip._id).lean()).status).toBe('arrived');
  });

  it('device positions without a trip omit the fields', async () => {
    const { createBus } = await import('./helpers.js');
    const bus = await createBus();
    await request(t.app).post('/view/update_location').set(bearer(admin.token)).send({ bus_id: bus.busId, latitude: 12.9, longitude: 77.6 });
    const res = await request(t.app).get(`/view/get_location/${bus.busId}`).set(bearer(admin.token));
    expect(res.body).not.toHaveProperty('trip_completed');
  });
});

describe('UI-01: simulation keeps a deliberately set "delayed" status while the trip runs', () => {
  it('delayed stays delayed during movement; completion still sets "arrived"; on_time becomes running', async () => {
    const { Schedule } = await import('../src/models/index.js');
    const { runSimulationTick } = await import('../src/jobs/simulationJob.js');
    const { createLogger } = await import('../src/config/logger.js');
    const { todayInTz } = await import('../src/utils/time.js');
    const { createBus, createRoute, createUser, fakeGeo } = await import('./helpers.js');
    const route = await createRoute();
    const driver = await createUser('driver');
    const mk = async (status) => Schedule.create({
      scheduleId: await nextSeq('schedules'), route: route._id, bus: (await createBus())._id, driver: driver._id, status,
      date: todayInTz('Asia/Kolkata'), arrivalTime: new Date(Date.now() - 60_000), departureTime: new Date(Date.now() + 60_000),
    });
    const delayed = await mk('delayed');
    const normal = await mk('on_time');
    const tick = () => runSimulationTick({ config: t.config, logger: createLogger('silent'), geo: fakeGeo() });

    await tick();
    expect((await Schedule.findById(delayed._id).lean()).status).toBe('delayed');
    expect((await Schedule.findById(normal._id).lean()).status).toBe('running');
    for (let i = 0; i < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      await tick();
    }
    const d = await Schedule.findById(delayed._id).lean();
    expect([d.isReached, d.status]).toEqual([true, 'arrived']);
  });
});
