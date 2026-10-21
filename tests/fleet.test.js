import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Route, Schedule, Stop } from '../src/models/index.js';
import { todayInTz } from '../src/utils/time.js';
import { bearer, createBus, createRoute, createUser, setupTestApp, userWithToken } from './helpers.js';

let t;
let admin;
let passenger;
let driverUser;
let superadmin;
beforeAll(async () => {
  t = await setupTestApp('fleet');
  admin = await userWithToken(t.app, 'admin');
  passenger = await userWithToken(t.app, 'passenger');
  superadmin = await userWithToken(t.app, 'superadmin');
  driverUser = await createUser('driver', { fullname: 'Driver Dev' });
});
afterAll(() => t.close());

describe('permissions', () => {
  it('/permissions/my returns effective permissions for the role', async () => {
    const res = await request(t.app).get('/permissions/my').set(bearer(passenger.token));
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('Passenger');
    expect(res.body.permissions).toMatchObject({ dashboard: true, users: false, Uploded_documents: false, permissions: false });
  });

  it('matrix is superadmin-only and updates take effect server-side', async () => {
    expect((await request(t.app).get('/permissions/matrix').set(bearer(admin.token))).status).toBe(403);
    const get = await request(t.app).get('/permissions/matrix').set(bearer(superadmin.token));
    expect(get.status).toBe(200);
    expect(get.body.roles).toEqual(expect.arrayContaining(['Superadmin', 'Admin', 'Driver', 'Passenger', 'Operator']));

    expect((await request(t.app).get('/data/get_data').set(bearer(passenger.token))).status).toBe(200);
    const put = await request(t.app)
      .put('/permissions/matrix')
      .set(bearer(superadmin.token))
      .send({ updates: [{ role_name: 'PASSENGER', feature_key: 'dashboard', allowed: false }, { role_name: 'Nope', feature_key: 'x', allowed: true }] });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ applied: 1, skipped_roles: ['Nope'] });
    expect((await request(t.app).get('/data/get_data').set(bearer(passenger.token))).status).toBe(403);
    const matrix = await request(t.app).get('/permissions/matrix').set(bearer(superadmin.token));
    expect(matrix.body.matrix.Passenger).toEqual({ dashboard: false });

    await request(t.app).put('/permissions/matrix').set(bearer(superadmin.token)).send({ updates: [{ role_name: 'Passenger', feature_key: 'dashboard', allowed: true }] });
  });

  it('rejects malformed matrix updates', async () => {
    const res = await request(t.app).put('/permissions/matrix').set(bearer(superadmin.token)).send({ updates: [] });
    expect(res.status).toBe(400);
  });
});

describe('buses', () => {
  it('admin registers buses; duplicates conflict; passengers are refused', async () => {
    const ok = await request(t.app).post('/bus/register_bus').set(bearer(admin.token)).send({ bus_number: 'DL-1PC-0001', bus_capacity: '42', bus_type: 'AC' });
    expect(ok.status).toBe(201);
    expect(ok.body.bus).toMatchObject({ bus_number: 'DL-1PC-0001', capacity: 42, bus_type: 'AC' });
    expect((await request(t.app).post('/bus/register_bus').set(bearer(admin.token)).send({ bus_number: 'DL-1PC-0001' })).status).toBe(409);
    expect((await request(t.app).post('/bus/register_bus').set(bearer(passenger.token)).send({ bus_number: 'X-1' })).status).toBe(403);
    expect((await request(t.app).post('/bus/register_bus').set(bearer(admin.token)).send({ capacity: 3 })).status).toBe(400);
    const list = await request(t.app).get('/bus/get_all_buses').set(bearer(passenger.token));
    expect(list.status).toBe(200);
    expect(list.body.map((b) => b.bus_number)).toContain('DL-1PC-0001');
    expect((await request(t.app).get('/bus/get_all_buses')).status).toBe(401);
  });
});

