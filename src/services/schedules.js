import { Bus, Route, Schedule, User, nextSeq } from '../models/index.js';
import { wallTimeToDate } from '../utils/time.js';
import { isValidLat, isValidLng } from './geo.js';

// Business rules ported from website/BusSchedular.py (unchanged):
//  - buses and drivers are paired in order (zip); route i gets pair i, extra routes are skipped;
//  - the first trip starts at 07:00 (app timezone) + i * 30 minutes;
//  - arrival_time = start + 30 min, departure_time = arrival + 5 min;
//  - status "on_time", current_index 0, is_reached false;
//  - a reverse trip (start = forward departure + 4 h) is created once the forward trip has
//    been reached (see createReverseTrips: checked continuously, not only at generation time).
// Added safety checks: routes with unusable coordinates are skipped, and a trip is not created
// when its bus or driver already has an overlapping trip that day (e.g. a manual schedule).
export const TRIP_MINUTES = 30;
export const DWELL_MINUTES = 5;
export const REVERSE_GAP_HOURS = 4;
export const FIRST_TRIP_HOUR = 7;
export const TRIP_SPACING_MINUTES = 30;

const addMinutes = (d, m) => new Date(d.getTime() + m * 60_000);

const validPoint = (p) => {
  const c = p?.coordinates;
  return Array.isArray(c) && isValidLng(c[0]) && isValidLat(c[1]) && !(c[0] === 0 && c[1] === 0);
};

// Another trip of the same bus or driver that overlaps [from, to) on this date.
async function findConflict({ date, bus, driver, from, to, exclude }) {
  return Schedule.findOne({
    date,
    $or: [{ bus: bus._id }, { driver: driver._id }],
    arrivalTime: { $lt: to },
    departureTime: { $gt: from },
    ...(exclude ? { _id: { $ne: exclude } } : {}),
  }).lean();
}

// Inserts a trip unless one already exists for (date, route, bus, departureTime) — the unique
// index on schedules makes this safe to call repeatedly and concurrently.
// Returns { schedule, created, conflict }.
async function upsertTrip({ route, bus, driver, startTime, date, direction }) {
  const arrivalTime = addMinutes(startTime, TRIP_MINUTES);
  const departureTime = addMinutes(arrivalTime, DWELL_MINUTES);
  const filter = { date, route: route._id, bus: bus._id, departureTime };

  const existing = await Schedule.findOne(filter).lean();
  if (existing) return { schedule: existing, created: false };
  const conflict = await findConflict({ date, bus, driver, from: arrivalTime, to: departureTime });
  if (conflict) return { schedule: null, created: false, conflict };
  try {
    const schedule = await Schedule.create({
      ...filter,
      scheduleId: await nextSeq('schedules'),
      driver: driver._id,
      arrivalTime,
      status: 'on_time',
      currentIndex: 0,
      isReached: false,
      direction,
    });
    return { schedule: schedule.toObject(), created: true };
  } catch (err) {
    if (err.code === 11000) return { schedule: await Schedule.findOne(filter).lean(), created: false };
    throw err;
  }
}

async function loadFleet() {
  const [routes, buses, drivers] = await Promise.all([
    Route.find().sort({ routeId: 1 }).lean(),
    Bus.find().sort({ busId: 1 }).lean(),
    User.find({ roleKey: 'driver' }).sort({ createdAt: 1, _id: 1 }).lean(),
  ]);
  return { routes, buses, drivers, pairs: buses.slice(0, Math.min(buses.length, drivers.length)).map((bus, i) => [bus, drivers[i]]) };
}

// Forward trips for one service date. Idempotent: existing trips are counted, never changed.
export async function generateDailySchedules(date, { tz, logger }) {
  const { routes, buses, drivers, pairs } = await loadFleet();
  const summary = { date, routes: routes.length, buses: buses.length, drivers: drivers.length, created: 0, existing: 0, reverseCreated: 0, conflicts: 0, invalidRoutes: 0, unassignedRoutes: 0 };

  if (!routes.length || !buses.length || !drivers.length) {
    logger.warn(summary, 'Missing routes/buses/drivers; skipping schedule generation');
    return { ...summary, skipped: true };
  }

  for (let i = 0; i < routes.length; i += 1) {
    if (i >= pairs.length) {
      summary.unassignedRoutes = routes.length - i;
      logger.info({ date, routeIds: routes.slice(i).map((r) => r.routeId) }, 'No more bus/driver pairs available');
      break;
    }
    const route = routes[i];
    if (!validPoint(route.start) || !validPoint(route.end)) {
      summary.invalidRoutes += 1;
      logger.warn({ date, routeId: route.routeId }, 'Route has unusable coordinates; no trip generated');
      continue;
    }
    const [bus, driver] = pairs[i];
    const startTime = addMinutes(wallTimeToDate(date, FIRST_TRIP_HOUR, 0, tz), i * TRIP_SPACING_MINUTES);
    const forward = await upsertTrip({ route, bus, driver, startTime, date, direction: 'forward' });
    if (forward.conflict) {
      summary.conflicts += 1;
      logger.warn({ date, routeId: route.routeId, busId: bus.busId, conflictWith: forward.conflict.scheduleId }, 'Bus or driver already booked at that time; trip not generated');
      continue;
    }
    summary[forward.created ? 'created' : 'existing'] += 1;
  }
  summary.reverseCreated = (await createReverseTrips(date, { tz, logger, fleet: { routes, pairs } })).created;
  logger.info(summary, 'Daily schedules generated');
  return summary;
}

// Reverse trips for a date whose latest forward trip (per route and paired bus) has been
// reached. Cheap and idempotent, so the worker runs it every check: the return trip appears
// as soon as the outbound trip finishes, not only if it had finished when the job ran.
export async function createReverseTrips(date, { logger, fleet } = {}) {
  const { routes, pairs } = fleet || (await loadFleet());
  let created = 0;
  for (let i = 0; i < routes.length && i < pairs.length; i += 1) {
    const route = routes[i];
    const [bus, driver] = pairs[i];
    const latestForward = await Schedule.findOne({ route: route._id, bus: bus._id, date, direction: 'forward' }).sort({ departureTime: -1 }).lean();
    if (!latestForward?.isReached) continue;
    const reverseStart = addMinutes(latestForward.departureTime, REVERSE_GAP_HOURS * 60);
    const reverse = await upsertTrip({ route, bus, driver, startTime: reverseStart, date, direction: 'reverse' });
    if (reverse.created) created += 1;
    else if (reverse.conflict) logger?.warn({ date, routeId: route.routeId, busId: bus.busId, conflictWith: reverse.conflict.scheduleId }, 'Return trip not generated: bus or driver already booked');
  }
  return { created };
}
