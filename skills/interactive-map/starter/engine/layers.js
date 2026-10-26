// map-pack engine: turning config layers into MapLibre sources/layers.
// Kit-owned file: sites should not edit it.
import { nightInk } from './look.js';
import { PALETTE, THEME_COLORS, MODE_EMOJI, arc, center, bbox, lineCoords, timeFilterExpr, inWindow, parseColor, mix, rgba, ringCentroid } from './util.js';

export const SIZES = { s: 26, m: 32, l: 40 };
const FONT = ['Noto Sans Regular'];
const FONT_BOLD = ['Noto Sans Bold'];
const PR = () => Math.min(4, Math.max(2, window.devicePixelRatio || 1) * 1.5);
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Twemoji Mozilla",sans-serif';

// z-order ranks: lower = further down. Ranks < 100 go below basemap labels.
// v0.2 tiers (draw order is fixed by tier): grid → area fills → lines → routes → context dots → support symbols → area
// labels → option symbols → selection. Ranks ≥ 100 sit above the basemap labels.
export const RANK = { grid: 10, areas: 20, heat: 30, lines: 40, route: 50, reveal: 52, legs: 60, top: 100, arrows: 110, legsTop: 120, heatPts: 125,
  glow: 126, ctxDot: 127, ctxSym: 128, cluster: 130, points: 140, support: 136, revealPts: 137, areaLabels: 138, option: 146, optionHit: 147, sel: 150, walk: 160 };
/** fill colours of named areas by lens (ENGINE-SPEC-v0.2 §6.2); theme.js replaces them from the --uw-area-* tokens */
export const AREA_COLORS = { quiet_night: '#0d9488', quiet: '#0d9488', lively_night: '#db2777', lively: '#db2777', green: '#16a34a', quiet_day: '#0891b2', lively_day: '#ea580c', amenities: '#4f46e5' };
const FEEL_KEYS = ['calm_day', 'calm_night', 'lively_day', 'lively_night', 'green', 'amenities'];

// ---------- icons ----------
// overlay halos and casings are written against the neutral night (navy); swap in the theme's night ink (theme.js)
function themeNight(c) {
  if (typeof c !== 'string') return c;
  const m = /^rgba\(\s*(13,\s*19,\s*34|10,\s*15,\s*28)\s*,\s*([\d.]+)\s*\)$/.exec(c);
  if (!m) return c;
  const ink = parseColor(/^13/.test(m[1]) ? nightInk().halo : nightInk().casing);
  return ink ? `rgba(${ink[0]},${ink[1]},${ink[2]},${m[2]})` : c;
}

