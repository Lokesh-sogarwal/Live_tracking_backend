import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { BusLocation, JobRun, Schedule, nextSeq } from '../src/models/index.js';
import { createGeoService } from '../src/services/geo.js';
import { createLogger } from '../src/config/logger.js';
import { generateDailySchedules } from '../src/services/schedules.js';
import { isDue, runDailyScheduleJob } from '../src/jobs/scheduleJob.js';
import { runSimulationTick } from '../src/jobs/simulationJob.js';
import { acquireLease, releaseLease } from '../src/jobs/lock.js';
import { todayInTz } from '../src/utils/time.js';
import { bearer, createBus, createRoute, createUser, fakeGeo, setupTestApp, userWithToken } from './helpers.js';

const TZ = 'Asia/Kolkata';
const logger = createLogger('silent');
let t;
let admin;
let passenger;
beforeAll(async () => {
  t = await setupTestApp('tracking');
  admin = await userWithToken(t.app, 'admin');
  passenger = await userWithToken(t.app, 'passenger');
});
afterAll(() => t.close());
afterEach(() => vi.unstubAllGlobals());

describe('location ingestion and lookup', () => {
  it('validates coordinates and stores GeoJSON [lng, lat]', async () => {
    const bus = await createBus();
    const ok = await request(t.app).post('/view/update_location').set(bearer(admin.token)).send({ bus_id: bus.busId, latitude: '28.61', longitude: 77.2 });
    expect(ok.status).toBe(200);
    const stored = await BusLocation.findOne({ busId: bus.busId }).lean();
    expect(stored.location.coordinates).toEqual([77.2, 28.61]);

    for (const bad of [{ latitude: 91, longitude: 0 }, { latitude: 0, longitude: 181 }, { latitude: 'abc', longitude: 1 }, { latitude: 0, longitude: 0 }, {}]) {
      const res = await request(t.app).post('/view/update_location').set(bearer(admin.token)).send({ bus_id: bus.busId, ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await request(t.app).post('/view/update_location').set(bearer(admin.token)).send({ bus_id: 99999, latitude: 1, longitude: 1 })).status).toBe(404);
  });

  it('rejects stale, future and out-of-order updates', async () => {
    const bus = await createBus();
    const send = (timestamp) =>
      request(t.app).post('/view/update_location').set(bearer(admin.token)).send({ bus_id: bus.busId, latitude: 12.9, longitude: 77.6, timestamp });
    expect((await send(new Date(Date.now() - 10 * 60_000).toISOString())).status).toBe(400);
    expect((await send(new Date(Date.now() + 10 * 60_000).toISOString())).status).toBe(400);
    expect((await send(new Date().toISOString())).status).toBe(200);
    expect((await send(new Date(Date.now() - 5_000).toISOString())).status).toBe(409);
  });

  it('authorizes drivers only for their bus today; passengers cannot post', async () => {
    const bus = await createBus();
    const otherBus = await createBus();
    const route = await createRoute();
    const driver = await userWithToken(t.app, 'driver');
    await Schedule.create({
      scheduleId: await nextSeq('schedules'), route: route._id, bus: bus._id, driver: driver.user._id,
      date: todayInTz(TZ), arrivalTime: new Date(), departureTime: new Date(Date.now() + 1000),
    });
    const post = (token, b) => request(t.app).post('/view/update_location').set(bearer(token)).send({ bus_id: b.busId, latitude: 12.9, longitude: 77.6 });
    expect((await post(driver.token, bus)).status).toBe(200);
    expect((await post(driver.token, otherBus)).status).toBe(403);
    expect((await post(passenger.token, bus)).status).toBe(403);
    expect((await BusLocation.findOne({ busId: bus.busId }).lean()).source).toBe('device');
  });

  it('returns latest location with freshness flags; 404 when none; 401 unauthenticated', async () => {
    const bus = await createBus();
    expect((await request(t.app).get(`/view/get_location/${bus.busId}`).set(bearer(passenger.token))).status).toBe(404);
    await BusLocation.create({ bus: bus._id, busId: bus.busId, location: { type: 'Point', coordinates: [77.6, 12.9] }, recordedAt: new Date(Date.now() - 600_000), source: 'device' });
    const res = await request(t.app).get(`/view/get_location/${bus.busId}`).set(bearer(passenger.token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ latitude: 12.9, longitude: 77.6, is_stale: true });
    expect(res.body.age_seconds).toBeGreaterThanOrEqual(600);
    expect((await request(t.app).get(`/view/get_location/${bus.busId}`)).status).toBe(401);
    expect((await request(t.app).get('/view/get_location/abc').set(bearer(passenger.token))).status).toBe(400);
  });
});

describe('route geometry (real geo service, mocked network)', () => {
  const start = { lat: 28.4646, lng: 77.5113 };
  const end = { lat: 28.5206, lng: 77.2013 };

  it('falls back to a densified straight [lng, lat] line without an ORS key', async () => {
    const { haversineMeters } = await import('../src/services/geo.js');
    const geo = createGeoService({ ...t.config, ORS_API_KEY: '' }, logger);
    const g = await geo.getRouteGeometry(start, end);
    expect(g.provider).toBe('fallback');
    expect(g.coordinates[0]).toEqual([77.5113, 28.4646]);
    expect(g.coordinates.at(-1)).toEqual([77.2013, 28.5206]);
    // ~31 km in <= 100 m steps (capped at 300 segments) instead of a single jump.
    expect(g.coordinates.length).toBe(301);
    for (let i = 1; i < g.coordinates.length; i += 1) {
      const [aLng, aLat] = g.coordinates[i - 1];
      const [bLng, bLat] = g.coordinates[i];
      expect(haversineMeters(aLat, aLng, bLat, bLng)).toBeLessThan(110);
    }
    expect(g.durationSeconds).toBeGreaterThan(0);
  });

  it('uses ORS geometry, caches it, and retries/falls back on failure', async () => {
    const fetchMock = vi.fn(async () =>
      // Road geometry between the requested points (10, 76) -> (10.5, 76.5); a line elsewhere is now rejected.
      new Response(JSON.stringify({ features: [{ geometry: { coordinates: [[76, 10], [76.2, 10.3], [76.5, 10.5]] }, properties: { summary: { distance: 30000, duration: 1800 } } }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const geo = createGeoService({ ...t.config, ORS_API_KEY: 'k', EXTERNAL_HTTP_RETRIES: 2 }, logger);
    const a = { lat: 10, lng: 76 };
    const b = { lat: 10.5, lng: 76.5 };
    const g1 = await geo.getRouteGeometry(a, b);
    const g2 = await geo.getRouteGeometry(a, b);
    expect(g1.provider).toBe('ors');
    expect(g2.coordinates).toEqual(g1.coordinates);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async () => new Response('down', { status: 503 }));
    vi.stubGlobal('fetch', failing);
    const g3 = await createGeoService({ ...t.config, ORS_API_KEY: 'k', EXTERNAL_HTTP_RETRIES: 2 }, logger).getRouteGeometry({ lat: 11, lng: 77 }, { lat: 11.2, lng: 77.3 });
    expect(failing).toHaveBeenCalledTimes(3); // 1 try + 2 bounded retries
    expect(g3.provider).toBe('fallback');
    expect(g3.coordinates[0]).toEqual([77, 11]);
  });

  it('GET /view/api/get_route keeps the legacy ORS JSON shape and accepts integers/negatives', async () => {
    const res = await request(t.app).get('/view/api/get_route/28.4646/77.5113/28.5206/77.2013').set(bearer(passenger.token));
    expect(res.status).toBe(200);
    expect(res.body.routes[0].geometry.type).toBe('LineString');
    expect(res.body.routes[0].summary).toHaveProperty('duration');
    expect((await request(t.app).get('/view/api/get_route/-33/151/-34/150').set(bearer(passenger.token))).status).toBe(200);
    expect((await request(t.app).get('/view/api/get_route/95/1/2/3').set(bearer(passenger.token))).status).toBe(400);
  });
});

describe('daily schedule generation', () => {
  // Fixed date far from "today": other tests in this file create trips dated today.
  const date = '2031-03-11';

  it('pairs buses with drivers and applies the legacy timing rules', async () => {
    const summary = await generateDailySchedules(date, { tz: TZ, logger });
    expect(summary.created).toBeGreaterThan(0);
    const trips = await Schedule.find({ date }).sort({ arrivalTime: 1 }).lean();
    const first = trips[0];
    // 07:00 IST start -> arrival 07:30 IST (02:00Z), departure 07:35 IST.
    expect(first.arrivalTime.toISOString()).toBe('2031-03-11T02:00:00.000Z');
    expect(first.departureTime.toISOString()).toBe('2031-03-11T02:05:00.000Z');
    if (trips[1]) expect(trips[1].arrivalTime - first.arrivalTime).toBe(30 * 60_000);
    expect(first).toMatchObject({ status: 'on_time', currentIndex: 0, isReached: false, direction: 'forward' });
  });

  it('is idempotent, including concurrent runs', async () => {
    const before = await Schedule.countDocuments({ date });
    await Promise.all([1, 2, 3].map(() => generateDailySchedules(date, { tz: TZ, logger })));
    expect(await Schedule.countDocuments({ date })).toBe(before);
  });

  it('job runs at most once per day and honours the cron time / grace window', async () => {
    const config = { ...t.config, SCHEDULE_CRON_TIME: '10:05', SCHEDULE_CATCHUP_ON_START: false };
    const at = (iso) => new Date(iso);
    expect(isDue(at('2026-10-21T04:30:00Z'), { tz: TZ, cronTime: '10:05', catchUp: false })).toBe(false); // 10:00 IST
    expect(isDue(at('2026-10-21T04:37:00Z'), { tz: TZ, cronTime: '10:05', catchUp: false })).toBe(true); // 10:07 IST
    expect(isDue(at('2026-10-21T06:00:00Z'), { tz: TZ, cronTime: '10:05', catchUp: false })).toBe(false); // missed
    expect(isDue(at('2026-10-21T06:00:00Z'), { tz: TZ, cronTime: '10:05', catchUp: true })).toBe(true);

    const now = at('2026-10-22T04:36:00Z');
    const r1 = await runDailyScheduleJob({ now, config, logger });
    const r2 = await runDailyScheduleJob({ now, config, logger });
    expect(r1.ran).toBe(true);
    expect(r2).toEqual({ ran: false, reason: 'already_succeeded' });
    expect((await JobRun.findOne({ runKey: '2026-10-22' }).lean()).status).toBe('succeeded');
  });

  it('lease lock admits a single holder', async () => {
    expect(await acquireLease('test-lock', 'a', 5000)).toBe(true);
    expect(await acquireLease('test-lock', 'b', 5000)).toBe(false);
    expect(await acquireLease('test-lock', 'a', 5000)).toBe(true);
    await releaseLease('test-lock', 'a');
    expect(await acquireLease('test-lock', 'b', 5000)).toBe(true);
  });
});

describe('location simulation', () => {
  it('advances one vertex per tick in [lng, lat] order, never resets, completes, and is safe under concurrency', async () => {
    const route = await createRoute();
    const bus = await createBus();
    const driver = await createUser('driver');
    const trip = await Schedule.create({
      scheduleId: await nextSeq('schedules'), route: route._id, bus: bus._id, driver: driver._id,
      date: todayInTz(TZ), arrivalTime: new Date(Date.now() - 60_000), departureTime: new Date(Date.now() + 240_000),
    });
    const geo = fakeGeo(); // 3-vertex geometry
    const tick = () => runSimulationTick({ config: t.config, logger, geo });

    await Promise.all([tick(), tick(), tick()]); // concurrent workers: still a single step
    let s = await Schedule.findById(trip._id).lean();
    expect(s.currentIndex).toBe(1);
    expect(s.status).toBe('running');
    let loc = await BusLocation.findOne({ busId: bus.busId }).lean();
    expect(loc.location.coordinates).toEqual([77.5113, 28.4646]);
    expect(loc.source).toBe('simulation');

    await new Promise((r) => setTimeout(r, 5));
    await tick();
    await new Promise((r) => setTimeout(r, 5));
    await tick();
    s = await Schedule.findById(trip._id).lean();
    expect(s.currentIndex).toBe(3);
    expect(s.isReached).toBe(true);
    expect(s.status).toBe('arrived');
    loc = await BusLocation.findOne({ busId: bus.busId }).lean();
    expect(loc.location.coordinates).toEqual([77.2013, 28.5206]);

    await tick();
    expect((await Schedule.findById(trip._id).lean()).currentIndex).toBe(3);
  });

  it('does not start trips whose arrival_time is in the future', async () => {
    const route = await createRoute();
    const bus = await createBus();
    const driver = await createUser('driver');
    const trip = await Schedule.create({
      scheduleId: await nextSeq('schedules'), route: route._id, bus: bus._id, driver: driver._id,
      date: todayInTz(TZ), arrivalTime: new Date(Date.now() + 3600_000), departureTime: new Date(Date.now() + 3900_000),
    });
    await runSimulationTick({ config: t.config, logger, geo: fakeGeo() });
    expect((await Schedule.findById(trip._id).lean()).currentIndex).toBe(0);
  });
});
