// The engine side of multi-city trips: a leg that follows the track (uw legs --follow) is drawn on the track, not as an
// arc; leg cards on a plan-route site show "km by rail" and a Timetable link; plan items carry their source link; the
// plan-route heading names the first stop in English on an English map.
// Needs Playwright (UW_PLAYWRIGHT=/path/to/playwright, optionally UW_BROWSER_CHANNEL=chrome); skipped without it.
// Run: UW_PLAYWRIGHT=… node --test map-pack/tests/itinerary-browser.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const { loadPlaywright, launchChromium, createStaticServer, listen } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'cmd-serve.mjs')).href);

let pw = null;
try { pw = await loadPlaywright(); } catch { pw = null; }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-itin-b-'));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const TRA = 'https://tip.railway.gov.tw/tra-tip-web/tip';
const pt = (id, c, p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { id, ...p } });
function makeSite() {
  const dir = path.join(tmp, 'site');
  const r = spawnSync(process.execPath, [UW, 'new', dir, '--title', 'Trip', '--center', '121.3,24.5', '--zoom', '7'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const TPE = [121.517475, 25.046243], HUA = [121.600952, 23.99264];
  const track = [TPE, [121.75, 25.1], [121.85, 24.6], [121.75, 24.3], HUA];
  const w = (f, j) => fs.writeFileSync(path.join(dir, 'data', f), JSON.stringify(j));
  w('stations.geojson', { type: 'FeatureCollection', features: [pt('taipei', TPE, { name: '台北車站', name_en: 'Taipei Main Station', kind: 'train_station', nights: 3 }),
    pt('hualien', HUA, { name: '花蓮', name_en: 'Hualien', kind: 'train_station', nights: 2 })], uw: { cmd: 'station' } });
  w('sights.geojson', { type: 'FeatureCollection', features: [pt('dihua', [121.5092, 25.0618], { name: '迪化街', name_en: 'Dihua Street', stop: 'taipei',
    source_url: 'https://en.wikipedia.org/wiki/Dihua_Street', source: 'Wikipedia' })], uw: { cmd: 'add-point' } });
  w('trip.geojson', { type: 'FeatureCollection', uw: { cmd: 'legs' }, features: [
    { type: 'Feature', geometry: { type: 'LineString', coordinates: track }, properties: { id: 'leg-1', order: 1, name: '台北車站 → 花蓮', name_en: 'Taipei Main Station → Hualien',
      from: 'taipei', to: 'hualien', mode: 'train', emoji: '🚆', distance_km: 193.5, track: true, track_km: 193.5, timetable_url: TRA } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [HUA, TPE] }, properties: { id: 'leg-2', order: 2, name: '花蓮 → 台北車站', from: 'hualien', to: 'taipei',
      mode: 'train', emoji: '🚆', distance_km: 117 } }] });
  const cfgPath = path.join(dir, 'map.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.layers = [
    { id: 'trip', title: 'Train legs', type: 'legs', data: 'data/trip.geojson' },
    { id: 'stations', title: 'Stations', type: 'points', data: 'data/stations.geojson' },
    { id: 'sights', title: 'Sights', type: 'points', data: 'data/sights.geojson' },
  ];
  cfg.question = { kind: 'plan-route', ask: 'Two weeks by train' };
  cfg.plan = { title: 'Plan', days: [
    { title: 'Tue 20 Oct · Taipei', time: 15, focus: { layer: 'stations', id: 'taipei' }, items: [
      { text: 'Dihua Street', ref: { layer: 'sights', id: 'dihua' }, url: 'https://en.wikipedia.org/wiki/Dihua_Street', source: 'Wikipedia' }] },
    { title: 'Fri 23 Oct · Taipei → Hualien', time: 9, time_hint: true, focus: { layer: 'stations', id: 'hualien' }, items: [
      { text: '🚆 Taipei → Hualien · times: check the timetable', ref: { layer: 'trip', id: 'leg-1' }, url: TRA, source: 'Timetable' }] }] };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const v = spawnSync(process.execPath, [UW, 'validate', dir], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stdout + v.stderr);
  return { dir, track };
}

test('track legs, leg cards, plan source links and the English start name', { skip: pw ? false : 'Playwright not found (set UW_PLAYWRIGHT)', timeout: 120000 }, async () => {
  const { dir, track } = makeSite();
  const server = createStaticServer(dir);
  const port = await listen(server, 0, '127.0.0.1');
  closers.push(() => new Promise((r) => server.close(r)));
  const browser = await launchChromium(pw);
  closers.push(() => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.__uwReady === true, null, { timeout: 60000 });
  // the track leg is drawn on its own coordinates; the other leg is still an arc (many points between two stops)
  const arcs = await page.evaluate(() => window.uw.getFeatures('trip').map((f) => f.properties._arc));
  assert.deepEqual(arcs[0], track, 'track leg drawn as the track');
  assert.ok(arcs[1].length > 2, 'a 2-point leg is drawn as an arc');
  // the plan-route heading names the first stop in English
  const sheet = await page.evaluate(() => document.body.innerText);
  assert.match(sheet, /from Taipei Main Station/);
  assert.doesNotMatch(sheet, /from 台北車站/);
  // the leg card (plan-route sites use the v0.2 card): distance by rail and the timetable link
  await page.evaluate(() => window.uw.select('trip', 'leg-1'));
  await page.waitForFunction(() => /km by rail/.test(document.body.innerText), null, { timeout: 10000 });
  const card = await page.evaluate(() => ({ text: document.body.innerText, links: [...document.querySelectorAll('a')].map((a) => ({ href: a.href, text: a.innerText.trim() })) }));
  assert.match(card.text, /194 km by rail/);
  assert.ok(card.links.some((l) => l.href.startsWith(TRA) && /Timetable/.test(l.text)), JSON.stringify(card.links));
  await page.evaluate(() => window.uw.select('trip', 'leg-2'));
  await page.waitForFunction(() => /straight line/.test(document.body.innerText), null, { timeout: 10000 });
  // the sight card links its source
  await page.evaluate(() => window.uw.select('sights', 'dihua'));
  await page.waitForFunction(() => [...document.querySelectorAll('a')].some((a) => /Source/.test(a.innerText) && /wikipedia/.test(a.href)), null, { timeout: 10000 });
  // plan items carry their source link, which does not select the item
  await page.evaluate(() => { window.uw.ui.openSheet('plan'); window.uw.setDay(0); });
  await page.waitForSelector('a.uw-item-src', { timeout: 10000 });
  // every day is one row of one list (the timeline page's day rows): no day chips, no "+N more days", no dots
  const plan = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('.uw-dayrow .uw-dayrow-t')].map((t) => t.innerText),
    open: [...document.querySelectorAll('.uw-dayrow')].map((r) => r.classList.contains('is-open')),
    steppers: document.querySelectorAll('.uw-stepper').length,
    dots: document.querySelectorAll('.uw-dot, .uw-daychip, .uw-vmore').length,
  }));
  assert.deepEqual(plan.rows, ['Tue 20 Oct · Taipei', 'Fri 23 Oct · Taipei → Hualien'], 'every day is listed, its date first');
  assert.deepEqual(plan.open, [true, false], 'the current day is open under its row');
  assert.equal(plan.steppers, 0, 'one way through the days: the list');
  assert.equal(plan.dots, 0, 'no day chips, no "more days", no dots');
  const src = await page.evaluate(() => [...document.querySelectorAll('a.uw-item-src')].map((a) => ({ href: a.href, text: a.innerText, target: a.target, rel: a.rel })));
  assert.deepEqual(src[0], { href: 'https://en.wikipedia.org/wiki/Dihua_Street', text: 'Wikipedia ↗', target: '_blank', rel: 'noopener noreferrer' });
  // opening a day sets its hour; the day itself has no clock chip, hint hour or not
  const chips = () => page.evaluate(() => [...document.querySelectorAll('.uw-dayrow-b .uw-chip')].map((c) => c.innerText));
  assert.ok(!(await chips()).some((t) => /\d:\d\d/.test(t)), `no clock chip in the day: ${await chips()}`);
  await page.evaluate(() => window.uw.setDay(1));
  await page.waitForFunction(() => /Taipei → Hualien/.test(document.querySelector('.uw-day-title')?.innerText || ''), null, { timeout: 10000 });
  assert.ok(!(await chips()).some((t) => /09:00|9:00/.test(t)), `no clock chip for a hint hour: ${await chips()}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});
