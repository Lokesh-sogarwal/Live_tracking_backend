// Drives the real React UI in Chrome (Playwright) against the isolated stack.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const FE = 'http://localhost:3096';
const OUT = process.env.OUT;
mkdirSync(`${OUT}/shots`, { recursive: true });
const log = [];
const note = (step, data = {}) => {
  const e = { at: new Date().toISOString().slice(11, 19), step, ...data };
  log.push(e);
  console.log(JSON.stringify(e));
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });

async function loggedInPage() {
  const page = await ctx.newPage();
  page.locations = [];
  page.consoleErrors = [];
  page.on('response', async (r) => {
    const m = r.url().match(/\/view\/get_location\/(\d+)/);
    if (!m) return;
    let body = null;
    try { body = await r.json(); } catch { /* ignore */ }
    page.locations.push({ t: Date.now(), busId: Number(m[1]), status: r.status(), body });
  });
  page.on('console', (msg) => { if (msg.type() === 'error') page.consoleErrors.push(msg.text().slice(0, 160)); });
  return page;
}

async function openTracking(page, busNumber, from = 'Connaught Place', to = 'India Gate') {
  await page.goto(`${FE}/live_tracking`);
  await page.fill('input[placeholder="Current Location"]', from);
  await page.fill('input[placeholder="Search Destination"]', to);
  // The button lifts 2px on :hover; under a stationary pointer near its edge it can bob in/out
  // of hover, so Playwright's stability check may never settle.
  await page.click('.search-btn-large', { force: true });
  await page.waitForSelector('.schedule-card', { timeout: 20000 });
  const cards = await page.$$eval('.schedule-card', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').slice(0, 90)));
  await page.click(`.schedule-card:has-text("${busNumber}")`);
  await page.waitForURL('**/bus_tracking');
  await page.waitForSelector('.leaflet-container', { timeout: 20000 });
  return cards;
}

const markerState = (page) =>
  page.evaluate(() => {
    const m = document.querySelector('.leaflet-marker-icon[src*="bus"]');
    const route = [...document.querySelectorAll('path.leaflet-interactive')].map((p) => ({ stroke: p.getAttribute('stroke'), dLen: (p.getAttribute('d') || '').length }));
    const text = document.body.innerText;
    return {
      marker: m ? m.style.transform : null,
      routePaths: route,
      notStarted: text.includes('Bus has not started yet'),
      signalLost: (text.match(/Live signal lost[^\n]*/) || [null])[0],
      fetchError: text.includes('Failed to fetch bus location'),
      tripStatus: (text.match(/Trip Status:\s*([^\n]*)/) || [])[1] || null,
    };
  });
const lastLoc = (page, busId) => [...page.locations].reverse().find((l) => l.busId === busId);

try {
  // ---- login as a passenger through the real form
  const page = await loggedInPage();
  await page.goto(`${FE}/login`);
  await page.fill('input[name="email"]', 'sim-passenger@example.com');
  await page.fill('input[name="password"]', 'Sim-Passenger-1');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard', { timeout: 15000 });
  note('login', { url: page.url() });

  // ---- tab A: SIM-BUS-01 (simulated)
  const cards = await openTracking(page, 'SIM-BUS-01');
  note('all_routes cards', { cards });
  await page.waitForSelector('.leaflet-marker-icon[src*="bus"]', { timeout: 20000 });
  for (let i = 0; i < 5; i += 1) {
    const s = await markerState(page);
    const l = lastLoc(page, 1);
    note(`bus1 sample ${i + 1}`, { markerTransform: s.marker, received: l && { status: l.status, lat: l.body?.latitude, lng: l.body?.longitude, age: l.body?.age_seconds, stale: l.body?.is_stale }, routePaths: s.routePaths, notStarted: s.notStarted, fetchError: s.fetchError, tripStatus: s.tripStatus });
    if (i === 0) await page.screenshot({ path: `${OUT}/shots/1-bus1-tracking.png` });
    await page.waitForTimeout(5500);
  }
  await page.screenshot({ path: `${OUT}/shots/2-bus1-after-25s.png` });

  // ---- browser refresh keeps tracking
  await page.reload();
  await page.waitForSelector('.leaflet-marker-icon[src*="bus"]', { timeout: 20000 });
  await page.waitForTimeout(2500);
  const afterReload = await markerState(page);
  note('after reload', { url: page.url(), markerTransform: afterReload.marker, routePaths: afterReload.routePaths, received: lastLoc(page, 1)?.body });
  await page.screenshot({ path: `${OUT}/shots/3-bus1-after-reload.png` });

  // ---- tab C: SIM-BUS-02 on another route, tracked at the same time as tab A
  const pageC = await loggedInPage();
  await openTracking(pageC, 'SIM-BUS-02', 'Karol Bagh', 'Rajiv Chowk');
  await pageC.waitForSelector('.leaflet-marker-icon[src*="bus"]', { timeout: 20000 });
  for (let i = 0; i < 3; i += 1) {
    const c = await markerState(pageC);
    const a = await markerState(page);
    note(`multi-bus sample ${i + 1}`, {
      bus2: { marker: c.marker, received: lastLoc(pageC, 2)?.body && [lastLoc(pageC, 2).body.latitude, lastLoc(pageC, 2).body.longitude] },
      bus1: { marker: a.marker, received: lastLoc(page, 1)?.body && [lastLoc(page, 1).body.latitude, lastLoc(page, 1).body.longitude] },
    });
    await pageC.waitForTimeout(5500);
  }
  await pageC.screenshot({ path: `${OUT}/shots/3b-bus2-tracking.png` });
  await pageC.close();

  // ---- tab B: SIM-BUS-03 (scheduled later, no position)
  const pageB = await loggedInPage();
  await openTracking(pageB, 'SIM-BUS-03');
  await pageB.waitForTimeout(5000);
  const b = await markerState(pageB);
  const bLoc = lastLoc(pageB, 3);
  note('bus3 (no position yet)', { notStarted: b.notStarted, fetchError: b.fetchError, getLocationStatus: bLoc?.status, getLocationBody: bLoc?.body });
  await pageB.screenshot({ path: `${OUT}/shots/4-bus3-not-started.png` });
  await pageB.close();

  // ---- tab A stays open: watch completion, then staleness (> 120 s without updates)
  let lastKey = null;
  let unchangedSince = Date.now();
  const deadline = Date.now() + 7 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(10000);
    const s = await markerState(page);
    const l = lastLoc(page, 1);
    const key = l ? `${l.body?.latitude},${l.body?.longitude}` : null;
    if (key !== lastKey) { lastKey = key; unchangedSince = Date.now(); }
    note('bus1 watch', { markerTransform: s.marker, lat: l?.body?.latitude, lng: l?.body?.longitude, age: l?.body?.age_seconds, stale: l?.body?.is_stale, signalLost: s.signalLost, fetchError: s.fetchError, unchangedForS: Math.round((Date.now() - unchangedSince) / 1000) });
    if (s.signalLost) {
      await page.screenshot({ path: `${OUT}/shots/5-bus1-stale.png` });
      break;
    }
  }
  note('console errors (tab A)', { errors: [...new Set(page.consoleErrors)].slice(0, 10) });
} catch (err) {
  note('ERROR', { message: err.message.slice(0, 300) });
} finally {
  writeFileSync(`${OUT}/browser-log.json`, JSON.stringify(log, null, 1));
  await browser.close();
}
