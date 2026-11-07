// `validate`: check a site thoroughly; every message names file + JSON path + a fix.
import { emptyPlanDays, isPlanSkeletonText, dayPlaceWarnings, dayPlaceLine } from './cmd-plan.mjs';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, makeOut, exists, fmtBytes } from './util.mjs';
import { checkV2, V2_TOP_KEYS, V2_LAYER_KEYS } from './validate-v2.mjs';
import { STARTER_DIR, placeIndex } from './site.mjs';
import { parseStops, expectOf, mergeExpect, uncovered, describeItems, featureNames } from './expect.mjs';
import { stillRunning, runningList } from './running.mjs';
import { REPLY_WITHIN_S } from './turn-advice.mjs';
import { readPage, unnamedSource, sourceSetSince } from './cmd-cite.mjs';
import { cacheOff } from './net.mjs';
import { isAreaPin, isPlaceToStay, stopIsAStay, staysLookedUp, lookedAsFarAsItGoes, STAY_RADIUS_MAX } from './stays.mjs';
import { isLodging } from './registry-geo.mjs';

export const help = `validate <dir> [--signal] [--strict] [--expect "<stop>:<nights>,…"] [--json]
  Checks map.config.json (schema, enums, refs), every layer file (exists, valid GeoJSON, geometry fits the layer type,
  properties.id unique + name present, coordinates sane, inside view.bounds + margin, not [0,0]), plan/notes/compare/vote
  refs, style.json, custom.js (node --check), engine/ and index.html, and size budgets.
  v0.2: question (refs, criteria on options, weights, lenses, budgets), verdict and why lines (V1 cites, V2 numbers
  match metrics, V3 "est." for estimates, V4 banned words, V5 refs, V6 criteria that cannot differ), tiers, links,
  photos.json credits, bind, data/metrics.json, data/records/*.json (records schema), data/version.json, bound.json
  (intents, JSON-Schema subset, prefill tokens, ui placements, targets, handlers), the credit each open-data adapter on the map requires (e.g. OGDL for Taiwan data).
  --signal  the static clutter rules fail instead of warn: S5 (every visible layer says what it is), S6 (a criterion
            that ties on every option), S7 (labels without English; fails only with --strict), photo credits.
  A trip's stops: every stop with nights in map.config.json "expect" (uw handoff --apply writes the route there; uw new
  --expect) and in --expect must be on the map and, when there is a plan, named by a day. One the request named and
  the map leaves out is an error, whatever the reason (a lookup that timed out included): place it, or say plainly in
  the reply that it is missing. A stop with nights on the map is a trip's too, without "expect": it needs a plan, and
  places to stay from uw stay. An area (or any pin that is not lodging) as its only place to stay is an error until uw
  stay looked around it and found none within its widest radius, and so is an area's note that cites no page uw cite
  read that names it: in the turn that built the stop or its stays, while its clock leaves time; later turns are
  warned, as is a stop with no place to stay at all.
  A uw command still running on the site (a place lookup whose command has not finished) is an error, named: what it
  finds is not on the map yet. Wait until it has finished; never start it again.
  Exit 1 on errors, 0 when only warnings remain (--strict: warnings also fail).`;

const LAYER_TYPES = ['points', 'lines', 'areas', 'grid', 'route', 'legs', 'heat'];
const GEOM_OK = {
  points: ['Point', 'MultiPoint'], heat: ['Point', 'MultiPoint'],
  lines: ['LineString', 'MultiLineString'], route: ['LineString', 'MultiLineString'], legs: ['LineString'],
  areas: ['Polygon', 'MultiPolygon'], grid: ['Polygon', 'MultiPolygon'],
};
const TOP_KEYS = ['expect', 'version', 'locale', 'title', 'subtitle', 'view', 'basemap', 'time', 'vibe', 'air', 'layers', 'compare', 'plan', 'notes', 'votes', 'attribution', 'custom', 'css', 'theme', '$schema', 'description', ...V2_TOP_KEYS];
// exactly the keys the engine reads (engine/layers.js); anything else is ignored with a console warning
const LAYER_KEYS = ['id', 'title', 'type', 'data', 'style', 'label', 'group', 'visible', 'list', 'selectable', 'compare', 'card', 'cluster', 'linkedTo',
  'animate', 'weight', 'time', 'attribution', 'minzoom', 'maxzoom', 'legend', 'note', 'linkedIdle', ...V2_LAYER_KEYS];
// CSS colour check (style.color, notes …): #hex, rgb()/hsl(), a CSS named colour, or "{property}"
const NAMED = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent').split(' '));
export function isColor(c) {
  if (typeof c !== 'string') return false;
  const t = c.trim();
  return /^\{[\w:.-]+\}$/.test(t) || /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t) || /^(rgb|rgba|hsl|hsla)\(\s*[-\d.%\s,/deg]+\)$/i.test(t) || NAMED.has(t.toLowerCase());
}
// keywords engine/look.js understands (besides a regex on style layer ids)
const OVERRIDE_KEYWORDS = ['rail', 'railways', 'water', 'roads', 'buildings', 'parks', 'green', 'labels', 'pois', 'boundaries', 'landuse', 'background'];
const LEG_MODES = ['train', 'hsr', 'bus', 'car', 'taxi', 'flight', 'plane', 'ferry', 'boat', 'walk', 'bike', 'metro', 'mrt', 'subway', 'scooter'];

// tokens the engine draws with (engine/theme.js DRAWN): read once from <html>, so they belong at the top level of theme
const DRAWN = /^(letter-[a-e]|cat-[1-6]|palette|walk|walk-night|heat-pt|area-[a-z-]+|night-[a-z0-9-]+|dusk|dusk-water|day-sky)$/;
// CIE76 ΔE between two #hex colours (null when either is not plain hex)
function hexRgb(c) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c).trim()); if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function lab(rgb) {
  const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), y = f(r * 0.2126 + g * 0.7152 + b * 0.0722), z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
export function deltaE(a, b) { const A = hexRgb(a), B = hexRgb(b); if (!A || !B) return null; const p = lab(A), q = lab(B); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); }
/** The theme's option-letter colours (and walk ink) as the page will draw them, from engine.css + the config's theme. */
function themeColors(cfg) {
  const css = fs.readFileSync(path.join(STARTER_DIR, 'engine', 'engine.css'), 'utf8');
  const cut = css.indexOf(':where(html[data-uw-theme="neutral"])');
  const preset = typeof cfg.theme === 'string' ? cfg.theme : cfg.theme?.base || 'instafy';
  const block = preset === 'neutral' ? css.slice(cut) : css.slice(0, cut);
  const tok = (name) => (new RegExp(`--uw-${name}:\\s*(#[0-9a-fA-F]{3,6})\\b`).exec(block) || [])[1] || null;
  const out = { letters: {}, walk: tok('walk') };
  for (const L of 'abcde') out.letters[L.toUpperCase()] = tok(`letter-${L}`);
  if (cfg.theme && typeof cfg.theme === 'object') {
    const flat = Object.fromEntries(Object.entries(cfg.theme).map(([k, v]) => [k.replace(/^-{0,2}(uw-)?/, ''), v]));
    for (const L of 'abcde') if (typeof flat[`letter-${L}`] === 'string') out.letters[L.toUpperCase()] = flat[`letter-${L}`];
    if (typeof flat.walk === 'string') out.walk = flat.walk;
  }
  return out;
}
const LETTER_NEAR = 20; // ΔE76 below this reads as "the same colour" next to each other on a map
function checkLetterColors({ cfg, featuresByLayer, W, CFG }) {
  const q = cfg.question;
  const T = themeColors(cfg);
  // letter colours that collide with each other (custom themes)
  const ls = Object.entries(T.letters).filter(([, c]) => hexRgb(c));
  for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) {
    const d = deltaE(ls[i][1], ls[j][1]);
    if (d < LETTER_NEAR) W(CFG, '$.theme', `letters ${ls[i][0]} (${ls[i][1]}) and ${ls[j][0]} (${ls[j][1]}) are nearly the same colour (ΔE ${d.toFixed(0)})`, 'give every letter-a … letter-e token its own hue (the letters are identities, not a ramp)');
  }
  if (!q || typeof q !== 'object' || !['choose-one', 'find-place'].includes(q.kind) || q.options?.letters === false) return;
  const optLayer = q.options?.layer;
  const nOpts = q.kind === 'choose-one' ? (Array.isArray(q.options?.ids) ? q.options.ids.length : (featuresByLayer.get(optLayer) || []).length) : (q.options?.top || 5);
  const used = ls.slice(0, Math.max(0, Math.min(5, nOpts || 0)));
  if (!used.length) return;
  for (const [i, l] of (cfg.layers || []).entries()) {
    if (!l || l.id === optLayer || typeof l.style?.color !== 'string') continue;
    const c = l.style.color === 'walk' ? T.walk : l.style.color;
    if (!hexRgb(c)) continue;
    let worst = null;
    for (const [L, lc] of used) { const d = deltaE(c, lc); if (d < LETTER_NEAR && (!worst || d < worst.d)) worst = { L, lc, d }; }
    if (worst) W(CFG, `$.layers[${i}].style.color`, `layer "${l.id}" (${l.style.color}) looks like option letter ${worst.L} (${worst.lc}, ΔE ${worst.d.toFixed(0)}); viewers will read it as part of ${worst.L}`,
      l.linkedTo === optLayer ? 'use "color": "letter" so each walk area / route takes its own option\'s colour, or "walk"' : 'pick a colour at least ~20 ΔE from every letter colour (reference/config.md → theme)');
  }
}

/** `turnLeftS`: seconds the turn clock leaves for tool work; `turnStartedMs`: when this turn started (uw.mjs; null: no
 *  clock, as when uw doctor checks a site). */
