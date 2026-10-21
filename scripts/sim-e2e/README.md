# Simulation end-to-end harness

Verifies the live simulation against **isolated** processes: automatic movement, route
progression, MongoDB persistence, Socket.IO `bus:location` delivery, and the React tracking
page in real Chrome. Used for docs/TEST_REPORT.md §00. Never point it at a real database.

Fixed ports and synthetic accounts (edit the constants at the top of each script to change):
API `http://127.0.0.1:5096`, frontend `http://localhost:3096`, MongoDB `127.0.0.1:27097/lt_sim`,
superadmin `sim-root@example.com` / `Sim-Root-Pass-1`, passenger `sim-passenger@example.com`.

```bash
# 0. tools (outside the project; uses your installed Google Chrome)
mkdir -p /tmp/sim-harness && cd /tmp/sim-harness && npm init -y && npm i playwright-core@1 socket.io-client@4 mongodb@6
cp <repo>/backend-node/scripts/sim-e2e/*.mjs .

# 1. throwaway database + API
mongod --dbpath /tmp/sim-data --port 27097 --bind_ip 127.0.0.1 --fork --logpath /tmp/sim-mongod.log
cd <repo>/backend-node
export MONGODB_URI=mongodb://127.0.0.1:27097/lt_sim JWT_SECRET=$(openssl rand -hex 32) PORT=5096 \
       FRONTEND_ORIGINS=http://localhost:3096 LOCAL_UPLOAD_DIR=/tmp/sim-uploads SIMULATION_TICK_MS=5000
SEED_SUPERADMIN_EMAIL=sim-root@example.com SEED_SUPERADMIN_PASSWORD=Sim-Root-Pass-1 node scripts/seed.js
node src/server.js &

# 2. fleet through the API (2 drivers, buses 1-2, routes A/B; then bus 3 + passenger)
cd /tmp/sim-harness && node setup-fleet.mjs && node extra-bus.mjs

# 3. frontend pointed at the isolated API
cd <repo>/Live_Tracking_Frontend && PORT=3096 BROWSER=none REACT_APP_API_URL=http://localhost:5096 npx react-scripts start &

# 4. observer + two workers + browser
cd /tmp/sim-harness && OUT=/tmp/run SECONDS=170 node observe2.mjs &
cd <repo>/backend-node && SIMULATION_ENABLED=true node src/worker.js & SIMULATION_ENABLED=true node src/worker.js &
cd /tmp/sim-harness && OUT=/tmp/run node browser.mjs     # results: /tmp/run/browser-log.json, observer.json, shots/

# Later runs: trips that already arrived are hidden by All Routes; create in-progress ones:
node new-trips.mjs && OUT=/tmp/run2 node arrival.mjs     # follows a trip through arrival + 150 s
```
