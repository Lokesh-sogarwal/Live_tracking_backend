import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { io as connect } from 'socket.io-client';
import { BusLocation, Route, Schedule, nextSeq } from '../src/models/index.js';
import { runSimulationTick } from '../src/jobs/simulationJob.js';
import { setIo } from '../src/services/realtime.js';
import { createLogger } from '../src/config/logger.js';
import { todayInTz } from '../src/utils/time.js';
import { bearer, createBus, createRoute, createUser, fakeGeo, setupTestApp, startRealtime, userWithToken } from './helpers.js';

// SIM-01: positions written by another process (the simulation worker) must reach
// Socket.IO subscribers. Before the relay, the worker's emit was a no-op and clients got nothing.
let t;
let rt;
let admin;
let viewer;
const sockets = [];

const open = (token) =>
  new Promise((resolve, reject) => {
    const s = connect(rt.url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
const ack = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const collect = (s, ms) =>
  new Promise((resolve) => {
    const got = [];
    const h = (p) => got.push(p);
    s.on('bus:location', h);
    setTimeout(() => {
      s.off('bus:location', h);
      resolve(got);
    }, ms);
  });
const writeAsOtherProcess = (bus, lng, lat) =>
  BusLocation.findOneAndUpdate(
    { busId: bus.busId },
    { $set: { bus: bus._id, busId: bus.busId, location: { type: 'Point', coordinates: [lng, lat] }, recordedAt: new Date(), source: 'simulation' } },
    { upsert: true, new: true },
  );

beforeAll(async () => {
  t = await setupTestApp('relay', { LOCATION_RELAY_MS: '100' });
  rt = await startRealtime(t.app, t.ctx);
  admin = await userWithToken(t.app, 'admin');
  viewer = await userWithToken(t.app, 'passenger');
});
afterAll(async () => {
  sockets.forEach((s) => s.disconnect());
  await rt.stop();
  await t.close();
});

describe('location relay', () => {
  it('delivers positions written by another process, in order, as [lat,lng] fields', async () => {
    const bus = await createBus();
    const s = await open(viewer.token);
    expect(await ack(s, 'bus:subscribe', { busId: bus.busId })).toEqual({ ok: true });
    const got = collect(s, 900);
    await writeAsOtherProcess(bus, 77.21, 28.63);
    await new Promise((r) => setTimeout(r, 250));
    await writeAsOtherProcess(bus, 77.22, 28.62);
    const events = await got;
    expect(events.map((e) => [e.latitude, e.longitude])).toEqual([[28.63, 77.21], [28.62, 77.22]]);
    expect(events.every((e) => e.bus_id === bus.busId && e.source === 'simulation' && e.is_stale === false)).toBe(true);
  });

  it('delivers API-ingested positions exactly once (no relay duplicate)', async () => {
    const bus = await createBus();
    const s = await open(viewer.token);
    await ack(s, 'bus:subscribe', { busId: bus.busId });
    const got = collect(s, 700);
    await request(t.app).post('/view/update_location').set(bearer(admin.token)).send({ bus_id: bus.busId, latitude: 12.97, longitude: 77.59 });
    expect((await got).length).toBe(1);
  });

  it('sends nothing to unsubscribed sockets; on subscribe sends the current position exactly once', async () => {
    const bus = await createBus();
    const s = await open(viewer.token);
    await writeAsOtherProcess(bus, 77.0, 28.0); // before this socket subscribed
    const unsubscribed = await collect(s, 400);
    expect(unsubscribed).toEqual([]);
    const afterSubscribe = collect(s, 600);
    await ack(s, 'bus:subscribe', { busId: bus.busId });
    const events = await afterSubscribe;
    expect(events.map((e) => [e.latitude, e.longitude])).toEqual([[28, 77]]);
  });

  it('end to end: simulation ticks in a process without Socket.IO reach subscribers', async () => {
    setIo(null); // this "worker" process has no Socket.IO server, like src/worker.js
    try {
      const route = await createRoute();
      const bus = await createBus();
      const driver = await createUser('driver');
      await Schedule.create({
        scheduleId: await nextSeq('schedules'), route: route._id, bus: bus._id, driver: driver._id,
        date: todayInTz('Asia/Kolkata'), arrivalTime: new Date(Date.now() - 60_000), departureTime: new Date(Date.now() + 60_000),
      });
      expect(await Route.countDocuments({ _id: route._id })).toBe(1);
      const s = await open(viewer.token);
      await ack(s, 'bus:subscribe', { busId: bus.busId });
      // One stored position per bus and a 1 s relay poll: space the ticks beyond the poll
      // interval so each position is a separate event even on a loaded machine.
      const got = collect(s, 4200);
      const logger = createLogger('silent');
      for (let i = 0; i < 3; i += 1) {
        await runSimulationTick({ config: t.config, logger, geo: fakeGeo() });
        await new Promise((r) => setTimeout(r, 1150));
      }
      const events = await got;
      const expected = [[77.5113, 28.4646], [77.3563, 28.4926], [77.2013, 28.5206]];
      expect(events).toHaveLength(3);
      events.forEach((e, i) => {
        expect(e.longitude).toBeCloseTo(expected[i][0], 6);
        expect(e.latitude).toBeCloseTo(expected[i][1], 6);
        expect(e.source).toBe('simulation');
      });
    } finally {
      // Last test in the file; the relay uses its own io reference, so nothing else depends on the global.
    }
  });
});
