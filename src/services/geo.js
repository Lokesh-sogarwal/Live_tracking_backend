import { RouteGeometry } from '../models/index.js';
import { fetchWithRetry } from '../utils/http.js';
import { upstreamError } from '../utils/errors.js';

const GEOMETRY_TTL_MS = 7 * 24 * 3600 * 1000;
const FALLBACK_TTL_MS = 10 * 60 * 1000;
// Metres between two [lng, lat] points.
const distanceMeters = ([lng1, lat1], [lng2, lat2]) => haversineMeters(lat1, lng1, lat2, lng2);

// Road geometry snaps to the nearest road, so its ends may sit a little away from the stop.
const ENDPOINT_TOLERANCE_M = 2000;

// Returns the geometry running start -> end with only valid [lng, lat] points, flipped if it
// was stored the other way round, or null if it does not connect the two points at all.
export function orientGeometry(geometry, start, end) {
  const coords = (geometry?.coordinates || []).filter(
    (c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) && isValidLng(c[0]) && isValidLat(c[1]),
  );
  if (coords.length < 2) return null;
  const s = [start.lng, start.lat];
  const e = [end.lng, end.lat];
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (distanceMeters(first, s) <= ENDPOINT_TOLERANCE_M && distanceMeters(last, e) <= ENDPOINT_TOLERANCE_M) {
    return { ...geometry, coordinates: coords };
  }
  if (distanceMeters(first, e) <= ENDPOINT_TOLERANCE_M && distanceMeters(last, s) <= ENDPOINT_TOLERANCE_M) {
    return { ...geometry, coordinates: [...coords].reverse() };
  }
  return null;
}

const FALLBACK_SPEED_MPS = 30_000 / 3600; // legacy fallback assumed 30 km/h
const FALLBACK_STEP_METERS = 100;
const FALLBACK_MAX_SEGMENTS = 300;

export const isValidLat = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
export const isValidLng = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dphi = toRad(lat2 - lat1);
  const dl = toRad(lng2 - lng1);
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dl / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Nominatim's usage policy allows at most 1 request/second per application.
let nominatimChain = Promise.resolve();
function throttleNominatim(fn) {
  const run = nominatimChain.then(fn);
  nominatimChain = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1100)));
  return run;
}

const geocodeCache = new Map();
const GEOCODE_CACHE_MAX = 500;
const GEOCODE_CACHE_MS = 3600 * 1000;

