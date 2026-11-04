// A pin's emoji, letter or number sits in the middle of its disc. The emoji sat left of the centre and a little high (a
// museum pin's 🏛️ by 6% of the pin's width to the left and 3% up, on a Mac): the engine centred each glyph on the
// font's advance and its middle baseline, with a fixed nudge down, and Apple Color Emoji's advance at pin sizes is
// wider than its picture, the extra space all on its right (18 px for a 14 px picture); Noto Color Emoji's pictures sat
// low; a digit or letter whose ink is not centred on its advance ("1", "J") and the dot of an option pin with no letter
// sat off centre too. Each glyph is now placed by where its pixels land.
// Here, the engine's own drawBadge and drawLetter at device pixel ratios 2 and 3: badges (26, 32 and 40 px, and the 30
// and 34 px ring badges of legs and the walker) and letter pins (26, 32 and 40 px: stop numbers, numbered places and
// option letters; an option pin with no letter draws a dot), as drawn and 1.32× (a selected pin): the centre of the
// glyph's ink box is within 0.5 CSS px of the disc's centre, across and up or down (a glyph is drawn on whole device
// pixels, so up to one of them off). Emoji only where a colour emoji font draws them.
// Needs Playwright (UW_PLAYWRIGHT=/path/to/playwright, optionally UW_BROWSER_CHANNEL=chrome); skipped without it.
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

const EMOJI = ['🏛️', '🍽️', '🌳', '⛪', '🏰', '🛍️', '🏨', '🚇', '☕'];
const CASES = [
  ...[26, 32, 40].flatMap((d) => EMOJI.map((g) => ({ fn: 'drawBadge', d, emoji: g }))),
  ...[30, 34].flatMap((d) => ['🚶', '🚆', '🚌'].map((g) => ({ fn: 'drawBadge', d, emoji: g, ring: true }))),
  ...[26, 32, 40].flatMap((d) => ['A', 'L', 'J', '7', '1', '12'].map((g) => ({ fn: 'drawLetter', d, letter: g }))),
  // an option pin with no letter and no emoji: a text font's dot, drawn as its emoji (layers.js add_points_option)
  { fn: 'drawLetter', d: 40, emoji: '•', text: true },
  ...['🏛️', '🍽️', '🌳', '🏨'].map((g) => ({ fn: 'drawLetter', d: 40, emoji: g })),
];

// In the page, for each case: the offset (CSS px, +x right, +y down) of the glyph's ink box's centre from the disc's
// centre. The disc is the pin's opaque part drawn without its glyph. The glyph's coverage comes from the same pin on a
// black and on a white disc (a pixel inside the disc is covered a = 1 − (on white − on black) / (white − black)); its
// ink is every pixel about a tenth covered or more (over 24 of 255). A ring badge is white inside whatever its colour:
// its ink is every pixel the glyph changes. → { colourEmoji, rows: [{ ...case, pr, dx, dy }] }
async function measure(cases) {
  const L = await import('/engine/layers.js');
  const box = (img, pred) => {
    const W = img.width, H = img.height;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (pred((y * W + x) * 4)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return x1 < 0 ? null : [(x0 + x1 + 1) / 2, (y0 + y1 + 1) / 2];
  };
  const draw = (c, color, glyph) => L[c.fn]({ d: c.d, ring: !!c.ring, color, emoji: glyph ? c.emoji : null, letter: glyph ? c.letter : null });
  const rows = [];
  for (const c of cases) {
    const { img: Bg, pixelRatio: pr } = draw(c, '#000000', true);
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
    rows.push({ ...c, pr, dx: ink ? (ink[0] - disc[0]) / pr : null, dy: ink ? (ink[1] - disc[1]) / pr : null });
  }
  // a colour emoji font: a tree is drawn green
  const tree = L.drawBadge({ emoji: '🌳', color: '#000000', d: 40 }).img.data;
  let colourEmoji = false;
  for (let i = 0; i < tree.length && !colourEmoji; i += 4) colourEmoji = tree[i + 1] - Math.max(tree[i], tree[i + 2]) > 60;
  return { colourEmoji, rows };
}

test('a pin\'s emoji, letter or number is centred on its disc by its pixels, at device pixel ratios 2 and 3', { skip: pw ? false : 'Playwright not found (set UW_PLAYWRIGHT)', timeout: 120000 }, async () => {
  const dir = path.join(tmp, 'site');
  fs.mkdirSync(dir);
  fs.cpSync(path.join(SKILL, 'starter', 'engine'), path.join(dir, 'engine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>pins</title>');
  const server = createStaticServer(dir);
  const port = await listen(server, 0, '127.0.0.1');
  closers.push(() => new Promise((r) => server.close(r)));
  const browser = await launchChromium(pw);
  closers.push(() => browser.close());
  const off = [];
  let emojiChecked = 0, lettersChecked = 0;
  for (const dpr of [2, 3]) {
    const ctx = await browser.newContext({ deviceScaleFactor: dpr });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    const { colourEmoji, rows } = await page.evaluate(measure, CASES);
    for (const r of rows) {
      const emoji = r.emoji && !r.text;
      if (emoji && !colourEmoji) continue;
      const what = `${r.fn}(${r.emoji || r.letter}, ${r.d} px${r.ring ? ', ring' : ''}) at device pixel ratio ${dpr}`;
      assert.ok(r.dx != null, `${what}: the glyph draws nothing`);
      if (emoji) emojiChecked++; else lettersChecked++;
      // a selected pin shows its icon 1.32× (engine.js uw--sel-icon)
      for (const scale of [1, 1.32]) {
        if (Math.max(Math.abs(r.dx), Math.abs(r.dy)) * scale > 0.5) off.push(`${what}${scale === 1 ? '' : ' ×1.32'}: ink centre ${(r.dx * scale).toFixed(2)}, ${(r.dy * scale).toFixed(2)} px from the disc's centre`);
      }
    }
    await ctx.close();
  }
  assert.deepEqual(off, [], `glyphs off the centre of their disc:\n  ${off.join('\n  ')}`);
  assert.equal(lettersChecked, 2 * 19);
  if (!emojiChecked) console.log('# no colour emoji font here: emoji not checked');
});
