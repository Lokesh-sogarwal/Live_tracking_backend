import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { DateTime } from 'luxon';
import {
  Bus, BusLocation, ChatMessage, Counter, DriverDocument, Feedback, Notification, Role, RolePermission,
  Route, Schedule, Stop, User,
} from '../models/index.js';
import { DEFAULT_ROLES, ensureDefaultRoles, normalizeRole } from '../services/roles.js';
import { conversationKey } from '../services/realtime.js';
import { sniffFile } from '../utils/fileSniff.js';

// Legacy table names (SQLAlchemy __tablename__; Active_user has no explicit name).
export const TABLES = [
  'roles', 'users', 'user_roles', 'role_permissions', 'active_user', 'buses', 'routes', 'stops',
  'schedules', 'bus_locations', 'driver_documents', 'notifications', 'feedback', 'chat_messages',
];

const MigrationRun = mongoose.models.MigrationRun
  || mongoose.model(
    'MigrationRun',
    new mongoose.Schema({ runId: { type: String, unique: true }, mode: String, startedAt: Date, finishedAt: Date, tables: mongoose.Schema.Types.Mixed, report: mongoose.Schema.Types.Mixed }),
    'migrationRuns',
  );

const bool = (v) => v === true || v === 1 || v === '1' || v === 't' || v === 'true';
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const validLat = (v) => Number.isFinite(v) && v >= -90 && v <= 90;
const validLng = (v) => Number.isFinite(v) && v >= -180 && v <= 180;

function makeTimeParser(sourceTz) {
  return (v) => {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return v;
    const s = String(v).trim();
    let dt = DateTime.fromSQL(s, { zone: sourceTz });
    if (!dt.isValid) dt = DateTime.fromISO(s, { zone: sourceTz });
    return dt.isValid ? dt.toJSDate() : undefined;
  };
}

class Report {
  constructor(mode) {
    this.mode = mode;
    this.tables = {};
  }

  table(name) {
    this.tables[name] ??= { source: 0, valid: 0, inserted: 0, updated: 0, unchanged: 0, rejected: [], duplicates: [], warnings: [], skipped: false };
    return this.tables[name];
  }

  reject(name, id, reason) {
    this.table(name).rejected.push({ id, reason });
  }
}

// Upsert keyed on the legacy id. Returns 'inserted' | 'updated' | 'unchanged' (or 'planned' in dry-run).
async function upsert(Model, filter, doc, apply) {
  if (!apply) return (await Model.exists(filter)) ? 'updated' : 'inserted';
  const update = { $set: doc };
  if (!doc.createdAt) {
    const now = new Date();
    update.$setOnInsert = { createdAt: now, updatedAt: now };
  }
  const res = await Model.updateOne(filter, update, { upsert: true, timestamps: false, runValidators: true, strict: true });
  if (res.upsertedCount) return 'inserted';
  return res.modifiedCount ? 'updated' : 'unchanged';
}

