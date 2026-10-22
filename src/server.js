import http from 'node:http';
import { loadConfig } from './config/index.js';
import { createLogger } from './config/logger.js';
import { connectMongo, disconnectMongo } from './db.js';
import { ensureIndexes } from './models/index.js';
import { ensureDefaultRoles } from './services/roles.js';
import { ensureDefaultAdmin } from './services/defaultAdmin.js';
import { createGeoService } from './services/geo.js';
import { createStorage } from './services/storage.js';
import { createApp } from './app.js';
import { createSocketServer } from './sockets/index.js';
import { startWorker } from './worker.js';
import { startKeepAlive } from './services/keepAlive.js';

export async function startServer(env = process.env) {
  const config = loadConfig(env);
  const logger = createLogger(config.LOG_LEVEL);

  await connectMongo(config.MONGODB_URI, logger);
  await ensureIndexes();
  await ensureDefaultRoles();
  await ensureDefaultAdmin(config, logger);

  const ctx = { config, logger, geo: createGeoService(config, logger), storage: await createStorage(config) };
  const app = createApp(ctx);
  const server = http.createServer(app);
  // Keep-alive longer than typical load balancer idle timeouts (Render/Railway ~60s).
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  const io = createSocketServer(server, ctx);

  await new Promise((resolve) => server.listen(config.PORT, resolve));
  logger.info({ port: server.address().port, env: config.NODE_ENV }, 'API listening');

  // RUN_WORKER=true: run the scheduler/simulation in this process too (one service on hosts
  // without background workers). The lease still allows only one active worker overall.
  const worker = config.RUN_WORKER ? await startWorker({ config, logger, geo: ctx.geo }) : null;
  const keepAlive = config.KEEP_ALIVE_ENABLED
    ? startKeepAlive({ url: config.keepAliveUrl, intervalMinutes: config.KEEP_ALIVE_INTERVAL_MINUTES, logger })
    : null;

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    keepAlive?.stop();
    await worker?.stop();
    io.close();
    await new Promise((resolve) => server.close(resolve));
    await disconnectMongo();
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { server, io, ctx };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((err) => {
    // Configuration errors are reported without echoing any env values.
    // eslint-disable-next-line no-console
    console.error('API failed to start:', err.message);
    process.exit(1);
  });
}
