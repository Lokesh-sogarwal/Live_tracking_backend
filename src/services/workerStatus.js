import { WorkerStatus } from '../models/index.js';

// Liveness of the background worker as seen by the API. The leader worker writes a heartbeat
// every 10 s; HEARTBEAT_STALE_MS without one means no worker is running jobs (stopped,
// crashed, or unable to reach the database).
const ID = 'worker';
export const HEARTBEAT_STALE_MS = 45_000;

export const recordHeartbeat = ({ instance, startedAt, simulationEnabled, simulationTickMs }, now = new Date()) =>
  WorkerStatus.updateOne({ _id: ID }, { $set: { instance, startedAt, heartbeatAt: now, simulationEnabled, simulationTickMs } }, { upsert: true });

export const recordSimulationTick = (result, now = new Date()) =>
  WorkerStatus.updateOne(
    { _id: ID },
    {
      $set: {
        lastSimulationTickAt: now,
        lastSimulationMoved: result.moved,
        ...(result.lastError ? { lastError: { at: now, job: 'simulation', ...result.lastError } } : {}),
      },
    },
    { upsert: true },
  );

export const recordScheduleCheck = (now = new Date()) => WorkerStatus.updateOne({ _id: ID }, { $set: { lastScheduleCheckAt: now } }, { upsert: true });

export const recordWorkerError = (job, err, now = new Date()) =>
  WorkerStatus.updateOne({ _id: ID }, { $set: { lastError: { at: now, job, message: String(err?.message || err).slice(0, 300) } } }, { upsert: true });

const iso = (d) => (d ? new Date(d).toISOString() : null);

// What GET /view/tracking_status returns: enough to say *why* positions aren't moving.
export async function readTrackingStatus(config, now = new Date()) {
  const s = await WorkerStatus.findById(ID).lean();
  const running = Boolean(s?.heartbeatAt && now - new Date(s.heartbeatAt) <= HEARTBEAT_STALE_MS);
  const tickMs = s?.simulationTickMs || null;
  const recentError = s?.lastError?.at && now - new Date(s.lastError.at) <= 10 * 60_000 ? s.lastError : null;
  return {
    worker: { running, last_heartbeat_at: iso(s?.heartbeatAt), started_at: running ? iso(s?.startedAt) : null },
    simulation: {
      enabled: s ? Boolean(s.simulationEnabled) : null, // null: no worker has ever reported
      tick_ms: tickMs,
      last_tick_at: iso(s?.lastSimulationTickAt),
      buses_moved_last_tick: s?.lastSimulationMoved ?? null,
    },
    stale_after_seconds: config.LOCATION_STALE_SECONDS,
    last_error: recentError ? { at: iso(recentError.at), job: recentError.job, message: recentError.message, bus_id: recentError.busId ?? null, schedule_id: recentError.scheduleId ?? null } : null,
  };
}
