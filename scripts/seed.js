#!/usr/bin/env node
// Seeds the canonical roles and the default admin (DEFAULT_ADMIN_* in .env). The API also
// does this on startup; this script is for preparing a database before the first deploy.
// SEED_SUPERADMIN_EMAIL / SEED_SUPERADMIN_PASSWORD / SEED_SUPERADMIN_NAME are still accepted.
// The password is read from the environment only and never printed.
import 'dotenv/config';
import mongoose from 'mongoose';
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/config/logger.js';
import { ensureIndexes } from '../src/models/index.js';
import { ensureDefaultRoles } from '../src/services/roles.js';
import { ensureDefaultAdmin } from '../src/services/defaultAdmin.js';

async function main() {
  const env = { ...process.env };
  if (!env.DEFAULT_ADMIN_EMAIL && env.SEED_SUPERADMIN_EMAIL) {
    env.DEFAULT_ADMIN_EMAIL = env.SEED_SUPERADMIN_EMAIL;
    env.DEFAULT_ADMIN_PASSWORD = env.SEED_SUPERADMIN_PASSWORD;
    env.DEFAULT_ADMIN_NAME = env.SEED_SUPERADMIN_NAME || 'Superadmin';
    env.DEFAULT_ADMIN_ROLE = 'superadmin';
  }
  const config = loadConfig(env);
  await mongoose.connect(config.MONGODB_URI);
  await ensureIndexes();
  await ensureDefaultRoles();
  console.log('Roles ensured');

  const { status } = await ensureDefaultAdmin(config, createLogger('silent'));
  console.log(
    {
      created: 'Default admin created',
      exists: 'Default admin email already exists; not modified',
      not_configured: 'No default admin configured (set DEFAULT_ADMIN_EMAIL and DEFAULT_ADMIN_PASSWORD)',
    }[status],
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
