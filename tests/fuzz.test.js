import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bearer, setupTestApp, userWithToken } from './helpers.js';

// Malformed-input sweep: every route must answer with a controlled 4xx (or 2xx),
// never a 5xx, for wrong types, operator injection, oversized numbers and bad ids.
const BODIES = [
  {},
  [],
  { email: { $gt: '' }, password: { $ne: null } },
  { email: ['a@example.com'], password: 123 },
  { user_uuid: { $ne: null }, fullname: { a: 1 } },
  { bus_id: '1e309', latitude: 'NaN', longitude: Infinity },
  { bus_id: -1, latitude: null, longitude: [] },
  { updates: [{ role_name: { $gt: '' }, feature_key: '../x', allowed: 'yes' }] },
  { route_name: 'x'.repeat(5000), starting: {}, destination: [], stops: 'not-array' },
  { feedback: { $where: '1' } },
  { starting_point: { $regex: '.*' }, destination: 7 },
  { route_id: 'abc', bus_id: {}, driver_uuid: 'x', date: '2026-02-30', arrival_time: '25:00', departure_time: '' },
  { bus_number: { $ne: 1 }, bus_capacity: -5 },
];

const ROUTES = [
  ['post', '/auth/login'],
  ['post', '/auth/signup'],
  ['put', '/auth/profile'],
  ['put', '/view/profile'],
  ['post', '/view/delete'],
  ['post', '/view/edit_user_details'],
  ['post', '/view/update_location'],
  ['post', '/view/submit_feedback'],
  ['post', '/view/notifications/mark_read/abc'],
  ['post', '/view/notifications/mark_read/99999999999999999999'],
  ['get', '/view/get_location/1e309'],
  ['get', '/view/get_location/-1'],
  ['get', '/view/api/get_route/a/b/c/d'],
  ['get', '/view/api/get_route/1e309/1/1/1'],
  ['post', '/bus/bus_route'],
  ['post', '/bus/get_routes'],
  ['get', '/bus/geocode?address[$ne]=x'],
  ['get', '/bus/schedules?date[$gt]=&limit=-1&page=abc'],
  ['post', '/bus/schedules'],
  ['post', '/bus/register_bus'],
  ['get', '/data/get_data?limit[$gt]=1&active_limit=-9'],
  ['get', '/data/total_routes?page=-4&per_page=abc'],
  ['get', '/data/get_documents?limit=-1'],
  ['get', '/data/uploads/doc-1?exp=abc&u=x&sig=zz'],
  ['get', '/data/uploads/doc-99999999999999999999'],
  ['post', '/data/verify_document/abc'],
  ['post', '/data/reject_document/1e309'],
  ['get', '/data/get_feedback?limit=99999'],
  ['get', '/chat/history/not-a-uuid'],
  ['get', '/chat/history/00000000-0000-4000-8000-000000000000?limit=-1'],
  ['put', '/permissions/matrix'],
  ['post', '/chatbot/chat'],
];

let t;
let su;
beforeAll(async () => {
  t = await setupTestApp('fuzz');
  su = await userWithToken(t.app, 'superadmin');
});
afterAll(() => t.close());

describe('malformed input never produces a 5xx', () => {
  it.each(ROUTES)('%s %s', async (method, path) => {
    for (const body of BODIES) {
      let req = request(t.app)[method](path).set(bearer(su.token));
      if (method !== 'get') req = req.send(body);
      const res = await req;
      if (path.startsWith('/chatbot')) expect([400, 501]).toContain(res.status);
      else expect(res.status, `${method} ${path} body=${JSON.stringify(body).slice(0, 80)} → ${res.status} ${JSON.stringify(res.body)}`).toBeLessThan(500);
      expect(res.body?.debug, 'no internal error detail').toBeUndefined();
    }
  });

  it('NoSQL operator objects cannot log in', async () => {
    const res = await request(t.app).post('/auth/login').send({ email: { $gt: '' }, password: { $ne: null } });
    expect(res.status).toBe(400);
  });

  it('non-JSON content types and huge bodies are rejected cleanly', async () => {
    expect((await request(t.app).post('/auth/login').set('Content-Type', 'text/plain').send('email=x')).status).toBe(400);
    const big = await request(t.app).post('/auth/login').send({ email: 'a@example.com', password: 'x'.repeat(200_000) });
    expect(big.status).toBe(413);
  });
});
