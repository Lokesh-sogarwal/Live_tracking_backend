import { BusLocation, LocationEvent } from '../models/index.js';
import { busRoom, emitTo } from './realtime.js';
import { markEmitted } from './locationRelay.js';
import { badRequest, conflict } from '../utils/errors.js';
import { isValidLat, isValidLng } from './geo.js';

// Freshness rules:
//  - recordedAt older than LOCATION_STALE_SECONDS is rejected as stale;
//  - recordedAt more than LOCATION_MAX_FUTURE_SKEW_SECONDS ahead of the server is rejected;
//  - an update older than the stored one is rejected (out-of-order delivery).
export async function recordLocation({ bus, lat, lng, recordedAt = new Date(), source, schedule = null }, config) {
  if (!isValidLat(lat) || !isValidLng(lng)) throw badRequest('latitude must be within [-90, 90] and longitude within [-180, 180]');
  if (lat === 0 && lng === 0) throw badRequest('Coordinates (0, 0) are not a valid bus position');

  const now = Date.now();
  const at = recordedAt instanceof Date ? recordedAt : new Date(recordedAt);
  if (Number.isNaN(at.getTime())) throw badRequest('Invalid timestamp');
  if (at.getTime() > now + config.LOCATION_MAX_FUTURE_SKEW_SECONDS * 1000) throw badRequest('Timestamp is in the future');
  if (at.getTime() < now - config.LOCATION_STALE_SECONDS * 1000) throw badRequest('Location update is stale');

  const set = {
    bus: bus._id,
    busId: bus.busId,
    location: { type: 'Point', coordinates: [lng, lat] },
    recordedAt: at,
    source,
    schedule: schedule?._id ?? null,
    scheduleId: schedule?.scheduleId ?? null,
  };

  const updated = await BusLocation.findOneAndUpdate({ busId: bus.busId, recordedAt: { $lt: at } }, { $set: set }, { new: true });
  let doc = updated;
  if (!doc) {
    try {
      doc = await BusLocation.create(set);
    } catch (err) {
      if (err.code === 11000) throw conflict('A newer location is already recorded for this bus');
      throw err;
    }
  }

  if (config.LOCATION_HISTORY_ENABLED) {
    await LocationEvent.create({
      busId: bus.busId,
      location: set.location,
      recordedAt: at,
      source,
      expiresAt: new Date(now + config.LOCATION_HISTORY_TTL_DAYS * 86400_000),
    });
  }

  // Only positions this process actually delivered are marked; otherwise the API's relay
  // (src/services/locationRelay.js) picks them up.
  if (emitTo(busRoom(bus.busId), 'bus:location', serializeLocation(doc, config))) markEmitted(bus.busId, doc.recordedAt);
  return doc;
}

export function serializeLocation(loc, config) {
  const [lng, lat] = loc.location.coordinates;
  const ageSeconds = Math.max(0, Math.round((Date.now() - new Date(loc.recordedAt).getTime()) / 1000));
  return {
    bus_id: loc.busId,
    latitude: lat,
    longitude: lng,
    timestamp: new Date(loc.recordedAt).toISOString(),
    age_seconds: ageSeconds,
    is_stale: ageSeconds > config.LOCATION_STALE_SECONDS,
    source: loc.source,
    // Which trip produced this position (on every payload, REST and socket), so a client never
    // shows one trip's position as another's. A bus keeps its last position after a trip ends;
    // without this the next, not-yet-started trip appeared at the previous trip's destination.
    schedule_id: loc.scheduleId ?? (loc.schedule && typeof loc.schedule === 'object' ? loc.schedule.scheduleId ?? null : null),
    // Whether that trip has finished (only when the trip was looked up, i.e. on REST reads).
    ...(loc.schedule && typeof loc.schedule === 'object' && 'isReached' in loc.schedule ? { trip_completed: Boolean(loc.schedule.isReached) } : {}),
  };
}
