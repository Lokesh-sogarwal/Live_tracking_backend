// Keeps a free Render web service awake: free instances sleep after ~15 minutes without
// inbound requests, which also pauses the in-process worker (RUN_WORKER). Every
// KEEP_ALIVE_INTERVAL_MINUTES the API calls its own *public* /health/live; the request goes out
// through Render's proxy and back in, so it counts as inbound traffic.
//
// Limits: it can't wake an instance that is already asleep (the process is stopped) — an
// external monitor (e.g. UptimeRobot on /health/live every 5–10 min) covers that. A service
// running 24/7 uses ~730 of the free plan's 750 instance-hours a month.
const JITTER = 0.1;

export function startKeepAlive({ url, intervalMinutes, logger, fetchImpl = fetch, random = Math.random, timeoutMs = 20_000 }) {
  if (!url) {
    logger.warn('KEEP_ALIVE_ENABLED is true but no URL is known (set KEEP_ALIVE_URL, or deploy on Render which sets RENDER_EXTERNAL_URL); keep-alive not started');
    return null;
  }
  const target = `${url.replace(/\/$/, '')}/health/live`;
  const baseMs = intervalMinutes * 60_000;
  let timer = null;
  let stopped = false;
  let okOnce = false;

  const ping = async () => {
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(target, { headers: { 'user-agent': 'live-tracking-keepalive' }, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!okOnce) logger.info({ target, everyMinutes: intervalMinutes }, 'Keep-alive ping ok');
      okOnce = true;
      return true;
    } catch (err) {
      logger.warn({ target, err: { message: err.name === 'AbortError' ? 'timed out' : err.message } }, 'Keep-alive ping failed');
      return false;
    } finally {
      clearTimeout(abort);
    }
  };

  const schedule = () => {
    if (stopped) return;
    // ±10 % jitter so several services don't ping in lockstep.
    const delay = Math.round(baseMs * (1 - JITTER + 2 * JITTER * random()));
    timer = setTimeout(async () => {
      await ping();
      schedule();
    }, delay);
    timer.unref?.(); // never keeps the process alive on shutdown
  };
  schedule();
  logger.info({ target, everyMinutes: intervalMinutes }, 'Keep-alive enabled');

  return {
    ping,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
