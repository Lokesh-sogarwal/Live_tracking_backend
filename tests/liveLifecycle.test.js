import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { io as connect } from 'socket.io-client';
import { BusLocation, Schedule, WorkerStatus, nextSeq } from '../src/models/index.js';
import { runSimulationTick } from '../src/jobs/simulationJob.js';
import { startLoop } from '../src/jobs/loop.js';
import { recordHeartbeat, recordSimulationTick } from '../src/services/workerStatus.js';
import { setIo } from '../src/services/realtime.js';
import { lastEmittedAt } from '../src/services/locationRelay.js';
import { recordLocation } from '../src/services/locations.js';
import { createLogger } from '../src/config/logger.js';
import { todayInTz } from '../src/utils/time.js';
import { bearer, createBus, createRoute, createUser, fakeGeo, setupTestApp, startRealtime, userWithToken } from './helpers.js';

const logger = createLogger('silent');
const pause = (ms = 8) => new Promise((r) => setTimeout(r, ms));
let t;
let token;
beforeAll(async () => {
  t = await setupTestApp('live_lifecycle');
  ({ token } = await userWithToken(t.app, 'admin'));
});
afterAll(() => t.close());

const trip = async (over = {}) => {
  const route = over.route ?? (await createRoute());
  const bus = over.bus ?? (await createBus());
  const driver = await createUser('driver');
  const s = await Schedule.create({
    scheduleId: await nextSeq('schedules'), route: route._id, bus: bus._id, driver: driver._id,
    date: todayInTz(t.config.APP_TIMEZONE), arrivalTime: new Date(Date.now() - 60_000), departureTime: new Date(Date.now() + 3600_000),
  });
  return { route, bus, trip: s };
};
const status = () => request(t.app).get('/view/tracking_status').set(bearer(token));

