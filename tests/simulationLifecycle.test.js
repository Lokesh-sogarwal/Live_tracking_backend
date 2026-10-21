import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { BusLocation, Schedule, nextSeq } from '../src/models/index.js';
import { COMPLETED, DELAYED_COMPLETED, eligibleTrips, runSimulationTick } from '../src/jobs/simulationJob.js';
import { createLogger } from '../src/config/logger.js';
import { todayInTz } from '../src/utils/time.js';
import { bearer, createBus, createRoute, createUser, fakeGeo, setupTestApp, userWithToken } from './helpers.js';

// Deterministic simulation clock: 10:00 IST on 10 Mar 2031 (04:30 UTC). Every tick gets `now`.
const T0 = new Date('2031-03-10T04:30:00Z');
const at = (ms) => new Date(T0.getTime() + ms);
const MIN = 60_000;
const PARI = [77.5113, 28.4646];
const SAKET = [77.2013, 28.5206];
const logger = createLogger('silent');

let t;
beforeAll(async () => {
  t = await setupTestApp('simulation_lifecycle');
});
afterAll(() => t.close());

// fakeGeo: 3 route points (origin, middle, destination) -> arrival on the 3rd tick.
const tick = (now) => runSimulationTick({ now, config: t.config, logger, geo: fakeGeo() });
async function trip({ startMs, endMs, status = 'on_time', direction = 'forward', bus, clock = T0 }) {
  const route = await createRoute();
  const theBus = bus ?? (await createBus());
  const driver = await createUser('driver');
  const start = new Date(clock.getTime() + startMs);
  return Schedule.create({
    scheduleId: await nextSeq('schedules'), route: route._id, bus: theBus._id, driver: driver._id, status, direction,
    date: todayInTz(t.config.APP_TIMEZONE, start), arrivalTime: start, departureTime: new Date(clock.getTime() + endMs),
  });
}
const reload = (s) => Schedule.findById(s._id).lean();
const position = async (s) => BusLocation.findOne({ bus: s.bus }).lean();

describe('which trips run', () => {
  it('1. a future trip does not start early', async () => {
    const s = await trip({ startMs: 60 * MIN, endMs: 90 * MIN });
    await tick(T0);
    expect((await reload(s)).currentIndex).toBe(0);
    expect(await position(s)).toBeNull();
  });

  it('2. a trip scheduled for now starts at its origin and runs', async () => {
    const s = await trip({ startMs: -1 * MIN, endMs: 30 * MIN });
    expect((await eligibleTrips(T0, t.config)).map((x) => x.scheduleId)).toContain(s.scheduleId);
    await tick(T0);
    const r = await reload(s);
    expect([r.currentIndex, r.status, r.isReached]).toEqual([1, 'running', false]);
    expect((await position(s)).location.coordinates).toEqual(PARI);
  });

  it('3. a trip whose scheduled window has already ended never starts', async () => {
    const s = await trip({ startMs: -120 * MIN, endMs: -60 * MIN });
    await tick(T0);
    expect((await reload(s)).currentIndex).toBe(0);
    expect(await position(s)).toBeNull();
  });

  it('4. a cancelled trip never runs', async () => {
    const s = await trip({ startMs: -1 * MIN, endMs: 30 * MIN, status: 'Cancelled' });
    await tick(T0);
    expect((await reload(s)).currentIndex).toBe(0);
  });

  it('an invalid schedule (end before start) never runs', async () => {
    const s = await trip({ startMs: -1 * MIN, endMs: -2 * MIN });
    await tick(T0);
    expect((await reload(s)).currentIndex).toBe(0);
  });
});

describe('arrival and completion', () => {
  it('5. reaching the destination on time -> "arrived", once, with the final position and time', async () => {
    const s = await trip({ startMs: -1 * MIN, endMs: 30 * MIN });
    await tick(T0);
    await tick(at(1 * MIN));
    const third = await tick(at(2 * MIN));
    expect(third).toMatchObject({ completed: 1, delayedCompleted: 0 });
    const r = await reload(s);
    expect(r).toMatchObject({ isReached: true, status: COMPLETED, currentIndex: 3 });
    expect(r.arrivedAt.toISOString()).toBe(at(2 * MIN).toISOString());
    const p = await position(s);
    expect(p.location.coordinates).toEqual(SAKET);
    expect(p.recordedAt.toISOString()).toBe(at(2 * MIN).toISOString());
  });

  it('6. reaching it after the scheduled arrival -> "delayed_completed"', async () => {
    const s = await trip({ startMs: -1 * MIN, endMs: 90_000 });
    await tick(T0);
    await tick(at(1 * MIN));
    const third = await tick(at(2 * MIN)); // scheduled end was T0 + 90 s
    expect(third).toMatchObject({ completed: 1, delayedCompleted: 1 });
    expect(await reload(s)).toMatchObject({ isReached: true, status: DELAYED_COMPLETED });
  });

  it('7. past the scheduled arrival but not at the destination -> still running, not completed', async () => {
    const s = await trip({ startMs: -1 * MIN, endMs: 90_000 });
    await tick(T0);
    await tick(at(5 * MIN)); // well after the scheduled end, one step short of the destination
    const r = await reload(s);
    expect([r.isReached, r.status, r.currentIndex, r.arrivedAt]).toEqual([false, 'running', 2, null]);
  });

  it('an operator-set "delayed" status stays until arrival, then becomes a completion status', async () => {
    const s = await trip({ startMs: -1 * MIN, endMs: 30 * MIN, status: 'delayed' });
    await tick(T0);
    expect((await reload(s)).status).toBe('delayed');
    await tick(at(1 * MIN));
    await tick(at(2 * MIN));
    expect((await reload(s)).status).toBe(COMPLETED);
  });

  it('8. a completed trip produces no more positions and never restarts', async () => {
    const s = await trip({ startMs: -1 * MIN, endMs: 30 * MIN });
    for (const m of [0, 1, 2]) await tick(at(m * MIN));
    const final = await position(s);
    for (const m of [3, 4, 10]) await tick(at(m * MIN));
    const after = await position(s);
    expect(after.recordedAt.toISOString()).toBe(final.recordedAt.toISOString());
    expect(after.location.coordinates).toEqual(SAKET);
    expect((await reload(s)).currentIndex).toBe(3);
  });

  it('9. concurrent workers on the last step complete the trip exactly once', async () => {
    const s = await trip({ startMs: -1 * MIN, endMs: 30 * MIN });
    await tick(T0);
    await tick(at(1 * MIN));
    const results = await Promise.all([tick(at(2 * MIN)), tick(at(2 * MIN)), tick(at(2 * MIN))]);
    expect(results.reduce((n, r) => n + r.completed, 0)).toBe(1);
    const r = await reload(s);
    expect([r.currentIndex, r.status]).toEqual([3, COMPLETED]);
  });
});

