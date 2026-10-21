// New in-progress trips via the real API (arrival = 1 minute ago, IST); the worker picks them up.
const B = 'http://127.0.0.1:5096';
const j = async (m, p, t, b) => { const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: b && JSON.stringify(b) }); return { status: r.status, data: await r.json() }; };
const su = (await j('POST', '/auth/login', null, { email: 'sim-root@example.com', password: 'Sim-Root-Pass-1' })).data.token;
const drivers = (await j('GET', '/view/driver_details', su)).data;
const fmt = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const arr = fmt(new Date(Date.now() - 60_000));
const dep = fmt(new Date(Date.now() + 4 * 60_000));
const out = [];
for (const [route_id, bus_id, d] of [[1, 1, 0], [2, 2, 1]]) {
  const s = await j('POST', '/bus/schedules', su, { route_id, bus_id, driver_uuid: drivers[d].user_uuid, date: today, arrival_time: arr, departure_time: dep });
  out.push({ route_id, bus_id, status: s.status, schedule_id: s.data.schedule_id, arr, dep });
}
console.log(JSON.stringify(out));
