// map-pack engine: small shared helpers (no dependencies). Kit-owned file: sites should not edit it.

export const PALETTE = ['#e11d48', '#7c3aed', '#0ea5e9', '#16a34a', '#ea580c', '#db2777', '#0891b2', '#ca8a04', '#4f46e5'];

export const MODE_EMOJI = {
  train: '🚆', rail: '🚆', hsr: '🚄', metro: '🚇', subway: '🚇', mrt: '🚇', tram: '🚊', bus: '🚌', coach: '🚌',
  car: '🚗', drive: '🚗', taxi: '🚕', flight: '✈️', plane: '✈️', fly: '✈️', ferry: '⛴️', boat: '⛴️',
  walk: '🚶', foot: '🚶', bike: '🚲', cycle: '🚲', scooter: '🛵',
};

export const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Dark chrome and basemap: the host's theme when hosted (<html data-uw-host-theme>, engine/host.js), else the device. */
export const prefersDark = () => {
  const host = document.documentElement.getAttribute('data-uw-host-theme');
  if (host === 'dark' || host === 'light') return host === 'dark';
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
};

/** Tiny DOM builder: h('div.cls#id', {attr}, ...children) */
export function h(sel, attrs, ...kids) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(sel) || [];
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** "{area} · {kind}" -> filled; missing keys vanish and dangling separators are tidied. */
export function fill(tpl, props) {
  if (tpl == null) return '';
  if (typeof tpl !== 'string') return String(tpl);
  const out = tpl.replace(/\{([\w:.-]+)\}/g, (_, k) => {
    const v = props?.[k];
    return v == null ? '' : (typeof v === 'number' ? fmtNum(v) : String(v));
  });
  return out.replace(/^(\s*[·•|,-]\s*)+|(\s*[·•|,-]\s*)+$/g, '').replace(/(\s[·•|]\s)(\s*[·•|]\s)+/g, '$1').trim();
}

export function fmtNum(v) {
  if (typeof v !== 'number' || !isFinite(v)) return String(v ?? '');
  if (Math.abs(v) >= 100) return Math.round(v).toLocaleString('en');
  if (Math.abs(v) >= 10) return String(Math.round(v * 10) / 10);
  return String(Math.round(v * 100) / 100);
}

export function fmtMetric(v, m = {}) {
  if (v == null || v === '' || (typeof v === 'number' && !isFinite(v))) return '–';
  if (typeof v !== 'number') return String(v);
  if (m.format === 'pct') return Math.round(v <= 1.0001 ? v * 100 : v) + '%';
  if (m.format === 'db' || m.unit === 'dB') return word('en', noiseWord(v));
  if (m.format === 'int') return Math.round(v).toLocaleString('en') + (m.unit ? ' ' + m.unit : '');
  if (m.format === 'km' || m.unit === 'km') return fmtNum(v) + ' km';
  if (m.format === 'min') return Math.round(v) + ' min';
  if (m.unit === 'm' && v >= 1000) return (v / 1000).toFixed(1) + ' km';
  if (m.unit === 'min') return Math.round(v) + ' min';
  return fmtNum(v) + (m.unit ? (m.unit.length > 2 ? ' ' : ' ') + m.unit : '');
}

const FEEL_LABELS = { calm_day: 'Calm by day (estimate)', calm_night: 'Calm at night (estimate)', lively_day: 'Lively by day (estimate)', lively_night: 'Lively at night (estimate)',
  green: 'Green (estimate)', amenities: 'Daily needs (estimate)', noise_day_db: 'Noise by day (estimate)', noise_night_db: 'Noise at night (estimate)' };
/** Metric key → label; matches the labels `uw.mjs enrich` suggests (cafes_10min → "Cafes ≤10 min", nearest_mrt_m → "To mrt"). */
export const humanize = (k) => FEEL_LABELS[k] || (/_area$/.test(k) && FEEL_LABELS[k.slice(0, -5)] ? FEEL_LABELS[k.slice(0, -5)].replace(' (estimate)', ', walk area (estimate)') : null)
  || String(k).replace(/^(walk|ride)_min_(.+)$/, (_, m, l) => `${m === 'ride' ? 'Ride' : 'Walk'} to ${l}`).replace(/^nearest_(.+)_m$/, 'To $1').replace(/_(\d+)min$/, ' ≤$1 min').replace(/_(\d+)m$/, ' ≤$1 m')
  .replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** OpenStreetMap's own classes for areas and boundaries, in the words a visitor uses ("Suburb" is a neighbourhood in
 *  town, "Administrative" any area with a border), and kinds whose word is not their name ("place_of_worship"). null:
 *  no word at all (a bare "Yes" or "House" says nothing). */
