#!/usr/bin/env node
// SQL (MySQL / PostgreSQL) -> MongoDB migration for the Live Tracking backend.
//
// Dry-run is the default; nothing is written unless --apply is passed. The source is
// opened read-only and never modified. Re-running is safe (upserts keyed on legacy ids);
// --resume <runId> skips tables a previous run already completed.
//
// Usage:
//   SOURCE_DATABASE_URL=mysql://... MONGODB_URI=mongodb+srv://... \
//     node scripts/migrate-sql-to-mongo.js --source mysql [--apply] [--source-tz Asia/Kolkata] \
//       [--uploads-dir /path/to/legacy/uploads] [--report report.json] [--resume <runId>]
//   node scripts/migrate-sql-to-mongo.js --source json --json-dir ./fixtures   (synthetic data)
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import 'dotenv/config';
import mongoose from 'mongoose';
import { ensureIndexes } from '../src/models/index.js';
import { createStorage } from '../src/services/storage.js';
import { openSource } from '../src/migration/sources.js';
import { migrate, summarize } from '../src/migration/sqlToMongo.js';
import { loadConfig } from '../src/config/index.js';

const { values: args } = parseArgs({
  options: {
    source: { type: 'string' },
    'json-dir': { type: 'string' },
    apply: { type: 'boolean', default: false },
    'source-tz': { type: 'string', default: 'Asia/Kolkata' },
    'uploads-dir': { type: 'string' },
    report: { type: 'string', default: 'migration-report.json' },
    resume: { type: 'string' },
    'i-have-a-verified-backup': { type: 'boolean', default: false },
  },
});

async function main() {
  if (!args.source) throw new Error('--source is required (mysql | postgres | json)');
  if (args.apply && args.source !== 'json' && !args['i-have-a-verified-backup']) {
    throw new Error('--apply against a real database requires --i-have-a-verified-backup (see docs/MIGRATION_PLAN.md)');
  }
  const target = args.source === 'json' ? args['json-dir'] : process.env.SOURCE_DATABASE_URL;
  if (!target) throw new Error(args.source === 'json' ? '--json-dir is required' : 'SOURCE_DATABASE_URL is required');

  const config = loadConfig({ JWT_SECRET: 'unused-by-migration', ...process.env });
  await mongoose.connect(config.MONGODB_URI);
  await ensureIndexes();
  const source = await openSource(args.source, target);
  try {
    const report = await migrate({
      source,
      apply: args.apply,
      sourceTz: args['source-tz'],
      uploadsDir: args['uploads-dir'],
      storage: await createStorage(config),
      resumeRunId: args.resume,
      logger: { info: (m) => console.error(m) },
    });
    // Full detail (rejected ids + reasons) goes to the report file; no row contents are logged.
    await writeFile(args.report, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(summarize(report), null, 2));
    console.log(`Full report written to ${args.report}`);
    const failed = report.reconciliation && Object.values(report.reconciliation).some((r) => r && r.ok === false);
    process.exitCode = failed ? 2 : 0;
  } finally {
    await source.close();
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