describe('worker loop', () => {
  it('backs off exponentially with jitter on consecutive failures and resets after a success', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let failNext = 3;
      const errors = [];
      const loop = startLoop(
        async () => {
          calls += 1;
          if (failNext > 0) {
            failNext -= 1;
            throw new Error('db down');
          }
        },
        1000,
        { onError: (_e, info) => errors.push(info), random: () => 0.5, maxBackoffMs: 60_000 },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(errors.map((e) => e.retryInMs)).toEqual([2000]);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);
      expect(errors.map((e) => e.retryInMs)).toEqual([2000, 4000, 8000]);
      await vi.advanceTimersByTimeAsync(8000); // success
      expect(loop.failures).toBe(0);
      const before = calls;
      await vi.advanceTimersByTimeAsync(1000); // back to the normal interval
      expect(calls).toBe(before + 1);
      loop.stop();
      expect(loop.pending).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toBe(before + 1); // a stopped loop leaves no timer behind
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the back-off', async () => {
    vi.useFakeTimers();
    try {
      const delays = [];
      const loop = startLoop(async () => { throw new Error('x'); }, 1000, { onError: (_e, i) => delays.push(i.retryInMs), random: () => 1, maxBackoffMs: 5000 });
      for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(10_000);
      loop.stop();
      expect(Math.max(...delays)).toBe(6000); // 5000 cap + 20 % jitter
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('simulation progress and errors', () => {
  it('a bus starts moving and its location timestamp advances', async () => {
    const { bus } = await trip();
    await runSimulationTick({ config: t.config, logger, geo: fakeGeo() });
    const first = await BusLocation.findOne({ busId: bus.busId }).lean();
    await pause(20);
    await runSimulationTick({ config: t.config, logger, geo: fakeGeo() });
    const second = await BusLocation.findOne({ busId: bus.busId }).lean();
    expect(second.recordedAt.getTime()).toBeGreaterThan(first.recordedAt.getTime());
    expect(second.location.coordinates).not.toEqual(first.location.coordinates);
  });

  it('one failing trip is reported with its bus and trip, and the other buses keep moving', async () => {
    const ok = await trip();
    const brokenRoute = await createRoute({ routeName: 'Broken', start: { type: 'Point', coordinates: [77.6, 28.6] } });
    const bad = await trip({ route: brokenRoute });
    const geo = fakeGeo({
      getRouteGeometry: async (s, e) => (s.lng === 77.6 ? Promise.reject(new Error('geometry unavailable')) : fakeGeo().getRouteGeometry(s, e)),
    });
    const result = await runSimulationTick({ config: t.config, logger, geo });
    expect(result.failed).toBe(1);
    expect(result.lastError).toEqual({ message: 'geometry unavailable', busId: bad.bus.busId, scheduleId: bad.trip.scheduleId });
    expect((await Schedule.findById(ok.trip._id).lean()).currentIndex).toBeGreaterThan(0);
    expect((await Schedule.findById(bad.trip._id).lean()).currentIndex).toBe(0);
    await recordSimulationTick(result);
    const s = await status();
    expect(s.body.last_error).toMatchObject({ job: 'simulation', message: 'geometry unavailable', bus_id: bad.bus.busId, schedule_id: bad.trip.scheduleId });
  });
});

describe('GET /view/tracking_status', () => {
  it('reports a stopped worker distinctly from a running one, and simulation on/off', async () => {
    await WorkerStatus.deleteMany({});
    let s = await status();
    expect(s.status).toBe(200);
    expect(s.body.worker.running).toBe(false);
    expect(s.body.simulation.enabled).toBeNull();

    await recordHeartbeat({ instance: 'test', startedAt: new Date(), simulationEnabled: false, simulationTickMs: null });
    s = await status();
    expect(s.body).toMatchObject({ worker: { running: true }, simulation: { enabled: false } });

    await recordHeartbeat({ instance: 'test', startedAt: new Date(), simulationEnabled: true, simulationTickMs: 2000 }, new Date(Date.now() - 60_000));
    s = await status();
    expect(s.body.worker.running).toBe(false); // heartbeat older than 45 s
    expect(JSON.stringify(s.body)).not.toMatch(/local|hostname|MONGODB|password/i);
  });

  it('needs a signed-in user with tracking access', async () => {
    expect((await request(t.app).get('/view/tracking_status')).status).toBe(401);
  });
});

describe('Socket.IO reconnection', () => {
  it('a client that disconnects and reconnects gets the current position and then live updates again', async () => {
    const { bus, trip: running } = await trip();
    const rt = await startRealtime(t.app, t.ctx);
    const open = () => connect(rt.url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    const nextEvent = (s, ms = 4000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no bus:location')), ms);
        s.once('bus:location', (p) => {
          clearTimeout(timer);
          resolve(p);
        });
      });
    try {
      await runSimulationTick({ config: t.config, logger, geo: fakeGeo() });
      let s = open();
      s.on('connect', () => s.emit('bus:subscribe', { busId: bus.busId }));
      const snapshot = await nextEvent(s);
      expect(snapshot.schedule_id).toBe(running.scheduleId);
      s.disconnect();

      // While disconnected the bus keeps moving.
      await pause(20);
      await runSimulationTick({ config: t.config, logger, geo: fakeGeo() });
      const moved = await BusLocation.findOne({ busId: bus.busId }).lean();

      s = open();
      const listeners = [];
      s.on('connect', () => s.emit('bus:subscribe', { busId: bus.busId }));
      const afterReconnect = await nextEvent(s);
      expect(new Date(afterReconnect.timestamp).getTime()).toBe(moved.recordedAt.getTime());

      // And live updates resume (relay from the worker-like process).
      setIo(null);
      s.on('bus:location', (p) => listeners.push(p));
      await pause(20);
      await runSimulationTick({ config: t.config, logger, geo: fakeGeo() });
      await vi.waitFor(() => expect(listeners.length).toBeGreaterThanOrEqual(1), { timeout: 4000, interval: 100 });
      expect(listeners.every((p) => p.schedule_id === running.scheduleId)).toBe(true);
      s.disconnect();
    } finally {
      await rt.stop();
    }
  });
});

describe('no duplicate position events', () => {
  it('in the API process a position is marked as delivered before it is written, so the relay cannot resend it', async () => {
    const bus = await createBus();
    const rt = await startRealtime(t.app, t.ctx); // registers Socket.IO in this process, like the API
    const at = new Date();
    const markedWhenWritten = [];
    const original = BusLocation.findOneAndUpdate.bind(BusLocation);
    const spy = vi.spyOn(BusLocation, 'findOneAndUpdate').mockImplementation((...args) => {
      markedWhenWritten.push(lastEmittedAt(bus.busId));
      return original(...args);
    });
    try {
      await recordLocation({ bus, lat: 28.5, lng: 77.3, recordedAt: at, source: 'admin' }, t.config);
      expect(markedWhenWritten).toEqual([at.getTime()]);
    } finally {
      spy.mockRestore();
      await rt.stop();
    }
  });

  it('a process without Socket.IO (the worker) does not mark positions, so the relay delivers them', async () => {
    setIo(null);
    const bus = await createBus();
    await recordLocation({ bus, lat: 28.5, lng: 77.3, recordedAt: new Date(), source: 'simulation' }, t.config);
    expect(lastEmittedAt(bus.busId)).toBeUndefined();
  });
});
