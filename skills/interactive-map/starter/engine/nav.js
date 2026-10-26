// map-pack engine: the map's own history, so a host can show where the viewer is and offer ‹ › (Instafy Studio's
// address bar; PAGE/NAV contract). Kit-owned file.
//
// An entry is what the viewer looked at: the selected place (and whether its card is open), the sheet's tab, the plan
// day. Camera moves, time and lens are not entries (the hash keeps them).
// OUT  { source: "instafy-map", v: 1, type: "page", payload: { path, title, canGoBack, canGoForward } } through
//      bridge.emit, once at ready and whenever it changes. path ≤ 200 chars, readable ("/Hotels/Lore Hotel"),
//      title ≤ 120.
// IN   { source: "instafy-host", v: 1, type: "command", command: { name: "navigate", args: { dir: "back" | "forward" } } }
//      (bind.js → E.command → go()).
// Never the browser's history: pushState inside a frame joins the host page's own Back button.

export const MAX_ENTRIES = 50;
export const MAX_PATH = 200;
export const MAX_TITLE = 120;

const clip = (s, n) => { const a = [...String(s ?? '')]; return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };
/** one readable path segment: no slashes or control characters, single spaces */
export const segment = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f/\\?#]+/g, ' ').replace(/\s+/g, ' ').trim();

/** segments → "/A/B" (≤ MAX_PATH chars) */
export function pathOf(segments) {
  const parts = (segments || []).map(segment).filter(Boolean);
  return clip('/' + parts.join('/'), MAX_PATH);
}

/** a state is { sel: {layer, id} | null, card: boolean, tab: string | null, day: number | null } */
export function sameState(a, b) {
  if (!a || !b) return a === b;
  const sa = a.sel ? a.sel.layer + ':' + a.sel.id : '', sb = b.sel ? b.sel.layer + ':' + b.sel.id : '';
  return sa === sb && !!a.card === !!b.card && (a.tab ?? null) === (b.tab ?? null) && (a.day ?? null) === (b.day ?? null);
}

export class NavHistory {
  /** @param {object} o { describe(state) → { segments, title }, apply(state), emit(type, payload), siteTitle(),
   *  read() → the state now (optional: right after apply, the entry becomes what the move produced) } */
  constructor({ describe = () => ({ segments: [], title: '' }), apply = () => {}, emit = () => {}, siteTitle = () => '', read = null } = {}) {
    Object.assign(this, { describe, apply, emit, siteTitle, read });
    this.entries = []; this.index = -1; this.last = null; this.going = false;
  }
  get current() { return this.entries[this.index] || null; }
  /** the first entry (at ready): history starts here */
  reset(state) { this.entries = [{ state: { ...state } }]; this.index = 0; this.going = false; return this.publish(); }
  /** the viewer moved somewhere: a new entry (forward entries are dropped), unless it is where we already are.
   *  Without read(), the first note after go() is what the move produced: it replaces the entry instead. */
  note(state) {
    if (this.index < 0) return this.reset(state);
    if (this.going) { this.going = false; this.entries[this.index] = { state: { ...state } }; return this.publish(); }
    if (sameState(this.current.state, state)) return this.publish();
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({ state: { ...state } });
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.index = this.entries.length - 1;
    return this.publish();
  }
  canGo(dir) { return dir === 'back' ? this.index > 0 : dir === 'forward' ? this.index >= 0 && this.index < this.entries.length - 1 : false; }
  /** back / forward: show that entry; false when there is nowhere to go */
  go(dir) {
    if (!this.canGo(dir)) { this.publish(true); return false; }
    this.index += dir === 'back' ? -1 : 1;
    this.going = true;
    try { this.apply({ ...this.current.state }); } catch (e) { console.warn('[map] navigate:', e?.message); }
    if (this.read) {
      // read at once, so a move the viewer makes right after is a new entry, never a correction of this one
      this.going = false;
      try { const now = this.read(); if (now) this.entries[this.index] = { state: { ...now } }; } catch { /* keep the entry */ }
    }
    this.publish();
    return true;
  }
  page() {
    const st = this.current?.state;
    const d = st ? this.describe(st) || {} : {};
    return {
      path: pathOf(d.segments),
      title: clip(segment(d.title) || segment(this.siteTitle()) || 'Map', MAX_TITLE),
      canGoBack: this.canGo('back'),
      canGoForward: this.canGo('forward'),
    };
  }
  /** emit "page" when it changed (force: always, e.g. a host asked to go where it cannot) */
  publish(force = false) {
    const p = this.page();
    const key = JSON.stringify(p);
    if (force || key !== this.last) { this.last = key; this.emit('page', p); }
    return p;
  }
}
