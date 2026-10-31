// map-pack engine: the embedding host's frame layout (Instafy Studio, or any host that speaks this). Kit-owned file.
//
// IN   1. `?instafy_host=<name>` on the page URL, read at load so nothing flashes (Studio mints viewer URLs with it;
//         the older `?uw_host=<name>` is still read).
//      2. the authoritative message from the parent frame, on load and whenever the host's chrome over the frame changes:
//         { source: "instafy-host", v: 1, type: "layout", insets: { top, bottom, left, right }, chrome: "host",
//           title: "shown" | "hidden", caps: { geolocation: true | false, location?: "host" }, theme: "light" | "dark" }
//         caps.location "host" = "ask me for the position" (locate.js): the frame itself may not use geolocation.
//         insets = px of the frame covered by host chrome (bars, composer, peek), measured from the frame's edges.
// OUT  { source: "instafy-map", v: 1, type: "layout-ack", payload: {...} } through bridge.emit after each layout, so the
//      host can drop its own padding. A host that never gets an ack keeps padding the frame (older or non-map pages).
//      Its supports list "ready": the map draws itself after the page loads, and says { type: "ready" } once its first
//      view is drawn (or it shows why it can't draw), so a host can say it is opening the map until then.
//
// Effects (all CSS, set on <html>, so they work before the map has booted):
//   --uw-host-t/b/l/r          the insets; engine.css folds them into --sat/--sab/--sal/--sar as a floor
//   data-uw-host="<name>"      hosted (from the query or the first layout)
//   data-uw-host-title="shown" the host's bar shows the title: the map hides its own .uw-title
//   data-uw-geo="off"          caps.geolocation === false and no caps.location "host": "Show my location" is hidden
//                              (true / absent / a host that answers location requests: it stays)
//   data-uw-chrome="host"      the host draws the title bar / close button (the map has none to drop)
// No host (no query, no message): none of this is set and the page is exactly as before.
// Follow mode (follow.js): "present", "apply-view" and "apply-tap" from the host get the same frame / origin checks and go
// to onFollow(message, origin); the ack's supports lists "view" and "tap".

export const MAX_INSET = 480;
// the host's answers to a location request (locate.js reads them; here they get the same frame / origin checks)
const LOCATION_TYPES = ['location', 'location-error', 'location-stop'];
// follow mode (follow.js): start / stop presenting, a presenter's view or tap to show
const FOLLOW_TYPES = ['present', 'apply-view', 'apply-tap'];
const STASH = 'uw:host-layout:';
// a provisional title guess before the first message: Studio shows its bar (and the title) where the frame gets the
// side-panel layout; on phones it shows none. The layout message always wins.
const SIDE_MIN_W = 900;

export function hostFromUrl(search) {
  try {
    const q = new URLSearchParams(search || '');
    const v = q.get('instafy_host') ?? q.get('uw_host');
    return v && /^[a-z][a-z0-9_-]{0,31}$/.test(v) ? v : null;
  } catch { return null; }
}

/** a layout message → { insets, chrome, title, caps, theme }, or null when it is not one */
export function parseLayout(d) {
  if (!d || typeof d !== 'object' || d.source !== 'instafy-host' || d.type !== 'layout') return null;
  if (d.v != null && d.v !== 1) return null;
  const n = (x) => { const v = Number(x); return Number.isFinite(v) ? Math.round(Math.min(MAX_INSET, Math.max(0, v))) : 0; };
  const i = d.insets && typeof d.insets === 'object' ? d.insets : {};
  const caps = d.caps && typeof d.caps === 'object' ? d.caps : {};
  return {
    insets: { top: n(i.top), bottom: n(i.bottom), left: n(i.left), right: n(i.right) },
    chrome: d.chrome === 'host' ? 'host' : null,
    title: d.title === 'shown' || d.title === 'hidden' ? d.title : null,
    caps: { geolocation: typeof caps.geolocation === 'boolean' ? caps.geolocation : null, location: caps.location === 'host' ? 'host' : null },
    theme: d.theme === 'light' || d.theme === 'dark' ? d.theme : null,
  };
}

