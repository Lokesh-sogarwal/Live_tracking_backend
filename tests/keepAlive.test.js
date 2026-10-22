import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { startKeepAlive } from '../src/services/keepAlive.js';
import { loadConfig } from '../src/config/index.js';
import { setupTestApp } from './helpers.js';

const silent = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
const base = { NODE_ENV: 'test', MONGODB_URI: 'mongodb://x/y', JWT_SECRET: 'x'.repeat(40) };

describe('keep-alive', () => {
  it('pings <url>/health/live about every interval, keeps going after failures, and stops', async () => {
    vi.useFakeTimers();
    try {
      const calls = [];
      let fail = true;
      const fetchImpl = vi.fn(async (u) => {
        calls.push(u);
        if (fail) {
          fail = false;
          throw new Error('ECONNRESET');
        }
        return new Response('{"status":"ok"}', { status: 200 });
      });
      const k = startKeepAlive({ url: 'https://api.example.onrender.com/', intervalMinutes: 10, logger: silent, fetchImpl, random: () => 0.5 });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(calls).toEqual(['https://api.example.onrender.com/health/live', 'https://api.example.onrender.com/health/live']);
      expect(silent.warn).toHaveBeenCalledWith(expect.objectContaining({ err: { message: 'ECONNRESET' } }), 'Keep-alive ping failed');
      k.stop();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start without a URL', () => {
    expect(startKeepAlive({ url: '', intervalMinutes: 10, logger: silent })).toBeNull();
  });

  it('config: off by default; URL falls back to RENDER_EXTERNAL_URL; interval must stay under 15 minutes', () => {
    expect(loadConfig(base).KEEP_ALIVE_ENABLED).toBe(false);
    expect(loadConfig({ ...base, RENDER_EXTERNAL_URL: 'https://x.onrender.com' }).keepAliveUrl).toBe('https://x.onrender.com');
    expect(loadConfig({ ...base, RENDER_EXTERNAL_URL: 'https://x.onrender.com', KEEP_ALIVE_URL: 'https://y.example' }).keepAliveUrl).toBe('https://y.example');
    expect(() => loadConfig({ ...base, KEEP_ALIVE_INTERVAL_MINUTES: '15' })).toThrow();
  });
});

describe('GET /health/live', () => {
  let t;
  beforeAll(async () => {
    t = await setupTestApp('keepalive');
  });
  afterAll(() => t.close());
  it('answers without auth or database work, uncached', async () => {
    const res = await request(t.app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
