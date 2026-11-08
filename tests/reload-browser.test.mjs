// Every open view of a `uw host` map follows the reload Instafy sends a site after a saved change or an Undo, in a real
// browser: a note added to a trip's day by hand showed in neither open view of the map until each was reloaded by
// hand, because `uw host` reloaded its viewers only on `uw reload`'s stamp in data/version.json. Here a stand-in for the
// runtime's `instafy bind command <site> reload '{}'` (tests/fixtures.mjs bindCommand) reaches two open pages of one
// map, which reload in place, and not the page of another map; and a map made before (its engine still looks for that
// stamp, and its data/version.json has none) loads under the new host and reloads the same way. A view on a trip's Plan
// tab comes back on the Plan: its day selects the base with no card, and that card came back over the Plan after each
// reload.
// Needs Playwright (UW_PLAYWRIGHT=/path/to/playwright, optionally UW_BROWSER_CHANNEL=chrome); skipped without it.
// Offline: every request off this computer is aborted. Run: UW_PLAYWRIGHT=… node --test tests/reload-browser.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bindCommand } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const { loadPlaywright, launchChromium } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'cmd-serve.mjs')).href);

let pw = null;
try { pw = await loadPlaywright(); } catch { pw = null; }

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'uw-reload-b-')));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const env = { ...process.env, UW_NO_CACHE: '1', UW_TURN_BUDGET: '0' };
for (const k of ['INSTAFY_CACHE_DIR', 'INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE']) delete env[k];
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 100)); } };

