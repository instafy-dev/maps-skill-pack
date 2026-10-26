// The map's own history for a host's address bar and ‹ › (PAGE/NAV contract): the map emits
// {source:"instafy-map", v:1, type:"page", payload:{path, title, canGoBack, canGoForward}} from what the viewer looked at
// (a place, a tab, a plan day) and answers {source:"instafy-host", v:1, type:"command", command:{name:"navigate",
// args:{dir}}}. The pure part runs offline; the browser part frames a real example like Studio does (needs Playwright:
// UW_PLAYWRIGHT=/path/to/playwright, or one the pack finds; skipped without it; outside requests are blocked).
// Run: node --test map-pack/tests/nav.test.mjs
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
const ENGINE = path.join(SKILL, 'starter', 'engine');
const N = await import(pathToFileURL(path.join(ENGINE, 'nav.js')).href);

// ---------------------------------------------------------------- pure

function history() {
  const sent = [], applied = [];
  const describe = (st) => (st.sel ? { segments: ['Hotels', st.sel.id], title: st.sel.id } : st.tab && st.tab !== 'compare' ? { segments: [st.tab], title: st.tab } : { segments: [], title: '' });
  const h = new N.NavHistory({ describe, apply: (st) => applied.push(st), emit: (t, p) => sent.push([t, p]), siteTitle: () => 'Taipei stay' });
  return { h, sent, applied };
}
const S = (o = {}) => ({ sel: null, card: false, tab: 'compare', day: null, ...o });

test('page: "/" and the site title at the start; a place is "/Layer/Name"; back and forward follow the entries', () => {
  const { h, sent, applied } = history();
  h.reset(S());
  assert.deepEqual(sent.at(-1), ['page', { path: '/', title: 'Taipei stay', canGoBack: false, canGoForward: false }]);
  h.note(S({ sel: { layer: 'hotels', id: 'Lore Hotel' }, card: true }));
  assert.deepEqual(sent.at(-1)[1], { path: '/Hotels/Lore Hotel', title: 'Lore Hotel', canGoBack: true, canGoForward: false });
  h.note(S({ tab: 'places' }));
  assert.equal(h.page().path, '/places');
  assert.equal(h.go('back'), true);
  assert.deepEqual(applied.at(-1), S({ sel: { layer: 'hotels', id: 'Lore Hotel' }, card: true }));
  assert.deepEqual(sent.at(-1)[1], { path: '/Hotels/Lore Hotel', title: 'Lore Hotel', canGoBack: true, canGoForward: true });
  // the state the move produced replaces that entry (it is not a new one)
  h.note(S({ sel: { layer: 'hotels', id: 'Lore Hotel' }, card: true }));
  assert.equal(h.entries.length, 3);
  assert.equal(h.go('back'), true);
  h.note(S());
  assert.deepEqual(h.page(), { path: '/', title: 'Taipei stay', canGoBack: false, canGoForward: true });
  assert.equal(h.go('back'), false, 'nothing before the start');
  assert.equal(h.go('forward'), true);
  h.note(S({ sel: { layer: 'hotels', id: 'Lore Hotel' }, card: true }));
  // a new move after going back drops the forward entries
  h.note(S({ sel: { layer: 'hotels', id: 'Via Inn' }, card: true }));
  assert.deepEqual(h.page(), { path: '/Hotels/Via Inn', title: 'Via Inn', canGoBack: true, canGoForward: false });
  assert.equal(h.entries.length, 3);
});

test('with read(): what a move produced is the entry at once, so a move right after it is a new entry', () => {
  const sent = [];
  let now = S();
  const h = new N.NavHistory({ describe: (st) => ({ segments: st.sel ? ['Cafés', st.sel.id] : st.day != null ? ['Plan', `Day ${st.day + 1}`] : [], title: '' }),
    apply: (st) => { now = { ...st, tab: st.day != null ? 'plan' : st.tab }; }, read: () => now, emit: (t, p) => sent.push(p) });
  h.reset(now);
  h.note(now = S({ sel: { layer: 'cafes', id: 'A' }, card: true }));
  h.note(now = S({ tab: 'plan', day: 0 }));
  h.go('back');
  assert.equal(h.going, false);
  // the viewer picks another café before any debounced note arrived
  h.note(now = S({ sel: { layer: 'cafes', id: 'B' }, card: true }));
  assert.deepEqual(h.page(), { path: '/Cafés/B', title: 'Map', canGoBack: true, canGoForward: false });
  assert.equal(h.entries.length, 3);
});

