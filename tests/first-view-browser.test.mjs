// The map's first view, as a person sees it before touching anything:
// - a dark page draws a dark map from its first frame. The day/night look waited for every tile ('load'), so a dark
//   page showed the style's light land for as long as the tiles took (a white map for seconds on a reload);
// - a phone shows the places. A map opened in a wide frame kept the camera fitted beside the side panel when the frame
//   turned phone-sized, so the places sat at the right edge or off it;
// - the phone sheet follows a drag from its handle. A mouse (and a browser that sends mouse events for a phone) is not
//   captured by the handle it pressed: the drag left the sheet at once, its moves went to the map, and the sheet
//   never rose;
// - in a host's frame (Studio), what the host says while the tiles load counts at once. Its dark theme came after the
//   style was in, and the map stayed light under the dark page until every tile was in; the frame's size changed, or
//   the host's chrome came over its bottom, while the tiles loaded, and the map stayed fitted to the frame as it was
//   until then;
// - a map that cannot draw says why, and says `ready` to its host at once, never with its ready mark.
// Offline: every request off this machine is held, then refused (no tiles, no sprite, no fonts).
// Needs Playwright (UW_PLAYWRIGHT=/path/to/playwright, optionally UW_BROWSER_CHANNEL=chrome); skipped without it.
// Run: UW_PLAYWRIGHT=… node --test tests/first-view-browser.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
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

/** The site in a host's frame, as Studio shows it: from another origin, with `?instafy_host=studio`, `w`×`h` px. The host
 *  says nothing until the test posts its layout (`layout(theme)`); `size(w, h)` resizes the frame; `said()` lists what
 *  the site told its host. Every request off this machine is held until `release()`. */
