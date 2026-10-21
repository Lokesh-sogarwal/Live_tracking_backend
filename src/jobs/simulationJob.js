import { Bus, Route, Schedule } from '../models/index.js';
import { recordLocation } from '../services/locations.js';
import { todayInTz } from '../utils/time.js';

// Statuses an operator sets deliberately; the simulation must not replace them with "running".
const KEEP_WHILE_RUNNING = ['delayed', 'cancelled'];

// Port of website/UpdateLocaionSchedular.py move_bus(): every tick, each of today's
// started, unfinished trips moves one vertex along its route geometry.
//
// Fixes relative to the legacy job (see docs/MAJOR_BUGS.md):
//  - progress is never reset on restart (legacy zeroed current_index for all of today's trips at boot);
//  - geometry is always [lng, lat]; the legacy fallback path swapped lat/lng;
//  - trips generated after boot are picked up (legacy only scheduled trips present at boot);
//  - each advance is a compare-and-set on current_index, so two workers cannot double-step a trip;
//  - reverse trips traverse the geometry end -> start.
export async function runSimulationTick({ now = new Date(), config, logger, geo }) {
  const date = todayInTz(config.APP_TIMEZONE, now);
  const trips = await Schedule.find({ date, isReached: false, arrivalTime: { $lte: now } })
    .sort({ arrivalTime: 1 })
    .limit(500)
    .lean();
  if (!trips.length) return { moved: 0, completed: 0 };

  const routes = new Map((await Route.find({ _id: { $in: trips.map((t) => t.route) } }).lean()).map((r) => [String(r._id), r]));
  const buses = new Map((await Bus.find({ _id: { $in: trips.map((t) => t.bus) } }).lean()).map((b) => [String(b._id), b]));

  let moved = 0;
  let completed = 0;
  // A bus can only be on one trip at a time. When trips of the same bus overlap, only the
  // earliest-started unfinished one moves; the next starts once it has arrived. Otherwise the
  // bus's single position alternated between trips (and routes) on every tick.
  const busyBuses = new Set();
  for (const trip of trips) {
    const route = routes.get(String(trip.route));
    const bus = buses.get(String(trip.bus));
    if (!route || !bus) continue;
    if (busyBuses.has(String(bus._id))) continue;
    busyBuses.add(String(bus._id));

    try {
      const [startLng, startLat] = route.start.coordinates;
      const [endLng, endLat] = route.end.coordinates;
      const geometry = await geo.getRouteGeometry({ lat: startLat, lng: startLng }, { lat: endLat, lng: endLng });
      const coords = trip.direction === 'reverse' ? [...geometry.coordinates].reverse() : geometry.coordinates;

      const idx = trip.currentIndex || 0;
      if (idx >= coords.length) {
        const res = await Schedule.updateOne({ _id: trip._id, isReached: false }, { $set: { isReached: true, status: 'arrived' } });
        completed += res.modifiedCount;
        continue;
      }

      const nextIndex = idx + 1;
      const isReached = nextIndex >= coords.length;
      // Status: "arrived" on completion (the terminal status legacy move_bus() checked for but
      // never set). While moving, "running" replaces only the default/initial status, so a
      // status set on purpose (e.g. "delayed") is not overwritten by the simulation.
      const status = isReached
        ? 'arrived'
        : { $cond: [{ $in: [{ $ifNull: ['$status', 'on_time'] }, KEEP_WHILE_RUNNING] }, '$status', 'running'] };
      const advanced = await Schedule.findOneAndUpdate(
        { _id: trip._id, currentIndex: idx, isReached: false },
        [{ $set: { currentIndex: nextIndex, isReached, status } }],
        { new: true },
      ).lean();
      if (!advanced) continue; // another worker already advanced this trip

      const [lng, lat] = coords[idx];
      await recordLocation({ bus, lat, lng, recordedAt: now, source: 'simulation', schedule: trip }, config).catch((err) => {
        // An out-of-order rejection means a fresher (e.g. device) position exists; keep it.
        logger.debug({ err: { message: err.message }, busId: bus.busId }, 'Simulated location not recorded');
      });
      moved += 1;
      if (isReached) completed += 1;
    } catch (err) {
      logger.warn({ err: { message: err.message }, scheduleId: trip.scheduleId }, 'Simulation step failed');
    }
  }
  return { moved, completed };
}
