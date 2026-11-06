// A day's own note (`uw set <site> plan:day1 --note "…"`) is shown under that day in the Plan tab: under the day's text,
// above its places, as Instafy's timeline page shows a day's note; another day shows none, and it is plain text.
// Needs Playwright (UW_PLAYWRIGHT=/path/to/playwright, optionally UW_BROWSER_CHANNEL=chrome); skipped without it.
// Run: UW_PLAYWRIGHT=… node --test tests/day-note-browser.test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-day-note-b-'));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const env = { ...process.env, UW_NO_CACHE: '1', UW_TURN_BUDGET: '0' };
for (const k of ['INSTAFY_CACHE_DIR', 'INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE']) delete env[k];
const uw = (args) => spawnSync(process.execPath, [UW, ...args], { cwd: tmp, env, encoding: 'utf8' });
const pt = (id, c, p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { id, ...p } });

function makeSite() {
  const dir = path.join(tmp, 'sv');
  const made = uw(['new', dir, '--title', 'Three days in Seville', '--center', '-5.9905,37.3855', '--zoom', '13']);
  assert.equal(made.status, 0, made.stderr);
  const w = (f, j) => fs.writeFileSync(path.join(dir, 'data', f), JSON.stringify(j));
  w('stops.geojson', { type: 'FeatureCollection', uw: { cmd: 'add-point' }, features: [pt('seville', [-5.99534, 37.38863], { name: 'Sevilla', name_en: 'Seville', kind: 'city', nights: 2 })] });
  w('stays.geojson', { type: 'FeatureCollection', uw: { cmd: 'stay' }, features: [pt('seville-patio', [-5.9888, 37.3855], { name: 'Hotel Patio de la Cruz', kind: 'hotel', stop: 'seville', rank: 1, walk_min: 2, walk_to: 'Santa Cruz' })] });
  w('sights.geojson', { type: 'FeatureCollection', uw: { cmd: 'add-point' }, features: [
    pt('catedral', [-5.993141, 37.385915], { name: 'Catedral de Sevilla', stop: 'seville', source_url: 'https://en.wikipedia.org/wiki/Seville_Cathedral', source: 'Wikipedia' }),
    pt('alcazar', [-5.990183, 37.383211], { name: 'Real Alcázar de Sevilla', stop: 'seville', source_url: 'https://en.wikipedia.org/wiki/Alc%C3%A1zar_of_Seville', source: 'Wikipedia' })] });
  const cfgPath = path.join(dir, 'map.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.layers = [
    { id: 'stops', title: 'Stops', type: 'points', data: 'data/stops.geojson', list: false },
    { id: 'stays', title: 'Stays', type: 'points', data: 'data/stays.geojson', list: true },
    { id: 'sights', title: 'Sights', type: 'points', data: 'data/sights.geojson', list: true },
  ];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const plan = uw(['plan', dir, '--stops', 'stops', '--ids', 'seville', '--nights', '2', '--start', '2026-11-06', '--stays', 'stays', '--sights', 'sights']);
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  const set = uw(['set', dir, 'plan:day1', '--note', 'Book the Alcázar tickets <b>ahead</b>.']);
  assert.equal(set.status, 0, set.stdout + set.stderr);
  return dir;
}

test('the Plan tab shows day 1\'s own note under its text, above its places, as plain text; day 2 shows none', { skip: pw ? false : 'Playwright not found (set UW_PLAYWRIGHT)', timeout: 120000 }, async () => {
  const dir = makeSite();
  const server = createStaticServer(dir);
  const port = await listen(server, 0, '127.0.0.1');
  closers.push(() => new Promise((r) => server.close(r)));
  const browser = await launchChromium(pw);
  closers.push(() => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.__uwReady === true, null, { timeout: 60000 });
  await page.evaluate(() => { window.uw.ui.openSheet('plan'); window.uw.setDay(0); });
  await page.waitForSelector('.uw-dayrow.is-open .uw-day-note', { timeout: 10000 });
  const day1 = await page.evaluate(() => {
    const body = document.querySelector('.uw-dayrow.is-open .uw-dayrow-b');
    const kids = [...body.children].map((el) => el.className);
    const note = body.querySelector('.uw-day-note');
    return { kids, note: note.textContent, html: note.innerHTML, bold: !!note.querySelector('b'), notes: document.querySelectorAll('.uw-day-note').length };
  });
  assert.equal(day1.note, 'Book the Alcázar tickets <b>ahead</b>.');
  assert.equal(day1.bold, false, 'plain text, never markup');
  assert.equal(day1.notes, 1);
  // the day's text, then its note, then its places
  const text = day1.kids.findIndex((c) => /\buw-text\b/.test(c) && !/uw-day-note/.test(c));
  const note = day1.kids.findIndex((c) => /uw-day-note/.test(c));
  const items = day1.kids.findIndex((c) => /uw-items/.test(c));
  assert.ok(text >= 0 && note === text + 1 && items === note + 1, JSON.stringify(day1.kids));
  await page.evaluate(() => window.uw.setDay(1));
  await page.waitForFunction(() => /Sat 7 Nov/.test(document.querySelector('.uw-day-title')?.innerText || ''), null, { timeout: 10000 });
  assert.equal(await page.evaluate(() => document.querySelectorAll('.uw-day-note').length), 0, 'day 2 has no note');
  assert.deepEqual(errors, []);
  await ctx.close();
});
