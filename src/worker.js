import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config/index.js';
import { createLogger } from './config/logger.js';
import { connectMongo, disconnectMongo } from './db.js';
import { ensureIndexes } from './models/index.js';
import { createGeoService } from './services/geo.js';
import { acquireLease, releaseLease } from './jobs/lock.js';
import { runDailyScheduleJob, runReverseTripCheck } from './jobs/scheduleJob.js';
import { runSimulationTick } from './jobs/simulationJob.js';
import { startLoop } from './jobs/loop.js';
import { recordHeartbeat, recordScheduleCheck, recordSimulationTick, recordWorkerError } from './services/workerStatus.js';

const LEASE_NAME = 'scheduler-worker';
const LEASE_MS = 30_000;
const SCHEDULE_CHECK_MS = 30_000;

// Starts the job loops (scheduler, return trips, simulation) under the Mongo lease. Used by
// `node src/worker.js` (own process) and by the API when RUN_WORKER=true (one process, e.g. a
// single free Render web service). Returns { stop } — or null when SCHEDULER_ENABLED=false.
// Expects MongoDB to be connected already.
export async function startWorker({ config, logger: baseLogger, geo }) {
  const logger = baseLogger.child({ component: 'worker' });
  if (!config.SCHEDULER_ENABLED) {
    logger.warn('SCHEDULER_ENABLED is false; worker jobs not started');
    return null;
  }
  if (config.SIMULATION_ENABLED && config.isProduction) {
    logger.warn('SIMULATION_ENABLED=true in production: simulated bus positions will be published as live locations');
  }
  const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const instance = randomUUID().slice(0, 8);
  const startedAt = new Date();

  let stopping = false;
  let leader = false;
  const loops = [];

  const heartbeat = async () => {
    try {
      const got = await acquireLease(LEASE_NAME, owner, LEASE_MS);
      if (got !== leader) logger.info({ owner, leader: got }, got ? 'Acquired scheduler lease' : 'Lost scheduler lease');
      leader = got;
      // Only the leader reports: a standby worker is not running jobs.
      if (leader) {
        await recordHeartbeat({ instance, startedAt, simulationEnabled: config.SIMULATION_ENABLED, simulationTickMs: config.SIMULATION_ENABLED ? config.SIMULATION_TICK_MS : null });
      }
    } catch (err) {
      leader = false;
      logger.error({ err: { message: err.message } }, 'Lease heartbeat failed');
    }
  };

  // Jobs only run while this process holds the lease.
  const loop = (name, fn, everyMs) =>
    loops.push(
      startLoop(fn, everyMs, {
        shouldRun: () => leader && !stopping,
        onError: (err, { failures, retryInMs } = {}) => {
          logger.error({ err: { message: err.message }, job: name, failures, retryInMs }, 'Worker job failed');
          recordWorkerError(name, err).catch(() => {});
        },
      }),
    );

  await heartbeat();
  const heartbeatTimer = setInterval(heartbeat, LEASE_MS / 3);
  loop('schedules', async () => {
    await runDailyScheduleJob({ config, logger, owner });
    await runReverseTripCheck({ config, logger });
    await recordScheduleCheck();
  }, SCHEDULE_CHECK_MS);
  logger.info(
    { runAt: config.SCHEDULE_CRON_TIME, timezone: config.APP_TIMEZONE, daysAhead: config.SCHEDULE_DAYS_AHEAD, checkEveryMs: SCHEDULE_CHECK_MS },
    'Daily schedule generation enabled',
  );
  if (config.SIMULATION_ENABLED) {
    loop('simulation', async () => {
      const result = await runSimulationTick({ config, logger, geo });
      await recordSimulationTick(result);
    }, config.SIMULATION_TICK_MS);
    logger.info({ tickMs: config.SIMULATION_TICK_MS }, 'Location simulation enabled');
  } else {
    // warn, not info: with simulation off nothing moves unless real devices report positions.
    logger.warn('Location simulation disabled (set SIMULATION_ENABLED=true to enable)');
  }

  // Stops the loops and hands the lease over at once (instead of after it expires).
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeatTimer);
    loops.forEach((l) => l.stop());
    await releaseLease(LEASE_NAME, owner).catch((err) => logger.warn({ err: { message: err.message } }, 'Lease release failed'));
    logger.info('Worker jobs stopped');
  };
  return { stop };
}

// Standalone worker process: `npm run start:worker`.
async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  await connectMongo(config.MONGODB_URI, logger);
  await ensureIndexes();
  const worker = await startWorker({ config, logger, geo: createGeoService(config, logger) });
  if (!worker) {
    await disconnectMongo();
    return;
  }
  const shutdown = async (signal) => {
    logger.info({ signal }, 'Worker shutting down');
    try {
      await worker.stop();
      await disconnectMongo();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Worker failed to start:', err.message);
    process.exit(1);
  });
}