/** write a parsed layout onto <html> (root); returns what the map now does, for the ack */
export function applyLayout(L, root, name = 'host') {
  const st = root.style, ds = root.dataset;
  st.setProperty('--uw-host-t', L.insets.top + 'px');
  st.setProperty('--uw-host-b', L.insets.bottom + 'px');
  st.setProperty('--uw-host-l', L.insets.left + 'px');
  st.setProperty('--uw-host-r', L.insets.right + 'px');
  if (!ds.uwHost) ds.uwHost = name;
  if (L.chrome) ds.uwChrome = L.chrome; else delete ds.uwChrome;
  if (L.title === 'shown') ds.uwHostTitle = 'shown'; else delete ds.uwHostTitle;
  const noGeo = L.caps.geolocation === false && L.caps.location !== 'host';
  if (noGeo) ds.uwGeo = 'off'; else delete ds.uwGeo;
  if (L.theme) ds.uwHostTheme = L.theme; else delete ds.uwHostTheme;
  return { insets: { ...L.insets }, title: L.title === 'shown' ? 'hidden' : 'shown', locate: noGeo ? 'hidden' : 'shown' };
}

export class HostLink {
  /** @param {object} o { win, emit(type, payload), onLayout(layout), onLocation(message), onFollow(message, origin) } */
  constructor({ win = globalThis.window, emit = () => {}, onLayout = () => {}, onLocation = () => {}, onFollow = () => {} } = {}) {
    this.win = win; this.emit = emit; this.onLayout = onLayout; this.onLocation = onLocation; this.onFollow = onFollow;
    this.name = null; this.layout = null; this.origin = null; this.origins = null;
    this.insets = { top: 0, bottom: 0, left: 0, right: 0 };
  }
  get root() { return this.win.document.documentElement; }
  get embedded() { try { return !!this.win.parent && this.win.parent !== this.win; } catch { return true; } }
  /** hosted = the URL said so, or a host sent a layout */
  get hosted() { return !!(this.name || this.layout); }
  start() {
    const w = this.win;
    this.name = hostFromUrl(w.location?.search);
    if (this.name) {
      this.root.dataset.uwHost = this.name;
      // a soft reload keeps the last layout, so the sheet does not jump while the host re-sends it
      const prev = this.stashed();
      if (prev) this.apply(prev, { ack: false, stash: false });
      else if ((w.innerWidth || 0) >= SIDE_MIN_W && this.name === 'studio') this.root.dataset.uwHostTitle = 'shown';
    }
    w.addEventListener('message', (e) => this.onMessage(e));
    return this;
  }
  /** only the parent frame, and only an allowed origin when the site lists some (bind.parentOrigins) */
  setOrigins(list) { this.origins = Array.isArray(list) && list.length ? list.filter((x) => typeof x === 'string') : null; }
  onMessage(e) {
    const d = e?.data;
    const L = parseLayout(d);
    const loc = !L && d && typeof d === 'object' && d.source === 'instafy-host' && LOCATION_TYPES.includes(d.type);
    const fol = !L && !loc && d && typeof d === 'object' && d.source === 'instafy-host' && FOLLOW_TYPES.includes(d.type);
    if (!L && !loc && !fol) return false;
    if (!this.embedded || e.source !== this.win.parent) return false;
    if (this.origins && !this.origins.includes(e.origin)) return false;
    if (this.origin && e.origin !== this.origin) return false; // the first host to speak keeps the frame
    // a position answers a request, so only the host that sent the layout (or one the site allows) may give one
    if (loc) { try { return this.onLocation(d) !== false; } catch (err) { console.warn('[map] host location:', err?.message); return false; } }
    // views go back only to the origin that asked for them
    if (fol) { try { return this.onFollow(d, e.origin) !== false; } catch (err) { console.warn('[map] host follow:', err?.message); return false; } }
    if (!this.origin && e.origin && e.origin !== 'null') this.origin = e.origin;
    this.apply(L);
    return true;
  }
  /** a layout from a channel the host itself handed over (its MessagePort, uw.ingest): no frame/origin check */
  accept(d) { const L = parseLayout(d); if (L) this.apply(L); return !!L; }
  apply(L, o = {}) {
    this.layout = L;
    this.insets = { ...L.insets };
    const done = applyLayout(L, this.root, this.name || 'host');
    if (o.stash !== false) this.stash(L);
    try { this.onLayout(L); } catch (err) { console.warn('[map] host layout:', err?.message); }
    if (o.ack !== false) this.emit('layout-ack', { v: 1, noun: 'map', ...done, supports: ['insets', 'title', 'caps.geolocation', 'caps.location', 'reload', 'hotkey', 'select', 'lens', 'ask', 'done', 'page', 'navigate', 'view', 'tap', 'ready'] });
    return done;
  }
  key() { return STASH + (this.win.location?.pathname || '/'); }
  stash(L) { try { this.win.sessionStorage.setItem(this.key(), JSON.stringify(L)); } catch { /* storage off */ } }
  stashed() {
    try {
      const raw = this.win.sessionStorage.getItem(this.key());
      return raw ? parseLayout({ source: 'instafy-host', v: 1, type: 'layout', ...JSON.parse(raw) }) : null;
    } catch { return null; }
  }
}

