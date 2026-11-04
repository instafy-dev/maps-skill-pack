// A pin's emoji, letter or number sits in the middle of its disc, and so does a list or card badge's emoji. The emoji
// sat left of the centre and a little high (a museum pin's 🏛️ by 6% of the pin's width to the left and 3% up, on a
// Mac): the engine centred each glyph on the font's advance and its middle baseline, with a fixed nudge down, and Apple
// Color Emoji's advance at pin sizes is wider than its picture, the extra space all on its right (18 px for a 14 px
// picture); Noto Color Emoji's pictures sat low, and in WebKit (Safari) every emoji sat 1.2 to 3.7 px low; letters and
// numbers sat up to 1.5 px low and the dot of an option pin with no letter off centre too. An emoji (and the dot) is
// now placed by where its pixels land; a letter or number keeps the font's advance centred across (a font spaces a "1"
// to look centred, which its ink box does not say: centred by its ink box, a "1"'s stem sits right of the middle) and
// is placed up and down by its pixels. The list and card badges (the same icon as on the map) centred the emoji's
// advance and line box: 2 px left in Chrome on a Mac, the same drift.
// Here, the engine's own drawBadge and drawLetter at device pixel ratios 2 and 3, and 2.2 and 2.5 (a Retina screen at
// 110% zoom, phones): badges (26, 32 and 40 px, and the 30 and 34 px ring badges of legs and the walker) and letter
// pins (26, 32 and 40 px: stop numbers, numbered places and option letters; an option pin with no letter draws a dot),
// as drawn and 1.32× (a selected pin): an emoji's or the dot's ink box centre is within 0.5 CSS px of the disc's
// centre, across and up or down; a letter's ink box centre up or down, and the centre of its advance across (a glyph is
// drawn on whole device pixels, so up to one of them off). And the badges of ui.js (30, 32, 34, 40 and 48 px) with
// engine.css at device pixel ratios 2 and 3: the emoji's ink box centre is within 0.5 px of the disc's. Emoji only
// where a colour emoji font draws them.
// Needs Playwright (UW_PLAYWRIGHT=/path/to/playwright, optionally UW_BROWSER_CHANNEL=chrome); skipped without it (pack
// CI has no Playwright, so it runs where a browser is, like the other browser tests).
// Run: UW_PLAYWRIGHT=… node --test tests/pin-centre-browser.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'interactive-map');
const { loadPlaywright, launchChromium, createStaticServer, listen } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'cmd-serve.mjs')).href);

let pw = null;
try { pw = await loadPlaywright(); } catch { pw = null; }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-pin-centre-'));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const SKIP = pw ? false : 'Playwright not found (set UW_PLAYWRIGHT)';

const EMOJI = ['🏛️', '🍽️', '🌳', '⛪', '🏰', '🛍️', '🏨', '🚇', '☕'];
const LETTERS = ['A', 'L', 'J', '7', '1', '12'];
const CASES = [
  ...[26, 32, 40].flatMap((d) => EMOJI.map((g) => ({ fn: 'drawBadge', d, emoji: g }))),
  ...[30, 34].flatMap((d) => ['🚶', '🚆', '🚌'].map((g) => ({ fn: 'drawBadge', d, emoji: g, ring: true }))),
  ...[26, 32, 40].flatMap((d) => LETTERS.map((g) => ({ fn: 'drawLetter', d, letter: g }))),
  // an option pin with no letter and no emoji: a text font's dot, drawn as its emoji (layers.js add_points_option)
  { fn: 'drawLetter', d: 40, emoji: '•', text: true },
  ...['🏛️', '🍽️', '🌳', '🏨'].map((g) => ({ fn: 'drawLetter', d: 40, emoji: g })),
];

