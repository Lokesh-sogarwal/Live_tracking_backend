import { inject } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/config/logger.js';
import { ensureIndexes, User, Bus, Route, nextSeq } from '../src/models/index.js';
import { ensureDefaultRoles, invalidatePermissionCache } from '../src/services/roles.js';
import { createStorage } from '../src/services/storage.js';
import { hashPassword } from '../src/services/passwords.js';
import { createApp } from '../src/app.js';
import { createSocketServer } from '../src/sockets/index.js';

export const JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
export const PASSWORD = 'Password#123';

export function dbUri(name) {
  const url = new URL(inject('mongoUri'));
  url.pathname = `/${name}`;
  return url.toString();
}

// Deterministic geocoder: tests never call Nominatim or ORS unless they opt in.
export const PLACES = {
  'pari chowk': { lat: 28.4646, lng: 77.5113 },
  'saket metro': { lat: 28.5206, lng: 77.2013 },
  'kr puram': { lat: 13.0077, lng: 77.6957 },
  majestic: { lat: 12.9767, lng: 77.5713 },
  'stop a': { lat: 28.5, lng: 77.4 },
};

export function fakeGeo(overrides = {}) {
  return {
    geocodePlace: async (p) => PLACES[p.trim().toLowerCase()] ?? null,
    searchRaw: async () => [{ lat: '1', lon: '2', display_name: 'x' }],
    reverseRaw: async () => ({ display_name: 'Somewhere' }),
    getRouteGeometry: async (s, e) => ({
      coordinates: [[s.lng, s.lat], [(s.lng + e.lng) / 2, (s.lat + e.lat) / 2], [e.lng, e.lat]],
      durationSeconds: 600,
      distanceMeters: 5000,
      provider: 'ors',
    }),
    ...overrides,
  };
}

export async function setupTestApp(name, envOverrides = {}, { geo, mailer } = {}) {
  const uploadDir = await mkdtemp(path.join(tmpdir(), 'lt-uploads-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    MONGODB_URI: dbUri(name),
    JWT_SECRET,
    LOG_LEVEL: 'silent',
    RATE_LIMIT_ENABLED: 'false',
    LOCAL_UPLOAD_DIR: uploadDir,
    FRONTEND_ORIGINS: 'http://localhost:3000,https://live-tracking-frontend.vercel.app',
    MAX_UPLOAD_BYTES: String(64 * 1024),
    ...envOverrides,
  });
  const logger = createLogger('silent');
  await mongoose.connect(config.MONGODB_URI);
  await mongoose.connection.db.dropDatabase();
  await ensureIndexes();
  await ensureDefaultRoles();
  invalidatePermissionCache();
  const ctx = { config, logger, geo: geo ?? fakeGeo(), storage: await createStorage(config), ...(mailer ? { mailer } : {}) };
  const app = createApp(ctx);

  return {
    app,
    ctx,
    config,
    async close() {
      await mongoose.disconnect();
      await rm(uploadDir, { recursive: true, force: true });
    },
  };
}

let counter = 0;
export async function createUser(roleKey = 'passenger', overrides = {}) {
  counter += 1;
  return User.create({
    fullname: `${roleKey} user ${counter}`,
    email: `${roleKey}${counter}-${Date.now()}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
    roleKey,
    ...overrides,
  });
}

export async function login(app, user, password = PASSWORD) {
  const res = await request(app).post('/auth/login').send({ email: user.email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

export async function userWithToken(app, roleKey, overrides) {
  const user = await createUser(roleKey, overrides);
  return { user, token: await login(app, user) };
}

export async function createBus(overrides = {}) {
  const busId = await nextSeq('buses');
  return Bus.create({ busId, busNumber: `KA-01-${busId}-${Date.now() % 100000}`, capacity: 40, ...overrides });
}

export async function createRoute(overrides = {}) {
  return Route.create({
    routeId: await nextSeq('routes'),
    routeName: 'Pari Chowk - Saket',
    startPoint: 'Pari Chowk, Greater Noida',
    start: { type: 'Point', coordinates: [77.5113, 28.4646] },
    endPoint: 'Saket Metro, Delhi',
    end: { type: 'Point', coordinates: [77.2013, 28.5206] },
    ...overrides,
  });
}

// Real HTTP server + Socket.IO for realtime tests.
export async function startRealtime(app, ctx) {
  const server = http.createServer(app);
  const io = createSocketServer(server, ctx);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    async stop() {
      io.close();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

export const bearer = (token) => ({ Authorization: `Bearer ${token}` });