export function drawBadge({ emoji, color = '#64748b', d = 32, ring = false, dot = false }) {
  const pr = PR(), pad = 5;
  const W = Math.ceil((d + pad * 2) * pr);
  const c = document.createElement('canvas'); c.width = c.height = W;
  const g = c.getContext('2d', { willReadFrequently: true }); g.scale(pr, pr);
  const cx = d / 2 + pad, r = d / 2;
  g.shadowColor = 'rgba(15,23,42,0.32)'; g.shadowBlur = 5; g.shadowOffsetY = 1.5;
  g.beginPath(); g.arc(cx, cx, r, 0, Math.PI * 2); g.fillStyle = '#ffffff'; g.fill();
  g.shadowColor = 'transparent';
  if (ring) {
    g.beginPath(); g.arc(cx, cx, r - 1.4, 0, Math.PI * 2); g.lineWidth = 2.6; g.strokeStyle = color; g.stroke();
  } else {
    g.beginPath(); g.arc(cx, cx, r - Math.max(2, d * 0.075), 0, Math.PI * 2); g.fillStyle = color; g.fill();
  }
  if (emoji) {
    g.font = `${Math.round(d * (ring ? 0.56 : 0.52))}px ${EMOJI_FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(emoji, cx, cx + d * 0.045);
  } else if (dot) {
    g.beginPath(); g.arc(cx, cx, d * 0.16, 0, Math.PI * 2); g.fillStyle = '#ffffff'; g.fill();
  }
  return { img: { width: W, height: W, data: new Uint8Array(g.getImageData(0, 0, W, W).data.buffer) }, pixelRatio: pr };
}

/** Option pin: filled circle in the letter colour, white bold letter, 2 px white ring, soft shadow (40 px). */
export function drawLetter({ letter, color = '#2563eb', d = 40, emoji = null }) {
  const pr = PR(), pad = 6;
  const W = Math.ceil((d + pad * 2) * pr);
  const c = document.createElement('canvas'); c.width = c.height = W;
  const g = c.getContext('2d', { willReadFrequently: true }); g.scale(pr, pr);
  const cx = d / 2 + pad, r = d / 2;
  g.shadowColor = 'rgba(15,23,42,0.38)'; g.shadowBlur = 7; g.shadowOffsetY = 2;
  g.beginPath(); g.arc(cx, cx, r, 0, Math.PI * 2); g.fillStyle = '#ffffff'; g.fill();
  g.shadowColor = 'transparent';
  g.beginPath(); g.arc(cx, cx, r - 2.2, 0, Math.PI * 2); g.fillStyle = color; g.fill();
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#ffffff';
  if (letter) { g.font = `800 ${Math.round(d * 0.5)}px -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif`; g.fillText(letter, cx, cx + d * 0.03); }
  else if (emoji) { g.font = `${Math.round(d * 0.5)}px ${EMOJI_FONT}`; g.fillText(emoji, cx, cx + d * 0.045); }
  return { img: { width: W, height: W, data: new Uint8Array(g.getImageData(0, 0, W, W).data.buffer) }, pixelRatio: pr };
}
/** a numbered stop: "n": 2 on the feature, or a keycap emoji (2️⃣) → a plain numeral in the disc (no double frame,
 *  and the same on every platform) */
export function stopNumber(p, emoji) {
  if (p.n != null && /^\d{1,2}$/.test(String(p.n))) return String(p.n);
  const m = /^(\d{1,2})\uFE0F?\u20E3$/u.exec(String(emoji || ''));
  return m ? m[1] : null;
}
export function ensureLetter(map, letter, color, d = 40, emoji = null) {
  const key = `uw:L:${letter || '•'}:${color}:${d}:${emoji || ''}`;
  if (!map.hasImage(key)) { const { img, pixelRatio } = drawLetter({ letter, color, d, emoji }); map.addImage(key, img, { pixelRatio }); }
  return key;
}

function drawArrow(color = '#ffffff') {
  const pr = PR(), s = 12, W = Math.ceil(s * pr);
  const c = document.createElement('canvas'); c.width = c.height = W;
  const g = c.getContext('2d', { willReadFrequently: true }); g.scale(pr, pr);
  g.strokeStyle = color; g.lineWidth = 2.2; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(4, 2.5); g.lineTo(8.5, 6); g.lineTo(4, 9.5); g.stroke();
  return { img: { width: W, height: W, data: new Uint8Array(g.getImageData(0, 0, W, W).data.buffer) }, pixelRatio: pr };
}

function drawPill({ emoji, color, text }) {
  const pr = PR(), hgt = 28, pad = 5;
  const m = document.createElement('canvas').getContext('2d');
  m.font = `700 13px -apple-system, "Segoe UI", Roboto, sans-serif`;
  const tw = m.measureText(text).width, ew = emoji ? 17 : 0;
  const w = Math.ceil(Math.max(hgt, tw + ew + 20));
  const c = document.createElement('canvas'); c.width = Math.ceil((w + pad * 2) * pr); c.height = Math.ceil((hgt + pad * 2) * pr);
  const g = c.getContext('2d', { willReadFrequently: true }); g.scale(pr, pr);
  const r = hgt / 2, x = pad, y = pad;
  const path = () => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + hgt, r); g.arcTo(x + w, y + hgt, x, y + hgt, r); g.arcTo(x, y + hgt, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  g.shadowColor = 'rgba(15,23,42,0.3)'; g.shadowBlur = 5; g.shadowOffsetY = 1.5;
  path(); g.fillStyle = '#ffffff'; g.fill();
  g.shadowColor = 'transparent';
  g.save(); g.translate(x + w / 2, y + hgt / 2); g.scale((w - 4) / w, (hgt - 4) / hgt); g.translate(-(x + w / 2), -(y + hgt / 2)); path(); g.fillStyle = color; g.fill(); g.restore();
  g.textBaseline = 'middle'; g.textAlign = 'left';
  let cx = x + (w - tw - ew) / 2;
  if (emoji) { g.font = `13px ${EMOJI_FONT}`; g.fillText(emoji, cx, y + hgt / 2 + 1); cx += ew; }
  g.font = `700 13px -apple-system, "Segoe UI", Roboto, sans-serif`; g.fillStyle = '#ffffff'; g.fillText(text, cx, y + hgt / 2 + 0.5);
  return { img: { width: c.width, height: c.height, data: new Uint8Array(g.getImageData(0, 0, c.width, c.height).data.buffer) }, pixelRatio: pr };
}

/** styleimagemissing: regenerate engine images on demand (clusters, badges). */
export function handleMissing(map, id) {
  id = String(id);
  if (map.hasImage(id)) return;
  // basemap sprite gaps (Liberty references a few icons its sprite lacks): draw nothing instead of warning
  if (!id.startsWith('uw:')) { map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) }); return; }
  const parts = id.split(':');
  if (parts[1] === 'L') {
    const [, , letter, color, d, emoji] = parts;
    ensureLetter(map, letter === '•' ? null : letter, color, +d || 40, emoji || null);
  } else if (parts[1] === 'cl') {
    const [, , color, emoji, ...rest] = parts;
    const p = drawPill({ color, emoji: emoji === '•' ? '' : emoji, text: rest.join(':') });
    map.addImage(id, p.img, { pixelRatio: p.pixelRatio });
  } else if (parts[1] !== 'arrow') {
    const [, emoji, color, d, r] = parts;
    ensureIcon(map, emoji === '•' ? null : emoji, color, +d || 32, r === 'r');
  }
}

export function iconKey(emoji, color, d, ring) { return `uw:${emoji || '•'}:${color}:${d}${ring ? ':r' : ''}`; }
export function ensureIcon(map, emoji, color, d, ring = false) {
  const key = iconKey(emoji, color, d, ring);
  if (!map.hasImage(key)) {
    const { img, pixelRatio } = drawBadge({ emoji, color, d, ring, dot: !emoji });
    map.addImage(key, img, { pixelRatio });
  }
  return key;
}

const isTemplate = (s) => typeof s === 'string' && /^\{[\w:.-]+\}$/.test(s.trim());
const tplKey = (s) => s.trim().slice(1, -1);
// style.color keywords (lines, routes, areas): "walk" = the theme's walk ink (--uw-walk by day, --uw-walk-night at
// night); "letter" = on a layer linkedTo the question's options, each feature takes its option's letter colour
// (features with no lettered option fall back to the walk ink)
export const COLOR_KEYWORDS = ['walk', 'letter'];
const isKeyword = (s) => COLOR_KEYWORDS.includes(s);
/** Colour expression: feature `color` prop, then {prop} template (or the option letter), then fixed colour. */
function colorExpr(style, fallback) {
  const parts = [['get', 'color']];
  let fixed = fallback;
  if (style === 'letter') parts.push(['get', '_lc']);
  else if (isTemplate(style)) parts.push(['get', tplKey(style)]);
  else if (typeof style === 'string' && !isKeyword(style)) fixed = style;
  return ['to-color', ...parts, fixed];
}
function plainColor(style, fallback) { return typeof style === 'string' && !isTemplate(style) && !isKeyword(style) ? style : fallback; }

/** Feel grid cells: _fade = 0.35 / 0.7 on the two outermost rings of the grid, 1 inside (soft edge instead of a hard box). */
function gridFade(feats) {
  const cells = [];
  for (const f of feats) {
    const r = f.geometry?.type === 'Polygon' ? f.geometry.coordinates[0] : null;
    if (!r || r.length < 4) continue;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [x, y] of r) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
    cells.push({ f, cx: (w + e) / 2, cy: (s + n) / 2, dx: e - w, dy: n - s });
  }
  if (cells.length < 9) return;
  const dx = cells[0].dx, dy = cells[0].dy;
  let W = Infinity, S = Infinity, E = -Infinity, N = -Infinity;
  for (const c of cells) { W = Math.min(W, c.cx); E = Math.max(E, c.cx); S = Math.min(S, c.cy); N = Math.max(N, c.cy); }
  for (const c of cells) {
    const ring = Math.min(Math.round((c.cx - W) / dx), Math.round((E - c.cx) / dx), Math.round((c.cy - S) / dy), Math.round((N - c.cy) / dy));
    if (ring <= 1) c.f.properties._fade = ring <= 0 ? 0.35 : 0.7;
  }
}

/**
 * 3×3 smoothing of the feel sub-scores from the c<col>-<row> ids (centre 0.4, each neighbour 0.075; missing and water
 * neighbours skipped, weights renormalised). Writes s_<key>; the raw values stay for the cell card. (§6.3)
 */
export function smoothGrid(feats) {
  const byId = new Map();
  for (const f of feats) { const m = /^c(-?\d+)-(-?\d+)$/.exec(String(f.properties.id)); if (m) byId.set(`${+m[1]},${+m[2]}`, f); }
  if (byId.size < 9) return false;
  for (const [k, f] of byId) {
    const p = f.properties; if (p.water) continue;
    const [c, r] = k.split(',').map(Number);
    for (const key of FEEL_KEYS) {
      if (typeof p[key] !== 'number') continue;
      let sum = 0.4 * p[key], w = 0.4;
      for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) {
        if (!dc && !dr) continue;
        const n = byId.get(`${c + dc},${r + dr}`)?.properties;
        if (!n || n.water || typeof n[key] !== 'number') continue;
        sum += 0.075 * n[key]; w += 0.075;
      }
      p['s_' + key] = Math.round((sum / w) * 1000) / 1000;
    }
  }
  return true;
}

// ---------- manager ----------
export class Layers {
  constructor(ctx) {
    this.ctx = ctx; this.map = ctx.map; this.list = []; this.byId = new Map(); this.stack = []; this.own = []; this.paletteI = 0;
    this.firstSymbol = (this.map.getStyle().layers.find((l) => l.type === 'symbol') || {}).id;
    this.hit = []; // [{id, rank, layer, kind}]
  }

  addMapLayer(spec, rank, beforeOverride) {
    const above = this.stack.find((s) => s.rank > rank);
    let before = beforeOverride || (above ? above.id : (rank < RANK.top ? this.firstSymbol : undefined));
    if (before && !this.map.getLayer(before)) before = undefined;
    this.map.addLayer(spec, before);
    this.stack.push({ id: spec.id, rank }); this.stack.sort((a, b) => a.rank - b.rank);
    return spec.id;
  }
  /** "walk" / "letter" colour keywords: the walk-ink fallback flips with the night look */
  inked(L, id, prop) {
    const c = L.style.color;
    if (!isKeyword(c)) return;
    this.own.push({ id, prop, fn: (k) => colorExpr(c, k === 'n' ? THEME_COLORS.walkNight : THEME_COLORS.walk) });
  }
  /** register paint colour that flips for the night look */
  themed(id, prop, day, night) { this.own.push({ id, prop, day: parseColor(day), night: parseColor(themeNight(night)) }); }
  applyTheme(dark) {
    const flip = Math.min(1, Math.max(0, (dark * dark * (3 - 2 * dark) - 0.35) / 0.3));
    for (const o of this.own) {
      if (!this.map.getLayer(o.id)) continue;
      if (o.fn) { const k = flip > 0.5 ? 'n' : 'd'; if (o.last === k) continue; o.last = k; this.map.setPaintProperty(o.id, o.prop, o.fn(k)); continue; }
      const t = o.prop.startsWith('text-') ? flip : dark;
      const c = mix(o.day, o.night, t); c[3] = o.day[3] + (o.night[3] - o.day[3]) * Math.min(1, Math.max(0, t)); // mix() keeps alpha; themes change it too
      const v = rgba(c);
      if (o.last === v) continue;
      o.last = v; this.map.setPaintProperty(o.id, o.prop, v);
    }
  }

  nextColor() { return PALETTE[this.paletteI++ % PALETTE.length]; }

  normalise(L, fc) {
    if (!fc || (fc.type !== 'FeatureCollection' && fc.type !== 'Feature')) throw new Error('not GeoJSON (expected a FeatureCollection)');
    const feats = (fc.type === 'Feature' ? [fc] : fc.features || []).filter((f) => f && f.geometry);
    const seen = new Set();
    feats.forEach((f, i) => {
      const p = f.properties = { ...(f.properties || {}) };
      let id = p.id != null ? String(p.id) : (f.id != null ? String(f.id) : `${L.id}-${i + 1}`);
      if (seen.has(id)) id = `${id}-${i + 1}`;
      seen.add(id); p.id = id; delete f.id;
      if (p.name == null) p.name = p.name_en || p.title || '';
    });
    return { type: 'FeatureCollection', features: feats };
  }

  defaults(def) {
    const t = def.type;
    const style = def.style || {};
    const L = {
      def, id: def.id, type: t, title: def.title || def.id, style,
      group: def.group || ({ points: 'Places', lines: 'Lines', route: 'Routes', legs: 'Trip', areas: 'Areas', grid: 'Feel', heat: 'Areas' }[t] || 'Layers'),
      visible: this.ctx.visibleOf ? this.ctx.visibleOf(def) : def.visible !== false,
      // with a question, an option's walk area is part of the option (tapping inside it is not a new selection)
      selectable: def.selectable != null ? def.selectable !== false && t !== 'heat' : t !== 'heat' && !(this.ctx.question && t === 'areas' && def.linkedTo && def.role !== 'verdict'),
      color: isKeyword(style.color) ? THEME_COLORS.walk : plainColor(style.color, null), emoji: style.emoji || null, size: SIZES[style.size] || (typeof style.size === 'number' ? style.size : SIZES.m),
      // time windows only apply when the time slider is on (otherwise the default hour would hide things forever)
      linkedTo: def.linkedTo || null, time: Array.isArray(def.time) && this.ctx.config?.time?.enabled ? def.time : null,
      cluster: !!def.cluster, compare: !!def.compare, mapLayers: [], sources: [], data: null, byFid: new Map(), error: null,
      attribution: def.attribution || null,
      tier: this.ctx.tierOf?.(def) || null, budgetLayers: [], budgetIds: null,
    };
    L.defVisible = L.visible;
    if (!L.color) L.color = t === 'grid' ? '#14b8a6' : this.nextColor();
    if (t === 'points' && L.tier === 'support' && this.ctx.question && !style.size) L.size = 30;
    if (t === 'points' && L.tier === 'context') L.size = SIZES.s;
    return L;
  }

  async add(def, data) {
    const known = ['id', 'title', 'type', 'data', 'style', 'label', 'group', 'visible', 'list', 'selectable', 'compare', 'card', 'cluster',
      'linkedTo', 'linkedIdle', 'time', 'animate', 'weight', 'attribution', 'legend', 'minzoom', 'maxzoom', 'note',
      'tier', 'rank', 'budget', 'role', 'lens', 'expert', 'links', 'glow', 'labelZoom', 'numbered', 'partial'];
    for (const k of Object.keys(def)) if (!known.includes(k)) console.warn(`[map] layer "${def.id}": unknown key "${k}" ignored`);
    const L = this.defaults(def);
    if (this.byId.has(L.id)) throw new Error(`duplicate layer id "${L.id}"`);
    // scripts write a top-level "attribution" into the GeoJSON they fetch (routing service, Wikipedia…)
    if (!L.attribution && data && typeof data.attribution === 'string') L.attribution = data.attribution;
    L.data = this.normalise(L, data);
    for (const f of L.data.features) L.byFid.set(f.properties.id, f);
    L.list = def.list != null ? !!def.list : (L.type === 'points' && !L.cluster && L.data.features.length <= 150);
    L.hasTimes = !!this.ctx.config?.time?.enabled && L.data.features.some((f) => f.properties.time_from != null);
    const fn = this['add_' + L.type];
    if (!fn) throw new Error(`unknown layer type "${L.type}" (use points, lines, areas, grid, route, legs, heat)`);
    try { fn.call(this, L); } catch (e) {
      // roll back anything half-added so the rest of the map stays clean
      for (const id of L.mapLayers) if (this.map.getLayer(id)) this.map.removeLayer(id);
      this.stack = this.stack.filter((s) => !L.mapLayers.includes(s.id));
      this.hit = this.hit.filter((x) => x.layer !== L);
      for (const s of L.sources) if (this.map.getSource(s)) this.map.removeSource(s);
      throw e;
    }
    this.list.push(L); this.byId.set(L.id, L);
    this.setVisible(L, L.visible, this.ctx.hour);
    return L;
  }

  src(L, suffix, data, extra = {}) {
    const id = `uw-${L.id}${suffix ? '-' + suffix : ''}`;
    this.map.addSource(id, { type: 'geojson', data, promoteId: 'id', attribution: L.attribution || undefined, ...extra });
    L.sources.push(id);
    return id;
  }
  ml(L, spec, rank, hitKind, budget) {
    if (L.def.minzoom != null) spec.minzoom = Math.max(spec.minzoom ?? 0, L.def.minzoom);
    else if (L.autoMinzoom != null && spec.minzoom == null) spec.minzoom = L.autoMinzoom;
    if (budget) L.budgetLayers.push({ id: spec.id, base: spec.filter || null, keep: budget === 'options' ? 'options' : budget === 'rest' ? 'rest' : 'all' });
    if (L.def.maxzoom != null) spec.maxzoom = L.def.maxzoom;
    this.addMapLayer(spec, rank);
    L.mapLayers.push(spec.id);
    if (hitKind && L.selectable) this.hit.push({ id: spec.id, rank, layer: L, kind: hitKind });
    this.hit.sort((a, b) => b.rank - a.rank);
  }
  timeFilter(L, base) {
    if (!L.hasTimes) return base;
    return base ? ['all', base, timeFilterExpr()] : timeFilterExpr();
  }
  linkedOpacity(L, strong, faint) {
    if (!L.linkedTo) return strong;
    // nothing selected: a single origin (one station, one park) shows its area fully; several origins show all lightly
    // (linkedIdle "show" | "faint" overrides). Selecting one origin lights up its own area and fades the others.
    const n = this.ctx.featureCount?.(L.linkedTo);
    const idleShow = L.def.linkedIdle === 'show' || (L.def.linkedIdle !== 'faint' && n === 1);
    const idle = idleShow ? strong : Math.min(strong, faint * 1.7);
    const sel = ['coalesce', ['global-state', 'sel_' + L.linkedTo], '#none'];
    return ['case', ['==', ['to-string', ['get', 'for']], sel], strong, ['==', sel, '#none'], idle, faint];
  }
  labelExpr(L) {
    const lab = L.def.label;
    if (!lab) return null;
    const en = this.ctx.config.basemap?.labels !== 'local';
    if (typeof lab === 'string' && lab.includes('{')) {
      const parts = []; let rest = lab; let m;
      while ((m = /\{([\w:.-]+)\}/.exec(rest))) { if (m.index) parts.push(rest.slice(0, m.index)); parts.push(['to-string', ['coalesce', ['get', m[1]], '']]); rest = rest.slice(m.index + m[0].length); }
      if (rest) parts.push(rest);
      return ['concat', '', ...parts];
    }
    if (lab === 'name' && en) return ['coalesce', ['get', 'name_en'], ['get', 'name']];
    return ['to-string', ['coalesce', ['get', lab], '']];
  }

  // ----- points -----
  add_points(L) {
    if (L.tier === 'option') return this.add_points_option(L);
    if (L.tier === 'context' && !(this.ctx.question?.kind === 'explore' && L.cluster)) return this.add_points_context(L);
    if (L.tier === 'support' && this.ctx.question) return this.add_points_support(L);
    return this.add_points_v0(L);
  }
  /** shared per-feature icon/colour prep */
  prepPoints(L, size = L.size) {
    for (const f of L.data.features) {
      const p = f.properties;
      const emoji = L.emoji || p.emoji, color = (typeof p.color === 'string' && parseColor(p.color)) ? p.color : L.color;
      const n = stopNumber(p, emoji);
      p._icon = n ? ensureLetter(this.map, n, color, size) : ensureIcon(this.map, emoji, color, size);
      p._emoji = emoji || ''; p._color = color;
    }
  }
  glow(L, sid, rank) {
    if (!L.style.glow) return;
    const h = ['to-number', ['global-state', 'hour'], 12];
    const timed = L.hasTimes;
    // fades in over the first half-hour of each feature's own window, and only shows inside it
    const op = timed ? ['let', 'dt', ['%', ['+', ['-', h, ['%', ['to-number', ['coalesce', ['get', 'time_from'], 0]], 24]], 24], 24],
      ['*', 0.6, ['min', 1, ['/', ['var', 'dt'], 0.5]]]] : 0.6;
    const spec = { id: `uw-${L.id}-glow`, type: 'circle', source: sid,
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 22, 15, 32], 'circle-blur': 0.85, 'circle-color': L.color, 'circle-opacity': op, 'circle-pitch-alignment': 'map' } };
    const f = this.timeFilter(L, null); if (f) spec.filter = f;
    this.ml(L, spec, rank, null, 'all');
  }
  /** option tier: 40 px letter badges that are never hidden by collisions, short-name label (+ live price) */
  add_points_option(L) {
    const map = this.map, Q = this.ctx.question;
    const optIds = [];
    for (const f of L.data.features) {
      const p = f.properties;
      const o = Q?.optionById(L.id, p.id);
      const emoji = L.emoji || p.emoji || '';
      if (o) {
        optIds.push(p.id);
        const color = o.color || ((typeof p.color === 'string' && parseColor(p.color)) ? p.color : L.color);
        p._icon = ensureLetter(map, o.letter, color, 40, o.letter ? null : emoji || '•');
        p._letter = o.letter || ''; p._color = color; p._emoji = emoji; p._short = o.short || p.name_en || p.name;
      } else {
        const color = (typeof p.color === 'string' && parseColor(p.color)) ? p.color : L.color;
        p._icon = ensureIcon(map, emoji, color, SIZES.s); p._emoji = emoji; p._color = color; p._letter = '';
      }
    }
    L.optionIds = optIds;
    const sid = this.src(L, '', L.data);
    const isOpt = ['in', ['get', 'id'], ['literal', optIds]];
    this.glow(L, sid, RANK.glow);
    // the rest of an options layer (find-place beyond the top N, ids not chosen) are context dots
    this.ml(L, { id: `uw-${L.id}-dot`, type: 'circle', source: sid, maxzoom: 16.5, filter: this.timeFilter(L, ['!', isOpt]),
      paint: { 'circle-radius': 4.5, 'circle-color': ['get', '_color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5, 'circle-opacity': 0.85, 'circle-stroke-opacity': 0.9 } }, RANK.ctxDot, 'point', 'rest');
    this.ml(L, { id: `uw-${L.id}-rest`, type: 'symbol', source: sid, minzoom: 16.5, filter: this.timeFilter(L, ['!', isOpt]),
      layout: { 'icon-image': ['get', '_icon'], 'icon-allow-overlap': false, 'icon-padding': 2 },
      paint: { 'icon-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0, 1] } }, RANK.ctxSym, 'point', 'rest');
    const short = ['coalesce', ['get', '_short'], ['get', 'name_en'], ['get', 'name']];
    const text = ['format', short, {}, ['case', ['has', '_price'], ['concat', '\n', ['get', '_price']], ''], { 'font-scale': 0.9, 'text-font': ['literal', FONT_BOLD] }];
    // option badges always show, and they take part in placement so no label (another option's name, a basemap
    // street) is ever drawn across a lettered pin
    const layout = { 'icon-image': ['get', '_icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': false,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.82, 13, 1],
      'symbol-sort-key': ['coalesce', ['get', '_rank'], 9], 'symbol-z-order': 'source',
      'text-field': text, 'text-font': FONT_BOLD, 'text-size': 12.5, 'text-anchor': 'top', 'text-offset': [0, 1.75], 'text-optional': true,
      'text-allow-overlap': false, 'text-max-width': 10, 'text-padding': 2 };
    const paint = { 'icon-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0, ['==', ['feature-state', 'vote'], 'down'], 0.45, 1],
      'text-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0, 1],
      'text-color': '#0f172a', 'text-halo-color': 'rgba(255,255,255,0.97)', 'text-halo-width': 2 };
    this.themed(`uw-${L.id}`, 'text-color', '#0f172a', '#f1f5f9');
    this.themed(`uw-${L.id}`, 'text-halo-color', 'rgba(255,255,255,0.97)', 'rgba(13,19,34,0.95)');
    this.ml(L, { id: `uw-${L.id}`, type: 'symbol', source: sid, filter: this.timeFilter(L, isOpt), layout, paint }, RANK.option, 'option');
    // 44 px hit area (thumbs miss 40 px badges at the edge)
    this.ml(L, { id: `uw-${L.id}-hit`, type: 'circle', source: sid, filter: this.timeFilter(L, isOpt),
      paint: { 'circle-radius': 22, 'circle-color': '#000000', 'circle-opacity': 0, 'circle-stroke-width': 0 } }, RANK.optionHit, 'option');
  }
  /** support tier: v0 badge (30 px), label only from z15.5 (or when selected / revealed), collides politely */
  add_points_support(L) {
    this.prepPoints(L);
    const sid = this.src(L, '', L.data);
    this.glow(L, sid, RANK.glow);
    const label = this.labelExpr(L);
    const layout = { 'icon-image': ['get', '_icon'], 'icon-allow-overlap': false, 'icon-ignore-placement': false, 'icon-padding': 2,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.7, 14, 0.88, 15.5, 1],
      'symbol-sort-key': ['+', 100, ['to-number', ['coalesce', ['get', '_prio'], 50]]] };
    const paint = { 'icon-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0, ['==', ['feature-state', 'vote'], 'down'], 0.42, this.linkedOpacity(L, 1, 0.5)] };
    if (label) {
      // a small support layer (≤ 12 places: the MRT stations, the night markets) is named from z13, with collisions;
      // a bigger one from z15.5 (selected / revealed ones always show their name)
      const lz = L.def.labelZoom ?? (L.data.features.length <= 12 ? 13 : 15.5);
      Object.assign(layout, { 'text-field': ['step', ['zoom'], '', lz, label], 'text-font': FONT, 'text-size': 11.5, 'text-anchor': 'top',
        'text-offset': [0, (L.size / 2 + 1) / 12], 'text-optional': true, 'text-max-width': 9, 'text-padding': 3 });
      Object.assign(paint, { 'text-color': '#1f2937', 'text-halo-color': 'rgba(255,255,255,0.95)', 'text-halo-width': 1.6,
        'text-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0, 1] });
      this.themed(`uw-${L.id}`, 'text-color', '#1f2937', '#e5e9f2');
      this.themed(`uw-${L.id}`, 'text-halo-color', 'rgba(255,255,255,0.95)', 'rgba(13,19,34,0.95)');
    }
    const spec = { id: `uw-${L.id}`, type: 'symbol', source: sid, layout, paint };
    const filter = this.timeFilter(L, null); if (filter) spec.filter = filter;
    this.ml(L, spec, RANK.support, 'point', 'all');
  }
  /** context tier: 9 px dots (no labels; the card names it); from z16.5 the small badge */
  add_points_context(L) {
    this.prepPoints(L, SIZES.s);
    const sid = this.src(L, '', L.data);
    this.glow(L, sid, RANK.glow);
    const filter = this.timeFilter(L, null);
    const dot = { id: `uw-${L.id}-dot`, type: 'circle', source: sid, maxzoom: 16.5,
      paint: { 'circle-radius': 4.5, 'circle-color': ['get', '_color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5,
        'circle-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0, 0.85], 'circle-stroke-opacity': 0.9 } };
    if (filter) dot.filter = filter;
    this.themed(`uw-${L.id}-dot`, 'circle-stroke-color', '#ffffff', 'rgba(13,19,34,0.9)');
    this.ml(L, dot, RANK.ctxDot, 'point', 'all');
    const sym = { id: `uw-${L.id}`, type: 'symbol', source: sid, minzoom: 16.5,
      layout: { 'icon-image': ['get', '_icon'], 'icon-allow-overlap': false, 'icon-padding': 1 },
      paint: { 'icon-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0, 1] } };
    if (filter) sym.filter = filter;
    this.ml(L, sym, RANK.ctxSym, 'point', 'all');
  }
  /** Pin budget: keep only these ids (null = all). Selected features are added by the caller. */
  setBudget(L, ids) {
    L.budgetIds = ids ? [...ids] : null;
    const opt = L.optionIds ? ['in', ['get', 'id'], ['literal', L.optionIds]] : null;
    for (const b of L.budgetLayers) {
      if (!this.map.getLayer(b.id)) continue;
      const parts = [];
      if (b.base) parts.push(b.base);
      if (ids && b.keep !== 'options') parts.push(['in', ['get', 'id'], ['literal', L.budgetIds]]);
      const f = parts.length === 0 ? null : parts.length === 1 ? parts[0] : ['all', ...parts];
      try { this.map.setFilter(b.id, f); } catch (e) { console.warn('[map] budget filter', b.id, e.message); }
    }
    return opt;
  }
  add_points_v0(L) {
    const map = this.map;
    // city-scale point sets turn into a blob at country zoom: fade them out below z9.5 unless the layer says otherwise
    const b = bbox(L.data.features);
    if (b && L.def.minzoom == null && Math.max(b[2] - b[0], b[3] - b[1]) < 0.25) L.autoMinzoom = 9.5;
    for (const f of L.data.features) {
      const p = f.properties;
      // an explicit style.emoji wins (so "make cafés 🍵" is a config edit); otherwise each feature's own emoji
      const emoji = L.emoji || p.emoji, color = (typeof p.color === 'string' && parseColor(p.color)) ? p.color : L.color;
      const n = stopNumber(p, emoji);
      p._icon = n ? ensureLetter(map, n, color, L.size) : ensureIcon(map, emoji, color, L.size);
      p._emoji = emoji || ''; p._color = color;
    }
    // cluster: true, or { "radius": 46, "maxZoom": 15 } to break clusters up sooner (smaller radius / lower maxZoom)
    const co = typeof L.def.cluster === 'object' && L.def.cluster ? L.def.cluster : {};
    const sid = this.src(L, '', L.data, L.cluster ? { cluster: true, clusterRadius: Math.max(10, Math.min(120, co.radius ?? 46)), clusterMaxZoom: Math.max(8, Math.min(18, co.maxZoom ?? 15)) } : {});
    if (L.cluster) {
      const em = L.emoji || '•', ps = L.size <= 28 ? 0.82 : L.size >= 36 ? 1.05 : 0.92;
      this.ml(L, { id: `uw-${L.id}-cluster`, type: 'symbol', source: sid, filter: ['has', 'point_count'],
        layout: { 'icon-image': ['concat', `uw:cl:${L.color}:${em}:`, ['to-string', ['get', 'point_count_abbreviated']]],
          'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-sort-key': ['-', 0, ['get', 'point_count']],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.78 * ps, 14, 0.9 * ps, 15, ps] } }, RANK.cluster, 'cluster');
    }
    const label = this.labelExpr(L);
    const layout = {
      'icon-image': ['get', '_icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': false, 'icon-padding': 0,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.62, 14, 0.82, 15.5, 1],
    };
    const paint = { 'icon-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0,
      ['==', ['feature-state', 'vote'], 'down'], 0.42, this.linkedOpacity(L, 1, 0.5)] };
    if (label) {
      Object.assign(layout, { 'text-field': label, 'text-font': FONT, 'text-size': L.size >= 36 ? 12.5 : 11.5, 'text-anchor': 'top',
        'text-offset': ['interpolate', ['linear'], ['zoom'], 11, ['literal', [0, (L.size * 0.31 + 1) / 12]], 14, ['literal', [0, (L.size * 0.41 + 1) / 12]], 15.5, ['literal', [0, (L.size / 2 + 1) / 12]]], 'text-optional': true, 'text-max-width': 9, 'text-padding': 3 });
      Object.assign(paint, { 'text-color': '#1f2937', 'text-halo-color': 'rgba(255,255,255,0.95)', 'text-halo-width': 1.6,
        'text-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0, ['==', ['feature-state', 'vote'], 'down'], 0.5, 1] });
      this.themed(`uw-${L.id}`, 'text-color', '#1f2937', '#e5e9f2');
      this.themed(`uw-${L.id}`, 'text-halo-color', 'rgba(255,255,255,0.95)', 'rgba(13,19,34,0.95)');
    }
    const filter = this.timeFilter(L, L.cluster ? ['!', ['has', 'point_count']] : null);
    const spec = { id: `uw-${L.id}`, type: 'symbol', source: sid, layout, paint };
    if (filter) spec.filter = filter;
    this.ml(L, spec, RANK.points + (L.size >= 36 ? 2 : L.size >= 30 ? 1 : 0), 'point');
  }

  // ----- lines -----
  add_lines(L) {
    const st = L.style, w = st.width || 3.5;
    const sid = this.src(L, '', L.data);
    const filter = this.timeFilter(L, null);
    const base = (spec) => (filter ? { ...spec, filter } : spec);
    const zw = (add) => ['interpolate', ['linear'], ['zoom'], 10, Math.max(1, w * 0.5) + add, 14, w + add, 18, w * 1.8 + add];
    const width = zw(0);
    this.ml(L, base({ id: `uw-${L.id}-casing`, type: 'line', source: sid, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': 'rgba(255,255,255,0.9)', 'line-width': zw(3), 'line-opacity': this.linkedOpacity(L, 0.9, 0.3) } }), RANK.lines);
    this.themed(`uw-${L.id}-casing`, 'line-color', 'rgba(255,255,255,0.9)', 'rgba(10,15,28,0.85)');
    const paint = { 'line-color': colorExpr(st.color, L.color), 'line-width': width, 'line-opacity': this.linkedOpacity(L, st.opacity ?? 1, 0.25) };
    const dash = st.dash === true ? [2, 1.5] : Array.isArray(st.dash) ? st.dash : null;
    if (dash) paint['line-dasharray'] = dash;
    this.ml(L, base({ id: `uw-${L.id}`, type: 'line', source: sid, layout: { 'line-cap': dash ? 'butt' : 'round', 'line-join': 'round' }, paint }), RANK.lines + 1, 'line');
    this.inked(L, `uw-${L.id}`, 'line-color');
  }

  // ----- areas -----
  add_areas(L) {
    if (L.def.role === 'verdict' || L.data.features.some((f) => f.properties.verdict)) return this.add_areas_verdict(L);
    const st = L.style, op = st.opacity ?? 0.16;
    const sid = this.src(L, '', L.data);
    const filter = this.timeFilter(L, null);
    const base = (spec) => (filter ? { ...spec, filter } : spec);
    // fills thin out at street zoom so they never wash the basemap out (the outline stays)
    const fo = (k) => this.linkedOpacity(L, Math.min(0.6, op * 1.6) * k, op * 0.22 * k);
    // with a question, walk areas of the options are outlines until one option is selected: three overlapping
    // tinted areas are noise at a glance; the selected option's own area fills in
    const qLinked = !!this.ctx.question && L.linkedTo && L.def.linkedIdle !== 'show';
    const fillFilter = qLinked ? ['==', ['to-string', ['get', 'for']], ['coalesce', ['global-state', 'sel_' + L.linkedTo], '#none']] : null;
    const fbase = (spec) => { const f = [filter, fillFilter].filter(Boolean); return f.length ? { ...spec, filter: f.length === 1 ? f[0] : ['all', ...f] } : spec; };
    this.ml(L, fbase({ id: `uw-${L.id}-fill`, type: 'fill', source: sid,
      paint: { 'fill-color': colorExpr(st.color, L.color), 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, fo(1), 16.5, fo(0.38)] } }), RANK.areas, 'area');
    this.inked(L, `uw-${L.id}-fill`, 'fill-color');
    if (st.outline !== false) {
      this.ml(L, base({ id: `uw-${L.id}-line`, type: 'line', source: sid, layout: { 'line-join': 'round' },
        paint: { 'line-color': colorExpr(st.color, L.color), 'line-width': 1.8, 'line-opacity': this.linkedOpacity(L, 0.9, 0.16),
          ...(st.dash ? { 'line-dasharray': Array.isArray(st.dash) ? st.dash : [2, 2] } : {}) } }), RANK.areas + 1);
      this.inked(L, `uw-${L.id}-line`, 'line-color');
    }
  }

  /** named areas ("Quiet at night · Dadaocheng"): soft fills by lens, a blurred edge, two-line labels (§6.2) */
  add_areas_verdict(L) {
    L.verdict = true;
    for (const f of L.data.features) {
      const p = f.properties;
      p._color = (typeof p.color === 'string' && parseColor(p.color)) ? p.color : AREA_COLORS[p.lens] || plainColor(L.style.color, null) || L.color;
      // a light tint of the lens colour for labels on the dusk/night looks (the full colour is too dark on dark land)
      const pc = parseColor(p._color); p._color_n = pc ? rgba([...mix(pc, [255, 255, 255, 1], 0.6).slice(0, 3), 1]) : '#f1f5f9';
    }
    const sid = this.src(L, '', L.data);
    const labels = L.data.features.map((f) => {
      const p = f.properties;
      const at = Array.isArray(p.label_at) && p.label_at.length === 2 ? p.label_at : f.geometry.type === 'Polygon' ? ringCentroid(f.geometry.coordinates[0]) : center(f.geometry);
      return { type: 'Feature', geometry: { type: 'Point', coordinates: at }, properties: { id: p.id, verdict: p.verdict || '', name: p.name || '', lens: p.lens || '', time_from: p.time_from, time_to: p.time_to, rank: p.rank ?? 9, _color: p._color, _color_n: p._color_n, _len: Math.max(String(p.verdict || '').length, String(p.name || '').length) } };
    });
    L.labelData = { type: 'FeatureCollection', features: labels };
    const lsid = this.src(L, 'labels', L.labelData);
    const filter = this.timeFilter(L, null);
    const base = (spec) => { if (filter) spec.filter = filter; return spec; };
    this.ml(L, base({ id: `uw-${L.id}-fill`, type: 'fill', source: sid,
      paint: { 'fill-color': ['get', '_color'], 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.16, 16, 0.08] } }), RANK.areas, 'area', 'all');
    this.ml(L, base({ id: `uw-${L.id}-edge`, type: 'line', source: sid, layout: { 'line-join': 'round' },
      paint: { 'line-color': ['get', '_color'], 'line-width': 6, 'line-blur': 4, 'line-opacity': 0.35 } }), RANK.areas + 1, null, 'all');
    this.ml(L, base({ id: `uw-${L.id}-label`, type: 'symbol', source: lsid,
      layout: { 'text-field': ['format', ['get', 'verdict'], { 'text-font': ['literal', FONT_BOLD], 'font-scale': 1 }, '\n', {}, ['get', 'name'], { 'font-scale': 0.85 }],
        'text-font': FONT, 'text-size': 13, 'text-max-width': 12, 'text-line-height': 1.15, 'symbol-sort-key': ['+', 50, ['to-number', ['coalesce', ['get', 'rank'], 9]]],
        'text-variable-anchor': ['center', 'top', 'bottom', 'left', 'right'], 'text-radial-offset': 0.6, 'text-justify': 'auto', 'text-padding': 4 },
      // "edge": the engine hides a label that would run off the screen or under the button column (§6.2)
      paint: { 'text-color': ['get', '_color'], 'text-halo-color': 'rgba(255,255,255,0.96)', 'text-halo-width': 2,
        'text-opacity': ['case', ['boolean', ['feature-state', 'edge'], false], 0, 1] } }), RANK.areaLabels, 'area', 'all');
    this.themed(`uw-${L.id}-label`, 'text-halo-color', 'rgba(255,255,255,0.96)', 'rgba(13,19,34,0.95)');
    this.own.push({ id: `uw-${L.id}-label`, prop: 'text-color', fn: (k) => ['get', k === 'n' ? '_color_n' : '_color'] });
  }

  // ----- grid (feel) -----
  add_grid(L) {
    gridFade(L.data.features);
    smoothGrid(L.data.features);
    L.expert = !!this.ctx.gridExpert?.(L);
    const sid = this.src(L, '', L.data);
    const num = (k) => ['to-number', ['coalesce', ['get', 's_' + k], ['get', k]], 0];
    const night = ['==', ['global-state', 'night'], true];
    const v = ['to-number', ['global-state', 'vibe'], 0.5];
    const calm = ['case', night, num('calm_night'), num('calm_day')];
    const lively = ['case', night, num('lively_night'), num('lively_day')];
    const score = ['+', ['*', 0.85, ['+', ['*', ['-', 1, v], calm], ['*', v, lively]]], ['*', 0.15, num('green')]];
    L.scoreExpr = score;
    if (L.expert) {
      // expert view: 3 honest classes instead of a continuous ramp; cells outside every option's walk area fade
      const inside = ['to-number', ['coalesce', ['get', '_in'], 1]];
      this.ml(L, { id: `uw-${L.id}`, type: 'fill', source: sid, paint: {
        'fill-color': ['step', score, '#cbd5e1', 0.33, '#5eead4', 0.66, '#059669'],
        'fill-opacity': ['*', ['coalesce', ['get', '_fade'], 1], inside, ['step', score, 0.25, 0.33, 0.4, 0.66, 0.55]],
        'fill-antialias': false,
      }, filter: ['!', ['to-boolean', ['get', 'water']]] }, RANK.grid, 'cell');
      this.ml(L, { id: `uw-${L.id}-line`, type: 'line', source: sid, minzoom: 14.5, filter: ['!', ['to-boolean', ['get', 'water']]], paint: { 'line-color': 'rgba(255,255,255,0.35)', 'line-width': 0.6 } }, RANK.grid + 1);
      this.themed(`uw-${L.id}-line`, 'line-color', 'rgba(255,255,255,0.35)', 'rgba(255,255,255,0.08)');
      return;
    }
    this.ml(L, { id: `uw-${L.id}`, type: 'fill', source: sid, paint: {
      'fill-color': ['interpolate', ['linear'], score, 0, '#94a3b8', 0.35, '#a9c6c3', 0.55, '#5eead4', 0.75, '#14b8a6', 1, '#16a34a'],
      // water cells (no estimate) are transparent; the outer two rings fade so the grid has no hard rectangular edge
      'fill-opacity': ['interpolate', ['linear'], ['zoom'],
        12, ['*', ['coalesce', ['get', '_fade'], 1], ['interpolate', ['linear'], score, 0, 0.16, 0.5, 0.4, 1, 0.62]],
        15, ['*', ['coalesce', ['get', '_fade'], 1], ['interpolate', ['linear'], score, 0, 0.1, 0.5, 0.28, 1, 0.48]],
        17, ['*', ['coalesce', ['get', '_fade'], 1], ['interpolate', ['linear'], score, 0, 0.05, 0.5, 0.15, 1, 0.3]]],
      'fill-antialias': false,
    }, filter: ['!', ['to-boolean', ['get', 'water']]] }, RANK.grid, 'cell');
    this.ml(L, { id: `uw-${L.id}-line`, type: 'line', source: sid, minzoom: 14.5, filter: ['!', ['to-boolean', ['get', 'water']]], paint: { 'line-color': 'rgba(255,255,255,0.35)', 'line-width': 0.6 } }, RANK.grid + 1);
    this.themed(`uw-${L.id}-line`, 'line-color', 'rgba(255,255,255,0.35)', 'rgba(255,255,255,0.08)');
  }

  // ----- route -----
  add_route(L) {
    const st = L.style, w = st.width || 5;
    const sid = this.src(L, '', L.data);
    const zw = (add) => ['interpolate', ['linear'], ['zoom'], 11, Math.max(2, w * 0.6) + add, 15, w + add, 18, w * 1.6 + add];
    const width = zw(0);
    this.ml(L, { id: `uw-${L.id}-casing`, type: 'line', source: sid, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': 'rgba(255,255,255,0.95)', 'line-width': zw(4), 'line-opacity': this.linkedOpacity(L, 1, 0.3) } }, RANK.route);
    this.themed(`uw-${L.id}-casing`, 'line-color', 'rgba(255,255,255,0.95)', 'rgba(10,15,28,0.9)');
    this.ml(L, { id: `uw-${L.id}`, type: 'line', source: sid, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': colorExpr(st.color, L.color), 'line-width': width, 'line-opacity': this.linkedOpacity(L, 1, 0.3),
        ...(st.dash ? { 'line-dasharray': Array.isArray(st.dash) ? st.dash : [1.5, 1.5] } : {}) } }, RANK.route + 1, 'line');
    this.inked(L, `uw-${L.id}`, 'line-color');
    if (!this.map.hasImage('uw:arrow')) { const a = drawArrow(); this.map.addImage('uw:arrow', a.img, { pixelRatio: a.pixelRatio }); }
    this.ml(L, { id: `uw-${L.id}-arrows`, type: 'symbol', source: sid, minzoom: 13,
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 70, 'icon-image': 'uw:arrow', 'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.7, 17, 1.1],
        'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map' },
      paint: { 'icon-opacity': this.linkedOpacity(L, 0.95, 0.3) } }, RANK.arrows);
  }

  // ----- legs -----
  add_legs(L) {
    const st = L.style, color = L.color;
    const arcs = [], badges = [], stops = new Map();
    const addStop = (c, name, id) => { const k = c[0].toFixed(5) + ',' + c[1].toFixed(5); if (!stops.has(k)) stops.set(k, { type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { id: id || 'stop-' + k, name: name || '' } }); else if (name && !stops.get(k).properties.name) stops.get(k).properties.name = name; };
    // curvature alternates leg by leg; a leg that goes back over an earlier pair (Chiayi → Alishan → Chiayi) reuses that
    // pair's sign, which with the ends swapped bends it to the other side instead of drawing on top of the first one
    const pairSign = new Map();
    L.data.features.forEach((f, i) => {
      const p = f.properties; const coords = lineCoords(f.geometry);
      if (coords.length < 2) return;
      const k = (c) => c[0].toFixed(4) + ',' + c[1].toFixed(4);
      const a0 = k(coords[0]), b0 = k(coords[coords.length - 1]);
      const sign = pairSign.get(b0 + '|' + a0) ?? (i % 2 ? -1 : 1);
      pairSign.set(a0 + '|' + b0, sign);
      // a leg that follows the real track (uw legs --follow) is drawn as it is; others are arcs between the stops
      const path = [];
      if (p.track && coords.length > 2) path.push(...coords);
      else for (let j = 1; j < coords.length; j++) { const seg = arc(coords[j - 1], coords[j], 0.16 * sign); path.push(...(j > 1 ? seg.slice(1) : seg)); }
      p._arc = path;
      arcs.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: path }, properties: { ...p } });
      const mid = path[Math.floor(path.length / 2)];
      const mode = String(p.mode || '').toLowerCase();
      const emoji = p.emoji || MODE_EMOJI[mode] || '➜';
      const icon = ensureIcon(this.map, emoji, color, 30, true);
      badges.push({ type: 'Feature', geometry: { type: 'Point', coordinates: mid }, properties: { id: p.id, name: p.name, _icon: icon, _label: p.duration ? String(p.duration) : '' } });
      p._emoji = emoji; p._icon = icon; p._color = color;
      addStop(coords[0], p.from_name || p.from, p.from_id);
      addStop(coords[coords.length - 1], p.to_name || p.to, p.to_id);
    });
    // a route question numbers its stops in travel order (1, 2, 3… with one dot per night under the name) and
    // shows the direction on the arcs (ENGINE-SPEC §1.2): "numbered": false keeps plain stop circles
    const numbered = L.def.numbered === true || (L.def.numbered !== false && this.ctx.question?.kind === 'plan-route');
    let numFeats = [];
    if (numbered) {
      const ordered = L.data.features.map((f, i) => ({ f, i })).sort((a, b) => (a.f.properties.order ?? a.i) - (b.f.properties.order ?? b.i)).map((x) => x.f);
      const seen = new Map();
      const addNum = (id, c, name) => {
        const key = id != null ? String(id) : c[0].toFixed(4) + ',' + c[1].toFixed(4);
        if (seen.has(key)) return;
        const st = id != null ? this.ctx.stopInfo?.(id) : null;
        const nights = parseInt(String(st?.props?.nights ?? ''), 10);
        const dots = Number.isFinite(nights) && nights > 0 ? ' ' + '●'.repeat(Math.min(nights, 5)) : '';
        const n = String(seen.size + 1);
        seen.set(key, true);
        numFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: st?.f?.geometry?.type === 'Point' ? st.f.geometry.coordinates : c },
          properties: { id: st ? st.props.id : key, n, _layer: st?.layer || null, _icon: ensureLetter(this.map, n, color, 26), _label: `${st?.name || name || ''}${dots}`.trim() } });
      };
      for (const f of ordered) {
        const p = f.properties, cs = lineCoords(f.geometry); if (cs.length < 2) continue;
        addNum(p.from_id ?? p.from, cs[0], p.from_name || p.from);
        addNum(p.to_id ?? p.to, cs[cs.length - 1], p.to_name || p.to);
      }
      L.numbered = true;
    }
    const arcsSrc = this.src(L, 'arcs', { type: 'FeatureCollection', features: arcs });
    const badgeSrc = this.src(L, 'badges', { type: 'FeatureCollection', features: badges });
    const stopSrc = this.src(L, 'stops', { type: 'FeatureCollection', features: numbered ? [] : [...stops.values()] });
    const flightDash = ['match', ['downcase', ['to-string', ['get', 'mode']]], ['flight', 'plane', 'fly'], ['literal', [1.5, 1.6]], ['literal', [1, 0]]];
    this.ml(L, { id: `uw-${L.id}-casing`, type: 'line', source: arcsSrc, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': 'rgba(255,255,255,0.9)', 'line-width': (st.width || 3.5) + 3.5 } }, RANK.legs);
    this.themed(`uw-${L.id}-casing`, 'line-color', 'rgba(255,255,255,0.9)', 'rgba(10,15,28,0.85)');
    this.ml(L, { id: `uw-${L.id}`, type: 'line', source: arcsSrc, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': colorExpr(st.color, color), 'line-width': st.width || 3.5, 'line-dasharray': flightDash } }, RANK.legs + 1, 'line');
    this.ml(L, { id: `uw-${L.id}-stops`, type: 'circle', source: stopSrc,
      paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-color': color, 'circle-stroke-width': 3 } }, RANK.legsTop);
    this.ml(L, { id: `uw-${L.id}-stops-label`, type: 'symbol', source: stopSrc,
      layout: { 'text-field': ['get', 'name'], 'text-font': FONT_BOLD, 'text-size': 12.5, 'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
        'text-radial-offset': 0.85, 'text-optional': true, 'symbol-sort-key': 0 },
      paint: { 'text-color': '#0f172a', 'text-halo-color': 'rgba(255,255,255,0.95)', 'text-halo-width': 1.8 } }, RANK.legsTop + 1);
    this.themed(`uw-${L.id}-stops-label`, 'text-color', '#0f172a', '#eef2f8');
    this.themed(`uw-${L.id}-stops-label`, 'text-halo-color', 'rgba(255,255,255,0.95)', 'rgba(13,19,34,0.95)');
    if (numbered) {
      if (!this.map.hasImage('uw:arrow')) { const a = drawArrow(); this.map.addImage('uw:arrow', a.img, { pixelRatio: a.pixelRatio }); }
      this.ml(L, { id: `uw-${L.id}-arrows`, type: 'symbol', source: arcsSrc,
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 90, 'icon-image': 'uw:arrow', 'icon-rotation-alignment': 'map',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.55, 10, 0.9], 'icon-allow-overlap': true, 'icon-ignore-placement': true } }, RANK.legsTop - 1);
      const numSrc = this.src(L, 'num', { type: 'FeatureCollection', features: numFeats });
      // the badges always show; their names take part in label collision (placed before the basemap's, so a basemap
      // "Taipei" never sits on top of the stop's own "Taipei ●●●")
      this.ml(L, { id: `uw-${L.id}-num`, type: 'symbol', source: numSrc,
        layout: { 'icon-image': ['get', '_icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': false, 'icon-padding': 0,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.85, 10, 1], 'symbol-sort-key': ['to-number', ['get', 'n']] } }, RANK.legsTop + 3, 'reveal');
      this.ml(L, { id: `uw-${L.id}-num-label`, type: 'symbol', source: numSrc,
        layout: { 'text-field': ['get', '_label'], 'text-font': FONT_BOLD, 'text-size': 12.5, 'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
          'text-radial-offset': 1.6, 'text-justify': 'auto', 'text-padding': 1, 'symbol-sort-key': ['to-number', ['get', 'n']] },
        paint: { 'text-color': '#0f172a', 'text-halo-color': 'rgba(255,255,255,0.95)', 'text-halo-width': 1.8 } }, RANK.legsTop + 2);
      this.themed(`uw-${L.id}-num-label`, 'text-color', '#0f172a', '#eef2f8');
      this.themed(`uw-${L.id}-num-label`, 'text-halo-color', 'rgba(255,255,255,0.95)', 'rgba(13,19,34,0.95)');
    }
    // a route question: leg badges only from z8, where they no longer pile up on each other
    this.ml(L, { id: `uw-${L.id}-badges`, type: 'symbol', source: badgeSrc, ...(this.ctx.question?.kind === 'plan-route' ? { minzoom: 8 } : {}),
      layout: { 'icon-image': ['get', '_icon'], 'icon-allow-overlap': true, 'text-field': ['get', '_label'], 'text-font': FONT_BOLD, 'text-size': 12,
        'text-anchor': 'left', 'text-offset': [1.45, 0], 'text-optional': true, 'text-allow-overlap': false },
      paint: { 'text-color': color, 'text-halo-color': 'rgba(255,255,255,0.97)', 'text-halo-width': 2 } }, RANK.legsTop + 2, 'leg');
    this.themed(`uw-${L.id}-badges`, 'text-halo-color', 'rgba(255,255,255,0.97)', 'rgba(13,19,34,0.95)');
  }

  // ----- heat -----
  add_heat(L) {
    const sid = this.src(L, '', L.data);
    const wkey = L.def.weight;
    const weight = wkey ? ['to-number', ['coalesce', ['get', wkey], 1]] : 1;
    this.ml(L, { id: `uw-${L.id}`, type: 'heatmap', source: sid, maxzoom: 17, paint: {
      'heatmap-weight': weight,
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 16, 1.6],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 26, 16, 36],
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.15, 'rgba(253,230,138,0.45)', 0.35, 'rgba(251,191,36,0.7)',
        0.55, 'rgba(249,115,22,0.8)', 0.8, 'rgba(225,29,72,0.85)', 1, 'rgba(159,18,57,0.9)'],
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 14.5, 0.85, 16.5, 0],
    } }, RANK.heat);
    this.ml(L, { id: `uw-${L.id}-pts`, type: 'circle', source: sid, minzoom: 14.5, paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14.5, 3, 18, 8], 'circle-color': THEME_COLORS.heatPt,
      'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5, 'circle-opacity': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 15.5, 0.9],
      'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 15.5, 1] } }, RANK.heatPts, 'point');
  }

  // ----- visibility -----
  setVisible(L, on, hour) {
    L.visible = !!on;
    const shown = L.visible && (!L.time || inWindow(hour, L.time));
    if (L.shown === shown) return; // the time slider calls this on every tick
    for (const id of L.mapLayers) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', shown ? 'visible' : 'none');
    L.shown = shown;
  }
  refreshTimes(hour) { for (const L of this.list) if (L.time) this.setVisible(L, L.visible, hour); }

  hitLayerIds() { return this.hit.filter((x) => this.map.getLayer(x.id)).map((x) => x.id); }
  hitInfo(mapLayerId) { return this.hit.find((x) => x.id === mapLayerId); }

  featureCenter(L, f) {
    if (L.type === 'legs' && f.properties._arc) return f.properties._arc[Math.floor(f.properties._arc.length / 2)];
    return center(f.geometry);
  }
}
