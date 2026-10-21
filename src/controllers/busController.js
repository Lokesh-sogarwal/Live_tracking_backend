import { z } from 'zod';
import { Bus, Route, Schedule, Stop, User, nextSeq } from '../models/index.js';
import { withTransaction } from '../db.js';
import { notifyAdmins } from '../services/notifications.js';
import { isValidLat, isValidLng } from '../services/geo.js';
import { escapeRegex, parsePagination } from '../utils/pagination.js';
import { addDays, formatHHMM, formatLegacy, isValidDateString, todayInTz, wallTimeToDate } from '../utils/time.js';
import { badRequest, conflict, notFound, upstreamError } from '../utils/errors.js';
import { lifecycleFields } from '../services/tripLifecycle.js';

const place = z.string().trim().min(1).max(300);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

export const schemas = {
  busRoute: z.object({
    route_name: z.string({ required_error: 'Kindly fill all the details' }).trim().min(1, 'Kindly fill all the details').max(100),
    starting: place,
    destination: place,
    stops: z.array(z.string().trim().max(300)).max(25).optional().default([]),
  }),
  searchRoutes: z
    .object({ starting_point: z.string().max(300).nullish(), destination: z.string().max(300).nullish() })
    .refine((b) => b.starting_point?.trim() || b.destination?.trim(), 'Kindly provide starting and/or destination'),
  geocode: z.object({ address: z.string({ required_error: 'Address required' }).trim().min(1, 'Address required').max(300) }),
  schedulesQuery: z.object({
    date: z.string().refine(isValidDateString, 'Invalid date format, use YYYY-MM-DD').optional(),
    include_route_details: z.string().optional(),
    limit: z.string().optional(),
    page: z.string().optional(),
  }),
  registerBus: z.object({
    bus_number: z.string().trim().min(1, 'bus_number is required').max(50),
    capacity: z.coerce.number().int().min(0).max(1000).optional(),
    bus_capacity: z.coerce.number().int().min(0).max(1000).optional(),
    operator: z.string().trim().max(150).optional(),
    bus_type: z.string().trim().max(50).optional(),
  }),
  createSchedule: z.object({
    route_id: z.coerce.number().int().positive(),
    bus_id: z.coerce.number().int().positive(),
    driver_uuid: z.string().uuid(),
    date: z.string().refine(isValidDateString, 'Invalid date format, use YYYY-MM-DD'),
    arrival_time: hhmm,
    departure_time: hhmm,
    status: z.string().trim().max(50).optional(),
  }),
};

const latLng = (point) => ({ lat: point.coordinates[1], lng: point.coordinates[0] });

export const serializeBus = (b) => ({
  bus_id: b.busId,
  bus_number: b.busNumber,
  capacity: b.capacity ?? null,
  operator: b.operator ?? null,
  bus_type: b.busType ?? null,
});

const routeFields = (r) => {
  const s = latLng(r.start);
  const e = latLng(r.end);
  return {
    route_id: r.routeId,
    route_name: r.routeName,
    start_point: r.startPoint,
    end_point: r.endPoint,
    start_lat: s.lat,
    start_lng: s.lng,
    end_lat: e.lat,
    end_lng: e.lng,
  };
};
export { routeFields };

