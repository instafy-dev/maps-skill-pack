// map-pack engine (v0). Kit-owned: replaced by `uw.mjs upgrade`. Sites edit map.config.json, style.json and custom.js instead.
// Loads map.config.json, renders layers with MapLibre (global `maplibregl`), builds the phone-first UI and exposes window.uw.
import { emit as bridgeEmit, setTitle as bridgeTitle, embedded, post as bridgePost } from './bridge.js';
import { HostLink, hotkeyOf, locateMessage, stashReload, takeReload, reloadNote } from './host.js';
import { FollowLink, parseState, encodeView, boxOf, cameraFor, isOwnGesture } from './follow.js';
import { Locator } from './locate.js';
import { NavHistory } from './nav.js';
import { UI, mapsLink, walkMinutes } from './ui.js';
import { Layers, ensureIcon, ensureLetter, handleMissing, RANK } from './layers.js';
import { applyLabels, applyOverrides, Look, lookFor, ensureTerrainSources, skyFor } from './look.js';
import {
  h, clamp, fill, fmtHour, fmtMetric, fmtNum, humanize, inWindow, center, bbox, lineCoords, cumulative, along, distM,
  pointInGeom, round6, debounce, rafThrottle, reducedMotion, prefersDark, timeIcon,
  BASIS, normBasis, fmtDate, fmtAge, fmtMoney, safeUrl, MODE_EMOJI, CAT_COLORS, THEME_COLORS, parseColor, featureName, selectPayload, word,
} from './util.js';
import { Question, guessMetric, mentionLayer, shortName } from './question.js';
import { RecordStore, expired, stale, itemFeature, offerGroup } from './records.js';
import { Bind, NEEDS, coolKey } from './bind.js';
import { buildLinks, DEFAULT_SHOW } from './links.js';
import { Photos } from './photos.js';
import { signalReport } from './signal.js';
import { applyTheme } from './theme.js';

window.__uwReady = false;
window.__uwErrors = window.__uwErrors || [];
// a host may say hello as soon as the frame loads, long before the map is ready: keep those messages for bind.js
window.__uwEarly = [];
window.addEventListener('message', (e) => {
  const d = e.data;
  if (window.__uwEarly && d && typeof d === 'object' && (d.source === 'instafy-host' || d.source === 'instafy-bind') && e.source === window.parent) window.__uwEarly.push(e);
});
const EMPTY = { type: 'FeatureCollection', features: [] };
const TOP_KEYS = ['version', 'locale', 'title', 'subtitle', 'view', 'basemap', 'time', 'vibe', 'air', 'layers', 'compare', 'plan', 'notes', 'votes', 'attribution', 'custom', 'css', 'theme', '$schema', 'description',
  'question', 'verdict', 'links', 'photos', 'bind', 'signal', 'intents', 'missing', 'expect'];
const OSM = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>';
const OFM = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>';
const OMT = '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a>';
const FEEL_BARS = [['calm_day', 'Calm by day'], ['calm_night', 'Calm at night'], ['lively_day', 'Lively by day'], ['lively_night', 'Lively at night'], ['green', 'Green'], ['amenities', 'Amenities']];
const FEEL_COUNTS = [['n_cafe', '☕', 'cafés'], ['n_food', '🍜', 'food'], ['n_gym', '🏋️', 'gyms'], ['n_night', '🍸', 'nightlife'], ['n_trees', '🌳', 'trees']];

const E = {
  config: null, map: null, ui: null, layers: null, look: null,
  hour: 14, vibe: 0.5, day: null, sel: null, pin: null, is3d: false, walking: null, listeners: {}, compareSet: null,
  // v0.2
  Q: null, question: null, records: new RecordStore(), bind: null, photos: null, metricsReg: {}, v2: false, booted: false,
  userVis: new Map(), lensVis: new Map(), reveal: null, optionNotes: new Map(), placesAll: new Set(),
  supportSet: new Set(), criterionLayers: new Set(), planRoutes: new Set(),
  error(msg, err) {
    console.error('[map] ' + msg, err && err !== msg ? err : '');
    window.__uwErrors.push(String(msg));
  },
};
// an embedding host (Instafy Studio): its chrome over the frame, title and capabilities (host.js, §3.7)
const hostLink = new HostLink({
  emit: (type, payload) => E.emit(type, payload),
  onLayout: (L) => {
    if (!E.ui) return;
    const prevBottom = E.ui.hostInsets.bottom;
    E.ui.hostInsets = { ...L.insets };
    E.ui.layout();
    syncMapSize();
    if (E.map && E.booted) {
      layoutNotes();
      // the host's composer / chat sheet grew: keep the selected place in the part of the map that is still visible
      if (L.insets.bottom !== prevBottom && E.sel) { const S = E.layers?.byId.get(E.sel.layer), f = S?.byFid.get(E.sel.id), c = f && E.layers.featureCenter(S, f); if (c) reveal(c); }
    }
  },
  // answers to "Show my location" from a host that locates for us (caps.location "host", locate.js)
  onLocation: (d) => locator.receive(d),
  // follow mode: present / apply-view / apply-tap (follow.js)
  onFollow: (d, origin) => follow.handle(d, origin),
}).start();
E.hostLayout = (d) => hostLink.accept(d);
// follow mode (Instafy docs/Follow-Mode.md): while the host says "present", the view goes out at most 10 times a second; a
// follower's copy applies the presenter's view. Views go only to the host that asked (never "*" once it is known).
const follow = new FollowLink({
  snapshot: (o) => viewSnapshot(o),
  apply: (v, o) => applyView(v, o),
  tap: (t, from) => showRipple(t, from),
  send: (msg, origin) => bridgePost(msg, origin || hostLink.origin || '*'),
});
E.follow = follow;
E.hostFollow = (d) => follow.handle(d, null);
// the person's own gestures on the site (a follower stops following); moves during a drag keep the quiet window open
for (const t of ['pointerdown', 'wheel', 'touchstart', 'keydown']) document.addEventListener(t, (e) => { if (isOwnGesture(e)) follow.touched(true); }, { capture: true, passive: true });
for (const t of ['pointermove', 'touchmove']) document.addEventListener(t, (e) => { if (e.isTrusted !== false && (e.type === 'touchmove' || e.buttons)) follow.touched(false); }, { capture: true, passive: true });
// "Show my location": the host's broker when its layout says caps.location "host", else the browser (locate.js).
// The position only moves the "me" dot; it is never emitted to the bridge.
const locator = new Locator({
  win: window, link: hostLink,
  onFix: (pos, info) => showMe(pos, info),
  onError: (kind) => E.ui?.toast(locateMessage(kind), 5000),
});
E.locator = locator;
// the same answers handed over the host's MessagePort or uw.ingest (bind.js)
E.hostLocation = (d) => locator.receive(d);
// leaving the page ends any watch, so a host never keeps locating for a page that is gone
window.addEventListener('pagehide', () => locator.stopAll());
// keys typed inside a cross-origin frame never reach the host: forward its shortcuts (⌘\ chat, F6 focus)
document.addEventListener('keydown', (e) => {
  if (!embedded()) return;
  const k = hotkeyOf(e); if (!k) return;
  e.preventDefault();
  E.emit('hotkey', k);
}, true);
E.featureCount = (id) => {
  const L = E.layers?.byId.get(id); if (L && !L.error) return L.data.features.length;
  const d = E.prefetch?.get(id); return d && Array.isArray(d.features) ? d.features.length : null;
};
const isNight = (h) => { h = ((h % 24) + 24) % 24; return h < 6 || h >= 19; };
const vibeWord = (v) => (v < 0.35 ? 'calm' : v > 0.65 ? 'lively' : 'balanced');

// ---------------- events ----------------
function strip(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = {};
  for (const [k, v] of Object.entries(payload)) if (k !== 'feature' && typeof v !== 'function') out[k] = v;
  return out;
}
E.emit = (type, payload = {}) => {
  for (const fn of E.listeners[type] || []) { try { fn(payload); } catch (e) { E.error(`listener for "${type}" threw: ${e.message}`, e); } }
  bridgeEmit(type, strip(payload));
};

// ---------------- votes ----------------
const voteKey = () => 'uw-votes:' + location.pathname + ':' + (E.config?.title || '');
function localVotes() { try { return JSON.parse(localStorage.getItem(voteKey()) || '{}'); } catch { return {}; } }
function saveVotes(v) { try { localStorage.setItem(voteKey(), JSON.stringify(v)); } catch { /* private mode */ } }
function voteInfo(id) {
  const cfg = (E.config.votes || {})[id] || {};
  const mine = localVotes()[id] || null;
  const up = [...(cfg.up || [])], down = [...(cfg.down || [])];
  if (mine === 'up') up.push('You'); if (mine === 'down') down.push('You');
  return { up, down, mine };
}
function vote(L, id, kind) {
  const v = localVotes();
  const was = v[id]; v[id] = was === kind ? null : kind; if (!v[id]) delete v[id];
  saveVotes(v);
  const f = L.byFid.get(id);
  try { E.map.setFeatureState({ source: L.sources[0], id }, { vote: v[id] || null }); } catch { /* not a points source */ }
  E.emit(kind === 'up' ? 'pick' : 'nope', { layer: L.id, id, name: f?.properties?.name, on: v[id] === kind });
  E.ui.toast(v[id] === kind ? (kind === 'up' ? `👍 Picked ${f?.properties?.name || ''}` : `👎 Noped ${f?.properties?.name || ''}`) : 'Vote removed', 1800);
  if (E.sel?.layer === L.id && E.sel.id === id) showFeatureCard(L, f);
  renderPlaces(); renderCompare();
}

// ---------------- the map's own history (nav.js): a host's address bar and ‹ › ----------------
// An entry: the selected place (card open or not), the sheet's tab, the plan day. Recording starts at ready; a burst of
// changes (a day selects its focus, a tab click closes a card) becomes one entry.
const navState = () => ({ sel: E.sel ? { layer: E.sel.layer, id: String(E.sel.id) } : null, card: !!(E.sel && E.ui?.card), tab: E.ui?.tab || null, day: E.day ?? null });
let navHome = null, navTimer = null;
function navDescribe(st) {
  const tabLabel = (id) => { const b = [...(E.ui?.tabsEl?.children || [])].find((x) => x.dataset.tab === id); return b?.textContent || id; };
  const place = (sel) => {
    const L = sel && E.layers?.byId.get(sel.layer), f = L?.byFid.get(String(sel.id));
    return f ? { layer: L.title || L.id, name: displayName(f.properties) || String(sel.id) } : null;
  };
  const days = E.config?.plan?.days || [];
  const p = st.card ? place(st.sel) : null;
  if (p) return { segments: [p.layer, p.name], title: p.name };
  if (st.tab === 'plan' && st.day != null && days[st.day]) {
    const n = `Day ${st.day + 1}`;
    return { segments: [tabLabel('plan'), n], title: days[st.day].title || n };
  }
  const q = place(st.sel);
  if (q) return { segments: [q.layer, q.name], title: q.name };
  if (st.tab && st.tab !== navHome?.tab) return { segments: [tabLabel(st.tab)], title: tabLabel(st.tab) };
  return { segments: [], title: E.config?.title || document.title };
}
function navApply(st) {
  if (!E.ui) return;
  if (st.day != null && st.day !== E.day && E.config?.plan?.days?.length) setDay(st.day);
  if (st.sel) {
    const same = E.sel && E.sel.layer === st.sel.layer && String(E.sel.id) === st.sel.id;
    if (!same || (st.card && !E.ui.card)) select(st.sel.layer, st.sel.id, { card: st.card });
    if (!st.card && E.ui.card) E.ui.hideCard();
  } else if (E.sel || E.pin) clearSelection();
  if (st.tab && E.ui.panels[st.tab]) E.ui.showTab(st.tab, false);
}
const nav = new NavHistory({
  describe: navDescribe,
  apply: navApply,
  read: navState,
  emit: (type, payload) => E.emit(type, payload),
  siteTitle: () => E.config?.title || document.title,
});
function navChanged() {
  if (!navHome) return;
  clearTimeout(navTimer);
  navTimer = setTimeout(() => nav.note(navState()), 80);
}
function navStart() { navHome = navState(); nav.reset(navHome); }

// ---------------- hash state ----------------
function readHash() { return parseState(location.hash); }
/** the hash state without the camera ("t=14&s=hotels:lore&l=sleep"): what a shared link and a follow view carry */
function stateParts() {
  const parts = [];
  const enc = (s) => encodeURIComponent(s).replace(/%3A/gi, ':').replace(/%2C/gi, ',');
  if (E.config.time?.enabled) parts.push('t=' + E.hour);
  if (E.vibeOn) parts.push('v=' + Math.round(E.vibe * 100) / 100);
  if (E.sel) parts.push('s=' + enc(E.sel.layer + ':' + E.sel.id));
  if (E.pin) parts.push('p=' + E.pin.map((x) => x.toFixed(5)).join(','));
  // only the viewer's own toggles (a lens's temporary layers and the question's defaults are not state)
  const off = [], on = [];
  for (const L of E.layers.list) { if (!E.userVis.has(L.id) || L.created) continue; const u = E.userVis.get(L.id); if (u === baseVisible(L)) continue; (u ? on : off).push(L.id); }
  if (off.length) parts.push('off=' + enc(off.join(',')));
  if (on.length) parts.push('on=' + enc(on.join(',')));
  if (E.Q?.lens) parts.push('l=' + enc(E.Q.lens));
  if (E.Q && Object.keys(E.Q.user).length) parts.push('w=' + enc(Object.entries(E.Q.user).map(([k, x]) => `${k}:${x}`).join(',')));
  if (E.day != null) parts.push('d=' + (E.day + 1));
  return parts;
}
const writeHashSoon = debounce(() => {
  if (!E.map || !E.layers) return;
  const c = E.map.getCenter(), parts = stateParts();
  const b = Math.round(E.map.getBearing()), p = Math.round(E.map.getPitch());
  parts.push('@=' + [c.lng.toFixed(5), c.lat.toFixed(5), E.map.getZoom().toFixed(2)].join(',') + (b || p ? ',' + b + ',' + p : ''));
  const s = '#' + parts.join('&');
  if (s !== location.hash) history.replaceState(null, '', s);
}, 300);
// every state change writes the hash; a presenter's view goes out with it (follow.js throttles)
const writeHash = Object.assign(() => { writeHashSoon(); follow.changed(); }, { flush: () => writeHashSoon.flush() });

// ---------------- follow mode: the view out, a presenter's view in ----------------
/**
 * The canvas must have its container's size. MapLibre's own ResizeObserver drops its first callback, so a frame the host
 * resized right after the map was built (a phone pane opening, the host's insets) kept the canvas at the old size and the
 * map drew a shifted area: a follower then showed another place than the presenter. True when it had to resize.
 */
