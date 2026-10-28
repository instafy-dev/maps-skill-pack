// The 28 Oct drive's third map (375×812, "3 days in Lisbon"): a stay's card read "2 min walk (routed, 161 m) to Baixa ·
// hotel in OpenStreetMap, 4★ (OSM tag)", the Map key ended "Walking times: OSRM (FOSSGIS) on OpenStreetMap", and the
// sheet's title was cut ("Where to stay and what to see each …"). The card now says "2 min walk to Baixa · hotel, 4★"
// with how each part is known under its collapsed "How we know", the key's credits sit behind a collapsed "Sources",
// and the title wraps to a second line.
// Needs Playwright (UW_PLAYWRIGHT=/path/to/playwright, optionally UW_BROWSER_CHANNEL=chrome); skipped without it.
// Run: UW_PLAYWRIGHT=… node --test tests/plain-provenance-browser.test.mjs
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
const { rankStays } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'cmd-stay.mjs')).href);

let pw = null;
try { pw = await loadPlaywright(); } catch { pw = null; }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-provenance-b-'));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const JARGON = /routed|OSM tag|OSRM|FOSSGIS|in OpenStreetMap/;

test('a stay\'s card and the Map key read in plain words; how it is known is one tap away; the title wraps', { skip: pw ? false : 'Playwright not found (set UW_PLAYWRIGHT)', timeout: 120000 }, async () => {
  const dir = path.join(tmp, 'site');
  const r = spawnSync(process.execPath, [UW, 'new', dir, '--title', 'Where to stay and what to see each day', '--center', '-9.1375,38.7115', '--zoom', '15'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // the reason and its "how" exactly as uw stay writes them
  const [pick] = rankStays([{ name: 'Pestana Rua Augusta', coord: [-9.1372, 38.7101], walk_min: 2, walk_m: 161, walk_basis: 'routed', registered: false, osm_kind: 'hotel', stars: '4', group: 'hotel' }], { to: 'Baixa' });
  assert.equal(pick.why, '2 min walk to Baixa · hotel, 4★');
  fs.writeFileSync(path.join(dir, 'data', 'stays.geojson'), JSON.stringify({ type: 'FeatureCollection', uw: { cmd: 'stay' }, features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: pick.coord }, properties: { id: 'pestana', name: pick.name, kind: 'hotel', emoji: '🏨', stop: 'lisbon', rank: 1, why: pick.why, note: pick.why, how: pick.how, walk_min: 2, walk_m: 161, walk_basis: 'routed', walk_to: 'Baixa', stars: '4', source: 'OpenStreetMap' } },
  ] }));
  const cfgPath = path.join(dir, 'map.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.layers = [{ id: 'stays', title: 'Stays', type: 'points', data: 'data/stays.geojson' }];
  cfg.attribution = [...(cfg.attribution || []), '© OpenStreetMap contributors (ODbL)', 'Walking times: OSRM (FOSSGIS) on OpenStreetMap'];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const server = createStaticServer(dir);
  const port = await listen(server, 0, '127.0.0.1');
  closers.push(() => new Promise((res) => server.close(res)));
  const browser = await launchChromium(pw);
  closers.push(() => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 375, height: 560 }, hasTouch: true, isMobile: true });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.__uwReady === true, null, { timeout: 60000 });

  // the title: two lines on a phone, not cut after "each"
  const title = await page.evaluate(() => {
    const el = document.querySelector('.uw-title');
    const lh = parseFloat(getComputedStyle(el).lineHeight);
    return { text: el.innerText, lines: Math.round(el.getBoundingClientRect().height / lh), cut: el.scrollHeight > el.clientHeight + 1 };
  });
  assert.equal(title.text, 'Where to stay and what to see each day');
  assert.equal(title.lines, 2, JSON.stringify(title));
  assert.equal(title.cut, false, 'the whole title shows');

  // the card: plain words; the walk's basis and the tags' origin under "How we know", collapsed
  await page.evaluate(() => window.uw.select('stays', 'pestana'));
  await page.waitForFunction(() => /Pestana Rua Augusta/.test(document.querySelector('.uw-sheet')?.innerText || ''), null, { timeout: 10000 });
  await page.waitForTimeout(300);
  const card = await page.evaluate(() => document.querySelector('.uw-sheet').innerText);
  assert.match(card, /2 min walk to Baixa · hotel, 4★/);
  assert.match(card, /How we know/);
  assert.doesNotMatch(card, JARGON);
  await page.getByRole('button', { name: 'How we know' }).click();
  const how = await page.evaluate(() => document.querySelector('.uw-how')?.innerText || '');
  assert.match(how, /Walk · 161 m along the streets, routed on OpenStreetMap \(OSRM, FOSSGIS\)/);
  assert.match(how, /Kind and stars · as mapped in OpenStreetMap, not a rating/);

  // the Map key: the layers, then "Sources" collapsed; the credits are there once it is opened
  await page.evaluate(() => { window.uw.clearSelection?.(); window.uw.ui.openSheet('layers'); window.uw.ui.snap('full'); });
  await page.waitForTimeout(400);
  const key = await page.evaluate(() => document.querySelector('.uw-sheet').innerText);
  assert.match(key, /Stays/);
  assert.match(key, /Sources/);
  assert.doesNotMatch(key, /OSRM|FOSSGIS|ODbL/);
  await page.getByRole('button', { name: 'Sources' }).click();
  const credits = await page.evaluate(() => document.querySelector('.uw-sheet').innerText);
  assert.match(credits, /Walking times: OSRM \(FOSSGIS\) on OpenStreetMap/);
  assert.deepEqual(errors, []);
});
