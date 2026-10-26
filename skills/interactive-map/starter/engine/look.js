// map-pack engine: basemap look — label language, overrides, day/dusk/night, terrain + 3D.
// Kit-owned file: sites should not edit it.
import { parseColor, mix, mapColors, clamp, prefersDark } from './util.js';

// ---------- labels ----------
function labelExpr(mode, sep) {
  // English where OSM has it, otherwise the local name (automatic romanisations such as POJ read oddly for travellers).
  const en = ['coalesce', ['get', 'name:en'], ['get', 'name'], ['get', 'name_int']];
  if (mode === 'local') return ['coalesce', ['get', 'name'], ['get', 'name_int']];
  if (mode === 'both') {
    return ['case',
      ['all', ['has', 'name:en'], ['!=', ['get', 'name:en'], ['get', 'name']]], ['concat', ['get', 'name:en'], sep, ['get', 'name']],
      ['coalesce', ['get', 'name'], ['get', 'name_int']]];
  }
  return en;
}

export function applyLabels(map, mode = 'en') {
  if (!['en', 'local', 'both'].includes(mode)) { console.warn(`[map] basemap.labels "${mode}" unknown; use en | local | both`); mode = 'en'; }
  for (const l of map.getStyle().layers) {
    if (l.type !== 'symbol' || l.id.startsWith('uw-')) continue;
    const tf = map.getLayoutProperty(l.id, 'text-field');
    if (!tf || !JSON.stringify(tf).includes('"name')) continue;
    const sep = map.getLayoutProperty(l.id, 'symbol-placement') === 'line' ? '  ' : '\n';
    map.setLayoutProperty(l.id, 'text-field', labelExpr(mode, sep));
  }
}

// ---------- overrides ----------
const KEYWORDS = {
  rail: (l) => /rail/.test(l.id) && l.type === 'line',
  railways: (l) => KEYWORDS.rail(l),
  water: (l) => /^water/.test(l.id) && l.type !== 'symbol',
  roads: (l) => /^(road|bridge|tunnel)_/.test(l.id) && l.type === 'line' && !/rail|hatching/.test(l.id),
  buildings: (l) => /^building/.test(l.id),
  parks: (l) => /^(park|landcover_(wood|grass|wetland)|landuse_(pitch|cemetery))/.test(l.id),
  green: (l) => KEYWORDS.parks(l),
  labels: (l) => l.type === 'symbol',
  pois: (l) => /^poi/.test(l.id),
  boundaries: (l) => /^boundary/.test(l.id),
  landuse: (l) => /^(landuse|landcover)/.test(l.id),
  background: (l) => l.type === 'background',
};
const PREFIX = { fill: ['fill-'], line: ['line-'], symbol: ['text-', 'icon-'], circle: ['circle-'], 'fill-extrusion': ['fill-extrusion-'],
  background: ['background-'], raster: ['raster-'], hillshade: ['hillshade-'], heatmap: ['heatmap-'] };
const SHORT = {
  color: { fill: 'fill-color', line: 'line-color', symbol: 'text-color', circle: 'circle-color', 'fill-extrusion': 'fill-extrusion-color', background: 'background-color' },
  opacity: { fill: 'fill-opacity', line: 'line-opacity', symbol: 'text-opacity', circle: 'circle-opacity', 'fill-extrusion': 'fill-extrusion-opacity', background: 'background-opacity', raster: 'raster-opacity' },
  width: { line: 'line-width' },
};
const fits = (type, prop) => (PREFIX[type] || []).some((p) => prop.startsWith(p) && !(type === 'fill' && prop.startsWith('fill-extrusion')));

function matcher(sel) {
  const list = Array.isArray(sel) ? sel : [sel];
  const fns = list.map((s) => {
    if (typeof s !== 'string') return () => false;
    if (KEYWORDS[s]) return KEYWORDS[s];
    try { const re = new RegExp(s); return (l) => re.test(l.id); } catch { console.warn(`[map] override "${s}" is not a keyword or valid regex`); return () => false; }
  });
  return (l) => fns.some((f) => f(l));
}

