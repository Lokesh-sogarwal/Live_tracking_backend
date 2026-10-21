import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { io as connect } from 'socket.io-client';
import { BusLocation, RouteGeometry, Schedule, nextSeq } from '../src/models/index.js';
import { runSimulationTick } from '../src/jobs/simulationJob.js';
import { createLogger } from '../src/config/logger.js';
import { createGeoService, orientGeometry } from '../src/services/geo.js';
import { todayInTz } from '../src/utils/time.js';
import { bearer, createBus, createRoute, createUser, fakeGeo, login, setupTestApp, startRealtime, userWithToken } from './helpers.js';

// Pari Chowk -> Saket (helpers.createRoute): start (28.4646, 77.5113), end (28.5206, 77.2013).
const PARI = [77.5113, 28.4646];
const SAKET = [77.2013, 28.5206];
const logger = createLogger('silent');
const pause = () => new Promise((r) => setTimeout(r, 8)); // each recorded position needs a later timestamp

let t;
let viewerToken;
beforeAll(async () => {
  t = await setupTestApp('trip_location');
  ({ token: viewerToken } = await userWithToken(t.app, 'passenger'));
});
afterAll(() => t.close());

const tick = () => runSimulationTick({ config: t.config, logger, geo: fakeGeo() });
const trip = async ({ route, bus, driver, startsInMs = -60_000, durationMs = 3600_000, ...rest }) =>
  Schedule.create({
    scheduleId: await nextSeq('schedules'),
    route: route._id,
    bus: bus._id,
    driver: driver._id,
    date: todayInTz(t.config.APP_TIMEZONE),
    arrivalTime: new Date(Date.now() + startsInMs), // legacy naming: arrivalTime is the trip start
    departureTime: new Date(Date.now() + startsInMs + durationMs),
    ...rest,
  });
const position = async (busId, scheduleId) =>
  request(t.app).get(`/view/get_location/${busId}${scheduleId ? `?schedule_id=${scheduleId}` : ''}`).set(bearer(viewerToken));

describe('route geometry orientation', () => {
  const start = { lng: PARI[0], lat: PARI[1] };
  const end = { lng: SAKET[0], lat: SAKET[1] };
  const line = [PARI, [77.35, 28.49], SAKET];

  it('keeps start -> end, flips a reversed line, rejects unrelated lines and bad points', () => {
    expect(orientGeometry({ coordinates: line }, start, end).coordinates).toEqual(line);
    expect(orientGeometry({ coordinates: [...line].reverse() }, start, end).coordinates).toEqual(line);
    expect(orientGeometry({ coordinates: [[72.8, 19.0], [72.9, 19.1]] }, start, end)).toBeNull();
    const dirty = [PARI, [Number.NaN, 28.5], [200, 28.5], [77.35, 95], SAKET];
    expect(orientGeometry({ coordinates: dirty }, start, end).coordinates).toEqual([PARI, SAKET]);
  });

  it('the geometry service starts at Pari Chowk and ends at Saket, and repairs a reversed cache entry', async () => {
    const geo = createGeoService({ ...t.config, ORS_API_KEY: '' }, logger);
    const g = await geo.getRouteGeometry(start, end);
    expect(g.provider).toBe('fallback');
    expect(g.coordinates[0]).toEqual(PARI);
    expect(g.coordinates.at(-1)).toEqual(SAKET);

    const key = [start.lng, start.lat, end.lng, end.lat].map((n) => n.toFixed(6)).join(',');
    await RouteGeometry.updateOne({ key }, { $set: { coordinates: [...g.coordinates].reverse(), provider: 'ors' } });
    const repaired = await geo.getRouteGeometry(start, end);
    expect(repaired.coordinates[0]).toEqual(PARI);
    expect(repaired.coordinates.at(-1)).toEqual(SAKET);
  });
});

