// The map canvas always has its container's size (engine.js syncMapSize). MapLibre's own ResizeObserver drops its first
// callback, so a frame the host resized in the same task the map was built in (a phone pane opening, host insets) kept
// the canvas at the old size and the map drew a shifted area: in a call, a follower then showed another place than the
// presenter. Here the container is 300 px tall while MapLibre builds the map and full height right after; the canvas
// must end up full height, and a later resize is followed too.
// Needs Playwright (UW_PLAYWRIGHT=/path/to/playwright, optionally UW_BROWSER_CHANNEL=chrome); skipped without it.
// Run: UW_PLAYWRIGHT=… node --test map-pack/tests/map-size-browser.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// the example sites are kept out of this repository (too large); tests that open one skip without them
const NO_EXAMPLES = fs.existsSync(path.join(HERE, '..', 'examples')) ? false : 'needs examples/ (not in this repository)';
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const { loadPlaywright, launchChromium, createStaticServer, listen } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'cmd-serve.mjs')).href);

let pw = null;
try { pw = await loadPlaywright(); } catch { pw = null; }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-size-'));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

// MapLibre builds the map while its container is 300 px tall; the container is full height again in the same task
const SQUEEZE_WHILE_BUILDING = `(() => {
  let real;
  Object.defineProperty(window, 'maplibregl', { configurable: true, get() { return real; }, set(v) {
    real = v;
    const M = v.Map;
    class Squeezed extends M {
      constructor(o) {
        const c = typeof o.container === 'string' ? document.getElementById(o.container) : o.container;
        const before = c.style.height;
        c.style.height = '300px';
        super(o);
        c.style.height = before;
      }
    }
    try { v.Map = Squeezed; } catch {}
  } });
})();`;

test('the canvas takes the container\'s size when the frame changes size right after the map is built', { skip: NO_EXAMPLES || (pw ? false : 'Playwright not found (set UW_PLAYWRIGHT)'), timeout: 120000 }, async () => {
  const dir = path.join(tmp, 'site');
  fs.cpSync(path.join(HERE, '..', 'examples', 'taipei-stay'), dir, { recursive: true, filter: (p) => !/[/\\](snapshots|\.uwcache)([/\\]|$)/.test(p) });
  fs.rmSync(path.join(dir, 'engine'), { recursive: true, force: true });
  fs.cpSync(path.join(SKILL, 'starter', 'engine'), path.join(dir, 'engine'), { recursive: true });
  const server = createStaticServer(dir);
  const port = await listen(server, 0, '127.0.0.1');
  closers.push(() => new Promise((r) => server.close(r)));
  const browser = await launchChromium(pw);
  closers.push(() => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
  await ctx.addInitScript(SQUEEZE_WHILE_BUILDING);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.__uwReady === true, null, { timeout: 60000 });
  const sizes = () => page.evaluate(() => {
    const m = window.uw.map, c = m.getContainer(), cv = m.getCanvas();
    return { container: [c.clientWidth, c.clientHeight], canvas: [cv.clientWidth, cv.clientHeight], squeezed: window.maplibregl.Map.name };
  });
  let s = await sizes();
  assert.equal(s.squeezed, 'Squeezed', 'the test hook is in place');
  // MapLibre alone ends here with canvas 300 inside an 844 container
  for (let i = 0; i < 20 && s.canvas[1] !== s.container[1]; i++) { await page.waitForTimeout(100); s = await sizes(); }
  assert.deepEqual(s.canvas, s.container, `canvas ${s.canvas} matches container ${s.container}`);
  assert.ok(s.container[1] > 600);
  // and a later change (the host's pane growing) is followed as well
  await page.setViewportSize({ width: 390, height: 700 });
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(100); s = await sizes(); if (s.canvas[1] === s.container[1]) break; }
  assert.deepEqual(s.canvas, s.container);
  await ctx.close();
});
