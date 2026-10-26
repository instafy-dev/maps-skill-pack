// Follow mode end to end in a real browser (Instafy docs/Follow-Mode.md): a Studio-like parent frames the same map
// twice, a phone (390 px, sheet) and a desktop (1000 px, side panel), and relays like Studio does: the presenter's
// "view" becomes the follower's "apply-view", "tap" becomes "apply-tap", and the follower's "interact" stops the relay.
// Checked: nothing goes out before "present"; the follower ends up with the presenter's hash state (lens, selection,
// layers, day, tab) and shows the presenter's area; applying never echoes a view or an interact; the presenter's tap is
// a ripple with their name; after "Show my location" the view has cam:null until the presenter pans, and a tap on the
// "me" dot is not sent; the follower's own wheel is an "interact"; Follow again catches up at once.
// Needs Playwright (UW_PLAYWRIGHT=/path/to/playwright, optionally UW_BROWSER_CHANNEL=chrome); skipped without it.
// Tiles and other outside requests are blocked: no network.
// Run: UW_PLAYWRIGHT=… node --test map-pack/tests/follow-browser.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// the example sites are kept out of this repository (too large); tests that open one skip without them
const NO_EXAMPLES = fs.existsSync(path.join(HERE, '..', 'examples')) ? false : 'needs examples/ (not in this repository)';
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const { loadPlaywright, launchChromium, createStaticServer, listen } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'cmd-serve.mjs')).href);
const F = await import(pathToFileURL(path.join(SKILL, 'starter', 'engine', 'follow.js')).href);

let pw = null;
try { pw = await loadPlaywright(); } catch { pw = null; }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-follow-'));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

// a real example with the pack's current engine (not the example's own copy)
function site(name, edit = null) {
  const dir = path.join(tmp, name);
  fs.cpSync(path.join(HERE, '..', 'examples', name), dir, { recursive: true, filter: (p) => !/[/\\](snapshots|\.uwcache)([/\\]|$)/.test(p) });
  fs.rmSync(path.join(dir, 'engine'), { recursive: true, force: true });
  fs.cpSync(path.join(SKILL, 'starter', 'engine'), path.join(dir, 'engine'), { recursive: true });
  if (edit) { const f = path.join(dir, 'map.config.json'); fs.writeFileSync(f, JSON.stringify(edit(JSON.parse(fs.readFileSync(f, 'utf8'))))); }
  return dir;
}

const FIX = { latitude: 25.0412, longitude: 121.5437 };
// the parent: two frames of one site and a relay that behaves like Studio's follow mode
const PARENT = (src, siteOrigin) => `<!doctype html><meta charset="utf-8"><title>host</title>
<style>html,body{margin:0}iframe{border:0;position:absolute;top:0}#a{left:0;width:390px;height:780px}#b{left:400px;width:1000px;height:700px}</style>
<iframe id="a" src="${src}" allow="fullscreen"></iframe><iframe id="b" src="${src}" allow="fullscreen"></iframe>
<script>
  const SITE = ${JSON.stringify(siteOrigin)};
  const A = document.getElementById('a'), B = document.getElementById('b');
  Object.assign(window, { views: [], taps: [], interacts: [], acks: {}, echo: [], relay: true, applied: 0 });
  const layout = { source: 'instafy-host', v: 1, type: 'layout', insets: { top: 0, bottom: 0, left: 0, right: 0 }, chrome: 'host',
    title: 'hidden', caps: { geolocation: true, location: 'host' }, theme: 'light' };
  for (const f of [A, B]) f.addEventListener('load', () => f.contentWindow.postMessage(layout, SITE));
  const to = (f, m) => f.contentWindow.postMessage({ source: 'instafy-host', v: 1, ...m }, SITE);
  const KIM = { id: 'u1', name: 'Kim' };
  window.addEventListener('message', (e) => {
    if (e.origin !== SITE) return;
    const who = e.source === A.contentWindow ? 'a' : e.source === B.contentWindow ? 'b' : null;
    const d = e.data; if (!who || !d || typeof d !== 'object') return;
    if (d.type === 'layout-ack') window.acks[who] = d.payload;
    if (d.type === 'location-request') to(who === 'a' ? A : B, { type: 'location', payload: { id: d.payload.id, coords: { ...${JSON.stringify(FIX)}, accuracy: 12 }, timestamp: Date.now() } });
    if (who === 'a' && d.type === 'view') { window.views.push({ ...d, t: performance.now() }); if (window.relay) { window.applied++; to(B, { type: 'apply-view', seq: d.seq, payload: d.payload, from: KIM, smooth: true }); } }
    if (who === 'a' && d.type === 'tap') { window.taps.push(d); if (window.relay) to(B, { type: 'apply-tap', payload: d.payload, from: KIM }); }
    if (who === 'b' && d.type === 'interact') { window.interacts.push(window.applied); window.relay = false; }
    if (who === 'b' && (d.type === 'view' || d.type === 'tap')) window.echo.push(d.type);
  });
  window.present = (on, location) => to(A, { type: 'present', on, share: { location: !!location } });
  window.followAgain = () => { window.relay = true; const v = window.views.at(-1); to(B, { type: 'apply-view', seq: v.seq, payload: v.payload, from: KIM, smooth: false }); };
</script>`;

