// Creates the test fleet through the real API workflow (no direct DB writes).
const B = 'http://127.0.0.1:5096';
const j = async (method, path, token, body) => {
  const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
const su = (await j('POST', '/auth/login', null, { email: 'sim-root@example.com', password: 'Sim-Root-Pass-1' })).data.token;
const out = { drivers: [], buses: [], routes: [] };
for (const [i, name] of ['Sim Driver One', 'Sim Driver Two'].entries()) {
  const d = await j('POST', '/auth/signup', su, { fullname: name, email: `sim-driver-${i + 1}@example.com`, password: 'Sim-Driver-1', role: 'Driver' });
  out.drivers.push({ status: d.status, uuid: d.data.user_uuid });
}
for (const n of ['SIM-BUS-01', 'SIM-BUS-02']) {
  const b = await j('POST', '/bus/register_bus', su, { bus_number: n, bus_capacity: 40 });
  out.buses.push({ status: b.status, ...b.data.bus });
}
for (const [name, s, e] of [['Sim Route A', 'Connaught Place, New Delhi', 'India Gate, New Delhi'], ['Sim Route B', 'Karol Bagh, New Delhi', 'Rajiv Chowk, New Delhi']]) {
  const r = await j('POST', '/bus/bus_route', su, { route_name: name, starting: s, destination: e });
  out.routes.push({ status: r.status, ...(r.data.route || r.data) });
}
console.log(JSON.stringify(out, null, 1));
