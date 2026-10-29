// The map's page says what it is in its <meta name="description"> ("Trip · 3 days · 14 places"), so a link preview
// (Instafy's preview card) has a facts line without another command, and marks itself ready (data-instafy-ready) once
// drawn, so the card's picture is never of a half-drawn map. Only numbers and fixed words: never the title or a
// place name, which come from the web and the person's request.
// The browser test needs Playwright (UW_PLAYWRIGHT=/path/to/playwright, optionally UW_BROWSER_CHANNEL=chrome).
// Run: node --test tests/meta-description.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const { pageDescription } = await import(pathToFileURL(path.join(SKILL, 'starter', 'engine', 'util.js')).href);
const { loadPlaywright, launchChromium, createStaticServer, listen } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'cmd-serve.mjs')).href);

let pw = null;
try { pw = await loadPlaywright(); } catch { pw = null; }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-meta-'));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const SHAPE = /^(Map|Trip)( · [1-9]\d* (day|days))?( · [1-9]\d* (place|places))?$/;

test('a trip says its days and places, a map its places, and a part that does not apply is left out', () => {
  const days = (n) => ({ plan: { days: Array.from({ length: n }, (_, i) => ({ title: `Day ${i + 1} in Alfama` })) } });
  assert.equal(pageDescription(days(3), 14), 'Trip · 3 days · 14 places');
  assert.equal(pageDescription(days(1), 1), 'Trip · 1 day · 1 place');
  assert.equal(pageDescription({ plan: {} }, 2), 'Trip · 2 places');
  assert.equal(pageDescription({}, 14), 'Map · 14 places');
  assert.equal(pageDescription({ layers: [] }, 0), 'Map');
  assert.equal(pageDescription(null, undefined), 'Map');
  assert.equal(pageDescription({}, -3), 'Map');
  assert.equal(pageDescription({}, 2.5), 'Map');
});

test('numbers and fixed words only: never a title, a place name or a day title', () => {
  const names = ['Lisbon weekend', 'Pastéis de Belém', 'Torre de Belém', 'Day 1 in Alfama', '<script>', 'https://x.example'];
  const config = { title: names[0], subtitle: names[1], plan: { title: names[2], days: [{ title: names[3] }, { title: names[4] }] }, layers: [{ id: 'sights', title: names[5] }] };
  const text = pageDescription(config, 6);
  assert.equal(text, 'Trip · 2 days · 6 places');
  for (let n = 0; n < 40; n++) assert.match(pageDescription(n % 2 ? config : { title: names[n % names.length] }, n), SHAPE);
  for (const name of names) assert.ok(!text.includes(name), name);
});

test('the map page sets its description once its layers are drawn (context dots are not places)', { skip: pw ? false : 'Playwright not found (set UW_PLAYWRIGHT)', timeout: 120000 }, async () => {
  const site = path.join(tmp, 'site');
  execFileSync(process.execPath, [path.join(SKILL, 'scripts', 'uw.mjs'), 'new', site, '--title', 'Lisbon weekend', '--center', '-9.14,38.71', '--zoom', '13'], { stdio: 'pipe' });
  const point = (id, name, lng) => ({ type: 'Feature', properties: { id, name }, geometry: { type: 'Point', coordinates: [lng, 38.71] } });
  fs.writeFileSync(path.join(site, 'data', 'sights.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [point('a', 'Torre de Belém', -9.21), point('b', 'Pastéis de Belém', -9.2), point('c', 'Alfama', -9.13)] }));
  fs.writeFileSync(path.join(site, 'data', 'dots.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [point('d', 'Some café', -9.14), point('e', 'Another café', -9.15)] }));
  const config = JSON.parse(fs.readFileSync(path.join(site, 'map.config.json'), 'utf8'));
  config.layers = [
    { id: 'sights', type: 'points', title: 'Sights', data: 'data/sights.geojson' },
    { id: 'dots', type: 'points', title: 'Cafés', data: 'data/dots.geojson', tier: 'context' },
  ];
  config.plan = { title: 'Weekend', days: [{ title: 'Day 1', items: [{ ref: 'sights:a' }] }, { title: 'Day 2', items: [{ ref: 'sights:c' }] }] };
  fs.writeFileSync(path.join(site, 'map.config.json'), JSON.stringify(config, null, 2));
  const server = createStaticServer(site);
  const port = await listen(server, 0, '127.0.0.1');
  closers.push(() => new Promise((r) => server.close(r)));
  const browser = await launchChromium(pw);
  closers.push(() => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
  // Every change of the page's ready mark, with the description the page had then.
  await ctx.addInitScript(() => {
    window.__marks = [];
    new MutationObserver(() => window.__marks.push([
      document.documentElement.getAttribute('data-instafy-ready'),
      document.querySelector('meta[name="description"]')?.content ?? null,
    ])).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-instafy-ready'] });
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.__uwReady === true, null, { timeout: 60000 });
  const metas = await page.evaluate(() => [...document.querySelectorAll('meta[name="description"]')].map((m) => m.content));
  assert.deepEqual(metas, ['Trip · 2 days · 3 places']);
  // The ready mark Instafy's preview card waits for before its picture: "false" while the map draws, "true" once it is
  // drawn, with its description already in.
  const marks = await page.evaluate(() => window.__marks);
  assert.deepEqual(marks.map(([mark]) => mark), ['false', 'true']);
  assert.equal(marks[1][1], 'Trip · 2 days · 3 places');
  await ctx.close();
});
