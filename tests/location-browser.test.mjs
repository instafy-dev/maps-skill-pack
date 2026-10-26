// "Show my location" end to end in a real browser (Instafy docs/Previews.md "Location"): a cross-origin parent page frames a map
// the way Instafy Studio does (allow without geolocation, ?instafy_host=studio, a layout with caps.location "host") and
// answers the map's location-request; the "me" dot appears, and a "stopped" answer becomes the ▾-menu toast. Standalone,
// the same button uses the browser's geolocation. Needs Playwright (UW_PLAYWRIGHT=/path/to/playwright, or one the pack
// finds); skipped without it. Tiles and other outside requests are blocked: no network.
// Run: UW_PLAYWRIGHT=… node --test map-pack/tests/location-browser.test.mjs
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

let pw = null;
try { pw = await loadPlaywright(); } catch { pw = null; }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-locate-'));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

// a real example with the pack's current engine (not the example's own copy)
function site() {
  const dir = path.join(tmp, 'site');
  fs.cpSync(path.join(HERE, '..', 'examples', 'daan-coffee-walk'), dir, { recursive: true, filter: (p) => !/[/\\](snapshots|\.uwcache)([/\\]|$)/.test(p) });
  fs.rmSync(path.join(dir, 'engine'), { recursive: true, force: true });
  fs.cpSync(path.join(SKILL, 'starter', 'engine'), path.join(dir, 'engine'), { recursive: true });
  return dir;
}

// the parent: frames the site like Studio and answers location requests per window.reply ('fix' | 'stopped')
const PARENT = (src, siteOrigin) => `<!doctype html><meta charset="utf-8"><title>host</title>
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>
<iframe id="f" src="${src}" allow="fullscreen; clipboard-write"></iframe>
<script>
  const f = document.getElementById('f');
  window.requests = []; window.reply = 'fix';
  const layout = { source: 'instafy-host', v: 1, type: 'layout', insets: { top: 0, bottom: 0, left: 0, right: 0 }, chrome: 'host',
    title: 'hidden', caps: { geolocation: true, location: 'host' }, theme: 'light' };
  f.addEventListener('load', () => f.contentWindow.postMessage(layout, ${JSON.stringify(siteOrigin)}));
  window.addEventListener('message', (e) => {
    if (e.source !== f.contentWindow || e.origin !== ${JSON.stringify(siteOrigin)}) return;
    const d = e.data; if (!d || d.type !== 'location-request') return;
    window.requests.push({ origin: e.origin, msg: d });
    const id = d.payload.id;
    const out = window.reply === 'fix'
      ? { source: 'instafy-host', v: 1, type: 'location', payload: { id, coords: { latitude: 25.0300, longitude: 121.5350, accuracy: 15 }, timestamp: Date.now() } }
      : { source: 'instafy-host', v: 1, type: 'location-error', payload: { id, code: window.reply } };
    f.contentWindow.postMessage(out, ${JSON.stringify(siteOrigin)});
  });
</script>`;

test('in a Studio-like frame the button asks the host (no geolocation in the frame); standalone it asks the browser', { skip: NO_EXAMPLES || (pw ? false : 'Playwright not found (set UW_PLAYWRIGHT)'), timeout: 120000 }, async () => {
  const dir = site();
  const siteServer = createStaticServer(dir);
  const sitePort = await listen(siteServer, 0, '127.0.0.1');
  closers.push(() => new Promise((r) => siteServer.close(r)));
  const siteOrigin = `http://127.0.0.1:${sitePort}`;
  const parentServer = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PARENT(`${siteOrigin}/?instafy_host=studio`, siteOrigin)); });
  const parentPort = await listen(parentServer, 0, '127.0.0.1');
  closers.push(() => new Promise((r) => parentServer.close(r)));

  const browser = await launchChromium(pw);
  closers.push(() => browser.close());
  const offline = async (ctx) => ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());

  // hosted: the parent is http://localhost, the site http://127.0.0.1 (two origins, like Studio and a viewer host)
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, permissions: [] });
  await offline(ctx);
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${parentPort}/`);
  const frame = page.frameLocator('#f');
  const btn = frame.locator('[data-id="uw-locate"]');
  await btn.waitFor({ state: 'visible', timeout: 60000 });
  const fr = page.frames().find((x) => x.url().startsWith(siteOrigin));
  await fr.waitForFunction(() => window.uw?.host?.layout?.caps?.location === 'host', null, { timeout: 15000 });
  // the frame itself cannot use geolocation (Permissions Policy): only the host path can work
  assert.equal(await fr.evaluate(() => document.featurePolicy?.allowsFeature?.('geolocation') ?? null), false);
  await btn.click();
  await frame.locator('.uw-me').waitFor({ state: 'attached', timeout: 10000 });
  const reqs = await page.evaluate(() => window.requests);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].origin, siteOrigin);
  assert.equal(reqs[0].msg.source, 'instafy-map'); assert.equal(reqs[0].msg.v, 1);
  assert.equal(reqs[0].msg.payload.watch, false); assert.equal(reqs[0].msg.payload.highAccuracy, true);
  assert.match(reqs[0].msg.payload.id, /^loc_/);
  const c = await fr.evaluate(() => new Promise((r) => { const m = window.uw.map; const done = () => r(m.getCenter().toArray()); m.isMoving() ? m.once('moveend', done) : done(); }));
  assert.ok(Math.abs(c[0] - 121.535) < 0.01 && Math.abs(c[1] - 25.03) < 0.01, `flew to the fix: ${c}`);
  // a stopped site: the toast points at the host's menu (no icon: the phone pill shows ⋯, the bar ▾)
  await page.evaluate(() => { window.reply = 'stopped'; });
  await btn.click();
  await frame.locator('.uw-toast', { hasText: 'Location is off for this site · turn it on in Studio’s menu for this preview' }).waitFor({ timeout: 5000 });
  await ctx.close();

  // standalone: the browser's own geolocation, the same dot
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 780 }, permissions: ['geolocation'], geolocation: { latitude: 25.0335, longitude: 121.5433 } });
  await offline(ctx2);
  const p2 = await ctx2.newPage();
  await p2.goto(`${siteOrigin}/`);
  await p2.locator('[data-id="uw-locate"]').waitFor({ state: 'visible', timeout: 60000 });
  await p2.locator('[data-id="uw-locate"]').click();
  await p2.locator('.uw-me').waitFor({ state: 'attached', timeout: 10000 });
  assert.equal(await p2.evaluate(() => window.uw.host.hosted), false);
  await ctx2.close();
});
