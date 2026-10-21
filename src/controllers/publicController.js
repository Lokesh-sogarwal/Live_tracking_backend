import { z } from 'zod';
import { Route, Schedule, Stop } from '../models/index.js';
import { addDays, formatHHMM, isValidDateString, todayInTz } from '../utils/time.js';
import { badRequest } from '../utils/errors.js';

// Explicitly public data for logged-out visitors: route names, stops and the timetable.
// Never drivers, user IDs, documents or anything administrative.
export const schemas = {
  routesQuery: z.object({ q: z.string().trim().max(100).optional() }),
  departuresQuery: z.object({
    date: z.string().optional(),
    q: z.string().trim().max(100).optional(),
  }),
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createPublicController(ctx) {
  const tz = ctx.config.APP_TIMEZONE;

  return {
    async routes(req, res) {
      const q = req.validatedQuery.q;
      const filter = q ? { $or: ['routeName', 'startPoint', 'endPoint'].map((f) => ({ [f]: new RegExp(escape(q), 'i') })) } : {};
      const routes = await Route.find(filter).sort({ routeName: 1 }).limit(200).lean();
      const stops = await Stop.find({ route: { $in: routes.map((r) => r._id) } }).sort({ route: 1, sequence: 1 }).lean();
      const byRoute = stops.reduce((m, s) => m.set(String(s.route), [...(m.get(String(s.route)) ?? []), s.name]), new Map());
      res.json(
        routes.map((r) => ({
          route_id: r.routeId,
          route_name: r.routeName,
          start_point: r.startPoint,
          end_point: r.endPoint,
          stops: byRoute.get(String(r._id)) ?? [],
        })),
      );
    },

    // Timetable for one day, today up to a week ahead.
    async departures(req, res) {
      const today = todayInTz(tz);
      const date = req.validatedQuery.date || today;
      if (!isValidDateString(date)) throw badRequest('Use a date like 2026-10-21');
      if (date < today || date > addDays(today, 7)) throw badRequest('Choose a date between today and 7 days from now');

      const schedules = await Schedule.find({ date }).sort({ arrivalTime: 1 }).limit(500).populate('route').populate('bus', 'busNumber').lean();
      const q = req.validatedQuery.q?.toLowerCase();
      const now = new Date();
      const rows = schedules
        .filter((s) => s.route && s.bus)
        .map((s) => ({
          schedule_id: s.scheduleId,
          route_id: s.route.routeId,
          route_name: s.route.routeName,
          // Reverse trips run the route backwards.
          start_point: s.direction === 'reverse' ? s.route.endPoint : s.route.startPoint,
          end_point: s.direction === 'reverse' ? s.route.startPoint : s.route.endPoint,
          bus_number: s.bus.busNumber,
          date: s.date,
          // Legacy naming is inverted: arrivalTime is when the trip starts (the simulation and
          // the dashboard's utils/trips.js both treat it so) and departureTime when it ends.
          start_time: formatHHMM(s.arrivalTime, tz),
          end_time: formatHHMM(s.departureTime, tz),
          status: s.isReached
            ? s.status === 'delayed_completed'
              ? 'completed_late'
              : 'completed'
            : /cancel/i.test(s.status || '')
              ? 'cancelled'
              : /delay/i.test(s.status || '')
                ? 'delayed'
                : (s.currentIndex || 0) > 0
                  ? 'running' // actually under way
                  : s.departureTime <= now
                    ? 'missed' // window passed without departing; it is not started late
                    : 'scheduled',
        }))
        .filter((r) => !q || [r.route_name, r.start_point, r.end_point, r.bus_number].some((v) => (v || '').toLowerCase().includes(q)));
      res.json({ date, today, departures: rows });
    },
  };
}