describe('routes and stops', () => {
  it('creates a route with ordered stops, skipping ungeocodable stops', async () => {
    const res = await request(t.app)
      .post('/bus/bus_route')
      .set(bearer(admin.token))
      .send({ route_name: 'Greater Noida Express', starting: 'Pari Chowk', destination: 'Saket Metro', stops: ['Stop A', 'Atlantis'] });
    expect(res.status).toBe(201);
    expect(res.body.route).toMatchObject({ route_name: 'Greater Noida Express', start_lat: 28.4646, start_lng: 77.5113, end_lat: 28.5206, end_lng: 77.2013 });
    expect(res.body.route.stops).toHaveLength(1);
    expect(res.body.skipped_stops).toEqual(['Atlantis']);
    const route = await Route.findOne({ routeId: res.body.route.route_id }).lean();
    expect(route.start.coordinates).toEqual([77.5113, 28.4646]); // GeoJSON [lng, lat]
    expect(await Stop.countDocuments({ route: route._id })).toBe(1);
  });

  it('returns 400 when start/end cannot be geocoded and 403 for passengers/drivers', async () => {
    expect((await request(t.app).post('/bus/bus_route').set(bearer(admin.token)).send({ route_name: 'X', starting: 'Nowhere', destination: 'Saket Metro' })).status).toBe(400);
    expect((await request(t.app).post('/bus/bus_route').set(bearer(admin.token)).send({ starting: 'Pari Chowk' })).status).toBe(400);
    expect((await request(t.app).post('/bus/bus_route').set(bearer(passenger.token)).send({ route_name: 'X', starting: 'Pari Chowk', destination: 'Saket Metro' })).status).toBe(403);
  });
});

describe('schedules', () => {
  let route;
  let bus;
  const today = () => todayInTz('Asia/Kolkata');

  beforeAll(async () => {
    route = await createRoute({ startPoint: 'KR Puram, Bengaluru', endPoint: 'Majestic, Bengaluru' });
    bus = await createBus();
  });

  it('creates a schedule and rejects invalid references and duplicates', async () => {
    const body = { route_id: route.routeId, bus_id: bus.busId, driver_uuid: driverUser.userId, date: today(), arrival_time: '07:30', departure_time: '07:35' };
    const ok = await request(t.app).post('/bus/schedules').set(bearer(admin.token)).send(body);
    expect(ok.status).toBe(201);
    expect((await request(t.app).post('/bus/schedules').set(bearer(admin.token)).send(body)).status).toBe(409);
    expect((await request(t.app).post('/bus/schedules').set(bearer(admin.token)).send({ ...body, route_id: 9999 })).status).toBe(400);
    expect((await request(t.app).post('/bus/schedules').set(bearer(admin.token)).send({ ...body, driver_uuid: passenger.user.userId })).status).toBe(400);
    expect((await request(t.app).post('/bus/schedules').set(bearer(admin.token)).send({ ...body, date: '2026-13-40' })).status).toBe(400);
    expect((await request(t.app).post('/bus/schedules').set(bearer(passenger.token)).send(body)).status).toBe(403);
  });

  it('lists schedules in the legacy shape, filtered by date, with route details', async () => {
    const res = await request(t.app).get(`/bus/schedules?date=${today()}&include_route_details=1`).set(bearer(admin.token));
    expect(res.status).toBe(200);
    const row = res.body.find((s) => s.route_id === route.routeId);
    expect(row).toMatchObject({
      bus_number: bus.busNumber,
      driver_name: 'Driver Dev',
      driver_id: driverUser.userId,
      stop_name: 'N/A',
      start_time: '07:35',
      end_time: '07:30',
      departure_time: '07:35',
      arrival_time: '07:30',
      status: 'on_time',
      date: today(),
      is_reached: false,
      route_stops: [],
      route_stops_count: 0,
    });
    expect((await request(t.app).get('/bus/schedules?date=20-01-2026').set(bearer(admin.token))).status).toBe(400);
    expect((await request(t.app).get('/bus/schedules')).status).toBe(401);
    // Passengers keep dashboard access to today's schedules.
    expect((await request(t.app).get(`/bus/schedules?date=${today()}`).set(bearer(passenger.token))).status).toBe(200);
  });

  it('searches routes by the first comma-separated part, case-insensitively, regex-safe', async () => {
    const res = await request(t.app).post('/bus/get_routes').set(bearer(passenger.token)).send({ starting_point: 'kr puram, Bengaluru, Karnataka', destination: '' });
    expect(res.status).toBe(200);
    const r = res.body.find((x) => x.route_id === route.routeId);
    expect(r.schedules[0]).toMatchObject({ bus_id: bus.busId, driver_name: 'Driver Dev', date: today() });
    expect(r.schedules[0].start_time).toMatch(/^\d{4}-\d{2}-\d{2} 07:35:00$/);
    expect((await request(t.app).post('/bus/get_routes').set(bearer(passenger.token)).send({ starting_point: '.*(' })).status).toBe(404);
    expect((await request(t.app).post('/bus/get_routes').set(bearer(passenger.token)).send({})).status).toBe(400);
  });
});

