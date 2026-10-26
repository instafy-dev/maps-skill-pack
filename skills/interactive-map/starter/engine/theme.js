// Theme: map.config.json "theme" → <html data-uw-theme="…">, optional custom tokens, and the colours the engine draws
// itself (canvas letter pins, default layer colours, the walk trail, the basemap at night). Every value comes from the
// --uw-* custom properties in engine.css, so a site's own CSS can override any of them too.
//
//   "theme": "instafy"   (default) the look of Instafy's page starters: paper/ink, blue only for the filled button,
//                        links and focus, neutral selection, 8 px buttons, charcoal dark surfaces
//   "theme": "neutral"   the engine's look before themes
//   "theme": { "base": "neutral", "accent": "#e11d48", "radius-btn": "12px", "dark": { "accent": "#fb7185" } }
//            flat keys apply in every look; "light" only in light mode; "dark" only in dark mode (the host's theme
//            when hosted, else the device setting; the night map look does not change the chrome).
import { LETTER_COLORS, CAT_COLORS, PALETTE, THEME_COLORS, parseColor } from './util.js';
import { setLookPalette } from './look.js';
import { AREA_COLORS } from './layers.js';

export const THEMES = ['instafy', 'neutral'];
const NAME = /^-{0,2}(uw-)?([a-z][a-z0-9-]{0,40})$/;
// a token value is one CSS value: no declarations, blocks, comments or markup can ride along
const SAFE = /^[^;{}<>\\]*$/;
// tokens the engine draws with (canvas pins, map layers): read once from <html> at load, so they belong at the top
// level of "theme" (a light/dark-only value would be applied to whichever mode the page loaded in, and never updated)
export const DRAWN = /^(letter-[a-e]|cat-[1-6]|palette|walk|walk-night|heat-pt|area-[a-z-]+|night-[a-z0-9-]+|dusk|dusk-water|day-sky)$/;
const AREA_KEYS = { quiet: 'quiet', quiet_day: 'quiet-day', quiet_night: 'quiet-night', lively: 'lively', lively_day: 'lively-day',
  lively_night: 'lively-night', green: 'green', amenities: 'amenities' };
const NIGHT_KEYS = { bg: 'bg', land: 'land', water: 'water', waterLine: 'water-line', green: 'green', building: 'building',
  building3d: 'building3d', road: 'road', major: 'major', motorway: 'motorway', casing: 'casing', rail: 'rail',
  boundary: 'boundary', text: 'text', halo: 'halo', aero: 'aero' };

/** Normalise one custom block into [[--uw-name, value]]; bad entries are warned about and dropped. */
function tokens(obj, where) {
  const out = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (where === '' && (k === 'base' || k === 'light' || k === 'dark')) continue;
    const m = NAME.exec(k);
    if (!m) { console.warn(`[map] theme${where}: "${k}" is not a token name (use e.g. "accent" or "--uw-accent")`); continue; }
    if ((typeof v !== 'string' && typeof v !== 'number') || !SAFE.test(String(v)) || String(v).length > 400) {
      console.warn(`[map] theme${where}.${k}: value must be one CSS value (a string without ; { } < >)`); continue;
    }
    if (where && DRAWN.test(m[2])) console.warn(`[map] theme${where}.${k}: drawn colours are read once at load; put "${m[2]}" at the top level of theme, not in ${where.slice(1)}`);
    out.push([`--uw-${m[2]}`, String(v)]);
  }
  return out;
}

const block = (sel, list) => (list.length ? `${sel} { ${list.map(([k, v]) => `${k}: ${v};`).join(' ')} }\n` : '');

/**
 * Apply the config's theme. Returns the preset name in use. A string names a preset; an object picks a base preset
 * and adds tokens. With no "theme" key, a data-uw-theme already on <html> (set in index.html) is kept.
 */