export async function run(argv, { turnLeftS = null, turnStartedMs = null } = {}) {
  const args = parseArgs(argv, { strict: 'bool', signal: 'bool', expect: 'string' }, { positionals: [1, 1], command: 'validate' });
  if (args.help) return console.log(help);
  const askedStops = parseStops(args.expect);
  const out = makeOut(args);
  const dir = path.resolve(args._[0]);
  const errors = [], warnings = [];
  const E = (file, p, message, fix) => errors.push({ level: 'error', file, path: p, message, fix });
  const W = (file, p, message, fix) => warnings.push({ level: 'warning', file, path: p, message, fix });
  const finish = () => report(out, args, dir, errors, warnings);

  if (!exists(dir) || !fs.statSync(dir).isDirectory()) { E(args._[0], '', 'site directory does not exist', `create it: uw new ${args._[0]}`); return finish(); }
  const CFG = 'map.config.json';
  const cfgPath = path.join(dir, CFG);
  if (!exists(cfgPath)) { E(CFG, '', 'missing', `this is not a map site; create one with: uw new ${args._[0]}`); return finish(); }
  let cfg;
  const raw = fs.readFileSync(cfgPath, 'utf8');
  try { cfg = JSON.parse(raw); } catch (e) {
    const m = String(e.message).match(/position (\d+)/);
    let where = '';
    if (m) { const pos = Number(m[1]); const before = raw.slice(0, pos); where = ` at line ${before.split('\n').length}, column ${pos - before.lastIndexOf('\n')}`; }
    E(CFG, '', `invalid JSON${where}: ${e.message}`, 'fix the syntax (no comments, no trailing commas, double quotes only)');
    return finish();
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { E(CFG, '$', 'must be a JSON object', 'start from starter/map.config.json'); return finish(); }
  // commands still running on this site (lib/running.mjs): what they find is not on the map yet
  const running = stillRunning(dir);
  if (running.length) {
    const many = running.length > 1;
    E('data/', '', `still running on this site: ${runningList(running)}; what ${many ? 'they find is' : 'it finds is'} not on the map yet`,
      `wait until ${many ? 'each has' : 'it has'} finished (an exit code; never start ${many ? 'one' : 'it'} again), then ${cfg.plan ? 'uw plan … --force (its days take what was found) and ' : ''}validate again`);
  }

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isLngLat = (c) => Array.isArray(c) && c.length >= 2 && isNum(c[0]) && isNum(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90;
  const local = (p) => typeof p === 'string' && !/^(https?:)?\/\//i.test(p) && !p.startsWith('data:');
  const inside = (p) => { const a = path.resolve(dir, p); return a === dir || a.startsWith(dir + path.sep); };

  // --- top level
  for (const k of Object.keys(cfg)) if (!TOP_KEYS.includes(k)) W(CFG, `$.${k}`, `unknown key "${k}" (the engine ignores it)`, `remove it, or check the spelling against reference/config.md (known: ${TOP_KEYS.slice(0, 14).join(', ')})`);
  if (cfg.version !== 1 && cfg.version !== 2) E(CFG, '$.version', `version must be 1 or 2 (got ${JSON.stringify(cfg.version)})`, 'set "version": 2 (or 1 for a v0 site)');
  if (cfg.locale !== undefined && !['en', 'sv'].includes(cfg.locale)) W(CFG, '$.locale', `locale "${cfg.locale}" is not supported (en, sv); the map's own words stay English`, 'set "locale" to "en" or "sv", or remove it');
  if (typeof cfg.title !== 'string' || !cfg.title.trim()) W(CFG, '$.title', 'no title', 'add a short "title" (shown in the sheet header and browser tab)');

  // --- view
  let bounds = null;
  const v = cfg.view;
  if (!v || typeof v !== 'object') E(CFG, '$.view', 'missing view', 'add "view": { "center": [lng, lat], "zoom": 13, "bounds": [[w, s], [e, n]] }');
  else {
    if (!isLngLat(v.center)) E(CFG, '$.view.center', `center must be [lng, lat] (got ${JSON.stringify(v.center)})`, 'use numbers, longitude first, e.g. [121.52, 25.05]');
    else if (v.center[0] === 0 && v.center[1] === 0) E(CFG, '$.view.center', 'center is [0, 0]', 'set the real centre (from geocode)');
    if (v.zoom !== undefined && (!isNum(v.zoom) || v.zoom < 0 || v.zoom > 22)) E(CFG, '$.view.zoom', `zoom must be 0-22 (got ${JSON.stringify(v.zoom)})`, 'city ≈ 12, neighbourhood ≈ 14.5, street ≈ 16');
    for (const k of ['pitch', 'bearing']) if (v[k] !== undefined && !isNum(v[k])) E(CFG, `$.view.${k}`, `${k} must be a number`, `remove it or use a number`);
    if (v.pitch !== undefined && isNum(v.pitch) && (v.pitch < 0 || v.pitch > 85)) E(CFG, '$.view.pitch', 'pitch must be 0-85', 'use 0 (flat) to 60 (3D)');
    if (v.bounds !== undefined) {
      const b = v.bounds;
      if (!Array.isArray(b) || b.length !== 2 || !isLngLat(b[0]) || !isLngLat(b[1])) E(CFG, '$.view.bounds', 'bounds must be [[west, south], [east, north]]', 'e.g. [[121.49, 25.02], [121.56, 25.08]]');
      else if (!(b[0][0] < b[1][0] && b[0][1] < b[1][1])) E(CFG, '$.view.bounds', `bounds corners are in the wrong order: ${JSON.stringify(b)}`, 'first [west, south], then [east, north]');
      else {
        bounds = [b[0][0], b[0][1], b[1][0], b[1][1]];
        if (isLngLat(v.center) && !(v.center[0] >= bounds[0] && v.center[0] <= bounds[2] && v.center[1] >= bounds[1] && v.center[1] <= bounds[3]))
          W(CFG, '$.view.center', 'center is outside view.bounds', 'move the centre inside the bounds or widen the bounds');
      }
    } else W(CFG, '$.view.bounds', 'no bounds', 'run: uw fit <site> after adding data (writes center, zoom and bounds)');
  }

  // --- theme (engine/theme.js): a preset name, or { base?, light?, dark?, …tokens }
  if (cfg.theme !== undefined) {
    const THEMES = ['instafy', 'neutral'];
    const tokOk = (o, p) => {
      for (const [k, v] of Object.entries(o)) {
        if (p === '$.theme' && ['base', 'light', 'dark'].includes(k)) continue;
        if (!/^-{0,2}(uw-)?[a-z][a-z0-9-]{0,40}$/.test(k)) E(CFG, `${p}.${k}`, `"${k}" is not a token name`, 'use the token without its prefix, e.g. "accent" for --uw-accent (reference/config.md lists them)');
        else if ((typeof v !== 'string' && typeof v !== 'number') || /[;{}<>\\]/.test(String(v))) E(CFG, `${p}.${k}`, 'a token value must be one CSS value (a string without ; { } < >)', 'e.g. "#e11d48" or "12px"');
      }
    };
    if (typeof cfg.theme === 'string') { if (!THEMES.includes(cfg.theme)) E(CFG, '$.theme', `theme must be ${THEMES.map((t) => `"${t}"`).join(' or ')} or an object of tokens (got ${JSON.stringify(cfg.theme)})`, 'use "instafy" (the default) or "neutral" (the pre-theme look)'); }
    else if (!cfg.theme || typeof cfg.theme !== 'object' || Array.isArray(cfg.theme)) E(CFG, '$.theme', 'theme must be a preset name or an object of tokens', 'e.g. "theme": "neutral" or { "base": "instafy", "accent": "#0f766e" }');
    else {
      if (cfg.theme.base !== undefined && !THEMES.includes(cfg.theme.base)) E(CFG, '$.theme.base', `base must be ${THEMES.map((t) => `"${t}"`).join(' or ')}`, 'leave it out for "instafy"');
      tokOk(cfg.theme, '$.theme');
      for (const m of ['light', 'dark']) if (cfg.theme[m] !== undefined) {
        if (!cfg.theme[m] || typeof cfg.theme[m] !== 'object' || Array.isArray(cfg.theme[m])) E(CFG, `$.theme.${m}`, `${m} must be an object of tokens`, '');
        else {
          tokOk(cfg.theme[m], `$.theme.${m}`);
          for (const k of Object.keys(cfg.theme[m])) if (DRAWN.test(k.replace(/^-{0,2}(uw-)?/, '')))
            W(CFG, `$.theme.${m}.${k}`, `"${k}" is drawn on the map and read once at load, so a ${m}-only value is not followed when the look changes`, `move it to the top level of "theme"`);
        }
      }
    }
  }

  // --- basemap + style.json
  const bm = cfg.basemap || {};
  if (cfg.basemap !== undefined && (typeof cfg.basemap !== 'object' || Array.isArray(cfg.basemap))) E(CFG, '$.basemap', 'basemap must be an object', 'see reference/config.md');
  if (bm.labels !== undefined && !['en', 'local', 'both'].includes(bm.labels)) E(CFG, '$.basemap.labels', `labels must be "en", "local" or "both" (got ${JSON.stringify(bm.labels)})`, 'use "en" for travellers');
  if (bm.theme !== undefined && !['light', 'dark', 'auto'].includes(bm.theme)) E(CFG, '$.basemap.theme', `theme must be "light", "dark" or "auto"`, 'use "auto" to follow the time slider');
  if (bm.terrain !== undefined && typeof bm.terrain !== 'boolean') E(CFG, '$.basemap.terrain', 'terrain must be true or false', '');
  if (bm.relief !== undefined && typeof bm.relief !== 'boolean') E(CFG, '$.basemap.relief', 'relief must be true or false', 'true keeps a soft hillshade on in 2D (needs no 3D)');
  if (bm.exaggeration !== undefined && (!isNum(bm.exaggeration) || bm.exaggeration < 0.5 || bm.exaggeration > 3)) E(CFG, '$.basemap.exaggeration', 'exaggeration must be 0.5-3', '1.35 is the default; 1.7 for dramatic mountains');
  for (const k of Object.keys(bm)) if (!['style', 'labels', 'theme', 'terrain', 'relief', 'exaggeration', 'overrides', 'placeLabels'].includes(k)) W(CFG, `$.basemap.${k}`, `unknown basemap key "${k}" (ignored)`, 'known: style, labels, theme, terrain, relief, exaggeration, overrides, placeLabels');
  if (bm.placeLabels !== undefined && !['all', 'auto'].includes(bm.placeLabels)) E(CFG, '$.basemap.placeLabels', 'placeLabels must be "auto" (named areas replace neighbourhood labels) or "all"', '');
  const styleRef = bm.style ?? 'style.json';
  let style = null;
  if (typeof styleRef === 'string' && local(styleRef)) {
    const sp = path.join(dir, styleRef);
    if (!inside(styleRef)) E(CFG, '$.basemap.style', 'style path points outside the site', 'keep style.json inside the site');
    else if (!exists(sp)) E(styleRef, '', 'style file not found', `restore it from the starter (uw new <tmp> and copy style.json) or point basemap.style at a style URL`);
    else {
      try { style = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch (e) { E(styleRef, '', `invalid JSON: ${e.message}`, 'fix the syntax'); }
      if (style) {
        if (style.version !== 8) E(styleRef, '$.version', 'MapLibre styles must have "version": 8', 'set "version": 8');
        if (!style.sources || typeof style.sources !== 'object') E(styleRef, '$.sources', 'missing sources', 'restore style.json from the starter');
        if (!Array.isArray(style.layers)) E(styleRef, '$.layers', 'missing layers array', 'restore style.json from the starter');
        else {
          const ids = new Set();
          style.layers.forEach((l, i) => {
            if (!l?.id) E(styleRef, `$.layers[${i}].id`, 'style layer without id', 'give every layer a unique id');
            else if (ids.has(l.id)) E(styleRef, `$.layers[${i}].id`, `duplicate style layer id "${l.id}"`, 'make ids unique');
            else ids.add(l.id);
            if (l?.source && style.sources && !style.sources[l.source]) E(styleRef, `$.layers[${i}].source`, `layer "${l.id}" uses unknown source "${l.source}"`, `add the source or fix the name (sources: ${Object.keys(style.sources).join(', ')})`);
            if (l?.type === 'symbol' && !style.glyphs && l.layout?.['text-field']) E(styleRef, '$.glyphs', `symbol layer "${l.id}" has text but the style has no "glyphs" URL`, 'restore "glyphs" from the starter style');
          });
        }
      }
    }
  } else if (styleRef !== undefined && typeof styleRef !== 'string') E(CFG, '$.basemap.style', 'style must be a path or URL string', 'use "style.json"');
  if (bm.overrides !== undefined) {
    if (!Array.isArray(bm.overrides)) E(CFG, '$.basemap.overrides', 'overrides must be an array', 'e.g. [{ "layers": "rail", "paint": { "line-color": "#22c55e" } }]');
    else bm.overrides.forEach((o, i) => {
      const p = `$.basemap.overrides[${i}]`;
      const sels = Array.isArray(o?.layers) ? o.layers : [o?.layers];
      if (!o || !sels.length || sels.some((x) => typeof x !== 'string')) { E(CFG, `${p}.layers`, 'needs "layers": a keyword, a regex on style layer ids, or a list of them', `keywords: ${OVERRIDE_KEYWORDS.join(', ')}`); return; }
      if (!o.paint && !o.layout && o.visible === undefined && o.color === undefined && o.opacity === undefined && o.width === undefined && !o.filter)
        W(CFG, p, 'override changes nothing', 'add "color", "paint": { … }, "layout", "visible" or remove it');
      for (const sel of sels) {
        if (OVERRIDE_KEYWORDS.includes(sel)) continue;
        let re = null;
        try { re = new RegExp(sel); } catch (e) { E(CFG, `${p}.layers`, `not a valid regex: ${e.message}`, 'escape special characters'); }
        if (re && style?.layers && !style.layers.some((l) => re.test(l.id))) W(CFG, `${p}.layers`, `"${sel}" matches no layer in ${styleRef}`, `use a keyword (${OVERRIDE_KEYWORDS.join(', ')}) or check layer ids in style.json`);
      }
      for (const k of ['paint', 'layout']) if (o[k] !== undefined && (typeof o[k] !== 'object' || Array.isArray(o[k]))) E(CFG, `${p}.${k}`, `${k} must be an object of MapLibre properties`, 'e.g. { "line-color": "#22c55e" }');
    });
  }

  // --- layers
  const layers = Array.isArray(cfg.layers) ? cfg.layers : [];
  if (!Array.isArray(cfg.layers)) E(CFG, '$.layers', 'layers must be an array', 'add "layers": []');
  const byId = new Map();
  const featuresByLayer = new Map();
  // what wrote each layer file, and when ("uw": { "cmd", "updated_at" })
  const uwByLayer = new Map();
  // layers of places picked one by one (add-point): one place, one pin
  const pinLayers = new Set();
  const checkedFiles = new Set();
  let dataBytes = 0;
  // properties custom.js sets at runtime ("p.ride = …") are fine in card templates even though no data file has them
  let customSrc = '';
  try { if (typeof cfg.custom === 'string' && local(cfg.custom) && inside(cfg.custom)) customSrc = fs.readFileSync(path.join(dir, cfg.custom), 'utf8'); } catch {}
  const setAtRuntime = (prop) => !!customSrc && new RegExp(`\\.${prop.replace(/[^\w]/g, '')}\\s*=[^=]|\\[['"]${prop.replace(/[^\w]/g, '')}['"]\\]\\s*=[^=]`).test(customSrc);
  layers.forEach((l, i) => {
    const p = `$.layers[${i}]`;
    if (!l || typeof l !== 'object') { E(CFG, p, 'layer must be an object', ''); return; }
    if (typeof l.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(l.id)) E(CFG, `${p}.id`, `layer id ${JSON.stringify(l.id)} is invalid`, 'use letters, digits, - and _ (no spaces, commas or colons; ids appear in the URL hash)');
    else if (byId.has(l.id)) { E(CFG, `${p}.id`, `duplicate layer id "${l.id}"`, 'give each layer a unique id'); return; }
    else byId.set(l.id, l);
    for (const k of Object.keys(l)) if (!LAYER_KEYS.includes(k)) W(CFG, `${p}.${k}`, `unknown layer key "${k}" (ignored by the engine)`, 'check reference/config.md');
    if (!LAYER_TYPES.includes(l.type)) E(CFG, `${p}.type`, `type ${JSON.stringify(l.type)} is not one of ${LAYER_TYPES.join(', ')}`, 'pick the matching type');
    if (l.data === undefined) E(CFG, `${p}.data`, 'missing data', `point it at a file written by a script, e.g. "data/${l.id || 'layer'}.geojson"`);
    else if (typeof l.data === 'object') { if (l.data?.type !== 'FeatureCollection') E(CFG, `${p}.data`, 'inline data must be a FeatureCollection', 'or use a file path'); else checkFC(l, l.data, CFG, `${p}.data`); }
    else if (typeof l.data !== 'string') E(CFG, `${p}.data`, 'data must be a path string', '');
    else if (local(l.data)) {
      if (!inside(l.data)) E(CFG, `${p}.data`, `data path "${l.data}" points outside the site`, 'keep data files under data/');
      else {
        const fp = path.join(dir, l.data);
        if (checkedFiles.has(fp)) { /* same file as an earlier layer: checked once */ }
        else if (!exists(fp)) E(CFG, `${p}.data`, `file "${l.data}" not found`, `generate it (e.g. uw ${suggestCmd(l)} ${args._[0]} --layer ${l.id} …) or fix the path`);
        else {
          const size = fs.statSync(fp).size;
          dataBytes += size;
          if (size > 10 * 1024 * 1024) E(l.data, '', `file is ${fmtBytes(size)} (> 10 MB)`, 'narrow the area, lower --limit or raise --simplify');
          else if (size > 3 * 1024 * 1024) W(l.data, '', `file is ${fmtBytes(size)} (> 3 MB): slow on phones`, 'narrow the area or raise --simplify');
          let fc = null;
          try { fc = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { E(l.data, '', `invalid JSON: ${e.message}`, 'regenerate it with the script that made it'); }
          if (fc) checkFC(l, fc, l.data, '$');
          checkedFiles.add(fp);
        }
      }
    }
    if (l.style !== undefined) {
      if (typeof l.style !== 'object' || Array.isArray(l.style)) E(CFG, `${p}.style`, 'style must be an object', 'e.g. { "color": "#e11d48", "emoji": "🏨" }');
      else {
        const s = l.style;
        if (s.size !== undefined && !['s', 'm', 'l'].includes(s.size) && !(isNum(s.size) && s.size >= 16 && s.size <= 64)) E(CFG, `${p}.style.size`, `size must be "s", "m", "l" or a pixel diameter 16-64`, '');
        if (s.opacity !== undefined && (!isNum(s.opacity) || s.opacity < 0 || s.opacity > 1)) E(CFG, `${p}.style.opacity`, 'opacity must be 0-1', '');
        if (s.width !== undefined && (!isNum(s.width) || s.width <= 0 || s.width > 40)) E(CFG, `${p}.style.width`, 'width must be a number of pixels (1-40)', '');
        const kw = s.color === 'walk' || s.color === 'letter';
        if (s.color !== undefined && !kw && !isColor(s.color)) E(CFG, `${p}.style.color`, `${JSON.stringify(s.color)} is not a colour`, 'use a CSS colour ("#16a34a", "green", "rgb(22,163,74)"), "{property}" for a colour stored on each feature, "walk" (the theme\'s walk ink) or "letter" (a layer linkedTo the options)');
        if (kw && !['lines', 'route', 'areas'].includes(l.type)) W(CFG, `${p}.style.color`, `"${s.color}" only applies to lines, route and areas layers`, 'use a CSS colour here');
        if (s.color === 'letter' && !l.linkedTo) W(CFG, `${p}.style.color`, '"letter" needs "linkedTo" (the options layer)', 'add "linkedTo": "<options layer>" or use "walk"');
        if (s.emoji !== undefined && (typeof s.emoji !== 'string' || [...s.emoji].length > 8)) E(CFG, `${p}.style.emoji`, 'emoji must be a short string (one emoji)', '');
      }
    }
    if (l.cluster && l.type !== 'points') W(CFG, `${p}.cluster`, 'cluster only applies to points layers', 'remove it');
    if (l.animate && l.type !== 'route') W(CFG, `${p}.animate`, 'animate only applies to route layers', 'remove it or use type "route"');
    if (l.time !== undefined && !(Array.isArray(l.time) && l.time.length === 2 && l.time.every(isNum))) E(CFG, `${p}.time`, 'time must be [fromHour, toHour]', 'e.g. [18, 26] for 18:00-02:00');
    if (l.card !== undefined && (typeof l.card !== 'object' || Array.isArray(l.card))) E(CFG, `${p}.card`, 'card must be an object { subtitle, body, fields }', '');
    if (l.card?.fields !== undefined && !Array.isArray(l.card.fields)) E(CFG, `${p}.card.fields`, 'fields must be an array of property names', '');
    if (l.linkedIdle !== undefined && !['show', 'faint'].includes(l.linkedIdle)) E(CFG, `${p}.linkedIdle`, 'linkedIdle must be "show" or "faint"', '"show" keeps every linked area visible while nothing is selected');
  });
  // linkedTo + property references
  layers.forEach((l, i) => {
    if (!l || typeof l !== 'object') return;
    const p = `$.layers[${i}]`;
    const feats = featuresByLayer.get(l.id) || [];
    const has = (prop) => feats.some((f) => f?.properties?.[prop] !== undefined) || setAtRuntime(prop);
    if (l.linkedTo !== undefined) {
      if (!byId.has(l.linkedTo)) E(CFG, `${p}.linkedTo`, `linkedTo "${l.linkedTo}" is not a layer id`, `use one of: ${[...byId.keys()].join(', ')}`);
      else if (feats.length) {
        const ids = new Set((featuresByLayer.get(l.linkedTo) || []).map((f) => String(f?.properties?.id)));
        const forVals = feats.map((f) => f?.properties?.for).filter((x) => x != null).map(String);
        if (!forVals.length) E(l.data, '$.features[*].properties.for', `layer "${l.id}" is linkedTo "${l.linkedTo}" but no feature has a "for" property`, `make it with: uw isochrone ${args._[0]} --layer ${l.id} --from layer:${l.linkedTo}`);
        else {
          const bad = [...new Set(forVals.filter((x) => !ids.has(x)))];
          if (bad.length) W(l.data, '$.features[*].properties.for', `${bad.length} "for" value(s) match no ${l.linkedTo} id: ${bad.slice(0, 5).join(', ')}`, `re-run isochrone after changing ${l.linkedTo}`);
          const missing = [...ids].filter((x) => !forVals.includes(x));
          if (missing.length) W(l.data, '$.features[*].properties.for', `no ${l.id} feature for ${missing.length} ${l.linkedTo} feature(s): ${missing.slice(0, 5).join(', ')}`, `re-run: uw isochrone ${args._[0]} --layer ${l.id} --from layer:${l.linkedTo}`);
        }
      }
    }
    if (!feats.length) return;
    const tpl = (s) => [...String(s || '').matchAll(/\{([A-Za-z0-9_:.-]+)\}/g)].map((m) => m[1]);
    if (typeof l.style?.color === 'string') for (const prop of tpl(l.style.color)) if (!has(prop)) W(CFG, `${p}.style.color`, `"{${prop}}" but no feature in ${l.id} has "${prop}"`, 'the fallback colour will be used everywhere; check the property name');
    // a template ("{name_en} · {name}") names properties in braces: check those, not the whole string
    if (typeof l.label === 'string') {
      const keys = /\{[^}]+\}/.test(l.label) ? [...l.label.matchAll(/\{([^}|]+)/g)].map((m) => m[1].trim()) : [l.label];
      const missingKeys = keys.filter((k) => !has(k));
      if (missingKeys.length === keys.length) W(CFG, `${p}.label`, `label ${keys.length > 1 ? 'template properties' : 'property'} ${missingKeys.map((k) => `"${k}"`).join(', ')} not on any feature`, 'use "name" or an existing property');
    }
    for (const k of ['subtitle', 'body']) for (const prop of tpl(l.card?.[k])) if (!has(prop)) W(CFG, `${p}.card.${k}`, `"{${prop}}" is not on any ${l.id} feature`, 'run enrich or fix the property name');
    if (Array.isArray(l.card?.fields)) l.card.fields.forEach((f, j) => { if (!has(f)) W(CFG, `${p}.card.fields[${j}]`, `"${f}" is not on any ${l.id} feature`, `run: uw enrich ${args._[0]} --layer ${l.id} … (or fix the name)`); });
    if (l.type === 'heat' && l.weight && !feats.some((f) => typeof f?.properties?.[l.weight] === 'number')) W(CFG, `${p}.weight`, `weight "${l.weight}" is not a numeric property in ${l.id}`, 'remove weight or fix the property name');
  });

  // one place, one pin: one place twice in a layer of picked places (the same OpenStreetMap object or register listing,
  // or the same name a few steps away: another object of it, as add-point judges it). A square pinned again under a
  // new id to fill a third day showed twice on the map and on two days, and the only error was "places cite one page",
  // whose fix (cite each one's own page) could not clear it: the reply went out with it standing
  for (const lid of pinLayers) {
    const same = new Map();
    const feats = (featuresByLayer.get(lid) || []).filter((f) => f?.properties?.id != null);
    const place = placeIndex(feats);
    feats.forEach((f, i) => {
      if (!same.has(place[i])) same.set(place[i], []);
      same.get(place[i]).push(f.properties);
    });
    const inDays = new Set((Array.isArray(cfg.plan?.days) ? cfg.plan.days : []).flatMap((d) => [d?.focus, ...(Array.isArray(d?.items) ? d.items : []).map((it) => it?.ref)])
      .filter((r) => r && r.layer === lid).map((r) => String(r.id)));
    for (const pins of same.values()) if (pins.length > 1) {
      const later = pins.slice(1);
      const planned = later.some((pr) => inDays.has(String(pr.id)));
      E(byId.get(lid)?.data || CFG, '$.features', `one place is pinned ${pins.length} times: ${pins[0].name_en || pins[0].name} (${pins.map((pr) => `${lid}:${pr.id}`).join(', ')})`,
        `one place, one pin: remove the later ${later.length === 1 ? 'pin' : 'pins'}: ${later.map((pr) => `uw set ${args._[0]} ${lid}:${pr.id} --remove`).join('; ')}`
          + (planned ? `; then the days: uw plan ${args._[0]} … --force in the turn that planned them, else remove its item from its day and reword that day's text; a day it leaves short takes another place, from its own page` : ''));
    }
  }

  // data files nobody uses (usually: the agent forgot to add the layer to the config)
  try {
    const used = new Set(layers.map((l) => (typeof l?.data === 'string' ? path.normalize(l.data) : null)).filter(Boolean));
    if (cfg.air?.data) used.add(path.normalize(cfg.air.data));
    for (const f of fs.readdirSync(path.join(dir, 'data'))) {
      if (!f.endsWith('.geojson')) continue;
      const rel = path.normalize(`data/${f}`);
      if (used.has(rel)) continue;
      let type = '…';
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
        const g = j.features?.[0]?.geometry?.type || '';
        type = /Polygon/.test(g) ? (j.uw?.cmd === 'feel' ? 'grid' : 'areas') : /LineString/.test(g) ? ({ route: 'route', legs: 'legs' }[j.uw?.cmd] || 'lines') : /Point/.test(g) ? 'points' : '…';
      } catch {}
      if (type === '…') try { type = { places: 'points', 'add-point': 'points', wiki: 'points', lines: 'lines', route: 'route', isochrone: 'areas', legs: 'legs', feel: 'grid', areas: 'areas', 'tw-night-markets': 'points' }[JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')).uw?.cmd] || '…'; } catch {}
      W(rel, '', 'not used by any layer in map.config.json', `add { "id": "${f.replace(/\.geojson$/, '')}", "type": "${type}", "data": "data/${f}" } to "layers", or delete the file`);
    }
  } catch { /* no data dir */ }

  // --- refs
  const ref = (r, file, p, what, gone = null) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { E(file, p, `${what} must be { "layer": "<id>", "id": "<featureId>" }`, ''); return; }
    if (!byId.has(r.layer)) { E(file, p + '.layer', `${what}: unknown layer "${r.layer}"`, `use one of: ${[...byId.keys()].join(', ')}`); return; }
    const feats = featuresByLayer.get(r.layer);
    if (feats && !feats.some((f) => String(f?.properties?.id) === String(r.id))) {
      const ids = feats.map((f) => f?.properties?.id).filter(Boolean);
      const sim = ids.filter((x) => String(x).includes(String(r.id)) || String(r.id).includes(String(x))).slice(0, 3);
      E(file, p + '.id', `${what}: no feature "${r.id}" in layer "${r.layer}"`, sim.length ? `did you mean ${sim.join(', ')}?` : gone || `ids look like: ${ids.slice(0, 4).join(', ')}`);
    }
  };
  if (cfg.time !== undefined) {
    if (typeof cfg.time !== 'object') E(CFG, '$.time', 'time must be an object', '{ "enabled": true, "default": 14 }');
    else if (cfg.time.default !== undefined && (!isNum(cfg.time.default) || cfg.time.default < 0 || cfg.time.default > 24)) E(CFG, '$.time.default', 'default hour must be 0-24', '');
  }
  if (cfg.vibe !== undefined) {
    if (typeof cfg.vibe !== 'object') E(CFG, '$.vibe', 'vibe must be an object', '{ "enabled": true, "default": 0.4, "grid": "feel" }');
    else {
      if (cfg.vibe.default !== undefined && (!isNum(cfg.vibe.default) || cfg.vibe.default < 0 || cfg.vibe.default > 1)) E(CFG, '$.vibe.default', 'vibe default must be 0-1', '0 = calm, 1 = lively');
      if (cfg.vibe.enabled !== false) {
        const g = cfg.vibe.grid || 'feel';
        if (!byId.has(g)) E(CFG, '$.vibe.grid', `vibe.grid "${g}" is not a layer id`, `add a grid layer (uw feel ${args._[0]} --bbox …) or set "vibe": { "enabled": false }`);
        else if (byId.get(g).type !== 'grid') E(CFG, '$.vibe.grid', `layer "${g}" is type "${byId.get(g).type}", not "grid"`, 'point vibe.grid at the feel grid layer');
      }
    }
  }
  if (cfg.air !== undefined) {
    if (typeof cfg.air !== 'object') E(CFG, '$.air', 'air must be an object', '{ "enabled": true, "data": "data/air.json" }');
    else if (cfg.air.enabled !== false) {
      const ap = cfg.air.data || 'data/air.json';
      if (local(ap) && !exists(path.join(dir, ap))) E(CFG, '$.air.data', `"${ap}" not found`, `run: uw air ${args._[0]} --at lng,lat (or set "air": { "enabled": false })`);
      else if (local(ap)) {
        try {
          const a = JSON.parse(fs.readFileSync(path.join(dir, ap), 'utf8'));
          if (!Array.isArray(a.locations) || !a.locations.length || !a.locations[0].by_hour) E(ap, '$.locations', 'no locations with by_hour', 'regenerate with uw.mjs air');
          else {
            const age = (Date.now() - Date.parse(a.generated_at)) / 864e5;
            if (age > 7) W(ap, '$.generated_at', `air data is ${Math.round(age)} days old`, 'refresh: uw air …');
          }
        } catch (e) { E(ap, '', `invalid JSON: ${e.message}`, 'regenerate with uw.mjs air'); }
      }
      const attr = JSON.stringify(cfg.attribution || []);
      let fileAttr = false; try { fileAttr = local(ap) && /open-meteo/i.test(JSON.parse(fs.readFileSync(path.join(dir, ap), 'utf8')).attribution || ''); } catch {}
      if (!fileAttr && !/open-meteo|cams/i.test(attr)) W(CFG, '$.attribution', 'air data is shown but not attributed', 'add "Air: Open-Meteo / CAMS" to "attribution"');
      let fileDisc = false; try { fileDisc = local(ap) && /ECMWF/.test(JSON.parse(fs.readFileSync(path.join(dir, ap), 'utf8')).disclaimer || ''); } catch {}
      if (!fileDisc && !/ECMWF/.test(attr)) W(ap, '$.disclaimer', 'the CAMS licence disclaimer is missing', `re-run: uw air ${args._[0]} … (it writes the disclaimer the engine shows)`);
    }
  }
  if (cfg.compare !== undefined) {
    const c = cfg.compare;
    if (!c || typeof c !== 'object') E(CFG, '$.compare', 'compare must be an object', '');
    else {
      if (!byId.has(c.layer)) E(CFG, '$.compare.layer', `compare.layer "${c.layer}" is not a layer id`, `use one of: ${[...byId.keys()].join(', ')}`);
      if (c.max !== undefined && (!Number.isInteger(c.max) || c.max < 2 || c.max > 6)) E(CFG, '$.compare.max', 'max must be an integer 2-6', '3 fits a phone');
      if (c.default !== undefined) {
        const ids = new Set((featuresByLayer.get(c.layer) || []).map((f) => String(f?.properties?.id)));
        if (!Array.isArray(c.default)) E(CFG, '$.compare.default', 'default must be an array of feature ids', '["via-loft", "lore"]');
        else c.default.forEach((id, j) => { if (ids.size && !ids.has(String(id))) E(CFG, `$.compare.default[${j}]`, `no ${c.layer} feature "${id}"`, `ids look like: ${[...ids].slice(0, 4).join(', ')}`); });
      }
      if (!Array.isArray(c.metrics) || !c.metrics.length) E(CFG, '$.compare.metrics', 'metrics must be a non-empty array', '[{ "key": "cafes_10min", "label": "Cafés ≤10 min", "better": "higher" }]');
      else {
        const feats = featuresByLayer.get(c.layer) || [];
        c.metrics.forEach((m, j) => {
          const p = `$.compare.metrics[${j}]`;
          if (!m?.key) { E(CFG, `${p}.key`, 'metric needs a "key"', ''); return; }
          if (m.better !== undefined && !['higher', 'lower'].includes(m.better)) E(CFG, `${p}.better`, 'better must be "higher" or "lower"', '');
          if (m.format !== undefined && !['pct', 'int', 'number', 'km', 'min', 'db'].includes(m.format)) W(CFG, `${p}.format`, `unknown format "${m.format}"`, 'use "pct" for 0-1 scores');
          const missing = feats.filter((f) => f?.properties?.[m.key] === undefined).map((f) => f?.properties?.id);
          if (feats.length && missing.length === feats.length) E(CFG, `${p}.key`, `no ${c.layer} feature has "${m.key}"`, `run: uw enrich ${args._[0]} --layer ${c.layer} … (see enrich --help for metric names)`);
          else if (missing.length) W(CFG, `${p}.key`, `"${m.key}" missing on ${missing.length} ${c.layer} feature(s): ${missing.slice(0, 4).join(', ')}`, `re-run enrich for ${c.layer}`);
        });
      }
    }
  }
  if (cfg.plan !== undefined) {
    const days = cfg.plan?.days;
    // a day names a place no longer on the map (uw stay's picks took the place of the area the days started at)
    const replan = `the days name a place no longer on the map: plan them again, uw plan ${args._[0]} … --force`;
    if (!Array.isArray(days)) E(CFG, '$.plan.days', 'plan.days must be an array', '');
    else days.forEach((d, i) => {
      const p = `$.plan.days[${i}]`;
      if (!d?.title) W(CFG, `${p}.title`, 'day without title', 'add "title": "Day 1 · Arrive"');
      if (d?.focus !== undefined) ref(d.focus, CFG, `${p}.focus`, 'focus', replan);
      if (d?.route !== undefined && !byId.has(d.route)) E(CFG, `${p}.route`, `route "${d.route}" is not a layer id`, `make one: uw route ${args._[0]} --layer ${d.route} --from … --to …`);
      if (d?.time !== undefined && (!isNum(d.time) || d.time < 0 || d.time > 24)) E(CFG, `${p}.time`, 'time must be an hour 0-24', '');
      if (d?.time_hint !== undefined && typeof d.time_hint !== 'boolean') E(CFG, `${p}.time_hint`, 'time_hint must be true or false (true: the hour only sets the light, no clock time is shown)', '');
      if (d?.depart !== undefined && typeof d.depart !== 'boolean') E(CFG, `${p}.depart`, 'depart must be true or false (true: the day the traveller leaves; nothing is planned on it)', '');
      if (d?.note !== undefined && (typeof d.note !== 'string' || !d.note.trim() || d.note.length > 120))
        E(CFG, `${p}.note`, 'a day\'s note is one short line under its text (≤ 120 characters)', `uw set ${args._[0]} plan:day${i + 1} --note "…" (or --unset note)`);
      (Array.isArray(d?.items) ? d.items : []).forEach((it, j) => {
        if (it?.ref !== undefined) ref(it.ref, CFG, `${p}.items[${j}].ref`, 'item ref', replan);
        if (it?.url !== undefined && !(typeof it.url === 'string' && /^https:\/\/[^\s]+$/.test(it.url) && it.url.length <= 2000))
          E(CFG, `${p}.items[${j}].url`, 'item url must be an https:// link (the page the item\'s facts came from)', '"url": "https://…", "source": "Taiwan Tourism"');
        if (it?.source !== undefined && (typeof it.source !== 'string' || it.source.length > 40)) W(CFG, `${p}.items[${j}].source`, 'source should be a short name (≤ 40 characters), e.g. "Taroko National Park"', '');
        if (it?.note !== undefined && (typeof it.note !== 'string' || !it.note.trim() || it.note.length > 120)) E(CFG, `${p}.items[${j}].note`, 'note is one short line under the item\'s name (≤ 120 characters)', '"text": "Taroko visitor centre", "note": "ask about trail status"');
        if (it?.check !== undefined && (typeof it.check !== 'string' || !it.check.trim() || it.check.length > 80)) E(CFG, `${p}.items[${j}].check`, 'check is what is not checked about this item, in a few words (≤ 80 characters)', '"check": "which trails are open", "check_url": "https://…"');
        if (it?.check_url !== undefined && !(typeof it.check_url === 'string' && /^https:\/\/[^\s]+$/.test(it.check_url) && it.check_url.length <= 2000))
          E(CFG, `${p}.items[${j}].check_url`, 'check_url must be an https:// link (where to check it)', '"check_url": "https://www.taroko.gov.tw/"');
      });
      if (d?.items !== undefined && !Array.isArray(d.items)) E(CFG, `${p}.items`, 'items must be an array', '');
      // a day text is read on a phone: short, and only what a source page says (an item with a link that day)
      if (typeof d?.text === 'string' && d.text.length > 140) W(CFG, `${p}.text`, `day text is ${d.text.length} characters (≤ 140 reads on a phone)`, 'shorten it; details belong on the items\' pages');
      // a day with sourced places that still reads "Day in Porto; night 2 of 3" tells the traveller nothing
      if (typeof d?.text === 'string' && /^Day in .+; night \d+ of \d+\.$/.test(d.text.trim()) && Array.isArray(d.items) && d.items.some((it) => it?.ref && typeof it?.url === 'string' && !/^Base: /.test(String(it.text || ''))))
        W(CFG, `${p}.text`, 'day text is still "Day in …" although the day has sourced places', `say what the day is for from those places (uw plan ${args._[0]} … --sights sights,food --force writes it from them, or write it: ≤ 140 characters, nothing their pages do not say)`);
      if (typeof d?.text === 'string' && d.text.trim() && !isPlanSkeletonText(d.text) && !(Array.isArray(d.items) && d.items.some((it) => typeof it?.url === 'string')))
        W(CFG, `${p}.text`, 'day text with no sourced item that day: a reader cannot check it', `pin the place its page names (uw add-point ${args._[0]} --layer sights|food|daytrips … --props-file - with {"stop":…,"source_url":…}) and add it as a ref item, or cut the claim; never copy the text into an item`);
    });
    // a prose item (no ref) that repeats a day's text is a copy, and goes stale when that text is rewritten
    const norm = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const dayTexts = (Array.isArray(days) ? days : []).map((d) => norm(d?.text)).filter((t) => t.length >= 12);
    (Array.isArray(days) ? days : []).forEach((d, i) => (Array.isArray(d?.items) ? d.items : []).forEach((it, j) => {
      if (it?.ref !== undefined) return;
      const t = norm(it?.text);
      if (t.length < 12) return;
      const k = dayTexts.findIndex((x) => x === t || (x.length >= 24 && t.length >= 24 && (x.startsWith(t) || t.startsWith(x))));
      if (k < 0) return;
      const own = norm(d?.text) === dayTexts[k];
      W(CFG, `$.plan.days[${i}].items[${j}].text`, own ? 'item repeats its day\'s text' : 'item repeats the text of another day',
        'remove it, or pin the place it names (uw add-point … then a ref item); when you rewrite a day, rewrite or remove its items in the same edit');
    }));
    // a place far from its day's other places, or nearer another day's: the day zigzags across town
    if (Array.isArray(days)) {
      const find = (r) => (featuresByLayer.get(r.layer) || []).find((f) => String(f?.properties?.id) === r.id) || null;
      for (const w of dayPlaceWarnings(cfg.plan, find)) {
        W(CFG, `$.plan.days[${w.day}].items[${w.item}]`, `day places: ${dayPlaceLine(w, days)}`,
          `or rebuild the days: uw plan ${args._[0]} … --sights sights,food --force (groups each stop's places by area, each day a loop from the base)`);
      }
    }
    if (Array.isArray(days)) {
      const gaps = emptyPlanDays(cfg.plan);
      // a plan made with --sights is a trip about what to see each day: a full day with nothing sourced on it is not
      // finished, just as an expected stop that is not on the map is not (a 28 Oct drive replied with its days empty)
      const sightLayers = cfg.plan?.sights;
      if (sightLayers !== undefined && !(Array.isArray(sightLayers) && sightLayers.every((x) => typeof x === 'string')))
        E(CFG, '$.plan.sights', 'sights must be the layer ids uw plan --sights was given', 'rebuild: uw plan … --sights sights,food --force');
      // the turn has time to add or cite places: more than about 3 minutes left on its clock (none: no limit)
      const timeToAdd = turnLeftS == null || turnLeftS > REPLY_WITHIN_S;
      const plannedAt = Date.parse(cfg.plan?.planned_at ?? '');
      const plannedThisTurn = Number.isFinite(plannedAt) && (turnStartedMs == null || plannedAt >= turnStartedMs);
      // places, not pins (one place pinned twice is its own error above): each place of the plan's layers, as add-point
      // judges one place
      const sightFeats = Array.isArray(sightLayers) ? sightLayers.flatMap((lid) => (featuresByLayer.get(lid) || []).map((f) => ({ lid, f }))) : [];
      const sightPlace = placeIndex(sightFeats.map((x) => x.f));
      const ownPageFix = (ref) => `cite each place's own page (its own site, else its Wikipedia article): uw cite <that page> --grep "<its name>", then uw set ${args._[0]} ${ref} --props-file - with {"source_url":"<that page>","source":"<site>"}; it gives the place's item in the days that page too, so the days stay as they are`;
      const noTimeToCite = 'too little time is left to cite their own pages in this turn; the reply names these places as not checked on a page of their own';
      // each place's source is its own page: places that share one cite a city or listing page, which only says which
      // places are worth it (three sights once all cited one city guide page; two cited a routes page that named
      // neither, and the reply vouched for it). While the turn has time it fails, a later turn's too; its fix cites
      // each place's own page with uw set, which gives the place's items in the days that page too: no new plan, which
      // would group the days by area again and undo what the person moved. Places, not pins: one place pinned twice is
      // its own error below (its fix is not another page)
      const sharedPages = new Set();
      if (Array.isArray(sightLayers)) {
        const byPage = new Map();
        sightFeats.forEach(({ f }, i) => {
          const pr = f?.properties || {};
          const u = pr.source_url;
          if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) return;
          const page = u.replace(/#.*$/, '');
          if (!byPage.has(page)) byPage.set(page, new Map());
          if (!byPage.get(page).has(sightPlace[i])) byPage.get(page).set(sightPlace[i], String(pr.name_en || pr.name || pr.id));
        });
        for (const [page, places] of byPage) if (places.size > 1) {
          sharedPages.add(page);
          const names = [...places.values()];
          (timeToAdd ? E : W)(CFG, '$.plan.sights', `${names.length} places cite one page (${page}): ${names.slice(0, 4).join(', ')}${names.length > 4 ? ' …' : ''}. A page about a whole city or a list of places says which are worth it; it is not their source`,
            timeToAdd ? ownPageFix('<layer>:<id>') : noTimeToCite);
        }
      }
      // each sight's page names it, judged from what uw cite (or uw handoff's source check) read there in the last hours,
      // with no request: a park once cited an address that led to a photo, and two sights cited pages the turn never
      // read, while the reply vouched for them. A page read that does not name its place (or is not a page) fails while
      // the turn has time, in any turn; a page nobody read fails for a place whose source this turn set (source_set_at:
      // an earlier turn's pages were read hours ago, or on another machine, and a later turn that planned the days again
      // failed every sight it never touched). A page places share is the error above; with every cache off
      // (UW_NO_CACHE) nothing read is kept, so nothing is judged
      if (Array.isArray(sightLayers) && !cacheOff()) {
        const unread = [], unnamed = [];
        for (const lid of sightLayers) for (const f of featuresByLayer.get(lid) || []) {
          const pr = f?.properties || {};
          if (typeof pr.source_url !== 'string' || !/^https?:\/\//i.test(pr.source_url) || pr.id == null || sharedPages.has(pr.source_url.replace(/#.*$/, ''))) continue;
          const place = { ref: `${lid}:${pr.id}`, name: String(pr.name_en || pr.name || pr.id), url: pr.source_url, props: pr };
          const read = readPage(pr.source_url);
          if (!read) { if (sourceSetSince(pr, turnStartedMs)) unread.push(place); continue; }
          const miss = unnamedSource(pr, [], read);
          if (miss) unnamed.push({ ...place, miss });
        }
        const list = (xs, why) => `${xs.slice(0, 4).map((x) => `${x.name} (${x.ref}: ${x.url}${why(x)})`).join(', ')}${xs.length > 4 ? ' …' : ''}`;
        if (unnamed.length)
          (timeToAdd ? E : W)(CFG, '$.plan.sights', `${unnamed.length === 1 ? '1 place cites a page that does not name it' : `${unnamed.length} places cite a page that does not name them`}: ${list(unnamed, (x) => (x.miss.not_page ? ` is ${x.miss.not_page}, not a page` : ''))}`,
            timeToAdd ? ownPageFix(unnamed.length === 1 ? unnamed[0].ref : '<layer>:<id>') : noTimeToCite);
        if (unread.length) {
          const greps = unread.slice(0, 4).map((x) => `uw cite "${shellWord(x.url)}" --grep "${shellWord(namesPattern(x.props))}"`);
          (timeToAdd ? E : W)(CFG, '$.plan.sights', `${unread.length === 1 ? '1 place cites a page' : `${unread.length} places cite pages`} no uw cite read: ${list(unread, () => '')}`,
            timeToAdd ? `read ${unread.length === 1 ? 'it' : 'each'}: ${greps.join('; ')}${unread.length > 4 ? '; …' : ''}; then validate again: a page that names its place passes. A page that does not, or that cannot be read, is not its source: ${ownPageFix(unread.length === 1 ? unread[0].ref : '<layer>:<id>')}`
              : 'too little time is left to read their pages in this turn; the reply names these places as not checked on their page');
        }
      }
      // a place of those layers in no day, and not one the plan left out itself ("unplaced": no room, or far from every
      // stop), was pinned after the days were planned: a lookup still running then finished later (uw plan named it)
      if (Array.isArray(sightLayers) && sightLayers.length) {
        const key = (r) => (r && typeof r === 'object' && r.layer != null && r.id != null ? `${r.layer}:${r.id}` : null);
        const inDays = new Set(days.flatMap((d) => [key(d?.focus), ...(Array.isArray(d?.items) ? d.items : []).map((it) => key(it?.ref))]).filter(Boolean));
        const unplaced = new Set(Array.isArray(cfg.plan.unplaced) ? cfg.plan.unplaced.map(String) : []);
        const late = sightLayers.flatMap((id) => (featuresByLayer.get(id) || []).filter((f) => f?.properties?.id != null)
          .filter((f) => !inDays.has(`${id}:${f.properties.id}`) && !unplaced.has(`${id}:${f.properties.id}`)));
        if (late.length) {
          const names = late.map((f) => String(f.properties.name_en || f.properties.name || f.properties.id));
          E(CFG, '$.plan.days', `on the map but in no day of the plan: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ' …' : ''} (pinned after the days were planned)`,
            `uw plan ${args._[0]} … --sights ${sightLayers.join(',')} --force: the days take every place pinned (it names one that fits no day)`);
        }
      }
      const sightsAsked = Array.isArray(sightLayers) && sightLayers.length > 0;
      const bareDays = sightsAsked ? gaps.bare : [];
      // a full day takes 2-3 sourced places (reference/itinerary.md Phase B step 1), or one when the person asked for one
      // a day (uw plan --per-day 1). One is not a day worth following, so in the turn that planned the days it fails
      // while the clock leaves time to add places (three sights for three days once passed with a warning and almost 7
      // minutes left). A later turn keeps the days the person changed (a place moved or dropped), and a turn with too
      // little time left adds nothing: there it is a warning whose fix is what the reply says
      const oneDays = sightsAsked ? gaps.single : [];
      const days4 = (list) => `${list.slice(0, 4).join(', ')}${list.length > 4 ? ' …' : ''}`;
      const notPinned = 'a place the lookup cannot pin goes on its day as {"text": "<name>", "url": "<its page>", "source": "<site>"}';
      // the fix names the reader: uw cite on each place's own page, in this turn. "A page you read" named none, and a
      // turn asked for the browser instead (3 turns for one map), or cited a page a browser card had listed
      const citeOwn = 'each from its own page (its own site, else its Wikipedia article): uw cite <page> --grep "<its name>", never a browser card';
      const pinTo = `uw add-point ${args._[0]} --layer ${sightsAsked ? sightLayers[0] : 'sights'} … with {"stop":…,"source_url":…}`;
      // places pinned with no page count on no day: each gets its own page where it is
      const unsourced = sightsAsked ? sightLayers.flatMap((id) => (featuresByLayer.get(id) || []).filter((f) => !/^https?:\/\//i.test(String(f?.properties?.source_url ?? '')))).length : 0;
      const giveOwn = unsourced ? `; ${unsourced === 1 ? 'the place' : `the ${unsourced} places`} pinned with no page: uw set ${args._[0]} <layer>:<id> --props-file - with {"source_url":…,"source":…}` : '';
      if (bareDays.length)
        E(CFG, '$.plan.days', `${bareDays.length} of ${gaps.full} full days have nothing to see (no sourced place): ${days4(bareDays)}`,
          `uw plan ${args._[0]} … --sights ${sightLayers.join(',')} --force spreads the places already pinned over every day, the arrival day too: run it first when a stop has as many places as days. Else cite 2-3 places for each of those days in this turn, ${citeOwn}; then ${pinTo}${giveOwn} (reference/itinerary.md Phase B step 1), then run it; ${notPinned}`);
      if (oneDays.length && plannedThisTurn && timeToAdd)
        E(CFG, '$.plan.days', `${oneDays.length} of ${gaps.full} full days have one place to see (a full day takes 2-3 sourced places): ${days4(oneDays)}`,
          `cite one or two more places for each of those days in this turn, in that day's area, ${citeOwn}; then ${pinTo}, one place per command${giveOwn} (reference/itinerary.md Phase B step 1), then uw plan ${args._[0]} … --sights ${sightLayers.join(',')} --force; ${notPinned}. One a day only when the person asked for it: uw plan … --per-day 1`);
      else if (oneDays.length && !bareDays.length)
        W(CFG, '$.plan.days', `${oneDays.length} of ${gaps.full} full days have one place to see: ${days4(oneDays)}`,
          `${plannedThisTurn ? 'too little time is left to add places in this turn' : 'the days were planned in an earlier turn: keep what the person changed'}; the reply names these days and offers to add places to them`);
      else if (!sightsAsked && gaps.full >= 2 && gaps.empty * 2 > gaps.full)
        W(CFG, '$.plan.days', `${gaps.empty} of ${gaps.full} full days are still empty ("Day in …", or only the arrival): a traveller gets nothing to do on them`, 'add 2-3 sourced sights a full day (reference/itinerary.md Phase B step 1), then uw plan … --sights sights --force and one short sourced text per day');
      else if (!sightsAsked && gaps.full >= 2 && gaps.thin * 2 > gaps.full)
        W(CFG, '$.plan.days', `${gaps.thin} of ${gaps.full} full days have fewer than 2 sourced items: one sight a day is not a day worth following`, 'add sights until each full day has 2-3 with a source page (reference/itinerary.md Phase B step 1), then uw plan … --sights sights --force');
    }
  }
  // --- a trip: its stops with nights. A stop with nights on the map is a trip's, with "expect" or without it (a turn
  // that made its map without --expect had no check of its stays at all)
  const planDays = Array.isArray(cfg.plan?.days) ? cfg.plan.days : [];
  const staysBy = (lid) => uwByLayer.get(lid)?.cmd === 'stay' || isLodging({ layer: lid });
  const nightStops = [];
  for (const [lid, feats] of featuresByLayer) {
    if (staysBy(lid)) continue;
    for (const f of feats) {
      const pr = f?.properties || {};
      if (Number.isInteger(pr.nights) && pr.nights >= 1 && pr.id != null) nightStops.push({ lid, pr, name: String(pr.name_en || pr.name || pr.id), nights: pr.nights });
    }
  }
  const nightLayers = new Set(nightStops.map((s) => s.lid));
  // where a trip's places to stay are: a layer uw stay wrote or named for them, or one the days start at
  const stayLayers = [...featuresByLayer.keys()].filter((lid) => !nightLayers.has(lid) && (staysBy(lid) || planDays.some((d) => d?.focus?.layer === lid)));

  // --- expect: the trip's stops (each with its nights) are all on the map, and in the plan
  if (cfg.expect !== undefined && !Array.isArray(cfg.expect)) E(CFG, '$.expect', 'expect must be an array of { "name", "nights" }', 'uw handoff --apply writes it; or uw new … --expect "Porto:3,Lisbon:4"');
  const expected = mergeExpect(expectOf(cfg), askedStops);
  if (!expected.length && nightStops.length && !planDays.length) {
    E(CFG, '$.plan', `a trip (${describeItems(nightStops)}) with no plan: its days go in the plan, which the map shows as its own tab, not in place notes`,
      `follow reference/itinerary.md ("One base" for days in one place): places to stay (uw stay), 2-3 sourced places a day grouped by area, then uw plan ${args._[0]} --stops … --ids … --nights … --stays stays --sights sights`);
  }
  if (expected.length) {
    const gaps = uncovered(cfg, featuresByLayer, expected);
    const off = gaps.filter((g) => !g.on_map), unplanned = gaps.filter((g) => g.on_map && g.in_plan === false);
    if (off.length) E(CFG, '$.expect', `asked for but not on the map: ${describeItems(off)} (${expected.length - off.length} of ${expected.length} stops on the map)`,
      `place each one (uw station … --city "<name>" --country "<country>" --nights N; days in one place: reference/itinerary.md "One base"; a lookup that timed out: run its retry command), then uw plan … --force; if none can be placed this turn, the reply says plainly which are missing and why`);
    if (unplanned.length) E(CFG, '$.plan.days', `on the map but in no day of the plan: ${describeItems(unplanned)}`, 'rebuild the plan with every stop: uw plan … --ids <all stop ids in travel order> --nights … --force');
    // nights asked for are a trip: its days are the plan (the map's Plan tab), never a day's text inside a place's note
    if (!(Array.isArray(cfg.plan?.days) && cfg.plan.days.length))
      E(CFG, '$.plan', `a trip (${describeItems(expected)}) with no plan: its days go in the plan, which the map shows as its own tab, not in place notes`,
        `follow reference/itinerary.md ("One base" for days in one place): places to stay (uw stay), 2-3 sourced places a day grouped by area, then uw plan ${args._[0]} --stops … --ids … --nights … --stays stays --sights sights`);
  }
  // --- a trip's places to stay (reference/several-stops.md step 3, itinerary.md "One base" step 2). A Seville map had
  // only its area pinned to stay in, with a note no page had said, written before the turn read any page; uw stay never
  // ran, and the reply called the area the recommendation. Each stop with nights has places to stay; an area pinned as
  // the place to stay stands in only once uw stay looked there and found none (uw stay keeps where it looked:
  // lib/stays.mjs), and its note says why only from a page uw cite read that names it. Both fail in the turn that built
  // the stop or its stays, while the clock leaves time to look; a later turn (a note to a day, a sight added and the
  // days planned again) is warned, and keeps what the map has
  if (nightStops.length) {
    const thisTurn = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) && (turnStartedMs == null || t >= turnStartedMs); };
    const builtNow = turnStartedMs == null || [...nightLayers, ...stayLayers].some((lid) => thisTurn(uwByLayer.get(lid)?.updated_at));
    const level = builtNow && (turnLeftS == null || turnLeftS > REPLY_WITHIN_S) ? E : W;
    const looked = staysLookedUp(dir);
    const site = args._[0];
    // what the reply says when uw stay found no place to stay (exit 2 at its widest), or could not look (exit 4)
    const noneFound = `None found within ${STAY_RADIUS_MAX} m (exit 2): the area is the recommendation, its note from a page you read, and the reply says no place to stay was found near it. `
      + 'Exit 4 (the search was busy): the reply says places to stay were not looked up yet';
    for (const s of nightStops) {
      if (stopIsAStay(s.pr)) continue;
      const id = String(s.pr.id);
      const mine = stayLayers.flatMap((sl) => (featuresByLayer.get(sl) || []).filter((f) => f?.properties?.id != null
        && (f.properties.stop != null ? String(f.properties.stop) === id : nightStops.length === 1)).map((f) => ({ sl, pr: f.properties })));
      // a place to stay is lodging, or what uw stay found: an area, a square or a landmark only says where to stay
      if (mine.some((x) => isPlaceToStay(x.pr)) || lookedAsFarAsItGoes(looked[id])) continue;
      const areas = mine.map((x) => ({ sl: x.sl, ref: `${x.sl}:${x.pr.id}`, name: String(x.pr.name_en || x.pr.name || x.pr.id) }));
      // one stop: days in one place, its stays in the area to stay in ("One base" step 2); a trip's stop: by its point
      const oneBase = nightStops.length === 1 && !(s.pr.kind === 'train_station' || s.pr.station_of);
      const layerArg = areas.length && areas[0].sl !== 'stays' ? ` --layer ${areas[0].sl}` : '';
      // uw stay looked and found none, short of its widest radius: the same lookup, wider, as it printed
      const wider = looked[id]?.status === 'none' && typeof looked[id].widen === 'string' ? looked[id].widen : null;
      const look = wider ? `${wider} (the same lookup, wider)`
        : areas.length ? `uw stay ${site} --near ${areas[0].ref} --stop ${id} --kinds hotel${layerArg}`
          : !oneBase ? `uw stay ${site} --near ${s.lid}:${id} --kinds hotel`
            : `uw geocode "<the area a page you read recommends>, ${s.name}", then uw stay ${site} --near <its lng,lat> --near-label "<that area>" --stop ${id} --kinds hotel`;
      // none at all is warned (a person may have a place of their own); an area pinned instead of looking fails
      (areas.length ? level : W)(byId.get(s.lid)?.data || CFG, `$.features[?(@.properties.id=="${id}")]`,
        `places to stay: ${s.name} (${s.nights} night${s.nights === 1 ? '' : 's'}) has ${areas.length ? `only the area${areas.length > 1 ? 's' : ''} ${areas.map((a) => a.name).join(', ')} to stay in` : 'none'}, and uw stay ${wider ? `found none within ${looked[id].radius} m of it` : 'has not looked for any there'}`,
        `${look}${wider ? '' : ` (hotels unless the person asked for hostels; ${oneBase ? 'reference/itinerary.md "One base" step 2' : 'reference/several-stops.md step 3'})`}, then uw plan ${site} … --stays ${areas[0]?.sl || 'stays'} --force: each day starts at the first stay. ${noneFound}`);
    }
    // an area pinned as the place to stay says why only from a page uw cite read that names it
    for (const sl of stayLayers) for (const f of featuresByLayer.get(sl) || []) {
      const pr = f?.properties || {};
      const key = ['note', 'why'].find((k) => typeof pr[k] === 'string' && pr[k].trim());
      if (!isAreaPin(pr) || pr.id == null || !key) continue;
      const ref = `${sl}:${pr.id}`, name = String(pr.name_en || pr.name || pr.id);
      let problem = null;
      if (typeof pr.source_url !== 'string' || !/^https?:\/\//i.test(pr.source_url)) problem = 'cites no page';
      else if (!cacheOff()) {
        const read = readPage(pr.source_url);
        const miss = read ? unnamedSource(pr, [], read) : null;
        if (!read && sourceSetSince(pr, turnStartedMs)) problem = `cites a page no uw cite read (${pr.source_url})`;
        else if (miss) problem = miss.not_page ? `cites ${miss.not_page} (${pr.source_url}), not a page` : `cites a page that does not name it (${pr.source_url})`;
      }
      if (!problem) continue;
      // the reply says what uw stay found for the area's stop, never "not looked up" after it looked
      const rec = looked[String(pr.stop ?? (nightStops.length === 1 ? nightStops[0].pr.id : ''))];
      const says = rec?.status === 'found' ? ''
        : rec?.status === 'none' ? `, and the reply says no place to stay was found within ${rec.radius} m of ${rec.near || name}`
          : `, and the reply says places to stay were not looked up yet${rec?.status === 'unavailable' ? ' (the search was busy)' : ''}`;
      level(byId.get(sl)?.data || CFG, `$.features[?(@.properties.id=="${pr.id}")].properties.${key}`,
        `the area ${name} (${ref}) says why to stay there ("${String(pr[key]).trim().slice(0, 80)}") but ${problem}`,
        `read the page that says it: uw cite <that page> --grep "${shellWord(name)}", then uw set ${site} ${ref} --props-file - with {"source_url":"<that page>","source":"<site>"}; no such page: uw set ${site} ${ref} --unset ${key}${says}`);
    }
  }
  // --- a "Not found yet" entry for a place that is on the map after all: the page would say it is missing while it
  // shows it (r11: a stop placed on handoff --apply's second try kept the entry its first pass wrote)
  if (Array.isArray(cfg.missing)) {
    const stale = cfg.missing.filter((m) => m && typeof m.name === 'string' && (featuresByLayer.get(m.layer) || [])
      .some((f) => (m.id && String(f?.properties?.id) === String(m.id)) || featureNames(f?.properties, m.name)));
    if (stale.length) E(CFG, '$.missing', `listed as not found yet but on the map: ${stale.map((m) => m.name).join(', ')}`,
      `remove ${stale.length > 1 ? 'these entries' : 'the entry'} from "missing" in ${CFG} (the page shows that list as "Not found yet")`);
  }

  if (cfg.notes !== undefined) {
    if (!Array.isArray(cfg.notes)) E(CFG, '$.notes', 'notes must be an array', '');
    else cfg.notes.forEach((n, i) => {
      const p = `$.notes[${i}]`;
      if (!n?.text) W(CFG, `${p}.text`, 'note without text', '');
      else if (String(n.text).length > 70) W(CFG, `${p}.text`, `note is ${String(n.text).length} characters: bubbles show 2 short lines (~50 characters), the rest only when tapped`, 'shorten it; put the detail in the feature\'s "note" (shown on its card)');
      if (Array.isArray(n?.at)) {
        if (!isLngLat(n.at) || (n.at[0] === 0 && n.at[1] === 0)) {
          const swapped = isLngLat([n.at[1], n.at[0]]) && Math.abs(n.at[0]) <= 90;
          E(CFG, `${p}.at`, `at ${JSON.stringify(n.at)} is not a valid [lng, lat]${swapped ? ' (it looks like [lat, lng])' : ''}`, swapped ? `swap to [${n.at[1]}, ${n.at[0]}], or better use a ref { "layer", "id" }` : 'use a ref { "layer", "id" } or coordinates from a script');
        }
        else if (bounds && !nearBounds(n.at, bounds, 0.5)) E(CFG, `${p}.at`, `note position ${JSON.stringify(n.at)} is far outside view.bounds`, 'check lng/lat order; use a ref to a feature instead');
      } else ref(n?.at, CFG, `${p}.at`, 'note at');
      if (n?.time !== undefined && !(Array.isArray(n.time) && n.time.length === 2 && n.time.every(isNum))) E(CFG, `${p}.time`, 'time must be [fromHour, toHour]', '');
    });
  }
  if (cfg.votes !== undefined) {
    if (typeof cfg.votes !== 'object' || Array.isArray(cfg.votes)) E(CFG, '$.votes', 'votes must be an object keyed by feature id', '{ "via-loft": { "up": ["Kim"], "down": [] } }');
    else {
      const allIds = new Set([...featuresByLayer.values()].flat().map((f) => String(f?.properties?.id)));
      for (const [k, val] of Object.entries(cfg.votes)) {
        if (!allIds.has(k)) W(CFG, `$.votes.${k}`, `no feature has id "${k}"`, 'use a feature id from a layer');
        for (const s of ['up', 'down']) if (val?.[s] !== undefined && !(Array.isArray(val[s]) && val[s].every((x) => typeof x === 'string'))) E(CFG, `$.votes.${k}.${s}`, `${s} must be an array of names`, '');
      }
    }
  }
  if (cfg.attribution !== undefined && !(Array.isArray(cfg.attribution) && cfg.attribution.every((x) => typeof x === 'string')))
    E(CFG, '$.attribution', 'attribution must be an array of strings', '["Air: Open-Meteo / CAMS"]');

  // --- v0.2: question, verdict, tiers, links, photos, bind, metrics, records, bound.json, OGDL, S5-S7
  // the engine's own ranking (letters follow the answer: V7)
  let Question = null;
  try { ({ Question } = await import(pathToFileURL(path.join(STARTER_DIR, 'engine', 'question.js')).href)); } catch { /* checked without ranking */ }
  // raw coordinates in text people read ("4 min walk to 121.60681,23.98207"): name the place instead
  const COORD_TEXT = /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/;
  const READ_PROPS = ['name', 'name_en', 'why', 'note', 'label', 'title', 'walk_to', 'summary'];
  for (const [layerId, fs2] of featuresByLayer) {
    const hit = fs2.find((f) => READ_PROPS.some((k) => typeof f?.properties?.[k] === 'string' && COORD_TEXT.test(f.properties[k])));
    if (hit) {
      const k = READ_PROPS.find((x) => typeof hit.properties[x] === 'string' && COORD_TEXT.test(hit.properties[x]));
      W(byId.get(layerId)?.data || CFG, `$.features[?(@.properties.id=="${hit.properties.id}")].properties.${k}`, `"${String(hit.properties[k]).slice(0, 80)}" shows raw coordinates to the reader`, 'name the place instead (uw stay --near-label "the centre of <City>", or uw set … --props)');
    }
  }
  if (Array.isArray(cfg.plan?.days)) cfg.plan.days.forEach((d, i) => {
    for (const k of ['title', 'text']) if (typeof d?.[k] === 'string' && COORD_TEXT.test(d[k])) W(CFG, `$.plan.days[${i}].${k}`, 'shows raw coordinates to the reader', 'name the place instead');
  });
  try { checkV2({ dir, cfg, byId, featuresByLayer, E, W, args, CFG, Question }); }
  catch (e) { E(CFG, '', `v0.2 checks crashed: ${e.message}`, 'report this; the rest of the checks ran'); }

  // --- colour identity: option letters stay unique (vs each other and vs other layers' colours)
  try { checkLetterColors({ cfg, featuresByLayer, W, CFG }); } catch (e) { W(CFG, '', `colour check skipped: ${e.message}`, ''); }

  // --- custom.js
  if (cfg.custom !== undefined && cfg.custom !== null && cfg.custom !== false) {
    if (typeof cfg.custom !== 'string' || !local(cfg.custom) || !inside(cfg.custom)) E(CFG, '$.custom', 'custom must be a relative path like "custom.js"', '');
    else {
      const cp = path.join(dir, cfg.custom);
      if (!exists(cp)) E(CFG, '$.custom', `"${cfg.custom}" not found`, 'create it (export default function setup(uw) { … }) or remove "custom"');
      else {
        const src = fs.readFileSync(cp, 'utf8');
        const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uw-check-')), 'custom.mjs');
        fs.writeFileSync(tmp, src);
        const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
        try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch {}
        if (r.status !== 0) {
          const msg = (r.stderr || '').split('\n').filter((x) => x.trim() && !x.includes('node:internal') && !/^\s+at /.test(x) && !/^Node\.js v/.test(x)).map((x) => x.replace(/\S*custom\.mjs/g, cfg.custom)).slice(0, 5).join(' | ');
          E(cfg.custom, '', `syntax error: ${msg}`, 'fix the JavaScript (it is loaded as an ES module)');
        } else if (!/export\s+default/.test(src)) E(cfg.custom, '', 'no "export default" function', 'export default function setup(uw) { … }');
        if (/engine\/|__uw|document\.body\.innerHTML\s*=/.test(src)) W(cfg.custom, '', 'custom.js reaches into engine internals', 'use the uw API (uw.map, uw.on, uw.ui.addButton …) so upgrades do not break it');
      }
    }
  }

  // --- kit files
  const enginePath = path.join(dir, 'engine', 'engine.js');
  if (!exists(enginePath)) E('engine/engine.js', '', 'engine is missing', `run: uw upgrade ${args._[0]}`);
  for (const f of ['engine/engine.css', 'engine/vendor/maplibre-gl.js', 'engine/vendor/maplibre-gl.css']) if (exists(enginePath) && !exists(path.join(dir, f))) E(f, '', 'missing kit file', `run: uw upgrade ${args._[0]}`);
  const ip = path.join(dir, 'index.html');
  if (!exists(ip)) E('index.html', '', 'missing', 'copy index.html from the starter');
  else {
    const html = fs.readFileSync(ip, 'utf8');
    if (!/engine\/engine\.js/.test(html)) E('index.html', '', 'does not load engine/engine.js', 'restore index.html from the starter');
    if (/(src|href)=["']\/(?!\/)/.test(html)) W('index.html', '', 'uses absolute paths ("/…")', 'use relative paths so the site works under a sub-path or in an iframe');
    if (!/viewport-fit=cover/.test(html)) W('index.html', '', 'viewport meta lacks viewport-fit=cover', 'restore the starter viewport meta');
  }

  // --- size budget
  const total = dirSize(dir, new Set(['.uwcache', 'snapshots', '.git', 'node_modules']));
  if (dataBytes > 8 * 1024 * 1024) W('data/', '', `layer data totals ${fmtBytes(dataBytes)} (> 8 MB)`, 'phones on mobile data will be slow; trim layers');
  if (total > 50 * 1024 * 1024) E('.', '', `site is ${fmtBytes(total)} (> 50 MB)`, 'remove unused files');
  else if (total > 20 * 1024 * 1024) W('.', '', `site is ${fmtBytes(total)} (> 20 MB)`, 'remove unused files');
  const ifOk = !exists(path.join(dir, '.gitignore')) || !/\.uwcache/.test(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'));
  if (exists(path.join(dir, '.uwcache')) && ifOk) W('.gitignore', '', '.uwcache/ is not ignored', 'add ".uwcache/" to .gitignore');
  return finish();

  // ---------------------------------------------------------------------------
  function checkFC(l, fc, file, base) {
    if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) { E(file, base, 'not a GeoJSON FeatureCollection', 'regenerate it with the script that made it'); return; }
    featuresByLayer.set(l.id, fc.features);
    if (fc.uw && typeof fc.uw === 'object') uwByLayer.set(l.id, fc.uw);
    if (fc.uw?.cmd === 'add-point') pinLayers.add(l.id);
    if (!fc.features.length) W(file, `${base}.features`, `layer "${l.id}" is empty`, 'check the query/area, or hide the layer');
    const okGeom = GEOM_OK[l.type] || [];
    const ids = new Map();
    let reported = 0;
    const lim = (fn) => { if (reported < 8) { fn(); reported++; } else if (reported === 8) { reported++; W(file, base, 'more problems in this file not shown', 'fix the ones above and re-run'); } };
    let outside = 0, farOutside = 0, precise = 0, firstFar = null;
    fc.features.forEach((f, k) => {
      const p = `${base}.features[${k}]`;
      if (!f || f.type !== 'Feature') { lim(() => E(file, p, 'not a Feature', '')); return; }
      if (!f.geometry) { lim(() => E(file, `${p}.geometry`, 'missing geometry', 'remove the feature or regenerate the file')); return; }
      if (okGeom.length && !okGeom.includes(f.geometry.type)) lim(() => E(file, `${p}.geometry.type`, `${f.geometry.type} in a "${l.type}" layer (expects ${okGeom.join('/')})`, `change the layer type in ${CFG} or use the right file`));
      const props = f.properties || {};
      if (props.id === undefined || props.id === null || props.id === '') lim(() => E(file, `${p}.properties.id`, 'feature without id', 'every feature needs a unique properties.id (scripts add them)'));
      else {
        const id = String(props.id);
        if (ids.has(id)) lim(() => E(file, `${p}.properties.id`, `duplicate id "${id}" (also features[${ids.get(id)}])`, 'ids must be unique within a file'));
        else ids.set(id, k);
        if (/[,:#&=\s]/.test(id)) lim(() => W(file, `${p}.properties.id`, `id "${id}" contains , : # & = or spaces`, 'ids appear in the URL hash and refs; use a slug like via-loft'));
      }
      if ((props.name === undefined || props.name === '') && l.type !== 'grid') lim(() => W(file, `${p}.properties.name`, 'feature without name', 'add properties.name (shown in lists and cards)'));
      // coordinates
      let bad = false;
      walk(f.geometry, (c) => {
        if (bad) return;
        if (!Array.isArray(c) || !isNum(c[0]) || !isNum(c[1]) || Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) { bad = true; lim(() => E(file, `${p}.geometry.coordinates`, `invalid coordinate ${JSON.stringify(c)}`, 'coordinates are [lng, lat] numbers')); return; }
        if (c[0] === 0 && c[1] === 0) { bad = true; lim(() => E(file, `${p}.geometry.coordinates`, 'coordinate is [0, 0]', 'a lookup failed; re-run the script for this feature')); return; }
        if (precise < 1 && (dec(c[0]) > 6 || dec(c[1]) > 6)) precise++;
      });
      if (bad || !bounds) return;
      const pts = []; walk(f.geometry, (c) => pts.push(c));
      const isPoint = /Point/.test(f.geometry.type);
      if (isPoint) {
        const c = pts[0];
        if (!nearBounds(c, bounds, 0)) { outside++; if (!nearBounds(c, bounds, 1)) { farOutside++; firstFar ??= { k, id: props.id, c }; } }
      } else if (!pts.some((c) => nearBounds(c, bounds, 0.5))) { outside++; if (l.type !== 'legs') { farOutside++; firstFar ??= { k, id: props.id, c: pts[0] }; } }
    });
    if (precise) W(file, base, 'coordinates have more than 6 decimals', 'round to 6 decimals (scripts do this)');
    if (farOutside) {
      // hand-picked points far away are almost always a wrong match; context layers (places, wiki, lines) just reach past the first view
      const handPicked = fc.uw?.cmd === 'add-point' || (!fc.uw && fc.features.length <= 20);
      const msg = `${farOutside} feature(s) are far outside view.bounds, e.g. features[${firstFar.k}] "${firstFar.id}" at ${JSON.stringify(firstFar.c)}`;
      if (handPicked && (l.type === 'points' || l.type === 'heat'))
        E(file, `${base}.features[${firstFar.k}]`, msg, 'likely a wrong geocode match or swapped lng/lat: re-run add-point with --near/--pick, remove it (uw.mjs set <site> <layer>:<id> --remove), or run fit if it is intended');
      else if (handPicked || !fc.uw) W(file, `${base}.features[${firstFar.k}]`, msg, 'check it, or run fit');
      else if (farOutside > fc.features.length / 2) W(file, base, `most of this ${fc.uw.cmd} layer lies outside the first view`, `fine if intended (context); otherwise re-fetch it for the area of the map`);
    }
    // context layers (places around an area, lines, grids) naturally spill past the initial view; only hand-picked data matters
    const picked = ['add-point', 'route', 'legs'].includes(fc.uw?.cmd) || (!fc.uw && !l.cluster && fc.features.length <= 20);
    if (picked && outside - farOutside > 0) W(file, base, `${outside - farOutside} feature(s) lie outside view.bounds (but close)`, `run: uw fit ${args._[0]} (frames the hand-picked layers), or widen view.bounds`);
  }
}

/** Text inside a double-quoted shell word. */
const shellWord = (s) => String(s).replace(/(["\\$`])/g, '\\$1');
/** uw cite's --grep for any of a place's names ("Maria Luisa Park|Parque de María Luisa"). */
function namesPattern(p) {
  const names = [...new Set([p?.name_en, p?.name, p?.looked_up_as].filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim()))];
  return names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || String(p?.id ?? '');
}

function suggestCmd(l) {
  if (l.role === 'verdict') return 'areas';
  return { points: 'places', heat: 'places', lines: 'lines', route: 'route', areas: 'isochrone', grid: 'feel', legs: 'legs' }[l.type] || 'places';
}
function walk(g, fn) {
  if (!g) return;
  if (g.type === 'GeometryCollection') { (g.geometries || []).forEach((x) => walk(x, fn)); return; }
  const rec = (c) => { if (Array.isArray(c) && c.length && Array.isArray(c[0])) c.forEach(rec); else fn(c); };
  rec(g.coordinates);
}
function dec(n) { const s = String(n); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; }
function nearBounds(c, b, marginFrac) {
  const mx = Math.max((b[2] - b[0]) * marginFrac, marginFrac ? 0.02 : 0), my = Math.max((b[3] - b[1]) * marginFrac, marginFrac ? 0.02 : 0);
  return c[0] >= b[0] - mx && c[0] <= b[2] + mx && c[1] >= b[1] - my && c[1] <= b[3] + my;
}
function dirSize(d, skip) {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) n += dirSize(p, skip); else if (e.isFile()) n += fs.statSync(p).size;
  }
  return n;
}

function report(out, args, dir, errors, warnings) {
  const fail = errors.length > 0 || (args.strict && warnings.length > 0);
  if (out.json) {
    process.stdout.write(JSON.stringify({ ok: !fail, errors, warnings }, null, 2) + '\n');
  } else {
    const line = (m) => `${m.level === 'error' ? 'ERROR' : 'warn '} ${m.file}${m.path ? ' ' + m.path : ''}: ${m.message}${m.fix ? `\n      fix: ${m.fix}` : ''}`;
    for (const m of errors) console.log(line(m));
    for (const m of warnings) console.log(line(m));
    console.log(fail ? `✗ ${errors.length} error(s), ${warnings.length} warning(s). Fix the errors and run validate again.`
      : `✓ ${path.basename(dir)} is valid${warnings.length ? ` (${warnings.length} warning(s))` : ''}.`);
  }
  return fail ? 1 : 0;
}
