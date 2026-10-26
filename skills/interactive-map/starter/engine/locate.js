// map-pack engine: "Show my location". Kit-owned file.
//
// Two paths, picked per request:
//   host     the embedding host's layout said caps.location === "host" (Instafy Studio, Instafy docs/Previews.md "Location"): the
//            page never touches navigator.geolocation (Studio's frame does not even allow it). It asks the host, which
//            asks the browser once for the whole app and shows the person which sites received their position.
//            OUT (to the parent frame, at the host's origin once known):
//              { source: "instafy-map", v: 1, type: "location-request", payload: { id, watch, highAccuracy } }
//              { source: "instafy-map", v: 1, type: "location-stop", payload: { id } }        (a watch we end)
//            IN  (host.js / bind.js deliver these only from the parent frame or the host's own MessagePort):
//              { source: "instafy-host", v: 1, type: "location", payload: { id, coords: { latitude, longitude,
//                accuracy, altitude?, heading?, speed? }, timestamp } }      (repeated for a watch)
//              { type: "location-error", payload: { id, code: "denied"|"unavailable"|"timeout"|"stopped"|"hidden" } }
//              { type: "location-stop", payload: { id } }                    (the host ended the watch)
//   browser  everything else (standalone, `uw serve`, any other host): navigator.geolocation, unchanged; the browser's own
//            prompt is the only dialog.
// The position goes to the engine's callbacks only. It is never put on the bridge (emit) or sent anywhere.

import { geoAvailability, locateMessage } from './host.js';

export const HOST_LOCATION_TYPES = ['location', 'location-error', 'location-stop'];
export const HOST_LOCATION_CODES = ['denied', 'unavailable', 'timeout', 'stopped', 'hidden'];
// a one-shot ask the host has not answered yet is reused by the next tap (the browser's prompt may still be open);
// after this long the next tap asks again, so a host that dropped the request never leaves the button dead
export const REASK_MS = 20000;
const BROWSER_OPTS = { enableHighAccuracy: true, timeout: 9000, maximumAge: 60000 };

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/** a host location message → { type, id, coords?, timestamp?, code? }, or null when it is not a well-formed one */
export function parseHostLocation(d) {
  if (!d || typeof d !== 'object' || d.source !== 'instafy-host' || !HOST_LOCATION_TYPES.includes(d.type)) return null;
  if (d.v != null && d.v !== 1) return null;
  const p = d.payload && typeof d.payload === 'object' ? d.payload : null;
  const id = p && typeof p.id === 'string' && p.id.length <= 64 ? p.id : null;
  if (!id) return null;
  if (d.type === 'location-stop') return { type: d.type, id };
  if (d.type === 'location-error') return { type: d.type, id, code: HOST_LOCATION_CODES.includes(p.code) ? p.code : 'unavailable' };
  const c = p.coords && typeof p.coords === 'object' ? p.coords : null;
  if (!c || !finite(c.latitude) || !finite(c.longitude) || Math.abs(c.latitude) > 90 || Math.abs(c.longitude) > 180) return null;
  const coords = { latitude: c.latitude, longitude: c.longitude, accuracy: finite(c.accuracy) && c.accuracy >= 0 ? c.accuracy : null };
  for (const k of ['altitude', 'heading', 'speed']) if (finite(c[k])) coords[k] = c[k];
  return { type: d.type, id, coords, timestamp: finite(p.timestamp) ? p.timestamp : Date.now() };
}

/** a GeolocationCoordinates (its fields are prototype getters: a spread copies nothing) or a host's coords → plain JSON */
export function plainCoords(c) {
  const out = { latitude: c?.latitude, longitude: c?.longitude, accuracy: finite(c?.accuracy) ? c.accuracy : null };
  for (const k of ['altitude', 'heading', 'speed']) if (finite(c?.[k])) out[k] = c[k];
  return out;
}

/** the host's caps say "ask me" */
export const hostLocates = (layout) => layout?.caps?.location === 'host';

function newId() {
  try {
    const b = new Uint8Array(6); globalThis.crypto.getRandomValues(b);
    return 'loc_' + Array.from(b, (x) => x.toString(36).padStart(2, '0')).join('').slice(0, 10);
  } catch { return 'loc_' + Math.random().toString(36).slice(2, 12); }
}