export function applyTheme(theme) {
  const html = document.documentElement;
  let base = THEMES.includes(html.dataset.uwTheme) ? html.dataset.uwTheme : 'instafy';
  let custom = null;
  if (typeof theme === 'string') {
    if (THEMES.includes(theme)) base = theme;
    else console.warn(`[map] theme "${theme}" is not a preset (${THEMES.join(', ')}); using "${base}"`);
  } else if (theme && typeof theme === 'object' && !Array.isArray(theme)) {
    if (theme.base !== undefined && !THEMES.includes(theme.base)) console.warn(`[map] theme.base "${theme.base}" is not a preset; using "${base}"`);
    else if (theme.base) base = theme.base;
    custom = theme;
  } else if (theme != null) console.warn('[map] theme must be a preset name or an object of tokens');
  html.dataset.uwTheme = base;
  document.getElementById('uw-theme-custom')?.remove();
  delete html.dataset.uwCustom;
  if (custom) {
    const flat = tokens(custom, ''), light = tokens(custom.light, '.light'), dark = tokens(custom.dark, '.dark');
    // light / dark follow the same switch as the presets: the host's theme when hosted (data-uw-host-theme), else
    // the device. The night map look never changes the chrome, so no block here keys on it.
    const sel = ':where(html[data-uw-custom])';
    const both = [...flat, ...dark];
    const css = block(sel, flat)
      + (light.length ? `@media (prefers-color-scheme: light) { ${block(':where(html[data-uw-custom]:not([data-uw-host-theme="dark"]))', light)}}\n`
        + block(':where(html[data-uw-custom][data-uw-host-theme="light"])', light) : '')
      + (both.length ? `@media (prefers-color-scheme: dark) { ${block(':where(html[data-uw-custom]:not([data-uw-host-theme="light"]))', both)}}\n`
        + block(':where(html[data-uw-custom][data-uw-host-theme="dark"])', both) : '');
    if (css) {
      const el = document.createElement('style');
      el.id = 'uw-theme-custom'; el.textContent = css;
      document.head.append(el);
      html.dataset.uwCustom = '';
    }
  }
  syncColors();
  return base;
}

/** Copy the drawn colours (canvas pins, map layers) from the CSS tokens now in effect. */
export function syncColors() {
  let cs;
  try { cs = getComputedStyle(document.documentElement); } catch { return; }
  const tok = (name) => { const v = cs.getPropertyValue(name).trim(); return v && parseColor(v) ? v : null; };
  for (const L of Object.keys(LETTER_COLORS)) { const v = tok(`--uw-letter-${L.toLowerCase()}`); if (v) LETTER_COLORS[L] = v; }
  CAT_COLORS.forEach((c, i) => { const v = tok(`--uw-cat-${i + 1}`); if (v) CAT_COLORS[i] = v; });
  const pal = cs.getPropertyValue('--uw-palette').split(',').map((x) => x.trim()).filter((x) => x && parseColor(x));
  if (pal.length) PALETTE.splice(0, PALETTE.length, ...pal);
  THEME_COLORS.walk = tok('--uw-walk') || THEME_COLORS.walk;
  THEME_COLORS.walkNight = tok('--uw-walk-night') || THEME_COLORS.walk;
  THEME_COLORS.heatPt = tok('--uw-heat-pt') || THEME_COLORS.heatPt;
  for (const [k, t] of Object.entries(AREA_KEYS)) { const v = tok(`--uw-area-${t}`); if (v) AREA_COLORS[k] = v; }
  const night = {};
  for (const [k, t] of Object.entries(NIGHT_KEYS)) { const v = tok(`--uw-night-${t}`); if (v) night[k] = v; }
  Object.assign(night, { dusk: tok('--uw-dusk'), duskWater: tok('--uw-dusk-water'), daySky: tok('--uw-day-sky'), nightSky: tok('--uw-night-sky'),
    waterMix: cs.getPropertyValue('--uw-night-water-mix').trim() });
  setLookPalette(night);
}
