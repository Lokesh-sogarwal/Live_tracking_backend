#!/usr/bin/env node
// Creates sample drivers, buses, routes and bus schedules (today + tomorrow, app timezone)
// through the running API, logged in as the default admin from .env. Development only.
// Safe to re-run: existing drivers/buses/routes are reused and duplicate trips are skipped.
//
//   node scripts/dev-sample-data.js            (API at http://localhost:5001)
//   API_URL=http://localhost:5001 node scripts/dev-sample-data.js
import 'dotenv/config';
import { randomBytes } from 'node:crypto';

const API = (process.env.API_URL || `http://localhost:${process.env.PORT || 5001}`).replace(/\/$/, '');
const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';

const DRIVERS = [
  { fullname: 'Ramesh Kumar', email: 'ramesh.driver@livetracking.local' },
  { fullname: 'Suresh Yadav', email: 'suresh.driver@livetracking.local' },
  { fullname: 'Amit Singh', email: 'amit.driver@livetracking.local' },
];
const BUSES = [
  { bus_number: 'DL-1PC-1001', bus_capacity: 42, bus_type: 'AC' },
  { bus_number: 'DL-1PC-1002', bus_capacity: 36, bus_type: 'Non-AC' },
  { bus_number: 'UP-16-AT-2003', bus_capacity: 48, bus_type: 'AC' },
];
// trips: [start "HH:MM", duration minutes, status]
const ROUTES = [
  {
    route_name: 'Pari Chowk - Saket Express',
    starting: 'Pari Chowk, Greater Noida',
    destination: 'Saket, New Delhi',
    stops: ['Botanical Garden, Noida', 'Ashram, New Delhi'],
    bus: 0, driver: 0, minutes: 60,
    trips: [['07:00'], ['10:00'], ['14:00', 'delayed'], ['18:00']],
  },
  {
    route_name: 'Connaught Place - India Gate Shuttle',
    starting: 'Connaught Place, New Delhi',
    destination: 'India Gate, New Delhi',
    stops: [],
    bus: 1, driver: 1, minutes: 20,
    trips: [['08:00'], ['09:00'], ['11:30'], ['16:00'], ['19:30']],
  },
  {
    route_name: 'Kashmere Gate - Noida Sector 18',
    starting: 'Kashmere Gate, Delhi',
    destination: 'Sector 18, Noida',
    stops: ['Laxmi Nagar, Delhi'],
    bus: 2, driver: 2, minutes: 45,
    trips: [['07:30'], ['12:30'], ['17:00', 'delayed'], ['21:00']],
  },
];

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const dateIn = (offsetDays) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + offsetDays * 86_400_000));
const addMinutes = (hhmm, m) => {
  const [h, mm] = hhmm.split(':').map(Number);
  const total = Math.min(h * 60 + mm + m, 23 * 60 + 59); // stay within the same day
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

async function main() {
  if (!process.env.DEFAULT_ADMIN_EMAIL || !process.env.DEFAULT_ADMIN_PASSWORD) {
    throw new Error('Set DEFAULT_ADMIN_EMAIL and DEFAULT_ADMIN_PASSWORD in .env');
  }
  const login = await api('POST', '/auth/login', { body: { email: process.env.DEFAULT_ADMIN_EMAIL, password: process.env.DEFAULT_ADMIN_PASSWORD } });
  if (login.status !== 200) throw new Error(`Admin login failed (${login.status}): ${login.data.error}`);
  const token = login.data.token;

  // Drivers (reused if the email exists). New ones share one random dev password.
  const driverPassword = `Drv-${randomBytes(6).toString('hex')}`;
  let createdDrivers = 0;
  const existingDrivers = (await api('GET', '/view/driver_details', { token })).data;
  const driverIds = [];
  for (const d of DRIVERS) {
    let found = existingDrivers.find((x) => x.email === d.email);
    if (!found) {
      const r = await api('POST', '/auth/signup', { token, body: { ...d, password: driverPassword, role: 'Driver', is_password_change: false } });
      if (r.status !== 200) throw new Error(`Driver ${d.email}: ${r.status} ${r.data.error}`);
      found = r.data;
      createdDrivers += 1;
    }
    driverIds.push(found.user_uuid);
  }

  // Buses (reused by number).
  const existingBuses = (await api('GET', '/bus/get_all_buses', { token })).data;
  const busIds = [];
  for (const b of BUSES) {
    let found = existingBuses.find((x) => x.bus_number === b.bus_number);
    if (!found) {
      const r = await api('POST', '/bus/register_bus', { token, body: b });
      if (r.status !== 201) throw new Error(`Bus ${b.bus_number}: ${r.status} ${r.data.error}`);
      found = r.data.bus;
    }
    busIds.push(found.bus_id);
  }

  // Routes (reused by name; new ones are geocoded by the API via Nominatim).
  const existingRoutes = (await api('GET', '/data/get_routes', { token })).data;
  const routeIds = [];
  for (const r of ROUTES) {
    let found = existingRoutes.find((x) => x.route_name === r.route_name);
    if (!found) {
      const res = await api('POST', '/bus/bus_route', { token, body: { route_name: r.route_name, starting: r.starting, destination: r.destination, stops: r.stops } });
      if (res.status !== 201) throw new Error(`Route "${r.route_name}": ${res.status} ${res.data.error}`);
      found = res.data.route;
      if (res.data.skipped_stops?.length) console.log(`  (stops not found by geocoder, skipped: ${res.data.skipped_stops.join(', ')})`);
    }
    routeIds.push(found);
  }

  // Schedules for today and tomorrow.
  const summary = [];
  for (const offset of [0, 1]) {
    const date = dateIn(offset);
    for (const [i, r] of ROUTES.entries()) {
      for (const [start, status] of r.trips) {
        const body = {
          route_id: routeIds[i].route_id,
          bus_id: busIds[r.bus],
          driver_uuid: driverIds[r.driver],
          date,
          arrival_time: start, // trip start (shown as "Departure" in the UI)
          departure_time: addMinutes(start, r.minutes), // trip end
          ...(status ? { status } : {}),
        };
        const res = await api('POST', '/bus/schedules', { token, body });
        summary.push({ date, route: r.route_name, bus: BUSES[r.bus].bus_number, start, end: body.departure_time, status: status || 'on_time', result: res.status === 201 ? `created #${res.data.schedule_id}` : res.status === 409 ? 'already exists' : `error ${res.status}: ${res.data.error}` });
      }
    }
  }
  await api('POST', '/auth/logout', { token });

  console.table(summary);
  console.log('Routes:');
  for (const r of routeIds) console.log(`  #${r.route_id} ${r.route_name}: ${r.start_point} (${r.start_lat?.toFixed?.(4)}, ${r.start_lng?.toFixed?.(4)}) -> ${r.end_point} (${r.end_lat?.toFixed?.(4)}, ${r.end_lng?.toFixed?.(4)})`);
  if (createdDrivers) console.log(`Created ${createdDrivers} driver account(s); dev password for them: ${driverPassword}`);
}

main().catch((err) => {
  console.error('Sample data failed:', err.message);
  process.exit(1);
});
