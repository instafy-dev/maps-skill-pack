// map-pack engine: follow mode (Instafy docs/Follow-Mode.md). One person presents the map, the others follow live: their copies
// take the presenter's camera, selection, open tab, day and lens. Kit-owned file.
//
// IN  (from the host frame, the same frame / origin checks as host.js's layout; or its MessagePort / uw.ingest)
//   { source: "instafy-host", v: 1, type: "present", on: true | false, share: { location: false } }   start / stop sending views
//   { source: "instafy-host", v: 1, type: "apply-view", seq, payload, from: { id, name }, smooth: true | false }
//   { source: "instafy-host", v: 1, type: "apply-tap", payload: { x, y, at? }, from: { id, name } }
// OUT (only to the origin that asked us to present)
//   { source: "instafy-map", v: 1, type: "view", seq, payload }       ≤ 2 KB, ≤ 10/s, the latest wins, with a trailing send
//   { source: "instafy-map", v: 1, type: "tap", seq, payload: { x, y, at } }   x, y in 0..1 of the frame; at = [lng, lat]
//   { source: "instafy-map", v: 1, type: "interact" }                  the person touched / panned / typed on the map themselves
//
// The view payload describes what is visible, not pixels (a phone and a desktop frame show the same area):
//   { k: "map", s: "<hash state without the camera>", cam: { b: [w, s, e, n], br, pi } | null, tab, card, lay, snap }
//   b is the visible part of the map (outside the sheet / side panel) as an unrotated box. cam is null while the camera
//   sits on the presenter's own position (after "Show my location", until they pan) unless the host said
//   share.location: true. A follower whose layout class differs (phone sheet vs desktop side panel) keeps its own snap.
// Applying a view never echoes it back (a presenting frame ignores apply-view, and only the person's own pointer, wheel
// and key events count as "interact").

export const FOLLOW_TYPES = ['present', 'apply-view', 'apply-tap'];
export const MAX_VIEW_BYTES = 2048;
export const VIEW_GAP_MS = 100; // at most 10 views a second
export const TAP_GAP_MS = 200; // at most 5 taps a second
export const INTERACT_GAP_MS = 300;
/** after the person's own gesture, smooth views are ignored this long (one already in flight must not yank the map) */
export const QUIET_AFTER_TOUCH_MS = 400;
export const SNAPS = ['peek', 'half', 'full'];

