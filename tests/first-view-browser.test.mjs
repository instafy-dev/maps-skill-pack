// The map's first view, as a person sees it before touching anything:
// - a dark page draws a dark map from its first frame. The day/night look waited for every tile ('load'), so a dark
//   page showed the style's light land for as long as the tiles took (a white map for seconds on a reload);
// - a phone shows the places. A map opened in a wide frame kept the camera fitted beside the side panel when the frame
//   turned phone-sized, so the places sat at the right edge or off it;
// - the phone sheet follows a drag from its handle. A mouse (and a browser that sends mouse events for a phone) is not
//   captured by the handle it pressed: the drag left the sheet at once, its moves went to the map, and the sheet
//   never rose.
// Offline: every request off this machine is held, then refused (no tiles, no sprite, no fonts).
// Needs Playwright (UW_PLAYWRIGHT=/path/to/playwright, optionally UW_BROWSER_CHANNEL=chrome); skipped without it.
// Run: UW_PLAYWRIGHT=… node --test tests/first-view-browser.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const { loadPlaywright, launchChromium, createStaticServer, listen } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'cmd-serve.mjs')).href);

let pw = null;
try { pw = await loadPlaywright(); } catch { pw = null; }
const skip = pw ? false : 'Playwright not found (set UW_PLAYWRIGHT)';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-first-view-'));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const pt = (id, c, p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { id, ...p } });
// a city break: the map was made on the city's centre (west of the old town), its base and sights are in the old town
const CENTRE = [-8.6291, 41.1579];
const PLACES = { sight: [-8.6148, 41.1469], base: [-8.6085, 41.1478], hotel: [-8.6125, 41.1462], stop: [-8.6109, 41.1496] };

function makeSite(name) {
  const dir = path.join(tmp, name);
  const r = spawnSync(process.execPath, [UW, 'new', dir, '--title', 'Three days in the old town', '--center', CENTRE.join(','), '--zoom', '13'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const write = (layer, feats) => fs.writeFileSync(path.join(dir, 'data', `${layer}.geojson`), JSON.stringify({ type: 'FeatureCollection', features: feats }));
  write('sights', [pt('sight', PLACES.sight, { name: 'Old bookshop', kind: 'bookshop' })]);
  write('stays', [pt('base', PLACES.base, { name: 'Base hostel', kind: 'hostel' }), pt('hotel', PLACES.hotel, { name: 'Square hotel', kind: 'hotel' })]);
  write('stops', [pt('stop', PLACES.stop, { name: 'Old town', kind: 'city' })]);
  const cfgPath = path.join(dir, 'map.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.layers = [{ id: 'sights', title: 'Sights', type: 'points', data: 'data/sights.geojson' }, { id: 'stays', title: 'Stays', type: 'points', data: 'data/stays.geojson' },
    { id: 'stops', title: 'Stops', type: 'points', data: 'data/stops.geojson' }];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const f = spawnSync(process.execPath, [UW, 'fit', dir, '--layers', 'sights,stays,stops'], { encoding: 'utf8' });
  assert.equal(f.status, 0, f.stderr);
  return dir;
}

async function open(dir, ctxOpts, { hold = false } = {}) {
  const site = createStaticServer(dir);
  const port = await listen(site, 0, '127.0.0.1');
  closers.push(() => new Promise((res) => site.close(res)));
  const browser = await launchChromium(pw);
  closers.push(() => browser.close());
  const ctx = await browser.newContext(ctxOpts);
  let release = () => {};
  const held = new Promise((res) => { release = res; });
  closers.push(async () => release());
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, async (route) => { if (hold) await held; route.abort().catch(() => {}); });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  return { page, errors, release };
}

/** The colour the page shows at (x, y) of the viewport, from a screenshot decoded in the page itself. */
async function pixel(page, x, y) {
  const png = (await page.screenshot({ clip: { x, y, width: 2, height: 2 } })).toString('base64');
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    return [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  }, png);
}
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

test('a dark page draws a dark map from its first frame, while the tiles are still on their way; a light page a light one', { skip, timeout: 120000 }, async () => {
  const dir = makeSite('paint');
  for (const scheme of ['dark', 'light']) {
    const { page, errors, release } = await open(dir, { viewport: { width: 1024, height: 768 }, colorScheme: scheme }, { hold: true });
    // the style is in and drawing; the tiles, sprite and fonts are held, so the map has not loaded
    await page.waitForFunction(() => { try { return window.uw.map.getStyle().layers.length > 0; } catch { return false; } }, null, { timeout: 30000 });
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => window.__uwReady), false, 'still waiting for its tiles');
    assert.equal(await page.evaluate(() => window.uw.map.loaded()), false);
    // the map area, right of the side panel
    const c = await pixel(page, 760, 420);
    release();
    if (scheme === 'dark') assert.ok(lum(c) < 70, `a dark page shows dark land before its tiles, not the style's light land: rgb(${c})`);
    else assert.ok(lum(c) > 200, `a light page shows the style's light land: rgb(${c})`);
    assert.deepEqual(errors, []);
  }
});