export function createBusController(ctx) {
  const { config, geo } = ctx;
  const tz = config.APP_TIMEZONE;

  return {
    async createRoute(req, res) {
      const { route_name, starting, destination, stops } = req.body;
      const start = await geo.geocodePlace(starting);
      const end = await geo.geocodePlace(destination);
      if (!start || !end) throw badRequest('Unable to geocode start or end point');

      // Legacy behaviour: stops that cannot be geocoded are skipped, not fatal.
      const geocodedStops = [];
      const skipped = [];
      for (const name of stops.filter(Boolean)) {
        const loc = await geo.geocodePlace(name);
        if (loc) geocodedStops.push({ name, ...loc });
        else skipped.push(name);
      }

      const { route, createdStops } = await withTransaction(async (session) => {
        const [route] = await Route.create(
          [
            {
              routeId: await nextSeq('routes', session),
              routeName: route_name,
              startPoint: starting,
              start: { type: 'Point', coordinates: [start.lng, start.lat] },
              endPoint: destination,
              end: { type: 'Point', coordinates: [end.lng, end.lat] },
            },
          ],
          { session },
        );
        const createdStops = [];
        for (let i = 0; i < geocodedStops.length; i += 1) {
          const s = geocodedStops[i];
          const [stop] = await Stop.create(
            [{ stopId: await nextSeq('stops', session), route: route._id, name: s.name, location: { type: 'Point', coordinates: [s.lng, s.lat] }, sequence: i + 1 }],
            { session },
          );
          createdStops.push({ stop_id: stop.stopId, stop_name: s.name, latitude: s.lat, longitude: s.lng, sequence: i + 1 });
        }
        return { route, createdStops };
      });

      await notifyAdmins(`New Route Created: ${route_name} (${starting} → ${destination})`, 'info', { tz, logger: req.log });
      res.status(201).json({
        message: 'Bus route created successfully',
        route: { ...routeFields(route), stops: createdStops },
        skipped_stops: skipped,
      });
    },

    async searchRoutes(req, res) {
      const now = new Date(); // one instant for every row's lifecycle
      // Legacy: keep only the first comma-separated part ("KR Puram, Bengaluru" -> "KR Puram")
      // and match it against either end of the route, case-insensitively.
      const first = (v) => (typeof v === 'string' ? v.split(',')[0].trim() : '');
      const terms = [first(req.body.starting_point), first(req.body.destination)].filter(Boolean);
      const or = terms.flatMap((t) => {
        const rx = new RegExp(escapeRegex(t), 'i');
        return [{ startPoint: rx }, { endPoint: rx }];
      });
      const routes = await Route.find({ $or: or }).sort({ routeId: 1 }).limit(200).lean();
      if (!routes.length) return res.status(404).json({ message: 'No route found' });

      // Bounded to the last 7 days onwards (the legacy query returned every schedule ever).
      const since = addDays(todayInTz(tz), -7);
      const schedules = await Schedule.find({ route: { $in: routes.map((r) => r._id) }, stop: null, date: { $gte: since } })
        .sort({ arrivalTime: 1 })
        .limit(2000)
        .populate('bus', 'busId busNumber')
        .populate('driver', 'fullname')
        .lean();

      const byRoute = new Map();
      for (const s of schedules) {
        if (!s.bus || !s.driver) continue;
        const list = byRoute.get(String(s.route)) ?? [];
        list.push({
          schedule_id: s.scheduleId,
          bus_number: s.bus.busNumber,
          driver_name: s.driver.fullname,
          bus_id: s.bus.busId,
          // Legacy naming: start_time carries departure_time and end_time carries arrival_time.
          start_time: formatLegacy(s.departureTime, tz),
          end_time: formatLegacy(s.arrivalTime, tz),
          status: s.status,
          date: s.date,
          is_reached: Boolean(s.isReached),
          // "reverse" trips run end_point -> start_point.
          direction: s.direction || 'forward',
          ...lifecycleFields(s, now),
        });
        byRoute.set(String(s.route), list);
      }

      const out = routes
        .filter((r) => byRoute.has(String(r._id)))
        .map((r) => ({ ...routeFields(r), schedules: byRoute.get(String(r._id)) }));
      if (!out.length) return res.status(404).json({ message: 'No routes found without stops' });
      return res.json(out);
    },

    async geocode(req, res) {
      const { address } = req.validatedQuery;
      const parts = address.split(',');
      try {
        if (parts.length === 2 && parts.every((p) => p.trim() !== '' && !Number.isNaN(Number(p)))) {
          const [lat, lon] = parts.map(Number);
          if (!isValidLat(lat) || !isValidLng(lon)) throw badRequest('Invalid coordinates');
          const data = await geo.reverseRaw(lat, lon);
          return res.json([{ lat, lon, display_name: data?.display_name || '' }]);
        }
        const data = await geo.searchRaw(address);
        if (!Array.isArray(data) || !data.length) throw notFound('Location not found');
        return res.json(data);
      } catch (err) {
        if (err.status) throw err;
        throw upstreamError('Geocoding service unavailable');
      }
    },

    async listSchedules(req, res) {
      const now = new Date(); // one instant for every row's lifecycle
      const q = req.validatedQuery;
      const includeDetails = ['1', 'true', 'yes'].includes((q.include_route_details || '').trim().toLowerCase());
      const { limit, skip } = parsePagination(q, { defaultLimit: 500, maxLimit: 2000 });

      const filter = q.date ? { date: q.date } : {};
      const schedules = await Schedule.find(filter)
        .sort(q.date ? { arrivalTime: 1 } : { date: -1, arrivalTime: 1 })
        .skip(skip)
        .limit(limit)
        .populate('bus', 'busId busNumber')
        .populate('route')
        .populate('driver', 'fullname userId')
        .populate('stop', 'name')
        .lean();

      let stopsByRoute = new Map();
      if (includeDetails && schedules.length) {
        const routeIds = [...new Set(schedules.map((s) => String(s.route?._id)).filter(Boolean))];
        const stops = await Stop.find({ route: { $in: routeIds } }).sort({ route: 1, sequence: 1 }).lean();
        stopsByRoute = stops.reduce((m, s) => {
          const list = m.get(String(s.route)) ?? [];
          list.push({ stop_id: s.stopId, stop_name: s.name, latitude: s.location.coordinates[1], longitude: s.location.coordinates[0], sequence: s.sequence });
          return m.set(String(s.route), list);
        }, new Map());
      }

      const out = schedules
        .filter((s) => s.bus && s.route && s.driver)
        .map((s) => {
          const start = formatHHMM(s.departureTime, tz);
          const end = formatHHMM(s.arrivalTime, tz);
          const row = {
            schedule_id: s.scheduleId,
            ...routeFields(s.route),
            bus_id: s.bus.busId,
            bus_number: s.bus.busNumber,
            driver_name: s.driver.fullname,
            driver_id: s.driver.userId, // lets a driver's dashboard find their own trips
            stop_name: s.stop?.name ?? 'N/A',
            start_time: start,
            end_time: end,
            departure_time: start,
            arrival_time: end,
            status: s.status,
            date: s.date,
            is_reached: Boolean(s.isReached),
            direction: s.direction || 'forward',
            // start_at / end_at / started / lifecycle — the one lifecycle every screen shows.
            ...lifecycleFields(s, now),
            arrived_at: s.arrivedAt ? s.arrivedAt.toISOString() : null,
          };
          if (includeDetails) {
            row.route_stops = stopsByRoute.get(String(s.route._id)) ?? [];
            row.route_stops_count = row.route_stops.length;
          }
          return row;
        });
      res.json(out);
    },

    async createSchedule(req, res) {
      const b = req.body;
      const [route, bus, driver] = await Promise.all([
        Route.findOne({ routeId: b.route_id }).lean(),
        Bus.findOne({ busId: b.bus_id }).lean(),
        User.findOne({ userId: b.driver_uuid }).lean(),
      ]);
      if (!route) throw badRequest('route_id does not exist');
      if (!bus) throw badRequest('bus_id does not exist');
      if (!driver || driver.roleKey !== 'driver') throw badRequest('driver_uuid must reference a user with the Driver role');

      const [ah, am] = b.arrival_time.split(':').map(Number);
      const [dh, dm] = b.departure_time.split(':').map(Number);
      try {
        const s = await Schedule.create({
          scheduleId: await nextSeq('schedules'),
          route: route._id,
          bus: bus._id,
          driver: driver._id,
          date: b.date,
          arrivalTime: wallTimeToDate(b.date, ah, am, tz),
          departureTime: wallTimeToDate(b.date, dh, dm, tz),
          status: b.status || 'on_time',
        });
        res.status(201).json({ message: 'Schedule created', schedule_id: s.scheduleId });
      } catch (err) {
        if (err.code === 11000) throw conflict('A schedule for this bus, route, date and departure time already exists');
        throw err;
      }
    },

    async listBuses(req, res) {
      const { limit, skip } = parsePagination(req.query, { defaultLimit: 1000, maxLimit: 2000 });
      const buses = await Bus.find().sort({ busId: 1 }).skip(skip).limit(limit).lean();
      res.json(buses.map(serializeBus));
    },

    async registerBus(req, res) {
      const b = req.body;
      try {
        const bus = await Bus.create({
          busId: await nextSeq('buses'),
          busNumber: b.bus_number,
          capacity: b.capacity ?? b.bus_capacity ?? null,
          operator: b.operator || null,
          busType: b.bus_type || null,
        });
        res.status(201).json({ message: 'Bus registered successfully', bus: serializeBus(bus) });
      } catch (err) {
        if (err.code === 11000) throw conflict('A bus with this number already exists');
        throw err;
      }
    },
  };
}
