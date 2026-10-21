import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { bearer, createBus, setupTestApp, userWithToken } from './helpers.js';

// Every endpoint the React app calls (grep of Live_Tracking_Frontend/src, Oct 2026),
// exercised as a superadmin. The assertion is "route exists and is handled", i.e. not
// a 404 from the router and never a 5xx. Body/shape assertions live in the domain tests.
let t;
let su;
let ids;
beforeAll(async () => {
  t = await setupTestApp('contract');
  su = await userWithToken(t.app, 'superadmin');
  const other = await userWithToken(t.app, 'driver');
  const bus = await createBus();
  ids = { other: other.user.userId, bus: bus.busId };
});
afterAll(() => t.close());

const calls = () => [
  ['post', '/auth/signup', { fullname: 'C', email: 'c@example.com', password: 'Abcdef#1' }, 'Signup.jsx, UserDetails.jsx, Driver_details.jsx'],
  ['get', '/auth/profile', null, 'Profile.jsx (alias)'],
  ['put', '/auth/profile', { fullname: 'Su' }, 'Profile.jsx, editProfile.jsx'],
  ['post', '/auth/verify_otp', { otp: '1' }, 'Otp.jsx (not routed) -> 501'],
  ['get', '/view/profile', null, 'Profile.jsx, editProfile.jsx'],
  ['get', '/view/user_details', null, 'UserDetails.jsx'],
  ['get', '/view/driver_details', null, 'Driver_details.jsx'],
  ['post', '/view/edit_user_details', () => ({ user_uuid: ids.other, fullname: 'D' }), 'UserDetails.jsx'],
  ['get', '/view/notifications', null, 'nav.jsx, Notification.jsx'],
  ['post', '/view/notifications/mark_read_all', {}, 'Notification.jsx'],
  ['post', '/view/notifications/mark_all_read', {}, 'legacy name'],
  ['get', '/view/chat_users', null, 'Chatusers.js'],
  ['post', '/view/submit_feedback', { feedback: 'ok' }, 'feedback.jsx'],
  ['get', () => `/view/get_location/${ids.bus}`, null, 'BusTracking.jsx (404 = no location yet)'],
  ['get', '/view/api/get_route/28.46/77.51/28.52/77.20', null, 'BusTracking.jsx'],
  ['get', '/data/get_data', null, 'dashboard widgets, active_users.jsx'],
  ['get', '/data/get_routes', null, 'Total_routes.jsx'],
  ['get', '/data/total_routes', null, 'legacy'],
  ['get', '/data/get_documents', null, 'Uploaded_documents.jsx'],
  ['get', '/data/get_feedback', null, 'show_feedback.jsx'],
  ['get', '/bus/get_all_buses', null, 'Total_buses.jsx'],
  ['post', '/bus/get_routes', { starting_point: 'x' }, 'AllRoutes.jsx (404 = no match)'],
  ['get', '/bus/schedules?date=2026-10-20&include_route_details=1', null, 'Dashboard.jsx, allschedules.jsx, schedule.jsx'],
  ['post', '/bus/register_bus', { bus_number: 'C-1' }, 'RegisterBus.jsx'],
  ['get', () => `/chat/history/${ids.other}`, null, 'chat.jsx'],
  ['get', '/permissions/my', null, 'PermissionsContext.jsx'],
  ['get', '/permissions/matrix', null, 'Permissions.jsx'],
  ['put', '/permissions/matrix', { updates: [{ role_name: 'Driver', feature_key: 'chat', allowed: true }] }, 'Permissions.jsx'],
  ['post', '/chatbot/chat', { message: 'hi', history: [] }, 'chatbot.jsx -> 501'],
];

describe('frontend API contract', () => {
  it.each(calls().map((c) => [typeof c[1] === 'string' ? `${c[0].toUpperCase()} ${c[1]}` : `${c[0].toUpperCase()} ${c[3]}`, c]))('%s', async (_name, [method, path, body]) => {
    const url = typeof path === 'function' ? path() : path;
    const payload = typeof body === 'function' ? body() : body;
    let req = request(t.app)[method](url).set(bearer(su.token));
    if (payload) req = req.send(payload);
    const res = await req;
    const expectedNotImplemented = /(verify_otp|chatbot)/.test(url);
    if (expectedNotImplemented) expect(res.status).toBe(501);
    else expect(res.status, `${url} -> ${res.status} ${JSON.stringify(res.body)}`).toBeLessThan(500);
    // The router's catch-all 404 body; handler-level 404s carry a specific message.
    expect(res.body).not.toEqual({ error: 'Not found', code: 'NOT_FOUND' });
  });

  it('upload, logout and download endpoints exist', async () => {
    expect((await request(t.app).post(`/view/upload/${ids.other}`).set(bearer(su.token))).status).toBe(400);
    expect((await request(t.app).get('/data/uploads/doc-1')).status).toBe(401);
    expect((await request(t.app).post('/view/delete').set(bearer(su.token)).send({ user_uuid: ids.other })).status).toBe(200);
    expect((await request(t.app).post('/auth/logout').set(bearer(su.token))).status).toBe(200);
  });

  it('unknown paths return a JSON 404', async () => {
    const res = await request(t.app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
  });
});

describe('platform', () => {
  it('health endpoints and request ids', async () => {
    expect((await request(t.app).get('/health/live')).body).toEqual({ status: 'ok' });
    const ready = await request(t.app).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.headers['x-request-id']).toBeTruthy();
    expect((await request(t.app).get('/healthz')).status).toBe(200);
    expect((await request(t.app).get('/')).text).toBe('Backend running successfully');
  });

  it('CORS allows only configured origins', async () => {
    const ok = await request(t.app).options('/auth/login').set('Origin', 'https://live-tracking-frontend.vercel.app').set('Access-Control-Request-Method', 'POST');
    expect(ok.headers['access-control-allow-origin']).toBe('https://live-tracking-frontend.vercel.app');
    const bad = await request(t.app).options('/auth/login').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('invalid JSON is a controlled 400 and helmet headers are set', async () => {
    const res = await request(t.app).post('/auth/login').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid JSON body');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('readiness fails when MongoDB is unavailable', async () => {
    await mongoose.disconnect();
    const res = await request(t.app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.checks.mongo).toBe(false);
    await mongoose.connect(t.config.MONGODB_URI);
  });
});
