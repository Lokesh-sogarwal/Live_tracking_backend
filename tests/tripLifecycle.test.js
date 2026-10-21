import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Schedule, nextSeq } from '../src/models/index.js';
import { tripLifecycle, isEligibleToRun } from '../src/services/tripLifecycle.js';
import { eligibleTrips, runSimulationTick } from '../src/jobs/simulationJob.js';
import { createLogger } from '../src/config/logger.js';
import { bearer, createBus, createRoute, createUser, fakeGeo, setupTestApp, userWithToken } from './helpers.js';

const logger = createLogger('silent');
const at = (iso) => new Date(iso);
// Production scenario, 21 Oct 2026 (IST = UTC+05:30): trips 07:30–07:35 and 16:54–16:59.
const T0730 = at('2026-10-21T02:00:00Z');
const T0735 = at('2026-10-21T02:05:00Z');
const T1654 = at('2026-10-21T11:24:00Z');
const T1659 = at('2026-10-21T11:29:00Z');

describe('tripLifecycle (pure rules)', () => {
  const trip = (over = {}) => ({ arrivalTime: T1654, departureTime: T1659, currentIndex: 0, isReached: false, status: 'on_time', ...over });
  it('upcoming before the start; never running early', () => {
    expect(tripLifecycle(trip(), at('2026-10-21T11:23:59Z'))).toBe('upcoming');
    expect(isEligibleToRun(trip(), at('2026-10-21T11:23:59Z'))).toBe(false);
  });
  it('not_started (eligible) from the start until the scheduled end', () => {
    expect(tripLifecycle(trip(), T1654)).toBe('not_started');
    expect(isEligibleToRun(trip(), T1654)).toBe(true);
  });
  it('did_not_depart once the window passes without departing (not running, not stale, not completed)', () => {
    expect(tripLifecycle(trip(), T1659)).toBe('did_not_depart');
    expect(isEligibleToRun(trip(), T1659)).toBe(false);
  });
  it('running once departed; delayed when past its end or set delayed; never completed by time alone', () => {
    expect(tripLifecycle(trip({ currentIndex: 3 }), at('2026-10-21T11:26:00Z'))).toBe('running');
    expect(tripLifecycle(trip({ currentIndex: 3 }), at('2026-10-21T12:30:00Z'))).toBe('delayed');
    expect(tripLifecycle(trip({ currentIndex: 3, status: 'delayed' }), at('2026-10-21T11:26:00Z'))).toBe('delayed');
  });
  it('completed / delayed_completed only after arrival; cancelled and invalid never run', () => {
    expect(tripLifecycle(trip({ isReached: true, status: 'arrived' }), T1659)).toBe('completed');
    expect(tripLifecycle(trip({ isReached: true, status: 'delayed_completed' }), T1659)).toBe('delayed_completed');
    expect(tripLifecycle(trip({ status: 'Cancelled' }), T1654)).toBe('cancelled');
    expect(tripLifecycle(trip({ departureTime: T1654 }), T1654)).toBe('invalid');
    expect(isEligibleToRun(trip({ status: 'Cancelled' }), T1654)).toBe(false);
  });
});

describe('production scenario: bus with a missed 07:30 trip and a 16:54 trip', () => {
  let t;
  let token;
  let bus;
  let missed;
  let evening;
  beforeAll(async () => {
    t = await setupTestApp('trip_lifecycle');
    ({ token } = await userWithToken(t.app, 'admin'));
    const route = await createRoute({ routeName: 'Bharatpur -> Mathura express' });
    bus = await createBus({ busNumber: 'KA-01-AB-1342' });
    const driver = await createUser('driver');
    const mk = async (start, end) =>
      Schedule.create({ scheduleId: await nextSeq('schedules'), route: route._id, bus: bus._id, driver: driver._id, date: '2026-10-21', arrivalTime: start, departureTime: end });
    missed = await mk(T0730, T0735);
    evening = await mk(T1654, T1659);
  });
  afterAll(() => t.close());

  it('at 16:54 IST the 16:54 trip is eligible and the 07:30 trip is not (it does not block the bus)', async () => {
    const ids = (await eligibleTrips(T1654, t.config)).map((s) => s.scheduleId);
    expect(ids).toContain(evening.scheduleId);
    expect(ids).not.toContain(missed.scheduleId);
  });

  it('the simulation starts the 16:54 trip at its origin; the 07:30 trip stays did_not_depart', async () => {
    await runSimulationTick({ now: T1654, config: t.config, logger, geo: fakeGeo() });
    expect((await Schedule.findById(evening._id).lean()).currentIndex).toBe(1);
    expect((await Schedule.findById(missed._id).lean()).currentIndex).toBe(0);
    expect(tripLifecycle(await Schedule.findById(missed._id).lean(), T1654)).toBe('did_not_depart');
  });

  it('schedule API, public timetable and location API report the same lifecycle (server clock)', async () => {
    // Real "now" is after both windows; the evening trip has departed (step 1) → delayed (late).
    const rows = await request(t.app).get('/bus/schedules?date=2026-10-21').set(bearer(token));
    const byId = Object.fromEntries(rows.body.map((r) => [r.schedule_id, r]));
    expect(byId[missed.scheduleId]).toMatchObject({ lifecycle: 'did_not_depart', started: false, start_at: T0730.toISOString(), end_at: T0735.toISOString() });
    expect(byId[evening.scheduleId]).toMatchObject({ lifecycle: 'delayed', started: true });

    const missedLoc = await request(t.app).get(`/view/get_location/${bus.busId}?schedule_id=${missed.scheduleId}`).set(bearer(token));
    expect(missedLoc.body).toMatchObject({ location: null, lifecycle: 'did_not_depart', trip_started: false });

    const route = await request(t.app).post('/bus/get_routes').set(bearer(token)).send({ source: 'pari chowk', destination: 'saket metro' });
    const searched = route.body.flatMap((r) => r.schedules || []).find((s) => s.schedule_id === missed.scheduleId);
    if (searched) expect(searched).toMatchObject({ lifecycle: 'did_not_depart', started: false });
  });
});
