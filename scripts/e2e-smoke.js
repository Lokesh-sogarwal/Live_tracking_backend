#!/usr/bin/env node
// End-to-end smoke test against a RUNNING API (local, test or staging — never production).
// Creates synthetic users/buses/routes with unique names; deletes nothing.
//
//   E2E_BASE_URL=http://localhost:5001 E2E_SUPERADMIN_EMAIL=… E2E_SUPERADMIN_PASSWORD=… \
//     node scripts/e2e-smoke.js
// Optional: E2E_ROUTE_START / E2E_ROUTE_END place names (geocoded by the API via Nominatim).
import { io } from 'socket.io-client';

const BASE = (process.env.E2E_BASE_URL || 'http://localhost:5001').replace(/\/$/, '');
const RUN = Date.now().toString(36);
const results = [];

async function api(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data };
}

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`FAIL  ${name} — ${err.message}`);
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const connect = (token) =>
  new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
const once = (s, ev, ms = 3000) => {
  const p = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${ev} within ${ms} ms`)), ms);
    s.once(ev, (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
  });
  p.catch(() => {}); // awaited later; avoid an unhandled rejection if an earlier check fails
  return p;
};
const ack = (s, ev, payload) => new Promise((resolve) => s.emit(ev, payload, resolve));

async function login(email, password) {
  const r = await api('POST', '/auth/login', { body: { email, password } });
  expect(r.status === 200 && r.data.token, `login ${email} → ${r.status}`);
  return r.data.token;
}

async function main() {
  const suEmail = process.env.E2E_SUPERADMIN_EMAIL;
  const suPassword = process.env.E2E_SUPERADMIN_PASSWORD;
  if (!suEmail || !suPassword) throw new Error('Set E2E_SUPERADMIN_EMAIL and E2E_SUPERADMIN_PASSWORD');
  const ctx = {};
  const sockets = [];

  await step('health/ready', async () => {
    const r = await api('GET', '/health/ready');
    expect(r.status === 200, `status ${r.status}`);
  });

  // 1. Signup → login → authenticated profile
  await step('signup → login → profile', async () => {
    ctx.pEmail = `e2e-passenger-${RUN}@example.com`;
    const s = await api('POST', '/auth/signup', { body: { fullname: `E2E Passenger ${RUN}`, email: ctx.pEmail.toUpperCase(), password: 'E2e-pass-123', role: 'Passenger' } });
    expect(s.status === 200 && s.data.role === 'Passenger', `signup ${s.status}`);
    ctx.pToken = await login(ctx.pEmail, 'E2e-pass-123');
    const p = await api('GET', '/view/profile', { token: ctx.pToken });
    expect(p.status === 200 && p.data.email === ctx.pEmail, `profile ${p.status}`);
    const put = await api('PUT', '/auth/profile', { token: ctx.pToken, body: { fullname: 'E2E Renamed', role: 'Superadmin' } });
    expect(put.status === 200 && put.data.fullname === 'E2E Renamed' && put.data.role === 'Passenger', 'profile update / role ignored');
    ctx.pUuid = p.data.user_uuid;
    return 'email normalized, role change ignored';
  });

  // 2. Role permissions: authorized and unauthorized
  await step('role permissions enforced server-side', async () => {
    ctx.suToken = await login(suEmail, suPassword);
    const esc = await api('POST', '/auth/signup', { body: { fullname: 'X', email: `e2e-esc-${RUN}@example.com`, password: 'E2e-pass-123', role: 'Admin' } });
    expect(esc.status === 403, `anonymous admin signup → ${esc.status}`);
    const denied = await api('GET', '/view/user_details', { token: ctx.pToken });
    expect(denied.status === 403, `passenger user_details → ${denied.status}`);
    const allowed = await api('GET', '/view/user_details', { token: ctx.suToken });
    expect(allowed.status === 200, `superadmin user_details → ${allowed.status}`);
    const matrix = await api('GET', '/permissions/matrix', { token: ctx.pToken });
    expect(matrix.status === 403, `passenger matrix → ${matrix.status}`);
  });

  // 3. Create bus → route → schedule
  await step('create driver, bus, route, schedule', async () => {
    ctx.dEmail = `e2e-driver-${RUN}@example.com`;
    const d = await api('POST', '/auth/signup', { token: ctx.suToken, body: { fullname: `E2E Driver ${RUN}`, email: ctx.dEmail, password: 'E2e-driver-1', role: 'Driver' } });
    expect(d.status === 200, `driver ${d.status}`);
    ctx.dUuid = d.data.user_uuid;
    ctx.dToken = await login(ctx.dEmail, 'E2e-driver-1');
    const b = await api('POST', '/bus/register_bus', { token: ctx.suToken, body: { bus_number: `E2E-${RUN}`, bus_capacity: 40 } });
    expect(b.status === 201, `bus ${b.status}`);
    ctx.busId = b.data.bus.bus_id;
    const r = await api('POST', '/bus/bus_route', {
      token: ctx.suToken,
      body: { route_name: `E2E Route ${RUN}`, starting: process.env.E2E_ROUTE_START || 'Connaught Place, New Delhi', destination: process.env.E2E_ROUTE_END || 'India Gate, New Delhi' },
    });
    expect(r.status === 201, `route ${r.status} ${JSON.stringify(r.data)}`);
    ctx.route = r.data.route;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.E2E_TZ || 'Asia/Kolkata' }).format(new Date());
    const s = await api('POST', '/bus/schedules', {
      token: ctx.suToken,
      body: { route_id: ctx.route.route_id, bus_id: ctx.busId, driver_uuid: ctx.dUuid, date: today, arrival_time: '00:00', departure_time: '00:05' },
    });
    expect(s.status === 201, `schedule ${s.status} ${JSON.stringify(s.data)}`);
    const dup = await api('POST', '/bus/schedules', {
      token: ctx.suToken,
      body: { route_id: ctx.route.route_id, bus_id: ctx.busId, driver_uuid: ctx.dUuid, date: today, arrival_time: '00:00', departure_time: '00:05' },
    });
    expect(dup.status === 409, `duplicate schedule → ${dup.status}`);
    const list = await api('GET', `/bus/schedules?date=${today}&include_route_details=1`, { token: ctx.pToken });
    expect(list.data.some((x) => x.bus_id === ctx.busId && x.driver_name === `E2E Driver ${RUN}`), 'schedule listed for passenger dashboard');
    return `bus ${ctx.busId}, route ${ctx.route.route_id} (${ctx.route.start_lat.toFixed(4)}, ${ctx.route.start_lng.toFixed(4)})`;
  });

  // 4. Location update → DB → API + socket (the payload the map marker consumes)
  await step('location update → API + bus:location event', async () => {
    const watcher = await connect(ctx.pToken);
    sockets.push(watcher);
    const sub = await ack(watcher, 'bus:subscribe', { busId: ctx.busId });
    expect(sub?.ok, 'subscribe');
    const evt = once(watcher, 'bus:location');
    const lat = ctx.route.start_lat + 0.001;
    const lng = ctx.route.start_lng + 0.001;
    const other = await api('POST', '/view/update_location', { token: ctx.pToken, body: { bus_id: ctx.busId, latitude: lat, longitude: lng } });
    expect(other.status === 403, `passenger update → ${other.status}`);
    const bad = await api('POST', '/view/update_location', { token: ctx.dToken, body: { bus_id: ctx.busId, latitude: 95, longitude: lng } });
    expect(bad.status === 400, `invalid coordinates → ${bad.status}`);
    const up = await api('POST', '/view/update_location', { token: ctx.dToken, body: { bus_id: ctx.busId, latitude: lat, longitude: lng } });
    expect(up.status === 200 && up.data.source === 'device', `driver update → ${up.status} ${JSON.stringify(up.data)}`);
    const e = await evt;
    expect(e.latitude === lat && e.longitude === lng && e.is_stale === false, 'socket payload');
    const get = await api('GET', `/view/get_location/${ctx.busId}`, { token: ctx.pToken });
    expect(get.status === 200 && get.data.latitude === lat && get.data.longitude === lng, 'GET location');
    // BusTracking.jsx renders Marker at [data.latitude, data.longitude].
    return `marker position [${get.data.latitude}, ${get.data.longitude}], age ${get.data.age_seconds}s`;
  });

  // 5. Chat: send → persistence → recipient → history
  await step('chat send → recipient → history', async () => {
    const a = await connect(ctx.pToken);
    const d = await connect(ctx.dToken);
    sockets.push(a, d);
    const recv = once(d, 'message');
    const notif = once(d, 'new_notification');
    const spoof = await ack(a, 'send_message', { sender_id: ctx.dUuid, receiver_id: ctx.dUuid, msg: 'spoof' });
    expect(spoof?.ok === false, 'impersonation rejected');
    const res = await ack(a, 'send_message', { sender_id: ctx.pUuid, receiver_id: ctx.dUuid, msg: `hello ${RUN}` });
    expect(res?.ok && res.message_id, `ack ${JSON.stringify(res)}`);
    const m = await recv;
    expect(m.msg === `hello ${RUN}` && m.sender_id === ctx.pUuid, 'recipient got message');
    await notif;
    const h = await api('GET', `/chat/history/${ctx.pUuid}`, { token: ctx.dToken });
    expect(h.status === 200 && h.data.some((x) => x.message_id === res.message_id), 'history has message');
    const outsider = await api('GET', `/chat/history/${ctx.dUuid}`, { token: ctx.suToken });
    expect(!outsider.data.some((x) => x.message_id === res.message_id), 'third party cannot read');
  });

  // 6. Upload → verify/reject → authorized download
  await step('document upload → verify → download', async () => {
    const pdf = new Blob([Buffer.from(`%PDF-1.4\ne2e ${RUN}\n%%EOF`)], { type: 'application/pdf' });
    const form = new FormData();
    form.append('document_type', 'license');
    form.append('expiry_date', '');
    form.append('file', pdf, 'license.pdf');
    const up = await api('POST', `/view/upload/${ctx.dUuid}`, { token: ctx.dToken, form });
    expect(up.status === 201, `upload ${up.status} ${JSON.stringify(up.data)}`);
    const exe = new FormData();
    exe.append('document_type', 'rc');
    exe.append('file', new Blob([Buffer.from('MZ fake')]), 'rc.pdf');
    const bad = await api('POST', `/view/upload/${ctx.dUuid}`, { token: ctx.dToken, form: exe });
    expect(bad.status === 400, `disguised file → ${bad.status}`);
    const list = await api('GET', '/data/get_documents', { token: ctx.suToken });
    const doc = list.data.documents.find((x) => x.id === up.data.id);
    expect(doc, 'listed');
    const ok = await api('POST', `/data/verify_document/${doc.id}`, { token: ctx.suToken });
    expect(ok.status === 200, `verify ${ok.status}`);
    const denied = await api('POST', `/data/reject_document/${doc.id}`, { token: ctx.pToken });
    expect(denied.status === 403, `passenger reject → ${denied.status}`);
    const dl = await fetch(`${BASE}/data/uploads/${doc.document_path}`);
    const bytes = Buffer.from(await dl.arrayBuffer()).toString();
    expect(dl.status === 200 && bytes.includes(`e2e ${RUN}`), `signed download ${dl.status}`);
    const anon = await fetch(`${BASE}/data/uploads/doc-${doc.id}`);
    expect(anon.status === 401, `anonymous download → ${anon.status}`);
  });

  // 7. Notification creation → listing → mark read
  await step('notification → list → mark read', async () => {
    const list = await api('GET', '/view/notifications', { token: ctx.dToken });
    const chat = list.data.find((n) => n.type === 'chat' && !n.is_read);
    expect(chat && chat.sender_id === ctx.pUuid, 'chat notification with sender_id');
    const foreign = await api('POST', `/view/notifications/mark_read/${chat.id}`, { token: ctx.pToken });
    expect(foreign.status === 404, `other user mark → ${foreign.status}`);
    const mark = await api('POST', `/view/notifications/mark_read/${chat.id}`, { token: ctx.dToken });
    expect(mark.status === 200, `mark ${mark.status}`);
    const after = await api('GET', '/view/notifications', { token: ctx.dToken });
    expect(after.data.find((n) => n.id === chat.id).is_read === true, 'persisted');
    const all = await api('POST', '/view/notifications/mark_read_all', { token: ctx.dToken });
    expect(all.status === 200, 'mark all');
  });

  // Logout revokes server-side
  await step('logout revokes token (HTTP + socket)', async () => {
    const out = await api('POST', '/auth/logout', { token: ctx.pToken });
    expect(out.status === 200, `logout ${out.status}`);
    const again = await api('GET', '/view/profile', { token: ctx.pToken });
    expect(again.status === 401, `after logout → ${again.status}`);
    let rejected = false;
    try {
      sockets.push(await connect(ctx.pToken));
    } catch {
      rejected = true;
    }
    expect(rejected, 'socket handshake rejected after logout');
  });

  sockets.forEach((s) => s.disconnect());
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error('E2E aborted:', err.message);
  process.exit(1);
});
