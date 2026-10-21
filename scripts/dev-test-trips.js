#!/usr/bin/env node
// Creates one test trip per sample route, starting at the current minute (app timezone),
// so the simulation worker starts moving the buses straight away. Development only.
// Requires the sample fleet: run scripts/dev-sample-data.js first.
//
//   node scripts/dev-test-trips.js                 # trips start now, scheduled for 20 min
//   TRIP_MINUTES=30 node scripts/dev-test-trips.js
import 'dotenv/config';

const API = (process.env.API_URL || `http://localhost:${process.env.PORT || 5001}`).replace(/\/$/, '');
const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const TRIP_MINUTES = Number(process.env.TRIP_MINUTES || 20);

// Same pairs as dev-sample-data.js.
const PAIRS = [
  { route: 'Pari Chowk - Saket Express', bus: 'DL-1PC-1001', driver: 'ramesh.driver@livetracking.local' },
  { route: 'Connaught Place - India Gate Shuttle', bus: 'DL-1PC-1002', driver: 'suresh.driver@livetracking.local' },
  { route: 'Kashmere Gate - Noida Sector 18', bus: 'UP-16-AT-2003', driver: 'amit.driver@livetracking.local' },
];

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const parts = (d) => Object.fromEntries(
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d)
    .map((p) => [p.type, p.value]),
);

async function main() {
  const now = new Date();
  const start = parts(now);
  const date = `${start.year}-${start.month}-${start.day}`;
  const startHHMM = `${start.hour}:${start.minute}`;
  const endParts = parts(new Date(now.getTime() + TRIP_MINUTES * 60_000));
  // A trip cannot cross midnight (one date per schedule): cap the end at 23:59.
  const endHHMM = endParts.day === start.day ? `${endParts.hour}:${endParts.minute}` : '23:59';

  const login = await api('POST', '/auth/login', { body: { email: process.env.DEFAULT_ADMIN_EMAIL, password: process.env.DEFAULT_ADMIN_PASSWORD } });
  if (login.status !== 200) throw new Error(`Admin login failed (${login.status}): ${login.data.error}`);
  const token = login.data.token;

  const [routes, buses, drivers] = await Promise.all([
    api('GET', '/data/get_routes', { token }),
    api('GET', '/bus/get_all_buses', { token }),
    api('GET', '/view/driver_details', { token }),
  ]);

  const results = [];
  for (const p of PAIRS) {
    const route = routes.data.find((r) => r.route_name === p.route);
    const bus = buses.data.find((b) => b.bus_number === p.bus);
    const driver = drivers.data.find((d) => d.email === p.driver);
    if (!route || !bus || !driver) {
      results.push({ route: p.route, result: 'missing sample data: run node scripts/dev-sample-data.js first' });
      continue;
    }
    const res = await api('POST', '/bus/schedules', {
      token,
      body: { route_id: route.route_id, bus_id: bus.bus_id, driver_uuid: driver.user_uuid, date, arrival_time: startHHMM, departure_time: endHHMM },
    });
    results.push({
      route: p.route,
      bus: p.bus,
      date,
      start: startHHMM,
      end: endHHMM,
      result: res.status === 201 ? `created #${res.data.schedule_id}` : res.status === 409 ? 'already exists (same minute)' : `error ${res.status}: ${res.data.error}`,
    });
  }
  await api('POST', '/auth/logout', { token });
  console.table(results);
}

main().catch((err) => {
  console.error('Test trips failed:', err.message);
  process.exit(1);
});
