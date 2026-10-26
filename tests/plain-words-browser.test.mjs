// The map speaks the same plain words as Instafy's pages (spec §4.3-4.6): no emoji, glyph-only marks or jargon
// ("registry", "routed", "lens", "Tune", "dB") in the sheet; an estimate says "Estimate"; each persona pick says why,
// on its option's own line; the peek has one segmented row (Places, the map's own, Map key) whose chosen tab looks
// chosen (as a screen reader hears it); no
// Adjust, 3D or whole-map button unless the map asks ("question.adjust"), and then Adjust holds them in words; no hint
// over the pins; a light phone gets a light map. The best compare value is a check and a word. The plan's stops read
// like the timeline page's rows (name, note on its own line, no time column, no dividers), with one link look.
// Runs the shipped examples with this pack's engine.
// Needs Playwright (UW_PLAYWRIGHT=/path/to/playwright, optionally UW_BROWSER_CHANNEL=chrome); skipped without it.
// Run: UW_PLAYWRIGHT=… node --test map-pack/tests/plain-words-browser.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// the example sites are kept out of this repository (too large); tests that open one skip without them
const NO_EXAMPLES = fs.existsSync(path.join(HERE, '..', 'examples')) ? false : 'needs examples/ (not in this repository)';
const PACK = path.join(HERE, '..');
const SKILL = path.join(PACK, 'skills', 'interactive-map');
const { loadPlaywright, launchChromium, createStaticServer, listen } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'cmd-serve.mjs')).href);

let pw = null;
try { pw = await loadPlaywright(); } catch { pw = null; }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-words-'));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

/** an example with this pack's engine (the example folders carry the engine they were built with) */
function example(name) {
  const dir = path.join(tmp, name);
  fs.cpSync(path.join(PACK, 'examples', name), dir, { recursive: true });
  fs.rmSync(path.join(dir, 'engine'), { recursive: true, force: true });
  fs.cpSync(path.join(SKILL, 'starter', 'engine'), path.join(dir, 'engine'), { recursive: true });
  return dir;
}
const EMOJI = /(?!\u2197)\p{Extended_Pictographic}/u; // the ↗ after a link is text (as on the pages)
const JARGON = /\b(registry|routed|lens|lenses|Tune|bound|intent|handoff)\b/i;

async function openSite(browser, base, site, viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 600, isMobile: viewport.width < 600 });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  await page.goto(`${base}/${site}/index.html`);
  await page.waitForFunction(() => window.__uwReady === true, null, { timeout: 60000 });
  await page.waitForTimeout(800);
  return page;
}
// the words of the sheet; a pin's own marker (.uw-badge, the same icon as on the map, aria-hidden) is not a word
const sheetText = (page) => page.evaluate(() => [...document.querySelectorAll('.uw-sheet, .uw-tune')].map((e) => {
  const c = e.cloneNode(true);
  c.querySelectorAll('.uw-badge[aria-hidden="true"]').forEach((b) => b.remove());
  document.body.append(c); c.style.cssText += ';position:fixed;left:-9999px;top:0;transform:none';
  const t = c.innerText; c.remove(); return t;
}).join('\n'));