export async function migrate({ source, apply = false, sourceTz = 'Asia/Kolkata', uploadsDir, storage, resumeRunId, logger = console }) {
  const report = new Report(apply ? 'apply' : 'dry-run');
  const parseTime = makeTimeParser(sourceTz);
  const runId = resumeRunId || randomUUID();
  const prior = resumeRunId ? await MigrationRun.findOne({ runId }).lean() : null;
  const done = new Set(Object.entries(prior?.tables ?? {}).filter(([, v]) => v === 'completed').map(([k]) => k));
  if (apply) {
    await ensureDefaultRoles();
    await MigrationRun.updateOne({ runId }, { $set: { mode: 'apply' }, $setOnInsert: { startedAt: new Date(), tables: {} } }, { upsert: true });
  }

  const rows = {};
  for (const t of TABLES) {
    rows[t] = await source.readTable(t);
    if (rows[t] === null) {
      report.table(t).warnings.push('table not found in source');
      rows[t] = [];
    }
    report.table(t).source = rows[t].length;
  }

  const step = async (name, fn) => {
    if (done.has(name)) {
      report.table(name).skipped = 'completed in resumed run';
      return;
    }
    await fn(report.table(name));
    if (apply) await MigrationRun.updateOne({ runId }, { $set: { [`tables.${name}`]: 'completed' } });
  };
  const tally = (t, outcome) => {
    t.valid += 1;
    t[outcome] = (t[outcome] ?? 0) + 1;
  };

  // ---- roles ----
  const roleKeyById = new Map();
  await step('roles', async (t) => {
    for (const r of rows.roles) {
      const key = normalizeRole(r.role_name);
      if (!key) {
        report.reject('roles', r.role_id, 'empty role_name');
        continue;
      }
      roleKeyById.set(num(r.role_id), key);
      if (!DEFAULT_ROLES.some((d) => d.key === key)) {
        t.warnings.push(`custom role "${r.role_name}" kept as key "${key}"`);
        tally(t, await upsert(Role, { key }, { key, name: r.role_name, roleId: 100 + num(r.role_id) }, apply));
      } else {
        tally(t, 'unchanged'); // canonical role already seeded
      }
    }
  });
  if (done.has('roles')) for (const r of rows.roles) roleKeyById.set(num(r.role_id), normalizeRole(r.role_name));

  // ---- users (+ user_roles) ----
  const roleOfUser = new Map();
  const userRolesSorted = [...rows.user_roles].sort((a, b) => num(a.id) - num(b.id));
  for (const ur of userRolesSorted) {
    const uid = num(ur.user_id);
    const key = roleKeyById.get(num(ur.role_id));
    if (!key) {
      report.reject('user_roles', ur.id, `unknown role_id ${ur.role_id}`);
      continue;
    }
    if (roleOfUser.has(uid)) {
      report.table('user_roles').warnings.push(`user ${uid} has multiple roles; kept "${roleOfUser.get(uid)}", ignored "${key}"`);
      continue;
    }
    roleOfUser.set(uid, key);
    report.table('user_roles').valid += 1;
  }

  const seenEmails = new Map();
  const validUserIds = new Set();
  const userUuidByLegacy = new Map();
  await step('users', async (t) => {
    for (const u of rows.users) {
      const id = num(u.id);
      const email = String(u.email || '').trim().toLowerCase();
      if (!email || !u.fullname || !u.password) {
        report.reject('users', id, 'missing email/fullname/password');
        continue;
      }
      if (seenEmails.has(email)) {
        t.duplicates.push({ id, email, keptId: seenEmails.get(email) });
        continue;
      }
      const clash = await User.findOne({ email, legacyId: { $ne: id } }, { legacyId: 1 }).lean();
      if (clash) {
        t.duplicates.push({ id, email, reason: 'email already used by another Mongo user', mongoLegacyId: clash.legacyId ?? null });
        continue;
      }
      seenEmails.set(email, id);
      const userId = u.user_id || randomUUID();
      if (!u.user_id) t.warnings.push(`user ${id} had no user_id; generated a new UUID`);
      const createdAt = parseTime(u.date_created) || new Date();
      const doc = {
        legacyId: id,
        userId,
        fullname: String(u.fullname).slice(0, 150),
        email,
        passwordHash: u.password, // Werkzeug hash; upgraded to bcrypt on next login
        phoneNo: u.phone_no || null,
        isPasswordChange: bool(u.is_password_change),
        roleKey: roleOfUser.get(id) ?? 'passenger',
        createdAt,
        updatedAt: parseTime(u.date_updated) || createdAt,
      };
      if (!roleOfUser.has(id)) t.warnings.push(`user ${id} has no role; defaulted to passenger (legacy login behaviour)`);
      tally(t, await upsert(User, { legacyId: id }, doc, apply));
      validUserIds.add(id);
      userUuidByLegacy.set(id, userId);
    }
  });
  if (done.has('users')) {
    for (const u of rows.users) {
      validUserIds.add(num(u.id));
      if (u.user_id) userUuidByLegacy.set(num(u.id), u.user_id);
    }
  }

  // Reference resolvers: in apply mode, real ObjectIds; in dry-run, the planned ids.
  const resolver = async (Model, field, ids) => {
    const map = new Map();
    if (!apply) {
      for (const v of ids) map.set(v, `planned:${v}`);
      return map;
    }
    const docs = await Model.find({ [field]: { $in: [...ids] } }, { [field]: 1 }).lean();
    for (const d of docs) map.set(d[field], d._id);
    return map;
  };
  const userRef = await resolver(User, 'legacyId', validUserIds);
  const userRefByUuid = new Map();
  for (const [legacy, uuid] of userUuidByLegacy) if (userRef.has(legacy)) userRefByUuid.set(uuid, userRef.get(legacy));

  // ---- role_permissions ----
  await step('role_permissions', async (t) => {
    for (const p of rows.role_permissions) {
      const roleKey = roleKeyById.get(num(p.role_id));
      if (!roleKey || !p.feature_key) {
        report.reject('role_permissions', p.id, 'unknown role or empty feature_key');
        continue;
      }
      tally(t, await upsert(RolePermission, { roleKey, featureKey: p.feature_key }, { roleKey, featureKey: p.feature_key, allowed: bool(p.allowed) }, apply));
    }
  });

  report.table('active_user').skipped = 'sessions are not migrated; users sign in again after cutover';

  // ---- buses ----
  const validBusIds = new Set();
  await step('buses', async (t) => {
    const seen = new Set();
    for (const b of rows.buses) {
      const id = num(b.bus_id);
      const busNumber = String(b.bus_number || '').trim();
      if (!busNumber) {
        report.reject('buses', id, 'missing bus_number');
        continue;
      }
      if (seen.has(busNumber)) {
        t.duplicates.push({ id, bus_number: busNumber });
        continue;
      }
      seen.add(busNumber);
      tally(t, await upsert(Bus, { busId: id }, { busId: id, busNumber, capacity: num(b.capacity), operator: b.operator || null }, apply));
      validBusIds.add(id);
    }
  });
  if (done.has('buses')) rows.buses.forEach((b) => validBusIds.add(num(b.bus_id)));
  const busRef = await resolver(Bus, 'busId', validBusIds);

  // ---- routes ----
  const validRouteIds = new Set();
  await step('routes', async (t) => {
    for (const r of rows.routes) {
      const id = num(r.route_id);
      const [sLat, sLng, eLat, eLng] = [num(r.start_lat), num(r.start_lng), num(r.end_lat), num(r.end_lng)];
      if (!validLat(sLat) || !validLng(sLng) || !validLat(eLat) || !validLng(eLng)) {
        report.reject('routes', id, 'invalid coordinates');
        continue;
      }
      if (!r.route_name || !r.start_point || !r.end_point) {
        report.reject('routes', id, 'missing name/start/end');
        continue;
      }
      tally(
        t,
        await upsert(
          Route,
          { routeId: id },
          {
            routeId: id,
            routeName: r.route_name,
            startPoint: r.start_point,
            start: { type: 'Point', coordinates: [sLng, sLat] },
            endPoint: r.end_point,
            end: { type: 'Point', coordinates: [eLng, eLat] },
          },
          apply,
        ),
      );
      validRouteIds.add(id);
    }
  });
  if (done.has('routes')) rows.routes.forEach((r) => validRouteIds.add(num(r.route_id)));
  const routeRef = await resolver(Route, 'routeId', validRouteIds);

  // ---- stops ----
  const validStopIds = new Set();
  await step('stops', async (t) => {
    for (const s of rows.stops) {
      const id = num(s.stop_id);
      const lat = num(s.latitude);
      const lng = num(s.longitude);
      if (!routeRef.has(num(s.route_id))) {
        report.reject('stops', id, `route_id ${s.route_id} not migrated`);
        continue;
      }
      if (!validLat(lat) || !validLng(lng) || !s.name) {
        report.reject('stops', id, 'invalid coordinates or name');
        continue;
      }
      tally(
        t,
        await upsert(Stop, { stopId: id }, { stopId: id, route: routeRef.get(num(s.route_id)), name: s.name, location: { type: 'Point', coordinates: [lng, lat] }, sequence: Math.max(1, num(s.sequence) || 1) }, apply),
      );
      validStopIds.add(id);
    }
  });
  if (done.has('stops')) rows.stops.forEach((s) => validStopIds.add(num(s.stop_id)));
  const stopRef = await resolver(Stop, 'stopId', validStopIds);

  // ---- schedules ----
  await step('schedules', async (t) => {
    const seen = new Map();
    for (const s of rows.schedules) {
      const id = num(s.schedule_id);
      const route = routeRef.get(num(s.route_id));
      const bus = busRef.get(num(s.bus_id));
      const driver = userRef.get(num(s.driver_id));
      if (!route || !bus || !driver) {
        report.reject('schedules', id, `unresolved reference (route ${s.route_id}, bus ${s.bus_id}, driver ${s.driver_id})`);
        continue;
      }
      if (s.stop_id !== null && s.stop_id !== undefined && !stopRef.has(num(s.stop_id))) {
        report.reject('schedules', id, `stop_id ${s.stop_id} not migrated`);
        continue;
      }
      const arrivalTime = parseTime(s.arrival_time);
      const departureTime = parseTime(s.departure_time);
      const date = String(s.date || '').slice(0, 10);
      if (!arrivalTime || !departureTime || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        report.reject('schedules', id, 'invalid arrival/departure/date');
        continue;
      }
      const uniq = `${date}|${s.route_id}|${s.bus_id}|${departureTime.toISOString()}`;
      if (seen.has(uniq)) {
        t.duplicates.push({ id, keptId: seen.get(uniq), rule: '(date, route, bus, departure_time)' });
        continue;
      }
      seen.set(uniq, id);
      tally(
        t,
        await upsert(
          Schedule,
          { scheduleId: id },
          {
            scheduleId: id, route, bus, driver,
            stop: s.stop_id === null || s.stop_id === undefined ? null : stopRef.get(num(s.stop_id)),
            arrivalTime, departureTime, date,
            status: s.status || 'on_time',
            currentIndex: Math.max(0, num(s.current_index) || 0),
            isReached: bool(s.is_reached),
            direction: 'forward',
          },
          apply,
        ),
      );
    }
  });

  // ---- bus_locations ----
  await step('bus_locations', async (t) => {
    for (const l of rows.bus_locations) {
      const busId = num(l.bus_id);
      const lat = num(l.latitude);
      const lng = num(l.longitude);
      if (!busRef.has(busId)) {
        report.reject('bus_locations', l.id, `bus_id ${busId} not migrated`);
        continue;
      }
      if (!validLat(lat) || !validLng(lng)) {
        report.reject('bus_locations', l.id, 'invalid coordinates');
        continue;
      }
      tally(
        t,
        await upsert(BusLocation, { busId }, { bus: busRef.get(busId), busId, location: { type: 'Point', coordinates: [lng, lat] }, recordedAt: parseTime(l.timestamp) || new Date(0), source: 'migration' }, apply),
      );
    }
  });

  // ---- driver_documents ----
  await step('driver_documents', async (t) => {
    for (const d of rows.driver_documents) {
      const id = num(d.doc_id);
      const user = userRefByUuid.get(d.user_id);
      if (!user) {
        report.reject('driver_documents', id, `user_id ${d.user_id} not migrated`);
        continue;
      }
      const basename = path.basename(String(d.document_path || '').replace(/\\/g, '/'));
      let storageKey = `legacy/${basename || `doc-${id}`}`;
      let fileMissing = true;
      let mimeType = null;
      let sizeBytes = null;
      if (uploadsDir && basename) {
        const buf = await readFile(path.join(uploadsDir, basename)).catch(() => null);
        const detected = buf && sniffFile(buf, basename);
        if (buf && detected) {
          storageKey = `driver-docs/${d.user_id}/legacy-${id}.${detected.ext}`;
          if (apply && !(await storage.exists(storageKey))) await storage.put(storageKey, buf, detected.mime);
          fileMissing = false;
          mimeType = detected.mime;
          sizeBytes = buf.length;
        } else if (buf) {
          t.warnings.push(`doc ${id}: file content not an allowed type; metadata kept, file not copied`);
        }
      }
      if (fileMissing) t.warnings.push(`doc ${id}: file "${basename}" not available; marked file_missing`);
      tally(
        t,
        await upsert(
          DriverDocument,
          { docId: id },
          {
            docId: id, user, userId: d.user_id, documentType: d.document_type, storageKey, originalName: basename,
            mimeType, sizeBytes, fileMissing, uploadTime: parseTime(d.upload_time) || new Date(0),
            expiryDate: parseTime(d.expiry_date), isVerified: bool(d.is_verified), isRejected: bool(d.is_rejected),
          },
          apply,
        ),
      );
    }
  });

  // ---- notifications ----
  const usersByName = new Map();
  for (const u of rows.users) {
    const list = usersByName.get(u.fullname) ?? [];
    list.push(num(u.id));
    usersByName.set(u.fullname, list);
  }
  await step('notifications', async (t) => {
    for (const n of rows.notifications) {
      const id = num(n.notification_id);
      const user = userRef.get(num(n.user_id));
      if (!user || !n.message) {
        report.reject('notifications', id, `user_id ${n.user_id} not migrated or empty message`);
        continue;
      }
      // Legacy unread chat counts were derived from "New message from <fullname>".
      let sender = null;
      const m = n.type === 'chat' && /^New message from (.+)$/.exec(n.message);
      if (m) {
        const candidates = usersByName.get(m[1]) ?? [];
        if (candidates.length === 1) sender = userRef.get(candidates[0]) ?? null;
        else t.warnings.push(`notification ${id}: sender "${m[1]}" ambiguous or unknown`);
      }
      const createdAt = parseTime(n.timestamp) || new Date(0);
      tally(
        t,
        await upsert(
          Notification,
          { notificationId: id },
          { notificationId: id, user, message: String(n.message).slice(0, 250), type: n.type || 'info', sender, isRead: bool(n.is_read), createdAt, updatedAt: createdAt },
          apply,
        ),
      );
    }
  });

  // ---- feedback ----
  await step('feedback', async (t) => {
    for (const f of rows.feedback) {
      const id = num(f.feedback_id);
      const user = userRef.get(num(f.user_id));
      if (!user || !f.message) {
        report.reject('feedback', id, `user_id ${f.user_id} not migrated or empty message`);
        continue;
      }
      const createdAt = parseTime(f.timestamp) || new Date(0);
      tally(t, await upsert(Feedback, { feedbackId: id }, { feedbackId: id, user, email: f.email || '', message: f.message, createdAt, updatedAt: createdAt }, apply));
    }
  });

  // ---- chat_messages ----
  await step('chat_messages', async (t) => {
    for (const c of rows.chat_messages) {
      const id = num(c.id);
      const sender = userRefByUuid.get(c.sender_id);
      const receiver = userRefByUuid.get(c.receiver_id);
      if (!sender || !receiver || !c.message) {
        report.reject('chat_messages', id, 'unresolved sender/receiver or empty message');
        continue;
      }
      const createdAt = parseTime(c.timestamp) || new Date(0);
      tally(
        t,
        await upsert(
          ChatMessage,
          { legacyId: id },
          {
            legacyId: id, messageId: c.message_id || `legacy-${id}`, sender, receiver,
            senderUserId: c.sender_id, receiverUserId: c.receiver_id, conversationKey: conversationKey(c.sender_id, c.receiver_id),
            message: c.message, createdAt, updatedAt: createdAt,
          },
          apply,
        ),
      );
    }
  });

  // ---- counters: next ids continue after the highest legacy id ----
  const counters = { buses: ['buses', 'bus_id'], routes: ['routes', 'route_id'], stops: ['stops', 'stop_id'], schedules: ['schedules', 'schedule_id'], notifications: ['notifications', 'notification_id'], feedback: ['feedback', 'feedback_id'], driverDocuments: ['driver_documents', 'doc_id'] };
  report.counters = {};
  for (const [name, [table, col]] of Object.entries(counters)) {
    const max = rows[table].reduce((m, r) => Math.max(m, num(r[col]) || 0), 0);
    report.counters[name] = max;
    if (apply && max) await Counter.updateOne({ _id: name }, { $max: { seq: max } }, { upsert: true });
  }

  // ---- reconciliation ----
  if (apply) {
    const dest = {
      users: [User, 'legacyId', rows.users.map((r) => num(r.id))],
      buses: [Bus, 'busId', rows.buses.map((r) => num(r.bus_id))],
      routes: [Route, 'routeId', rows.routes.map((r) => num(r.route_id))],
      stops: [Stop, 'stopId', rows.stops.map((r) => num(r.stop_id))],
      schedules: [Schedule, 'scheduleId', rows.schedules.map((r) => num(r.schedule_id))],
      bus_locations: [BusLocation, 'busId', rows.bus_locations.map((r) => num(r.bus_id))],
      driver_documents: [DriverDocument, 'docId', rows.driver_documents.map((r) => num(r.doc_id))],
      notifications: [Notification, 'notificationId', rows.notifications.map((r) => num(r.notification_id))],
      feedback: [Feedback, 'feedbackId', rows.feedback.map((r) => num(r.feedback_id))],
      chat_messages: [ChatMessage, 'legacyId', rows.chat_messages.map((r) => num(r.id))],
    };
    report.reconciliation = {};
    for (const [table, [Model, field, ids]] of Object.entries(dest)) {
      const t = report.table(table);
      const destination = await Model.countDocuments({ [field]: { $in: ids } });
      const expected = t.source - t.rejected.length - t.duplicates.length;
      report.reconciliation[table] = { source: t.source, rejected: t.rejected.length, duplicates: t.duplicates.length, expected, destination, ok: destination === expected };
    }
    // Sample: every migrated schedule must resolve all of its references.
    const broken = await Schedule.aggregate([
      { $match: { scheduleId: { $in: rows.schedules.map((r) => num(r.schedule_id)) } } },
      { $lookup: { from: 'routes', localField: 'route', foreignField: '_id', as: 'r' } },
      { $lookup: { from: 'buses', localField: 'bus', foreignField: '_id', as: 'b' } },
      { $lookup: { from: 'users', localField: 'driver', foreignField: '_id', as: 'd' } },
      { $match: { $or: [{ r: { $size: 0 } }, { b: { $size: 0 } }, { d: { $size: 0 } }] } },
      { $count: 'n' },
    ]);
    report.reconciliation.schedule_reference_integrity = { broken: broken[0]?.n ?? 0, ok: !broken.length };
    const sample = rows.users.filter((u) => validUserIds.has(num(u.id))).slice(0, 5);
    report.reconciliation.user_samples = await Promise.all(
      sample.map(async (u) => {
        const m = await User.findOne({ legacyId: num(u.id) }).lean();
        return { id: num(u.id), ok: Boolean(m) && m.email === String(u.email).trim().toLowerCase() && m.fullname === u.fullname };
      }),
    );
    await MigrationRun.updateOne({ runId }, { $set: { finishedAt: new Date(), report: summarize(report) } });
  }

  report.runId = runId;
  logger.info?.(`migration ${report.mode} finished (run ${runId})`);
  return report;
}

export function summarize(report) {
  const tables = Object.fromEntries(
    Object.entries(report.tables).map(([k, v]) => [
      k,
      { ...v, rejected: v.rejected.length, duplicates: v.duplicates.length, warnings: v.warnings.length },
    ]),
  );
  return { mode: report.mode, runId: report.runId, tables, counters: report.counters, reconciliation: report.reconciliation };
}