const TILE = 512;
const MAX_LAT = 85.051129;
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// ---------------- the hash state (shared with engine.js readHash / writeHash) ----------------
/** "t=14&s=hotels:lore&l=sleep&@=…" → { t, v, s, off, on, d, at, p, l, w } */
export function parseState(raw) {
  const out = {};
  for (const part of String(raw || '').replace(/^#/, '').split('&')) {
    const i = part.indexOf('='); if (i < 0) continue;
    let k, v;
    try { k = decodeURIComponent(part.slice(0, i)); v = decodeURIComponent(part.slice(i + 1)); } catch { continue; }
    out[k] = v;
  }
  const num = (x) => (x == null || x === '' || isNaN(+x) ? null : +x);
  const at = out['@'] ? out['@'].split(',').map(Number) : null;
  const w = {};
  for (const kv of (out.w || '').split(',')) { const [k, x] = kv.split(':'); if (k && x != null && isFinite(+x)) w[k] = +x; }
  return { t: num(out.t), v: num(out.v), s: out.s || null, off: out.off ? out.off.split(',') : [], on: out.on ? out.on.split(',') : [], d: num(out.d),
    at: at && at.length >= 3 && at.every(isFinite) ? at : null, p: out.p ? out.p.split(',').map(Number) : null,
    l: out.l != null ? out.l : undefined, w: Object.keys(w).length ? w : null };
}

// ---------------- the camera as a box (Web Mercator, MapLibre's 512 px tiles) ----------------
const mx = (lng) => (lng + 180) / 360;
const my = (lat) => { const s = Math.sin(clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const lngOf = (x) => x * 360 - 180;
const latOf = (y) => (360 / Math.PI) * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - 90;

/** the area a width × height px window shows around center at zoom, unrotated: [w, s, e, n] */
export function boxOf({ center, zoom, width, height }) {
  const world = TILE * Math.pow(2, zoom);
  const cx = mx(center[0]), cy = my(center[1]);
  const hw = width / 2 / world, hh = height / 2 / world;
  return [r5(lngOf(cx - hw)), r5(clamp(latOf(cy + hh), -MAX_LAT, MAX_LAT)), r5(lngOf(cx + hw)), r5(clamp(latOf(cy - hh), -MAX_LAT, MAX_LAT))];
}
/** the center and zoom that fit box (all of it) into a width × height px window */
export function cameraFor(box, { width, height }) {
  const [w, s, e, n] = box;
  const x0 = mx(w), x1 = mx(e), y0 = my(n), y1 = my(s);
  const dx = Math.max(1e-12, x1 - x0), dy = Math.max(1e-12, y1 - y0);
  const zoom = clamp(Math.log2(Math.min(Math.max(1, width) / (dx * TILE), Math.max(1, height) / (dy * TILE))), 0, 22);
  return { center: [lngOf((x0 + x1) / 2), latOf((y0 + y1) / 2)], zoom };
}

// ---------------- the view payload ----------------
export function viewBytes(p) { try { return new TextEncoder().encode(JSON.stringify(p)).length; } catch { return Infinity; } }
const dropKeys = (s, keys) => String(s || '').split('&').filter((x) => x && !keys.includes(x.slice(0, x.indexOf('=')))).join('&');

/** build a view payload; over 2 KB it drops the layer toggles, then the weights, then everything but the camera */
export function encodeView({ s = '', cam = null, tab = null, card = false, lay = 'sheet', snap = null } = {}) {
  const p = { k: 'map', s: String(s || ''), cam: cam && Array.isArray(cam.b) && cam.b.length === 4 && cam.b.every(isNum)
    ? { b: cam.b.map(r5), br: isNum(cam.br) ? Math.round(cam.br) : 0, pi: isNum(cam.pi) ? Math.round(cam.pi) : 0 } : null,
  tab: typeof tab === 'string' ? tab.slice(0, 40) : null, card: !!card, lay: lay === 'side' ? 'side' : 'sheet', snap: SNAPS.includes(snap) ? snap : null };
  for (const keys of [['off', 'on'], ['w'], ['off', 'on', 'w', 'p', 's']]) {
    if (viewBytes(p) <= MAX_VIEW_BYTES) return p;
    p.s = dropKeys(p.s, keys); p.trimmed = true;
  }
  if (viewBytes(p) <= MAX_VIEW_BYTES) return p;
  return { k: 'map', s: '', cam: p.cam, tab: null, card: false, lay: p.lay, snap: null, trimmed: true };
}
/** a payload from the host → a clean view, or null */
export function decodeView(p) {
  if (!p || typeof p !== 'object' || p.k !== 'map') return null;
  if (viewBytes(p) > MAX_VIEW_BYTES) return null;
  let cam = null;
  const c = p.cam;
  if (c && typeof c === 'object' && Array.isArray(c.b) && c.b.length === 4 && c.b.every(isNum)) {
    const [w, s, e, n] = c.b;
    if (w >= -540 && e <= 540 && w < e && s >= -90 && n <= 90 && s < n) cam = { b: [w, s, e, n], br: isNum(c.br) ? clamp(c.br, -360, 360) : 0, pi: isNum(c.pi) ? clamp(c.pi, 0, 85) : 0 };
  }
  return { s: typeof p.s === 'string' ? p.s : '', cam, tab: typeof p.tab === 'string' && /^[\w-]{1,40}$/.test(p.tab) ? p.tab : null, card: p.card === true,
    lay: p.lay === 'side' ? 'side' : 'sheet', snap: SNAPS.includes(p.snap) ? p.snap : null };
}
/** a tap from the host → { x, y, at } (x, y in 0..1, at = [lng, lat] or null), or null */
export function decodeTap(p) {
  if (!p || typeof p !== 'object') return null;
  const x = isNum(p.x) && p.x >= 0 && p.x <= 1 ? p.x : null, y = isNum(p.y) && p.y >= 0 && p.y <= 1 ? p.y : null;
  const at = Array.isArray(p.at) && p.at.length === 2 && p.at.every(isNum) && Math.abs(p.at[0]) <= 180 && Math.abs(p.at[1]) <= 90 ? [p.at[0], p.at[1]] : null;
  if (!at && (x == null || y == null)) return null;
  return { x, y, at };
}
/** the presenter's name, one short line */
export function fromName(from) {
  const s = from && typeof from.name === 'string' ? from.name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return s ? [...s].slice(0, 40).join('') : null;
}
/** the person's own gesture (not the host's shortcuts, not a bare modifier) */
export function isOwnGesture(e) {
  if (!e || e.isTrusted === false) return false;
  if (e.type === 'keydown') {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    return !['Shift', 'Control', 'Alt', 'Meta', 'F6', 'Tab', 'CapsLock'].includes(e.key);
  }
  return ['pointerdown', 'wheel', 'touchstart', 'mousedown'].includes(e.type);
}

export class FollowLink {
  /** @param {object} o { snapshot() → payload | null, apply(view, { smooth, from, seq }), tap({ x, y, at }, from),
   *  send(msg, origin), now(), setTimeout, clearTimeout, source } */
  constructor({ snapshot = () => null, apply = () => {}, tap = () => {}, send = () => {}, now = () => Date.now(),
    setTimeout: st = (fn, ms) => setTimeout(fn, ms), clearTimeout: ct = (t) => clearTimeout(t), source = 'instafy-map' } = {}) {
    Object.assign(this, { snapshot, applyFn: apply, tapFn: tap, sendFn: send, now, st, ct, source });
    this.presenting = false; this.share = { location: false }; this.origin = null;
    this.seq = 0; this.last = null; this.lastAt = -Infinity; this.timer = null;
    this.lastTap = -Infinity; this.following = false; this.touchedAt = -Infinity; this.lastInteract = -Infinity;
    this.pending = null; this.ready = false;
  }
  /** a follow message from the host; origin = where views go back to. Returns true when it was one. */
  handle(d, origin = null) {
    if (!d || typeof d !== 'object' || d.source !== 'instafy-host' || !FOLLOW_TYPES.includes(d.type)) return false;
    if (d.v != null && d.v !== 1) return false;
    if (origin && origin !== 'null') this.origin = origin;
    if (d.type === 'present') {
      if (d.on === true) {
        this.presenting = true; this.following = false; this.pending = null;
        this.share = { location: !!(d.share && d.share.location === true) };
        this.last = null; this.flush();
      } else this.stop();
      return true;
    }
    if (this.presenting) return true; // a presenter never follows (and never echoes)
    if (d.type === 'apply-view') {
      const smooth = d.smooth !== false;
      if (smooth && this.now() - this.touchedAt < QUIET_AFTER_TOUCH_MS) return true;
      const v = decodeView(d.payload); if (!v) return true;
      this.following = true;
      const meta = { smooth, from: d.from && typeof d.from === 'object' ? { id: typeof d.from.id === 'string' ? d.from.id : null, name: fromName(d.from) } : null, seq: isNum(d.seq) ? d.seq : null };
      if (!this.ready) { this.pending = [v, meta]; return true; }
      try { this.applyFn(v, meta); } catch (e) { console.warn('[map] apply-view:', e?.message); }
      return true;
    }
    const t = decodeTap(d.payload);
    if (t) { try { this.tapFn(t, d.from && typeof d.from === 'object' ? { name: fromName(d.from) } : null); } catch (e) { console.warn('[map] apply-tap:', e?.message); } }
    return true;
  }
  /** the map is ready: send the first view, apply the one that came early */
  start() {
    this.ready = true;
    if (this.pending) { const [v, m] = this.pending; this.pending = null; try { this.applyFn(v, { ...m, smooth: false }); } catch (e) { console.warn('[map] apply-view:', e?.message); } }
    this.changed();
  }
  stop() { this.presenting = false; if (this.timer) { this.ct(this.timer); this.timer = null; } this.last = null; }
  /** something the view holds changed: send it (at most every VIEW_GAP_MS, the latest wins, with a trailing send) */
  changed() {
    if (!this.presenting || this.timer) return;
    const wait = VIEW_GAP_MS - (this.now() - this.lastAt);
    if (wait <= 0) { this.flush(); return; }
    this.timer = this.st(() => { this.timer = null; this.flush(); }, wait);
  }
  flush() {
    if (!this.presenting) return false;
    if (this.timer) { this.ct(this.timer); this.timer = null; }
    let p = null;
    try { p = this.snapshot({ location: this.share.location }); } catch (e) { console.warn('[map] view:', e?.message); }
    if (!p) return false;
    const key = JSON.stringify(p);
    if (key === this.last) return false;
    if (viewBytes(p) > MAX_VIEW_BYTES) return false;
    this.last = key; this.lastAt = this.now();
    this.send({ source: this.source, v: 1, type: 'view', seq: ++this.seq, payload: p });
    return true;
  }
  /** the presenter tapped: { x, y } in 0..1 of the frame, at = [lng, lat] (callers leave out taps on the "me" dot) */
  tapped(x, y, at = null) {
    if (!this.presenting) return false;
    const t = this.now(); if (t - this.lastTap < TAP_GAP_MS) return false;
    const payload = { x: Math.round(clamp(x, 0, 1) * 1000) / 1000, y: Math.round(clamp(y, 0, 1) * 1000) / 1000 };
    if (Array.isArray(at) && at.length === 2 && at.every(isNum)) payload.at = [r5(at[0]), r5(at[1])];
    this.lastTap = t;
    this.send({ source: this.source, v: 1, type: 'tap', seq: ++this.seq, payload });
    return true;
  }
  /** the person's own pointer / wheel / key: a follower tells the host (it stops following); start = a new gesture */
  touched(start = true) {
    const t = this.now();
    this.touchedAt = t;
    if (!start || !this.following || this.presenting || t - this.lastInteract < INTERACT_GAP_MS) return false;
    this.lastInteract = t;
    this.send({ source: this.source, v: 1, type: 'interact' });
    return true;
  }
  send(msg) { try { this.sendFn(msg, this.origin); } catch (e) { console.warn('[map] follow send:', e?.message); } }
}
