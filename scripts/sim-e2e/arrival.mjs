// Follows one trip in the real UI through arrival and past the 120 s stale threshold.
import { chromium } from 'playwright-core';
import { writeFileSync, mkdirSync } from 'node:fs';
const FE = 'http://localhost:3096'; const OUT = process.env.OUT; mkdirSync(`${OUT}/shots`, { recursive: true });
const log = []; const note = (step, d = {}) => { const e = { at: new Date().toISOString().slice(11, 19), step, ...d }; log.push(e); console.log(JSON.stringify(e)); };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const polls = [];
page.on('response', async (r) => { if (/\/view\/get_location\/1$/.test(r.url())) { try { polls.push({ t: Date.now(), body: await r.json() }); } catch { /* non-JSON response */ } } });
try {
  await page.goto(`${FE}/login`);
  await page.fill('input[name="email"]', 'sim-passenger@example.com');
  await page.fill('input[name="password"]', 'Sim-Passenger-1');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard');
  await page.goto(`${FE}/live_tracking`);
  await page.fill('input[placeholder="Current Location"]', 'Connaught Place');
  await page.fill('input[placeholder="Search Destination"]', 'India Gate');
  await page.click('.search-btn-large', { force: true });
  await page.waitForSelector('.schedule-card');
  await page.click('.schedule-card:has-text("SIM-BUS-01")');
  await page.waitForSelector('.leaflet-marker-icon[src*="bus"]');
  const deadline = Date.now() + Number(process.env.MAX_S || 360) * 1000;
  let arrivedAt = null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(10000);
    const st = await page.evaluate(() => ({
      marker: document.querySelector('.leaflet-marker-icon[src*="bus"]')?.style.transform,
      tripStatus: (document.body.innerText.match(/Trip Status:\s*([^\n]*)/) || [])[1],
      signalLost: (document.body.innerText.match(/Live signal lost[^\n]*/) || [null])[0],
      trail: [...document.querySelectorAll('path.leaflet-interactive')].map((p) => p.getAttribute('stroke')),
    }));
    const last = polls.at(-1);
    note('watch', { ...st, lastPoll: last && { lat: last.body.latitude, lng: last.body.longitude, age: last.body.age_seconds, stale: last.body.is_stale, schedule_id: last.body.schedule_id, trip_completed: last.body.trip_completed }, pollsSoFar: polls.length });
    if (st.tripStatus === 'Arrived' && !arrivedAt) { arrivedAt = Date.now(); await page.screenshot({ path: `${OUT}/shots/6-arrived.png` }); }
    if (arrivedAt && Date.now() - arrivedAt > 150_000) break;
  }
  const pollsAfterArrival = arrivedAt ? polls.filter((p) => p.t > arrivedAt + 3000).length : null;
  note('result', { arrived: Boolean(arrivedAt), pollsMoreThan3sAfterArrival: pollsAfterArrival });
  await page.screenshot({ path: `${OUT}/shots/7-arrived-after-150s.png` });
} catch (e) { note('ERROR', { message: e.message.slice(0, 300) }); }
finally { writeFileSync(`${OUT}/arrival-log.json`, JSON.stringify(log, null, 1)); await browser.close(); }
