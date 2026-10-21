import { Bus, Route, Schedule } from '../models/index.js';
import { recordLocation } from '../services/locations.js';
import { addDays, todayInTz } from '../utils/time.js';

// Statuses an operator sets deliberately; the simulation must not replace them with "running".
const KEEP_WHILE_RUNNING = ['delayed'];
export const COMPLETED = 'arrived'; // existing completion status (on time or early)
export const DELAYED_COMPLETED = 'delayed_completed'; // reached the destination after the scheduled arrival
const CANCELLED = /cancel/i;

// Legacy field naming: `arrivalTime` is when a trip STARTS and `departureTime` its scheduled END
// (see utils/trips.js in the app).
//
// Which trips move on a tick (evaluated against the simulation clock `now`, not wall time):
//  - not cancelled, not reached, with a usable route/bus and start < end;
//  - not yet started (currentIndex 0): only inside its scheduled window start <= now < end.
//    A trip whose window has passed never starts (it is not run hours late);
//  - already under way: keeps going after its scheduled end and completes late;
//  - one trip per bus at a time (the earliest started), buses independent of each other;
//  - selected by time, not by calendar date, so a trip running across midnight continues.
// Completion: when the last route point is recorded the trip is reached exactly once (compare-
// and-set on currentIndex), arrivedAt is stored, and the status becomes "arrived" or, if now is
// after the scheduled end, "delayed_completed". Nothing is recorded for a reached trip again.
//
// Other fixes kept from the port of website/UpdateLocaionSchedular.py: progress survives
// restarts, geometry is [lng, lat], reverse trips run end -> start, two workers can't double-step.
export async function eligibleTrips(now, config) {
  const today = todayInTz(config.APP_TIMEZONE, now);
  const candidates = await Schedule.find({
    date: { $in: [addDays(today, -1), today] },
    isReached: false,
    arrivalTime: { $lte: now },
    $or: [{ currentIndex: { $gt: 0 } }, { departureTime: { $gt: now } }],
  })
    .sort({ arrivalTime: 1 })
    .limit(500)
    .lean();
  return candidates.filter((t) => !CANCELLED.test(t.status || '') && t.arrivalTime < t.departureTime);
}

export async function runSimulationTick({ now = new Date(), config, logger, geo }) {
  const trips = await eligibleTrips(now, config);
  if (!trips.length) return { moved: 0, completed: 0, delayedCompleted: 0, failed: 0, lastError: null };

  const routes = new Map((await Route.find({ _id: { $in: trips.map((t) => t.route) } }).lean()).map((r) => [String(r._id), r]));
  const buses = new Map((await Bus.find({ _id: { $in: trips.map((t) => t.bus) } }).lean()).map((b) => [String(b._id), b]));

  let moved = 0;
  let completed = 0;
  let delayedCompleted = 0;
  let failed = 0;
  let lastError = null;
  // A bus can only be on one trip at a time. When trips of the same bus overlap, only the
  // earliest-started unfinished one moves; the next starts once it has arrived (if its own
  // window is still open).
  const busyBuses = new Set();
  for (const trip of trips) {
    const route = routes.get(String(trip.route));
    const bus = buses.get(String(trip.bus));
    if (!route || !bus) {
      logger.warn({ scheduleId: trip.scheduleId }, 'Trip has no route or bus; not simulated');
      continue;
    }
    if (busyBuses.has(String(bus._id))) continue;
    busyBuses.add(String(bus._id));

    try {
      const [startLng, startLat] = route.start.coordinates;
      const [endLng, endLat] = route.end.coordinates;
      const geometry = await geo.getRouteGeometry({ lat: startLat, lng: startLng }, { lat: endLat, lng: endLng });
      const coords = trip.direction === 'reverse' ? [...geometry.coordinates].reverse() : geometry.coordinates;
      const late = now > trip.departureTime;
      const finalStatus = late ? DELAYED_COMPLETED : COMPLETED;

      const idx = trip.currentIndex || 0;
      if (idx >= coords.length) {
        // Geometry got shorter since the trip started: it is already at (or past) the end.
        const res = await Schedule.updateOne({ _id: trip._id, isReached: false }, { $set: { isReached: true, status: finalStatus, arrivedAt: now } });
        if (res.modifiedCount) {
          completed += 1;
          if (late) delayedCompleted += 1;
        }
        continue;
      }

      const nextIndex = idx + 1;
      const isReached = nextIndex >= coords.length;
      // While moving, "running" replaces only the default/initial status, so a status set on
      // purpose ("delayed") is kept until arrival.
      const status = isReached
        ? finalStatus
        : { $cond: [{ $in: [{ $ifNull: ['$status', 'on_time'] }, KEEP_WHILE_RUNNING] }, '$status', 'running'] };
      const advanced = await Schedule.findOneAndUpdate(
        { _id: trip._id, currentIndex: idx, isReached: false },
        [{ $set: { currentIndex: nextIndex, isReached, status, ...(isReached ? { arrivedAt: now } : {}) } }],
        { new: true },
      ).lean();
      if (!advanced) continue; // another worker already advanced (or completed) this trip

      const [lng, lat] = coords[idx];
      await recordLocation({ bus, lat, lng, recordedAt: now, source: 'simulation', schedule: trip, now }, config).catch((err) => {
        // An out-of-order rejection means a fresher (e.g. device) position exists; keep it.
        logger.debug({ err: { message: err.message }, busId: bus.busId, scheduleId: trip.scheduleId }, 'Simulated location not recorded');
      });
      moved += 1;
      if (isReached) {
        completed += 1;
        if (late) delayedCompleted += 1;
        logger.info({ busId: bus.busId, scheduleId: trip.scheduleId, status: finalStatus, arrivedAt: now.toISOString() }, 'Simulated trip reached its destination');
      }
    } catch (err) {
      // One trip failing never stops the others; the error is logged with its bus and trip.
      failed += 1;
      lastError = { message: err.message, busId: bus.busId, scheduleId: trip.scheduleId };
      logger.warn({ err: { message: err.message }, busId: bus.busId, scheduleId: trip.scheduleId, operation: 'simulation-step' }, 'Simulation step failed');
    }
  }
  return { moved, completed, delayedCompleted, failed, lastError };
}