function syncMapSize() {
  const map = E.map;
  if (!map) return false;
  try {
    const c = map.getContainer(), cv = map.getCanvas();
    if (!c || !cv) return false;
    if (Math.abs(c.clientWidth - cv.clientWidth) > 0.5 || Math.abs(c.clientHeight - cv.clientHeight) > 0.5) { map.resize(); return true; }
  } catch (e) { console.warn('[map] resize:', e?.message); }
  return false;
}
E.syncMapSize = syncMapSize;
/** the visible part of the map (outside the sheet / side panel), px */
function visibleRect() {
  syncMapSize();
  const P = pad(), c = E.map.getContainer(), W = c.clientWidth, H = c.clientHeight;
  const x0 = clamp(P.left, 0, W - 40), x1 = clamp(W - P.right, x0 + 40, W), y0 = clamp(P.top, 0, H - 40), y1 = clamp(H - P.bottom, y0 + 40, H);
  return { x0, x1, y0, y1, width: x1 - x0, height: y1 - y0 };
}
/** what this copy shows, as a follow view (follow.js); null before the map is ready */
function viewSnapshot(o = {}) {
  if (!E.map || !E.layers || !E.ui || !E.booted) return null;
  let cam = null;
  // the camera sits on the presenter's own position (after "Show my location", until they pan): it stays home
  if (!(E.camOnMe && !o.location)) {
    const r = visibleRect(), c = E.map.unproject([(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2]);
    cam = { b: boxOf({ center: [c.lng, c.lat], zoom: E.map.getZoom(), width: r.width, height: r.height }), br: E.map.getBearing(), pi: E.map.getPitch() };
  }
  return encodeView({ s: stateParts().join('&'), cam, tab: E.ui.tab, card: !!(E.sel && E.ui.card), lay: E.ui.side ? 'side' : 'sheet', snap: E.ui.snap });
}
/** a presenter's view: the same lens, layers, day, selection, tab (and snap, on the same layout class), and area */
function applyView(v, o = {}) {
  if (!E.map || !E.layers || !E.booted) return;
  const s = parseState(v.s);
  if (E.config.time?.enabled && s.t != null && Math.abs(s.t - E.hour) > 0.001) setTime(s.t, { final: true });
  if (E.vibeOn && s.v != null && Math.abs(s.v - E.vibe) > 0.001) setVibe(s.v, { final: true });
  if (E.Q) {
    const lens = s.l ? s.l : null;
    if (lens !== (E.Q.lens ?? null) && (!lens || E.Q.lenses.some((l) => l.id === lens))) setLens(lens);
    if (JSON.stringify(s.w || {}) !== JSON.stringify(E.Q.user || {})) { E.Q.setUserWeights(s.w || {}); setWeights({}); }
  }
  // the viewer's own toggles relative to the lens's defaults (the hash's off / on)
  for (const L of E.layers.list) {
    if (L.created) continue;
    const want = s.on.includes(L.id) ? true : s.off.includes(L.id) ? false : baseVisible(L);
    const now = E.userVis.has(L.id) ? E.userVis.get(L.id) : baseVisible(L);
    if (want !== now) setLayerVisible(L.id, want, { quiet: true });
  }
  if (s.d != null && E.config.plan?.days?.length && s.d - 1 !== E.day) setDay(s.d - 1, { fly: false });
  const i = s.s ? s.s.indexOf(':') : -1;
  if (i > 0) {
    const layer = s.s.slice(0, i), id = s.s.slice(i + 1);
    const same = E.sel && E.sel.layer === layer && String(E.sel.id) === id;
    if (!same || (v.card && !E.ui.card)) select(layer, id, { card: v.card, fly: false });
    if (!v.card && E.ui.card) E.ui.hideCard();
  } else if (s.p && s.p.length === 2 && s.p.every(isFinite)) {
    if (!E.pin || Math.abs(E.pin[0] - s.p[0]) > 1e-6 || Math.abs(E.pin[1] - s.p[1]) > 1e-6) dropPin(s.p);
  } else if (E.sel || E.pin) clearSelection({ silent: true });
  if (v.tab && v.tab !== 'card' && E.ui.panels[v.tab] && !E.ui.card && E.ui.tab !== v.tab) E.ui.showTab(v.tab, false);
  // a phone sheet and a desktop side panel are different layouts: each keeps its own snap
  if (!E.ui.side && v.lay === 'sheet' && v.snap && E.ui.snap !== v.snap) E.ui.setSnap(v.snap, !!o.smooth);
  if (v.cam) {
    const r = visibleRect(), cam = cameraFor(v.cam.b, { width: r.width, height: r.height });
    zeroPadding();
    const opts = { center: cam.center, zoom: cam.zoom, bearing: v.cam.br, pitch: v.cam.pi, offset: visOffset() };
    E.map.easeTo({ ...opts, duration: o.smooth && !reducedMotion() ? 300 : 0, essential: true }, { uwFollow: true });
  }
}
/** the presenter tapped here: a ripple with their name for 1.2 s (on the map where they tapped, else over the frame) */
function showRipple(t, from) {
  if (!E.map || !E.ui) return;
  const el = h('div.uw-ripple' + (reducedMotion() ? '.is-static' : ''), { 'aria-hidden': 'true' }, h('i'), from?.name ? h('span', from.name) : null);
  let marker = null;
  const c = E.map.getContainer(), W = c.clientWidth, H = c.clientHeight;
  const pt = t.at ? E.map.project(t.at) : null;
  if (pt && pt.x >= 0 && pt.y >= 0 && pt.x <= W && pt.y <= H) marker = new maplibregl.Marker({ element: el }).setLngLat(t.at).addTo(E.map);
  else if (t.x != null && t.y != null) { el.classList.add('is-fixed'); el.style.left = Math.round(t.x * window.innerWidth) + 'px'; el.style.top = Math.round(t.y * window.innerHeight) + 'px'; E.ui.root.append(el); }
  else return;
  setTimeout(() => { if (marker) marker.remove(); else el.remove(); }, 1200);
}

// ---------------- camera ----------------
// One rule keeps the camera honest: the map's own transform padding stays 0. MapLibre adds the padding of the last
// padded flyTo/easeTo to every later fitBounds, so a padded flight followed by a fit counted the sheet twice
// (maps zoomed out on select, Reset missed home, plan days stopped moving or threw). Instead, fits pass the sheet as
// fit padding (never stored) and point flights pass an `offset` that centres the target in the visible part of the map.
const pad = () => E.ui.padding();
const ZERO_PAD = { top: 0, right: 0, bottom: 0, left: 0 };
/** pixel offset that puts a camera target in the middle of the map area the sheet / side panel leaves visible */
function visOffset() { const P = pad(); return [Math.round((P.left - P.right) / 2), Math.round((P.top - P.bottom) / 2)]; }
function zeroPadding() {
  const p = E.map.getPadding?.();
  if (p && (p.top || p.right || p.bottom || p.left)) E.map.setPadding(ZERO_PAD);
}
/** The map centre that shows `lnglat` in the middle of the visible map area at the current zoom. */
function centerFor(lnglat) {
  const [ox, oy] = visOffset(), p = E.map.project(lnglat), c = E.map.unproject([p.x - ox, p.y - oy]);
  return [c.lng, c.lat];
}
// view.zoom is the zoom a phone needs to show view.bounds; it caps the fit so a tiny area never over-zooms.
// Wide screens (side panel) may go further in, since they have room to show the area larger.
const maxZoomFor = (v) => (v.zoom != null ? v.zoom + (E.ui?.side ? 1 : 0.6) : 18);
/** Fit a [[w,s],[e,n]] box into the visible map area. Never throws: if the box can't fit, it just centres it. */
function fit(b, o = {}) {
  const map = E.map;
  zeroPadding();
  const P = pad(), x = o.extra || 0;
  const padding = { top: P.top + x, right: P.right + x, bottom: P.bottom + x + (o.extraBottom || 0), left: P.left + x };
  let cam = null;
  try { cam = map.cameraForBounds(b, { padding, maxZoom: o.maxZoom ?? 16.5, bearing: o.bearing ?? map.getBearing() }); } catch { cam = null; }
  const pitch = o.pitch ?? map.getPitch(), duration = reducedMotion() ? 0 : (o.duration ?? 900);
  if (!cam || !cam.center || !isFinite(cam.zoom)) {
    const c = [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];
    return map.easeTo({ center: c, offset: visOffset(), pitch, duration, essential: false });
  }
  const opts = { center: cam.center, zoom: cam.zoom, bearing: cam.bearing ?? map.getBearing(), pitch, duration, essential: false };
  return duration ? map.flyTo(opts) : map.jumpTo(opts);
}
/** view.bounds, grown to include every option of the question (the answer must be on screen, never under the sheet) */
function homeBounds() {
  const v = E.config.view || {};
  let b = v.bounds ? [v.bounds[0][0], v.bounds[0][1], v.bounds[1][0], v.bounds[1][1]] : null;
  const pts = E.Q ? E.Q.opts.map(optionPoint).filter(Boolean) : [];
  if (!pts.length) return v.bounds || null;
  const ob = bbox({ type: 'MultiPoint', coordinates: pts });
  if (!b) b = ob; else b = [Math.min(b[0], ob[0]), Math.min(b[1], ob[1]), Math.max(b[2], ob[2]), Math.max(b[3], ob[3])];
  return [[b[0], b[1]], [b[2], b[3]]];
}
function home(animate = true) {
  const v = E.config.view || {};
  const pitch = E.is3d ? 60 : (v.pitch || 0), bearing = v.bearing || 0;
  const hb = homeBounds();
  // bounds = the area that must be visible; zoom (if set) caps how far in it goes, so a small area doesn't over-zoom
  if (hb) fit(hb, { maxZoom: maxZoomFor(v), pitch, bearing, duration: animate ? 1100 : 0, extra: E.Q ? 14 : 0 });
  else { zeroPadding(); E.map.flyTo({ center: v.center || [10, 25], zoom: v.zoom ?? 1.6, pitch, bearing, offset: visOffset(), duration: animate && !reducedMotion() ? 1100 : 0, essential: false }); }
}
function flyTo(target, o = {}) {
  const map = E.map;
  if (!target) return;
  if (target.layer && target.id != null) {
    const L = E.layers.byId.get(target.layer), f = L?.byFid.get(String(target.id));
    if (!f) return;
    if (f.geometry.type === 'Point') return flyTo({ center: f.geometry.coordinates, zoom: Math.max(map.getZoom(), o.zoom || 15.2) }, o);
    return flyTo(bbox(L.type === 'legs' ? { type: 'LineString', coordinates: f.properties._arc } : f.geometry), o);
  }
  if (Array.isArray(target) && target.length === 4 && typeof target[0] === 'number') target = [[target[0], target[1]], [target[2], target[3]]];
  if (Array.isArray(target) && Array.isArray(target[0])) {
    const [[w, s], [e, n]] = target;
    if (Math.abs(e - w) < 1e-6 && Math.abs(n - s) < 1e-6) return flyTo([w, s], o);
    return fit(target, { maxZoom: o.maxZoom || 16.5, extra: o.extra, extraBottom: o.extraBottom, ...o.cam });
  }
  zeroPadding();
  const dur = reducedMotion() ? 0 : 900;
  if (Array.isArray(target)) return map.flyTo({ center: target, zoom: Math.max(map.getZoom(), 15), offset: visOffset(), duration: dur, essential: false });
  const t = { ...target };
  if (t.padding) { console.warn('[map] uw.flyTo: "padding" is ignored (the engine keeps the camera clear of the panel itself)'); delete t.padding; }
  if (reducedMotion()) t.duration = 0;
  return map.flyTo({ offset: visOffset(), duration: dur, essential: false, ...t });
}
/** Ease so a point is visible in the uncovered part of the map. */
function reveal(lnglat) {
  const map = E.map, p = map.project(lnglat), P = pad(), cv = map.getCanvas();
  const W = cv.clientWidth, H = cv.clientHeight;
  if (p.x < P.left || p.x > W - P.right || p.y < P.top || p.y > H - P.bottom) { zeroPadding(); map.easeTo({ center: lnglat, offset: visOffset(), duration: reducedMotion() ? 0 : 600 }); }
}

// ---------------- selection ----------------
function selLayersReady() {
  const map = E.map, Ls = E.layers;
  map.addSource('uw--sel', { type: 'geojson', data: EMPTY });
  const geom = (types) => ['in', ['geometry-type'], ['literal', types]];
  Ls.addMapLayer({ id: 'uw--sel-area', type: 'line', source: 'uw--sel', filter: geom(['Polygon', 'MultiPolygon']),
    paint: { 'line-color': ['get', '_color'], 'line-width': 3.5, 'line-opacity': 0.95 } }, 149);
  Ls.addMapLayer({ id: 'uw--sel-glow', type: 'line', source: 'uw--sel', filter: geom(['LineString', 'MultiLineString']),
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', '_color'], 'line-width': 14, 'line-opacity': 0.28, 'line-blur': 2 } }, 49);
  Ls.addMapLayer({ id: 'uw--sel-pulse', type: 'circle', source: 'uw--sel', filter: geom(['Point']),
    paint: { 'circle-radius': 22, 'circle-color': ['get', '_color'], 'circle-opacity': 0.22, 'circle-stroke-width': 2, 'circle-stroke-color': ['get', '_color'], 'circle-stroke-opacity': 0.35, 'circle-pitch-alignment': 'map' } }, 150);
  Ls.addMapLayer({ id: 'uw--sel-icon', type: 'symbol', source: 'uw--sel', filter: ['all', geom(['Point']), ['has', '_icon']],
    layout: { 'icon-image': ['get', '_icon'], 'icon-size': 1.32, 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'text-field': ['get', '_label'], 'text-font': ['Noto Sans Bold'], 'text-size': 13.5, 'text-anchor': 'top', 'text-offset': ['literal', [0, 2.05]],
      'text-allow-overlap': true, 'text-ignore-placement': true },
    paint: { 'text-color': '#0f172a', 'text-halo-color': 'rgba(255,255,255,0.97)', 'text-halo-width': 2 } }, 152);
  Ls.themed('uw--sel-icon', 'text-color', '#0f172a', '#f8fafc');
  Ls.themed('uw--sel-icon', 'text-halo-color', 'rgba(255,255,255,0.97)', 'rgba(13,19,34,0.95)');
  // walk animation
  map.addSource('uw--walk', { type: 'geojson', data: EMPTY });
  Ls.addMapLayer({ id: 'uw--walk-trail', type: 'line', source: 'uw--walk', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': THEME_COLORS.walk, 'line-width': 7, 'line-opacity': 0.95 } }, 158);
  Ls.themed('uw--walk-trail', 'line-color', THEME_COLORS.walk, THEME_COLORS.walkNight);
  const walker = ensureIcon(map, '🚶', THEME_COLORS.walk, 34, true);
  Ls.addMapLayer({ id: 'uw--walk-dot', type: 'symbol', source: 'uw--walk', filter: ['==', ['geometry-type'], 'Point'],
    layout: { 'icon-image': walker, 'icon-allow-overlap': true, 'icon-ignore-placement': true } }, 160);
}

let pulseRaf = null;
function startPulse() {
  cancelAnimationFrame(pulseRaf);
  if (reducedMotion()) return;
  const map = E.map, t0 = performance.now();
  const base = E.sel?.size ? E.sel.size * 0.66 : 16;
  const tick = (now) => {
    if (!E.sel || !E.sel.point || !map.getLayer('uw--sel-pulse')) return;
    // three pulses, then a calm static ring: an endless pulse repaints the whole map every frame (battery, heat)
    if (now - t0 > 3 * 1700) {
      map.setPaintProperty('uw--sel-pulse', 'circle-radius', base + 7);
      map.setPaintProperty('uw--sel-pulse', 'circle-opacity', 0.16);
      map.setPaintProperty('uw--sel-pulse', 'circle-stroke-opacity', 0.45);
      return;
    }
    const k = ((now - t0) % 1700) / 1700;
    map.setPaintProperty('uw--sel-pulse', 'circle-radius', base + k * 20);
    map.setPaintProperty('uw--sel-pulse', 'circle-opacity', 0.28 * (1 - k));
    map.setPaintProperty('uw--sel-pulse', 'circle-stroke-opacity', 0.5 * (1 - k));
    pulseRaf = requestAnimationFrame(tick);
  };
  pulseRaf = requestAnimationFrame(tick);
}

function setSelFeature(L, f) {
  const map = E.map;
  if (!f) { map.getSource('uw--sel')?.setData(EMPTY); return; }
  const p = f.properties;
  const geom = L.type === 'legs' ? { type: 'LineString', coordinates: p._arc } : f.geometry;
  const props = { _color: p._color || L.color, _label: '' };
  if (geom.type === 'Point' && p._icon) { props._icon = p._icon; props._label = displayName(p); }
  map.getSource('uw--sel').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: geom, properties: props }] });
}

function clearSelState() {
  const s = E.sel;
  if (!s) return;
  const L = E.layers.byId.get(s.layer);
  if (L && L.type === 'points') { try { E.map.setFeatureState({ source: L.sources[0], id: s.id }, { selected: false }); } catch { /* */ } }
  if (L) E.map.setGlobalStateProperty('sel_' + L.id, null);
}

function select(layerId, id, o = {}) {
  const L = E.layers.byId.get(layerId);
  id = id == null ? id : String(id);
  const f = L?.byFid.get(id);
  if (!f) { console.warn(`[map] select: no feature ${layerId}:${id}`); return false; }
  stopWalk(); removePin(true);
  clearSelState();
  // v0: selecting a hidden layer turns it on. With a question, a hidden context layer stays hidden: the selection
  // layer shows the one feature (selected features are always shown)
  if (!L.visible && !E.Q) setLayerVisible(L.id, true);
  E.sel = { layer: L.id, id, point: f.geometry.type === 'Point' && L.type !== 'grid', size: L.tier === 'option' ? 40 : L.size };
  if (L.type === 'points') E.map.setFeatureState({ source: L.sources[0], id }, { selected: true });
  E.map.setGlobalStateProperty('sel_' + L.id, id);
  setSelFeature(L, f);
  startPulse();
  if (E.Q) { revealFor(L, f); applyBudgets(); }
  if (L.type === 'grid') showCellCard(L, f, null);
  else if (L.verdict && o.card !== false) showAreaCard(L, f);
  else if (o.card !== false) showFeatureCard(L, f);
  if (o.fly !== false) E.ui.revealMap('half');
  const c = E.layers.featureCenter(L, f);
  // a point with its own walk area (isochrone linkedTo its layer): show the whole area, not just the pin
  const area = L.type === 'points' && o.fly !== false ? findWalk(L, f).area : null;
  if (o.fly === false) { /* keep camera */ } else if (area) flyTo(bbox(area.feature.geometry), { maxZoom: 16, extra: 8 });
  else if (o.from === 'map') { if (c) reveal(c); } else flyTo({ layer: L.id, id }, { zoom: L.type === 'points' ? 15.5 : undefined });
  E.emit('select', selectPayload(L, f, E.config.basemap?.labels || 'en', id));
  writeHash();
  updateAir();
  navChanged();
  return true;
}
function clearSelection(o = {}) {
  const had = E.sel || E.pin;
  clearSelState();
  E.sel = null; cancelAnimationFrame(pulseRaf);
  setSelFeature(null);
  removePin(true);
  if (E.reveal) { clearReveal(); renderLayersTab(); }
  E.ui.hideCard();
  if (had && !o.silent) E.emit('clear', {});
  writeHash();
  navChanged();
}

function displayName(p) { return featureName(p, E.config.basemap?.labels || 'en'); }

// ---------------- cards ----------------
/** Metric meta: v0 guesses from the key name, then data/metrics.json (scripts), then compare.metrics; with a question
 *  the question's merged meta (criterion overrides and anchors too). */
function metricMeta(key) {
  if (E.Q) return E.Q.meta(key);
  const m = (E.config.compare?.metrics || []).find((x) => x.key === key);
  const guess = { key, label: humanize(key), ...guessMetric(key), ...(E.metricsReg[key] || {}) };
  return m ? { ...guess, ...m } : guess;
}
const statsCache = new Map();
function stats(L, key) {
  const k = L.id + '|' + key;
  if (!statsCache.has(k)) {
    const vals = L.data.features.map((f) => f.properties[key]).filter((v) => typeof v === 'number' && isFinite(v));
    statsCache.set(k, vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : null);
  }
  return statsCache.get(k);
}
function goodColor(g) { return g == null ? 'var(--uw-accent)' : `hsl(${Math.round(8 + 134 * clamp(g, 0, 1))} 68% 46%)`; }
function barFor(L, key, v, m) {
  const st = stats(L, key);
  if (typeof v !== 'number' || !st) return { len: 0, color: goodColor(null) };
  const pct = m.format === 'pct' && v <= 1.0001;
  const len = pct ? v : st.max > 0 ? v / st.max : 0;
  let g = null;
  if (m.better && st.max > st.min) { g = (v - st.min) / (st.max - st.min); if (m.better === 'lower') g = 1 - g; }
  else if (m.better && st.max === st.min) g = 1;
  return { len: clamp(len, 0, 1), color: goodColor(g) };
}

function voteChips(id) {
  const v = voteInfo(id);
  return [...v.up.map((n) => ({ text: `👍 ${n}`, kind: 'up' })), ...v.down.map((n) => ({ text: `👎 ${n}`, kind: 'down' }))];
}

/** Routes / walk areas that belong to a feature: { route: {layer,id,mode}, area: {layer,id,minutes,mode} } (either may be null). */
function findWalk(L, f) {
  const id = f.properties.id, ls = E.layers.list, out = { route: null, area: null };
  const modeOf = (R, fid) => { const x = fid != null ? R.byFid.get(String(fid)) : R.data.features[0]; return x?.properties?.mode || null; };
  if (L.type === 'route') { if (L.def.animate !== false) out.route = { layer: L.id, id, mode: f.properties.mode || null }; return out; }
  if (f.properties.route && E.layers.byId.get(f.properties.route)) { const R = E.layers.byId.get(f.properties.route); out.route = { layer: R.id, mode: modeOf(R) }; }
  for (const R of ls) {
    if (out.route) break;
    if (R.type !== 'route' || R.error || R.def.animate === false) continue;
    const hit = R.data.features.find((x) => String(x.properties.for) === id) || R.data.features.find((x) => x.properties.for == null && String(x.properties.from) === id);
    if (hit) out.route = { layer: R.id, id: hit.properties.id, mode: hit.properties.mode || null };
  }
  if (!out.route) {
    const day = (E.config.plan?.days || []).find((d) => d.route && d.focus && d.focus.layer === L.id && String(d.focus.id) === id);
    if (day && E.layers.byId.get(day.route)) { const R = E.layers.byId.get(day.route), x = dayRouteFeature(day); out.route = { layer: R.id, id: x?.properties.id, mode: x?.properties.mode || modeOf(R) }; }
  }
  for (const A of ls) {
    if (A.type !== 'areas' || A.linkedTo !== L.id || A.error) continue;
    const hits = A.data.features.filter((x) => String(x.properties.for) === id);
    if (!hits.length) continue;
    const hit = hits.reduce((a, b) => ((b.properties.minutes || 0) > (a.properties.minutes || 0) ? b : a));
    out.area = { layer: A.id, id: hit.properties.id, minutes: hit.properties.minutes, mode: hit.properties.mode || null, feature: hit };
    break;
  }
  return out;
}
const isBike = (mode) => /bike|bicycle|cycl/.test(String(mode || ''));
const walkLabel = (mode) => (isBike(mode) ? ['🚲', 'Ride it'] : /car|driv/.test(String(mode || '')) ? ['🚗', 'Drive it'] : ['🚶', 'Walk it']);
/** The route feature a plan day means: the one that starts at (or is "for") the day's focus, else the first line. */
function dayRouteFeature(d) {
  const R = d?.route && E.layers.byId.get(d.route); if (!R || R.error) return null;
  const fid = d.focus ? String(d.focus.id) : null;
  return (fid && (R.data.features.find((x) => String(x.properties.for) === fid) || R.data.features.find((x) => String(x.properties.from) === fid)))
    || R.data.features.find((x) => /Line/.test(x.geometry.type)) || null;
}

function showFeatureCard(L, f, o = {}) {
  if (E.v2) return showFeatureCard2(L, f, o);
  const p = f.properties, card = L.def.card || {};
  const title = displayName(p) || L.title;
  let subtitle = card.subtitle ? fill(card.subtitle, p) : [p.kind ? humanize(p.kind) : '', p.area].filter(Boolean).join(' · ');
  const local = p.name && p.name !== title ? p.name : '';
  if (local && !subtitle.includes(local)) subtitle = subtitle ? `${local} · ${subtitle}` : local;
  const chips = [];
  if (L.type !== 'legs' && (L.type === 'route' || p.duration_min != null || p.distance_km != null)) {
    if (p.duration_min != null) chips.push({ text: `⏱ ${Math.round(p.duration_min)} min` });
    if (p.distance_km != null) chips.push({ text: `📏 ${p.distance_km} km` });
  }
  if (L.type === 'legs') chips.push(...legChips(p));
  // the open window only matters with the time slider on, and the opening-hours chip already says it
  if (E.config.time?.enabled && p.time_from != null && p.time_to != null && !p.opening_hours) chips.push({ text: `${timeIcon(p.time_from)} ${fmtHour(p.time_from)}–${fmtHour(p.time_to)}`.trim() });
  if (p.opening_hours) chips.push({ text: `🕒 ${p.opening_hours}` });
  chips.push(...voteChips(p.id));
  // metric bars
  const keys = [...(card.fields || [])];
  if (E.config.compare?.layer === L.id) for (const m of E.config.compare.metrics || []) if (!keys.includes(m.key)) keys.push(m.key);
  const bars = keys.filter((k) => p[k] != null).map((k) => {
    const m = metricMeta(k); const b = barFor(L, k, p[k], m);
    return { label: m.label, value: fmtMetric(p[k], m), len: b.len, color: b.color };
  });
  const c = E.layers.featureCenter(L, f);
  const v = voteInfo(p.id);
  const actions = [
    { emoji: '👍', label: v.mine === 'up' ? 'Picked' : 'Pick', pressed: v.mine === 'up', onClick: () => vote(L, p.id, 'up') },
    { emoji: '👎', label: 'Nope', pressed: v.mine === 'down', onClick: () => vote(L, p.id, 'down') },
  ];
  const w = findWalk(L, f);
  // both when both exist: the linked area ("10-min walk") and the route animation ("Walk it")
  if (w.area) actions.unshift({ emoji: '🟣', label: `${w.area.minutes || 10}-min ${isBike(w.area.mode) ? 'ride' : 'walk'}`, primary: !w.route, onClick: () => walk(w.area.layer, w.area.id) });
  if (w.route) { const [em, lab] = walkLabel(w.route.mode); actions.unshift({ emoji: em, label: lab, primary: true, onClick: () => walk(w.route.layer, w.route.id) }); }
  if (c) actions.push({ icon: 'maps', label: 'Open in Maps', href: mapsLink(p.name || title, c) });
  const ask = askAct(L, p.id, title); if (ask) actions.push(ask);
  actions.push({ icon: 'share', label: 'Share', onClick: () => share(title) });
  if (p.url || p.website) actions.push({ emoji: '🔗', label: 'Website', href: p.url || p.website });
  actions.push(...sourceActs(L, p));
  const src = p.source || (/^osm-[nwr]\d+/.test(p.id) ? 'OpenStreetMap' : '');
  let foot = src ? `Source: ${src}` : '';
  if (/^osm-([nwr])(\d+)/.test(p.id)) { const [, t, n] = /^osm-([nwr])(\d+)/.exec(p.id); foot += ` · osm.org/${{ n: 'node', w: 'way', r: 'relation' }[t]}/${n}`; }
  // placed from a fallback source (uw add-point / station): the card says so until a full answer replaces it
  if (p.data_status === 'partial') foot += `${foot ? ' · ' : ''}data may be incomplete`;
  E.ui.showCard({ kind: 'feature', layer: L.id, id: p.id, title, subtitle, emoji: p._emoji || L.emoji || p.emoji || '', color: p._color || L.color,
    body: card.body ? fill(card.body, p) : (p.note || p.description || ''), chips, bars, actions, foot,
    image: typeof p.image === 'string' && /^https:\/\//.test(p.image) ? p.image : null,
    imageCredit: typeof p.image_credit === 'string' ? p.image_credit : null, imageCreditUrl: typeof p.image_page === 'string' && /^https:\/\//.test(p.image_page) ? p.image_page : null });
}

function feelScore(p, hour = E.hour, v = E.vibe) {
  const n = isNight(hour), g = (k) => (typeof p[k] === 'number' ? p[k] : 0);
  const s = (1 - v) * (n ? g('calm_night') : g('calm_day')) + v * (n ? g('lively_night') : g('lively_day'));
  return clamp(0.85 * s + 0.15 * g('green'), 0, 1);
}
function gridLayer() {
  const want = E.config.vibe?.grid;
  return E.layers.list.find((L) => L.type === 'grid' && !L.error && (!want || L.id === want)) || E.layers.list.find((L) => L.type === 'grid' && !L.error);
}
function cellAt(lnglat) {
  const G = gridLayer(); if (!G) return null;
  const f = G.data.features.find((x) => pointInGeom(lnglat, x.geometry));
  return f ? { L: G, f } : null;
}
function nearby(lnglat, n = 3) {
  const out = [];
  for (const L of E.layers.list) {
    if (L.type !== 'points' || L.error || !L.visible) continue;
    for (const f of L.data.features) out.push({ L, f, d: distM(lnglat, f.geometry.coordinates) });
  }
  const bike = travelMode() === 'bike';
  return out.sort((a, b) => a.d - b.d).slice(0, n).map(({ L, f, d }) => ({ layer: L.id, id: f.properties.id, name: displayName(f.properties) || L.title,
    emoji: f.properties._emoji, color: f.properties._color,
    sub: [L.title, d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(1) + ' km',
      bike ? `~${Math.max(1, Math.round(d / 250))} min by bike` : d <= 2500 ? `~${walkMinutes(d)} min walk` : null].filter(Boolean).join(' · ') }));
}
/** How this map gets around: "bike" when its routes / reachable areas are all by bike, else "foot". */
let modeCache = null;
function travelMode() {
  if (modeCache) return modeCache;
  const modes = [];
  for (const L of E.layers.list) if ((L.type === 'route' || L.type === 'areas') && !L.error) for (const f of L.data.features) if (f.properties.mode) modes.push(f.properties.mode);
  return (modeCache = modes.length && modes.every(isBike) ? 'bike' : 'foot');
}
function cellModelBits(p) {
  const night = isNight(E.hour);
  const bars = FEEL_BARS.filter(([k]) => p[k] != null).map(([k, label]) => {
    const now = (k.endsWith('_night') && night) || (k.endsWith('_day') && !night);
    // a rank among this map's blocks ("top 4%"), never a bare "96%" that reads like a measured share
    const pc = gridPercentile(k, p[k]);
    const val = pc == null ? (p[k] >= 0.8 ? 'very high' : p[k] >= 0.6 ? 'high' : p[k] >= 0.4 ? 'medium' : p[k] >= 0.2 ? 'low' : 'very low') : pc >= 0.5 ? `top ${Math.max(1, Math.round((1 - pc) * 100))}%` : `bottom ${Math.max(1, Math.round(pc * 100))}%`;
    return { label: label + (now ? ' · now' : ''), value: val, len: p[k], color: now ? 'var(--uw-accent)' : 'var(--uw-muted-bar)' };
  });
  const counts = FEEL_COUNTS.filter(([k]) => p[k] != null).map(([k, e, w]) => `${e} ${p[k]} ${w}`);
  return { bars, counts };
}
function showCellCard(L, f, lnglat, o = {}) {
  const p = f.properties, { bars, counts } = cellModelBits(p);
  const c = lnglat || center(f.geometry);
  const ints = lnglat ? intentActs('map-context', null, { pin: lnglat, ui: 'map-context' }) : [];
  if (p.water) {
    E.ui.showCard({ kind: 'cell', layer: L.id, id: p.id, title: 'On the water', subtitle: L.title, emoji: '🌊', color: '#0ea5e9',
      body: 'Rivers, lakes and harbours have no calm ↔ lively estimate.', nearby: nearby(c, 3),
      actions: [...ints, { icon: 'maps', label: 'Open in Maps', href: mapsLink('', c) }, { icon: 'share', label: 'Share', onClick: () => share('A spot') }] });
    return;
  }
  E.ui.showCard({ kind: 'cell', layer: L.id, id: p.id, refresh: !!o.refresh, title: lnglat ? "What's it like here?" : 'This block', subtitle: `${L.title} · ${fmtHour(E.hour)}`,
    emoji: '🧭', color: '#14b8a6', score: feelScore(p), scoreTitle: `Match for a ${vibeWord(E.vibe)} vibe at ${fmtHour(E.hour)} (estimate)`,
    scoreNote: 'An estimate from the map data, not a measurement. Bars rank this block against the other blocks of this map. Drag the time and vibe to see it change.', bars, counts,
    nearby: nearby(c, 3), actions: [...ints, { icon: 'maps', label: 'Open in Maps', href: mapsLink('', c) }, { icon: 'share', label: 'Share', onClick: () => share('A spot') }],
    foot: 'Estimated from OpenStreetMap: noise from road & rail class, green from parks and trees, lively from cafés, food and nightlife. Not measured.'
      + (p.s_calm_day != null ? ' The map colours are smoothed with neighbours; these are the raw values of this block.' : '') });
}

// ---------------- pin (long-press / right-click) ----------------
let pinMarker = null;
function dropPin(lnglat) {
  if (lnglat && !Array.isArray(lnglat)) lnglat = [lnglat.lng, lnglat.lat];
  lnglat = lnglat.map(round6);
  stopWalk();
  clearSelState(); E.sel = null; setSelFeature(null);
  removePin(true);
  E.pin = lnglat;
  const el = h('div.uw-pin', { 'aria-label': 'Dropped pin' }, h('span.uw-pin-head'), h('span.uw-pin-shadow'));
  pinMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(lnglat).addTo(E.map);
  const cell = cellAt(lnglat);
  if (cell) E.map.getSource('uw--sel').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: cell.f.geometry, properties: { _color: '#14b8a6' } }] });
  showPinCard(lnglat);
  reveal(lnglat);
  E.emit('pin', { lngLat: lnglat, name: 'Dropped pin', cell: cell ? cell.f.properties.id : null, score: cell ? Math.round(feelScore(cell.f.properties) * 100) / 100 : null });
  writeHash();
}
function showPinCard(lnglat, o = {}) {
  const cell = cellAt(lnglat);
  if (cell) { showCellCard(cell.L, cell.f, lnglat, o); return; }
  E.ui.showCard({ kind: 'pin', title: "What's it like here?", subtitle: `${lnglat[1].toFixed(5)}, ${lnglat[0].toFixed(5)}`, emoji: '📍', color: '#ef4444', refresh: !!o.refresh,
    // the "ask for a layer" hint is for the person building the map (inside Instafy), not for someone it was shared with
    body: gridLayer() ? 'Outside the calm ↔ lively grid of this map.' : window.parent !== window ? 'No calm ↔ lively grid on this map yet: ask for one to see what it is like here.' : '',
    nearby: nearby(lnglat, 3), actions: [...intentActs('map-context', null, { pin: lnglat, ui: 'map-context' }), { icon: 'maps', label: 'Open in Maps', href: mapsLink('', lnglat) }, { icon: 'share', label: 'Share', onClick: () => share('A spot') }] });
}
function removePin(silent) {
  if (pinMarker) { pinMarker.remove(); pinMarker = null; }
  if (E.pin) { E.pin = null; if (!E.sel) setSelFeature(null); }
  if (!silent) writeHash();
}

// ---------------- share ----------------
async function share(title) {
  writeHash.flush?.();
  const url = location.href;
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) { await navigator.share({ title: `${title} · ${E.config.title || 'Map'}`, url }); return; }
  } catch (e) { if (e?.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); E.ui.toast('🔗 Link copied'); } catch { E.ui.toast('Copy this link from the address bar'); }
}