function newMap(rel, title) {
  const made = spawnSync(process.execPath, [UW, 'new', rel, '--title', title, '--center', '-8.6291,41.1579', '--zoom', '13'], { cwd: tmp, env, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stdout + made.stderr);
  return path.join(tmp, rel);
}
/** A map made before: the engine it was made with looked for `uw reload`'s stamp in data/version.json (the only engine
 *  change since: those lines put back), and its data/version.json has no stamp. */
function oldMap(rel, title) {
  const dir = newMap(rel, title);
  const file = path.join(dir, 'engine', 'bind.js');
  const src = fs.readFileSync(file, 'utf8');
  const at = '      if (prev && prev.v !== ver.v) this.E.onVersion?.(ver);\n';
  assert.ok(src.includes(at));
  fs.writeFileSync(file, src.replace(at, `${at}      // \`uw reload\` stamps "reload" for viewers that only poll (no SSE): the page changed, reload in place\n`
    + "      if (prev && typeof ver.reload === 'string' && ver.reload !== prev.reload) this.command({ name: 'reload', args: { note: ver.reload_note } });\n"));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'version.json'), JSON.stringify({ v: 1, updated_at: '2026-11-07T20:53:36.167Z', files: {}, jobs: {} }, null, 2));
  return dir;
}
/** A trip map with its days planned (a base and two sights), as a turn builds one */
function tripMap(rel, title) {
  const dir = newMap(rel, title);
  const pt = (id, c, p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { id, ...p } });
  const w = (f, j) => fs.writeFileSync(path.join(dir, 'data', f), JSON.stringify(j));
  w('stops.geojson', { type: 'FeatureCollection', uw: { cmd: 'add-point' }, features: [pt('porto', [-8.6291, 41.1579], { name: 'Porto', kind: 'city', nights: 2 })] });
  w('stays.geojson', { type: 'FeatureCollection', uw: { cmd: 'stay' }, features: [pt('porto-hotel', [-8.6110, 41.1460], { name: 'Hotel da Ribeira', kind: 'hotel', stop: 'porto', rank: 1, walk_min: 3, walk_to: 'Ribeira' })] });
  w('sights.geojson', { type: 'FeatureCollection', uw: { cmd: 'add-point' }, features: [
    pt('se', [-8.6110, 41.1428], { name: 'Sé do Porto', stop: 'porto', source_url: 'https://en.wikipedia.org/wiki/Porto_Cathedral', source: 'Wikipedia' }),
    pt('bolsa', [-8.6155, 41.1413], { name: 'Palácio da Bolsa', stop: 'porto', source_url: 'https://en.wikipedia.org/wiki/Pal%C3%A1cio_da_Bolsa', source: 'Wikipedia' })] });
  const cfgPath = path.join(dir, 'map.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.layers = [
    { id: 'stops', title: 'Stops', type: 'points', data: 'data/stops.geojson', list: false },
    { id: 'stays', title: 'Stays', type: 'points', data: 'data/stays.geojson', list: true },
    { id: 'sights', title: 'Sights', type: 'points', data: 'data/sights.geojson', list: true },
  ];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  // the days as they are (a 100 s turn: too little time left to add places)
  const planned = spawnSync(process.execPath, [UW, 'plan', dir, '--stops', 'stops', '--ids', 'porto', '--nights', '2', '--start', '2026-11-06', '--stays', 'stays', '--sights', 'sights'],
    { cwd: tmp, env: { ...env, UW_TURN_BUDGET: '100' }, encoding: 'utf8' });
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  return dir;
}
/** `uw host . --port <port>` from the map's own folder, as its preview card starts it */
async function host(dir) {
  const port = await freePort();
  const p = spawn(process.execPath, [UW, 'host', '.', '--port', String(port), '--no-warm'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', (d) => { log += d; }); p.stderr.on('data', (d) => { log += d; });
  closers.push(() => new Promise((r) => { if (p.exitCode !== null) return r(); p.once('exit', r); p.kill('SIGTERM'); }));
  const up = await waitFor(() => fetch(`http://127.0.0.1:${port}/__uw/health`).then((r) => r.ok, () => false));
  assert.ok(up, 'uw host answers: ' + log);
  return { port, log: () => log, viewers: () => fetch(`http://127.0.0.1:${port}/__uw/health`).then((r) => r.json()).then((j) => j.viewers, () => -1) };
}

test('the reload Instafy sends a changed map reaches every open view of it, which reloads in place; a map made before loads and reloads too', { skip: pw ? false : 'Playwright not found (set UW_PLAYWRIGHT)', timeout: 180000 }, async () => {
  const porto = newMap('sites/porto', 'Porto in 3 days');
  const lisbon = oldMap('sites/lisbon', 'Lisbon in 3 days');
  const P = await host(porto), L = await host(lisbon);

  const browser = await launchChromium(pw);
  closers.push(() => browser.close());
  const errors = [];
  const open = async (port, opts) => {
    const ctx = await browser.newContext(opts);
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => window.__uwReady === true, null, { timeout: 60000 });
    await page.evaluate(() => { window.__before = true; });
    return page;
  };
  // two open views of the Porto map (a desktop and a phone), one of the Lisbon map made before
  const desk = await open(P.port, { viewport: { width: 1280, height: 800 } });
  const phone = await open(P.port, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const old = await open(L.port, { viewport: { width: 1280, height: 800 } });
  assert.ok(await waitFor(async () => (await P.viewers()) === 2 && (await L.viewers()) === 1), `viewers: ${await P.viewers()}, ${await L.viewers()}`);

  const reloaded = async (page) => {
    await page.waitForFunction(() => window.__uwReady === true && window.__before === undefined, null, { timeout: 60000 });
    return page.evaluate(() => ({ nav: performance.getEntriesByType('navigation')[0]?.type, toast: [...document.querySelectorAll('.uw-toast')].map((t) => t.textContent).join(' | ') }));
  };
  // the stand-in runtime sends the Porto map its reload: both of its views reload in place, with the short toast
  const sent = await bindCommand(porto, 'reload');
  assert.deepEqual([sent.status, sent.json?.viewers], [202, 2], sent.text);
  for (const page of [desk, phone]) {
    const r = await reloaded(page);
    assert.equal(r.nav, 'reload');
    assert.match(r.toast, /Map updated/);
  }
  // and the Lisbon map's view stays as it was
  assert.equal(await old.evaluate(() => window.__before), true, 'another map is not reloaded');
  // the map made before: it loaded, and its reload reaches it the same way
  const sentOld = await bindCommand(lisbon, 'reload');
  assert.deepEqual([sentOld.status, sentOld.json?.viewers], [202, 1], sentOld.text);
  const r = await reloaded(old);
  assert.equal(r.nav, 'reload');
  assert.match(r.toast, /Map updated/);
  // every view came back to its map and listens again
  assert.ok(await waitFor(async () => (await P.viewers()) === 2 && (await L.viewers()) === 1));
  assert.deepEqual(errors, []);
});

test('a reload keeps a view on the Plan tab on the Plan: its day\'s base stays selected with no card over it; a card that was open stays open', { skip: pw ? false : 'Playwright not found (set UW_PLAYWRIGHT)', timeout: 180000 }, async () => {
  const dir = tripMap('sites/porto-trip', 'Porto in 2 days');
  const H = await host(dir);
  const browser = await launchChromium(pw);
  closers.push(() => browser.close());
  const errors = [];
  const view = (page) => page.evaluate(() => ({
    shown: [...document.querySelectorAll('.uw-panel')].filter((p) => !p.hidden).map((p) => p.dataset.panel),
    tab: [...document.querySelectorAll('.uw-tab[aria-selected="true"]')].map((b) => b.dataset.tab),
    sel: /[#&]s=([^&]+)/.exec(location.hash)?.[1] ?? null,
  }));
  const reload = async (page) => {
    await page.evaluate(() => { window.__before = true; });
    const sent = await bindCommand(dir, 'reload');
    assert.equal(sent.status, 202, sent.text);
    await page.waitForFunction(() => window.__uwReady === true && window.__before === undefined, null, { timeout: 60000 });
    // the selection's card would come with the selection, as the page draws it
    await page.waitForTimeout(800);
  };
  for (const opts of [{ viewport: { width: 1280, height: 800 } }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]) {
    const ctx = await browser.newContext(opts);
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${H.port}/`);
    await page.waitForFunction(() => window.__uwReady === true, null, { timeout: 60000 });
    // the person opens the Plan tab: day 1 selects its base, with no card over the Plan
    await page.click('.uw-tab[data-tab="plan"]');
    await page.waitForFunction(() => /[#&]d=1/.test(location.hash), null, { timeout: 10000 });
    const before = await view(page);
    assert.deepEqual([before.shown, before.tab, before.sel], [['plan'], ['plan'], 'stays:porto-hotel'], JSON.stringify(before));
    // a change is saved and the view reloads: the Plan, as it was, the base still selected
    await reload(page);
    assert.deepEqual(await view(page), before, `${opts.viewport.width} px: the Plan tab stays open, with no card over it`);
    // a place's card open when the reload comes stays open
    await page.evaluate(() => window.uw.select('sights', 'bolsa'));
    await page.waitForFunction(() => !document.querySelector('[data-panel="card"]')?.hidden, null, { timeout: 10000 });
    await page.waitForTimeout(400);
    await reload(page);
    const card = await view(page);
    assert.deepEqual([card.shown, card.sel], [['card'], 'sights:bolsa'], JSON.stringify(card));
    await ctx.close();
  }
  assert.deepEqual(errors, []);
});