const KIND_WORDS = {
  suburb: 'Neighbourhood', quarter: 'Neighbourhood', neighbourhood: 'Neighbourhood', neighborhood: 'Neighbourhood', city_block: 'Neighbourhood',
  borough: 'District', district: 'District', administrative: 'Area', political: 'Area', locality: 'Area', region: 'Area', county: 'Area',
  state: 'Area', province: 'Area', municipality: 'Town', city: 'City', town: 'Town', village: 'Village', hamlet: 'Village',
  isolated_dwelling: 'Village', islet: 'Island', yes: null, house: null, building: null, address: null,
  cafe: 'Café', marketplace: 'Market', mrt_station: 'Metro station', subway_entrance: 'Metro entrance', halt: 'Station',
  aerodrome: 'Airport', camp_site: 'Campsite', convenience: 'Convenience store', atm: 'ATM', ev_charging: 'EV charging',
  tea: 'Tea / bubble tea', pool: 'Swimming pool', swimming_pool: 'Swimming pool', bike_share: 'Bike share',
  bicycle_rental: 'Bike share', books: 'Bookstore', archaeological_site: 'Archaeological site',
};
/** Kinds whose own name is the plain word ("museum" → "Museum", "food_court" → "Food court"): the uw commands' kinds
 *  and the OpenStreetMap classes of places people go to. */
const PLAIN_KINDS = new Set(('museum gallery attraction viewpoint monument memorial castle palace fort ruins tower lighthouse ' +
  'church cathedral chapel basilica mosque synagogue temple shrine place_of_worship monastery square park garden zoo ' +
  'aquarium theme_park artwork fountain beach peak island lake waterfall bridge market night_market food_court ' +
  'restaurant coffee bar pub fast_food ice_cream bakery dessert nightlife nightclub karaoke hotel hostel guest_house motel ' +
  'apartment lodging station train_station tram_stop bus_stop bus_station ferry_terminal airport university library ' +
  'theatre cinema stadium arts_centre gym playground supermarket pharmacy toilets laundry coworking bookstore hot_spring ' +
  'mall department_store shop store sight landmark venue food area stop stay home office school hospital').split(' '));
/** A place's kind as its card and list say it: the plain word for it, or nothing. A kind with no plain word is left
 *  out, never shown as its tag ("board", an information board in OpenStreetMap, read "Board"); a kind written by hand
 *  (capitals or spaces: "B&B", "Day trip") is the author's own words. */
export const kindLabel = (k) => {
  const text = String(k ?? '').trim(), key = text.toLowerCase();
  if (!key) return '';
  if (Object.prototype.hasOwnProperty.call(KIND_WORDS, key)) return KIND_WORDS[key] || '';
  if (/^[a-z0-9_]+$/.test(text) && !PLAIN_KINDS.has(key)) return '';
  return text.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
};
/** The map's credits, each once: a credit that says what an earlier one says ("© OpenStreetMap contributors (ODbL)"
 *  after the linked "© OpenStreetMap contributors") is dropped. Compared by its words, without links, case or a licence
 *  in brackets. */
export function uniqueCredits(list) {
  const seen = new Set();
  return (list || []).filter((c) => {
    if (typeof c !== 'string' || !c.trim()) return false;
    const key = c.replace(/<[^>]*>/g, ' ').replace(/&copy;/gi, '©').replace(/\((?:ODbL|CC[ -][^)]*|licen[cs]e[^)]*)\)/gi, ' ')
      .toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
/** A card's source line: map data reads "Map data © OpenStreetMap" (never which search found it), any other source its
 *  own name without the lookup in brackets ("Wikipedia (its article's coordinates)" → "Source: Wikipedia"); a place a
 *  fallback found adds "data may be incomplete". */
export function sourceLine(p) {
  const raw = typeof p?.source === 'string' ? p.source.trim() : '';
  const osm = /^openstreetmap\b/i.test(raw) || (!raw && /^osm-[nwr]\d+/.test(String(p?.id ?? '')));
  const name = osm ? '' : raw.replace(/\s*\([^)]*\)/g, '').trim();
  const parts = [osm ? 'Map data © OpenStreetMap' : name ? `Source: ${name}` : '', p?.data_status === 'partial' ? 'data may be incomplete' : ''];
  return parts.filter(Boolean).join(' · ');
}