test('page: emitted only when it changes; the same state twice is one entry; a refused move re-sends it', () => {
  const { h, sent } = history();
  h.reset(S());
  const n = sent.length;
  h.note(S());
  h.note(S());
  assert.equal(sent.length, n);
  assert.equal(h.entries.length, 1);
  assert.equal(h.go('forward'), false);
  assert.equal(sent.length, n + 1, 'the host learns it cannot go there (its button state is stale)');
});

test('page: path and title are bounded and readable; history keeps the last 50 entries', () => {
  assert.equal(N.pathOf(['A/B', 'x\u0000y', '  many   spaces ', '', '?#']), '/A B/x y/many spaces');
  assert.ok(N.pathOf(['x'.repeat(500)]).length <= N.MAX_PATH);
  const { h } = history();
  h.reset(S());
  h.note(S({ sel: { layer: 'h', id: 'y'.repeat(400) }, card: true }));
  assert.ok([...h.page().title].length <= N.MAX_TITLE);
  for (let i = 0; i < 80; i++) h.note(S({ sel: { layer: 'h', id: 'p' + i }, card: true }));
  assert.equal(h.entries.length, N.MAX_ENTRIES);
  assert.equal(h.page().canGoBack, true);
  assert.equal(N.sameState(S({ day: 1 }), S({ day: 1 })), true);
  assert.equal(N.sameState(S({ day: 1 }), S({ day: 2 })), false);
  assert.equal(N.sameState(S({ sel: { layer: 'a', id: '1' }, card: true }), S({ sel: { layer: 'a', id: '1' }, card: false })), false);
});