describe('dashboard', () => {
  it('returns counts; only privileged roles see other users\' details', async () => {
    const adminRes = await request(t.app).get('/data/get_data').set(bearer(admin.token));
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.total_users).toBeGreaterThanOrEqual(4);
    expect(adminRes.body.total_drivers).toBe(adminRes.body.total_driver);
    expect(adminRes.body.total_drivers).toBeGreaterThanOrEqual(1);
    expect(adminRes.body.total_active_users).toBeGreaterThanOrEqual(3);
    expect(adminRes.body.users[0]).toHaveProperty('email');
    expect(adminRes.body.active_users[0]).toHaveProperty('login_time');

    const pRes = await request(t.app).get('/data/get_data').set(bearer(passenger.token));
    expect(pRes.status).toBe(200);
    expect(pRes.body.users[0]).toEqual({ created_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(pRes.body.active_users).toEqual([]);
  });

  it('total_routes and get_routes', async () => {
    const tr = await request(t.app).get('/data/total_routes').set(bearer(admin.token));
    expect(tr.status).toBe(200);
    expect(tr.body.total_routes).toBe(await Schedule.countDocuments());
    const gr = await request(t.app).get('/data/get_routes').set(bearer(admin.token));
    expect(gr.status).toBe(200);
    expect(gr.body.length).toBe(await Route.countDocuments());
  });
});

describe('user management', () => {
  it('lists users/drivers by permission, edits and deletes with hierarchy checks', async () => {
    expect((await request(t.app).get('/view/user_details').set(bearer(passenger.token))).status).toBe(403);
    const users = await request(t.app).get('/view/user_details').set(bearer(admin.token));
    expect(users.status).toBe(200);
    expect(users.body.every((u) => u.role !== 'Driver')).toBe(true);
    const drivers = await request(t.app).get('/view/driver_details').set(bearer(admin.token));
    expect(drivers.body.every((u) => u.role === 'Driver')).toBe(true);

    const victim = await createUser('passenger');
    expect((await request(t.app).post('/view/edit_user_details').set(bearer(passenger.token)).send({ user_uuid: victim.userId, fullname: 'Hacked' })).status).toBe(403);
    const edit = await request(t.app).post('/view/edit_user_details').set(bearer(admin.token)).send({ user_uuid: victim.userId, fullname: 'Edited', role: 'Superadmin' });
    expect(edit.status).toBe(200);
    expect(edit.body.fullname).toBe('Edited');

    const otherAdmin = await createUser('admin');
    expect((await request(t.app).post('/view/delete').set(bearer(admin.token)).send({ user_uuid: otherAdmin.userId })).status).toBe(403);
    expect((await request(t.app).post('/view/delete').set(bearer(passenger.token)).send({ user_uuid: victim.userId })).status).toBe(403);
    expect((await request(t.app).post('/view/delete').set(bearer(admin.token)).send({ user_uuid: admin.user.userId })).status).toBe(403);
    expect((await request(t.app).post('/view/delete').set(bearer(admin.token)).send({ user_uuid: victim.userId })).status).toBe(200);
    expect((await request(t.app).post('/view/delete').set(bearer(admin.token)).send({ user_uuid: victim.userId })).status).toBe(404);
    expect((await request(t.app).post('/view/delete').set(bearer(superadmin.token)).send({ user_uuid: otherAdmin.userId })).status).toBe(200);
  });
});
