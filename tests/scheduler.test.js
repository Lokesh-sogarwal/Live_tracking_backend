import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { BusLocation, JobRun, Route, Schedule, nextSeq } from '../src/models/index.js';
import { isDue, runDailyScheduleJob, runReverseTripCheck, windowDates } from '../src/jobs/scheduleJob.js';
import { generateDailySchedules } from '../src/services/schedules.js';
import { runSimulationTick } from '../src/jobs/simulationJob.js';
import { createLogger } from '../src/config/logger.js';
import { todayInTz } from '../src/utils/time.js';
import { loadConfig } from '../src/config/index.js';
import { bearer, createBus, createRoute, createUser, fakeGeo, setupTestApp, userWithToken } from './helpers.js';

const TZ = 'Asia/Kolkata';
const logger = createLogger('silent');
// 00:00:30 IST on 1 Dec 2031 = 18:30:30 UTC on 30 Nov.
const MIDNIGHT = new Date('2031-11-30T18:30:30Z');
const DATES = ['2031-12-01', '2031-12-02', '2031-12-03', '2031-12-04', '2031-12-05', '2031-12-06', '2031-12-07', '2031-12-08'];

let t;
let config;
let route2;
beforeAll(async () => {
  t = await setupTestApp('scheduler');
  config = { ...t.config, SCHEDULE_CRON_TIME: '00:00', SCHEDULE_DAYS_AHEAD: 7, SCHEDULE_CATCHUP_ON_START: true };
  await createRoute({ routeName: 'Route one' });
  route2 = await createRoute({ routeName: 'Route two' });
  await createBus();
  await createBus();
  await createUser('driver');
  await createUser('driver');
});
afterAll(() => t.close());
beforeEach(async () => {
  await Promise.all([Schedule.deleteMany({}), JobRun.deleteMany({})]); // test data only (isolated test DB)
});

const run = (now, extra = {}) => runDailyScheduleJob({ now, config, logger, ...extra });
const perDate = async () => Object.fromEntries(await Promise.all(DATES.map(async (d) => [d, await Schedule.countDocuments({ date: d })])));

describe('defaults', () => {
  it('runs at midnight Asia/Kolkata and plans 7 days ahead unless configured', () => {
    const c = loadConfig({ NODE_ENV: 'test', MONGODB_URI: 'mongodb://x/y', JWT_SECRET: 'x'.repeat(40) });
    expect([c.SCHEDULE_CRON_TIME, c.APP_TIMEZONE, c.SCHEDULE_DAYS_AHEAD]).toEqual(['00:00', TZ, 7]);
    expect(() => loadConfig({ NODE_ENV: 'test', MONGODB_URI: 'mongodb://x/y', JWT_SECRET: 'x'.repeat(40), SCHEDULE_CRON_TIME: '24:00' })).toThrow();
  });

  it('is due from 00:00 IST, not at 23:59 IST or at UTC midnight', () => {
    const opts = { tz: TZ, cronTime: '00:00', catchUp: false };
    // 23:59:59 IST still belongs to 30 Nov; 00:00:30 IST is 1 Dec (not UTC midnight).
    expect(todayInTz(TZ, new Date('2031-11-30T18:29:59Z'))).toBe('2031-11-30');
    expect(todayInTz(TZ, new Date('2031-11-30T18:30:30Z'))).toBe('2031-12-01');
    expect(isDue(new Date('2031-11-30T18:29:00Z'), { ...opts, cronTime: '00:00' })).toBe(false); // 23:59 IST: past 30 Nov's grace, 1 Dec not yet
    expect(isDue(new Date('2031-11-30T18:30:30Z'), opts)).toBe(true); // 00:00:30 IST 1 Dec
    expect(isDue(new Date('2031-11-30T18:40:00Z'), opts)).toBe(false); // 00:10 IST: past the legacy grace without catch-up
    expect(isDue(new Date('2031-11-30T18:40:00Z'), { ...opts, catchUp: true })).toBe(true);
    expect(windowDates('2031-12-01', 7)).toEqual(DATES);
  });
});