describe('Pari Chowk -> Saket: a trip that has not started never shows the bus at Saket', () => {
  it('reproduces the bug and verifies the fix', async () => {
    const route = await createRoute();
    const bus = await createBus();
    const driver = await createUser('driver');

    // Trip A runs to the end: the bus is left at Saket.
    const a = await trip({ route, bus, driver, startsInMs: -120_000 });
    for (let i = 0; i < 4; i++) {
      await tick();
      await pause();
    }
    expect((await Schedule.findById(a._id).lean()).isReached).toBe(true);
    const stored = await BusLocation.findOne({ busId: bus.busId }).lean();
    expect(stored.location.coordinates).toEqual(SAKET);
    expect(stored.scheduleId).toBe(a.scheduleId);

    // Trip B is scheduled later the same day.
    const b = await trip({ route, bus, driver, startsInMs: 3600_000 });
    // Before: the per-bus endpoint hands back Saket for B. It now labels which trip it came from...
    const legacy = await position(bus.busId);
    expect(legacy.status).toBe(200);
    expect(legacy.body).toMatchObject({ schedule_id: a.scheduleId, trip_completed: true });
    // ...and asked for trip B, it has nothing: the page shows "not started", not a bus at Saket.
    const forB = await position(bus.busId, b.scheduleId);
    // An existing trip with no position yet is an empty result, not a 404.
    expect(forB.status).toBe(200);
    expect(forB.body).toEqual({ bus_id: bus.busId, schedule_id: b.scheduleId, location: null, trip_status: 'on_time', trip_completed: false, trip_started: false });
  });

  it('a new trip starts at the origin and advances toward the destination (no inherited coordinates)', async () => {
    const route = await createRoute();
    const bus = await createBus();
    const driver = await createUser('driver');
    const a = await trip({ route, bus, driver, startsInMs: -120_000 });
    for (let i = 0; i < 4; i++) {
      await tick();
      await pause();
    }
    expect((await Schedule.findById(a._id).lean()).isReached).toBe(true);

    const b = await trip({ route, bus, driver, startsInMs: -1000 });
    await tick();
    let loc = await position(bus.busId, b.scheduleId);
    expect(loc.status).toBe(200);
    expect([loc.body.longitude, loc.body.latitude]).toEqual(PARI);
    await pause();
    await tick();
    loc = await position(bus.busId, b.scheduleId);
    expect(loc.body.longitude).toBeLessThan(PARI[0]); // moved west, toward Saket
    expect(loc.body.longitude).toBeGreaterThan(SAKET[0]);
    expect((await Schedule.findById(b._id).lean()).currentIndex).toBe(2);
  });

  it('a reverse trip starts at Saket and is reported as running Saket -> Pari Chowk', async () => {
    const route = await createRoute();
    const bus = await createBus();
    const driver = await createUser('driver');
    const r = await trip({ route, bus, driver, direction: 'reverse' });
    await tick();
    const loc = await position(bus.busId, r.scheduleId);
    expect([loc.body.longitude, loc.body.latitude]).toEqual(SAKET);
    const { token } = await userWithToken(t.app, 'admin');
    const rows = await request(t.app).get(`/bus/schedules?date=${todayInTz(t.config.APP_TIMEZONE)}`).set(bearer(token));
    expect(rows.body.find((x) => x.schedule_id === r.scheduleId).direction).toBe('reverse');
    const pub = await request(t.app).get('/public/departures');
    expect(pub.body.departures.find((x) => x.schedule_id === r.scheduleId)).toMatchObject({ start_point: route.endPoint, end_point: route.startPoint });
  });
});