/** Every place's position in the frame, and the part of the frame the sheet leaves for the map. */
const placesIn = (page) => page.evaluate((places) => {
  const m = window.uw.map, sheet = document.querySelector('.uw-sheet');
  const pts = Object.fromEntries(Object.entries(places).map(([k, c]) => { const p = m.project(c); return [k, [Math.round(p.x), Math.round(p.y)]]; }));
  return { W: innerWidth, top: Math.round(sheet.getBoundingClientRect().top), pts, center: m.getCenter().toArray(), zoom: m.getZoom() };
}, PLACES);

test('a map opened wide shows every place when its frame turns phone-sized; once someone moves it, a new size leaves it alone', { skip, timeout: 120000 }, async () => {
  const dir = makeSite('narrow');
  const { page, errors } = await open(dir, { viewport: { width: 1024, height: 768 } });
  await page.waitForFunction(() => window.__uwReady === true, null, { timeout: 60000 });
  const wide = await placesIn(page);
  for (const [k, [x, y]] of Object.entries(wide.pts)) assert.ok(x > 400 && x < wide.W && y > 0 && y < 768, `${k} beside the side panel: ${JSON.stringify(wide)}`);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(800);
  const phone = await placesIn(page);
  for (const [k, [x, y]] of Object.entries(phone.pts)) {
    assert.ok(x >= 8 && x <= phone.W - 8, `${k} across the phone, not at or past its edge (x ${x} of ${phone.W}): ${JSON.stringify(phone)}`);
    assert.ok(y >= 8 && y <= phone.top - 8, `${k} above the sheet (y ${y}, sheet at ${phone.top}): ${JSON.stringify(phone)}`);
  }
  // the person moves the map: from then on the camera is theirs
  await page.mouse.move(190, 300); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(190 - i * 10, 300 + i * 4);
  await page.mouse.up();
  // the drag's inertia runs on after the release (0.2 to 0.5 s here, longer after a fast flick): the camera is the
  // person's once it has come to rest, sampled twice in a row
  await page.waitForFunction(() => {
    const m = window.uw.map, k = JSON.stringify([m.getCenter(), m.getZoom()]);
    const still = !m.isMoving() && window.__restCam === k;
    window.__restCam = k;
    return still;
  }, null, { polling: 200, timeout: 15000 });
  const moved = await placesIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  const after = await placesIn(page);
  assert.ok(Math.abs(after.center[0] - moved.center[0]) < 1e-7 && Math.abs(after.center[1] - moved.center[1]) < 1e-7 && Math.abs(after.zoom - moved.zoom) < 1e-6,
    `a moved map keeps its camera: ${JSON.stringify({ moved, after })}`);
  assert.deepEqual(errors, []);
});

test('phone: dragging the sheet by its handle raises it, and dragging it back down lowers it (mouse events, as a desktop browser at phone size sends)', { skip, timeout: 120000 }, async () => {
  const dir = makeSite('drag');
  const { page, errors } = await open(dir, { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  await page.waitForFunction(() => window.__uwReady === true, null, { timeout: 60000 });
  const snap = () => page.evaluate(() => document.querySelector('.uw-sheet').dataset.snap);
  const handle = () => page.evaluate(() => { const r = document.querySelector('.uw-handle').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  const drag = async (dy) => {
    const [x, y] = await handle();
    await page.mouse.move(x, y); await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(x, y + (dy * i) / 10);
    await page.mouse.up();
    await page.waitForTimeout(700);
  };
  assert.equal(await snap(), 'peek');
  await drag(-320);
  assert.notEqual(await snap(), 'peek', 'dragged up, the sheet rose');
  const up = await snap();
  await drag(500);
  assert.equal(await snap(), 'peek', `dragged down from ${up}, it is lowered again`);
  // a press on the handle without a drag still steps it
  const [x, y] = await handle();
  await page.mouse.click(x, y);
  await page.waitForTimeout(600);
  assert.equal(await snap(), 'half');
  assert.deepEqual(errors, []);
});