describe('the midnight run', () => {
  it('1. creates schedules for today and the next 7 days, with the timetable rules', async () => {
    const r = await run(MIDNIGHT);
    expect(r).toMatchObject({ ran: true, status: 'succeeded' });
    expect(r.result).toMatchObject({ from: '2031-12-01', to: '2031-12-08', days: 8, created: 16, existing: 0 });
    expect(await perDate()).toEqual(Object.fromEntries(DATES.map((d) => [d, 2])));
    const first = await Schedule.findOne({ date: '2031-12-05' }).sort({ arrivalTime: 1 }).lean();
    // 07:00 IST + 30 min (legacy arrival) = 02:00 UTC
    expect(first.arrivalTime.toISOString()).toBe('2031-12-05T02:00:00.000Z');
    expect(first).toMatchObject({ status: 'on_time', currentIndex: 0, isReached: false, direction: 'forward' });
    expect((await JobRun.findOne({ runKey: '2031-12-01' }).lean())).toMatchObject({ status: 'succeeded' });
  });

  it('3. running twice (and the next midnight) creates no duplicates; the window rolls forward one day', async () => {
    await run(MIDNIGHT);
    expect(await run(new Date(MIDNIGHT.getTime() + 30_000))).toEqual({ ran: false, reason: 'already_succeeded' });
    const forced = await run(MIDNIGHT, { force: true });
    expect(forced.result).toMatchObject({ created: 0, existing: 16 });
    const next = await run(new Date(MIDNIGHT.getTime() + 86_400_000));
    expect(next.result).toMatchObject({ from: '2031-12-02', to: '2031-12-09', created: 2, existing: 14 });
    expect(await Schedule.countDocuments({})).toBe(18);
  });

  it('4. manual schedules are preserved, and their bus/driver is not double-booked', async () => {
    const [route] = await Route.find().sort({ routeId: 1 }).lean();
    const pairBus = (await (await import('../src/models/index.js')).Bus.find().sort({ busId: 1 }).lean())[0];
    const driver = await createUser('driver');
    const manual = await Schedule.create({
      scheduleId: await nextSeq('schedules'), route: route._id, bus: pairBus._id, driver: driver._id, date: '2031-12-03', direction: 'forward',
      arrivalTime: new Date('2031-12-03T01:50:00Z'), departureTime: new Date('2031-12-03T02:20:00Z'), status: 'on_time',
    });
    const r = await run(MIDNIGHT);
    expect(r.result.conflicts).toBe(1);
    const kept = await Schedule.findById(manual._id).lean();
    expect(kept).toMatchObject({ arrivalTime: manual.arrivalTime, departureTime: manual.departureTime, status: 'on_time' });
    expect(await Schedule.countDocuments({ date: '2031-12-03', bus: pairBus._id })).toBe(1);
  });

  it('5. routes with unusable coordinates and routes without a bus/driver pair are skipped safely', async () => {
    // routeId 0 sorts first, so the broken route is the one given a bus/driver pair.
    const bad = await Route.collection.insertOne({ routeId: 0, routeName: 'Broken', startPoint: 'X', endPoint: 'Y', start: { type: 'Point', coordinates: [0, 0] }, end: { type: 'Point', coordinates: [77.2, 28.5] } });
    const extra = await createRoute({ routeName: 'More routes than buses' });
    const r = await run(MIDNIGHT);
    expect(r.status).toBe('succeeded');
    expect(r.result.invalidRoutes).toBe(8);
    expect(await Schedule.countDocuments({ route: bad.insertedId })).toBe(0);
    expect(await Schedule.countDocuments({ route: extra._id })).toBe(0);
    await Route.deleteMany({ _id: { $in: [bad.insertedId, extra._id] } });
  });

  it('6. a missed midnight (worker down for 3 days) is recovered on restart without duplicates', async () => {
    await run(MIDNIGHT);
    const back = new Date(MIDNIGHT.getTime() + 3 * 86_400_000 + 5 * 3600_000); // 05:00 IST on 4 Dec
    const r = await run(back);
    expect(r.result).toMatchObject({ from: '2031-12-04', to: '2031-12-11', created: 6, existing: 10 });
    for (const d of ['2031-12-04', '2031-12-08', '2031-12-11']) expect(await Schedule.countDocuments({ date: d })).toBe(2);
  });

  it('a failing run is retried, then retried again after a cool-down (never given up for the day)', async () => {
    await JobRun.create({ job: 'daily-schedules', runKey: '2031-12-01', status: 'failed', attempts: 3, finishedAt: MIDNIGHT });
    expect((await run(new Date(MIDNIGHT.getTime() + 60_000))).reason).toBe('max_attempts');
    const later = await run(new Date(MIDNIGHT.getTime() + 31 * 60_000));
    expect(later).toMatchObject({ ran: true, status: 'succeeded' });
  });

  it('7. two scheduler instances at once: one run, no duplicate schedules', async () => {
    const results = await Promise.all([run(MIDNIGHT, { owner: 'a' }), run(MIDNIGHT, { owner: 'b' }), run(MIDNIGHT, { owner: 'c' })]);
    expect(results.filter((r) => r.ran)).toHaveLength(1);
    expect(results.filter((r) => !r.ran).map((r) => r.reason).every((x) => ['running_elsewhere', 'already_succeeded'].includes(x))).toBe(true);
    expect(await Schedule.countDocuments({})).toBe(16);
    // Even the generator itself, called concurrently for one date, cannot duplicate.
    await Promise.all([1, 2, 3].map(() => generateDailySchedules('2031-12-20', { tz: TZ, logger })));
    expect(await Schedule.countDocuments({ date: '2031-12-20' })).toBe(2);
  });
});