async function setup(browser, name, edit) {
  const dir = site(name, edit);
  const siteServer = createStaticServer(dir);
  const sitePort = await listen(siteServer, 0, '127.0.0.1');
  closers.push(() => new Promise((r) => siteServer.close(r)));
  const siteOrigin = `http://127.0.0.1:${sitePort}`;
  const parentServer = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PARENT(`${siteOrigin}/?instafy_host=studio`, siteOrigin)); });
  const parentPort = await listen(parentServer, 0, '127.0.0.1');
  closers.push(() => new Promise((r) => parentServer.close(r)));
  const ctx = await browser.newContext({ viewport: { width: 1420, height: 800 } });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${parentPort}/`);
  const frame = async (id) => (await page.waitForSelector('#' + id)).contentFrame();
  const a = await frame('a'), b = await frame('b');
  if (process.env.FOLLOW_DEBUG) { page.on('console', (m) => console.log('[console]', m.text())); }
  const info = (f) => f.evaluate(() => JSON.stringify({ ready: window.__uwReady, errs: window.__uwErrors, host: window.uw ? window.uw.host : null }));
  for (const f of [a, b]) {
    try { await f.waitForFunction(() => window.__uwReady === true && window.uw?.host?.layout, null, { timeout: 60000 }); } catch (e) { throw new Error(`${e.message} ${await info(f)}`); }
  }
  return { ctx, page, a, b, errors };
}

// the hash state without the camera, from a frame
const stateOf = (f) => f.evaluate(() => location.hash).then((h) => { const { at, ...s } = F.parseState(h); return s; });
const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const overlap = (x, y) => area([Math.max(x[0], y[0]), Math.max(x[1], y[1]), Math.min(x[2], y[2]), Math.min(x[3], y[3])]);
async function until(fn, ms = 8000, what = 'condition') {
  const t0 = Date.now(); let last;
  for (;;) { last = await fn(); if (last) return last; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 100)); }
}

test('a phone presents, a desktop follows: same state and area, a ripple, no echo, location left out, interact stops it', { skip: NO_EXAMPLES || (pw ? false : 'Playwright not found (set UW_PLAYWRIGHT)'), timeout: 180000 }, async () => {
  const browser = await launchChromium(pw);
  closers.push(() => browser.close());
  const { ctx, page, a, b, errors } = await setup(browser, 'taipei-stay');
  const acks = await page.evaluate(() => window.acks);
  for (const k of ['a', 'b']) for (const s of ['view', 'tap']) assert.ok(acks[k]?.supports?.includes(s), `${k} ack lists ${s}`);
  assert.equal(await a.evaluate(() => window.uw.state.side), false, 'a is the phone sheet');
  assert.equal(await b.evaluate(() => window.uw.state.side), true, 'b is the desktop side panel');

  // nothing leaves before the host says present
  const hotels = await a.evaluate(() => window.uw.getFeatures('hotels').map((f) => String(f.properties.id)));
  assert.ok(hotels.length >= 2);
  await a.evaluate((id) => window.uw.select('hotels', id), hotels[0]);
  await page.waitForTimeout(500);
  assert.equal((await page.evaluate(() => window.views)).length, 0);

  // present: the presenter changes lens, selection, a layer, the tab, and pans; the follower matches
  await page.evaluate(() => window.present(true));
  await until(() => page.evaluate(() => window.views.length > 0), 5000, 'the first view');
  await a.evaluate((id) => {
    const uw = window.uw;
    uw.setLens('night');
    uw.select('hotels', id);
    uw.setLayerVisible('mrt', false);
    uw.map.jumpTo({ center: [121.545, 25.045], zoom: 15.2 });
  }, hotels[1]);
  await until(async () => JSON.stringify(await stateOf(b)) === JSON.stringify(await stateOf(a)), 8000, 'the follower\'s hash to equal the presenter\'s');
  const sa = await stateOf(a);
  assert.equal(sa.l, 'night'); assert.equal(sa.s, `hotels:${hotels[1]}`); assert.deepEqual(sa.off, ['mrt']);
  // the same area: the follower (a wider frame) shows all of what the presenter sees, and not much more
  let va, vb, ov = 0;
  await until(async () => {
    [va, vb] = [await a.evaluate(() => window.uw.view()), await b.evaluate(() => window.uw.view())];
    ov = va.cam && vb.cam ? overlap(va.cam.b, vb.cam.b) / area(va.cam.b) : 0;
    return ov >= 0.9;
  }, 4000, 'the follower to show the presenter\'s area').catch(() => {});
  assert.ok(ov >= 0.9, `≥ 90% of the presenter's area is on the follower's screen: ${ov.toFixed(3)} ${JSON.stringify([va?.cam, vb?.cam])}`);
  assert.ok(area(vb.cam.b) / area(va.cam.b) < 4, 'and the follower is not zoomed far out');
  assert.equal(vb.card, true, 'the card is open on both');
  // the tab: open Compare on the presenter (closing the card), the follower follows
  await a.evaluate(() => { window.uw.ui.openSheet('compare'); });
  await until(() => b.evaluate(() => window.uw.view().tab === 'compare' && window.uw.view().card === false), 5000, 'the follower\'s Compare tab');
  // applying views never echoes them, and is never reported as the person's own interaction
  assert.deepEqual(await page.evaluate(() => window.echo), []);
  assert.deepEqual(await page.evaluate(() => window.interacts), []);
  // ≤ 10 views a second while the presenter pans continuously
  const n0 = (await page.evaluate(() => window.views)).length;
  await a.evaluate(() => new Promise((r) => { const m = window.uw.map; let i = 0; const t = setInterval(() => { m.jumpTo({ center: [121.545 + i * 0.0004, 25.045] }); if (++i >= 60) { clearInterval(t); r(); } }, 16); }));
  await page.waitForTimeout(300);
  const burst = (await page.evaluate(() => window.views)).slice(n0);
  const span = (burst.at(-1).t - burst[0].t) / 1000;
  assert.ok(burst.length <= Math.ceil(span * 10) + 2, `${burst.length} views in ${span.toFixed(2)} s`);
  for (const v of burst) assert.ok(F.viewBytes(v.payload) <= 2048);

  // a tap on the presenter's map becomes a ripple with the presenter's name on the follower
  const box = await page.locator('#a').boundingBox();
  const taps0 = (await page.evaluate(() => window.taps)).length;
  await page.mouse.click(box.x + 200, box.y + 200);
  await until(() => page.evaluate((n) => window.taps.length > n, taps0), 4000, 'a tap');
  const tap = (await page.evaluate(() => window.taps)).at(-1);
  assert.ok(tap.payload.x > 0 && tap.payload.x < 1 && Array.isArray(tap.payload.at));
  await b.locator('.uw-ripple', { hasText: 'Kim' }).waitFor({ state: 'attached', timeout: 4000 });

  // "Show my location" on the presenter: the views leave the camera out (cam:null) until they pan; the "me" dot is never a tap
  await a.locator('[data-id="uw-locate"]').click();
  await a.locator('.uw-me').waitFor({ state: 'attached', timeout: 10000 });
  await until(() => a.evaluate(() => !window.uw.map.isMoving()), 8000, 'the flight to the fix');
  await until(() => page.evaluate(() => window.views.at(-1).payload.cam === null), 4000, 'a view with cam:null');
  const vAfterFix = (await page.evaluate(() => window.views.length));
  const near = (x, y) => Math.abs(x - FIX.longitude) < 0.0001 && Math.abs(y - FIX.latitude) < 0.0001;
  const dot = await a.locator('.uw-me').boundingBox();
  const tapsBefore = (await page.evaluate(() => window.taps)).length;
  await page.mouse.click(dot.x + dot.width / 2, dot.y + dot.height / 2);
  await page.waitForTimeout(500);
  assert.equal((await page.evaluate(() => window.taps)).length, tapsBefore, 'a tap on the "me" dot is not sent');
  for (const v of (await page.evaluate(() => window.views)).slice(vAfterFix - 1)) {
    assert.equal(v.payload.cam, null);
    assert.ok(!(JSON.stringify(v.payload).includes(FIX.latitude.toFixed(4)) && JSON.stringify(v.payload).includes(FIX.longitude.toFixed(4))), 'no position in the view');
  }
  // the presenter pans away (their own drag): the camera is shared again
  await page.mouse.move(box.x + 200, box.y + 150);
  await page.mouse.down(); await page.mouse.move(box.x + 120, box.y + 230, { steps: 8 }); await page.mouse.up();
  await until(() => page.evaluate(() => window.views.at(-1).payload.cam !== null), 4000, 'the camera back in the view');
  const lastCam = (await page.evaluate(() => window.views.at(-1).payload.cam.b));
  assert.ok(!near((lastCam[0] + lastCam[2]) / 2, (lastCam[1] + lastCam[3]) / 2));

  // the follower's own wheel is an interact (Studio stops following); the presenter's next moves do not move it
  const bbox = await page.locator('#b').boundingBox();
  await page.mouse.move(bbox.x + 700, bbox.y + 350);
  await page.mouse.wheel(0, -300);
  await until(() => page.evaluate(() => window.interacts.length === 1), 3000, 'an interact');
  await page.waitForTimeout(500);
  const before = await stateOf(b);
  await a.evaluate((id) => window.uw.select('hotels', id), hotels[0]);
  await page.waitForTimeout(800);
  assert.deepEqual(await stateOf(b), before, 'not following any more');
  // Follow again: one jump catches up
  await page.evaluate(() => window.followAgain());
  await until(async () => (await stateOf(b)).s === `hotels:${hotels[0]}`, 5000, 'Follow again');
  assert.deepEqual(await page.evaluate(() => window.echo), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a plan day and the Plan tab follow too (a walk planned over three days)', { skip: NO_EXAMPLES || (pw ? false : 'Playwright not found (set UW_PLAYWRIGHT)'), timeout: 120000 }, async () => {
  const browser = await launchChromium(pw);
  closers.push(() => browser.close());
  // daan-coffee-walk, its one day repeated three times (taiwan-loop needs its terrain tiles to get ready offline)
  const { ctx, page, a, b, errors } = await setup(browser, 'daan-coffee-walk', (c) => ({ ...c, plan: { ...c.plan, days: [0, 1, 2].map((i) => ({ ...c.plan.days[0], title: `Day ${i + 1}` })) } }));
  await page.evaluate(() => window.present(true));
  await until(() => page.evaluate(() => window.views.length > 0), 5000, 'the first view');
  await a.evaluate(() => { window.uw.ui.openSheet('plan'); window.uw.setDay(2); });
  await until(async () => (await stateOf(b)).d === 3, 8000, 'day 3 on the follower');
  await until(() => b.evaluate(() => window.uw.view().tab === 'plan'), 5000, 'the Plan tab on the follower');
  assert.equal(await b.evaluate(() => window.uw.state.day), 2);
  assert.deepEqual(await page.evaluate(() => window.echo), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});