// ---------------- walk it ----------------
function stopWalk() {
  if (!E.walking) return;
  cancelAnimationFrame(E.walking.raf); clearTimeout(E.walking.timer);
  E.walking = null;
  E.map.getSource('uw--walk')?.setData(EMPTY);
}
function walk(layerId, fid) {
  const L = E.layers.byId.get(layerId);
  if (!L || L.error) { E.ui.toast('Nothing to walk here yet'); return; }
  if (!L.visible) setLayerVisible(L.id, true);
  const f = fid != null ? L.byFid.get(String(fid)) : L.data.features.find((x) => /Line/.test(x.geometry.type)) || L.data.features[0];
  if (!f) return;
  if (L.type === 'areas') {
    if (L.linkedTo) E.map.setGlobalStateProperty('sel_' + L.linkedTo, f.properties.for ?? null);
    E.ui.revealMap('half');
    flyTo(bbox(f.geometry), { maxZoom: 16 });
    E.ui.toast(`🟣 ${f.properties.minutes || 10}-minute ${isBike(f.properties.mode) ? 'ride' : 'walk'} from here`);
    return;
  }
  const coords = L.type === 'legs' ? f.properties._arc : lineCoords(f.geometry);
  if (!coords || coords.length < 2) return;
  stopWalk();
  E.ui.revealMap('peek');
  const p = f.properties;
  const summary = [p.duration_min != null ? `${Math.round(p.duration_min)} min` : null, p.distance_km != null ? `${p.distance_km} km` : null].filter(Boolean).join(' · ');
  if (reducedMotion()) { flyTo(bbox(f.geometry)); E.ui.toast(`🚶 ${p.name || L.title}${summary ? ' · ' + summary : ''}`); return; }
  const cum = cumulative(coords), color = p._color || (typeof p.color === 'string' ? p.color : L.color);
  E.map.setPaintProperty('uw--walk-trail', 'line-color', color);
  const walker = L.type === 'legs' ? (p._emoji || '🚆') : walkLabel(p.mode)[0];
  E.map.setLayoutProperty('uw--walk-dot', 'icon-image', ensureIcon(E.map, walker, color, 34, true));
  const W = E.walking = { raf: 0, timer: 0 };
  const startZoom = L.type === 'legs' ? E.map.getZoom() : clamp(Math.max(E.map.getZoom(), 15.6), 0, 17.2);
  zeroPadding();
  E.map.easeTo({ center: coords[0], zoom: startZoom, offset: visOffset(), duration: 700 });
  E.ui.toast(`${walker} ${L.type === 'legs' ? 'Travelling' : isBike(p.mode) ? 'Riding it' : 'Walking it'}… tap the map to stop`, 2000);
  const dur = L.type === 'legs' ? 4500 : 6000;
  W.timer = setTimeout(() => {
    let t0 = null;
    const frame = (now) => {
      if (E.walking !== W) return;
      if (t0 == null) t0 = now;
      const t = clamp((now - t0) / dur, 0, 1), e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const pt = along(coords, 0.04 * t + 0.96 * e, cum);
      const trail = coords.slice(0, pt[2]).concat([[pt[0], pt[1]]]);
      E.map.getSource('uw--walk').setData({ type: 'FeatureCollection', features: [
        { type: 'Feature', geometry: { type: 'LineString', coordinates: trail.length > 1 ? trail : [coords[0], coords[0]] }, properties: {} },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [pt[0], pt[1]] }, properties: {} }] });
      if (L.type !== 'legs') E.map.jumpTo({ center: centerFor([pt[0], pt[1]]) });
      if (t < 1) W.raf = requestAnimationFrame(frame);
      else {
        E.ui.toast(`🏁 ${p.name || L.title}${summary ? ' · ' + summary : ''}`, 3200);
        W.timer = setTimeout(() => { if (E.walking === W) stopWalk(); }, 2600);
      }
    };
    W.raf = requestAnimationFrame(frame);
  }, 720);
}

// ---------------- time / vibe / look ----------------
const applyLook = rafThrottle(() => {
  if (!E.look) return;
  const b = E.config.basemap || {};
  const { dark, warm } = lookFor(b.theme || 'auto', E.hour, !!E.config.time?.enabled);
  E.look.apply(dark, warm);
  E.layers.applyTheme(dark);
  E.map.setSky(skyFor(dark, E.look));
  const look = dark > 0.6 ? 'night' : warm > 0.35 ? 'dusk' : 'day';
  if (E.ui.root.dataset.look !== look) { E.ui.root.dataset.look = look; E.emit('look', { look }); }
});
const emitTime = debounce(() => E.emit('time', { hour: E.hour, label: fmtHour(E.hour) }), 250);
const emitVibe = debounce(() => E.emit('vibe', { vibe: E.vibe, label: vibeWord(E.vibe) }), 250);
// hour drives the time-window filters, and every change re-lays out those symbols. Features can only appear or vanish
// at their own time_from / time_to, so while the slider moves the new hour is pushed only when it crosses one of them.
let hourEdges = null, pushedBucket = null;
function hourBucket(h) {
  if (!hourEdges) {
    const s = new Set();
    for (const L of E.layers?.list || []) if (L.hasTimes) for (const f of L.data.features) for (const k of ['time_from', 'time_to']) {
      const v = Number(f.properties[k]); if (f.properties[k] != null && isFinite(v)) s.add(((v % 24) + 24) % 24);
    }
    hourEdges = [...s].sort((a, b) => a - b);
  }
  h = ((h % 24) + 24) % 24;
  let i = 0; while (i < hourEdges.length && hourEdges[i] <= h) i++;
  return i;
}
const pushHour = rafThrottle((force) => {
  if (!E.map) return;
  const b = hourBucket(E.hour);
  if (!force && b === pushedBucket) return;
  pushedBucket = b;
  E.map.setGlobalStateProperty('hour', E.hour % 24);
});
function setTime(hour, o = {}) {
  hour = clamp(Number(hour) || 0, 0, 24);
  E.hour = hour;
  if (!E.map || !E.layers) return;
  pushHour(o.final !== false);
  const n = isNight(hour);
  if (n !== E.night) { E.night = n; E.map.setGlobalStateProperty('night', n); }
  E.layers.refreshTimes(hour);
  updateNotes();
  updateAir();
  E.ui.updateTime(hour);
  applyLook();
  if (o.final !== false) {
    emitTime(); writeHash();
    if (E.Q && E.booted) { applyBudgets(); renderLensRow(); }
    updateLegend();
    const cc = E.ui.card;
    if (cc && (cc.kind === 'cell')) refreshCard();
    if (o.final) { renderLayersTab(); renderPlaces(); }
  }
}
function setVibe(v, o = {}) {
  v = clamp(Number(v) || 0, 0, 1);
  E.vibe = v;
  if (!E.map) return;
  E.map.setGlobalStateProperty('vibe', v);
  E.ui.updateVibe(v);
  emitVibe(); writeHash();
  if (o.final) updateLegend();
  if (E.ui.card?.kind === 'cell' && o.final) refreshCard();
}
function refreshCard() {
  const c = E.ui.card; if (!c) return;
  if (c.kind === 'cell') {
    if (E.pin) { const cell = cellAt(E.pin); if (cell) showCellCard(cell.L, cell.f, E.pin); }
    else if (E.sel) { const L = E.layers.byId.get(E.sel.layer); showCellCard(L, L.byFid.get(E.sel.id), null); }
  }
}

// ---------------- air ----------------
// air.json (written by `uw.mjs air`): { source, attribution, note, locations: [{ id, name, lng, lat, by_hour: {"0": {pm2_5…}…}, current, hourly }] }.
// Also accepts hour_of_day / hourly_avg arrays of 24, or a raw Open-Meteo response.
function parseAirLoc(loc, j, single) {
  const pick = (o) => (o == null ? null : typeof o === 'number' ? o : o.pm2_5 ?? o.pm25 ?? o['pm2.5'] ?? null);
  const as24 = (v) => {
    if (Array.isArray(v) && v.length === 24) { const a = v.map(pick); return a.every((x) => typeof x === 'number') ? a : null; }
    if (v && typeof v === 'object') {
      for (const k of ['pm2_5', 'pm25']) if (Array.isArray(v[k]) && v[k].length === 24) return v[k].map(Number);
      const ks = Object.keys(v); if (ks.length === 24 && ks.every((k) => /^\d+$/.test(k))) { const a = []; for (let i = 0; i < 24; i++) a.push(pick(v[i] ?? v[String(i).padStart(2, '0')])); if (a.every((x) => typeof x === 'number')) return a; }
    }
    return null;
  };
  const search = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 3) return null;
    for (const [k, v] of Object.entries(o)) if (/hour/i.test(k) && !/^hourly$/i.test(k)) { const a = as24(v); if (a) return a; }
    for (const [k, v] of Object.entries(o)) if (k !== 'locations' && v && typeof v === 'object' && !Array.isArray(v)) { const a = search(v, depth + 1); if (a) return a; }
    return null;
  };
  let byHour = search(loc) || (single ? search(j) : null);
  const hourly = loc.hourly || (single ? j.hourly : null);
  if (!byHour && hourly && Array.isArray(hourly.time) && Array.isArray(hourly.pm2_5)) {
    const sum = Array(24).fill(0), n = Array(24).fill(0);
    hourly.time.forEach((t, i) => { const v = hourly.pm2_5[i]; const hh = +String(t).slice(11, 13); if (typeof v === 'number' && hh >= 0 && hh < 24) { sum[hh] += v; n[hh]++; } });
    if (n.some(Boolean)) byHour = sum.map((s, i) => (n[i] ? s / n[i] : null));
  }
  const now = pick(loc.current || (single ? j.current : null));
  if (!byHour && now == null) return null;
  const at = Array.isArray(loc.at) ? loc.at : isFinite(loc.lng) && isFinite(loc.lat) ? [+loc.lng, +loc.lat]
    : isFinite(loc.longitude) && isFinite(loc.latitude) ? [+loc.longitude, +loc.latitude] : null;
  return { byHour, now, at, id: loc.id != null ? String(loc.id) : null, label: loc.name || j.name || 'Regional air' };
}
function parseAir(j) {
  if (!j || typeof j !== 'object') return null;
  const raw = Array.isArray(j.locations) && j.locations.length ? j.locations : [j];
  const locs = raw.map((l) => (l && typeof l === 'object' ? parseAirLoc(l, j, raw.length === 1) : null)).filter(Boolean);
  if (!locs.length) return null;
  const cams = /cams|copernicus/i.test(`${j.source || ''} ${j.attribution || ''}`) || !j.source;
  return { locs, source: j.source || 'Open-Meteo / CAMS', attribution: typeof j.attribution === 'string' ? j.attribution : null,
    disclaimer: typeof j.disclaimer === 'string' ? j.disclaimer : cams ? 'Neither the European Commission nor ECMWF is responsible for any use of this information.' : null };
}
/** The air location that matters now: the selected feature's own entry, else the one nearest the selection / pin / map centre. */
function airLoc() {
  const a = E.air; if (!a) return null;
  if (a.locs.length === 1) return a.locs[0];
  let ref = null;
  if (E.sel) {
    const own = a.locs.find((l) => l.id === E.sel.id); if (own) return own;
    const L = E.layers.byId.get(E.sel.layer), f = L?.byFid.get(E.sel.id); if (f) ref = E.layers.featureCenter(L, f);
  }
  if (!ref && E.pin) ref = E.pin;
  if (!ref) { const c = E.map.getCenter(); ref = [c.lng, c.lat]; }
  let best = a.locs[0], bd = Infinity;
  for (const l of a.locs) if (l.at) { const d = distM(ref, l.at); if (d < bd) { bd = d; best = l; } }
  return best;
}
function updateAir() {
  const l = airLoc(); if (!l) return;
  const hh = Math.floor(E.hour) % 24;
  const v = l.byHour ? l.byHour[hh] ?? l.now : l.now;
  E.ui.setAir(typeof v === 'number' ? { pm25: v, label: E.air.locs.length > 1 ? `Near ${l.label}` : l.label, source: E.air.source, disclaimer: E.air.disclaimer } : null);
}

// ---------------- notes ----------------
const notes = [];
function buildNotes() {
  for (const n of E.config.notes || []) {
    // with a question, a note about an option is an editorial why line in its card, not a bubble over the pins
    if (E.Q && n.at?.layer && E.Q.isOption(n.at.layer, n.at.id)) {
      const ref = refOf(n.at.layer, String(n.at.id));
      (E.optionNotes.get(ref) || E.optionNotes.set(ref, []).get(ref)).push({ text: n.text || '', emoji: n.emoji || null, time: n.time });
      continue;
    }
    let at = null;
    if (Array.isArray(n.at)) at = n.at;
    else if (n.at && n.at.layer) { const L = E.layers.byId.get(n.at.layer), f = L?.byFid.get(String(n.at.id)); if (f) at = E.layers.featureCenter(L, f); }
    if (!at) { console.warn('[map] note target not found', n.at); continue; }
    const text = n.text || '';
    // marker element = a 0×0 anchor at the point; the bubble hangs off it (to the right, or flipped left near the
    // button column / screen edge). The button is ≥ 44 px tall for thumbs; the visible bubble is the inner span.
    const btn = h('button.uw-bubble', { type: 'button', 'aria-label': text || 'Note', 'aria-expanded': 'false' },
      h('span.uw-bubble-in', h('span.uw-bubble-e', { 'aria-hidden': 'true' }, n.emoji || '💬'), h('span.uw-bubble-t', text)));
    const el = h('div.uw-note', btn);
    const T = n.at?.layer ? E.layers.byId.get(n.at.layer) : null;
    const r = T && T.type === 'points' ? T.size / 2 : 6;
    el.style.setProperty('--off', Math.round(r * 0.72) + 'px');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !el.classList.contains('is-open');
      for (const x of notes) if (x.el !== el) { x.el.classList.remove('is-open'); x.btn.setAttribute('aria-expanded', 'false'); }
      el.classList.toggle('is-open', open); btn.setAttribute('aria-expanded', String(open));
      layoutNotes();
    });
    const m = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(at).addTo(E.map);
    el.removeAttribute('aria-label'); el.removeAttribute('role'); // MapLibre labels every marker "Map marker"; the button says what it is
    notes.push({ n, el, btn, m, L: T });
  }
  updateNotes();
}
function updateNotes() {
  const far = E.map && E.map.getZoom() < 13.5;
  const timed = !!E.config.time?.enabled;
  for (const x of notes) x.el.hidden = far || (timed && !inWindow(E.hour, x.n.time)) || (x.L && !x.L.shown);
  layoutNotes();
}
/** Keep note bubbles off the buttons, the panel, the screen edges and each other: flip left, else shrink to the emoji. */
const layoutNotes = rafThrottle(() => {
  if (!notes.length || !E.ui) return;
  const root = E.ui.root.getBoundingClientRect(), W = root.width, H = root.height;
  const blocks = [];
  const grow = (r, m) => ({ left: r.left - m, top: r.top - m, right: r.right + m, bottom: r.bottom + m });
  for (const b of E.ui.fabs.children) if (!b.hidden) blocks.push(grow(b.getBoundingClientRect(), 6));
  const sh = E.ui.sheet.getBoundingClientRect();
  blocks.push(grow(sh, 4));
  const at = E.ui.root.querySelector('.maplibregl-ctrl-top-left .maplibregl-ctrl-attrib');
  if (at) blocks.push(grow(at.getBoundingClientRect(), 4));
  for (const el of [E.ui.legendPill, E.ui.tuneEl]) if (el && !el.hidden && el.isConnected) blocks.push(grow(el.getBoundingClientRect(), 4));
  const hit = (r, q) => r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top;
  const pins = pinBoxes();
  const coversPin = (r, own, kinds) => pins.some((b) => b.id !== own && (!kinds || kinds.includes(b.kind)) && hit(r, b));
  // r = the visible bubble, t = its 44 px tap box (which must not sit on top of a button either)
  const bad = (r, placed, own, t = r) => r.left < 6 || r.right > W - 6 || r.top < 6 || r.bottom > H - 4 || blocks.some((q) => hit(t, q)) || placed.some((q) => hit(r, q)) || coversPin(r, own);
  const placed = [];
  // open (tapped) bubbles first so they win
  const order = notes.filter((x) => !x.el.hidden).sort((a, b) => b.el.classList.contains('is-open') - a.el.classList.contains('is-open'));
  const onScreen = (r) => r.left >= 4 && r.right <= W - 4 && r.top >= 4 && r.bottom <= H - 2;
  const PLACES = [['', 0], ['is-left', 0], ['is-above', 0], ['is-below', 0], ['', 1], ['is-left', 1]];
  for (const x of order) {
    const inner = x.btn.firstChild, own = x.n.at?.id != null ? String(x.n.at.id) : null;
    // try: right, left, above, below, then the emoji alone (an open bubble stays full)
    const tries = x.el.classList.contains('is-open') ? PLACES.slice(0, 4) : PLACES;
    let ok = null, fallback = null;
    x.el.classList.remove('is-gone');
    for (const [pos, mini] of tries) {
      x.el.classList.remove('is-left', 'is-above', 'is-below');
      if (pos) x.el.classList.add(pos);
      x.el.classList.toggle('is-mini', !!mini);
      const r = inner.getBoundingClientRect(), t = x.btn.getBoundingClientRect();
      if (!bad(r, placed, own, t)) { ok = r; break; }
      // the emoji may sit over a small context pin, never over an option or support pin
      if (!fallback && mini && onScreen(r) && !placed.some((q) => hit(r, q)) && !blocks.some((q) => hit(t, q)) && !coversPin(r, own, ['option', 'support'])) fallback = [pos, mini, r];
    }
    if (!ok && fallback) { x.el.classList.remove('is-left', 'is-above', 'is-below'); if (fallback[0]) x.el.classList.add(fallback[0]); x.el.classList.toggle('is-mini', true); ok = fallback[2]; }
    // nowhere to go without covering a pin, the buttons, the panel or the screen edge: leave it out until the map moves
    if (!ok) { x.el.classList.add('is-gone'); continue; }
    placed.push(grow(ok, 2));
  }
});
/** Screen boxes (44 px) of the rendered option and support pins (v0 sites: the m / l pins), for notes and uw.signal(). */
function pinBoxes() {
  if (!E.map || !E.layers) return [];
  const ids = [];
  const kindOf = new Map();
  for (const x of E.layers.hit) {
    if (!E.map.getLayer(x.id) || /-hit$|-dot$|-rest$/.test(x.id)) continue;
    let kind = null;
    if (x.kind === 'option') kind = 'option';
    else if (x.kind === 'leg') kind = 'support';
    else if (x.kind === 'point' && x.layer?.type === 'points') kind = E.Q ? (x.layer.tier === 'support' ? 'support' : null) : (x.layer.size >= 30 ? 'support' : null);
    if (kind) { ids.push(x.id); kindOf.set(x.id, kind); }
  }
  if (!ids.length) return [];
  const mapR = E.ui.mapEl.getBoundingClientRect();
  let fs = [];
  try { fs = E.map.queryRenderedFeatures({ layers: ids }); } catch { return []; }
  const out = [], seen = new Set();
  for (const f of fs) {
    if (f.geometry?.type !== 'Point') continue;
    const k = f.layer.id + '|' + f.properties?.id; if (seen.has(k)) continue; seen.add(k);
    const pt = E.map.project(f.geometry.coordinates), r = 22;
    out.push({ id: f.properties?.id != null ? String(f.properties.id) : null, kind: kindOf.get(f.layer.id), left: mapR.left + pt.x - r, right: mapR.left + pt.x + r, top: mapR.top + pt.y - r, bottom: mapR.top + pt.y + r });
  }
  return out;
}

// ---------------- panels ----------------
function placeItem(L, f) {
  const p = f.properties, card = L.def.card || {};
  const v = voteInfo(p.id);
  const sub = card.subtitle ? fill(card.subtitle, p) : [p.kind ? humanize(p.kind) : '', p.area].filter(Boolean).join(' · ');
  const name = displayName(p);
  return { id: p.id, layer: L.id, name, sub: sub || L.title, emoji: p._emoji, color: p._color || L.color,
    search: [p.name, p.name_en, p.kind, p.area, sub].filter(Boolean).join(' ').toLowerCase(),
    vote: v.up.length || v.down.length ? { kind: v.up.length >= v.down.length ? 'up' : 'down', text: [v.up.length ? `👍 ${v.up.length}` : '', v.down.length ? `👎 ${v.down.length}` : ''].filter(Boolean).join('  ') } : null,
    dim: (!!E.config.time?.enabled && p.time_from != null && !inWindow(E.hour, [p.time_from, p.time_to ?? 24])) || v.mine === 'down' };
}
function renderPlaces() {
  if (!E.ui.panels.places) return;
  // the compared layer first, then top-most layers first (config order is draw order, so the main subject is usually last)
  const cmp = E.Q?.optionLayer || E.config.compare?.layer;
  const listed = E.layers.list.filter((L) => L.list && !L.error && L.type === 'points').reverse().sort((a, b) => (b.id === cmp) - (a.id === cmp));
  // layers that are switched off or outside their time window stay findable, but dimmed (tapping one turns it on)
  const groups = listed.map((L) => {
    const off = L.shown === false;
    const items = L.data.features.map((f) => { const it = placeItem(L, f); if (off) it.dim = true; return it; });
    let more = null, title = L.title;
    if (E.Q && L.id === E.Q.optionLayer) {
      // options first, in rank order, with their letters and verdict phrases
      const order = new Map(E.Q.rankList().map((r, i) => [r.o.id, i]));
      const vl = new Map((E.verdict?.lines || []).map((l) => [l.ref, l]));
      for (const it of items) {
        const o = E.Q.optionById(L.id, it.id);
        if (o) { it.letter = o.letter; if (o.color) it.color = o.color; const l = vl.get(o.ref); if (l?.phrases?.length) it.sub = l.phrases.join(' · '); const b = E.records.bestOffer(o.ref); if (b) it.price = fmtMoney(b.price.amount, b.price.currency); }
        else { it.small = true; if (!E.placesAll.has(L.id)) it.hide = true; }
      }
      items.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
      const rest = items.filter((it) => it.hide).length;
      if (E.Q.kind === 'find-place') title = `Top ${E.Q.opts.length} · ${L.title}`;
      if (rest) more = { label: `Show all ${items.length}`, onClick: () => { E.placesAll.add(L.id); renderPlaces(); } };
    } else if (E.Q && L.budgetIds && !E.placesAll.has(L.id)) {
      const keep = new Set(L.budgetIds);
      for (const it of items) if (!keep.has(it.id)) it.hide = true;
      if (items.some((it) => it.hide)) more = { label: `Show all ${items.length}`, onClick: () => { E.placesAll.add(L.id); renderPlaces(); } };
    }
    if (E.bind?.active) for (const it of items) { const x = E.itemFor(refOf(L.id, it.id)); const m = intentActs('list-row', x); if (m.length) it.menu = m; }
    return { title, items, off: off ? (L.visible ? '· not now' : '· layer off') : null, more };
  });
  groups.sort((a, b) => !!a.off - !!b.off);
  E.ui.renderPlaces(groups);
}
function renderLayersTab() {
  if (!E.ui.panels.layers) return;
  const order = []; const by = new Map();
  for (const L of E.layers.list) { if (!by.has(L.group)) { by.set(L.group, []); order.push(L.group); } by.get(L.group).push(L); }
  const srcs = [OSM, OFM, OMT, ...(E.config.attribution || []), ...E.layers.list.map((L) => L.attribution).filter(Boolean)];
  const extra = h('p.uw-note.uw-foot'); extra.innerHTML = 'Sources: ' + [...new Set(srcs)].join(' · ');
  E.ui.renderLayers(order.map((g) => ({ title: g, layers: by.get(g) })), extra);
}
function compareModel() {
  const c = E.config.compare; if (!c) return null;
  const L = E.layers.byId.get(c.layer); if (!L || L.error) return null;
  const max = clamp(c.max || 3, 1, 5);
  if (!E.compareSet) {
    // 👍 picks first, then compare.default (ids the map maker chose), then layer order
    const picks = L.data.features.filter((f) => voteInfo(f.properties.id).up.length).map((f) => f.properties.id);
    const dflt = Array.isArray(c.default) ? c.default.map(String).filter((id) => L.byFid.has(id)) : [];
    E.compareSet = [...new Set([...picks, ...dflt, ...L.data.features.map((f) => f.properties.id)])].slice(0, max);
  }
  const all = L.data.features.map((f) => { const n = displayName(f.properties) || f.properties.id; return { id: f.properties.id, name: n, short: n.length > 18 ? n.slice(0, 17) + '…' : n, emoji: f.properties._emoji, props: f.properties }; });
  const chosen = E.compareSet.filter((id) => L.byFid.has(id));
  const wins = {};
  const metrics = (c.metrics || []).map((m0) => {
    const m = { label: humanize(m0.key), ...m0 };
    let bv = null;
    if (m.better) for (const id of chosen) { const v = L.byFid.get(id).properties[m.key]; if (typeof v !== 'number') continue; if (bv == null || (m.better === 'lower' ? v < bv : v > bv)) bv = v; }
    // ties: every leader gets the star, nobody gets the win
    const eps = bv == null ? 0 : Math.max(1e-9, Math.abs(bv) * 1e-6);
    const leaders = bv == null ? [] : chosen.filter((id) => { const v = L.byFid.get(id).properties[m.key]; return typeof v === 'number' && Math.abs(v - bv) <= eps; });
    if (leaders.length === 1 && chosen.length > 1) wins[leaders[0]] = (wins[leaders[0]] || 0) + 1;
    return { ...m, best: leaders, scale: (v) => barFor(L, m.key, v, m) };
  });
  const top = Object.entries(wins).sort((a, b) => b[1] - a[1]);
  const winner = top.length && (top.length < 2 || top[0][1] > top[1][1]) && chosen.length > 1 ? { name: all.find((x) => x.id === top[0][0]).name, wins: top[0][1] } : null;
  return { layer: L.id, max, all, chosen, metrics, winner };
}
function renderCompare() { if (!E.ui.panels.compare) return; if (E.Q) E.ui.renderCompare2(compareModel2()); else E.ui.renderCompare(compareModel()); }
function toggleCompare(id) {
  const m = compareModel(); if (!m) return;
  const s = E.compareSet;
  if (s.includes(id)) E.compareSet = s.filter((x) => x !== id);
  else { s.push(id); if (s.length > m.max) s.shift(); }
  renderCompare();
}
function renderPlan() { if (E.ui.panels.plan) E.ui.renderPlan(E.config.plan, E.day ?? 0); }
function refInfo(ref) {
  const L = E.layers.byId.get(ref.layer), f = L?.byFid.get(String(ref.id));
  return f ? { name: displayName(f.properties), emoji: f.properties._emoji ?? L.emoji, color: f.properties._color || L.color } : null;
}
function setDay(i, o = {}) {
  const days = E.config.plan?.days || []; if (!days.length) return;
  i = clamp(Math.round(i), 0, days.length - 1);
  E.day = i;
  const d = days[i];
  if (d.time != null && E.config.time?.enabled) setTime(d.time, { final: true });
  const routes = new Set(days.map((x) => x.route).filter(Boolean));
  for (const r of routes) if (E.layers.byId.has(r)) setLayerVisible(r, r === d.route, { quiet: true });
  if (d.focus) select(d.focus.layer, d.focus.id, { card: false, fly: false });
  else if (E.sel || E.pin) clearSelection({ silent: true });
  if (o.fly !== false) {
    E.ui.revealMap('half');
    const geoms = [];
    const rf = dayRouteFeature(d);
    if (rf) geoms.push(rf);
    if (d.focus) { const L = E.layers.byId.get(d.focus.layer), f = L?.byFid.get(String(d.focus.id)); if (f) geoms.push(f); }
    for (const it of d.items || []) if (it.ref) {
      const L = E.layers.byId.get(it.ref.layer), f = L?.byFid.get(String(it.ref.id));
      if (f) geoms.push(L.type === 'legs' ? { type: 'Feature', geometry: { type: 'LineString', coordinates: f.properties._arc }, properties: {} } : f);
    }
    const b = bbox(geoms);
    // a camera failure must never leave the stepper and the map on different days
    try { if (b) flyTo(b, { maxZoom: 16, extra: 6, extraBottom: 22 }); } catch (e) { console.warn('[map] plan day camera:', e.message); }
  }
  renderPlan(); renderLayersTab();
  E.emit('day', { index: i, day: i + 1, title: d.title || `Day ${i + 1}` });
  writeHash();
  navChanged();
}