test('plain words on a question map and its compare sheet; the plan lists every day', { skip: NO_EXAMPLES || (pw ? false : 'Playwright not found (set UW_PLAYWRIGHT)'), timeout: 240000 }, async () => {
  const root = path.join(tmp, 'sites');
  fs.mkdirSync(root);
  fs.renameSync(example('taipei-stay'), path.join(root, 'taipei-stay'));
  fs.renameSync(example('taiwan-loop'), path.join(root, 'taiwan-loop'));
  const server = createStaticServer(root);
  const port = await listen(server, 0, '127.0.0.1');
  closers.push(() => new Promise((r) => server.close(r)));
  const browser = await launchChromium(pw);
  closers.push(() => browser.close());
  const base = `http://127.0.0.1:${port}`;

  // ---- taipei-stay: the peek ----
  const page = await openSite(browser, base, 'taipei-stay');
  let text = await sheetText(page);
  assert.doesNotMatch(text, EMOJI, `no emoji in the sheet: ${(text.match(EMOJI) || [])[0]}`);
  assert.doesNotMatch(text, JARGON, `plain words: ${(text.match(JARGON) || [])[0]}`);
  assert.match(text, /Estimate/, 'an estimate says "Estimate"');
  assert.doesNotMatch(text, /\best\.(?!\w)/, 'no "est." tags');
  const focus = await page.evaluate(() => ({
    peekSegs: document.querySelectorAll('.uw-sheet .uw-lens-seg').length,
    tabs: [...document.querySelectorAll('.uw-tab')].map((t) => t.innerText.trim()),
    adjust: document.querySelectorAll('.uw-tune-btn').length,
    lensRow: !document.querySelector('.uw-lensrow').hidden,
    picks: [...document.querySelectorAll('.uw-persona .uw-pick')].map((p) => p.innerText),
    persona: !document.querySelector('.uw-persona').hidden,
    lines: [...document.querySelectorAll('.uw-vline-t')].map((t) => t.innerText),
    fabs: [...document.querySelectorAll('.uw-fab')].filter((b) => b.offsetParent).map((b) => b.dataset.id),
    hints: document.querySelectorAll('.uw-toast').length,
    // the tab a screen reader hears as selected looks selected, at the peek too (review v4)
    chosen: [...document.querySelectorAll('.uw-tab[aria-selected="true"]')].map((t) => t.innerText.trim()),
    chosenLook: (() => { const t = document.querySelector('.uw-tab[aria-selected="true"]'); return t ? getComputedStyle(t, '::before').content : null; })(),
    look: window.uw.state.look,
    // how far the basemap moved toward night (0 = the day map)
    dark: window.uw.state.dark,
  }));
  assert.equal(focus.peekSegs, 0, 'the peek has one segmented row, the tabs');
  assert.deepEqual(focus.tabs, ['Places', 'Compare', 'Map key'], 'one tab order on every map: Places, the map\'s own, the map key');
  assert.equal(focus.adjust, 0, 'no Adjust on a map that did not ask for it');
  assert.equal(focus.lensRow, false, 'no empty row where Adjust was');
  assert.deepEqual(focus.fabs, ['uw-locate'], `on the map only the locate button (the info button is the attribution): ${focus.fabs}`);
  assert.equal(focus.hints, 0, 'no first-visit hint over the pins: the option lines say where to start');
  assert.equal(focus.chosen.length, 1, 'one tab is chosen');
  assert.notEqual(focus.chosenLook, 'none', `the chosen tab looks chosen at the peek (${focus.chosen})`);
  assert.notEqual(focus.look, 'night', 'a light phone gets a light map under its light sheet, even at 23:00');
  assert.equal(focus.dark, 0, 'and not dimmed toward night (a dimmed light map read as a muddy, disabled overlay)');
  // each pick says why, in words, on its option's own line (review v4: a second list repeated the rows' facts)
  assert.deepEqual(focus.picks, [], 'no second list of picks');
  assert.equal(focus.persona, false, 'no persona block under the lines');
  assert.equal(focus.lines.length, 3, `one line per hotel: ${focus.lines}`);
  assert.match(focus.lines[0], /^Via Loft · best for light sleepers: quietest door at night, tied with C, and 4 quiet blocks nearby \(C\s0\) · Estimate$/, focus.lines[0]);
  assert.match(focus.lines[1], /^Lore · best for commuters: closest MRT, 3 min · but night market 262 m away/, focus.lines[1]);
  assert.match(focus.lines[2], /^Everstar · best for night owls: liveliest streets nearby · Estimate$/, focus.lines[2]);
  assert.doesNotMatch(text, /\bdB\b/, 'noise is said in words, never in decibels');
  // the verdict wraps: no line is cut off mid-fact
  const cut = await page.evaluate(() => [...document.querySelectorAll('.uw-vline-t')].filter((t) => t.scrollHeight > t.clientHeight + 1).map((t) => t.innerText));
  assert.deepEqual(cut, [], 'no verdict line is cut off');
  const lines = await page.evaluate(() => [...document.querySelectorAll('.uw-vline-t')].map((t) => t.innerText));
  for (const l of lines) assert.ok((l.match(/\bbut\b/g) || []).length <= 1, `one "but" per line: ${l}`);
  // the stations and the letters are not the link blue or a teal
  const marks = await page.evaluate(() => ({ a: getComputedStyle(document.documentElement).getPropertyValue('--uw-letter-a').trim().toLowerCase(), link: getComputedStyle(document.documentElement).getPropertyValue('--uw-link').trim().toLowerCase() }));
  assert.notEqual(marks.a, marks.link, 'letter A is not the link blue');
  await page.evaluate(() => window.uw.ui.openSheet('compare'));
  await page.waitForTimeout(400);
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector('.uw-tab[aria-selected="true"]'), '::before').content), 'none', 'an open sheet shows its tab as chosen');
  // the map canvas shows where the keyboard is
  const ring = await page.evaluate(() => { const c = document.querySelector('.maplibregl-canvas'); c.focus(); return c.matches(':focus-visible') ? getComputedStyle(c).outlineStyle : 'not focus-visible'; });
  assert.ok(ring === 'solid' || ring === 'not focus-visible', `the focused map has a ring: ${ring}`);
  await page.context().close();

  // ---- taipei-stay with "question.adjust": true: Adjust holds the focus, the time and the rarer map buttons ----
  const cfgPath = path.join(root, 'taipei-adjust', 'map.config.json');
  fs.cpSync(path.join(root, 'taipei-stay'), path.join(root, 'taipei-adjust'), { recursive: true });
  const acfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); acfg.question.adjust = true; fs.writeFileSync(cfgPath, JSON.stringify(acfg));
  const adj = await openSite(browser, base, 'taipei-adjust');
  const tune = await adj.evaluate(() => ({ text: document.querySelector('.uw-tune-btn')?.innerText.trim(), name: document.querySelector('.uw-tune-btn')?.getAttribute('aria-label'),
    fabs: [...document.querySelectorAll('.uw-fab')].filter((b) => b.offsetParent).map((b) => b.dataset.id) }));
  assert.equal(tune.text, 'Adjust', 'Adjust says what it opens, no clock');
  assert.equal(tune.name, 'Adjust');
  assert.ok(!tune.fabs.includes('uw-3d') && !tune.fabs.includes('uw-reset'), `3D and reset live in Adjust: ${tune.fabs}`);
  await adj.locator('.uw-tune-btn').click();
  await adj.waitForSelector('.uw-tune');
  await adj.waitForTimeout(400);
  const adjust = await adj.evaluate(() => {
    const last = [...document.querySelectorAll('.uw-tune .uw-act')].pop();
    last.scrollIntoView({ block: 'nearest' });
    const r = last.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      title: document.querySelector('.uw-tune-head').innerText.trim(),
      map: [...document.querySelectorAll('.uw-tune-map .uw-act')].map((b) => b.innerText.trim()),
      focus: [...document.querySelectorAll('.uw-tune .uw-lens-seg .uw-lens')].map((b) => b.innerText.trim()),
      sections: [...document.querySelectorAll('.uw-tune .uw-sub-h')].map((b) => b.innerText.trim()),
      lastInView: r.top >= 0 && r.bottom <= innerHeight && !!hit && last.contains(hit),
    };
  });
  assert.equal(adjust.title, 'Adjust');
  assert.deepEqual(adjust.focus, ['Sleep', 'Night', 'Transit'], 'the focus choice, in words, inside Adjust');
  assert.deepEqual(adjust.sections, ['Focus', 'Time of day', 'Map'], 'no weights or sliders nobody asked for');
  assert.deepEqual(adjust.map, ['3D view', 'Show the whole map'], 'the rarer map buttons, in words');
  assert.ok(adjust.lastInView, 'Adjust\'s last button is on screen and not under the sheet');
  assert.deepEqual(adj.errors, []);
  await adj.context().close();

  // ---- taipei-stay: compare ----
  const page2 = await openSite(browser, base, 'taipei-stay');
  await page2.evaluate(() => window.uw.ui.openSheet('compare'));
  await page2.waitForSelector('.uw-cmp-cell');
  text = await sheetText(page2);
  assert.doesNotMatch(text, /★/, 'no star for the best value');
  assert.doesNotMatch(text, EMOJI, `no emoji in compare: ${(text.match(EMOJI) || [])[0]}`);
  assert.doesNotMatch(text, JARGON, `plain words in compare: ${(text.match(JARGON) || [])[0]}`);
  const best = await page2.evaluate(() => [...document.querySelectorAll('.uw-cmp-cell.is-best .uw-best')].map((b) => b.innerText.trim()));
  assert.ok(best.length >= 1 && best.every((w) => /^(Lowest|Closest|Highest|Quietest|Most)$/.test(w)), `the best value says why: ${best}`);
  const cmp = await page2.evaluate(() => ({
    labels: [...document.querySelectorAll('.uw-cmp-l')].map((l) => l.innerText.trim()),
    align: [...new Set([...document.querySelectorAll('.uw-cmp-cell')].map((c) => getComputedStyle(c).textAlign))],
  }));
  assert.ok(!cmp.labels.includes('Verdict'), `the verdict is said once, in the peek: ${cmp.labels}`);
  assert.deepEqual(cmp.align, ['left'], 'compare cells read left to right, like the page table');
  assert.doesNotMatch(text, /\(estimate\)|\bregisters?\b|weight \d/, 'one estimate word, no register jargon, no weights');
  assert.match(text, /loud traffic/, 'the door noise in words, on the WHO night guideline (65 dB is loud)');
  const cmpMore = await page2.evaluate(() => ({
    bars: document.querySelectorAll('.uw-cmp-bar').length,
    small: [...document.querySelectorAll('.uw-sheet *')].filter((e) => e.offsetParent && e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.data.trim()) && parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${e.className}: ${e.innerText.trim().slice(0, 30)}`),
    labels: [...document.querySelectorAll('.uw-cmp-l')].map((l) => l.innerText.trim()),
  }));
  assert.equal(cmpMore.bars, 0, 'no bars under words: the word is the value (a goodness bar read backwards on noise)');
  assert.deepEqual(cmpMore.small, [], 'no text under 12 px in Compare');
  assert.ok(!cmpMore.labels.some((l) => /^(Doorstep|Licence)/.test(l)), `plain row names: ${cmpMore.labels}`);
  assert.doesNotMatch(text, new RegExp(`\\b\\d{1,2} \\w{3} ${new Date().getFullYear()}\\b`), 'no year on a date of this year');
  assert.deepEqual(page2.errors, []);
  await page2.context().close();

  // ---- taiwan-loop: the plan ----
  const plan = await openSite(browser, base, 'taiwan-loop');
  text = await sheetText(plan);
  assert.doesNotMatch(text, EMOJI, `no emoji in the plan peek: ${(text.match(EMOJI) || [])[0]} in ${text.slice(Math.max(0, text.search(EMOJI) - 80), text.search(EMOJI) + 40)}`);
  assert.doesNotMatch(text, /\+\d+ more days|\bD1\b/, 'no day chips or "+N more days"');
  await plan.evaluate(() => { window.uw.ui.openSheet('plan'); window.uw.setDay(1); });
  await plan.waitForSelector('.uw-dayrow.is-open');
  const days = await plan.evaluate(() => ({
    rows: document.querySelectorAll('.uw-dayrow').length,
    first: document.querySelector('.uw-dayrow .uw-dayrow-t').innerText,
    steppers: document.querySelectorAll('.uw-stepper, .uw-step-btn').length,
    dots: document.querySelectorAll('.uw-dot').length,
    open: document.querySelector('.uw-dayrow.is-open').id,
    card: getComputedStyle(document.querySelector('.uw-dayrows')).borderTopWidth,
  }));
  const n = JSON.parse(fs.readFileSync(path.join(root, 'taiwan-loop', 'map.config.json'), 'utf8')).plan.days.length;
  assert.equal(days.rows, n, 'every day is listed');
  assert.equal(days.dots, 0, 'no dots');
  assert.equal(days.first, 'Sat 24 Oct · Taipei', 'a day row: its date, then the place');
  assert.equal(days.steppers, 0, 'one way through the days: the list (no stepper above it)');
  assert.equal(days.card, '0px', 'the day list is not a card inside the panel');
  assert.equal(days.open, 'uw-day-2');
  // day 5 reads like the timeline page's row, and the stepper stays in view above it
  await plan.evaluate(() => window.uw.setDay(4));
  await plan.waitForFunction(() => document.querySelector('.uw-dayrow.is-open')?.id === 'uw-day-5');
  await plan.waitForTimeout(500);
  const d5 = await plan.evaluate(() => {
    const body = document.querySelector('.uw-body').getBoundingClientRect();
    const open = document.querySelector('.uw-dayrow.is-open'), or = open.getBoundingClientRect();
    return {
      gap: Math.round(or.top - body.top),
      nested: [...open.querySelectorAll('[role="button"], button')].filter((b) => b.querySelector('a, button')).length,
      goes: open.querySelectorAll('button.uw-item-go').length,
      title: open.querySelector('.uw-dayrow-t').innerText, cap: open.querySelector('.uw-dayrow-c').innerText,
      checks: [...open.querySelectorAll('.uw-item-check')].map((c) => c.innerText),
      marks: open.querySelectorAll('.uw-item-n, .uw-item .uw-badge').length,
      chips: [...open.querySelectorAll('.uw-chip')].map((c) => c.innerText),
      names: [...open.querySelectorAll('.uw-item-t')].map((c) => c.innerText),
      notes: [...open.querySelectorAll('.uw-item-note')].map((c) => c.innerText),
      times: open.querySelectorAll('.uw-item-time').length,
      lines: [...open.querySelectorAll('.uw-item')].map((li) => getComputedStyle(li).borderBottomWidth),
      link: (() => { const a = open.querySelector('.uw-item-src'), cs = getComputedStyle(a); return { color: cs.color, line: cs.textDecorationLine, want: getComputedStyle(document.documentElement).getPropertyValue('--uw-link').trim() }; })(),
      head: document.querySelector('.uw-vhead')?.innerText, ask: document.querySelector('.uw-title').innerText,
    };
  });
  assert.ok(d5.gap >= -1 && d5.gap <= 12, `the open day starts at the top of the panel (${d5.gap} px), not part-way through the row above`);
  assert.equal(d5.nested, 0, 'no link or button inside a button: a stop\'s links sit beside it');
  assert.ok(d5.goes >= 1, 'a stop on the map is a real button');
  assert.equal(d5.title, 'Wed 28 Oct · Taroko Gorge', 'the place, without "(check what\'s open)"');
  assert.equal(d5.cap, '4 stops · 2 not checked', 'the timeline page\'s caption');
  assert.deepEqual(d5.checks, ['Not checked · which trails are open · where to check ↗', 'Not checked · which trails are open · where to check ↗']);
  assert.equal(d5.marks, 0, 'no number circles or picture badges on the stops');
  assert.deepEqual(d5.chips, [], 'no second clock or "Show on map": opening the day does both');
  // the timeline page's stop rows: the name, the note on its own line, no time column, no dividers
  assert.deepEqual(d5.names, ['Xincheng (Taroko) Station', 'Taroko visitor centre', 'Shakadang Trail along a turquoise river', 'Eternal Spring Shrine']);
  assert.deepEqual(d5.notes, ['ask about trail status']);
  assert.equal(d5.times, 0, 'no time column');
  assert.ok(d5.lines.every((w) => w === '0px'), `no dividers between stops: ${d5.lines}`);
  assert.equal(d5.link.line, 'underline', 'one inline-link look: underlined');
  assert.equal(d5.link.color, await plan.evaluate((c) => { const d = document.createElement('span'); d.style.color = c; document.body.append(d); const v = getComputedStyle(d).color; d.remove(); return v; }, d5.link.want), 'in the link colour');
  assert.match(d5.head, /^14 days · 10 rides by train & high-speed rail · loop from /, `the summary counts days, as the list does: ${d5.head}`);
  assert.doesNotMatch(d5.ask, /day by day/i, 'the title does not repeat the tab');
  text = await sheetText(plan);
  assert.doesNotMatch(text, EMOJI, `no emoji in the plan: ${(text.match(EMOJI) || [])[0]}`);
  // a note bubble on the map shows the one drawn info glyph, not a colour emoji (review v4: a ⚠️ on Taroko)
  const bubbles = await plan.evaluate(() => [...document.querySelectorAll('.uw-bubble-e')].map((e) => { const c = getComputedStyle(e); return `${c.fontSize}|${c.maskImage || c.webkitMaskImage}`.slice(0, 20); }));
  assert.ok(bubbles.length >= 1 && bubbles.every((b) => b.startsWith('0px|url(')), `note bubbles draw a glyph: ${bubbles}`);
  assert.deepEqual(plan.errors, []);
  await plan.context().close();
});
