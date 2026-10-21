// Socket.IO + MongoDB observer for the simulation run. Never writes to the database.
// At DROP_AT seconds it drops the transport to test reconnection/recovery.
import { io } from 'socket.io-client';
import { MongoClient } from 'mongodb';
import { writeFileSync } from 'node:fs';

const API = 'http://127.0.0.1:5096';
const SECONDS = Number(process.env.SECONDS || 150);
const DROP_AT = Number(process.env.DROP_AT || 30);
const token = (await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'sim-root@example.com', password: 'Sim-Root-Pass-1' }) })).json()).token;
const mongo = await MongoClient.connect('mongodb://127.0.0.1:27097');
const db = mongo.db('lt_sim');

const log = [];
const t0 = Date.now();
const rel = () => Math.round((Date.now() - t0) / 100) / 10;
const s = io(API, { auth: { token }, transports: ['websocket'], reconnectionDelay: 500 });
s.on('connect', () => {
  log.push({ t: rel(), type: 'connect', recovered: s.recovered });
  // Documented contract: re-subscribe after a reconnect that was not recovered (e.g. server restart).
  if (!s.recovered) for (const busId of [1, 2, 3]) s.emit('bus:subscribe', { busId }, (a) => log.push({ t: rel(), type: 'subscribe', busId, ok: a?.ok }));
});
s.on('disconnect', (reason) => log.push({ t: rel(), type: 'disconnect', reason }));
s.on('bus:location', (p) => log.push({ t: rel(), type: 'bus:location', bus: p.bus_id, lat: p.latitude, lng: p.longitude, source: p.source, stale: p.is_stale, ts: p.timestamp }));
setTimeout(() => { log.push({ t: rel(), type: 'force transport drop' }); s.io.engine.close(); }, DROP_AT * 1000);

const samples = [];
while (Date.now() - t0 < SECONDS * 1000) {
  const locs = await db.collection('busLocations').find({}, { projection: { _id: 0, busId: 1, 'location.coordinates': 1, recordedAt: 1, source: 1 } }).toArray();
  const trips = await db.collection('schedules').find({}, { projection: { _id: 0, scheduleId: 1, currentIndex: 1, isReached: 1, status: 1 } }).toArray();
  samples.push({ t: rel(), locs, trips });
  await new Promise((r) => setTimeout(r, 1000));
}
s.disconnect();
const lease = await db.collection('jobLocks').findOne({});
const runs = await db.collection('jobRuns').find({}, { projection: { _id: 0 } }).toArray();
const geo = await db.collection('routeGeometries').find({}, { projection: { _id: 0, provider: 1, n: { $size: '$coordinates' } } }).toArray();
await mongo.close();
writeFileSync(process.env.OUT + '/observer.json', JSON.stringify({ log, samples, lease, runs, geo }, null, 1));
console.log('observer done', log.filter((e) => e.type === 'bus:location').length, 'events');
