import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config/index.js';
import { originMatcher } from '../src/app.js';
import { setupTestApp } from './helpers.js';

const PROD = 'https://live-tracking-frontend.vercel.app';
const PREVIEWS = 'https://live-tracking-frontend-*-lokesh-sogarwals-projects.vercel.app';
const base = { NODE_ENV: 'test', MONGODB_URI: 'mongodb://x/y', JWT_SECRET: 'x'.repeat(40) };

describe('FRONTEND_ORIGINS patterns', () => {
  it('matches every preview deployment of this project and nothing else', () => {
    const m = originMatcher([PROD, PREVIEWS]);
    expect(m('https://live-tracking-frontend-m64926iis-lokesh-sogarwals-projects.vercel.app')).toBe(true);
    expect(m(PROD)).toBe(true);
    for (const bad of [
      'https://live-tracking-frontend-x-attacker.vercel.app',
      'https://live-tracking-frontend-a.b-lokesh-sogarwals-projects.vercel.app',
      'https://live-tracking-frontend-abc-lokesh-sogarwals-projects.vercel.app.evil.com',
      'http://live-tracking-frontend-abc-lokesh-sogarwals-projects.vercel.app',
      'https://evil.com',
    ]) expect(m(bad)).toBe(false);
  });

  it('refuses unsafe patterns and keeps emailed links on a real address', () => {
    expect(() => loadConfig({ ...base, FRONTEND_ORIGINS: 'https://*.vercel.app' })).toThrow(/FRONTEND_ORIGINS entry/); // any Vercel site
    expect(() => loadConfig({ ...base, FRONTEND_ORIGINS: 'http://app-*-team.vercel.app' })).toThrow(/https/);
    expect(() => loadConfig({ ...base, FRONTEND_ORIGINS: 'https://a-*-*-team.vercel.app' })).toThrow(/only one/);
    expect(() => loadConfig({ ...base, FRONTEND_ORIGINS: 'https://example.com/*' })).toThrow();
    const c = loadConfig({ ...base, FRONTEND_ORIGINS: `${PREVIEWS},${PROD}` });
    expect(c.appPublicUrl).toBe(PROD);
  });
});

describe('CORS headers', () => {
  let t;
  beforeAll(async () => {
    t = await setupTestApp('cors', { FRONTEND_ORIGINS: `${PROD},${PREVIEWS}` });
  });
  afterAll(() => t.close());

  it('preflight from a preview deployment is allowed; from another site it is not', async () => {
    const preview = 'https://live-tracking-frontend-m64926iis-lokesh-sogarwals-projects.vercel.app';
    const ok = await request(t.app).options('/auth/signup_options').set('Origin', preview).set('Access-Control-Request-Method', 'GET');
    expect(ok.headers['access-control-allow-origin']).toBe(preview);
    const get = await request(t.app).get('/auth/signup_options').set('Origin', preview);
    expect(get.headers['access-control-allow-origin']).toBe(preview);
    const evil = await request(t.app).options('/auth/signup_options').set('Origin', 'https://live-tracking-frontend-x-attacker.vercel.app').set('Access-Control-Request-Method', 'GET');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});