async function openHosted(dir, ctxOpts, { w, h }) {
  const site = createStaticServer(dir);
  const port = await listen(site, 0, '127.0.0.1');
  closers.push(() => new Promise((res) => site.close(res)));
  const origin = `http://127.0.0.1:${port}`;
  const host = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><style>html,body{margin:0;background:#202020}iframe{border:0;display:block}</style>
<iframe id="f" style="width:${w}px;height:${h}px" src="${origin}/?instafy_host=studio"></iframe>
<script>window.__msgs = []; addEventListener('message', (e) => { if (e.source === document.getElementById('f').contentWindow) window.__msgs.push(e.data); });</script>`);
  });
  const hport = await listen(host, 0, '127.0.0.1');
  closers.push(() => new Promise((res) => host.close(res)));
  const browser = await launchChromium(pw);
  closers.push(() => browser.close());
  const ctx = await browser.newContext(ctxOpts);
  let release = () => {};
  const held = new Promise((res) => { release = res; });
  closers.push(async () => release());
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, async (route) => { await held; route.abort().catch(() => {}); });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${hport}/`);
  const frame = await (await page.waitForSelector('#f')).contentFrame();
  const layout = (theme, extra = {}) => page.evaluate(([t, o, x]) => document.getElementById('f').contentWindow.postMessage({ source: 'instafy-host', v: 1, type: 'layout', caps: { location: 'host' }, theme: t, ...x }, o), [theme, origin, extra]);
  const size = (fw, fh) => page.evaluate(([a, b]) => { const f = document.getElementById('f'); f.style.width = `${a}px`; f.style.height = `${b}px`; }, [fw, fh]);
  const styleIn = () => frame.waitForFunction(() => { try { return window.uw.map.getStyle().layers.length > 0; } catch { return false; } }, null, { timeout: 30000 });
  // what the site said to its host (a host only reads its own frame's messages)
  const said = () => page.evaluate(() => window.__msgs.filter((m) => m && m.source === 'instafy-map' && m.v === 1).map((m) => ({ type: m.type, supports: m.payload?.supports })));
  return { page, frame, errors, release, layout, size, styleIn, said };
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
  return { W: innerWidth, H: innerHeight, top: Math.round(sheet.getBoundingClientRect().top), pts, center: m.getCenter().toArray(), zoom: m.getZoom() };
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

// Studio on a light device in its dark theme: the frame knows the theme only from the host's message, which can come
// after the style is in. The map then stayed light under the dark page for as long as the tiles took (2 to 3 s on a
// reload).
test('in a host\'s frame, the host\'s dark theme turns the map dark as soon as it comes, while the tiles are still on their way', { skip, timeout: 120000 }, async () => {
  const dir = makeSite('host-theme');
  const { page, frame, errors, release, layout, styleIn } = await openHosted(dir, { viewport: { width: 640, height: 700 }, colorScheme: 'light' }, { w: 600, h: 650 });
  await styleIn();
  await page.waitForTimeout(300);
  const before = await pixel(page, 300, 120);
  assert.ok(lum(before) > 200, `light before the host says anything (a light device): rgb(${before})`);
  await layout('dark');
  await frame.waitForFunction(() => document.documentElement.dataset.uwHostTheme === 'dark', null, { timeout: 5000 });
  await page.waitForTimeout(500);
  assert.equal(await frame.evaluate(() => window.__uwReady), false, 'still waiting for its tiles');
  assert.equal(await frame.evaluate(() => window.uw.map.loaded()), false);
  const after = await pixel(page, 300, 120);
  release();
  assert.ok(lum(after) < 70, `dark as soon as the host says so, not once every tile is in: rgb(${after})`);
  assert.deepEqual(errors, []);
});

// A host still laying out its pane: the frame starts short and gets its height while the tiles load. The camera stayed
// fitted to the short frame (zoomed out) until every tile was in, then zoomed to the places.
test('in a host\'s frame resized while the tiles load, the first view fits the places in the new size at once and stays when the tiles come', { skip, timeout: 120000 }, async () => {
  const dir = makeSite('host-size');
  const { page, frame, errors, release, layout, size, styleIn } = await openHosted(dir, { viewport: { width: 400, height: 700 }, colorScheme: 'dark' }, { w: 375, h: 200 });
  await styleIn();
  await layout('dark');
  await size(375, 650);
  await page.waitForTimeout(800);
  assert.equal(await frame.evaluate(() => window.__uwReady), false, 'still waiting for its tiles');
  const loading = await placesIn(frame);
  assert.equal(loading.H, 650);
  for (const [k, [x, y]] of Object.entries(loading.pts)) {
    assert.ok(x >= 8 && x <= loading.W - 8 && y >= 8 && y <= loading.top - 8, `${k} above the sheet while the tiles load: ${JSON.stringify(loading)}`);
  }
  release();
  await frame.waitForFunction(() => window.__uwReady === true, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const ready = await placesIn(frame);
  assert.ok(Math.abs(ready.zoom - loading.zoom) < 0.01 && Math.abs(ready.center[0] - loading.center[0]) < 1e-5 && Math.abs(ready.center[1] - loading.center[1]) < 1e-5,
    `the first view does not move when the tiles come in: ${JSON.stringify({ loading, ready })}`);
  assert.deepEqual(errors, []);
});

// After a press on a map's card the pane said "Opening <title>…" only until the frame loaded, then showed a dark, empty
// pane for 2 to 5 s while the map drew itself. A host keeps its line for a page that lists "ready" in its layout-ack,
// until that page says `ready`.
test('in a host\'s frame, the map says it draws itself after it loads and says `ready` once drawn', { skip, timeout: 120000 }, async () => {
  const dir = makeSite('host-ready');
  const { frame, errors, release, layout, styleIn, said } = await openHosted(dir, { viewport: { width: 640, height: 700 }, colorScheme: 'dark' }, { w: 600, h: 650 });
  await styleIn();
  await layout('dark');
  await frame.waitForTimeout(500);
  const early = await said();
  const ack = early.find((m) => m.type === 'layout-ack');
  assert.ok(ack?.supports?.includes('ready'), `the layout-ack lists "ready": ${JSON.stringify(early)}`);
  assert.equal(early.filter((m) => m.type === 'ready').length, 0, 'not drawn while its tiles are on their way');
  release();
  await frame.waitForFunction(() => window.__uwReady === true, null, { timeout: 60000 });
  await frame.waitForTimeout(300);
  assert.equal((await said()).filter((m) => m.type === 'ready').length, 1, 'says ready once, when its first view is drawn');
  assert.deepEqual(errors, []);

});

// A map that cannot draw shows why, and says `ready` at once, so a host never holds "Opening …" over its message for
// 15 s. Its ready mark stays "false": the card keeps its picture instead of taking one of the message, and a page check
// still says the page never drew. A style that does not load (one that does not parse) and settings that break the
// start (not an object, a list that is not one) left the map empty with no reason and no `ready`.
test('in a host\'s frame, a map that cannot draw (settings or style that do not load, a start that breaks) shows why and says `ready` at once; its ready mark stays "false"', { skip, timeout: 180000 }, async () => {
  const cases = {
    'host-broken-settings': (dir) => fs.writeFileSync(path.join(dir, 'map.config.json'), '{ "title": '),
    'host-broken-style': (dir) => fs.writeFileSync(path.join(dir, 'style.json'), '{ "version": 8, '),
    'host-null-settings': (dir) => fs.writeFileSync(path.join(dir, 'map.config.json'), 'null'),
    'host-broken-start': (dir) => {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'map.config.json'), 'utf8'));
      fs.writeFileSync(path.join(dir, 'map.config.json'), JSON.stringify({ ...cfg, layers: 5 }));
    },
  };
  for (const [name, breakIt] of Object.entries(cases)) {
    const dir = makeSite(name);
    breakIt(dir);
    const b = await openHosted(dir, { viewport: { width: 640, height: 700 }, colorScheme: 'dark' }, { w: 600, h: 650 });
    await b.frame.waitForSelector('.uw-fatal', { timeout: 30000 }).catch(() => assert.fail(`${name}: no message says why the map cannot draw`));
    await b.layout('dark');
    await b.frame.waitForTimeout(500);
    const said = await b.said();
    assert.ok(said.find((m) => m.type === 'layout-ack')?.supports?.includes('ready'), `${name}: ${JSON.stringify(said)}`);
    assert.equal(said.filter((m) => m.type === 'ready').length, 1, `${name}: says ready once, at once: ${JSON.stringify(said)}`);
    assert.equal(await b.frame.evaluate(() => document.querySelectorAll('.uw-fatal').length), 1, `${name}: one message`);
    assert.equal(await b.frame.evaluate(() => document.documentElement.getAttribute('data-instafy-ready')), 'false', `${name}: never pictured as drawn`);
    assert.equal(await b.frame.evaluate(() => window.__uwReady), false, name);
    b.release();
  }
});