describe('8. generated trips and live tracking', () => {
  it('future trips stay Not Started: no position, not moved by the simulation, listed with their direction', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
    await run(new Date(), { force: true });
    const trip = await Schedule.findOne({ date: { $gt: today } }).sort({ date: 1 }).lean();
    expect(trip).toBeTruthy();
    await runSimulationTick({ config, logger, geo: fakeGeo() });
    expect((await Schedule.findById(trip._id).lean()).currentIndex).toBe(0);
    const bus = await (await import('../src/models/index.js')).Bus.findById(trip.bus).lean();
    expect(await BusLocation.exists({ scheduleId: trip.scheduleId })).toBeNull();
    const { token } = await userWithToken(t.app, 'admin');
    const loc = await request(t.app).get(`/view/get_location/${bus.busId}?schedule_id=${trip.scheduleId}`).set(bearer(token));
    expect(loc.status).toBe(404);
    const rows = await request(t.app).get(`/bus/schedules?date=${trip.date}`).set(bearer(token));
    expect(rows.body.find((r) => r.schedule_id === trip.scheduleId)).toMatchObject({ is_reached: false, direction: 'forward', status: 'on_time' });
  });

  it('return trips appear once the outbound trip has finished, exactly once', async () => {
    await run(MIDNIGHT);
    const out = await Schedule.findOne({ date: '2031-12-01', route: route2._id }).lean();
    const check = () => runReverseTripCheck({ now: MIDNIGHT, config, logger });
    expect((await check()).created).toBe(0);
    await Schedule.updateOne({ _id: out._id }, { $set: { isReached: true, status: 'arrived' } });
    expect((await check()).created).toBe(1);
    expect((await check()).created).toBe(0);
    const back = await Schedule.findOne({ date: '2031-12-01', route: route2._id, direction: 'reverse' }).lean();
    expect(back.arrivalTime - out.departureTime).toBe(4 * 3600_000 + 30 * 60_000);
    expect(back).toMatchObject({ currentIndex: 0, isReached: false, status: 'on_time' });
  });
});
