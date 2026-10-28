// The drive's place cards on a real page (28 Oct 2026: "Baixa · Suburb", "Belém · Administrative" and "Source:
// OpenStreetMap search (Photon)"): the card and the Places list say "Neighbourhood" and "Area", and the card's source
// line is "Map data © OpenStreetMap".
// Needs Playwright (UW_PLAYWRIGHT=/path/to/playwright, optionally UW_BROWSER_CHANNEL=chrome); skipped without it.
// Run: UW_PLAYWRIGHT=… node --test tests/plain-labels-browser.test.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-labels-b-'));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const pt = (id, c, p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { id, ...p } });

test('place cards and the Places list say plain words and whose map data it is', { skip: pw ? false : 'Playwright not found (set UW_PLAYWRIGHT)', timeout: 120000 }, async () => {
  const dir = path.join(tmp, 'site');
  const r = spawnSync(process.execPath, [UW, 'new', dir, '--title', 'Lisbon', '--center', '-9.15,38.71', '--zoom', '12'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const photon = 'OpenStreetMap search (Photon)';
  fs.writeFileSync(path.join(dir, 'data', 'sights.geojson'), JSON.stringify({ type: 'FeatureCollection', uw: { cmd: 'add-point' }, features: [
    pt('baixa', [-9.1375, 38.7115], { name: 'Baixa', kind: 'suburb', area: 'Santa Maria Maior', source: photon, osm_id: 'osm-r123' }),
    pt('belem', [-9.2063, 38.6973], { name: 'Belém', kind: 'administrative', source: `${photon} (Overpass unavailable)`, data_status: 'partial' }),
    pt('osm-n42', [-9.1334, 38.7099], { name: 'Sé de Lisboa', kind: 'cathedral' }),
  ] }));
  const cfgPath = path.join(dir, 'map.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.layers = [{ id: 'sights', title: 'Sights', type: 'points', data: 'data/sights.geojson' }];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const server = createStaticServer(dir);
  const port = await listen(server, 0, '127.0.0.1');
  closers.push(() => new Promise((res) => server.close(res)));
  const browser = await launchChromium(pw);
  closers.push(() => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.__uwReady === true, null, { timeout: 60000 });

  const card = async (id) => {
    await page.evaluate((x) => window.uw.select('sights', x), id);
    await page.waitForFunction((x) => new RegExp(x).test(document.body.innerText), { baixa: 'Baixa', belem: 'Belém', 'osm-n42': 'Sé de Lisboa' }[id], { timeout: 10000 });
    await page.waitForTimeout(300);
    return page.evaluate(() => document.body.innerText);
  };
  const baixa = await card('baixa');
  assert.match(baixa, /Neighbourhood · Santa Maria Maior/);
  assert.match(baixa, /Map data © OpenStreetMap/);
  const belem = await card('belem');
  assert.match(belem, /\bArea\b/);
  assert.match(belem, /Map data © OpenStreetMap · data may be incomplete/);
  const se = await card('osm-n42');
  assert.match(se, /Map data © OpenStreetMap/);
  for (const text of [baixa, belem, se]) {
    assert.doesNotMatch(text, /Suburb|Administrative|Photon|Overpass|OpenStreetMap search|osm\.org/);
  }
  await page.evaluate(() => window.uw.ui.openSheet('places'));
  await page.waitForTimeout(400);
  const list = await page.evaluate(() => document.body.innerText);
  assert.match(list, /Neighbourhood/);
  assert.doesNotMatch(list, /Suburb|Administrative/);
  assert.deepEqual(errors, []);
});
