import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Schedule, nextSeq } from '../src/models/index.js';
import { runSimulationTick } from '../src/jobs/simulationJob.js';
import { createLogger } from '../src/config/logger.js';
import { todayInTz } from '../src/utils/time.js';
import { bearer, createBus, createRoute, createUser, fakeGeo, setupTestApp, userWithToken } from './helpers.js';

// The exact production request: GET /view/get_location/:bus_id?schedule_id=:id (Bus Tracking).
const logger = createLogger('silent');
let t;
let token;
beforeAll(async () => {
  t = await setupTestApp('trip_request');
  ({ token } = await userWithToken(t.app, 'superadmin'));
});
afterAll(() => t.close());

async function trip({ startMs, endMs, bus }) {
  const route = await createRoute({ routeName: 'Bharatpur -> Mathura express' });
  const b = bus ?? (await createBus());
  const driver = await createUser('driver');
  const now = Date.now();
  const s = await Schedule.create({
    scheduleId: await nextSeq('schedules'), route: route._id, bus: b._id, driver: driver._id,
    date: todayInTz(t.config.APP_TIMEZONE), arrivalTime: new Date(now + startMs), departureTime: new Date(now + endMs),
  });
  return { bus: b, trip: s };
}
const get = (busId, scheduleId) => request(t.app).get(`/view/get_location/${busId}?schedule_id=${scheduleId}`).set(bearer(token));

describe('GET /view/get_location/:bus_id?schedule_id=', () => {
  it('a real trip that has not departed answers 200 with location null and its state (not 404)', async () => {
    const { bus, trip: s } = await trip({ startMs: -60 * 60_000, endMs: -40 * 60_000 }); // like #1: window passed
    const res = await get(bus.busId, s.scheduleId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bus_id: bus.busId, schedule_id: s.scheduleId, location: null, trip_status: 'on_time', trip_completed: false, trip_started: false });
  });

  it('an unknown schedule id, or one belonging to another bus, is a permanent 404 TRIP_NOT_FOUND', async () => {
    const { bus } = await trip({ startMs: 0, endMs: 60_000 });
    const other = await trip({ startMs: 0, endMs: 60_000 });
    for (const res of [await get(bus.busId, 999999), await get(bus.busId, other.trip.scheduleId)]) {
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('TRIP_NOT_FOUND');
    }
  });

  it('once the trip departs, the same request returns its position', async () => {
    const { bus, trip: s } = await trip({ startMs: -60_000, endMs: 30 * 60_000 });
    await runSimulationTick({ config: t.config, logger, geo: fakeGeo() });
    const res = await get(bus.busId, s.scheduleId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schedule_id: s.scheduleId, latitude: 28.4646, longitude: 77.5113, trip_completed: false });
  });

  it('the legacy form without schedule_id keeps its contract (404 when the bus never reported)', async () => {
    const { bus } = await trip({ startMs: 0, endMs: 60_000 });
    const res = await request(t.app).get(`/view/get_location/${bus.busId}`).set(bearer(token));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No location found');
  });

  it('needs a signed-in user with tracking access', async () => {
    const { bus, trip: s } = await trip({ startMs: 0, endMs: 60_000 });
    expect((await request(t.app).get(`/view/get_location/${bus.busId}?schedule_id=${s.scheduleId}`)).status).toBe(401);
  });
});

describe('schedules and public timetable say whether a bus actually departed', () => {
  it('started flag; public status: scheduled / running / missed', async () => {
    const missed = await trip({ startMs: -60 * 60_000, endMs: -40 * 60_000 });
    const due = await trip({ startMs: -60_000, endMs: 30 * 60_000 });
    const moving = await trip({ startMs: -60_000, endMs: 30 * 60_000 });
    await Schedule.updateOne({ _id: moving.trip._id }, { $set: { currentIndex: 5 } });
    const rows = await request(t.app).get(`/bus/schedules?date=${todayInTz(t.config.APP_TIMEZONE)}`).set(bearer(token));
    const byId = Object.fromEntries(rows.body.map((r) => [r.schedule_id, r]));
    expect([byId[missed.trip.scheduleId].started, byId[moving.trip.scheduleId].started]).toEqual([false, true]);
    const pub = await request(t.app).get('/public/departures');
    const st = Object.fromEntries(pub.body.departures.map((d) => [d.schedule_id, d.status]));
    expect([st[missed.trip.scheduleId], st[due.trip.scheduleId], st[moving.trip.scheduleId]]).toEqual(['missed', 'scheduled', 'running']);
  });
});
