import { BusLocation } from '../models/index.js';
import { busRoom } from './realtime.js';
import { serializeLocation } from './locations.js';

// Positions written by another process (the simulation worker, another API instance)
// cannot be emitted by that process to this process's sockets. Each API process
// therefore polls busLocations for rows updated since its last check and emits
// "bus:location" to its own subscribers. It only queries while somebody is subscribed,
// and it works on standalone MongoDB (no change streams or pub/sub adapter needed).

const lastEmitted = new Map(); // busId -> recordedAt (ms) last delivered by this process

// Called for positions this process emitted directly, so the relay doesn't repeat them.
export function markEmitted(busId, recordedAt) {
  lastEmitted.set(busId, new Date(recordedAt).getTime());
}

// recordedAt (ms) this process last delivered for a bus (or undefined).
export const lastEmittedAt = (busId) => lastEmitted.get(busId);

export function subscribedBusIds(io) {
  const ids = [];
  for (const [room, members] of io.of('/').adapter.rooms) {
    if (room.startsWith('bus_') && members.size > 0) ids.push(Number(room.slice(4)));
  }
  return ids.filter(Number.isInteger);
}

export function startLocationRelay(io, { config, logger, intervalMs = 1000 }) {
  let cursor = new Date();
  let timer = null;
  let stopped = false;

  const tick = async () => {
    timer = null;
    if (stopped) return;
    try {
      const busIds = subscribedBusIds(io);
      if (busIds.length) {
        // The trip lookup gives schedule_id even for positions stored without scheduleId
        // (written before it existed, or by a worker still running older code).
        const rows = await BusLocation.find({ busId: { $in: busIds }, updatedAt: { $gte: cursor } })
          .sort({ updatedAt: 1 })
          .limit(1000)
          .populate('schedule', 'scheduleId isReached')
          .lean();
        for (const loc of rows) {
          if (loc.updatedAt > cursor) cursor = loc.updatedAt;
          const at = new Date(loc.recordedAt).getTime();
          if (lastEmitted.get(loc.busId) === at) continue; // already delivered
          lastEmitted.set(loc.busId, at);
          io.to(busRoom(loc.busId)).emit('bus:location', serializeLocation(loc, config));
        }
      } else {
        // Nobody listening: don't replay a backlog when someone subscribes later.
        cursor = new Date();
      }
    } catch (err) {
      logger.warn({ err: { message: err.message } }, 'Location relay tick failed');
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