describe('independence and time', () => {
  it('10. buses with different schedules run independently; a bus\'s next trip waits for its current one', async () => {
    const busA = await createBus();
    const a1 = await trip({ startMs: -1 * MIN, endMs: 30 * MIN, bus: busA });
    const a2 = await trip({ startMs: 0, endMs: 30 * MIN, bus: busA, direction: 'reverse' }); // overlaps a1
    const b = await trip({ startMs: 2 * MIN, endMs: 30 * MIN });
    await tick(T0);
    expect([(await reload(a1)).currentIndex, (await reload(a2)).currentIndex, (await reload(b)).currentIndex]).toEqual([1, 0, 0]);
    await tick(at(1 * MIN));
    await tick(at(2 * MIN)); // a1 arrives; b's window opens
    expect([(await reload(a1)).isReached, (await reload(b)).currentIndex]).toEqual([true, 1]);
    await tick(at(3 * MIN)); // a2 now runs, from Saket (reverse)
    expect((await reload(a2)).currentIndex).toBe(1);
    expect((await position(a2)).location.coordinates).toEqual(SAKET);
  });

  it('11. a trip running across midnight IST continues the next day; dates follow IST, not UTC', async () => {
    const lateEvening = new Date('2031-03-10T18:28:00Z'); // 23:58 IST on 10 Mar
    const s = await trip({ startMs: 0, endMs: 30 * MIN, clock: lateEvening });
    expect(s.date).toBe('2031-03-10');
    await tick(lateEvening);
    const afterMidnight = new Date('2031-03-10T18:31:00Z'); // 00:01 IST on 11 Mar
    expect(todayInTz(t.config.APP_TIMEZONE, afterMidnight)).toBe('2031-03-11');
    await tick(afterMidnight);
    expect((await reload(s)).currentIndex).toBe(2);

    // A 05:00 IST trip on 11 Mar starts at 23:30 UTC on 10 Mar: it belongs to 11 Mar in IST.
    const earlyIst = new Date('2031-03-10T23:30:00Z');
    const e = await trip({ startMs: 0, endMs: 30 * MIN, clock: earlyIst });
    expect(e.date).toBe('2031-03-11');
    await tick(earlyIst);
    expect((await reload(e)).currentIndex).toBe(1);
  });

  it('12. positions, completion and statuses reach the APIs (trip_status, arrived_at, public label)', async () => {
    // Real time here, so the API's freshness rules apply as in production.
    const now = new Date();
    const s = await trip({ startMs: -1 * MIN, endMs: 1000, clock: now });
    await tick(now);
    await tick(new Date(now.getTime() + 1500));
    await tick(new Date(now.getTime() + 3000)); // after the scheduled end -> late
    const bus = await (await import('../src/models/index.js')).Bus.findById(s.bus).lean();
    const { token } = await userWithToken(t.app, 'admin');
    const loc = await request(t.app).get(`/view/get_location/${bus.busId}?schedule_id=${s.scheduleId}`).set(bearer(token));
    expect(loc.body).toMatchObject({ trip_completed: true, trip_status: DELAYED_COMPLETED, is_stale: false });
    const rows = await request(t.app).get(`/bus/schedules?date=${s.date}`).set(bearer(token));
    const row = rows.body.find((r) => r.schedule_id === s.scheduleId);
    expect(row).toMatchObject({ is_reached: true, status: DELAYED_COMPLETED });
    expect(row.arrived_at).toBeTruthy();
    const pub = await request(t.app).get('/public/departures');
    expect(pub.body.departures.find((d) => d.schedule_id === s.scheduleId)?.status).toBe('completed_late');
  });
});