/** keys typed inside a cross-origin frame never reach the host: forward the host's own shortcuts.
 *  ⌘\ / Ctrl+\ (hide or show chat) and F6 (move between chat and site). Returns the payload, or null. */
export function hotkeyOf(e) {
  if (!e || e.repeat) return null;
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === '\\' || e.code === 'Backslash')) return { key: 'Mod+\\', shift: !!e.shiftKey };
  if (e.key === 'F6' && !e.metaKey && !e.ctrlKey && !e.altKey) return { key: 'F6', shift: !!e.shiftKey };
  return null;
}

/** "Show my location" failure → a friendly line (never a raw error). kind: the browser's error code (1 / 2 / 3), a
 *  geoAvailability() answer, or a host's location-error code (locate.js) */
export function locateMessage(kind) {
  switch (kind) {
    case 'denied': return 'Location is blocked for Instafy. Studio shows how to turn it on, then tap the button again.';
    case 'timeout': return 'Finding you took too long. Try again (outdoors or with Wi-Fi on helps).';
    case 'stopped': return 'Location is off for this site · turn it on in Studio’s menu for this preview';
    case 'hidden': return 'Location pauses while this map is hidden. Tap the button again to find you.';
    case 'insecure': return 'Your location needs a secure (https) link. Open the map from its preview card or an https link.';
    case 'frame': return 'Location is turned off inside this frame. Open the map in its own tab to use it.';
    case 'unsupported': return 'This browser can’t share your location.';
    case 1: return 'Location is blocked for this map. Allow location for this site in your browser’s settings, then tap the button again.';
    case 3: return 'Finding you took too long. Try again (outdoors or with Wi-Fi on helps).';
    default: return 'Couldn’t find your location right now. Check that location services are on, then try again.';
  }
}

/** can this document ask for the position at all? 'ok' | 'insecure' | 'frame' | 'unsupported' */
export function geoAvailability(win = globalThis.window) {
  if (!win.navigator?.geolocation) return 'unsupported';
  if (win.isSecureContext === false) return 'insecure';
  try {
    const p = win.document.permissionsPolicy || win.document.featurePolicy;
    if (p && typeof p.allowsFeature === 'function' && !p.allowsFeature('geolocation')) return 'frame';
  } catch { /* */ }
  return 'ok';
}

const RELOAD = 'uw:reload:';
/** soft reload: remember what the hash does not hold (sheet height, tab, a note for the toast), then reload in place */
export function stashReload(win, state) {
  try { win.sessionStorage.setItem(RELOAD + (win.location?.pathname || '/'), JSON.stringify({ ...state, at: Date.now() })); } catch { /* */ }
}
/** read (once) what a soft reload left, if it is recent */
export function takeReload(win, maxAgeMs = 30000) {
  try {
    const k = RELOAD + (win.location?.pathname || '/');
    const raw = win.sessionStorage.getItem(k);
    if (!raw) return null;
    win.sessionStorage.removeItem(k);
    const s = JSON.parse(raw);
    return s && typeof s === 'object' && Date.now() - Number(s.at) < maxAgeMs ? s : null;
  } catch { return null; }
}
/** the reload note a host may send ({ name: "reload", args: { note } }): short plain text, or null */
export function reloadNote(a) {
  const s = a && typeof a.note === 'string' ? a.note.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim() : '';
  return s ? s.slice(0, 80) : null;
}