/** Returns a Set of "layerId|prop" that overrides own (theming leaves them alone). */
export function applyOverrides(map, overrides) {
  const owned = new Set();
  if (!Array.isArray(overrides)) return owned;
  for (const o of overrides) {
    if (!o || !o.layers) { console.warn('[map] basemap.overrides entry needs "layers"', o); continue; }
    const match = matcher(o.layers);
    const targets = map.getStyle().layers.filter((l) => !l.id.startsWith('uw-') && match(l));
    if (!targets.length) { console.warn(`[map] override ${JSON.stringify(o.layers)} matched no basemap layer`); continue; }
    for (const l of targets) {
      const paint = { ...(o.paint || {}) };
      for (const k of Object.keys(SHORT)) if (o[k] != null && SHORT[k][l.type]) paint[SHORT[k][l.type]] = o[k];
      for (const [k, v] of Object.entries(paint)) {
        const prop = SHORT[k] ? SHORT[k][l.type] : k;
        if (!prop || !fits(l.type, prop)) continue;
        try { map.setPaintProperty(l.id, prop, v); owned.add(l.id + '|' + prop); } catch (e) { console.warn(`[map] override ${l.id} ${prop}:`, e.message); }
      }
      for (const [k, v] of Object.entries(o.layout || {})) {
        try { map.setLayoutProperty(l.id, k, v); } catch (e) { console.warn(`[map] override layout ${l.id} ${k}:`, e.message); }
      }
      if (o.visible === false) map.setLayoutProperty(l.id, 'visibility', 'none');
      if (o.visible === true) map.setLayoutProperty(l.id, 'visibility', 'visible');
      if (o.filter) { try { map.setFilter(l.id, o.filter); } catch (e) { console.warn(`[map] override filter ${l.id}:`, e.message); } }
    }
  }
  return owned;
}

// ---------- day / dusk / night ----------
const NIGHT = {
  bg: '#0d1322', water: '#0c2341', waterLine: '#163a63', green: '#10251f', land: '#131a2a', building: '#1d2535', building3d: '#252f43',
  road: '#2a3447', major: '#3a465e', motorway: '#58492f', casing: '#0a0f1c', rail: '#4b5568', boundary: '#5b6781',
  text: '#d3dbe8', halo: '#0d1322', aero: '#1a2233',
};
let DUSK = parseColor('#ff9757'), DUSK_WATER = parseColor('#8a6fd6');
// how far night water moves to its target (the rest is the day water's blue showing through)
const WATER_MIX = { fill: 0.92, line: 0.9 };
const SKY = { day: '#7cc0f5', night: '#0a1024' };
/**
 * Swap the night / dusk / sky colours (theme.js reads them from the --uw-night-* tokens). Call before a Look is built.
 * Unknown keys and unparsable colours are ignored, so a partial palette keeps the rest.
 */
export function setLookPalette(p = {}) {
  for (const k of Object.keys(NIGHT)) if (typeof p[k] === 'string' && parseColor(p[k])) NIGHT[k] = p[k];
  if (typeof p.dusk === 'string' && parseColor(p.dusk)) DUSK = parseColor(p.dusk);
  if (typeof p.duskWater === 'string' && parseColor(p.duskWater)) DUSK_WATER = parseColor(p.duskWater);
  if (typeof p.daySky === 'string' && parseColor(p.daySky)) SKY.day = p.daySky;
  if (typeof p.nightSky === 'string' && parseColor(p.nightSky)) SKY.night = p.nightSky;
  const wm = Number(p.waterMix);
  if (p.waterMix != null && p.waterMix !== '' && Number.isFinite(wm) && wm >= 0 && wm <= 1) WATER_MIX.fill = WATER_MIX.line = wm;
}
/** The night halo / casing colours, for overlay layers that pair a day colour with a night one. */
export const nightInk = () => ({ halo: NIGHT.halo, casing: NIGHT.casing });

function targetFor(l, prop) {
  const id = l.id;
  if (l.type === 'background') return [NIGHT.bg, 0.95];
  if (prop === 'text-color') return [NIGHT.text, 0.95];
  if (prop === 'text-halo-color') return [NIGHT.halo, 0.95];
  if (l.type === 'fill-extrusion') return [NIGHT.building3d, 0.9];
  if (l.type === 'fill') {
    if (/^water/.test(id)) return [NIGHT.water, WATER_MIX.fill];
    if (/^building/.test(id)) return [NIGHT.building, 0.9];
    if (/^(park|landcover_(wood|grass|wetland))/.test(id)) return [NIGHT.green, 0.9];
    if (/^aeroway|road_area/.test(id)) return [NIGHT.aero, 0.9];
    return [NIGHT.land, 0.9];
  }
  if (l.type === 'line') {
    if (/^water/.test(id)) return [NIGHT.waterLine, WATER_MIX.line];
    if (/casing/.test(id)) return [NIGHT.casing, 0.9];
    if (/rail/.test(id)) return [NIGHT.rail, 0.85];
    if (/^boundary/.test(id)) return [NIGHT.boundary, 0.7];
    if (/motorway/.test(id)) return [NIGHT.motorway, 0.85];
    if (/trunk|primary|secondary|tertiary/.test(id)) return [NIGHT.major, 0.88];
    if (/park_outline/.test(id)) return [NIGHT.green, 0.9];
    return [NIGHT.road, 0.9];
  }
  return null;
}
const COLOR_PROPS = { background: ['background-color'], fill: ['fill-color', 'fill-outline-color'], line: ['line-color'],
  'fill-extrusion': ['fill-extrusion-color'], symbol: ['text-color', 'text-halo-color'] };