export class Locator {
  /** @param {object} o { win, link (HostLink: .layout, .origin), onFix(pos, info), onError(kind, info), onStop(info), now } */
  constructor({ win = globalThis.window, link = null, onFix = () => {}, onError = () => {}, onStop = () => {}, now = () => Date.now() } = {}) {
    this.win = win; this.link = link; this.onFix = onFix; this.onError = onError; this.onStop = onStop; this.now = now;
    this.active = new Map(); // id → { via: 'host'|'browser', watch, at, fixes, watchId?, cb }
  }
  /** 'host' only inside a frame whose host said so; a stashed layout in a page opened on its own falls back to the browser */
  get mode() { return hostLocates(this.link?.layout) && this.embedded ? 'host' : 'browser'; }
  get embedded() { try { return !!this.win.parent && this.win.parent !== this.win; } catch { return true; } }
  /** start a request; returns its id, or null when it could not start (onError has been called) */
  locate({ watch = false, highAccuracy = true, onFix = null, onError = null } = {}) {
    const cb = { onFix, onError };
    if (this.mode === 'host') {
      // one tap = one ask: a one-shot still waiting for its answer is reused, unless the host never answered
      for (const [id, r] of this.active) if (r.via === 'host' && !r.watch && !watch && this.now() - r.at < REASK_MS) return id;
      for (const [id, r] of this.active) if (r.via === 'host' && !r.watch && !watch) this.stop(id);
      const id = newId();
      this.active.set(id, { via: 'host', watch: !!watch, at: this.now(), fixes: 0, cb });
      this.post('location-request', { id, watch: !!watch, highAccuracy: !!highAccuracy });
      return id;
    }
    const can = geoAvailability(this.win);
    if (can !== 'ok') { this.fail(null, can, cb); return null; }
    const geo = this.win.navigator.geolocation;
    const id = newId();
    const r = { via: 'browser', watch: !!watch, at: this.now(), fixes: 0, cb };
    this.active.set(id, r);
    const ok = (pos) => this.fix(id, pos);
    const bad = (err) => {
      // the browser keeps a watch running after "unavailable" / "timeout" (a moved position, a weak signal): once it
      // has found the person, only a refusal ends it
      if (r.watch && r.fixes > 0 && err?.code !== 1) return;
      this.active.delete(id); if (r.watchId != null) try { geo.clearWatch(r.watchId); } catch { /* */ } this.fail(id, err?.code, cb);
    };
    const opts = { ...BROWSER_OPTS, enableHighAccuracy: !!highAccuracy };
    if (watch) r.watchId = geo.watchPosition(ok, bad, opts);
    else geo.getCurrentPosition(ok, bad, opts);
    return id;
  }
  /** end one request (a watch: tell the host, or clear the browser's watch); returns whether it was running */
  stop(id) {
    const r = this.active.get(id); if (!r) return false;
    this.active.delete(id);
    if (r.via === 'host') this.post('location-stop', { id });
    else if (r.watchId != null) try { this.win.navigator.geolocation.clearWatch(r.watchId); } catch { /* */ }
    return true;
  }
  /** the page is going away (pagehide): end everything, so a host's watch does not outlive us */
  stopAll() { for (const id of [...this.active.keys()]) this.stop(id); }
  get watching() { return [...this.active.values()].some((r) => r.watch); }
  /** a host message already checked for its frame / origin (host.js) or channel (bind.js port, uw.ingest) */
  receive(d) {
    const m = parseHostLocation(d); if (!m) return false;
    const r = this.active.get(m.id);
    if (!r || r.via !== 'host') return false; // not ours, or already ended: a stray or late answer is dropped
    if (m.type === 'location') { this.fix(m.id, { coords: m.coords, timestamp: m.timestamp }); return true; }
    this.active.delete(m.id);
    if (m.type === 'location-error') this.fail(m.id, m.code, r.cb);
    else { try { this.onStop({ id: m.id, watch: r.watch, by: 'host' }); } catch { /* */ } }
    return true;
  }
  fix(id, pos) {
    const r = this.active.get(id); if (!r) return;
    const info = { id, watch: r.watch, first: r.fixes === 0, via: r.via };
    r.fixes++;
    if (!r.watch) this.active.delete(id);
    const p = { coords: plainCoords(pos.coords), timestamp: finite(pos.timestamp) ? pos.timestamp : this.now() };
    try { this.onFix(p, info); } catch (e) { console.warn('[map] location:', e?.message); }
    try { r.cb.onFix?.(p, info); } catch (e) { console.warn('[map] location:', e?.message); }
  }
  fail(id, kind, cb = {}) {
    const info = { id, message: locateMessage(kind) };
    try { this.onError(kind, info); } catch { /* */ }
    try { cb.onError?.(kind, info); } catch { /* */ }
  }
  post(type, payload) {
    const w = this.win;
    if (!this.embedded) return false;
    const parent = w.parent;
    // the host's own origin once it has spoken (host.js keeps it); the request itself carries no position
    try { parent.postMessage({ source: 'instafy-map', v: 1, type, payload }, this.link?.origin || '*'); return true; } catch { return false; }
  }
}