test('the engine wires it: navigate is an accepted command, the ack lists page + navigate, and nothing uses pushState', async () => {
  const src = fs.readFileSync(path.join(ENGINE, 'bind.js'), 'utf8');
  assert.match(src, /const COMMANDS = \[[^\]]*'navigate'/);
  const { Bind } = await import(pathToFileURL(path.join(ENGINE, 'bind.js')).href);
  const got = [];
  const bind = new Bind({ command: (name, a) => got.push([name, a]) });
  bind.handle({ source: 'instafy-host', v: 1, type: 'command', command: { name: 'navigate', args: { dir: 'back' } } }, 'port');
  bind.handle({ source: 'instafy-host', v: 1, type: 'command', command: { name: 'eval', args: {} } }, 'port');
  assert.deepEqual(got, [['navigate', { dir: 'back' }]]);
  const host = fs.readFileSync(path.join(ENGINE, 'host.js'), 'utf8');
  assert.match(host, /supports: \[[^\]]*'page', 'navigate'[^\]]*\]/);
  for (const f of ['nav.js', 'engine.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ENGINE, f), 'utf8'), /history\.pushState/, `${f}: pushState inside a frame joins the host's Back button`);
  }
});

// ---------------------------------------------------------------- in a browser

const { loadPlaywright, launchChromium, createStaticServer, listen } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'cmd-serve.mjs')).href);
let pw = null;
try { pw = await loadPlaywright(); } catch { pw = null; }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-nav-'));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

function site(name) {
  const dir = path.join(tmp, name);
  fs.cpSync(path.join(HERE, '..', 'examples', name), dir, { recursive: true, filter: (p) => !/[/\\](snapshots|\.uwcache)([/\\]|$)/.test(p) });
  fs.rmSync(path.join(dir, 'engine'), { recursive: true, force: true });
  fs.cpSync(path.join(ENGINE), path.join(dir, 'engine'), { recursive: true });
  return dir;
}

// the parent frames the site like Studio and keeps every "page" message; window.go(dir) sends the navigate command
const PARENT = (src, siteOrigin) => `<!doctype html><meta charset="utf-8"><title>host</title>
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>
<iframe id="f" src="${src}"></iframe>
<script>
  const f = document.getElementById('f');
  window.pages = [];
  window.addEventListener('message', (e) => {
    if (e.source !== f.contentWindow || e.origin !== ${JSON.stringify(siteOrigin)}) return;
    if (e.data && e.data.source === 'instafy-map' && e.data.type === 'page') window.pages.push(e.data);
  });
  window.go = (dir) => f.contentWindow.postMessage({ source: 'instafy-host', v: 1, type: 'command', command: { name: 'navigate', args: { dir } } }, ${JSON.stringify(siteOrigin)});
</script>`;

test('in a Studio-like frame: a place, a tab and a plan day become pages; the host\'s ‹ › walk them', { skip: NO_EXAMPLES || (pw ? false : 'Playwright not found (set UW_PLAYWRIGHT)'), timeout: 180000 }, async () => {
  const dir = site('daan-coffee-walk');
  const siteServer = createStaticServer(dir);
  const sitePort = await listen(siteServer, 0, '127.0.0.1');
  closers.push(() => new Promise((r) => siteServer.close(r)));
  const siteOrigin = `http://127.0.0.1:${sitePort}`;
  const parentServer = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PARENT(`${siteOrigin}/?instafy_host=studio`, siteOrigin)); });
  const parentPort = await listen(parentServer, 0, '127.0.0.1');
  closers.push(() => new Promise((r) => parentServer.close(r)));

  const browser = await launchChromium(pw);
  closers.push(() => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${parentPort}/`);
  await page.waitForFunction(() => window.pages.length > 0, null, { timeout: 90000 });
  const fr = page.frames().find((x) => x.url().startsWith(siteOrigin));
  const last = () => page.evaluate(() => window.pages.at(-1).payload);
  // pred(x, arg) runs in the parent page, so it gets what it needs from the test as arg
  const waitPage = (pred, what, arg = null) => page.waitForFunction(([src, a]) => { const x = window.pages.at(-1)?.payload; return !!x && (0, eval)(src)(x, a); }, [String(pred), arg], { timeout: 15000 })
    .catch(async () => { throw new Error(`${what}: pages ${JSON.stringify(await page.evaluate(() => window.pages.map((m) => m.payload.path + (m.payload.canGoBack ? ' <' : '') + (m.payload.canGoForward ? ' >' : ''))))}`); });

  const historyAtStart = await fr.evaluate(() => history.length);
  const first = await last();
  assert.deepEqual(first, { path: '/', title: first.title, canGoBack: false, canGoForward: false });
  assert.ok(first.title.length > 0, 'the site title');

  // a place: "/<layer title>/<place name>"
  const target = await fr.evaluate(() => {
    const L = window.uw.getLayer('cafes'); const f = window.uw.getFeatures('cafes')[0];
    window.uw.select('cafes', f.properties.id);
    return { layer: L.title || L.id, id: String(f.properties.id) };
  });
  await waitPage((x) => x.canGoBack && x.path !== '/', 'after select');
  const placePage = await last();
  assert.equal(placePage.path.split('/')[1], target.layer);
  assert.equal(placePage.canGoForward, false);

  // the Plan tab opens day 1: "/<plan tab>/Day 1"
  await fr.evaluate(() => document.querySelector('[data-tab="plan"]').click());
  await waitPage((x) => /\/Day 1$/.test(x.path), 'after the Plan tab');

  // the host's ‹: back to the place (its card again), then to the start
  await page.evaluate(() => window.go('back'));
  await waitPage((x, p) => x.path === p && x.canGoBack && x.canGoForward, 'after back', placePage.path);
  assert.deepEqual(await fr.evaluate(() => window.uw.state.selected), { layer: 'cafes', id: target.id });
  await page.evaluate(() => window.go('back'));
  await waitPage((x) => x.path === '/' && !x.canGoBack && x.canGoForward, 'after back to the start');
  assert.equal(await fr.evaluate(() => window.uw.state.selected), null);
  // ›: forward to the place again
  await page.evaluate(() => window.go('forward'));
  await waitPage((x, p) => x.path === p && x.canGoBack && x.canGoForward, 'after forward', placePage.path);
  // a new move drops the forward entry (the plan day)
  await fr.evaluate(() => { const f = window.uw.getFeatures('cafes')[1]; window.uw.select('cafes', f.properties.id); });
  await waitPage((x, p) => x.path !== p && x.path !== '/' && x.canGoBack && !x.canGoForward, 'after a new select', placePage.path);
  // none of this touched the browser's history (the host page's Back button)
  assert.equal(await fr.evaluate(() => history.length), historyAtStart);
});
