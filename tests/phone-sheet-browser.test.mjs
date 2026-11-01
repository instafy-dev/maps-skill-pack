// The map's phone sheet inside a host's frame, as the 29 Oct 2026 drive saw it on a 375×812 phone: Studio's frame sits
// between its bar and its floating chips and composer. Raised, the sheet showed the search box, the "Sights" heading
// and half of the first sight, its rows ran on to the edge the composer sits on, and focusing the search box raised
// the sheet to the top, so the next tap opened another place.
// Needs Playwright (UW_PLAYWRIGHT=/path/to/playwright, optionally UW_BROWSER_CHANNEL=chrome); skipped without it.
// Run: UW_PLAYWRIGHT=… node --test tests/phone-sheet-browser.test.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-sheet-b-'));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const pt = (id, c, p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { id, ...p } });
// Studio on a phone: its bar above the frame, its chips and composer below it (the frame ends where they start)
const BAR = 110, COMPOSER = 130;

test('phone sheet in a host frame: raised, it shows the first place whole and its list ends above the bottom edge; search focus leaves it where it is', { skip: pw ? false : 'Playwright not found (set UW_PLAYWRIGHT)', timeout: 120000 }, async () => {
  const dir = path.join(tmp, 'site');
  const r = spawnSync(process.execPath, [UW, 'new', dir, '--title', 'Where to stay and what to see each day in Lisbon', '--ask', 'Three days, first visit', '--center', '-9.15,38.71', '--zoom', '12'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const sights = [['jeronimos', 'Mosteiro dos Jerónimos', [-9.2068, 38.6979], 'museum'], ['torre', 'Torre de Belém', [-9.2160, 38.6916], 'attraction'],
    ['castelo', 'Castelo de São Jorge', [-9.1335, 38.7139], 'attraction'], ['comercio', 'Praça do Comércio', [-9.1365, 38.7077], 'square'],
    ['se', 'Sé de Lisboa', [-9.1334, 38.7099], 'cathedral'], ['estrela', 'Basílica da Estrela', [-9.1602, 38.7131], 'basilica']];
  fs.writeFileSync(path.join(dir, 'data', 'sights.geojson'), JSON.stringify({ type: 'FeatureCollection', uw: { cmd: 'add-point' },
    features: sights.map(([id, name, c, kind]) => pt(id, c, { name, kind, area: 'Lisboa', source: 'Visit Lisboa' })) }));
  fs.writeFileSync(path.join(dir, 'data', 'stays.geojson'), JSON.stringify({ type: 'FeatureCollection', uw: { cmd: 'stay' },
    features: [pt('hotel', [-9.1390, 38.7110], { name: 'Hotel in Baixa', kind: 'hotel' })] }));
  const cfgPath = path.join(dir, 'map.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.layers = [{ id: 'sights', title: 'Sights', type: 'points', data: 'data/sights.geojson' }, { id: 'stays', title: 'Stays', type: 'points', data: 'data/stays.geojson' }];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const site = createStaticServer(dir);
  const port = await listen(site, 0, '127.0.0.1');
  closers.push(() => new Promise((res) => site.close(res)));
  // the host is another origin, as Studio is
  const host = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%}
#pane{position:absolute;top:${BAR}px;left:0;right:0;bottom:${COMPOSER}px}iframe{width:100%;height:100%;border:0;display:block}
#composer{position:absolute;left:0;right:0;bottom:0;height:${COMPOSER}px;background:#eee}</style>
<div id="pane"><iframe id="f" src="http://localhost:${port}/?instafy_host=studio"></iframe></div><div id="composer"></div>
<script>const f=document.getElementById('f');f.addEventListener('load',()=>f.contentWindow.postMessage({source:'instafy-host',v:1,type:'layout',caps:{location:'host'},theme:'light'},'*'));</script>`);
  });
  const hport = await listen(host, 0, '127.0.0.1');
  closers.push(() => new Promise((res) => host.close(res)));
  const browser = await launchChromium(pw);
  closers.push(() => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${hport}/`);
  const frame = await (await page.waitForSelector('#f')).contentFrame();
  frame.on?.('pageerror', (e) => errors.push(String(e)));
  await frame.waitForFunction(() => window.__uwReady === true, null, { timeout: 60000 });
  await frame.waitForFunction(() => document.documentElement.dataset.uwHostTheme === 'light', null, { timeout: 10000 });

  // raise it the way a person does: the Places tab
  await frame.click('.uw-tab[data-tab="places"]');
  await frame.waitForTimeout(700);
  const geo = () => frame.evaluate(() => {
    const sheet = document.querySelector('.uw-sheet'), body = document.querySelector('.uw-body');
    const rows = [...document.querySelectorAll('.uw-row')].map((r) => r.getBoundingClientRect());
    const sab = parseFloat(getComputedStyle(document.querySelector('.uw-root')).getPropertyValue('--sab')) || 0;
    return { H: innerHeight, sab, snap: sheet.dataset.snap, top: Math.round(sheet.getBoundingClientRect().top), bodyBottom: body.getBoundingClientRect().bottom,
      listEnd: body.style.getPropertyValue('--uw-list-end'), mask: getComputedStyle(body).maskImage || getComputedStyle(body).webkitMaskImage,
      firstRow: rows[0] ? { top: rows[0].top, bottom: rows[0].bottom } : null };
  });
  const half = await geo();
  assert.equal(half.H, 812 - BAR - COMPOSER, 'the frame ends where the composer starts');
  assert.equal(half.snap, 'half');
  // the first place shows whole above the list's end (the drive: half of it, under the composer's edge)
  assert.ok(half.firstRow, JSON.stringify(half));
  assert.ok(half.firstRow.bottom <= half.H - half.sab - 16, `the first place ends at ${half.firstRow.bottom}, the list at ${half.H - half.sab - 16}: ${JSON.stringify(half)}`);
  // the list ends above the bottom edge: the part of the body past it is masked out, then a 16 px fade
  assert.match(String(half.mask), /linear-gradient/);
  const hidden = half.bodyBottom - (half.H - half.sab);
  const end = await frame.evaluate(() => { const b = document.querySelector('.uw-body'); const d = document.createElement('div'); d.style.height = 'var(--uw-list-end)'; b.append(d); const v = d.getBoundingClientRect().height; d.remove(); return v; });
  assert.ok(Math.abs(end - (hidden + half.sab)) <= 1 || Math.abs(end - hidden) <= 1, `--uw-list-end ${end} px, the body runs ${hidden} px past the edge`);

  // focusing the search box leaves the sheet where it is
  await frame.focus('.uw-search');
  await frame.waitForTimeout(700);
  const focused = await geo();
  assert.equal(focused.snap, 'half', 'still half open');
  assert.equal(focused.top, half.top, 'the sheet did not move');
  // and typing filters the list in place
  await frame.type('.uw-search', 'Belém');
  await frame.waitForTimeout(300);
  assert.match(await frame.evaluate(() => document.querySelector('.uw-list').innerText), /Torre de Belém/);
  assert.equal((await geo()).top, half.top);

  // Review of 0.1.11: with the sheet lowered the search box is out of view, and a keyboard (Tab) can still focus it;
  // it then stayed hidden under the edge. Focus brings a hidden box into view (half open); a box in view never moves.
  await frame.evaluate(() => document.activeElement?.blur());
  // the handle steps half → full → peek
  await frame.click('.uw-handle');
  await frame.waitForTimeout(500);
  await frame.click('.uw-handle');
  await frame.waitForTimeout(700);
  assert.equal((await geo()).snap, 'peek');
  // resting, the tab bar ends PEEK_GAP above the frame's bottom edge, where the host's floating chips start (it
  // touched them), and the gap under it is the sheet's own colour: nothing of the list shows there
  const rest = await frame.evaluate(() => {
    const tabs = document.querySelector('.uw-tabs').getBoundingClientRect(), body = document.querySelector('.uw-body');
    const sab = parseFloat(getComputedStyle(document.querySelector('.uw-root')).getPropertyValue('--sab')) || 0;
    const d = document.createElement('div'); d.style.height = 'var(--uw-list-end)'; body.append(d); const listEnd = d.getBoundingClientRect().height; d.remove();
    return { H: innerHeight, sab, tabsBottom: tabs.bottom, bodyBottom: body.getBoundingClientRect().bottom, listEnd };
  });
  const { PEEK_GAP } = await import(pathToFileURL(path.join(SKILL, 'starter', 'engine', 'ui.js')).href);
  assert.ok(PEEK_GAP >= 8);
  const edge = rest.H - rest.sab;
  assert.ok(rest.tabsBottom <= edge - PEEK_GAP + 1 && rest.tabsBottom >= edge - PEEK_GAP - 1, `the tabs end at ${rest.tabsBottom}, the edge is at ${edge}: ${JSON.stringify(rest)}`);
  // the mask: the body is transparent below (its bottom - --uw-list-end), so all of it under the tab bar is
  assert.ok(rest.bodyBottom - rest.listEnd <= rest.tabsBottom + 1, `the list is hidden from ${rest.bodyBottom - rest.listEnd} px, under the tabs at ${rest.tabsBottom}: ${JSON.stringify(rest)}`);
  const hiddenBox = await frame.evaluate(() => document.querySelector('.uw-search').getBoundingClientRect().bottom);
  assert.ok(hiddenBox > 812 - BAR - COMPOSER, `the box is out of view at peek (${hiddenBox})`);
  await frame.focus('.uw-search');
  await frame.waitForTimeout(700);
  const shown = await geo();
  assert.equal(shown.snap, 'half', 'a hidden box that takes focus is brought into view');
  const box = await frame.evaluate(() => document.querySelector('.uw-search').getBoundingClientRect().bottom);
  assert.ok(box <= shown.H - shown.sab, `the box ends at ${box}, in view above ${shown.H - shown.sab}`);
  assert.deepEqual(await frame.evaluate(() => [document.scrollingElement.scrollTop, document.body.scrollTop, document.querySelector('.uw-root').scrollTop]), [0, 0, 0], 'the page itself did not scroll');

  // (a guard, not a change) Studio's theme switch reaches a map on screen at once: the sheet and the basemap
  const look = () => frame.evaluate(() => ({ sheet: getComputedStyle(document.querySelector('.uw-sheet')).backgroundColor, look: document.querySelector('.uw-root').dataset.look }));
  const light = await look();
  await page.evaluate(() => document.getElementById('f').contentWindow.postMessage({ source: 'instafy-host', v: 1, type: 'layout', caps: { location: 'host' }, theme: 'dark' }, '*'));
  await frame.waitForFunction(() => document.querySelector('.uw-root').dataset.look === 'night', null, { timeout: 5000 });
  await frame.waitForTimeout(600); // the sheet's colour eases over 0.35 s
  assert.notEqual((await look()).sheet, light.sheet);
  assert.deepEqual(errors, []);
});

// The 1 Nov 2026 drive: the Seville map's sheet, dragged up and let go in Studio's pane while the pane was out of view,
// showed its rows down to the frame's bottom edge, under the composer: the list's end was already the one for the
// raised sheet while the sheet was still drawn where the drag left it. Its end now follows the sheet while it is dragged,
// and stays at the frame's edge until the slide has arrived.
test('phone sheet in a host frame: dragged up and let go, the list never runs past the frame\'s bottom edge, also while the slide is not drawn', { skip: pw ? false : 'Playwright not found (set UW_PLAYWRIGHT)', timeout: 120000 }, async () => {
  const dir = path.join(tmp, 'drag');
  const r = spawnSync(process.execPath, [UW, 'new', dir, '--title', 'Three days in Seville', '--center', '-5.99,37.38', '--zoom', '13'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const names = ['Cathedral', 'Alcázar', 'Archive of the Indies', 'Plaza de España', 'Torre del Oro', 'María Luisa Park', 'Triana', 'Metropol Parasol', 'Casa de Pilatos', 'Museum of Fine Arts'];
  fs.writeFileSync(path.join(dir, 'data', 'sights.geojson'), JSON.stringify({ type: 'FeatureCollection', uw: { cmd: 'add-point' },
    features: names.map((name, i) => pt(`s${i}`, [-5.995 + (i % 5) * 0.004, 37.378 + Math.floor(i / 5) * 0.006], { name, kind: 'attraction', source: 'Wikipedia' })) }));
  const cfgPath = path.join(dir, 'map.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.layers = [{ id: 'sights', title: 'Sights', type: 'points', data: 'data/sights.geojson' }];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const site = createStaticServer(dir);
  const port = await listen(site, 0, '127.0.0.1');
  closers.push(() => new Promise((res) => site.close(res)));
  const host = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%}
#pane{position:absolute;top:${BAR}px;left:0;right:0;bottom:${COMPOSER}px}iframe{width:100%;height:100%;border:0;display:block}
#composer{position:absolute;left:0;right:0;bottom:0;height:${COMPOSER}px;background:#eee}</style>
<div id="pane"><iframe id="f" src="http://localhost:${port}/?instafy_host=studio"></iframe></div><div id="composer"></div>
<script>const f=document.getElementById('f');f.addEventListener('load',()=>f.contentWindow.postMessage({source:'instafy-host',v:1,type:'layout',caps:{location:'host'},theme:'dark'},'*'));</script>`);
  });
  const hport = await listen(host, 0, '127.0.0.1');
  closers.push(() => new Promise((res) => host.close(res)));
  const browser = await launchChromium(pw);
  closers.push(() => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${hport}/`);
  const frame = await (await page.waitForSelector('#f')).contentFrame();
  await frame.waitForFunction(() => window.__uwReady === true, null, { timeout: 60000 });
  await frame.waitForFunction(() => document.querySelector('.uw-sheet')?.dataset.snap === 'peek', null, { timeout: 10000 });
  // where the list ends (the body's bottom less --uw-list-end) against the frame's bottom edge (less --sab)
  const ends = () => frame.evaluate(() => {
    const sheet = document.querySelector('.uw-sheet'), body = document.querySelector('.uw-body');
    const d = document.createElement('div'); d.style.height = 'var(--uw-list-end)'; body.append(d); const listEnd = d.getBoundingClientRect().height; d.remove();
    const sab = parseFloat(getComputedStyle(document.querySelector('.uw-root')).getPropertyValue('--sab')) || 0;
    return { snap: sheet.dataset.snap, top: Math.round(sheet.getBoundingClientRect().top), list: body.getBoundingClientRect().bottom - listEnd, edge: innerHeight - sab };
  });
  const fr = await (await page.$('#f')).boundingBox();
  const grip = await frame.evaluate(() => { const b = document.querySelector('.uw-handle').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await page.mouse.move(fr.x + grip.x, fr.y + grip.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) { await page.mouse.move(fr.x + grip.x, fr.y + grip.y - i * 30); await page.waitForTimeout(16); }
  // dragged: the list ends at the frame's edge, wherever the sheet is
  const dragged = await ends();
  assert.ok(Math.abs(dragged.list - dragged.edge) <= 1, `dragged to ${dragged.top}: the list ends at ${dragged.list}, the edge is at ${dragged.edge}`);
  // let go, in a frame that draws none of the slide (each transition is held at its start)
  await frame.evaluate(() => document.addEventListener('transitionrun', (e) => { for (const a of e.target.getAnimations()) { a.pause(); a.currentTime = 0; } }, true));
  await page.mouse.up();
  await frame.waitForTimeout(400);
  const held = await ends();
  assert.equal(held.snap, 'full');
  assert.ok(Math.abs(held.top - dragged.top) <= 2, `the slide is held where the drag left it (${held.top}, ${dragged.top})`);
  assert.ok(held.list <= held.edge + 1, `held at ${held.top}: the list ends at ${held.list}, past the frame's edge at ${held.edge}`);
  // drawn again: the slide arrives and the list ends at the edge of the raised sheet
  await frame.evaluate(() => { for (const a of document.querySelector('.uw-sheet').getAnimations()) a.finish(); });
  await frame.waitForTimeout(200);
  const raised = await ends();
  assert.ok(Math.abs(raised.list - raised.edge) <= 1, `raised: the list ends at ${raised.list}, the edge is at ${raised.edge}`);
});
