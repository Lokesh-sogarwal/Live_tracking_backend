import { DateTime } from 'luxon';
import { JobRun } from '../models/index.js';
import { createReverseTrips, generateDailySchedules } from '../services/schedules.js';
import { addDays, todayInTz } from '../utils/time.js';

// Daily timetable generation, run by the worker (src/worker.js), never by the API.
//
// Every day at SCHEDULE_CRON_TIME (default 00:00) in APP_TIMEZONE (default Asia/Kolkata) the
// leader worker (re)fills the window today .. today + SCHEDULE_DAYS_AHEAD. Generation is
// idempotent (unique index + upsert), so re-filling the whole window is safe and also picks up
// routes, buses and drivers added since the last run.
//
// Reliability:
//  - the worker checks every 30 s; the first check after the run time does the run;
//  - one successful run per local date (jobRuns, key = date); a missed run (worker down at
//    midnight) is done as soon as the worker is back (SCHEDULE_CATCHUP_ON_START);
//  - each run is claimed atomically, so two workers can't run it at once even without the lease;
//  - failures are retried (3 attempts), then again after a cool-down — never silently given up.
const JOB = 'daily-schedules';
const MAX_ATTEMPTS = 3;
const LEGACY_GRACE_MINUTES = 5; // APScheduler misfire_grace_time=300 in the legacy job
const SKIPPED_RECHECK_MS = 10 * 60 * 1000;
const FAILED_COOLDOWN_MS = 30 * 60 * 1000;
const STALE_RUNNING_MS = 10 * 60 * 1000; // a run left "running" by a crashed worker

// Decides whether today's run is due. With catch-up disabled the legacy behaviour is kept:
// a run missed by more than the grace period is skipped until tomorrow.
export function isDue(now, { tz, cronTime, catchUp }) {
  const [h, m] = cronTime.split(':').map(Number);
  const local = DateTime.fromJSDate(now, { zone: tz });
  const target = local.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (local < target) return false;
  return catchUp || local.diff(target, 'minutes').minutes <= LEGACY_GRACE_MINUTES;
}

export const windowDates = (today, daysAhead) => Array.from({ length: daysAhead + 1 }, (_, i) => addDays(today, i));

// Atomically marks the run as ours. Returns false if another process is running it now.
async function claim(today, now, owner) {
  try {
    await JobRun.findOneAndUpdate(
      { job: JOB, runKey: today, $or: [{ status: { $ne: 'running' } }, { startedAt: { $lt: new Date(now.getTime() - STALE_RUNNING_MS) } }] },
      { $set: { status: 'running', startedAt: now, owner }, $inc: { attempts: 1 } },
      { upsert: true },
    );
    return true;
  } catch (err) {
    if (err.code === 11000) return false; // the run exists and is "running" elsewhere
    throw err;
  }
}

export async function runDailyScheduleJob({ now = new Date(), config, logger, force = false, owner = 'worker' }) {
  const tz = config.APP_TIMEZONE;
  const today = todayInTz(tz, now);
  if (!force && !isDue(now, { tz, cronTime: config.SCHEDULE_CRON_TIME, catchUp: config.SCHEDULE_CATCHUP_ON_START })) {
    return { ran: false, reason: 'not_due' };
  }

  const existing = await JobRun.findOne({ job: JOB, runKey: today }).lean();
  if (!force) {
    if (existing?.status === 'succeeded') return { ran: false, reason: 'already_succeeded' };
    if (existing?.status === 'failed' && existing.attempts >= MAX_ATTEMPTS && now - new Date(existing.finishedAt) < FAILED_COOLDOWN_MS) {
      return { ran: false, reason: 'max_attempts' };
    }
    // A day skipped for missing routes/buses/drivers is re-checked periodically.
    if (existing?.status === 'skipped' && now - new Date(existing.finishedAt) < SKIPPED_RECHECK_MS) {
      return { ran: false, reason: 'skipped_recently' };
    }
  }
  if (existing?.status === 'failed' && existing.attempts >= MAX_ATTEMPTS) {
    await JobRun.updateOne({ job: JOB, runKey: today }, { $set: { attempts: 0 } }); // cool-down over
  }
  if (!(await claim(today, now, owner))) return { ran: false, reason: 'running_elsewhere' };

  const dates = windowDates(today, config.SCHEDULE_DAYS_AHEAD);
  const started = Date.now();
  const totals = { from: dates[0], to: dates.at(-1), days: dates.length, created: 0, existing: 0, reverseCreated: 0, conflicts: 0, invalidRoutes: 0, failedDates: [], skipped: false };
  for (const date of dates) {
    try {
      const r = await generateDailySchedules(date, { tz, logger });
      if (r.skipped) {
        totals.skipped = true;
        break; // no routes/buses/drivers: the same for every date
      }
      for (const k of ['created', 'existing', 'reverseCreated', 'conflicts', 'invalidRoutes']) totals[k] += r[k] || 0;
    } catch (err) {
      totals.failedDates.push(date);
      logger.error({ err: { message: err.message }, date }, 'Schedule generation failed for date');
    }
  }
  totals.durationMs = Date.now() - started;

  const status = totals.failedDates.length ? 'failed' : totals.skipped ? 'skipped' : 'succeeded';
  // Only failures consume the retry budget; a skipped day keeps its re-checks available.
  await JobRun.updateOne(
    { job: JOB, runKey: today },
    { $set: { status, finishedAt: now, result: totals, error: totals.failedDates.length ? `failed dates: ${totals.failedDates.join(', ')}` : null, ...(status === 'skipped' ? { attempts: 0 } : {}) } },
  );
  logger[status === 'failed' ? 'error' : 'info']({ runAt: now.toISOString(), today, ...totals, status }, 'Schedule window run finished');
  return { ran: true, status, result: totals };
}

// Every check: create today's return trips whose outbound trip has finished.
export async function runReverseTripCheck({ now = new Date(), config, logger }) {
  return createReverseTrips(todayInTz(config.APP_TIMEZONE, now), { logger });
}