function setLayerVisible(id, on, o = {}) {
  const L = E.layers.byId.get(id); if (!L) { console.warn(`[map] setLayerVisible: unknown layer ${id}`); return; }
  E.userVis.set(id, !!on);
  applyVisibility(L);
  if (!on && E.sel?.layer === id) clearSelection();
  // a user toggle makes a reveal permanent (the whole layer is on) or undoes it
  if (E.reveal?.layers.has(id) && E.sel) { const S = E.layers.byId.get(E.sel.layer), f = S?.byFid.get(E.sel.id); if (f) revealFor(S, f); }
  if (E.Q) applyBudgets();
  updateNotes();
  updateLegend();
  renderLayersTab();
  if (!o.quiet) E.emit('layer', { layer: id, id, name: L.title, visible: !!on });
  writeHash();
}

/** Public filter: keeps the full data in L.all and swaps what the map, lists and lookups see. */
function setFilter(layerId, fn) {
  const L = E.layers?.byId.get(layerId);
  if (!L || L.error) { console.warn(`[map] setFilter: unknown layer ${layerId}`); return 0; }
  L.all ||= L.data;
  const feats = typeof fn === 'function' ? L.all.features.filter((f) => { try { return !!fn(f); } catch { return false; } }) : L.all.features;
  L.data = { type: 'FeatureCollection', features: feats };
  L.byFid = new Map(feats.map((f) => [f.properties.id, f]));
  if (L.type === 'points' || L.type === 'lines' || L.type === 'areas' || L.type === 'route' || L.type === 'heat' || L.type === 'grid') E.map.getSource(L.sources[0])?.setData(L.data);
  else console.warn(`[map] setFilter: layer type "${L.type}" is filtered in lists only`);
  statsCache.clear(); hourEdges = null;
  if (E.sel?.layer === layerId && !L.byFid.has(E.sel.id)) clearSelection();
  if (E.compareSet && E.config.compare?.layer === layerId) E.compareSet = E.compareSet.filter((id) => L.byFid.has(id));
  applyVotesState();
  refreshPanels();
  return feats.length;
}
function refreshPanels(o = {}) {
  if (!E.layers) return;
  renderPlaces(); renderLayersTab(); renderCompare(); if (!o.soft) renderPlan();
  const c = E.ui.card;
  if (c?.kind === 'feature' && E.sel) {
    const L = E.layers.byId.get(E.sel.layer), f = L?.byFid.get(E.sel.id);
    if (f) { if (L.verdict) showAreaCard(L, f); else showFeatureCard(L, f, { refresh: true }); }
  }
  else if (c?.kind === 'cell') refreshCard();
}

// ---------------- tabs ----------------
function buildTabs() {
  const tabs = [];
  const lc = E.config.locale;
  if (E.layers.list.some((L) => L.list && L.type === 'points')) tabs.push({ id: 'places', label: word(lc, 'places') });
  // one order on every map: Places, the map's own tab (Plan, Compare), then the map key (layers)
  if (E.config.plan?.days?.length) tabs.push({ id: 'plan', label: E.config.plan.title || word(lc, 'plan') });
  if ((E.config.compare && E.layers.byId.get(E.config.compare.layer)) || (E.Q && E.Q.opts.length >= 2 && (E.Q.kind === 'choose-one' || E.Q.kind === 'find-place'))) tabs.push({ id: 'compare', label: word(lc, 'compare') });
  if (E.layers.list.length) tabs.push({ id: 'layers', label: word(lc, 'layers') });
  if (!tabs.length) tabs.push({ id: 'about', label: 'About' });
  // the question picks the first tab (§1.2): Compare to choose one, Places to find, Plan for a route
  if (E.Q && !E.ui.tab) {
    const want = E.Q.kind === 'choose-one' && E.Q.opts.length >= 2 ? 'compare' : E.Q.kind === 'plan-route' ? 'plan' : 'places';
    if (tabs.some((t) => t.id === want)) E.ui.tab = want;
  }
  E.ui.buildTabs(tabs);
  if (E.ui.panels.about) {
    E.ui.panels.about.append(h('div.uw-emptystate', h('div.uw-emptystate-e', '🗺️'), h('h2', 'A blank map, ready to fill'),
      h('p', 'Ask for places, a walk between two spots, how calm or lively the blocks are, or recolour the basemap.'),
      h('p.uw-note', 'Long-press (or right-click) anywhere to drop a pin.')));
  }
  renderPlaces(); renderPlan(); renderLayersTab(); renderCompare();
}

// ---------------- map interactions ----------------
function bindMap() {
  const map = E.map, cont = map.getCanvasContainer();
  let lastLong = 0;
  map.on('click', (e) => {
    if (e.originalEvent?.target?.closest?.('.uw-bubble, .uw-pin, .uw-me')) return;
    if (E.walking) { stopWalk(); return; }
    if (performance.now() - lastLong < 800) return;
    const touch = e.originalEvent && (e.originalEvent.pointerType === 'touch' || matchMedia('(pointer: coarse)').matches);
    const r = touch ? 16 : 7;
    const ids = E.layers.hitLayerIds();
    const hits = ids.length ? map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers: ids }) : [];
    if (!hits.length) { if (E.sel || E.pin) clearSelection(); return; }
    let best = null, bestScore = -Infinity;
    for (const f of hits) {
      const info = E.layers.hitInfo(f.layer.id); if (!info) continue;
      let s = info.rank * 1000;
      if (f.geometry.type === 'Point') { const p = map.project(f.geometry.coordinates); s -= Math.hypot(p.x - e.point.x, p.y - e.point.y); }
      if (s > bestScore) { bestScore = s; best = { f, info }; }
    }
    if (!best) return;
    const { f, info } = best;
    if (info.kind === 'reveal') { if (f.properties._layer && f.properties.id != null) select(f.properties._layer, f.properties.id, { from: 'map' }); return; }
    if (info.kind === 'cluster') {
      map.getSource(f.source).getClusterExpansionZoom(f.properties.cluster_id).then((z) => {
        // never more than 3 levels in one tap: a 2-café cluster used to jump from z11 to z16
        zeroPadding();
        map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(z + 0.4, map.getZoom() + 3, 18), offset: visOffset(), duration: reducedMotion() ? 0 : 600 });
      }).catch(() => {});
      return;
    }
    const id = f.properties.id;
    if (id == null) return;
    select(info.layer.id, id, { from: 'map' });
  });
  map.on('contextmenu', (e) => { e.preventDefault?.(); if (performance.now() - lastLong < 900) return; lastLong = performance.now(); dropPin(e.lngLat); });
  // long-press on touch
  let lp = null;
  const cancel = () => { if (lp) { clearTimeout(lp.timer); lp = null; } };
  cont.addEventListener('touchstart', (e) => {
    if (E.walking) stopWalk();
    if (e.touches.length !== 1) { cancel(); return; }
    const t = e.touches[0], r = cont.getBoundingClientRect();
    cancel();
    lp = { x: t.clientX, y: t.clientY, timer: setTimeout(() => {
      if (!lp) return;
      lastLong = performance.now();
      const ll = map.unproject([lp.x - r.left, lp.y - r.top]); lp = null;
      try { navigator.vibrate?.(12); } catch { /* */ }
      dropPin(ll);
    }, 500) };
  }, { passive: true });
  cont.addEventListener('touchmove', (e) => { if (lp && e.touches[0] && Math.hypot(e.touches[0].clientX - lp.x, e.touches[0].clientY - lp.y) > 10) cancel(); }, { passive: true });
  cont.addEventListener('touchend', cancel, { passive: true });
  cont.addEventListener('touchcancel', cancel, { passive: true });
  cont.addEventListener('mousedown', () => { if (E.walking) stopWalk(); });
  map.on('movestart', (e) => { if (e.originalEvent && e.originalEvent.type !== 'touchstart') cancel(); });
  map.on('moveend', () => { writeHash(); layoutNotes(); edgeLabels(); if (E.air?.locs.length > 1 && !E.sel) updateAir(); });
  // follow mode: the presenter's camera goes out while it moves (follow.js keeps it to 10 a second)
  map.on('move', () => follow.changed());
  // any move but the "Show my location" flight takes the camera off the viewer's own position
  map.on('movestart', (e) => { if (!e.uwMe) E.camOnMe = false; });
  // a presenter's tap: where, for the followers' ripple. Never a tap on (or right by) the viewer's own "me" dot
  map.on('click', (e) => {
    if (!follow.presenting) return;
    if (!follow.share.location && meMarker) {
      if (e.originalEvent?.target?.closest?.('.uw-me')) return;
      const m = map.project(meMarker.getLngLat());
      if (Math.hypot(m.x - e.point.x, m.y - e.point.y) < 28) return;
    }
    const oe = e.originalEvent, w = window.innerWidth || 1, hh = window.innerHeight || 1;
    const x = oe && isFinite(oe.clientX) ? oe.clientX / w : e.point.x / w, y = oe && isFinite(oe.clientY) ? oe.clientY / hh : e.point.y / hh;
    follow.tapped(x, y, [e.lngLat.lng, e.lngLat.lat]);
  });
  edgeLabels();
  // during flights and drags too (a few times a second), so a bubble never slides under the buttons on its way
  let lastNoteLayout = 0;
  map.on('move', () => { const t = performance.now(); if (notes.length && t - lastNoteLayout > 220) { lastNoteLayout = t; layoutNotes(); } });
  let wasFar = null;
  map.on('zoom', () => { const far = map.getZoom() < 13.5; if (far !== wasFar) { wasFar = far; updateNotes(); } });
  // hover cursor (desktop nicety only; nothing depends on hover)
  map.on('mousemove', rafThrottle((e) => {
    const ids = E.layers.hitLayerIds();
    const hit = ids.length && map.queryRenderedFeatures([[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]], { layers: ids }).some((f) => E.layers.hitInfo(f.layer.id)?.kind !== 'cell');
    map.getCanvas().style.cursor = hit ? 'pointer' : '';
  }));
}

/** named-area labels that would run off the screen or under the button column are hidden until panned into view */
function edgeLabels() {
  const map = E.map; if (!map || !E.layers) return;
  const c = map.getContainer(), W = c.clientWidth, H = c.clientHeight;
  const fr = E.ui.fabs.getBoundingClientRect(), cr = c.getBoundingClientRect();
  const fab = fr.width ? { left: fr.left - cr.left - 6, bottom: fr.bottom - cr.top + 6 } : null;
  for (const L of E.layers.list) {
    if (!L.verdict || L.error) continue;
    const sid = `uw-${L.id}-labels`, src = map.getSource(sid); if (!src) continue;
    for (const f of L.labelData?.features || []) {
      const p = map.project(f.geometry.coordinates);
      const half = Math.min(100, (f.properties._len || 12) * 3.7);
      const out = p.x - half < 2 || p.x + half > W - 2 || p.y < 14 || p.y > H || (fab && p.x + half > fab.left && p.y - 18 < fab.bottom);
      try { map.setFeatureState({ source: sid, id: f.properties.id }, { edge: !!out }); } catch { /* */ }
    }
  }
}

// ---------------- floating buttons ----------------
let meMarker = null;
/** a position (from the browser or the host) → the "me" dot; the first fix of a request flies there */
function showMe(pos, info = {}) {
  if (!E.map) return;
  const ll = [pos.coords.longitude, pos.coords.latitude];
  if (!meMarker) meMarker = new maplibregl.Marker({ element: h('div.uw-me', h('span')) }).setLngLat(ll).addTo(E.map); else meMarker.setLngLat(ll);
  if (info.first === false) return;
  zeroPadding();
  // the camera now sits on the viewer's position: a presenter's view leaves the camera out until they move it
  E.camOnMe = true;
  E.map.flyTo({ center: ll, zoom: Math.max(E.map.getZoom(), 15), offset: visOffset(), essential: false }, { uwMe: true });
  follow.changed();
}
function buildFabs() {
  const ui = E.ui;
  // standalone: the browser's own permission prompt is the only dialog. In a host that locates for us (Instafy Studio:
  // caps.location "host") the host asks once for the whole app and shows who got the position (locate.js);
  // the button hides only when a host says it can't share the position at all (caps.geolocation false, host.js)
  ui.addButton({ id: 'uw-locate', title: 'Show my location', html: ui.icon('locate'), onClick: () => {
    if (locator.locate({ watch: false, highAccuracy: true })) ui.toast('Finding you…', 1500);
  } });
  E.btn3d = ui.addButton({ id: 'uw-3d', title: 'Toggle 3D', label: '3D', cls: 'uw-fab-text', adjust: '3D view', onClick: () => set3d(!E.is3d) });
  ui.addButton({ id: 'uw-reset', title: 'Reset view', html: ui.icon('reset'), adjust: 'Show the whole map', onClick: () => { stopWalk(); home(true); } });
  // compass: appears only when the map is turned (two-finger twist) or tilted outside 3D; tap = north up again
  const comp = ui.addButton({ id: 'uw-compass', title: 'Point north', html: ui.icon('compass'), onClick: () => {
    zeroPadding(); E.map.easeTo({ bearing: 0, pitch: E.is3d ? E.map.getPitch() : 0, duration: reducedMotion() ? 0 : 500 });
  } });
  const needle = comp.firstElementChild;
  const upd = rafThrottle(() => {
    const b = E.map.getBearing(), p = E.map.getPitch();
    const show = Math.abs(b) > 1 || (!E.is3d && p > 1);
    if (comp.hidden === show) { comp.hidden = !show; layoutNotes(); }
    if (needle) needle.style.transform = `rotate(${-b}deg)`;
  });
  comp.hidden = true;
  E.map.on('rotate', upd); E.map.on('pitch', upd); upd();
}
function set3d(on) {
  const map = E.map, terrain = !!E.config.basemap?.terrain;
  E.is3d = !!on;
  E.btn3d.textContent = on ? '2D' : '3D';
  E.btn3d.setAttribute('aria-pressed', String(!!on));
  if (terrain) {
    const bm = E.config.basemap || {};
    const ex = typeof bm.exaggeration === 'number' ? clamp(bm.exaggeration, 0.5, 3) : 1.35;
    try {
      if (on) map.setTerrain({ source: 'uw--dem', exaggeration: ex }); else map.setTerrain(null);
      // basemap.relief keeps the soft hillshade in 2D too (mountains read at country zoom)
      map.setLayoutProperty('uw--hillshade', 'visibility', on || bm.relief ? 'visible' : 'none');
    } catch (e) { E.error('terrain toggle failed: ' + e.message, e); }
  }
  if (on) map.setSky(skyFor(lookFor(E.config.basemap?.theme || 'auto', E.hour, !!E.config.time?.enabled).dark, E.look));
  zeroPadding();
  map.easeTo({ pitch: on ? 60 : 0, bearing: on ? (map.getBearing() || -18) : map.getBearing(), duration: reducedMotion() ? 0 : 900 });
  E.emit('3d', { on: E.is3d });
}

// ---------------- attribution ----------------
let attrib = null;
function placeAttribution(side) {
  if (!E.map) return;
  if (attrib) E.map.removeControl(attrib);
  const custom = [OSM, ...(E.config.attribution || [])];
  attrib = new maplibregl.AttributionControl({ compact: true, customAttribution: custom });
  E.map.addControl(attrib, side ? 'bottom-right' : 'top-left');
  collapseAttribution();
}
function collapseAttribution() {
  const el = E.ui.root.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact');
  if (el) { el.classList.remove('maplibregl-compact-show'); el.removeAttribute('open'); }
}

// ---------------- data ----------------
async function fetchText(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
/** "sha256:<hex>" of a text (the bound.json hash a v1 host pins at binding), or null where crypto.subtle is missing */
async function sha256(text) {
  try { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return 'sha256:' + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''); } catch { return null; }
}
async function fetchJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  try { return JSON.parse(text); } catch (e) { throw new Error('invalid JSON: ' + e.message); }
}
async function addLayer(def, preloaded) {
  if (!def || !def.id || !def.type) throw new Error('addLayer needs { id, type, data }');
  let data = preloaded, stage = 'load';
  try {
    if (data === undefined) data = typeof def.data === 'string' ? await fetchJSON(def.data) : def.data;
    if (data instanceof Error) throw data;
    stage = 'draw';
    const L = await E.layers.add(def, data);
    statsCache.clear(); hourEdges = null; modeCache = null;
    return L;
  } catch (e) {
    const L = E.layers.defaults(def); L.error = e.message; L.data = { type: 'FeatureCollection', features: [] }; L.visible = false;
    E.layers.list.push(L); E.layers.byId.set(L.id, L);
    E.error(stage === 'load' ? `layer "${def.id}": couldn't load ${typeof def.data === 'string' ? def.data : 'data'} (${e.message})` : `layer "${def.id}": ${e.message}`);
    E.ui.toast(`⚠️ Couldn't load “${def.title || def.id}” — the rest of the map still works`, 4500);
    return L;
  }
}

function applyVotesState() {
  const v = localVotes();
  for (const L of E.layers.list) {
    if (L.type !== 'points' || L.error) continue;
    for (const f of L.data.features) {
      const id = f.properties.id; const mine = v[id] || null;
      if (mine) E.map.setFeatureState({ source: L.sources[0], id }, { vote: mine });
    }
  }
}

// ---------------- boot ----------------
function hasWebGL() { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } }

async function boot() {
  const root = document.getElementById('app') || document.body.appendChild(h('div#app'));
  const ui = E.ui = new UI(root, E);
  ui.hostInsets = { ...hostLink.insets };
  Object.assign(E, { select, clearSelection, setTime, setVibe, setDay, setLayerVisible, walk, refInfo, toggleCompare, renderPlaces,
    walkDay: (d) => { const f = dayRouteFeature(d); walk(d.route, f?.properties.id); },
    dayWalkLabel: (d) => walkLabel(dayRouteFeature(d)?.properties.mode) });
  E.onLayout = (side) => { syncMapSize(); placeAttribution(side); layoutNotes(); };
  E.onSnap = () => { setTimeout(layoutNotes, 460); follow.changed(); };
  E.onView = () => follow.changed();
  // opening the Plan tab shows its day on the map (before, nothing happened until "next", and a 1-day plan never applied)
  E.onTab = (id) => { if (id === 'plan' && E.day == null && E.config?.plan?.days?.length && E.map) setDay(0); navChanged(); };
  Object.assign(E, { setLens, lensId: () => E.Q?.lens ?? null, renderTune, openSheet: (n) => E.ui.openSheet(n),
    layerBusy: (L) => !!E.bind && E.bind.all().some((j) => j.mode === 'layer' && j.layer === L.id),
    layerNote: (L) => {
      if (!E.Q) return null;
      if (E.reveal?.layers.has(L.id) && !L.shown) return `Showing ${E.reveal.layers.get(L.id).length} for ${E.reveal.letter} · Show all`;
      if (L.type === 'grid' && L.expert && !L.visible) return 'Expert view · estimated · tap to show';
      if (!L.visible && !L.defVisible && !E.userVis.has(L.id)) return 'Hidden to keep the map clear · tap to show';
      if (L.visible && L.budgetIds) return `${L.budgetShown} nearest of ${L.budgetTotal} on the map · all in Places`;
      return null;
    },
    tierOf, visibleOf, gridExpert: (L) => gridIsExpert(L.def) });
  let config, hostHint = false, hostBound = false;
  try {
    const r = await fetch('map.config.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    // `uw host` marks its responses; only then is __uw/health worth asking (a 404 there is noise on static hosts)
    hostHint = !!r.headers.get('x-uw-host');
    hostBound = hostHint && r.headers.get('x-uw-bound') === '1';
    const text = await r.text();
    try { config = JSON.parse(text); } catch (e) { throw new Error('invalid JSON: ' + e.message); }
  }
  catch (e) { E.error("couldn't load map.config.json: " + e.message); ui.fatal("This map couldn't load its settings", `map.config.json: ${e.message}`); return; }
  E.config = config;
  for (const k of Object.keys(config)) if (!TOP_KEYS.includes(k)) console.warn(`[map] config: unknown key "${k}" ignored`);
  if (config.version != null && config.version !== 1 && config.version !== 2) console.warn(`[map] config version ${config.version}; this engine understands versions 1 and 2`);
  const qcfg = config.question && typeof config.question === 'object' ? config.question : null;
  E.v2 = config.version === 2 || !!qcfg;
  if (/(^|[#&])bind=host(&|$)/.test(location.hash) || config.bind?.host === true) hostHint = true;
  document.title = config.title || 'Map'; bridgeTitle(document.title);
  if (Array.isArray(config.bind?.parentOrigins)) hostLink.setOrigins(config.bind.parentOrigins);
  // theme preset + custom tokens (before the site's own stylesheet, which can still override any --uw-* token)
  E.theme = applyTheme(config.theme);
  // a site's own stylesheet (config "css"), loaded after engine.css so it can override the chrome
  if (typeof config.css === 'string' && config.css && !/^(https?:)?\/\//.test(config.css)) {
    document.head.append(h('link', { rel: 'stylesheet', href: config.css }));
  }
  ui.setTitle(config.title || 'Map', config.subtitle);
  const hash = readHash();
  const hasGrid = (config.layers || []).some((l) => l.type === 'grid');
  E.vibeOn = config.vibe ? config.vibe.enabled !== false : hasGrid;
  E.hour = clamp(hash.t ?? config.time?.default ?? 14, 0, 24);
  E.vibe = clamp(hash.v ?? config.vibe?.default ?? 0.5, 0, 1);
  if (qcfg) {
    // the starting lens sets the clock and the dial unless the link says otherwise
    const lens0 = (qcfg.lenses || []).find((l) => l && l.id === (hash.l !== undefined ? hash.l : qcfg.lens));
    if (lens0 && hash.t == null && lens0.time != null && config.time?.enabled) E.hour = clamp(+lens0.time, 0, 24);
    if (lens0 && hash.v == null && lens0.vibe != null) E.vibe = clamp(+lens0.vibe, 0, 1);
    ui.buildQuestionHeader(qcfg.ask || config.title);
  } else ui.buildControls({ time: !!config.time?.enabled, vibe: E.vibeOn });
  // places the user asked for that are not on the map yet (add-point writes "missing"; it clears once one is added)
  if (Array.isArray(config.missing)) ui.setMissing(config.missing.filter((m) => m && typeof m.name === 'string' && m.name));
  // v0.2 side files, fetched only when the config asks for them (a speculative 404 is an error on static hosts)
  const metricsPromise = qcfg && qcfg.metrics !== false && (Array.isArray(qcfg.criteria) && qcfg.criteria.length || typeof qcfg.metrics === 'string') ? fetchJSON(typeof qcfg.metrics === 'string' ? qcfg.metrics : 'data/metrics.json').catch((e) => e)
    : typeof config.signal?.metrics === 'string' ? fetchJSON(config.signal.metrics).catch((e) => e) : null;
  const photosPromise = config.photos ? fetchJSON(config.photos.data || 'data/photos.json').catch((e) => e) : null;
  // `uw host` also says when the site has a bound.json, so a forgotten "bind" key never hides the buttons there
  const bindCfg = config.bind && typeof config.bind === 'object' ? config.bind : config.bind === true || (hostBound && config.bind !== false) ? {} : null;
  const boundPromise = bindCfg && bindCfg.manifest !== false ? fetchText(typeof bindCfg.manifest === 'string' ? bindCfg.manifest : 'bound.json').catch((e) => e) : null;

  if (typeof maplibregl === 'undefined') { E.error('maplibre-gl failed to load'); ui.fatal('The map library did not load', 'Check that engine/vendor/maplibre-gl.js is present.'); return; }
  if (!hasWebGL()) { E.error('WebGL not available'); ui.fatal('This device can’t draw the map', 'WebGL is turned off or not supported in this browser. Try another browser or device.'); return; }

  const v = config.view || {};
  // without terrain, pitch stops at 72: steeper, the sky meets bare tile edges (ENGINE-SPEC-v0.2 §12.1)
  const opts = { container: ui.mapEl, style: config.basemap?.style || 'style.json', attributionControl: false, maxPitch: config.basemap?.terrain || config.basemap?.relief ? 75 : 72,
    fadeDuration: 180, clickTolerance: 4, dragRotate: true, touchPitch: true, pitchWithRotate: true, refreshExpiredTiles: false,
    center: v.center || [10, 25], zoom: v.zoom ?? 1.6, pitch: v.pitch || 0, bearing: v.bearing || 0 };
  if (hash.at) Object.assign(opts, { center: [hash.at[0], hash.at[1]], zoom: hash.at[2], bearing: hash.at[3] || 0, pitch: hash.at[4] || 0 });
  else if (v.bounds && !v.center) { opts.bounds = v.bounds; opts.fitBoundsOptions = { padding: ui.padding(), maxZoom: maxZoomFor(v) }; }
  let map;
  try { map = E.map = new maplibregl.Map(opts); } catch (e) { E.error('map init failed: ' + e.message, e); ui.fatal('The map could not start', e.message); return; }
  // the container's size, always (syncMapSize): our own observer, which keeps every callback, plus the window's resizes
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => syncMapSize()).observe(ui.mapEl);
  window.addEventListener('resize', syncMapSize);
  window.visualViewport?.addEventListener('resize', syncMapSize);
  syncMapSize();
  if (!hash.at && v.center && v.bounds) fit(v.bounds, { duration: 0, maxZoom: maxZoomFor(v), pitch: v.pitch || 0, bearing: v.bearing || 0 });
  else if (!hash.at && v.center) map.jumpTo({ center: centerFor(v.center) });
  placeAttribution(ui.side);
  map.on('error', (e) => {
    const msg = e?.error?.message || String(e?.error || 'map error');
    if (e?.sourceId || e?.tile || /tile|Failed to fetch|NetworkError|AJAXError|404|403/i.test(msg)) { console.warn('[map] tile/source issue (non-fatal):', msg); (window.__uwWarnings ||= []).push(msg); return; }
    E.error('map: ' + msg, e?.error);
  });
  map.on('styleimagemissing', (e) => { try { handleMissing(map, e.id); } catch (err) { console.warn('[map] image', e.id, err.message); } });

  const dataPromises = (config.layers || []).map((d) => (typeof d?.data === 'string' ? fetchJSON(d.data).catch((e) => e) : Promise.resolve(d?.data)));
  const airPromise = config.air?.enabled !== false && config.air?.data ? fetchJSON(config.air.data).catch((e) => e) : null;

  await new Promise((res) => { if (map.loaded()) res(); else map.once('load', res); });
  syncMapSize();
  try {
    E.hour = E.hour; E.night = isNight(E.hour);
    map.setGlobalStateProperty('hour', E.hour % 24);
    map.setGlobalStateProperty('night', E.night);
    map.setGlobalStateProperty('vibe', E.vibe);
    const b = config.basemap || {};
    // globe only for world / continent maps (zoom < 5): below ~z12 MapLibre's globe can't ease gestures around the
    // finger ("Easing around a point is not supported under globe projection"); a style.json "projection" wins
    if (!map.getStyle().projection && (config.view?.zoom ?? 1.6) < 5) { try { map.setProjection({ type: 'globe' }); } catch { /* older style spec */ } }
    applyLabels(map, b.labels || 'en');
    // named areas say what a neighbourhood is like: the basemap's neighbourhood / quarter labels (often automatic
    // romanisations such as "Tsiancheng") then only compete with them. basemap.placeLabels: "all" keeps them.
    if (b.placeLabels !== 'all' && (config.layers || []).some((l) => l?.type === 'areas' && l.role === 'verdict')) {
      for (const l of map.getStyle().layers) {
        if (l.type !== 'symbol' || l['source-layer'] !== 'place' || l.id.startsWith('uw')) continue;
        const f = map.getFilter(l.id);
        const drop = ['!', ['match', ['get', 'class'], ['village', 'suburb', 'neighbourhood', 'quarter', 'hamlet', 'isolated_dwelling'], true, false]];
        try { map.setFilter(l.id, f ? ['all', f, drop] : drop); } catch (e) { console.warn('[map] place labels', l.id, e.message); }
      }
    }
    const owned = applyOverrides(map, b.overrides);
    E.look = new Look(map, owned);
    E.layers = new Layers(E);
    if (b.terrain || b.relief) {
      // hillshade goes under the water fills: the DEM also shades the sea floor, which reads as smudges on the ocean
      const water = map.getStyle().layers.find((l) => l.type === 'fill' && /^water/.test(l.id));
      ensureTerrainSources(map, water ? water.id : E.layers.firstSymbol, { visible: !!b.relief });
      if (b.relief && !b.terrain) b.terrain = true;
    }
    const defs = config.layers || [];
    const datas = await Promise.all(dataPromises);
    E.prefetch = new Map(defs.map((d, i) => [d?.id, datas[i]]));
    if (metricsPromise) {
      const m = await metricsPromise;
      if (m instanceof Error) console.warn(`[map] metrics.json: ${m.message} (labels and basis are guessed from the key names)`);
      else if (m && typeof m.metrics === 'object') E.metricsReg = m.metrics;
    }
    if (qcfg) {
      // ids exactly as Layers.normalise() will set them, so the options resolve before their layer is drawn
      for (const d of defs) { const fc = E.prefetch.get(d?.id); if (fc && Array.isArray(fc.features)) fc.features.forEach((f, i) => { if (f && f.properties && f.properties.id == null) f.properties.id = f.id != null ? String(f.id) : `${d.id}-${i + 1}`; }); }
      E.Q = E.question = new Question(qcfg, { locale: config.locale, metrics: E.metricsReg, compare: config.compare, verdict: config.verdict, plan: config.plan,
        features: (id) => E.layers?.byId.get(id)?.data.features || prefetchFeats(id),
        areasLayers: () => (E.layers?.list || []).filter((L) => L.verdict && !L.error),
        claimValue: (ref, attr) => E.claimValue(ref, attr),
        percentile: (key, x) => gridPercentile(key, x),
        layerTitle: (id) => { const d = (config.layers || []).find((l) => l?.id === id); return d?.title || null; },
        planSummary: () => planSummary(),
        routeSummary: () => routeSummary(),
        // a day's own walk/ride (not the day's length): say what it is
        dayDuration: (d) => { const f = dayRouteFeature(d); const m = f?.properties?.duration_min; if (m == null) return f?.properties?.duration || null; const [em, lab] = walkLabel(f.properties.mode); return `${em} ${Math.round(m)} min ${lab.split(' ')[0].toLowerCase()}`; } });
      E.Q.lens = E.Q.lenses.some((l) => l.id === (hash.l !== undefined ? hash.l : qcfg.lens)) ? (hash.l !== undefined ? hash.l : qcfg.lens) : null;
      if (hash.w) E.Q.setUserWeights(hash.w);
      E.Q.resolve();
      planQuestionSets();
      const lens = E.Q.lenses.find((l) => l.id === E.Q.lens);
      for (const lid of lens?.show || []) E.lensVis.set(lid, true);
      for (const lid of lens?.hide || []) E.lensVis.set(lid, false);
    }
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      if (!def || !def.id || !def.type) { E.error(`layer #${i + 1} needs "id", "type" and "data"`); continue; }
      if (E.layers.byId.has(def.id)) { E.error(`duplicate layer id "${def.id}"`); continue; }
      const L = await addLayer(def, datas[i]);
      if (L.type === 'grid' && L.expert) { L.group = def.group || 'Expert'; if (!/est\.|estimate/.test(L.title)) L.title += ' (estimate)'; }
    }
    selLayersReady();
    revealLayersReady();
    for (const id of hash.off) if (E.layers.byId.has(id)) E.userVis.set(id, false);
    for (const id of hash.on) if (E.layers.byId.has(id)) E.userVis.set(id, true);
    for (const L of E.layers.list) applyVisibility(L);
    E.layers.refreshTimes(E.hour);
    applyVotesState();
    if (E.Q) {
      E.Q.resolve();
      markGridInside();
      applyAreaLens();
      applyRank();
      applyBudgets();
    }
    if (photosPromise) {
      const pj = await photosPromise;
      if (pj instanceof Error) console.warn(`[map] photos: ${pj.message}`);
      else { E.photos = new Photos(E, pj, config.photos); if (!(config.attribution ||= []).includes(E.photos.attribution)) config.attribution.push(E.photos.attribution); }
    }
    buildNotes();
    if (airPromise) { const a = await airPromise; if (a instanceof Error) { E.error(`air: couldn't load ${config.air.data} (${a.message})`); ui.toast('⚠️ Air data failed to load', 3500); } else {
      E.air = parseAir(a);
      if (!E.air) console.warn('[map] air.json: no pm2_5 values found');
      else {
        if (E.air.attribution && !(config.attribution || []).some((x) => /open-meteo/i.test(x))) (config.attribution ||= []).push(E.air.attribution);
        // CAMS licence: the disclaimer must be shown with the data (air chip toast + sources footer)
        if (E.air.disclaimer && !(config.attribution || []).some((x) => /ECMWF/.test(x))) (config.attribution ||= []).push(E.air.disclaimer);
      }
    } }
    for (const k of ['time', 'vibe', 'air']) if (config[k]?.attribution) (config.attribution ||= []).push(config[k].attribution);
    placeAttribution(ui.side);
    buildFabs();
    buildTabs();
    setTime(E.hour, { final: false });
    setVibe(E.vibe);
    applyLook();
    if (E.Q) renderLensRow();
    updateLegend();
    // two-way binding: intents out, records in (bound.json and/or config "intents")
    let bound = null, boundHash = null;
    if (boundPromise) {
      const b = await boundPromise;
      if (b instanceof Error) console.warn(`[map] bound.json: ${b.message}`);
      else { try { bound = JSON.parse(b); } catch (e) { console.warn(`[map] bound.json: invalid JSON (${e.message})`); } boundHash = await sha256(b); }
    }
    // embedded: a host's commands (select, highlight, reload…) arrive by postMessage, so listen even without intents
    if (bound || config.intents || bindCfg || hostHint || embedded() || hostLink.hosted) {
      E.bind = new Bind(E);
      for (const a of Array.isArray(bound?.attribution) ? bound.attribution : []) if (typeof a === 'string' && !(config.attribution ||= []).includes(a)) config.attribution.push(a);
      try { await E.bind.init({ config, bound, boundHash, hostHint }); } catch (e) { E.error('binding failed: ' + e.message, e); }
      placeAttribution(ui.side);
    }
    E.booted = true;
    if (E.Q) { renderLensRow(); renderVerdict(); if (!hash.at && !hash.s) home(false); }
    // record ages ("4 min", "expired") stay true while the page is open: re-render every 30 s when there is something
    // timed on screen (identical cards are not redrawn)
    setInterval(() => {
      if (document.hidden || !E.records.byKey.size) return;
      if (E.ui.card?.kind === 'feature' || E.ui.tab === 'compare') refreshPanels({ soft: true });
    }, 30000);
    refreshPanels({ soft: true });
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { E.look.state.dark = -1; applyLook(); });
    // the host's theme (engine/host.js writes it) also sets the basemap when the clock is off
    try { new MutationObserver(() => { E.look.state.dark = -1; applyLook(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-uw-host-theme'] }); } catch { /* old browsers */ }
    bindMap();
    window.addEventListener('hashchange', () => {
      const s = readHash();
      if (s.t != null && s.t !== E.hour) setTime(s.t, { final: true });
      if (s.v != null && Math.abs(s.v - E.vibe) > 0.001) setVibe(s.v, { final: true });
      if (s.s && (!E.sel || s.s !== E.sel.layer + ':' + E.sel.id)) { const i = s.s.indexOf(':'); select(s.s.slice(0, i), s.s.slice(i + 1)); }
      if (E.Q && s.l !== undefined && s.l !== E.Q.lens) setLens(s.l || null);
      if (/(^|[#&])bind=1(&|$)/.test(location.hash) && E.bind && !E.bind.listen.forced) { E.bind.listen.forced = true; E.bind.changed(); }
    });
  } catch (e) {
    E.error('setup failed: ' + e.message, e);
    ui.toast('⚠️ Something went wrong drawing this map: ' + e.message, 6000);
  }

  if (config.custom) {
    try {
      const mod = await import(new URL(config.custom, document.baseURI).href);
      const fn = mod.default || mod.setup;
      if (typeof fn === 'function') await fn(uw);
    } catch (e) { E.error(`custom.js failed: ${e.message}`, e); ui.toast(`⚠️ ${config.custom} failed: ${e.message}`, 5000); }
  }

  // a shared link's selection / day / pin is applied after custom.js, so its card shows what custom.js added
  try {
    if (E.layers) {
      if (hash.d != null && config.plan?.days?.length) { setDay(hash.d - 1, { fly: !hash.at }); ui.showTab('plan', false); }
      if (hash.s) { const i = hash.s.indexOf(':'); if (i > 0) select(hash.s.slice(0, i), hash.s.slice(i + 1), { fly: !hash.at }); }
      else if (hash.p && hash.p.length === 2 && hash.p.every(isFinite)) dropPin(hash.p);
    }
  } catch (e) { E.error('restoring the shared link failed: ' + e.message, e); }
  restoreAfterReload();

  let done = false;
  const ready = () => { if (done) return; done = true; window.__uwReady = true; document.documentElement.dataset.uwReady = '1'; E.emit('ready', { title: config.title || '' }); navStart(); follow.start(); };
  map.once('idle', () => { collapseAttribution(); layoutNotes(); ready(); });
  map.triggerRepaint();
  setTimeout(ready, 15000);
}

// =====================================================================================================================
// v0.2: question, tiers, budgets, reveal, verdict, why-cards, link-outs, photos, records, binding (ENGINE-SPEC-v0.2)
// =====================================================================================================================
const TIERS = ['option', 'support', 'context'];
const SORTED_TEXT = 'Weights shown above. Source, seller and commission are never factors.';
const refOf = (layer, id) => `${layer}:${id}`;
function splitRef(ref) { const s = String(ref || ''); const i = s.indexOf(':'); return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [null, null]; }
function featureByRef(ref) { const [l, id] = splitRef(ref); const L = E.layers?.byId.get(l); const f = L?.byFid.get(id); return f ? { L, f } : null; }
function itemOf(L, f) { const p = f.properties; return { layer: L.id, id: p.id, ref: refOf(L.id, p.id), name: displayName(p) || L.title, lnglat: E.layers.featureCenter(L, f), props: p }; }
E.itemFor = (ref) => { const x = featureByRef(ref); return x ? itemOf(x.L, x.f) : null; };
const prefetchFeats = (id) => { const d = E.prefetch?.get(id); return d && Array.isArray(d.features) ? d.features : []; };

/** tier of a config layer (§3.1): explicit, else from the question; null = v0 rendering */
function tierOf(def) {
  // an "option" layer drawn before `uw question` has run: plain pins (letters need the question's options)
  if (def.tier === 'option' && !E.Q) return null;
  if (TIERS.includes(def.tier)) return def.tier;
  const Q = E.Q;
  if (!Q || (def.type !== 'points' && def.type !== 'heat')) return null;
  if (def.id === Q.optionLayer && Q.kind !== 'find-area' && Q.kind !== 'plan-route' && Q.kind !== 'explore') return 'option';
  return E.supportSet.has(def.id) ? 'support' : 'context';
}
function gridIsExpert(def) {
  if (def.type !== 'grid') return false;
  if (def.expert === true) return true;
  if (def.expert === false) return false;
  return (E.config.layers || []).some((l) => l && l.type === 'areas' && (l.role === 'verdict' || prefetchFeats(l.id).some((f) => f?.properties?.verdict)));
}
/** default visibility (§1.2): explicit `visible` wins; with a question only the layers that answer it start on */
function visibleOf(def) {
  if (def.visible === true || def.visible === false) return def.visible;
  const Q = E.Q;
  if (!Q) return true;
  if (def.type === 'grid') return !gridIsExpert(def) && E.criterionLayers.has(def.id);
  // an explicit tier "context" means "hidden until a card mentions it" (§3.5, §15), even for a criterion's layer
  if (def.id === Q.optionLayer || (E.criterionLayers.has(def.id) && def.tier !== 'context') || E.planRoutes.has(def.id)) return true;
  if (def.type === 'areas' && (def.linkedTo === Q.optionLayer || def.role === 'verdict' || prefetchFeats(def.id).some((f) => f?.properties?.verdict))) return true;
  const t = tierOf(def);
  return t === 'option' || t === 'support';
}
// ----- percentiles against the feel grid ("top 5% of this map's blocks" instead of a bare "95%") -----
const pctCache = new Map();
function gridPercentile(key, x) {
  if (typeof x !== 'number' || !isFinite(x)) return null;
  const field = String(key).replace(/^claim:/, '').replace(/_area$/, '');
  if (!/^(calm_day|calm_night|lively_day|lively_night|green|amenities)$/.test(field)) return null;
  let vals = pctCache.get(field);
  if (vals === undefined) {
    const want = E.config?.vibe?.grid;
    const def = (E.config?.layers || []).find((l) => l?.type === 'grid' && (!want || l.id === want)) || (E.config?.layers || []).find((l) => l?.type === 'grid');
    const feats = def ? (E.layers?.byId.get(def.id)?.data.features || prefetchFeats(def.id)) : [];
    vals = feats.filter((f) => !f.properties?.water).map((f) => f.properties?.[field]).filter((v) => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
    if (vals.length < 20) vals = null;
    pctCache.set(field, vals);
  }
  if (!vals) return null;
  let lo = 0, hi = vals.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (vals[mid] <= x + 1e-9) lo = mid + 1; else hi = mid; }
  return lo / vals.length;
}
/** plan-route heading: "14 days · 10 rides by train & high-speed rail · loop from Taipei" (the plan's days, as the day
 * list and a timeline page count them; else the stops' "nights"). No "stops": a day's row counts its places as stops. */
function planSummary() {
  const legsDef = (E.config.layers || []).find((l) => l?.type === 'legs');
  if (!legsDef) return null;
  const legs = [...(E.layers?.byId.get(legsDef.id)?.data.features || prefetchFeats(legsDef.id))].sort((a, b) => (a.properties.order ?? 0) - (b.properties.order ?? 0));
  if (!legs.length) return null;
  const ids = [];
  for (const f of legs) for (const k of ['from', 'to']) { const id = f.properties[k + '_id'] ?? f.properties[k]; if (id != null && !ids.includes(String(id))) ids.push(String(id)); }
  let nights = 0, known = 0;
  for (const id of ids) { const st = stopInfo(id); const n = parseInt(String(st?.props?.nights ?? ''), 10); if (Number.isFinite(n)) { nights += n; known++; } }
    const MODE_WORD = { hsr: 'high-speed rail', thsr: 'high-speed rail', train: 'train', rail: 'train', bus: 'bus', ferry: 'ferry', flight: 'air', plane: 'air', car: 'car', drive: 'car', bike: 'bike', walk: 'foot' };
  const modes = [...new Set(legs.map((f) => String(f.properties.mode || '').toLowerCase()).filter(Boolean).map((m) => MODE_WORD[m] || m))].slice(0, 3).join(' & ');
  // the stop's own label (English on an English map: "Taipei main station", not 台北車站), else the leg's from_name
  const st0 = stopInfo(String(legs[0].properties.from_id ?? legs[0].properties.from));
  const start = (st0?.props ? displayName(st0.props) : '') || legs[0].properties.from_name || st0?.name || '';
  const loop = ids.length > 2 && String(legs[0].properties.from_id ?? legs[0].properties.from) === String(legs[legs.length - 1].properties.to_id ?? legs[legs.length - 1].properties.to);
  const days = E.config.plan?.days?.length || 0;
  const parts = [days ? `${days} days` : known === ids.length || known >= ids.length - 1 ? `${nights} nights` : null, `${legs.length} ${legs.length === 1 ? 'ride' : 'rides'}${modes ? ' by ' + modes : ''}`, start ? `${loop ? 'loop from' : 'from'} ${start}` : null];
  return { text: parts.filter(Boolean).join(' · '), cites: ['plan.legs'] };
}
/** find-area heading from the plan's first walk: "🚶 Walk: 3 stops · 2.1 km · 31 min (routed)" */
function routeSummary() {
  const d = (E.config.plan?.days || []).find((x) => x?.route);
  if (!d) return null;
  const def = (E.config.layers || []).find((l) => l?.id === d.route);
  const f = (E.layers?.byId.get(d.route)?.data.features || prefetchFeats(d.route))[0];
  if (!def || !f) return null;
  const p = f.properties;
  const stops = (d.items || []).filter((it) => it?.ref).length;
  const km = Number(p.distance_km), min = Number(p.duration_min);
  const [em, lab] = walkLabel(p.mode);
  const parts = [stops ? `${stops} stops` : null, isFinite(km) ? `${fmtNum(km)} km` : null, isFinite(min) ? `${Math.round(min)} min` : null].filter(Boolean);
  if (!parts.length) return null;
  return { text: `${def.title || lab}: ${parts.join(' · ')}`, cites: ['route'] };
}
/** a stop of a route by id: the points feature that carries it (any layer), for nights and the card */
function stopInfo(id) {
  for (const d of E.config.layers || []) {
    if (d?.type !== 'points') continue;
    const fs = E.layers?.byId.get(d.id)?.data.features || prefetchFeats(d.id);
    const f = fs.find((x) => String(x.properties?.id) === String(id));
    if (f) return { layer: d.id, f, props: f.properties, name: f.properties.name_en || f.properties.name };
  }
  return null;
}
E.stopInfo = stopInfo;
function planQuestionSets() {
  const Q = E.Q, cfg = E.config;
  E.criterionLayers = new Set(); E.supportSet = new Set(); E.planRoutes = new Set();
  if (!Q) return;
  for (const c of Q.criteria) { const l = mentionLayer(c.key, Q.meta(c.key)); if (l) E.criterionLayers.add(l); }
  if (Q.kind === 'find-area') for (const l of cfg.layers || []) if (l?.type === 'areas') E.criterionLayers.add(l.id);
  for (const d of cfg.plan?.days || []) { if (d.route) E.planRoutes.add(d.route); if (d.focus?.layer) E.supportSet.add(d.focus.layer); for (const it of d.items || []) if (it.ref?.layer) E.supportSet.add(it.ref.layer); }
  // a route question is answered by its legs
  if (Q.kind === 'plan-route') for (const l of cfg.layers || []) if (l?.type === 'legs') E.criterionLayers.add(l.id);
  for (const lens of Q.lenses) for (const id of lens.show || []) E.supportSet.add(id);
  for (const id of E.criterionLayers) E.supportSet.add(id);
  // a points layer with ≤ 12 features that a card mentions (card.fields, compare metrics, criteria)
  const keys = new Set([...(cfg.compare?.metrics || []).map((m) => m.key), ...Q.criteria.map((c) => c.key)]);
  for (const l of cfg.layers || []) for (const k of l?.card?.fields || []) keys.add(k);
  for (const k of keys) {
    const lay = mentionLayer(k, Q.meta(k));
    const def = lay && (cfg.layers || []).find((l) => l?.id === lay);
    if (def && def.type === 'points' && prefetchFeats(lay).length <= 12) E.supportSet.add(lay);
  }
}
const baseVisible = (L) => (E.lensVis.has(L.id) ? E.lensVis.get(L.id) : L.defVisible);
function applyVisibility(L) { const on = E.userVis.has(L.id) ? E.userVis.get(L.id) : baseVisible(L); if (on !== L.visible || L.shown == null) E.layers.setVisible(L, on, E.hour); }

// ----- ranking → pins, verdict -----
function optionPoint(o) { const L = E.layers?.byId.get(o.layer); const f = L?.byFid.get(o.id); return f ? E.layers.featureCenter(L, f) : null; }
function applyRank() {
  const Q = E.Q; if (!Q || !E.layers) return;
  const before = Q.opts.map((o) => o.letter).join();
  Q.assignLetters();
  const ranked = Q.rankList();
  const L = E.layers.byId.get(Q.optionLayer);
  let dirty = false;
  // find-place: the rest of the candidates are context dots, kept (by the budget) in score order
  if (Q.kind === 'find-place') for (const r of Q.rankList(Q.candidates)) r.o.f.properties._score = r.score;
  ranked.forEach((r, i) => {
    const p = r.o.f.properties;
    if (p._rank !== i + 1) { p._rank = i + 1; dirty = true; }
    const short = shortName(p);
    if (p._short !== short) { p._short = short; dirty = true; }
  });
  if (L && L.tier === 'option' && before !== Q.opts.map((o) => o.letter).join()) {
    for (const o of Q.opts) { const p = o.f.properties; p._icon = ensureLetter(E.map, o.letter, o.color || L.color, 40, o.letter ? null : p._emoji || '•'); p._color = o.color || L.color; p._letter = o.letter || ''; }
    dirty = true;
  }
  if (dirty && L && !L.error) E.map.getSource(L.sources[0])?.setData(L.data);
  tintLinked(Q);
  renderVerdict();
}
/** Layers linkedTo the options with "color": "letter": each walk area / route (by `for`, or a route's `from`) takes its option's letter colour. */
function tintLinked(Q) {
  for (const A of E.layers.list) {
    if (A.error || A.style?.color !== 'letter' || !A.linkedTo || !A.data) continue;
    let changed = false;
    for (const f of A.data.features) {
      const p = f.properties, own = p.for ?? p.from, o = own != null ? Q.optionById(A.linkedTo, String(own)) : null;
      const c = (o?.letter && o.color) || '';
      if ((p._lc || '') !== c) { p._lc = c; changed = true; }
    }
    if (changed && A.sources[0]) E.map.getSource(A.sources[0])?.setData(A.data);
  }
}
let lastVerdict = '';
const emitVerdict = debounce((lines) => E.emit('verdict', { lines }), 500);
function renderVerdict() {
  const Q = E.Q; if (!Q || !E.ui.verdictEl) return;
  const lines = Q.verdictLines();
  const persona = Q.personaLine();
  const head = Q.verdictHead();
  E.verdict = { lines, persona, head };
  E.ui.renderVerdict(lines, persona, (l) => {
    // a day line opens that day: the Plan tab at half height, the map framing the day above it
    if (l.day != null) { E.ui.openSheet('plan'); E.ui.setSnap('half'); setDay(l.day); return; }
    const [layer, id] = splitRef(l.ref); if (layer) select(layer, id, { from: 'verdict' });
  }, head);
  const key = JSON.stringify(lines.map((l) => [l.ref, l.text]));
  if (key !== lastVerdict) { lastVerdict = key; emitVerdict(lines.map((l) => ({ ref: l.ref, letter: l.letter, text: l.text, cites: l.cites, facts: l.facts?.map((f) => ({ text: f.text, basis: f.basis, key: f.key, ...(f.partial ? { partial: f.partial } : {}) })), ...(l.caveats?.length ? { caveats: l.caveats } : {}) }))); }
}
function renderLensRow() {
  const Q = E.Q; if (!Q) return;
  const extra = (E.bind?.forPlace('sheet-header', null) || []).map((d) => { const pr = E.bind.prefill(d, {}); const c = E.bind.cooling(d.name, null, pr); return { name: d.name, emoji: d.emoji, label: c ? 'Sent' : d.label, disabled: c,
    onClick: () => runIntent(d.name, { ui: 'sheet-header' }) }; });
  // Adjust (focus, time, weights) only when the map asks for it: "question.adjust": true, or "adjust_weights": true.
  // Otherwise the persona line already says each pick and why, and nobody has a control they did not ask for.
  const adjust = Q.cfg.adjust === true || Q.cfg.adjust_weights === true;
  E.ui.renderLensRow(Q.lenses, Q.lens, adjust ? 'Adjust' : null, extra);
}
function setLens(id, o = {}) {
  const Q = E.Q; if (!Q) return;
  const lens = id ? Q.lenses.find((l) => l.id === id) : null;
  if (id && !lens) { console.warn(`[map] setLens: no lens "${id}"`); return; }
  Q.lens = lens ? lens.id : null;
  if (lens?.time != null && E.config.time?.enabled) setTime(lens.time, { final: true });
  if (lens?.vibe != null && E.vibeOn) setVibe(lens.vibe, { final: true });
  if (o.from === 'user') Q.user = {};
  E.lensVis = new Map();
  for (const lid of lens?.show || []) E.lensVis.set(lid, true);
  for (const lid of lens?.hide || []) E.lensVis.set(lid, false);
  for (const L of E.layers.list) applyVisibility(L);
  applyAreaLens();
  applyBudgets();
  applyRank();
  renderLensRow();
  refreshPanels();
  updateNotes();
  // a lens is about the options: when some are off screen (zoomed in on one street), frame them again
  if (o.from === 'user' && !E.sel && E.map && E.Q.opts.length && !optionsInView()) home(true);
  E.emit('lens', { id: Q.lens });
  writeHash();
}
/** are all options inside the map area not covered by the sheet / panel? */
function optionsInView() {
  const P = pad(), c = E.map.getContainer(), W = c.clientWidth, H = c.clientHeight;
  return E.Q.opts.every((o) => { const ll = optionPoint(o); if (!ll) return true; const p = E.map.project(ll); return p.x >= P.left - 20 && p.x <= W - P.right + 20 && p.y >= P.top - 20 && p.y <= H - P.bottom + 20; });
}
function setWeights(w, o = {}) {
  const Q = E.Q; if (!Q) return;
  Q.setUserWeights({ ...Q.user, ...w });
  applyRank();
  if (o.final !== false) { applyBudgets(); refreshPanels(); E.emit('weights', { weights: Q.weights() }); writeHash(); }
}
/** areas features shown for the active lens; with no lens all, unless > 5 (then the top lens per time window) */
function applyAreaLens() {
  for (const L of E.layers.list) {
    if (!L.verdict || L.error) continue;
    const lens = E.Q?.lens && E.Q.lenses.find((l) => l.id === E.Q.lens);
    let keep = null;
    if (lens && Array.isArray(lens.areas)) keep = lens.areas;
    else if (L.data.features.length > 5) {
      const best = new Map();
      for (const f of L.data.features) { const p = f.properties, w = `${p.time_from ?? ''}-${p.time_to ?? ''}`; const r = Number(p.rank) || 99; if (!best.has(w) || r < best.get(w).r) best.set(w, { r, lens: p.lens }); }
      keep = [...new Set([...best.values()].map((x) => x.lens))];
    }
    for (const b of L.budgetLayers) {
      if (!E.map.getLayer(b.id)) continue;
      const parts = [b.base, keep ? ['in', ['get', 'lens'], ['literal', keep]] : null].filter(Boolean);
      E.map.setFilter(b.id, parts.length ? (parts.length === 1 ? parts[0] : ['all', ...parts]) : null);
    }
    L.lensKeep = keep;
  }
}
/** pin budgets (§3.3): top-N support and context features by priority, shared across layers; selected always shown */
function applyBudgets() {
  const Q = E.Q; if (!Q || !E.layers) return;
  const B = Q.budget();
  const pts = Q.opts.map(optionPoint).filter(Boolean);
  const prio = (f) => {
    const p = f.properties;
    if (typeof p.rank === 'number' && isFinite(p.rank)) return p.rank;
    if (Q.kind === 'find-place' && p._score != null) return 1 - p._score;
    const c = f.geometry?.type === 'Point' ? f.geometry.coordinates : center(f.geometry);
    let d = Infinity; for (const o of pts) d = Math.min(d, distM(c, o));
    return isFinite(d) ? d / 1e5 + 1 : 2;
  };
  const sel = E.sel;
  // the last job's results are never hidden by the budget (until the summary chip is dismissed)
  const freshRefs = E.fresh && !E.fresh.dismissed ? new Set(E.fresh.refs) : null;
  for (const tier of ['support', 'context']) {
    const cand = [];
    for (const L of E.layers.list) {
      if (L.type !== 'points' || L.error || !L.budgetLayers.length) continue;
      const isOptRest = L.tier === 'option';
      if (!(L.tier === tier || (isOptRest && tier === 'context'))) continue;
      let feats = L.data.features.filter((f) => !(isOptRest && L.optionIds?.includes(f.properties.id)));
      if (L.hasTimes) feats = feats.filter((f) => f.properties.time_from == null || inWindow(E.hour, [f.properties.time_from, f.properties.time_to ?? 24]));
      const cap = Number(L.def.budget) > 0 ? Number(L.def.budget) : Infinity;
      const fresh = Q.kind === 'find-place' && L.id === Q.optionLayer;
      // places an agent found (a layer an intent created) never push a criterion's own layer (the MRT) off the map
      const extra = L.created ? 10 : 0;
      const ranked = feats.map((f) => ({ L, f, p: extra + (fresh ? prio(f) : f.properties._prio ?? (f.properties._prio = prio(f))) })).sort((a, b) => a.p - b.p).slice(0, cap);
      cand.push(...ranked);
    }
    cand.sort((a, b) => a.p - b.p);
    const keep = cand.slice(0, B[tier] ?? Infinity);
    const by = new Map();
    for (const x of keep) (by.get(x.L) || by.set(x.L, []).get(x.L)).push(x.f.properties.id);
    for (const L of new Set(cand.map((x) => x.L))) {
      const ids = by.get(L) || [];
      if (sel && sel.layer === L.id && !ids.includes(sel.id)) ids.push(sel.id);
      if (freshRefs) for (const f of L.data.features) if (freshRefs.has(refOf(L.id, f.properties.id)) && !ids.includes(f.properties.id)) ids.push(f.properties.id);
      const total = L.data.features.length - (L.optionIds?.length || 0);
      L.budgetShown = ids.length; L.budgetTotal = total;
      E.layers.setBudget(L, ids.length >= total ? null : ids);
    }
  }
}

// ----- reveal on selection (§3.5): context layers stay hidden until a card mentions them -----
function clearReveal() {
  if (!E.reveal) return;
  E.reveal = null;
  E.map.getSource('uw--reveal')?.setData(EMPTY);
  E.map.getSource('uw--reveal-line')?.setData(EMPTY);
}
function cardKeys(L, f) {
  const keys = new Set(E.Q ? E.Q.criteria.map((c) => c.key) : []);
  for (const k of L.def.card?.fields || []) keys.add(k);
  if (E.config.compare?.layer === L.id) for (const m of E.config.compare.metrics || []) keys.add(m.key);
  return [...keys].filter((k) => f.properties[k] != null);
}
function revealFor(L, f) {
  clearReveal();
  const Q = E.Q; if (!Q || !Q.isOption(L.id, f.properties.id)) return;
  const p = f.properties, at = E.layers.featureCenter(L, f), o = Q.optionById(L.id, p.id);
  const pts = [], lines = [], layers = new Map();
  for (const key of cardKeys(L, f)) {
    const meta = Q.meta(key), lay = mentionLayer(key, meta);
    const T = lay && E.layers.byId.get(lay);
    if (!T || T.type !== 'points' || T.error || T.id === L.id || layers.has(T.id)) continue;
    let fid = (meta.id_key && p[meta.id_key]) || p[`nearest_${lay}_id`] || p[`walk_min_${lay}_id`] || p[`walk_id_${lay}`];
    let g = fid != null ? T.byFid.get(String(fid)) : null;
    if (!g && at) { let bd = Infinity; for (const x of T.data.features) { const d = distM(at, x.geometry.coordinates); if (d < bd) { bd = d; g = x; } } }
    if (!g) continue;
    if (T.shown && (!T.budgetIds || T.budgetIds.includes(g.properties.id))) continue;
    layers.set(T.id, [g.properties.id]);
    const gp = g.properties;
    pts.push({ type: 'Feature', geometry: g.geometry, properties: { id: gp.id, _layer: T.id, _icon: ensureIcon(E.map, gp._emoji || T.emoji || gp.emoji, gp._color || T.color, 30), _label: displayName(gp) } });
  }
  for (const R of E.layers.list) {
    if (R.type !== 'route' || R.error || R.shown) continue;
    if (R.def.time && E.config.time?.enabled && !inWindow(E.hour, R.def.time)) continue;
    // a fixed colour as given; "letter" = this option's letter colour; otherwise ("walk", templates) the walk ink,
    // which turns light at night (_color_n)
    const fixed = typeof R.style.color === 'string' && parseColor(R.style.color) ? R.style.color : null;
    const day = fixed || (R.style.color === 'letter' && o?.letter && o.color) || (R.style.color === 'walk' || R.style.color === 'letter' ? THEME_COLORS.walk : R.color);
    const night = fixed || (R.style.color === 'letter' && o?.letter && o.color) || (R.style.color === 'walk' || R.style.color === 'letter' ? THEME_COLORS.walkNight : R.color);
    for (const x of R.data.features) if (String(x.properties.for ?? x.properties.from) === p.id) {
      lines.push({ type: 'Feature', geometry: x.geometry, properties: { _color: day, _color_n: night, id: x.properties.id, _layer: R.id } });
      layers.set(R.id, [...(layers.get(R.id) || []), x.properties.id]);
    }
  }
  if (!pts.length && !lines.length) return;
  E.reveal = { ref: refOf(L.id, p.id), letter: o?.letter || shortName(p), layers };
  E.map.getSource('uw--reveal')?.setData({ type: 'FeatureCollection', features: pts });
  E.map.getSource('uw--reveal-line')?.setData({ type: 'FeatureCollection', features: lines });
}
function revealLayersReady() {
  const map = E.map, Ls = E.layers;
  map.addSource('uw--reveal', { type: 'geojson', data: EMPTY });
  map.addSource('uw--reveal-line', { type: 'geojson', data: EMPTY });
  Ls.addMapLayer({ id: 'uw--reveal-line-casing', type: 'line', source: 'uw--reveal-line', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': 'rgba(255,255,255,0.95)', 'line-width': 8 } }, RANK.reveal);
  Ls.themed('uw--reveal-line-casing', 'line-color', 'rgba(255,255,255,0.95)', 'rgba(10,15,28,0.9)');
  Ls.addMapLayer({ id: 'uw--reveal-line', type: 'line', source: 'uw--reveal-line', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', '_color'], 'line-width': 4.5, 'line-dasharray': [1.2, 1.2] } }, RANK.reveal + 1);
  Ls.own.push({ id: 'uw--reveal-line', prop: 'line-color', fn: (k) => ['get', k === 'n' ? '_color_n' : '_color'] });
  Ls.addMapLayer({ id: 'uw--reveal', type: 'symbol', source: 'uw--reveal',
    layout: { 'icon-image': ['get', '_icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'text-field': ['get', '_label'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-anchor': 'top', 'text-offset': [0, 1.45], 'text-optional': true, 'text-max-width': 9 },
    paint: { 'text-color': '#1f2937', 'text-halo-color': 'rgba(255,255,255,0.96)', 'text-halo-width': 1.8 } }, RANK.revealPts);
  Ls.themed('uw--reveal', 'text-color', '#1f2937', '#e5e9f2');
  Ls.themed('uw--reveal', 'text-halo-color', 'rgba(255,255,255,0.96)', 'rgba(13,19,34,0.95)');
  Ls.hit.push({ id: 'uw--reveal', rank: RANK.revealPts, layer: { id: 'uw--reveal' }, kind: 'reveal' });
  Ls.hit.sort((a, b) => b.rank - a.rank);
  // the last search's radius (a dashed ring and its centre) until the summary chip is dismissed
  map.addSource('uw--fresh', { type: 'geojson', data: EMPTY });
  Ls.addMapLayer({ id: 'uw--fresh-ring', type: 'line', source: 'uw--fresh', filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': '#475569', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.75 } }, RANK.reveal);
  Ls.themed('uw--fresh-ring', 'line-color', '#475569', '#cbd5e1');
  Ls.addMapLayer({ id: 'uw--fresh-pt', type: 'circle', source: 'uw--fresh', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 5, 'circle-color': '#475569', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } }, RANK.reveal);
  // pulses for host "highlight" commands
  map.addSource('uw--hl', { type: 'geojson', data: EMPTY });
  Ls.addMapLayer({ id: 'uw--hl', type: 'circle', source: 'uw--hl', paint: { 'circle-radius': 26, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 3,
    'circle-stroke-color': ['get', '_color'], 'circle-stroke-opacity': 0.9, 'circle-pitch-alignment': 'map' } }, RANK.sel + 1);
}
function highlight(refs, ms = 2400) {
  const feats = [];
  for (const ref of Array.isArray(refs) ? refs.slice(0, 20) : []) { const x = featureByRef(ref); if (x) feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: E.layers.featureCenter(x.L, x.f) }, properties: { _color: x.f.properties._color || x.L.color } }); }
  const src = E.map.getSource('uw--hl'); if (!src || !feats.length) return;
  src.setData({ type: 'FeatureCollection', features: feats });
  const t0 = performance.now(), dur = clamp(Number(ms) || 2400, 400, 10000);
  cancelAnimationFrame(E.hlRaf);
  const tick = (now) => {
    const t = (now - t0) / dur;
    if (t >= 1 || reducedMotion()) { if (t >= 1) src.setData(EMPTY); else E.hlRaf = setTimeout(() => src.setData(EMPTY), dur); return; }
    const k = ((now - t0) % 900) / 900;
    E.map.setPaintProperty('uw--hl', 'circle-radius', 20 + k * 22);
    E.map.setPaintProperty('uw--hl', 'circle-stroke-opacity', 0.9 * (1 - k));
    E.hlRaf = requestAnimationFrame(tick);
  };
  E.hlRaf = requestAnimationFrame(tick);
}

// ----- records → features, prices, criteria -----
E.ingestRecords = (list, meta = {}) => { const res = E.records.ingest(list); afterRecords(res, meta); return res; };
E.ingestRecordFile = (path, json, text) => { const res = E.records.ingestFile(json, text); if (res.ok) afterRecords(res, { file: path }); return res; };
function targetDef(layer) { for (const d of E.bind?.intents.values() || []) if (d.target?.layer === layer && d.target.create) return d; return null; }
function afterRecords(res, meta) {
  if (!res.changed.length) return;
  const byLayer = new Map();
  for (const r of res.items) {
    const lay = r.layer || meta.intent?.target?.layer;
    if (!lay) { console.warn(`[map] item record ${r.iid} has no layer`); continue; }
    (byLayer.get(lay) || byLayer.set(lay, []).get(lay)).push(itemFeature(r));
  }
  for (const [lay, feats] of byLayer) addItemFeatures(lay, feats);
  for (const ref of res.refs) if (!featureByRef(ref) && !byLayer.has(splitRef(ref)[0])) console.warn(`[map] records for ${ref}: no such feature (kept; shown when it arrives)`);
  updatePrices();
  if (E.Q && res.changed.some((r) => r.type === 'claim' && E.Q.criteria.some((c) => c.key === 'claim:' + r.attr))) { E.Q.resetMeta(); applyRank(); }
  if (E.records.attribution.size) for (const a of E.records.attribution) if (!(E.config.attribution ||= []).includes(a)) { E.config.attribution.push(a); E.attribDirty = true; }
  if (E.attribDirty && E.map) { E.attribDirty = false; placeAttribution(E.ui.side); }
  if (E.booted) refreshPanels({ soft: true });
  // say what changed, once per batch (screen readers)
  const lic = res.changed.find((r) => r.type === 'claim' && r.attr === 'licence');
  if (lic) { const it = E.itemFor(lic.ref); if (it) E.ui.announce(`${it.name}: licence ${lic.status === 'ok' ? 'found' : lic.status === 'not_found' ? 'not found in the register' : 'possibly found'}`); }
  else if (res.items.length) E.ui.announce(`${res.items.length} place${res.items.length === 1 ? '' : 's'} found`);
  else E.ui.announce(`${res.changed.length} fact${res.changed.length === 1 ? '' : 's'} updated`);
}
let itemChain = Promise.resolve();
function addItemFeatures(lay, feats) {
  itemChain = itemChain.then(async () => {
    if (!E.layers) return;
    let L = E.layers.byId.get(lay);
    if (!L) {
      const d = targetDef(lay);
      if (!d) { console.warn(`[map] item records for unknown layer "${lay}" (declare target.create in the intent to add it)`); return; }
      const def = { id: lay, type: 'points', title: d.target.create.title || humanize(lay), tier: d.target.create.tier || 'support', group: d.target.create.group || 'Found',
        style: d.target.create.style || { emoji: d.emoji || '📍', color: '#64748b', size: 'm' }, label: 'name', list: true };
      L = await addLayer(def, { type: 'FeatureCollection', features: [] });
      L.created = true; L.defVisible = true;
      buildTabs();
    }
    if (L.error || L.type !== 'points') return;
    for (const f of feats) {
      const p = f.properties, old = L.byFid.get(p.id);
      const emoji = L.emoji || p.emoji, color = (typeof p.color === 'string' && p.color) || L.color;
      p._icon = ensureIcon(E.map, emoji, color, L.size); p._emoji = emoji || ''; p._color = color;
      if (old) Object.assign(old, f); else { L.data.features.push(f); }
      L.byFid.set(p.id, old || f);
    }
    if (L.all && L.all !== L.data) L.all.features = [...L.data.features];
    E.map.getSource(L.sources[0])?.setData(L.data);
    statsCache.clear(); hourEdges = null;
    if (!L.visible && !E.userVis.has(L.id)) { L.defVisible = true; applyVisibility(L); }
    applyBudgets();
    refreshPanels({ soft: true });
  }).catch((e) => E.error('adding found places failed: ' + e.message, e));
}
function updatePrices() {
  const Q = E.Q; if (!Q) return;
  const L = E.layers?.byId.get(Q.optionLayer); if (!L || L.error) return;
  let dirty = false;
  for (const o of Q.opts) {
    const best = E.records.bestOffer(o.ref);
    const txt = best ? fmtMoney(best.price.amount, best.price.currency) : null;
    const p = o.f.properties;
    if ((p._price || null) !== txt) { if (txt) p._price = txt; else delete p._price; dirty = true; }
  }
  if (dirty) E.map.getSource(L.sources[0])?.setData(L.data);
}
E.claimValue = (ref, attr) => E.records?.claim(ref, attr)?.value ?? null;

// ----- licence chip (§8.3) -----
const LIC_LABEL = { hotel: 'Registered hotel', tourist_hotel: 'Registered tourist hotel', bnb: 'Registered B&B',
  一般旅館: 'Registered hotel', 觀光旅館: 'Registered tourist hotel', 國際觀光旅館: 'Registered tourist hotel', 民宿: 'Registered B&B' };
const licLabel = (p, c) => LIC_LABEL[c?.value_class] || LIC_LABEL[p.licence?.class] || LIC_LABEL[p.licence_class] || LIC_LABEL[p.tw_class] || 'Registered hotel';
function licenceInfo(ref, p) {
  const all = E.records?.claimsBySource(ref, 'licence') || [];
  const c = all[0] || null;
  if (c) {
    const status = c.status === 'ok' ? 'registered' : c.status === 'uncertain' ? 'uncertain' : c.status === 'not_found' ? 'not_found' : null;
    if (!status) return null;
    // two registers that disagree (one says 447號, the other "not found", or two holders): both are shown, none wins
    const ok = all.filter((x) => x.status === 'ok');
    const disagree = all.length > 1 && (new Set(all.map((x) => x.status)).size > 1 || new Set(ok.map((x) => x.value)).size > 1);
    // the registers may name the holder differently (renamed in one): say so, with each register's own name
    const holders = [...new Map(ok.filter((x) => x.match?.candidate).map((x) => [x.match.candidate, x])).values()];
    const named = holders.length > 1 ? holders.map((x) => ({ name: x.match.candidate, source: x.prov.source_label || x.prov.source, as_of: x.prov.as_of })) : null;
    const conf = c.match?.confidence || c.confidence;
    return { status: disagree && status !== 'registered' && ok.length ? 'registered' : status, id: typeof (ok[0] || c).value === 'string' ? (ok[0] || c).value : null, label: licLabel(p, c),
      source: all.length > 1 ? all.map((x) => x.prov.source_label || x.prov.source).join(' + ') : c.prov.source_label || c.prov.source, as_of: c.prov.as_of || c.prov.observed_at, checked: c.prov.intent ? c.prov.observed_at : null, url: c.prov.url,
      confidence: named && conf === 'high' ? 'medium' : conf, match: c.match || null, rec: c, stale: stale(c), disagree: disagree ? all : null, names: named };
  }
  const l = p.licence;
  if (l && typeof l === 'object' && ['registered', 'uncertain', 'not_found'].includes(l.status)) {
    return { status: l.status, id: typeof l.id === 'string' ? l.id : null, label: typeof l.label === 'string' ? l.label : licLabel(p), source: l.source, as_of: l.as_of,
      url: safeUrl(l.url), confidence: l.confidence, match: p.tw_match || null, holder: p.tw_match?.candidate || null, stale: l.as_of ? Date.now() - Date.parse(l.as_of) > 45 * 86400e3 : false };
  }
  return null;
}
function licenceText(li, short = false) {
  if (li.disagree && short) return `✓ ${li.id || 'Registered'} · sources differ`;
  if (li.status === 'registered') return short ? `✓ ${li.id || 'Registered'}` : `✓ ${li.label}${li.id ? ' · ' + li.id : ''}${li.disagree ? ' · sources differ' : ''}`;
  // an unsure register match is "Not checked" (the trust word pages use), with the candidate it may be
  if (li.status === 'uncertain') return short ? `Not checked${li.id ? ' · maybe ' + li.id : ''}` : `Not checked · may be ${li.id || 'registered'}${li.confidence ? ' (match ' + li.confidence + ')' : ''}`;
  return short ? 'Not in the register' : `Not in the register${li.as_of ? ` (checked ${fmtDate(li.as_of)})` : ''}`;
}
function licenceChip(item, li, pendingNow) {
  if (pendingNow) return h('span.uw-lic.is-skel', { 'aria-busy': 'true' }, h('span.uw-skel'), pendingNow === true ? 'Checking the register…' : pendingNow);
  if (!li) return null;
  const b = h('button.uw-lic.is-' + li.status, { type: 'button' }, licenceText(li));
  b.addEventListener('click', (e) => { e.stopPropagation(); licenceSheet(item, li); });
  return b;
}
function licenceSheet(item, li) {
  const m = li.match;
  const rows = [['Status', licenceText(li)], ['Licence', li.id], ['Source', li.source], ['Data as of', fmtDate(li.as_of)], ['Checked', li.checked ? `${fmtDate(li.checked)} ${fmtClockLocal(li.checked)}` : null],
    ['Match', m ? [m.confidence ? `${m.confidence} confidence` : null, Array.isArray(m.by) && m.by.length ? 'by ' + m.by.join(', ') : null, Number.isFinite(m.dist_m) ? `${Math.round(m.dist_m)} m apart` : null, m.candidate ? `register name ${m.candidate}` : null].filter(Boolean).join(' · ') : null]];
  // each register's own answer, side by side, when they differ (a holder renamed in one, missing from the other…)
  for (const c of li.disagree || []) rows.push([c.prov.source_label || c.prov.source, `${c.status === 'ok' ? '✓ ' + (c.value ?? '') : c.status === 'not_found' ? 'not found' : 'possibly ' + (c.value ?? '')}${c.match?.candidate ? ` · registered as ${c.match.candidate}` : ''}${c.prov.as_of ? ` · ${fmtDate(c.prov.as_of)}` : ''}`]);
  if (li.disagree) rows.push(['Note', 'The registers do not agree. Both answers are shown; neither is picked.']);
  for (const n of li.names || []) rows.push(['Registered as', `${n.name} (${shortSource(n.source)}${n.as_of ? ', ' + fmtDate(n.as_of) : ''})`]);
  if (li.names) rows.push(['Note', 'The registers name the holder differently (often a rename). Same licence number; check the name on arrival.']);
  if (li.stale) rows.push(['Freshness', 'This register is updated monthly; this copy may be out of date.']);
  rows.push(['Note', li.status === 'not_found' ? 'Not found means this register has no matching entry. It is not a judgement about the place.' : null]);
  E.ui.infoSheet(`${item.name} · licence`, rows, li.url ? { url: li.url, label: 'Open the dataset ↗' } : null);
}
const fmtClockLocal = (iso) => { const t = new Date(iso); return isFinite(t) ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : ''; };

// ----- record rows (§9.7) -----
function fmtClaimValue(c) {
  const v = c.value;
  // "Registered rooms 20", not "Registered rooms 20 rooms"
  const unit = c.unit && !(c.label || '').toLowerCase().includes(String(c.unit).toLowerCase()) ? c.unit : '';
  if (typeof v === 'number') return c.unit === 'TWD' || c.unit === 'NT$' ? fmtMoney(v, 'TWD') : /^[A-Z]{3}$/.test(c.unit || '') ? fmtMoney(v, c.unit) : `${fmtNum(v)}${unit ? ' ' + unit : ''}`;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (v == null) return c.status === 'not_found' ? 'not found' : '—';
  return String(v);
}
function freshness(r) {
  const live = r.prov.class === 'live' || r.basis === 'live';
  const when = live ? fmtAge(r.prov.observed_at) : fmtDate(r.prov.as_of) || fmtDate(r.prov.observed_at);
  return [r.prov.source_label || r.prov.source, when].filter(Boolean).join(' · ');
}
/** "<source> · data as of 9 Sep 2026 · checked 15:04" with the source as a link to where it came from. A live record
 *  says its age; stored official data says its own date and, after a check, when it was checked. */
function freshNode(r, extra = '') {
  const url = safeUrl(r.prov.url), src = r.prov.source_label || r.prov.source;
  const live = r.prov.class === 'live' || r.basis === 'live';
  const asOf = fmtDate(r.prov.as_of);
  const when = live ? fmtAge(r.prov.observed_at) : asOf ? `data as of ${asOf}` : fmtDate(r.prov.observed_at);
  const checked = !live && r.prov.intent && r.prov.observed_at ? ` · checked ${fmtAge(r.prov.observed_at) === 'now' ? 'just now' : fmtDate(r.prov.observed_at, false) + ' ' + fmtClockLocal(r.prov.observed_at)}` : '';
  return h('span', url ? h('a.uw-src', { href: url, target: '_blank', rel: 'noopener noreferrer' }, src) : src, when ? ` · ${when}` : '', checked, extra);
}
function jobsFor(ref) { return E.bind ? E.bind.all().filter((j) => j.ref === ref) : []; }
function jobText(j) {
  const who = j.remote ? `${j.by || 'Someone else'}: ` : '';
  if (j.status === 'needs_confirm') return who + (NEEDS[j.needs] || NEEDS.confirm);
  if (j.waiting) return `${j.def.label} · sent to chat, waiting`;
  if (j.progress?.message) return `${who}${j.progress.message}${j.progress.step != null && j.progress.of ? ` · ${j.progress.step}/${j.progress.of}` : ''}`;
  if (j.remote) return `${who}${j.def.label}…`;
  return j.status === 'queued' ? `${j.def.label} · queued` : j.status === 'running' ? `${j.def.label}…` : `${j.def.label} · sent`;
}
/** a pending row: text, plus "Show" when the job waits on the person in their browser (v1 session.show) */
function jobRow(j) { return { text: jobText(j), action: !j.remote && j.status === 'needs_confirm' && j.needs && j.needs !== 'confirm' ? { label: 'Show', onClick: () => E.bind.show(j.id) } : null }; }
function targetedAttrs(def) { return [...new Set([...def.ui.filter((u) => u.startsWith('compare-cell:')).map((u) => u.slice(13)), ...(Array.isArray(def.produces) ? def.produces : [])])]; }
function factRows(item) {
  const facts = [];
  const jobs = jobsFor(item.ref);
  const cellPending = new Set(jobs.filter((j) => j.mode.startsWith('cell:')).map((j) => j.mode.slice(5)));
  const itemPending = jobs.filter((j) => j.mode === 'item');
  // every attribute the running job will (re)write is pending, not just the row that was tapped
  const pendAttrs = new Set([...cellPending, ...jobs.flatMap((j) => targetedAttrs(j.def))]);
  const rowFor = (a) => jobRow(jobs.find((j) => j.mode === 'cell:' + a) || jobs.find((j) => targetedAttrs(j.def).includes(a)) || itemPending[0] || jobs[0]);
  const now = Date.now();
  const seen = new Set();
  for (const c of E.records.claims(item.ref)) {
    if (c.attr === 'licence') continue;
    const k = c.attr + '|' + c.prov.source;
    if (seen.has(k)) continue; seen.add(k);
    if (pendAttrs.has(c.attr)) { if (!facts.some((f) => f.skeleton && f.attr === c.attr)) facts.push({ skeleton: rowFor(c.attr), attr: c.attr }); continue; }
    const exp = expired(c, now), st = stale(c, now);
    const ca = E.bind?.forCell(c.attr, item, c);
    facts.push({ label: c.label || humanize(c.attr), value: fmtClaimValue(c), sub: freshNode(c, exp ? ' · expired' : st ? ' · may be out of date' : ''), note: c.note || null, basis: normBasis(c.basis), confidence: c.confidence,
      expired: exp, stale: st, sandbox: c.prov.sandbox === true,
      onRefresh: ca ? () => E.bind.checkAgain(c.attr, item, c) : null, cooling: ca && E.bind.cooling(ca.def.name, item.ref) });
  }
  const offers = E.records.offers(item.ref);
  if (offers.length) {
    const best = E.records.bestOffer(item.ref, now);
    const lowest = best ? null : E.records.lowestOffer(item.ref, now);
    const sameGroup = (o) => best && offerGroup(o) === offerGroup(best);
    const sorted = [...offers].sort((a, b) => (sameGroup(b) - sameGroup(a)) || a.price.amount - b.price.amount);
    for (const o of sorted.slice(0, 6)) {
      const exp = expired(o, now);
      const v = o.variant ? [o.variant.label, o.variant.checkin && o.variant.checkout ? `${fmtDate(o.variant.checkin, false)}–${fmtDate(o.variant.checkout, false)}` : null, o.variant.guests ? `${o.variant.guests} guests` : null].filter(Boolean).join(' · ') : '';
      // "best" only among offers that compare like with like (same dates, guests, refundability, taxes known)
      const label = o === best ? 'Best price' : o === lowest ? 'Lowest seen (taxes unclear)' : sameGroup(o) ? 'Price' : 'Price (not comparable)';
      facts.push({ label, value: `${fmtMoney(o.price.amount, o.price.currency)}${o.price.kind && o.price.kind !== 'total' ? ' ' + o.price.kind : ''}`,
        sub: [o.seller?.name, fmtAge(o.prov.observed_at), v, o.refundable === true ? (o.free_until ? `free cancellation until ${fmtDate(o.free_until, false)}` : 'refundable') : o.refundable === false ? 'non-refundable' : null, o.price.taxes_included === 'yes' ? 'taxes incl.' : o.price.taxes_included === 'no' ? 'taxes extra' : 'taxes unclear'].filter(Boolean).join(' · ') + (exp ? ' · expired' : ''),
        basis: normBasis(o.basis) || 'live', expired: exp, sandbox: o.prov.sandbox === true,
        href: safeUrl(o.handoff?.url), hrefLabel: o.handoff ? `${o.handoff.label || 'Book'}${o.handoff.affiliate ? ' (partner link)' : ''} ↗` : null,
        onRefresh: (() => { const ca = E.bind?.forCell('price', item, o); return ca ? () => E.bind.checkAgain('price', item, o) : null; })() });
    }
  }
  // targeted attributes with no record yet: skeletons while running
  const have = new Set(E.records.claims(item.ref).map((c) => c.attr));
  for (const a of pendAttrs) if (!have.has(a) && a !== 'licence' && !facts.some((f) => f.skeleton && f.attr === a)) facts.push({ skeleton: rowFor(a), attr: a });
  const pending = jobs.filter((j) => !targetedAttrs(j.def).length && j.mode !== 'layer').map(jobRow);
  if (jobs.length && !pending.length && !facts.some((f) => f.skeleton) && pendAttrs.has('licence')) pending.push(rowFor('licence'));
  const licJob = pendAttrs.has('licence') ? jobs.find((j) => targetedAttrs(j.def).includes('licence') || j.mode === 'cell:licence') : null;
  return { facts, pending, licencePending: licJob ? (licJob.remote ? jobText(licJob) : true) : false };
}
function outcomeFor(item) {
  if (!E.bind) return null;
  for (const d of E.bind.intents.values()) {
    const o = E.bind.outcomeFor(`${d.name}|${item.ref}`);
    if (o) return { text: E.bind.outcomeText(o), error: o.kind === 'error', onRetry: o.retry ? () => { E.bind.retry(o.retry); } : null };
  }
  for (const [k, o] of E.bind.outcome) if (k.startsWith(item.ref + '|')) return { text: E.bind.outcomeText(o), error: o.kind === 'error', onRetry: o.retry ? () => E.bind.retry(o.retry) : null };
  return null;
}

// ----- link-outs -----
function linksFor(L, f) {
  const cfg = E.config.links && typeof E.config.links === 'object' ? E.config.links : null;
  if (L.def.links === false || E.config.links === false) return [];
  const p = f.properties, at = E.layers.featureCenter(L, f);
  const isCtx = L.tier === 'context' || (L.tier === 'option' && !E.Q?.isOption(L.id, p.id));
  let show = Array.isArray(L.def.links) ? L.def.links : cfg?.show || DEFAULT_SHOW;
  const inLayers = !Array.isArray(cfg?.layers) || cfg.layers.includes(L.id);
  if (!Array.isArray(L.def.links) && (isCtx || !inLayers)) show = ['google'];
  let directions = null;
  if (show.includes('directions')) {
    const d = cfg?.directions || {};
    let from = null;
    if (d.from?.layer) { const x = E.layers.byId.get(d.from.layer)?.byFid.get(String(d.from.id)); if (x) from = E.layers.featureCenter(E.layers.byId.get(d.from.layer), x); }
    directions = { label: d.label, from, mode: d.mode };
  }
  const photo = E.photos?.photo(refOf(L.id, p.id));
  return buildLinks(p, at, { show, lookaround: cfg?.lookaround, directions, photo }).map((l) => ({ ...l, onClick: () => E.emit('link', { layer: L.id, id: p.id, kind: l.kind, url: l.url }) }));
}

// ----- intents from the UI -----
function runIntent(name, o = {}) {
  return E.bind.run(name, null, o).catch((e) => { E.error('intent failed: ' + e.message, e); E.ui.toast(`⚠️ ${e.message}`, 4000); });
}
/** "Ask in chat" on a place card, only inside a host that sent a layout (Instafy Studio): the host puts a reference to
 *  this place in the viewer's composer; nothing is sent until they type. Never runs anything itself. */
function askAct(L, id, name) {
  if (!hostLink.layout || !embedded()) return null;
  return { emoji: '💬', label: 'Ask in chat', onClick: () => E.emit('ask', { layer: L.id, id, ref: refOf(L.id, id), name: String(name || '').slice(0, 120) }) };
}
function intentActs(place, item, opts = {}) {
  return (E.bind?.forPlace(place, item) || []).map((d) => {
    // the same key the host uses: an item's ref, or (map-context) where the search would run
    const params = item?.ref ? null : E.bind.prefill(d, { item, pin: opts.pin || null });
    const ref = item?.ref || null;
    const cool = E.bind.cooling(d.name, ref, params);
    const busy = E.bind.all().some((j) => j.name === d.name && (ref ? j.ref === ref : !j.ref && !j.remote));
    // "again" only for the same request (a map search at another spot is a new one)
    const ok0 = E.bind.okFor(`${d.name}|${ref || ''}`);
    const ok = ok0 && (ref || ok0.cool === coolKey(d.name, null, params)) ? ok0 : null;
    // after a job: "✓ Checked · now" while it cools down, then "Check licence again"
    const label = busy ? 'Working…' : cool && ok ? `✓ ${d.doneLabel || 'Done'} · ${fmtAge(ok.at) || 'now'}` : cool ? 'Sent' : ok ? (d.againLabel || `${d.label} again`) : d.label;
    return { emoji: busy || cool ? '' : d.emoji, label, intent: true, disabled: cool || busy, sub: d.describe, name: d.name,
      onClick: () => runIntent(d.name, { ref: item?.ref, item, ui: opts.ui || place, pin: opts.pin }) };
  });
}
E.token = (tok, ctx = {}) => {
  const [root, ...rest] = tok.replace(/^\$/, '').split('.');
  const key = rest.join('.');
  if (root === 'item') {
    const it = ctx.item; if (!it) return undefined;
    if (key === 'ref') return it.ref; if (key === 'id') return it.id; if (key === 'layer') return it.layer; if (key === 'name') return it.name;
    if (key === 'lnglat') return it.lnglat ? it.lnglat.map(round6) : undefined;
    const v = it.props?.[key]; return v == null || typeof v === 'object' ? undefined : v;
  }
  if (root === 'pin') return key === 'lnglat' && (ctx.pin || E.pin) ? (ctx.pin || E.pin).map(round6) : undefined;
  if (root === 'view') {
    // the camera sits on the viewer's own position (after "Show my location", until they pan): its center and bounds
    // are where the viewer is, which an intent would share with every viewer and keep in records; ask for a pin instead
    if (E.camOnMe && (key === 'center' || key === 'bbox')) return undefined;
    if (key === 'center') { const c = E.map.getCenter(); return [round6(c.lng), round6(c.lat)]; }
    if (key === 'zoom') return Math.round(E.map.getZoom() * 100) / 100;
    if (key === 'bbox') { const b = E.map.getBounds(); return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(round6); }
    return undefined;
  }
  if (root === 'state') { if (key === 'hour') return E.hour; if (key === 'lens') return E.Q?.lens ?? undefined; if (key === 'weights') return E.Q ? E.Q.weights() : undefined; return undefined; }
  if (root === 'options' && key === 'refs') return E.Q ? E.Q.opts.map((o) => o.ref) : undefined;
  return undefined;
};
E.stateHint = () => ({ hour: E.hour, ...(E.Q?.lens ? { lens: E.Q.lens } : {}) });
const refreshPinCard = () => { if (E.pin && (E.ui.card?.kind === 'pin' || E.ui.card?.kind === 'cell')) showPinCard(E.pin, { refresh: true }); };
E.onBindChange = () => { if (!E.booted) return; renderLensRow(); refreshPanels({ soft: true }); refreshPinCard(); };
E.onPending = () => { updatePendingPins(); renderProgress(); if (E.booted) { refreshPanels({ soft: true }); refreshPinCard(); } };
E.onVersion = () => {};
E.afterExpire = () => { updatePrices(); if (E.booted) refreshPanels({ soft: true }); };
/** browser.location (v1): the page the agent (or you) is on → pulse the pin it belongs to */
E.onLocation = (url) => {
  let u; try { u = new URL(url); } catch { return; }
  const same = (x) => { try { const v = new URL(x); return v.hostname === u.hostname && v.pathname.replace(/\/$/, '') === u.pathname.replace(/\/$/, ''); } catch { return false; } };
  const refs = new Set();
  for (const r of E.records.all()) if (r.ref && (same(r.handoff?.url || '') || same(r.prov?.url || ''))) refs.add(r.ref);
  for (const L of E.layers?.list || []) if (L.type === 'points') for (const f of L.data.features) if (same(f.properties.url || f.properties.website || '')) refs.add(refOf(L.id, f.properties.id));
  if (refs.size) highlight([...refs].slice(0, 5), 3000);
};
/** a job finished: what it found is shown (never hidden by the pin budget), framed, and summed up in one line */
E.onJobDone = (job, info = {}) => {
  const layerJob = job.mode === 'layer' || !!job.def.target?.create;
  const summary = info.summary || (job.count ? null : 'Nothing found');
  if (!layerJob) return;
  const refs = [...(job.refs || [])].filter((r) => featureByRef(r));
  const at = Array.isArray(job.params?.at) && job.params.at.length === 2 ? job.params.at : null;
  const radius = Number(job.params?.radius_m) || null;
  E.fresh = { id: job.id, name: job.name, label: job.def.label, emoji: job.def.emoji, refs, at, radius, summary: summary || `${refs.length} found`, remote: !!job.remote, by: job.by || null, dismissed: false, ts: Date.now() };
  freshRing();
  applyBudgets();
  renderProgress();
  // frame what came back (your own search only: another viewer's map is not moved under their finger)
  if (!job.remote && (refs.length || at)) {
    const pts = refs.map((r) => { const x = featureByRef(r); return E.layers.featureCenter(x.L, x.f); });
    if (at) pts.push(at);
    let b = bbox({ type: 'MultiPoint', coordinates: pts });
    if (at && radius) { const dLat = radius / 111320, dLng = radius / (111320 * Math.cos(at[1] * Math.PI / 180)); b = [Math.min(b[0], at[0] - dLng), Math.min(b[1], at[1] - dLat), Math.max(b[2], at[0] + dLng), Math.max(b[3], at[1] + dLat)]; }
    E.ui.revealMap('half');
    fit([[b[0], b[1]], [b[2], b[3]]], { maxZoom: 16.5, duration: reducedMotion() ? 0 : 900 });
  }
  if (E.booted) refreshPanels({ soft: true });
};
function freshRing() {
  const src = E.map?.getSource('uw--fresh'); if (!src) return;
  const f = E.fresh;
  if (!f || f.dismissed || !f.at || !f.radius) { src.setData(EMPTY); return; }
  const ring = [];
  for (let i = 0; i <= 64; i++) { const a = (i / 64) * Math.PI * 2; ring.push([f.at[0] + (f.radius / (111320 * Math.cos(f.at[1] * Math.PI / 180))) * Math.cos(a), f.at[1] + (f.radius / 111320) * Math.sin(a)]); }
  src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: ring }, properties: {} }, { type: 'Feature', geometry: { type: 'Point', coordinates: f.at }, properties: {} }] });
}
function dismissFresh() { if (!E.fresh) return; E.fresh.dismissed = true; freshRing(); applyBudgets(); renderProgress(); }
E.command = (name, a) => {
  if (name === 'select' && a.ref) { const [l, id] = splitRef(a.ref); select(l, id); }
  else if (name === 'flyTo') { if (a.ref) { const [l, id] = splitRef(a.ref); flyTo({ layer: l, id }); } else if (Array.isArray(a.bbox) && a.bbox.length === 4) flyTo(a.bbox); else if (Array.isArray(a.lnglat)) flyTo(a.lnglat); }
  else if (name === 'setLens') setLens(a.id ?? null);
  else if (name === 'setTime' && isFinite(a.hour)) setTime(a.hour, { final: true });
  else if (name === 'highlight') highlight(a.refs, a.ms);
  else if (name === 'reload') softReload(a);
  else if (name === 'navigate' && (a.dir === 'back' || a.dir === 'forward')) nav.go(a.dir);
};
// "reload" (the agent changed the site: `uw reload <site>`, or the host's ↻): reload in place and come back where the
// viewer was. The hash already holds camera, selection, lens, layers, time; the sheet height, tab and a note ride along.
let reloading = false;
function softReload(a = {}) {
  if (reloading) return;
  reloading = true;
  try { writeHash.flush(); } catch { /* */ }
  stashReload(window, { snap: E.ui?.snap || null, tab: E.ui?.tab || null, note: reloadNote(a) });
  setTimeout(() => location.reload(), 120);
}
function restoreAfterReload() {
  const s = takeReload(window); if (!s) return;
  try {
    if (typeof s.tab === 'string' && s.tab !== 'card' && !E.ui.card && E.ui.panels[s.tab]) E.ui.showTab(s.tab, false);
    if (!E.ui.side && ['peek', 'half', 'full'].includes(s.snap) && !E.ui.card) E.ui.setSnap(s.snap, false);
  } catch { /* the tab is gone after the change */ }
  E.ui.toast(s.note ? `↻ ${s.note}` : '↻ Map updated', 2600);
}
function renderProgress() {
  if (!E.bind) return;
  const items = E.bind.all().filter((j) => j.mode === 'layer').map((j) => {
    const t = jobText(j);
    // "Found 5 so far" already counts; otherwise say how many places have arrived
    const n = j.items && !/\d+ (so far|found)/i.test(t) ? ` · ${j.items} place${j.items === 1 ? '' : 's'} so far` : '';
    const row = jobRow(j);
    return { id: j.id, label: j.def.label, text: `${j.def.emoji || ''} ${t}${n}`.trim(), onCancel: j.remote ? null : () => E.bind.cancel(j.id), action: row.action };
  });
  // the last search's outcome stays as a one-line chip until dismissed ("12 of 43 registered hotels within 600 m …")
  const f = E.fresh;
  if (f && !f.dismissed && !items.length) items.push({ id: 'fresh', done: true, label: f.label, text: `${f.refs.length ? '✓' : 'ⓘ'} ${f.by ? f.by + ': ' : ''}${f.summary}`, onCancel: dismissFresh, cancelLabel: 'Dismiss' });
  E.ui.renderProgress(items);
}
const pendMarkers = new Map();
function updatePendingPins() {
  const want = new Map();
  for (const j of E.bind?.all() || []) if (j.ref && j.mode !== 'layer' && j.mode !== 'none') { const x = featureByRef(j.ref); if (x && x.f.geometry.type === 'Point') want.set(j.ref, x); }
  for (const [ref, m] of pendMarkers) if (!want.has(ref)) { m.remove(); pendMarkers.delete(ref); }
  for (const [ref, x] of want) {
    if (pendMarkers.has(ref)) continue;
    const big = x.L.tier === 'option';
    const el = h('div.uw-pend' + (reducedMotion() ? '.is-static' : ''), { 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
    pendMarkers.set(ref, new maplibregl.Marker({ element: el, anchor: 'center', offset: big ? [17, -17] : [13, -13] }).setLngLat(x.f.geometry.coordinates).addTo(E.map));
  }
}

// ----- the v2 feature card (§4.3) -----
/** a leg's chips: duration (only when sourced), distance by rail or straight line, the duration's source */
function legChips(p) {
  const chips = [];
  if (p.duration) chips.push({ text: `${p._emoji || '🚆'} ${p.duration}` });
  if (!p.duration && p.duration_min != null) chips.push({ text: `${p._emoji || '🚆'} ${Math.round(p.duration_min)} min` });
  // legs are arcs between stops (the distance is a straight line) unless they follow the track (uw legs --follow)
  if (p.track && p.track_km != null) chips.push({ text: `📏 ${Math.round(p.track_km)} km by rail` });
  else if (p.distance_km != null) chips.push({ text: `📏 ≈ ${Math.round(p.distance_km)} km straight line` });
  // an arc where the leg goes by train: the line is not the route (uw legs says why: track not loaded / not connected)
  if (!p.track && p.track_note) chips.push({ text: `〰 ${String(p.track_note).slice(0, 80)}` });
  if (p.duration_source) chips.push({ text: `🗓 ${p.duration_source}` });
  return chips;
}
/** links to where a card's facts came from: a leg's timetable (uw legs --source-url), a sight's or stay's source page */
function sourceActs(L, p) {
  const out = [];
  const tt = L.type === 'legs' && (p.duration_source_url || p.timetable_url) ? safeUrl(p.duration_source_url || p.timetable_url) : null;
  if (tt) out.push({ emoji: '🗓', label: 'Timetable', href: tt });
  const su = p.source_url ? safeUrl(p.source_url) : null;
  if (su && su !== tt) out.push({ emoji: '📄', label: 'Source', href: su });
  return out;
}
function showFeatureCard2(L, f, o = {}) {
  const p = f.properties, item = itemOf(L, f), Q = E.Q, card = L.def.card || {};
  const opt = Q?.optionById(L.id, p.id) || null;
  const isCtx = !opt && (L.tier === 'context' || L.tier === 'option');
  const title = displayName(p) || L.title;
  const local = p.name && p.name !== title ? p.name : '';
  let subtitle = card.subtitle ? fill(card.subtitle, p) : [p.kind ? humanize(p.kind) : '', p.area].filter(Boolean).join(' · ');
  if (local && !subtitle.includes(local)) subtitle = subtitle ? `${local} · ${subtitle}` : local;
  const isPoint = f.geometry?.type === 'Point';
  const links = isPoint ? linksFor(L, f) : [];
  const src = p.source || (/^osm-[nwr]\d+/.test(p.id) ? 'OpenStreetMap' : '');
  let foot = src ? `Source: ${src}` : '';
  if (/^osm-([nwr])(\d+)/.test(p.id)) { const [, t, n] = /^osm-([nwr])(\d+)/.exec(p.id); foot += ` · osm.org/${{ n: 'node', w: 'way', r: 'relation' }[t]}/${n}`; }
  // placed from a fallback source (uw add-point / station): the card says so until a full answer replaces it
  if (p.data_status === 'partial') foot += `${foot ? ' · ' : ''}data may be incomplete`;
  const base = { kind: 'feature', v2: true, layer: L.id, id: p.id, ref: item.ref, title, subtitle, emoji: p._emoji || L.emoji || p.emoji || '', color: p._color || L.color,
    letter: opt?.letter || null, context: isCtx, links, foot, refresh: !!o.refresh };
  const timeChip = () => {
    if (E.config.time?.enabled && p.time_from == null && p.hours_known === false) return { text: '🕒 Hours not listed' };
    if (!(E.config.time?.enabled && p.time_from != null && p.time_to != null)) return null;
    const win = `${fmtHour(p.time_from)}–${fmtHour(p.time_to)}`;
    // a register's window (e.g. permitted vendor hours) says so: it is not an opening time
    const what = typeof p.hours_label === 'string' && p.hours_label ? p.hours_label.toLowerCase() : p.kind ? humanize(p.kind).toLowerCase() : L.title;
    return { text: L.style.glow || p.hours_label ? `${L.emoji || p.emoji || '🕒'} ${win} · ${what}` : `${timeIcon(p.time_from)} ${win}`.trim() };
  };
  // hours from an official register: a fact row with its source, date and basis
  const hoursFact = p.hours_label && p.time_from != null && p.time_to != null ? { label: String(p.hours_label), value: `${fmtHour(p.time_from)}–${fmtHour(p.time_to)}`,
    sub: [p.source, fmtDate(p.as_of)].filter(Boolean).join(' · '), basis: normBasis(p.hours_basis) || 'registry', confidence: 'high' } : null;
  if (isCtx && !E.records.forRef(item.ref).length) {
    const tc = timeChip();
    E.ui.showCard({ ...base, subtitle: [subtitle, p.opening_hours ? `🕒 ${p.opening_hours}` : null].filter(Boolean).join(' · '), chips: tc ? [tc] : [], facts: hoursFact ? [hoursFact] : [] });
    return;
  }
  const { facts, pending, licencePending } = factRows(item);
  if (hoursFact) facts.unshift(hoursFact);
  const li = licenceInfo(item.ref, p);
  // why lines (options): authored first, then generated; notes about this option join as editorial lines
  let why = null;
  if (opt) {
    const authored = Array.isArray(p.why) ? p.why : Array.isArray(Q.cfg.why?.[p.id]) ? Q.cfg.why[p.id] : [];
    const notes = (E.optionNotes.get(item.ref) || []).filter((n) => !E.config.time?.enabled || inWindow(E.hour, n.time));
    why = Q.why(opt, authored, notes);
  }
  // all numbers (v0 bars), collapsed when why lines exist
  const keys = [...(card.fields || [])];
  if (E.config.compare?.layer === L.id) for (const m of E.config.compare.metrics || []) if (!keys.includes(m.key)) keys.push(m.key);
  if (opt) for (const c of Q.criteria) if (!keys.includes(c.key) && !c.key.startsWith('claim:')) keys.push(c.key);
  const bars = keys.filter((k) => typeof p[k] === 'number').map((k) => {
    const m = metricMeta(k); const b = barFor(L, k, p[k], m);
    return { label: m.label + (m.basis === 'estimated' && !/est\.|estimate/.test(m.label) ? ' (estimate)' : ''), value: E.Q ? E.Q.fmt(k, p[k]) : fmtMetric(p[k], m), len: b.len, color: 'var(--uw-muted-bar)' };
  });
  const how = (why?.cites || keys).filter((k, i, a) => a.indexOf(k) === i).slice(0, 8).map((k) => {
    const m = metricMeta(k);
    return { label: m.label, text: [m.source ? m.source + (m.scale ? ` (${m.scale})` : '') : m.scale, BASIS[m.basis]?.word || m.basis, m.as_of ? 'as of ' + fmtDate(m.as_of) : null].filter(Boolean).join(' · ') || 'from the map data' };
  });
  // actions: Pick, Nope, Walk it, then bound intents (ui: card); up to 4 visible, the rest under ⋯
  const v = voteInfo(p.id);
  // 👍 / 👎 decide between the answers; a night market or an MRT station is context, not a candidate
  const votable = !Q || !!opt || !['choose-one', 'find-place'].includes(Q.kind);
  const acts = votable ? [
    { emoji: '👍', label: v.mine === 'up' ? 'Picked' : 'Pick', pressed: v.mine === 'up', onClick: () => vote(L, p.id, 'up') },
    { emoji: '👎', label: 'Nope', pressed: v.mine === 'down', onClick: () => vote(L, p.id, 'down') },
  ] : [];
  const more = [];
  const w = findWalk(L, f);
  const cardIntents = intentActs('card', item);
  // the card's first agent action sits in the head, next to the licence chip: reachable without scrolling
  const headAct = cardIntents.shift() || null;
  if (w.route) { const [em, lab] = walkLabel(w.route.mode); acts.push({ emoji: em, label: lab, primary: true, onClick: () => walk(w.route.layer, w.route.id) }); }
  const areaAct = w.area ? { emoji: '🟣', label: `${w.area.minutes || 10}-min ${isBike(w.area.mode) ? 'ride' : 'walk'}`, onClick: () => walk(w.area.layer, w.area.id) } : null;
  if (areaAct && !w.route) acts.push(areaAct); else if (areaAct) more.push(areaAct);
  acts.push(...cardIntents);
  more.push(...intentActs('card-more', item));
  const ask = askAct(L, p.id, title); if (ask) more.unshift(ask);
  more.push({ icon: 'share', label: 'Share', onClick: () => share(title) });
  if (p.url || p.website) { const u = safeUrl(p.url || p.website); if (u) more.push({ emoji: '🔗', label: 'Website', href: u }); }
  if (!links.length) { const c = item.lnglat; if (c) more.push({ icon: 'maps', label: 'Open in Maps', href: mapsLink(p.name || title, c) }); }
  const chips = [];
  const tc = timeChip(); if (tc) chips.push(tc);
  if (L.type === 'legs') chips.push(...legChips(p));
  acts.push(...sourceActs(L, p));
  if (p.opening_hours) chips.push({ text: `🕒 ${p.opening_hours}` });
  chips.push(...voteChips(p.id));
  const photo = isPoint && E.photos && E.photos.covers(L.id) ? E.photos.card(item, links) : null;
  let found = null;
  if (p._found) found = `Found by ${E.bind?.intents.get(p._found.intent)?.label || 'the agent'} · ${p._found.source}${p._found.at ? ' · ' + fmtAge(p._found.at) : ''}`;
  const moreForHead = [...(headAct && !headAct.disabled ? [headAct] : []), ...cardIntents.filter((x) => !x.disabled), ...intentActs('card-more', item)];
  if (p._found && p.address && !subtitle.includes(p.address)) subtitle = [subtitle, String(p.address)].filter(Boolean).join(' · ');
  const bodyText = card.body ? fill(card.body, p) : (p.note || p.description || '');
  E.ui.showCard({ ...base, subtitle, licence: licenceChip(item, li, licencePending), headActs: headAct ? [headAct] : [], photo, why, body: why?.lines?.length ? '' : bodyText, about: why?.lines?.length && bodyText ? bodyText : null,
    chips, facts, pending, outcome: outcomeFor(item), actions: [...acts.slice(0, 4), ...acts.slice(4)], moreActions: more,
    bars, barsOpen: !why?.lines?.length && bars.length > 0 && bars.length <= 3, barsKey: 'nums', how, found,
    foot: [foot, typeof p.name_note === 'string' ? p.name_note : null, E.photos?.photo(item.ref) ? E.photos.attribution : null].filter(Boolean).join(' · '),
    onLongPress: moreForHead.length ? () => E.ui.actionSheet(title, moreForHead) : null });
}

// ----- named area card (§6.2) -----
function showAreaCard(L, f) {
  const p = f.properties;
  const opts = p.options && typeof p.options === 'object' ? p.options : null;
  const Q = E.Q;
  const inside = opts ? Object.entries(opts).map(([id, n]) => { const o = Q?.optionById(Q.optionLayer, id); return [o?.letter || id, n]; })
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([l, n]) => `${l} ${n}`).join(' · ') : '';
  const G = gridLayer();
  const acts = [];
  if (G) acts.push({ emoji: '🔬', label: 'Show the evidence', onClick: () => { setLayerVisible(G.id, true); flyTo(bbox(f.geometry), { maxZoom: 16.5 }); E.ui.toast('Showing the estimate grid for this area', 2600); } });
  acts.push({ icon: 'share', label: 'Share', onClick: () => share(p.name || p.verdict) });
  E.ui.showCard({ kind: 'feature', v2: true, layer: L.id, id: p.id, ref: refOf(L.id, p.id), title: [p.verdict, p.name].filter(Boolean).join(' · '),
    subtitle: [p.name_local, p.cells ? `${p.cells} blocks of 200 m` : null].filter(Boolean).join(' · '),
    emoji: /quiet|calm/.test(p.lens || '') ? '🌙' : /lively|busy/.test(p.lens || '') ? '🎉' : /green/.test(p.lens || '') ? '🌳' : '📍', color: p._color || L.color,
    why: { lines: [{ mark: 'neutral', text: p.why || p.verdict || '', value: '', basis: normBasis(p.basis) || 'estimated', confidence: p.confidence || 'low' }], tradeoff: null },
    facts: inside ? [{ label: 'Inside the 10-min walk of', value: `${inside} blocks`, sub: 'top cells for this lens inside each option’s walk area', basis: 'estimated', confidence: p.confidence || 'low' }] : [],
    factsTitle: 'Your options', actions: acts, links: [],
    foot: [L.attribution || '© OpenStreetMap contributors', p.needs_english ? 'No English name found' : null].filter(Boolean).join(' · ') });
}

// ----- Compare v2 -----
function compareModel2() {
  const Q = E.Q; if (!Q || !Q.opts.length) return null;
  const opts = [...Q.opts].sort((a, b) => (a.letter || '').localeCompare(b.letter || '') || a.i - b.i);
  const cols = opts.map((o) => { const p = o.f.properties; return { layer: o.layer, id: o.id, ref: o.ref, letter: o.letter, color: o.color, short: shortName(p), name: displayName(p), emoji: p._emoji }; });
  const rows = [], data = [], hidden = [];
  // the verdict is said once, in the peek above the tabs; Compare holds the numbers behind it
  if (E.photos && E.photos.covers(Q.optionLayer) && E.photos.hasAny(opts.map((o) => o.ref))) {
    data.push({ label: 'Photo of the entrance', sub: `street photo within ${E.photos.radius} m`, cls: 'is-photo', cells: opts.map((o) => ({ node: E.photos.cell(E.itemFor(o.ref)) })) });
  }
  const lics = opts.map((o) => licenceInfo(o.ref, o.f.properties));
  if (lics.some(Boolean) || opts.some((o) => jobsFor(o.ref).some((j) => targetedAttrs(j.def).includes('licence') || j.mode === 'cell:licence'))) {
    // each cell names its own register: one option's licence may come from the national database only
    const srcs = [...new Set(lics.filter(Boolean).map((li) => li.source).filter(Boolean))];
    data.push({ label: 'Legally registered', sub: srcs.length === 1 ? srcs[0] : 'official lists', basis: 'registry', cells: opts.map((o, i) => {
      const it = E.itemFor(o.ref), li = lics[i];
      const pend = jobsFor(o.ref).some((j) => j.mode === 'cell:licence' || targetedAttrs(j.def).includes('licence'));
      const ca = E.bind?.forCell('licence', it, li?.rec);
      const own = srcs.length > 1 && li?.source ? shortSource(li.source) : '';
      // a word in the cell ("Licensed"); the number and the register's own name live in the pin's card
      return { skel: pend, text: li ? licenceWord(li) : '—', small: [own, li?.as_of ? `seen ${shortDate(li.as_of)}` : ''].filter(Boolean).join(' · '),
        onRefresh: ca && !pend ? () => E.bind.checkAgain('licence', it, li?.rec) : null, cooling: ca && E.bind.cooling(ca.def.name, o.ref), refreshLabel: `Check ${it.name}'s licence again` };
    }) });
  }
  const offers = opts.map((o) => E.records.bestOffer(o.ref) || E.records.lowestOffer(o.ref));
  if (offers.some(Boolean)) {
    const v = offers.find(Boolean).variant;
    // across options only offers with the same comparability key are compared; the rest say "not comparable"
    const groups = new Set(offers.filter(Boolean).map(offerGroup));
    data.push({ label: 'Price', sub: v ? [v.label, v.checkin && v.checkout ? `${fmtDate(v.checkin, false)}–${fmtDate(v.checkout, false)}` : null, v.guests ? `${v.guests} guests` : null].filter(Boolean).join(' · ') : 'best comparable offer', basis: 'live',
      cells: offers.map((x) => ({ text: x ? fmtMoney(x.price.amount, x.price.currency) : '—', small: x ? [x.seller?.name, fmtAge(x.prov.observed_at), x.price.taxes_included === 'unknown' || !x.price.taxes_included ? 'taxes unclear' : null, groups.size > 1 ? 'not comparable' : null].filter(Boolean).join(' · ') : '', expired: x && expired(x) })) });
  }
  const w = Q.weights();
  const keys = [...Q.criteria].sort((a, b) => (w[b.key] || 0) - (w[a.key] || 0)).map((c) => c.key);
  for (const m of E.config.compare?.layer === Q.optionLayer ? E.config.compare.metrics || [] : []) if (!keys.includes(m.key)) keys.push(m.key);
  for (const key of keys) {
    const meta = Q.meta(key);
    const vals = opts.map((o) => Q.value(o, key));
    if (vals.every((x) => x == null)) continue;
    const L = Q.leaders(key, opts);
    const always = (E.config.compare?.metrics || []).find((m) => m.key === key)?.always === true || Q.crit(key).always === true;
    if (L.length === opts.length && opts.length > 1 && !always) { hidden.push(Q.label(key)); continue; }
    const sole = L.length === 1 && opts.length > 1;
    const wt = w[key];
    // the row's label and its trust word ("Estimate"); the weight and the method stay in the pin's card
    data.push({ label: String(Q.label(key)).replace(/\s*\(estimate\)/g, ''), basis: meta.basis, confidence: meta.confidence, key,
      // the word or number is the value: no bar under it (a goodness bar read backwards on noise, and was too faint)
      cells: opts.map((o, i) => ({ text: Q.fmt(key, vals[i]), best: sole && L[0] === o, bestWord: bestWord(key, meta) })) });
  }
  return { cols, rows: [...rows, ...data.slice(0, 5)], extra: data.slice(5), hidden, sorted: SORTED_TEXT };
}

/** the comparison's own word for its best value: "Closest" for a distance or walk, "Quietest" for noise, "Most" for
 *  a count ("quiet blocks"), "Lowest" / "Highest" otherwise */
function bestWord(key, meta) {
  const lower = (meta?.better || E.Q?.crit?.(key)?.better) === 'lower' || meta?.dir === 'lower';
  if (meta?.unit === 'dB' || meta?.format === 'db') return 'Quietest';
  if (lower) return /min|walk|dist|_m$|km|near/i.test(key) ? 'Closest' : 'Lowest';
  return meta?.count || meta?.unit === 'blocks' ? 'Most' : 'Highest';
}
/** "Taipei hotel register" → kept; "data.gov.tw 7780" → kept; long labels to their first part */
const shortSource = (s) => { const t = String(s); return / \+ /.test(t) ? `${t.split(' + ').length} official lists` : t.split(' · ')[0].replace(/\s*\(.*\)\s*$/, '').slice(0, 28); };
/** "9 Sep" (the year only when it is not this year), the pages' date */
const shortDate = (iso) => fmtDate(iso, String(iso).slice(0, 4) !== String(new Date().getFullYear()));
/** a licence in one plain word for a compare cell */
function licenceWord(li) {
  if (li.status === 'registered') return li.disagree ? 'Licensed · lists differ' : 'Licensed';
  if (li.status === 'uncertain') return 'Not checked';
  return 'Not on the list';
}

// ----- Tune ⚙ -----
function renderTune(body) {
  body.innerHTML = '';
  const Q = E.Q;
  if (E.config.time?.enabled) body.append(h('div.uw-tune-sec', h('div.uw-sub-h', 'Time of day'), E.ui.timeSlider()));
  // the weights and the calm-to-lively slider are for a map that asks for them ("question.adjust_weights": true);
  // otherwise the focus choice above already sets both
  const full = Q?.cfg?.adjust_weights === true || !Q;
  if (E.vibeOn && full) body.append(h('div.uw-tune-sec', h('div.uw-sub-h', 'Calm to lively'), E.ui.vibeSlider()));
  if (Q && Q.criteria.length && full) {
    const w = Q.weights();
    const top = [...Q.criteria].sort((a, b) => b.weight - a.weight).slice(0, 3);
    const sec = h('div.uw-tune-sec', h('div.uw-sub-h', 'What matters to you'));
    const share = h('div.uw-share', { 'aria-hidden': 'true' });
    const legend = h('div.uw-share-l');
    const paintShare = () => {
      const ww = Q.weights(); const tot = Object.values(ww).reduce((s, x) => s + x, 0) || 1;
      share.innerHTML = ''; legend.innerHTML = '';
      Q.criteria.forEach((c, i) => {
        const pct = (ww[c.key] || 0) / tot;
        const col = CAT_COLORS[i % CAT_COLORS.length];
        if (pct > 0) share.append(h('span', { style: { width: (pct * 100).toFixed(1) + '%', background: col } }));
        legend.append(h('span', h('i', { style: { background: col } }), `${Q.label(c.key)} ${Math.round(pct * 100)}%`));
      });
    };
    for (const c of top) sec.append(E.ui.weightSlider(Q.label(c.key), w[c.key] ?? c.weight, (val, final) => { setWeights({ [c.key]: val }, { final }); paintShare(); }));
    paintShare();
    sec.append(share, legend);
    if (Q.lens) sec.append(h('p.uw-note', `Starting from “${Q.lenses.find((l) => l.id === Q.lens)?.label || Q.lens}”.`));
    body.append(sec);
  }
  if (full) body.append(h('p.uw-note.uw-sorted', 'Sorted by your weights. ' + SORTED_TEXT.replace('Weights shown above. ', '')));
  // (the map's subtitle is not a setting: it stays out of Adjust)
  if (!Q && E.config.subtitle) body.append(h('p.uw-note', E.config.subtitle));
  if (E.ui.airEl && !E.ui.airEl.hidden) { E.ui.airEl.classList.remove('is-moved'); body.append(h('div.uw-tune-sec', E.ui.airEl)); }
}

// ----- on-map grid legend (§6.3) -----
function updateLegend() {
  const G = gridLayer();
  if (!G || !G.shown) { E.ui.setLegend(null); return; }
  const v = E.vibe;
  const words = v < 0.35 ? ['busy', 'mixed', 'calm'] : v > 0.65 ? ['quiet', 'mixed', 'lively'] : ['less', 'mixed', 'more your vibe'];
  const cols = G.expert ? ['#cbd5e1', '#5eead4', '#059669'] : ['#a9c6c3', '#5eead4', '#16a34a'];
  E.ui.setLegend({ classes: cols.map((c, i) => [c, words[i]]), note: `estimate at ${fmtHour(E.hour)}` });
}

/** Expert grid: cells outside every option's walk area render at 0.3× (computed once, §6.3) */
function markGridInside() {
  const Q = E.Q; if (!Q) return;
  for (const G of E.layers.list) {
    if (G.type !== 'grid' || !G.expert || G.error) continue;
    const polys = [];
    for (const A of E.layers.list) if (A.type === 'areas' && A.linkedTo === Q.optionLayer && !A.error) for (const f of A.data.features) if (Q.isOption(Q.optionLayer, f.properties.for)) polys.push(f.geometry);
    if (!polys.length) continue;
    for (const c of G.data.features) { const pt = center(c.geometry); c.properties._in = polys.some((g) => pointInGeom(pt, g)) ? 1 : 0.3; }
    E.map.getSource(G.sources[0])?.setData(G.data);
  }
}

// ---------------- public API ----------------
const uw = {
  get map() { return E.map; },
  get config() { return E.config; },
  get state() { return { hour: E.hour, vibe: E.vibe, selected: E.sel ? { layer: E.sel.layer, id: E.sel.id } : null, pin: E.pin, day: E.day, is3d: E.is3d, snap: E.ui?.snap, side: E.ui?.side, look: E.ui?.root.dataset.look || 'day', dark: Math.max(0, E.look?.state?.dark ?? 0) }; },
  /** the embedding host's frame (host.js): { name, hosted, insets, layout } (layout null until a host sent one) */
  get host() { return { name: hostLink.name, hosted: hostLink.hosted, insets: { ...hostLink.insets }, layout: hostLink.layout ? JSON.parse(JSON.stringify(hostLink.layout)) : null }; },
  /** follow mode (follow.js): the view this copy would send ({ k, s, cam, tab, card, lay, snap }), and whether the host
   *  has it presenting or following */
  view: () => viewSnapshot({ location: follow.share.location }),
  get follow() { return { presenting: follow.presenting, following: follow.following, share: { ...follow.share }, seq: follow.seq }; },
  /** soft reload: reload in place, keeping camera, selection, lens, sheet and tab */
  reload: (note) => softReload({ note }),
  on(evt, fn) { (E.listeners[evt] ||= new Set()).add(fn); return () => E.listeners[evt].delete(fn); },
  off(evt, fn) { E.listeners[evt]?.delete(fn); },
  emit: (evt, payload) => E.emit(evt, payload),
  select: (layerId, id, o) => select(layerId, id, o),
  /** the map's own history (nav.js): uw.navigate('back' | 'forward') → moved?; uw.page() → { path, title, canGoBack, canGoForward } */
  navigate: (dir) => nav.go(dir),
  page: () => nav.page(),
  clearSelection: () => clearSelection(),
  flyTo: (t, o) => flyTo(t, o),
  setTime: (h) => setTime(h, { final: true }),
  setVibe: (v) => setVibe(v, { final: true }),
  setLayerVisible: (id, on) => setLayerVisible(id, on),
  setDay: (i) => setDay(i),
  set3d: (on) => set3d(on),
  walk: (layerId, id) => walk(layerId, id),
  dropPin: (ll) => dropPin(ll),
  async addLayer(def) {
    const L = await addLayer(def);
    if (L.type === 'points') applyVotesState();
    buildTabs();
    return L.id;
  },
  getFeatures: (layerId) => (E.layers?.byId.get(layerId)?.data.features || []),
  /** Show only the features of a layer for which fn(feature) is true (null = all again). Updates map, Places, Compare and cards. */
  setFilter: (layerId, fn) => setFilter(layerId, fn),
  /** Re-render the panels (Places, Layers, Compare, Plan) and the open card after you changed feature properties. */
  refresh: () => refreshPanels(),
  getLayer: (layerId) => E.layers?.byId.get(layerId) || null,
  // ----- v0.2 -----
  /** the resolved question config (null without one) */
  get question() { return E.Q ? { ...E.Q.cfg, kind: E.Q.kind, lens: E.Q.lens, weights: E.Q.weights(), options: E.Q.opts.map((o) => ({ ref: o.ref, letter: o.letter })) } : null; },
  /** current ranking: [{ ref, letter, score, g: { key: goodness } }] */
  rank: () => (E.Q ? E.Q.rank() : []),
  setLens: (id) => setLens(id ?? null),
  setWeights: (w) => setWeights(w || {}),
  /** emit a declared intent (prefill + form + confirm as configured). Throws for undeclared names; resolves to the intent id */
  intent(name, params, o = {}) {
    if (!E.bind || !E.bind.intents.has(name)) throw new Error(`intent "${name}" is not declared`);
    return E.bind.run(name, params, o);
  },
  /** feed a host message ({ source: 'instafy-host', type: 'results' | 'progress' | … }) through the same path as postMessage */
  ingest: (msg) => { if (!E.bind) { E.bind = new Bind(E); } E.bind.handle(msg && typeof msg === 'object' ? { source: 'instafy-host', ...msg } : msg, 'api'); },
  records: (ref) => (ref ? E.records.forRef(ref) : E.records.all()).map((r) => JSON.parse(JSON.stringify(r))),
  pending: () => (E.bind ? E.bind.snapshot() : []),
  links: (layer, id) => { const L = E.layers?.byId.get(layer), f = L?.byFid.get(String(id)); return f ? linksFor(L, f).map(({ kind, label, url }) => ({ kind, label, url })) : []; },
  /** in-page clutter report (§11) */
  signal: () => signalReport(E, { pinBoxes, notes, compareModel2 }),
  /** a map layer custom.js drew itself, counted by uw.signal() like the engine's own tiers ('option'|'support'|'context') */
  registerLayer: (id, tier = 'support') => { (E.customTiers ||= new Map()).set(String(id), ['option', 'support', 'context'].includes(tier) ? tier : 'support'); },
  /** Find the viewer: one fix, or { watch: true } for a stream (moves the "me" dot; the first fix flies there).
   *  Asks the host when it locates for us, else the browser. o.onFix(pos, info) / o.onError(kind, { message }) are
   *  this page's own callbacks: the position is never sent anywhere. Returns an id for stopLocating, or null. */
  locate: (o = {}) => locator.locate({ watch: !!o.watch, highAccuracy: o.highAccuracy !== false, onFix: typeof o.onFix === 'function' ? o.onFix : null, onError: typeof o.onError === 'function' ? o.onError : null }),
  stopLocating: (id) => locator.stop(id),
  random(layerId) { const fs = uw.getFeatures(layerId); return fs.length ? fs[Math.floor(Math.random() * fs.length)].properties.id : null; },
  ui: {
    toast: (text, ms) => E.ui.toast(text, ms),
    addButton: (b) => E.ui.addButton(b),
    openSheet: (name) => E.ui.openSheet(name),
    snap: (name) => E.ui.setSnap(name),
  },
  util: { fill, fmtHour, distM, center, bbox },
};
window.uw = uw;
export default uw;

boot().catch((e) => { E.error('boot failed: ' + e.message, e); });