const DEFAULTS = { 'text-color': '#000000', 'text-halo-color': 'rgba(0,0,0,0)' };

/** Daylight curve: returns {dark 0..1, warm 0..1} for hour h. */
export function lightAt(h) {
  h = ((h % 24) + 24) % 24;
  const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  let dark;
  if (h >= 7 && h < 18) dark = 0;
  else if (h >= 18 && h < 21) dark = Math.pow(ss(18, 21, h), 1.5);
  else if (h >= 5 && h < 7) dark = Math.pow(1 - ss(5, 7, h), 1.5);
  else dark = 1;
  const bell = (c, w) => Math.max(0, 1 - Math.abs(h - c) / w);
  const warm = Math.max(bell(18.8, 1.9), bell(6.1, 1.3));
  return { dark, warm };
}

export class Look {
  constructor(map, owned) {
    this.map = map; this.owned = owned || new Set(); this.entries = []; this.last = new Map(); this.state = { dark: -1, warm: -1 };
    for (const l of map.getStyle().layers) {
      if (l.id.startsWith('uw-')) continue;
      for (const prop of COLOR_PROPS[l.type] || []) {
        if (this.owned.has(l.id + '|' + prop)) continue;
        const t = targetFor(l, prop); if (!t) continue;
        let base = map.getPaintProperty(l.id, prop);
        if (base == null) { if (!DEFAULTS[prop]) continue; base = DEFAULTS[prop]; }
        this.entries.push({ id: l.id, prop, base, target: parseColor(t[0]), k: t[1], water: /^water/.test(l.id), fillish: l.type !== 'symbol' && l.type !== 'line' });
      }
      if (l.type === 'symbol' && map.getLayoutProperty(l.id, 'icon-image')) {
        this.entries.push({ id: l.id, prop: 'icon-opacity', base: map.getPaintProperty(l.id, 'icon-opacity') ?? 1, numeric: true });
      }
      if (l.type === 'raster') this.entries.push({ id: l.id, prop: 'raster-brightness-max', base: 1, numeric: true, raster: true });
    }
  }
  apply(dark, warm) {
    if (Math.abs(dark - this.state.dark) < 0.004 && Math.abs(warm - this.state.warm) < 0.004) return false;
    this.state = { dark, warm };
    const map = this.map;
    for (const e of this.entries) {
      let v;
      if (e.numeric) {
        if (e.raster) v = 1 - 0.65 * dark;
        else v = typeof e.base === 'number' ? e.base * (1 - 0.3 * dark) : e.base;
      } else {
        const isText = e.prop === 'text-color' || e.prop === 'text-halo-color';
        // labels flip decisively around mid-dusk so they never go grey-on-grey
        const d = isText ? dark * dark * (3 - 2 * dark) : dark;
        const dt = isText ? Math.min(1, Math.max(0, (d - 0.35) / 0.3)) : d;
        v = mapColors(e.base, (c) => {
          let x = mix(c, e.target, dt * e.k);
          if (warm > 0 && e.prop !== 'text-color' && e.prop !== 'text-halo-color') x = mix(x, e.water ? DUSK_WATER : DUSK, warm * (e.water ? 0.22 : e.fillish ? 0.3 : 0.18) * (1 - dark * 0.45));
          return x;
        });
      }
      if (e.prop === 'background-color') this.bg = firstColor(v);
      const key = typeof v === 'string' || typeof v === 'number' ? v : JSON.stringify(v);
      if (this.last.get(e.id + e.prop) === key) continue;
      this.last.set(e.id + e.prop, key);
      try { map.setPaintProperty(e.id, e.prop, v, { validate: false }); } catch { /* layer may be gone */ }
    }
    return true;
  }
  /** The land colour the look shows right now (the style's background, after day/dusk/night mixing). */
  bgColor(dark = Math.max(0, this.state.dark)) {
    if (this.bg) return this.bg;
    return mix(parseColor('#f8f4f0'), parseColor(NIGHT.bg), dark);
  }
}
/** first colour string inside a paint value (string or expression) */
function firstColor(v) {
  if (typeof v === 'string') return parseColor(v);
  if (Array.isArray(v)) for (const x of v) { const c = firstColor(x); if (c) return c; }
  if (v && typeof v === 'object' && Array.isArray(v.stops)) return firstColor(v.stops.map((s) => s[1]));
  return null;
}