export function createGeoService(config, logger) {
  const httpOpts = { timeoutMs: config.EXTERNAL_HTTP_TIMEOUT_MS, retries: config.EXTERNAL_HTTP_RETRIES };
  const nominatimHeaders = { 'User-Agent': config.GEO_USER_AGENT, Accept: 'application/json' };

  async function nominatim(path, params) {
    const url = new URL(path, config.NOMINATIM_BASE_URL);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    return throttleNominatim(async () => {
      const res = await fetchWithRetry(url, { ...httpOpts, headers: nominatimHeaders });
      if (!res.ok) throw new Error(`Nominatim responded ${res.status}`);
      return res.json();
    });
  }

  // Returns { lat, lng } or null. Mirrors legacy geocode_place().
  async function geocodePlace(place) {
    const key = place.trim().toLowerCase();
    const hit = geocodeCache.get(key);
    if (hit && Date.now() - hit.at < GEOCODE_CACHE_MS) return hit.value;
    try {
      const data = await nominatim('/search', { q: place, format: 'json', limit: 1 });
      const value = Array.isArray(data) && data[0] ? { lat: Number(data[0].lat), lng: Number(data[0].lon) } : null;
      const ok = value && isValidLat(value.lat) && isValidLng(value.lng);
      if (geocodeCache.size >= GEOCODE_CACHE_MAX) geocodeCache.delete(geocodeCache.keys().next().value);
      geocodeCache.set(key, { at: Date.now(), value: ok ? value : null });
      return ok ? value : null;
    } catch (err) {
      // Service failure (403/5xx/timeout) is not "place not found": surface it as 502 so the
      // user is not told their input is wrong, and do not cache it.
      logger.warn({ err: { message: err.message } }, 'Geocoding failed');
      throw upstreamError('Geocoding service unavailable, please try again later');
    }
  }

  const searchRaw = (address) => nominatim('/search', { format: 'json', q: address, limit: 1 });
  const reverseRaw = (lat, lng) => nominatim('/reverse', { format: 'json', lat, lon: lng, zoom: 18, addressdetails: 1 });

  // Straight line, densified so the simulation advances in small steps instead of jumping
  // from start to end in one tick (a 2-point line finished every trip in 2 ticks).
  function fallbackGeometry(start, end) {
    const distance = haversineMeters(start.lat, start.lng, end.lat, end.lng);
    const segments = Math.min(FALLBACK_MAX_SEGMENTS, Math.max(1, Math.ceil(distance / FALLBACK_STEP_METERS)));
    const coordinates = [];
    for (let i = 0; i <= segments; i += 1) {
      const f = i / segments;
      coordinates.push([
        Number((start.lng + (end.lng - start.lng) * f).toFixed(7)),
        Number((start.lat + (end.lat - start.lat) * f).toFixed(7)),
      ]);
    }
    coordinates[segments] = [end.lng, end.lat];
    return {
      coordinates,
      distanceMeters: Math.round(distance),
      durationSeconds: distance > 0 ? Math.round(distance / FALLBACK_SPEED_MPS) : 0,
      provider: 'fallback',
    };
  }

  async function fetchOrs(start, end) {
    const res = await fetchWithRetry(`${config.ORS_BASE_URL}/v2/directions/driving-car/geojson`, {
      ...httpOpts,
      method: 'POST',
      headers: { Authorization: config.ORS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: [[start.lng, start.lat], [end.lng, end.lat]], instructions: false }),
    });
    if (!res.ok) throw new Error(`ORS responded ${res.status}`);
    const data = await res.json();
    const feature = data?.features?.[0];
    const coords = feature?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) throw new Error('ORS returned no geometry');
    return {
      coordinates: coords.map(([lng, lat]) => [lng, lat]),
      distanceMeters: feature.properties?.summary?.distance ?? null,
      durationSeconds: feature.properties?.summary?.duration ?? null,
      provider: 'ors',
    };
  }

  // Road geometry between two points as [lng, lat] pairs. Cached in Mongo so the API and
  // the worker share one ORS call per pair; failures fall back to a straight line.
  // Every result (fresh or cached) is checked to run start -> end; see orientGeometry().
  async function getRouteGeometry(start, end) {
    const key = [start.lng, start.lat, end.lng, end.lat].map((n) => n.toFixed(6)).join(',');
    const cached = await RouteGeometry.findOne({ key, expiresAt: { $gt: new Date() } }).lean();
    if (cached) {
      const oriented = orientGeometry(cached, start, end);
      if (oriented) return oriented;
      logger.warn({ key }, 'Cached route geometry does not connect its endpoints; rebuilding');
    }

    let geometry;
    if (start.lat === end.lat && start.lng === end.lng) {
      geometry = fallbackGeometry(start, end);
    } else if (!config.ORS_API_KEY) {
      logger.warn('ORS_API_KEY not configured; using straight-line route fallback');
      geometry = fallbackGeometry(start, end);
    } else {
      try {
        geometry = await fetchOrs(start, end);
      } catch (err) {
        logger.warn({ err: { message: err.message } }, 'ORS directions failed; using fallback');
        geometry = fallbackGeometry(start, end);
      }
    }
    const oriented = orientGeometry(geometry, start, end);
    if (!oriented) {
      logger.warn({ provider: geometry.provider }, 'Route geometry does not connect its endpoints; using fallback');
      geometry = fallbackGeometry(start, end);
    } else geometry = oriented;
    const ttl = geometry.provider === 'ors' ? GEOMETRY_TTL_MS : FALLBACK_TTL_MS;
    return RouteGeometry.findOneAndUpdate(
      { key },
      { $set: { ...geometry, fetchedAt: new Date(), expiresAt: new Date(Date.now() + ttl) } },
      { upsert: true, new: true, lean: true },
    );
  }

  return { geocodePlace, searchRaw, reverseRaw, getRouteGeometry };
}
