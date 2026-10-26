// The map engine's default "instafy" preset uses the same tokens as Instafy's page starters (theme.css in
// packages/instafy-bind/src/starters), and dark mode follows the same switch: the host's theme when hosted
// (<html data-uw-host-theme>), else the device. The time slider's night look changes only the map, never the chrome.
// The static checks read engine.css; the browser checks (skipped without Playwright) load a real site.
// Run: UW_PLAYWRIGHT=… UW_BROWSER_CHANNEL=chrome node --test map-pack/tests/theme-tokens.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const ENGINE = path.join(SKILL, 'starter', 'engine');
const CSS = fs.readFileSync(path.join(ENGINE, 'engine.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every top-level and @media-nested rule as { media, selector, body }. Enough CSS for engine.css (no nested @supports). */
function rules(css) {
  const out = [];
  let i = 0;
  const walk = (media, end) => {
    while (i < end) {
      const open = css.indexOf('{', i);
      if (open < 0 || open >= end) { i = end; return; }
      const head = css.slice(i, open).trim();
      if (head.startsWith('@media') || head.startsWith('@container') || head.startsWith('@supports')) {
        let depth = 1, j = open + 1;
        while (depth && j < css.length) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
        i = open + 1; walk(head, j - 1); i = j; continue;
      }
      if (head.startsWith('@keyframes')) {
        let depth = 1, j = open + 1;
        while (depth && j < css.length) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
        i = j; continue;
      }
      const close = css.indexOf('}', open);
      out.push({ media, selector: head, body: css.slice(open + 1, close) });
      i = close + 1;
    }
  };
  walk(null, css.length);
  return out;
}
const decls = (body) => {
  const m = {};
  for (const d of body.split(/;(?![^(]*\))/)) {
    const k = d.indexOf(':');
    if (k < 0) continue;
    m[d.slice(0, k).trim()] = d.slice(k + 1).trim().replace(/\s+/g, ' ');
  }
  return m;
};
const ALL = rules(CSS);
const block = (selector, media = null) => {
  const found = ALL.filter((r) => r.selector === selector && r.media === media);
  assert.equal(found.length, 1, `exactly one "${selector}" block${media ? ` in ${media}` : ''}`);
  return decls(found[0].body);
};
// the preset's light tokens (the color-scheme line is its own small :where(:root) rule)
const LIGHT = Object.assign({}, ...ALL.filter((r) => r.selector === ':where(:root)' && !r.media).map((r) => decls(r.body)));
const DARK_MEDIA = '@media (prefers-color-scheme: dark)';

test('instafy light: the starters\' tokens (ink, warm slate, one blue fill, neutral selection, 8 px buttons, 16 px panels)', () => {
  const want = {
    '--uw-fg': '#0f172a', '--uw-fg2': '#55524c', '--uw-muted': '#6f6b64', '--uw-line': '#ebe7e2', '--uw-line2': '#d4d0ca',
    '--uw-accent-fill': '#0066ac', '--uw-accent-hover': '#004f88', '--uw-link': '#0066ac', '--uw-focus': '#0066ac',
    '--uw-sel-bg': '#f6f3ef', '--uw-sel-fg': '#0f172a', '--uw-sel-ring': '#d4d0ca',
    '--uw-tab-on-bg': '#ffffff', '--uw-tab-on-fg': '#0f172a', '--uw-good': '#007a55', '--uw-check': '#007a55',
    '--uw-winner-bg': '#f6f3ef', '--uw-btn-bg': '#f6f3ef', '--uw-btn-fg': '#55524c', '--uw-chip': '#f6f3ef',
    '--uw-toast-bg': '#262626', '--uw-toast-fg': '#fbfaf7', '--uw-skel': '#f6f3ef',
    '--uw-radius-sheet': '16px', '--uw-radius-panel': '16px', '--uw-radius-box': '12px', '--uw-radius-btn': '8px',
    '--uw-radius-input': '12px', '--uw-tab-radius': '8px', '--uw-tab-inset': '4px',
    // space (Instafy #576): one row inset, and Studio's dialog preset (16 px sides, 512 px, 16 px from the edge)
    '--uw-inset': '16px', '--uw-dialog-gutter': '16px', '--uw-dialog-max': '512px', '--uw-overlay-clear': '16px',
  };
  for (const [k, v] of Object.entries(want)) assert.equal(LIGHT[k], v, k);
  assert.match(LIGHT['--uw-font'], /^Inter, system-ui, -apple-system,/);
  assert.match(LIGHT['--uw-tab-on-shadow'], /0 1px 3px 0 rgb\(0 0 0 \/ 0\.1\)/, 'the selected tab is raised like a .seg option');
  assert.equal(LIGHT['--uw-bg'], '#ffffff', 'the panel is solid like a page card (no glass taking the map\'s colour)');
  assert.match(LIGHT['--uw-tabs-fill'], /^color-mix\(in oklch, #f6f3ef 70%, transparent\)$/);
  // chrome tokens: no pills, no gradients, no cool slate or navy (the drawn ramps are data colours, not chrome)
  for (const [k, v] of Object.entries(LIGHT)) {
    if (/ramp$/.test(k)) continue;
    assert.doesNotMatch(v, /999px|linear-gradient|#64748b|#020617/i, `${k}: ${v}`);
  }
});

test('instafy dark: one value list under the device switch and under a dark host, with the starters\' dark tokens', () => {
  const DARK_OS = block(':where(html:not([data-uw-host-theme="light"]))', DARK_MEDIA);
  const DARK_HOST = block(':where(html[data-uw-host-theme="dark"]:not([data-uw-theme="neutral"]))');
  assert.deepEqual(DARK_HOST, DARK_OS, 'host-dark and device-dark carry the same values');
  const want = {
    '--uw-fg': '#fbfaf7', '--uw-muted': '#b5b0a9', '--uw-line': 'rgba(255, 255, 255, 0.105)', '--uw-line2': 'rgba(255, 255, 255, 0.13)',
    '--uw-bg': '#1d1d1d', '--uw-bg-solid': '#1d1d1d', '--uw-card': '#262626', '--uw-map-bg': '#141414', '--uw-accent-fill': '#2a72c6',
    '--uw-link': '#8dc1ff', '--uw-sel-bg': '#2a2a2a', '--uw-tab-on-bg': '#303030', '--uw-good': '#5ee9b5', '--uw-check': '#5ee9b5',
    '--uw-winner-bg': '#2a2a2a', '--uw-toast-bg': '#2e2e2e', 'color-scheme': 'dark',
  };
  for (const [k, v] of Object.entries(want)) assert.equal(DARK_OS[k], v, k);
  for (const [k, v] of Object.entries(DARK_OS)) assert.doesNotMatch(v, /linear-gradient|#0d1322|#181c27/i, `${k}: ${v}`);
  // a light host on a dark device gets light controls too
  assert.equal(block(':where(html[data-uw-host-theme="light"]:not([data-uw-theme="neutral"]))')['color-scheme'], 'light');
});

test('the night look never redeclares chrome: no rule keyed on data-look sets a token, and custom themes skip it too', () => {
  const night = ALL.filter((r) => /data-look/.test(r.selector) || /data-look/.test(r.media || ''));
  for (const r of night) assert.doesNotMatch(r.body, /--uw-/, `${r.selector} sets tokens`);
  assert.equal(night.length, 0, `rules on data-look: ${night.map((r) => r.selector).join(', ')}`);
  const themeJs = fs.readFileSync(path.join(ENGINE, 'theme.js'), 'utf8');
  assert.doesNotMatch(themeJs, /data-look/, 'theme.js writes no night-look block');
  assert.match(themeJs, /data-uw-host-theme="dark"/, 'custom dark tokens follow the host theme');
});

test('"neutral" keeps its old values, and the component alignment is scoped away from it', () => {
  const n = block(':where(html[data-uw-theme="neutral"])');
  assert.equal(n['--uw-accent'], '#4f46e5');
  assert.equal(n['--uw-radius-btn'], '14px');
  assert.equal(n['--uw-muted'], '#64748b');
  assert.equal(n['--uw-sel-bg'], '#0f172a');
  const nd = block(':where(html[data-uw-theme="neutral"])', DARK_MEDIA);
  assert.equal(nd['--uw-bg-solid'], '#181c27');
  const aligned = ALL.filter((r) => /\.uw-(lens|tab|act|chip-btn|cmp-cell)\b/.test(r.selector) && /data-uw-theme/.test(r.selector));
  assert.ok(aligned.length >= 6, 'component rules for the instafy preset exist');
  for (const r of aligned) assert.match(r.selector, /:where\(html:not\(\[data-uw-theme="neutral"\]\)\)/, r.selector);
});

test('one type scale and no pills with the pages: title 20/600, captions 12/16, no letter-spacing, chips with button corners, a solid panel', () => {
  const P = ':where(html:not([data-uw-theme="neutral"]))';
  const find = (part) => {
    const r = ALL.find((x) => !x.media && x.selector.split(',').map((t) => t.trim()).includes(`${P} ${part}`));
    assert.ok(r, `an instafy rule for ${part}`);
    return decls(r.body);
  };
  assert.equal(find('.uw-root .uw-title').font, '600 20px/28px var(--uw-font)');
  assert.equal(find('.uw-root.has-question .uw-title').font, '600 20px/28px var(--uw-font)', 'beats the question header\'s 17 px');
  assert.equal(find('.uw-root .uw-card-title').font, '600 20px/28px var(--uw-font)');
  assert.equal(find('.uw-root .uw-day-title').font, '600 16px/24px var(--uw-font)');
  assert.equal(find('.uw-root .uw-row-title').font, '500 14px/20px var(--uw-font)');
  assert.equal(find('.uw-root .uw-note').font, '400 12px/16px var(--uw-font)');
  assert.equal(find('.uw-root *')['letter-spacing'], '0');
  for (const part of ['.uw-root .uw-chip', '.uw-root .uw-lens', '.uw-root .uw-time .uw-thumb']) assert.equal(find(part)['border-radius'], 'var(--uw-radius-btn)', part);
  assert.equal(find('.uw-sheet')['backdrop-filter'], 'none', 'no glass on the panel');
  assert.equal(find('.uw-root .uw-vfact.is-caveat').color, 'var(--uw-fg2)', 'a caveat is neutral prose, not amber');
  assert.equal(find('.uw-root .uw-lens-seg').background, 'var(--uw-tabs-fill)', 'the focus choice is one segmented group like the tabs');
});

// ---------------- browser ----------------
const { loadPlaywright, launchChromium, createStaticServer, listen } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'cmd-serve.mjs')).href);
let pw = null;
try { pw = await loadPlaywright(); } catch { pw = null; }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-theme-'));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

function makeSite(name, theme) {
  const dir = path.join(tmp, name);
  const r = spawnSync(process.execPath, [path.join(SKILL, 'scripts', 'uw.mjs'), 'new', dir, '--title', 'Theme', '--center', '121.52,25.05', '--zoom', '13'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  if (theme) {
    const p = path.join(dir, 'map.config.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    cfg.theme = theme;
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  }
  return dir;
}

test('chrome follows the host theme over the device, and stays light at night under a light host', { skip: pw ? false : 'Playwright not found (set UW_PLAYWRIGHT)', timeout: 120000 }, async () => {
  const root = path.join(tmp, 'sites');
  fs.mkdirSync(root, { recursive: true });
  fs.renameSync(makeSite('plain'), path.join(root, 'plain'));
  fs.renameSync(makeSite('custom', { dark: { accent: '#fb7185' } }), path.join(root, 'custom'));
  const server = createStaticServer(root);
  const port = await listen(server, 0, '127.0.0.1');
  closers.push(() => new Promise((r) => server.close(r)));
  const browser = await launchChromium(pw);
  closers.push(() => browser.close());

  async function look(site, scheme, host, night = false) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/${site}/`);
    await page.waitForFunction(() => window.__uwReady === true, null, { timeout: 60000 });
    await page.evaluate(({ host, night }) => {
      const html = document.documentElement;
      if (host) html.dataset.uwHostTheme = host; else delete html.dataset.uwHostTheme;
      if (night) document.querySelector('.uw-root').dataset.look = 'night';
    }, { host, night });
    await page.waitForTimeout(600); // the sheet fades its background (0.35 s)
    const got = await page.evaluate(() => {
      const html = document.documentElement;
      const cs = getComputedStyle(html);
      return { bg: cs.getPropertyValue('--uw-bg-solid').trim(), accent: cs.getPropertyValue('--uw-accent').trim(),
        scheme: cs.colorScheme, sheet: getComputedStyle(document.querySelector('.uw-sheet')).backgroundColor,
        btnRadius: getComputedStyle(document.querySelector('.uw-fab')).borderRadius,
        tabRadius: (() => { const t = document.querySelector('.uw-tab[aria-selected="true"]'); return t ? getComputedStyle(t, '::before').borderRadius : null; })() };
    });
    assert.deepEqual(errors, []);
    await ctx.close();
    return got;
  }

  const lightSheet = 'rgb(255, 255, 255)', darkSheet = 'rgb(29, 29, 29)';
  const deviceDark = await look('plain', 'dark', null);
  assert.equal(deviceDark.bg, '#1d1d1d'); assert.equal(deviceDark.sheet, darkSheet);
  const hostLight = await look('plain', 'dark', 'light');
  assert.equal(hostLight.bg, '#ffffff', 'a light Studio on a dark device: light chrome');
  assert.equal(hostLight.sheet, lightSheet); assert.equal(hostLight.scheme, 'light');
  const hostDark = await look('plain', 'light', 'dark');
  assert.equal(hostDark.bg, '#1d1d1d', 'a dark Studio on a light device: dark chrome');
  assert.equal(hostDark.sheet, darkSheet); assert.equal(hostDark.scheme, 'dark');
  const nightLight = await look('plain', 'light', 'light', true);
  assert.equal(nightLight.bg, '#ffffff', 'the night map look leaves a light Studio\'s sheet light');
  assert.equal(nightLight.sheet, lightSheet);
  const nightDevice = await look('plain', 'light', null, true);
  assert.equal(nightDevice.sheet, lightSheet, 'no host, light device: light sheet at night too');
  if (hostLight.tabRadius) assert.equal(hostLight.tabRadius, '8px', 'the selected tab is an 8 px segmented option');

  // a site's own dark tokens ride the same switch
  assert.equal((await look('custom', 'light', 'dark')).accent, '#fb7185');
  assert.equal((await look('custom', 'dark', 'light')).accent, '#007acc');
  assert.equal((await look('custom', 'light', 'light', true)).accent, '#007acc', 'custom dark tokens do not apply at night');
  assert.equal((await look('custom', 'dark', null)).accent, '#fb7185');
});

test('hosted, the basemap follows the host\'s light or dark theme; the hour moves it only within that band', async () => {
  const { lookFor, lightAt, HOST_LIGHT_MAX, HOST_DARK_MIN } = await import(pathToFileURL(path.join(ENGINE, 'look.js')).href);
  // a light Studio at 23:00 is not a near-black night map; a dark Studio at 09:00 is not a bright day map
  // a light chrome keeps the day map at every hour (review v4: the dimmed light map read as a muddy overlay)
  assert.equal(lookFor('auto', 23, true, 'light').dark, 0);
  assert.equal(HOST_LIGHT_MAX, 0);
  assert.ok(lookFor('auto', 9, true, 'dark').dark >= HOST_DARK_MIN && HOST_DARK_MIN >= 0.8);
  assert.ok(lookFor('auto', 19, true, 'light').warm > 0, 'dusk still warms a light map');
  // no host: the hour decides, as before; a fixed theme always wins
  for (const hour of [3, 9, 19, 23]) assert.deepEqual(lookFor('auto', hour, true, null), lightAt(hour));
  assert.equal(lookFor('light', 23, true, 'dark').dark, 0);
  assert.equal(lookFor('dark', 9, true, 'light').dark, 1);
});

test('marker colours are not the link blue or a teal: option letters, and the stations `uw stay` adds', () => {
  // review (v3): letter A was close to the accent blue and the station pins were teal; the pages use blue only for the
  // primary button, links, focus and the checkbox, and no teal at all. A grey-blue slate is neutral, not blue.
  const blueOrTeal = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
    if (!d) return false;
    const sat = d / (1 - Math.abs(2 * l - 1));
    const h = ((mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
    return sat > 0.35 && h >= 160 && h <= 225;
  };
  const instafy = rules(CSS).filter((r) => /--uw-letter-a/.test(r.body) && !/neutral/.test(r.selector));
  assert.ok(instafy.length >= 1, 'the instafy letter tokens');
  for (const r of instafy) {
    const letters = [...r.body.matchAll(/--uw-letter-[a-e]:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]);
    assert.equal(letters.length, 5, r.selector);
    for (const c of letters) assert.ok(!blueOrTeal(c), `letter ${c} in ${r.selector} is not blue or teal`);
  }
  const util = fs.readFileSync(path.join(ENGINE, 'util.js'), 'utf8');
  for (const m of /LETTER_COLORS = \{([^}]*)\}/.exec(util)[1].matchAll(/'(#[0-9a-f]{6})'/gi)) assert.ok(!blueOrTeal(m[1]), `default letter ${m[1]}`);
  const stay = fs.readFileSync(path.join(SKILL, 'scripts', 'lib', 'cmd-stay.mjs'), 'utf8');
  const st = /emoji: '🚉', color: '(#[0-9a-f]{6})'/i.exec(stay)[1];
  assert.ok(!blueOrTeal(st), `stations ${st} are a neutral slate, not teal`);
});