export function fmtHour(h) {
  const hh = Math.floor(((h % 24) + 24) % 24), mm = Math.round((h - Math.floor(h)) * 60);
  return String(hh).padStart(2, '0') + ':' + String(mm === 60 ? 0 : mm).padStart(2, '0');
}

/** a time-of-day glyph for the "neutral" preset; the instafy preset writes times in words and digits only ('') */
export function timeIcon(h) {
  if (typeof document !== 'undefined' && document.documentElement.getAttribute('data-uw-theme') !== 'neutral') return '';
  h = ((h % 24) + 24) % 24;
  if (h < 5 || h >= 20) return '🌙';
  if (h < 7.5) return '🌅';
  if (h >= 17.5) return '🌇';
  return '☀️';
}

/** Is hour h inside [from, to)? Handles wrap past midnight and to > 24. */
export function inWindow(h, win) {
  if (!Array.isArray(win) || win.length < 2) return true;
  let [a, b] = win.map(Number);
  if (!isFinite(a) || !isFinite(b)) return true;
  if (b - a >= 24) return true;
  a = ((a % 24) + 24) % 24; b = ((b % 24) + 24) % 24;
  h = ((h % 24) + 24) % 24;
  return a <= b ? h >= a && h < b : h >= a || h < b;
}

/** MapLibre expression equivalent of inWindow over feature props time_from/time_to and global-state "hour". */
export function timeFilterExpr() {
  const h = ['to-number', ['global-state', 'hour'], 12];
  const fr = ['to-number', ['coalesce', ['get', 'time_from'], 0]], to = ['to-number', ['coalesce', ['get', 'time_to'], 24]];
  const a = ['%', fr, 24], b = ['%', to, 24];
  return ['any',
    ['!', ['has', 'time_from']],
    ['>=', ['-', to, fr], 24],
    ['all', ['<=', a, b], ['>=', h, a], ['<', h, b]],
    ['all', ['>', a, b], ['any', ['>=', h, a], ['<', h, b]]],
  ];
}