describe('independence and ordering', () => {
  it('overlapping trips of one bus: only the earliest moves, so positions never alternate between trips', async () => {
    const route = await createRoute();
    const bus = await createBus();
    const driver = await createUser('driver');
    const first = await trip({ route, bus, driver, startsInMs: -90_000 });
    const second = await trip({ route, bus, driver, startsInMs: -30_000, direction: 'reverse' });
    await tick();
    await pause();
    await tick();
    expect((await Schedule.findById(first._id).lean()).currentIndex).toBe(2);
    expect((await Schedule.findById(second._id).lean()).currentIndex).toBe(0);
    expect((await BusLocation.findOne({ busId: bus.busId }).lean()).scheduleId).toBe(first.scheduleId);
  });

  it('two buses update independently', async () => {
    const route = await createRoute();
    const driver = await createUser('driver');
    const b1 = await createBus();
    const b2 = await createBus();
    const t1 = await trip({ route, bus: b1, driver, startsInMs: -60_000 });
    const t2 = await trip({ route, bus: b2, driver, startsInMs: -60_000, direction: 'reverse' });
    await tick();
    const [p1, p2] = await Promise.all([position(b1.busId, t1.scheduleId), position(b2.busId, t2.scheduleId)]);
    expect([p1.body.longitude, p1.body.latitude]).toEqual(PARI);
    expect([p2.body.longitude, p2.body.latitude]).toEqual(SAKET);
  });

  it('a completed trip does not move again, and an older position never overwrites a newer one', async () => {
    const route = await createRoute();
    const bus = await createBus();
    const driver = await createUser('driver');
    const done = await trip({ route, bus, driver, startsInMs: -120_000 });
    for (let i = 0; i < 5; i++) {
      await tick();
      await pause();
    }
    const before = await BusLocation.findOne({ busId: bus.busId }).lean();
    await tick();
    const after = await BusLocation.findOne({ busId: bus.busId }).lean();
    expect(after.recordedAt).toEqual(before.recordedAt);
    expect((await Schedule.findById(done._id).lean()).status).toBe('arrived');

    const { token } = await userWithToken(t.app, 'admin');
    const old = await request(t.app).post('/view/update_location').set(bearer(token))
      .send({ bus_id: bus.busId, latitude: 28.5, longitude: 77.3, timestamp: new Date(before.recordedAt.getTime() - 1000).toISOString() });
    expect(old.status).toBe(409);
    const bad = await request(t.app).post('/view/update_location').set(bearer(token)).send({ bus_id: bus.busId, latitude: 91, longitude: 77.3 });
    expect(bad.status).toBe(400);
  });

  it('a driver device position is tied to the trip in progress, not to a finished or future trip', async () => {
    const route = await createRoute();
    const bus = await createBus();
    const driver = await createUser('driver');
    await trip({ route, bus, driver, startsInMs: -7200_000, isReached: true, status: 'arrived' });
    const running = await trip({ route, bus, driver, startsInMs: -60_000 });
    await trip({ route, bus, driver, startsInMs: 3600_000 });
    const token = await login(t.app, driver);
    const res = await request(t.app).post('/view/update_location').set(bearer(token)).send({ bus_id: bus.busId, latitude: 28.47, longitude: 77.49 });
    expect(res.status).toBe(200);
    expect(res.body.schedule_id).toBe(running.scheduleId);
  });
});

describe('positions stored without scheduleId (older worker or data) still name their trip', () => {
  it('Socket.IO subscribe snapshot and REST carry schedule_id from the trip reference', async () => {
    const route = await createRoute();
    const bus = await createBus();
    const driver = await createUser('driver');
    const running = await trip({ route, bus, driver });
    // Written the way the previous worker version wrote it: trip reference, no scheduleId.
    await BusLocation.create({ bus: bus._id, busId: bus.busId, location: { type: 'Point', coordinates: PARI }, recordedAt: new Date(), source: 'simulation', schedule: running._id });

    const rest = await position(bus.busId, running.scheduleId);
    expect(rest.status).toBe(200);
    expect(rest.body.schedule_id).toBe(running.scheduleId);

    const rt = await startRealtime(t.app, t.ctx);
    const s = connect(rt.url, { auth: { token: viewerToken }, transports: ['websocket'], reconnection: false, forceNew: true });
    try {
      const payload = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no bus:location')), 5000);
        s.on('bus:location', (p) => {
          clearTimeout(timer);
          resolve(p);
        });
        s.on('connect', () => s.emit('bus:subscribe', { busId: bus.busId }));
      });
      expect(payload.schedule_id).toBe(running.scheduleId);
    } finally {
      s.disconnect();
      await rt.stop();
    }
  });
});