// A host whose chrome covers part of the frame (its composer, a chat sheet over the pane) says so in a layout that can
// come while the tiles load. The first view stayed fitted to the whole frame, with places under the host's chrome,
// until every tile was in.
test('in a host\'s frame, a layout whose chrome covers the bottom of the frame while the tiles load fits the places above it at once', { skip, timeout: 120000 }, async () => {
  const dir = makeSite('host-insets');
  const H = 650, COVER = 380;
  const { page, frame, errors, release, layout, styleIn } = await openHosted(dir, { viewport: { width: 960, height: 700 }, colorScheme: 'dark' }, { w: 900, h: H });
  await styleIn();
  await page.waitForTimeout(500);
  const first = await placesIn(frame);
  assert.ok(Object.values(first.pts).some(([, y]) => y > H - COVER), `a place sits where the host's chrome will be: ${JSON.stringify(first)}`);
  await layout('dark', { insets: { top: 0, bottom: COVER, left: 0, right: 0 } });
  await page.waitForTimeout(800);
  assert.equal(await frame.evaluate(() => window.__uwReady), false, 'still waiting for its tiles');
  const loading = await placesIn(frame);
  assert.equal(loading.H, H, 'the frame kept its size: only the host\'s chrome changed');
  for (const [k, [x, y]] of Object.entries(loading.pts)) {
    assert.ok(x >= 8 && x <= loading.W - 8 && y >= 8 && y <= H - COVER - 8, `${k} above the host's chrome while the tiles load: ${JSON.stringify(loading)}`);
  }
  release();
  await frame.waitForFunction(() => window.__uwReady === true, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const ready = await placesIn(frame);
  assert.ok(Math.abs(ready.zoom - loading.zoom) < 0.01 && Math.abs(ready.center[0] - loading.center[0]) < 1e-5 && Math.abs(ready.center[1] - loading.center[1]) < 1e-5,
    `the first view does not move when the tiles come in: ${JSON.stringify({ loading, ready })}`);
  assert.deepEqual(errors, []);
});