// ---------- colour ----------
const NAMED = { white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0] };
export function parseColor(s) {
  if (typeof s !== 'string') return null;
  s = s.trim().toLowerCase();
  if (NAMED[s]) return NAMED[s].slice();
  let m;
  if ((m = /^#([0-9a-f]{3,8})$/.exec(s))) {
    let x = m[1];
    if (x.length === 3 || x.length === 4) x = x.split('').map((c) => c + c).join('');
    if (x.length !== 6 && x.length !== 8) return null;
    const n = (i) => parseInt(x.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), x.length === 8 ? n(6) / 255 : 1];
  }
  if ((m = /^rgba?\(([^)]+)\)$/.exec(s))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    if (p.length < 3) return null;
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  if ((m = /^hsla?\(([^)]+)\)$/.exec(s))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    if (p.length < 3) return null;
    const [r, g, b] = hslToRgb(p[0], p[1] / 100, p[2] / 100);
    return [r, g, b, p.length > 3 ? p[3] : 1];
  }
  return null;
}
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const f = (n) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))); };
  return [f(0), f(8), f(4)];
}
export const rgba = (c) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${+c[3].toFixed(3)})`;
export function mix(a, b, t) {
  if (t <= 0) return a; if (t >= 1) return [b[0], b[1], b[2], a[3]];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3]];
}
/** Walk a style value (string or expression) and transform every colour string in it. */
export function mapColors(v, fn) {
  if (typeof v === 'string') { const c = parseColor(v); return c ? rgba(fn(c)) : v; }
  if (Array.isArray(v)) return v.map((x) => mapColors(x, fn));
  if (v && typeof v === 'object' && Array.isArray(v.stops)) return { ...v, stops: v.stops.map(([z, c]) => [z, mapColors(c, fn)]) };
  return v;
}

// ---------- geometry ----------
export function eachCoord(geom, fn) {
  if (!geom) return;
  const walk = (c) => { if (typeof c[0] === 'number') fn(c); else c.forEach(walk); };
  if (geom.type === 'GeometryCollection') geom.geometries.forEach((g) => eachCoord(g, fn));
  else if (geom.coordinates) walk(geom.coordinates);
}
export function bbox(geomOrFeatures) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (c) => { if (c[0] < b[0]) b[0] = c[0]; if (c[1] < b[1]) b[1] = c[1]; if (c[0] > b[2]) b[2] = c[0]; if (c[1] > b[3]) b[3] = c[1]; };
  const list = Array.isArray(geomOrFeatures) ? geomOrFeatures : [geomOrFeatures];
  for (const g of list) eachCoord(g && g.type === 'Feature' ? g.geometry : g, add);
  return isFinite(b[0]) ? b : null;
}
export function center(geom) {
  if (!geom) return null;
  if (geom.type === 'Point') return geom.coordinates;
  if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
    const line = lineCoords(geom); return along(line, 0.5);
  }
  const b = bbox(geom); return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null;
}
export function lineCoords(geom) {
  if (!geom) return [];
  if (geom.type === 'LineString') return geom.coordinates;
  if (geom.type === 'MultiLineString') return geom.coordinates.flat();
  if (geom.type === 'Feature') return lineCoords(geom.geometry);
  return [];
}
export function distM(a, b) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r, dLng = (b[0] - a[0]) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
export function cumulative(line) {
  const d = [0];
  for (let i = 1; i < line.length; i++) d.push(d[i - 1] + distM(line[i - 1], line[i]));
  return d;
}
/** Point at fraction t (0..1) along a coordinate list. */
export function along(line, t, cum) {
  if (!line.length) return null;
  cum = cum || cumulative(line);
  const total = cum[cum.length - 1], target = clamp(t, 0, 1) * total;
  let i = 1; while (i < cum.length - 1 && cum[i] < target) i++;
  const seg = cum[i] - cum[i - 1] || 1, f = (target - cum[i - 1]) / seg;
  const a = line[i - 1], b = line[i] || a;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, i];
}
/** Gently curved arc from a to b (quadratic bezier, bulging left of travel). */
export function arc(a, b, bend = 0.18, n = 48) {
  const latScale = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  const dx = (b[0] - a[0]) * latScale, dy = b[1] - a[1];
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const cx = mx - dy * bend / latScale, cy = my + dx * bend;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * cx + t * t * b[0], u * u * a[1] + 2 * u * t * cy + t * t * b[1]]);
  }
  return out;
}
export function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
export function pointInGeom(p, geom) {
  if (!geom) return false;
  const poly = (rings) => pointInRing(p, rings[0]) && !rings.slice(1).some((r) => pointInRing(p, r));
  if (geom.type === 'Polygon') return poly(geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some(poly);
  return false;
}
export const round6 = (n) => Math.round(n * 1e6) / 1e6;

export function debounce(fn, ms) {
  let t, last = null;
  const d = (...a) => { last = a; clearTimeout(t); t = setTimeout(() => { last = null; fn(...a); }, ms); };
  d.flush = () => { if (last) { clearTimeout(t); const a = last; last = null; fn(...a); } };
  return d;
}
export function rafThrottle(fn) {
  let queued = false, args;
  return (...a) => { args = a; if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fn(...args); }); };
}
export const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------- v0.2 shared vocabulary ----------
/** Option letters and their fixed colours (verdict chips, pins, Compare columns, list rows, card heads). Not good/bad. */
export const LETTERS = ['A', 'B', 'C', 'D', 'E'];
// identity colours; theme.js replaces them (in place) from the --uw-letter-* / --uw-cat-* / --uw-walk* / --uw-heat-pt tokens
// letters never take the link / button blue or a teal (blue means "press me"; the pages have no teal)
export const LETTER_COLORS = { A: '#6b4fa0', B: '#a16207', C: '#c0264e', D: '#3f6212', E: '#55524c' };
export const CAT_COLORS = ['#6b4fa0', '#a16207', '#c0264e', '#3f6212', '#55524c', '#ca8a04'];
export const THEME_COLORS = { walk: '#7c3aed', walkNight: '#7c3aed', heatPt: '#f97316' };
/** basis → what a person sees (ENGINE-SPEC-v0.2 §0.3; `modelled` / `inferred` show as estimated). The basis word is
 * shown only where it changes the meaning: an estimate says "Estimate", a maker's claim and a note say so. Measured,
 * routed, counted, register, filed and live values show just their source and date (the same trust line as Instafy's
 * pages), so their chip is empty. `word` is the hover / screen-reader text. */
export const BASIS = {
  measured: { chip: '', word: 'measured', conf: 'high' },
  routed: { chip: '', word: 'routed on the street map', conf: 'high' },
  counted: { chip: '', word: 'counted', conf: 'medium' },
  estimated: { chip: 'Estimate', word: 'Estimate', conf: 'low' },
  registry: { chip: '', word: 'official register', conf: 'high' },
  filed: { chip: '', word: 'filed record', conf: 'high' },
  live: { chip: '', word: 'checked live', conf: 'high' },
  brand: { chip: "maker's claim", word: "maker's claim", conf: 'medium' },
  user_note: { chip: 'note', word: 'note', conf: null },
  editorial: { chip: '', word: '', conf: null },
};
/** The basis word a sentence may show ("Estimate", "maker's claim", "note"), else ''. */
export const basisShown = (b) => BASIS[b]?.chip || '';
export const normBasis = (b) => (b === 'modelled' || b === 'inferred' ? 'estimated' : BASIS[b] ? b : null);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "9 Sep 2026" (or "9 Sep" when year is false) from an ISO date / date-time; null when unparseable. */
export function fmtDate(iso, year = true) {
  if (!iso || typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(iso);
  if (!m) return null;
  const mon = MON[+m[2] - 1]; if (!mon) return null;
  return [m[3] ? String(+m[3]) : null, mon, year ? m[1] : null].filter(Boolean).join(' ');
}
/** "Jul 2026" */
export function fmtMonth(iso) { const m = /^(\d{4})-(\d{2})/.exec(String(iso || '')); return m && MON[+m[2] - 1] ? `${MON[+m[2] - 1]} ${m[1]}` : null; }
/** Age of an ISO time: "now", "4 min", "3 h", else "9 Sep". */
export function fmtAge(iso, now = Date.now()) {
  const t = Date.parse(iso); if (!isFinite(t)) return null;
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return fmtDate(new Date(t).toISOString(), false);
}
/** HH:MM local time of an ISO string (for "as of 15:04"). */
export function fmtClock(iso) { const d = new Date(iso); return isFinite(d) ? String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') : ''; }
const CUR = { TWD: 'NT$', USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: 'CN¥', HKD: 'HK$', SGD: 'S$', AUD: 'A$', CAD: 'C$', KRW: '₩', THB: '฿', SEK: 'kr ' };
export function fmtMoney(amount, currency) {
  if (typeof amount !== 'number' || !isFinite(amount)) return '';
  const c = String(currency || '').toUpperCase();
  const n = Math.round(amount).toLocaleString('en');
  return CUR[c] ? `${CUR[c]}${n}` : `${c} ${n}`.trim();
}
/** Is a URL safe to put in an href/src? https always; http only for localhost (records are untrusted). */
export function safeUrl(u) {
  if (typeof u !== 'string' || u.length > 2000) return null;
  try {
    const x = new URL(u, location.href);
    if (x.protocol === 'https:') return x.href;
    if (x.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(x.hostname)) return x.href;
  } catch { /* */ }
  return null;
}
/** Polygon area-weighted label point fallback: centroid of the outer ring (good enough for convex-ish areas). */
export function ringCentroid(ring) {
  let a = 0, x = 0, y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f; x += (ring[j][0] + ring[i][0]) * f; y += (ring[j][1] + ring[i][1]) * f;
  }
  if (!a) return ring[0];
  return [x / (3 * a), y / (3 * a)];
}
// ---------- the words the map writes itself (map.config.json "locale"; titles, asks and notes are the agent's) ----------
export const LOCALES = ['en', 'sv'];
const WORDS = {
  en: { places: 'Places', layers: 'Map key', compare: 'Compare', plan: 'Plan', verdict: 'Verdict',
    best: 'Best by your weights: {name}', bestFor: 'best for {who}', tie: 'Too close to call on what is measured so far', soFar: 'so far', close: '{a} and {b} are close',
    plenty: 'plenty ({n}+)', inside: 'inside', top: 'top {n}%', bottom: 'bottom {n}%',
    veryHigh: 'very high', high: 'high', medium: 'medium', low: 'low', veryLow: 'very low',
    noise1: 'quiet', noise2: 'fairly quiet', noise3: 'some traffic noise', noise4: 'loud traffic' },
  sv: { places: 'Platser', layers: 'Lager', compare: 'Jämför', plan: 'Plan', verdict: 'Omdöme',
    best: 'Bäst enligt dina vikter: {name}', bestFor: 'bäst för {who}', tie: 'För jämnt för att avgöra på det som mätts hittills', soFar: 'hittills', close: '{a} och {b} ligger jämnt',
    plenty: 'gott om ({n}+)', inside: 'inuti', top: 'topp {n}%', bottom: 'botten {n}%',
    veryHigh: 'mycket hög', high: 'hög', medium: 'medel', low: 'låg', veryLow: 'mycket låg',
    noise1: 'tyst', noise2: 'ganska tyst', noise3: 'en del trafikbuller', noise4: 'högt trafikbuller' },
};
/** A road-noise estimate in decibels said in words (the number is jargon to most people): the word key for word().
 *  Bands for a facade at night, anchored on the WHO night guideline for road traffic (45 dB Lnight, 2018): under 45
 *  quiet, under 55 fairly quiet, under 62 some traffic noise, else loud (65 dB is 20 dB over the guideline). */
export function noiseWord(db) { return db < 45 ? 'noise1' : db < 55 ? 'noise2' : db < 62 ? 'noise3' : 'noise4'; }
export const localeOf = (l) => (LOCALES.includes(l) ? l : 'en');
/** word('sv', 'best', { name: 'A' }) → "Bäst enligt dina vikter: A"; unknown locales read English */
export function word(locale, key, vars = {}) {
  const s = WORDS[localeOf(locale)][key] ?? WORDS.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}

/** The name the map shows for a feature (pins, cards, lists): English where it has one, unless basemap labels are
 *  "local". Events to a host use it too, so a chip never shows a raw register name the map does not. */
export function featureName(p, labels = 'en') {
  p = p || {};
  if (labels === 'local') return p.name || p.name_en || '';
  return p.name_en || p.name || '';
}
/** the v1 "select" event: the layer, id, ref and the name the viewer sees on the map (layer title as a fallback) */
export function selectPayload(L, f, labels = 'en', id = f?.properties?.id) {
  return { layer: L.id, id, ref: `${L.id}:${id}`, name: featureName(f?.properties, labels) || L.title || '', feature: f };
}
export const capFirst = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');

/** The day after a trip's last night, as `uw plan` writes it ("depart": true; older plans: a title ending ": depart"). */
export function isDepartDay(d) { return d?.depart === true || /: depart$/.test(String(d?.title || '')); }

/** The page's description (`<meta name="description">`, what a link preview shows): what the map is and how much it
 *  holds, from numbers and fixed words only, never a title or a place name. "Trip · 3 days · 14 places" for a map with
 *  a plan, "Map · 14 places" otherwise; a part that does not apply is left out. `places` = the points on the map. */
export function pageDescription(config, places) {
  // the departure day is the date the traveller leaves, not a day of the trip ("3 days in Lisbon": 3 nights)
  const days = Array.isArray(config?.plan?.days) ? config.plan.days.filter((d) => !isDepartDay(d)).length : 0;
  const count = (n, one, many) => (n > 0 ? `${n} ${n === 1 ? one : many}` : null);
  const kind = config?.plan && typeof config.plan === 'object' ? 'Trip' : 'Map';
  const n = Number.isInteger(places) && places > 0 ? places : 0;
  return [kind, count(days, 'day', 'days'), count(n, 'place', 'places')].filter(Boolean).join(' · ');
}