/** Decide basemap look for theme + hour. */
/** The chrome's theme, which bounds the map: the host's (Studio's light or dark, <html data-uw-host-theme>), else the
 *  device's. The sheet always follows it, so a light phone never gets a near-black 23:00 map under a white sheet. */
const chromeBand = () => {
  if (typeof document === 'undefined') return null;
  const host = document.documentElement.getAttribute('data-uw-host-theme');
  if (host === 'light' || host === 'dark') return host;
  if (typeof window === 'undefined' || !window.matchMedia) return null;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};
/** How dark the basemap is: a fixed theme, else the hour (with the time slider on), else the device.
 *  The hour moves the light only within the chrome's band: a light Studio never opens on a near-black night map, a
 *  dark Studio (or a dark device) never on a bright day map under a dark sheet. */
export function lookFor(theme, hour, timeEnabled, host = chromeBand()) {
  if (theme === 'dark') return { dark: 1, warm: 0 };
  if (theme === 'light') return { dark: 0, warm: 0 };
  if (!timeEnabled) return prefersDark() ? { dark: 1, warm: 0 } : { dark: 0, warm: 0 };
  const at = lightAt(hour);
  if (host === 'light') return { dark: Math.min(at.dark, HOST_LIGHT_MAX), warm: at.warm };
  if (host === 'dark') return { dark: Math.max(at.dark, HOST_DARK_MIN), warm: at.warm * 0.3 };
  return at;
}
// a light chrome keeps the light map at every hour: a dimmed light map read as a muddy, disabled overlay with smudged
// labels; night is said in words (the hour, "at night") instead
export const HOST_LIGHT_MAX = 0;
export const HOST_DARK_MIN = 0.85;

// ---------- terrain / 3D ----------
const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export function ensureTerrainSources(map, beforeId, { visible = false } = {}) {
  if (map.getSource('uw--dem')) return;
  const src = { type: 'raster-dem', tiles: [DEM], encoding: 'terrarium', tileSize: 256, maxzoom: 15,
    attribution: 'Terrain: <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Mapzen/AWS Terrain Tiles</a>' };
  // terrain mesh uses DEM z<=14 (matches the vector tiles' maxzoom; avoids MapLibre's overscale warning), hillshade the full z15
  map.addSource('uw--dem', { ...src, maxzoom: 14 });
  map.addSource('uw--dem-hs', { ...src, attribution: undefined });
  map.addLayer({ id: 'uw--hillshade', type: 'hillshade', source: 'uw--dem-hs', layout: { visibility: visible ? 'visible' : 'none' },
    paint: { 'hillshade-exaggeration': visible ? 0.42 : 0.35, 'hillshade-shadow-color': 'rgba(40,40,60,0.45)', 'hillshade-highlight-color': 'rgba(255,255,255,0.25)' } }, beforeId);
}

/**
 * Sky + fog for the current look. The fog is the land colour itself and the horizon is that colour mixed a quarter of
 * the way to the sky, so in steep 3D the last tile row fades into a horizon of the same tone instead of leaving a dark
 * (night) or grey (day) band between the map and the sky (ENGINE-SPEC-v0.2 §12.1).
 */
export function skyFor(dark, look) {
  const rgb = (x) => `rgb(${x.slice(0, 3).map((n) => Math.round(clamp(n, 0, 255))).join(',')})`;
  const sky = mix(parseColor(SKY.day), parseColor(SKY.night), dark);
  const land = look?.bgColor ? look.bgColor(dark) : mix(parseColor('#f8f4f0'), parseColor(NIGHT.bg), dark);
  return { 'sky-color': rgb(sky), 'horizon-color': rgb(mix(land, sky, 0.25)), 'fog-color': rgb(land),
    'sky-horizon-blend': 0.5, 'horizon-fog-blend': 0.85, 'fog-ground-blend': 0.92,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 6, 0.6, 9, 0] };
}