let site = null;
async function serve() {
  if (site) return site;
  const dir = path.join(tmp, 'site');
  fs.mkdirSync(dir);
  fs.cpSync(path.join(SKILL, 'starter', 'engine'), path.join(dir, 'engine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>pins</title>');
  const server = createStaticServer(dir);
  const port = await listen(server, 0, '127.0.0.1');
  closers.push(() => new Promise((r) => server.close(r)));
  const browser = await launchChromium(pw);
  closers.push(() => browser.close());
  site = { dir, port, browser };
  return site;
}
async function newPage(browser, dpr, viewport) {
  const ctx = await browser.newContext({ deviceScaleFactor: dpr, ...(viewport ? { viewport } : {}) });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
  return { ctx, page: await ctx.newPage() };
}

// In the page, for each case: the offset (CSS px, +x right, +y down) of the glyph's ink box's centre from the disc's
// centre, and for a letter the offset of its advance's centre across (its ink box centre less the ink's offset from the
// advance's centre in the font the pin drew it with). The disc is the pin's opaque part drawn without its glyph. The
// glyph's coverage comes from the same pin on a black and on a white disc (a pixel inside the disc is covered
// a = 1 − (on white − on black) / (white − black)); its ink is every pixel about a tenth covered or more (over 24 of
// 255). A ring badge is white inside whatever its colour: its ink is every pixel the glyph changes.
// → { colourEmoji, rows: [{ ...case, pr, dx, dy, adv }] }
async function measure(cases) {
  const L = await import('/engine/layers.js');
  const box = (img, pred) => {
    const W = img.width, H = img.height;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (pred((y * W + x) * 4)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return x1 < 0 ? null : [(x0 + x1 + 1) / 2, (y0 + y1 + 1) / 2];
  };
  // the font a letter pin draws its letter in
  const fill = CanvasRenderingContext2D.prototype.fillText;
  let want = null, font = null;
  CanvasRenderingContext2D.prototype.fillText = function (t, ...rest) { if (t === want) font = this.font; return fill.call(this, t, ...rest); };
  // where `text`'s ink lands across from the centre of its advance, CSS px
  const fromAdvance = (text, f, pr) => {
    const c = document.createElement('canvas'), S = Math.ceil(100 * pr); c.width = c.height = S;
    const g = c.getContext('2d', { willReadFrequently: true }); g.scale(pr, pr);
    g.font = f; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#000';
    const A = Math.round(50 * pr) / pr; fill.call(g, text, A, A);
    const img = g.getImageData(0, 0, S, S), b = box(img, (i) => img.data[i + 3] > 24);
    return b && b[0] / pr - A;
  };
  const draw = (c, color, glyph) => L[c.fn]({ d: c.d, ring: !!c.ring, color, emoji: glyph ? c.emoji : null, letter: glyph ? c.letter : null });
  const rows = [];
  for (const c of cases) {
    want = c.letter || null; font = null;
    const { img: Bg, pixelRatio: pr } = draw(c, '#000000', true);
    const f = font;
    want = null;
    const B0 = draw(c, '#000000', false).img, W0 = draw(c, '#ffffff', false).img, Wg = draw(c, '#ffffff', true).img;
    const disc = box(B0, (i) => B0.data[i + 3] >= 128);
    const ink = c.ring
      ? box(Bg, (i) => [0, 1, 2, 3].some((k) => Math.abs(Bg.data[i + k] - B0.data[i + k]) > 32))
      : box(Bg, (i) => {
        let a = 0;
        for (let k = 0; k < 3; k++) {
          const span = W0.data[i + k] - B0.data[i + k];
          if (span < 200) return false;
          a += (1 - (Wg.data[i + k] - Bg.data[i + k]) / span) / 3;
        }
        return a * 255 > 24;
      });
    const dx = ink ? (ink[0] - disc[0]) / pr : null, dy = ink ? (ink[1] - disc[1]) / pr : null;
    const nat = c.letter && f && ink ? fromAdvance(c.letter, f, pr) : null;
    rows.push({ ...c, pr, dx, dy, adv: nat == null ? null : dx - nat, font: f });
  }
  CanvasRenderingContext2D.prototype.fillText = fill;
  // a colour emoji font: a tree is drawn green
  const tree = L.drawBadge({ emoji: '🌳', color: '#000000', d: 40 }).img.data;
  let colourEmoji = false;
  for (let i = 0; i < tree.length && !colourEmoji; i += 4) colourEmoji = tree[i + 1] - Math.max(tree[i], tree[i + 2]) > 60;
  return { colourEmoji, rows };
}

test('a pin\'s emoji, letter or number is centred on its disc by its pixels, at device pixel ratios 2, 3, 2.2 and 2.5', { skip: SKIP, timeout: 180000 }, async () => {
  const { port, browser } = await serve();
  const off = [];
  let emojiChecked = 0, lettersChecked = 0;
  const DPRS = [2, 3, 2.2, 2.5];
  for (const dpr of DPRS) {
    const { ctx, page } = await newPage(browser, dpr);
    await page.goto(`http://127.0.0.1:${port}/`);
    const { colourEmoji, rows } = await page.evaluate(measure, CASES);
    for (const r of rows) {
      const emoji = r.emoji && !r.text;
      if (emoji && !colourEmoji) continue;
      const what = `${r.fn}(${r.emoji || r.letter}, ${r.d} px${r.ring ? ', ring' : ''}) at device pixel ratio ${dpr}`;
      assert.ok(r.dx != null, `${what}: the glyph draws nothing`);
      if (r.letter) assert.ok(r.adv != null, `${what}: no font recorded for the letter`);
      if (emoji) emojiChecked++; else lettersChecked++;
      // across: the ink's centre (an emoji, the dot) or the advance's centre (a letter or number)
      const across = r.letter ? r.adv : r.dx;
      // a selected pin shows its icon 1.32× (engine.js uw--sel-icon)
      for (const scale of [1, 1.32]) {
        if (Math.max(Math.abs(across), Math.abs(r.dy)) * scale > 0.5) {
          off.push(`${what}${scale === 1 ? '' : ' ×1.32'}: ${r.letter ? 'advance centre' : 'ink centre'} ${(across * scale).toFixed(2)} px across, ink centre ${(r.dy * scale).toFixed(2)} px down from the disc's centre`);
        }
      }
    }
    await ctx.close();
  }
  assert.deepEqual(off, [], `glyphs off the centre of their disc:\n  ${off.join('\n  ')}`);
  assert.equal(lettersChecked, DPRS.length * (3 * LETTERS.length + 1));
  if (!emojiChecked) console.log('# no colour emoji font here: emoji not checked');
});

// The badges of lists, card heads and compare columns, made by the engine's ui.js with engine.css: each shot on a
// black and a white fill, with and without its emoji, at device pixel ratios 2 and 3 → offset of the emoji's ink box
// centre from the disc's (the badge's fill inside its white border), CSS px.
const BADGES = [30, 32, 34, 40, 48].flatMap((d) => ['🏛️', '🍽️', '🌳', '⛪', '🚇', '☕'].map((g) => ({ d, g })));
const badgePage = (fill, glyph) => `<!doctype html><meta charset="utf-8"><title>badges</title><link rel="stylesheet" href="/engine/engine.css">
<body style="margin:0;background:#888"><div class="uw-root" style="position:relative;inset:auto;width:720px;height:400px;background:#888"></div>
<script type="module">
const { UI } = await import('/engine/ui.js');
const ui = Object.create(UI.prototype), root = document.querySelector('.uw-root');
${JSON.stringify(BADGES)}.forEach((b, i) => {
  const el = ui.badge(${glyph} ? b.g : '', '${fill}', b.d);
  el.id = 'b' + i; el.style.position = 'absolute'; el.style.left = (12 + (i % 10) * 70) + 'px'; el.style.top = (12 + Math.floor(i / 10) * 70) + 'px';
  root.append(el);
});
await document.fonts.ready;
await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
window.ready = true;
</script>`;

test('a list or card badge\'s emoji is centred on its disc by its pixels, as on the map, at device pixel ratios 2 and 3', { skip: SKIP, timeout: 180000 }, async () => {
  const { dir, port, browser } = await serve();
  for (const fill of ['000000', 'ffffff']) for (const glyph of [true, false]) fs.writeFileSync(path.join(dir, `badges-${fill}-${glyph ? 'g' : 'n'}.html`), badgePage('#' + fill, glyph));
  const off = [];
  let checked = 0;
  for (const dpr of [2, 3]) {
    const { ctx, page } = await newPage(browser, dpr, { width: 720, height: 400 });
    await page.goto(`http://127.0.0.1:${port}/`);
    const { colourEmoji } = await page.evaluate(measure, []);
    if (!colourEmoji) { await ctx.close(); continue; }
    const shots = {};
    for (const k of ['000000-g', '000000-n', 'ffffff-g', 'ffffff-n']) {
      await page.goto(`http://127.0.0.1:${port}/badges-${k}.html`);
      await page.waitForFunction(() => window.ready === true);
      shots[k] = (await page.screenshot({ type: 'png' })).toString('base64');
    }
    const rects = await page.evaluate((n) => Array.from({ length: n }, (_, i) => { const r = document.getElementById('b' + i).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }), BADGES.length);
    const rows = await page.evaluate(async ({ shots, rects, dpr }) => {
      const load = (b64) => new Promise((ok) => { const im = new Image(); im.onload = () => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); ok(g.getImageData(0, 0, c.width, c.height)); }; im.src = 'data:image/png;base64,' + b64; });
      const B0 = await load(shots['000000-n']), Bg = await load(shots['000000-g']), W0 = await load(shots['ffffff-n']), Wg = await load(shots['ffffff-g']);
      const W = B0.width;
      return rects.map(([l, t, w, h]) => {
        let d0 = [1e9, 1e9, -1, -1], ink = [1e9, 1e9, -1, -1];
        for (let y = Math.floor((t - 6) * dpr); y < Math.ceil((t + h + 6) * dpr); y++) for (let x = Math.floor((l - 6) * dpr); x < Math.ceil((l + w + 6) * dpr); x++) {
          const q = (y * W + x) * 4;
          let span = 255; for (let k = 0; k < 3; k++) span = Math.min(span, W0.data[q + k] - B0.data[q + k]);
          if (span < 200) continue;
          d0 = [Math.min(d0[0], x), Math.min(d0[1], y), Math.max(d0[2], x), Math.max(d0[3], y)];
          let a = 0; for (let k = 0; k < 3; k++) a += (1 - (Wg.data[q + k] - Bg.data[q + k]) / (W0.data[q + k] - B0.data[q + k])) / 3;
          if (a * 255 > 24) ink = [Math.min(ink[0], x), Math.min(ink[1], y), Math.max(ink[2], x), Math.max(ink[3], y)];
        }
        if (ink[2] < 0) return null;
        return [((ink[0] + ink[2] + 1) / 2 - (d0[0] + d0[2] + 1) / 2) / dpr, ((ink[1] + ink[3] + 1) / 2 - (d0[1] + d0[3] + 1) / 2) / dpr];
      });
    }, { shots, rects, dpr });
    rows.forEach((r, i) => {
      const what = `ui.badge(${BADGES[i].g}, ${BADGES[i].d} px) at device pixel ratio ${dpr}`;
      assert.ok(r, `${what}: the emoji draws nothing`);
      checked++;
      if (Math.max(Math.abs(r[0]), Math.abs(r[1])) > 0.5) off.push(`${what}: ink centre ${r[0].toFixed(2)}, ${r[1].toFixed(2)} px from the disc's centre`);
    });
    await ctx.close();
  }
  assert.deepEqual(off, [], `badge emoji off the centre of their disc:\n  ${off.join('\n  ')}`);
  if (!checked) console.log('# no colour emoji font here: badges not checked');
});
