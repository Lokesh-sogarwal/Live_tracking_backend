// Third bus with a schedule later today: it must show "not started" (no position yet).
const B = 'http://127.0.0.1:5096';
const j = async (m, p, t, b) => { const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: b && JSON.stringify(b) }); return { status: r.status, data: await r.json() }; };
const su = (await j('POST', '/auth/login', null, { email: 'sim-root@example.com', password: 'Sim-Root-Pass-1' })).data.token;
const bus = await j('POST', '/bus/register_bus', su, { bus_number: 'SIM-BUS-03' });
const drivers = (await j('GET', '/view/driver_details', su)).data;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const s = await j('POST', '/bus/schedules', su, { route_id: 1, bus_id: bus.data.bus.bus_id, driver_uuid: drivers[0].user_uuid, date: today, arrival_time: '23:50', departure_time: '23:55' });
const p = await j('POST', '/auth/signup', null, { fullname: 'Sim Passenger', email: 'sim-passenger@example.com', password: 'Sim-Passenger-1' });
console.log(JSON.stringify({ bus: bus.status, busId: bus.data.bus.bus_id, schedule: s.status, passenger: p.status, date: today }));
