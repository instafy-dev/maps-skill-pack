// map-pack bridge: tells an embedding host (e.g. Instafy) what the viewer did on the map.
// Kit-owned file: sites should not edit it.
//
// emit(type, payload)            UI events (select, pick, nope, pin, lens, link, intent…), message v: 1:
//   - if the page is embedded (window.parent !== window) -> parent.postMessage({ source: 'instafy-map', v: 1, type, payload, title }, '*')
//   - always dispatches a window CustomEvent 'uw:event' with the same message as detail.
// postIntent(msg, targetOrigin)  the v: 2 intent message (ENGINE-SPEC-v0.2 §9.3) to the parent frame and as window events
//   'uw:intent' (detail = msg) and 'uw:event' ({ type: 'intent', payload: msg }).
// Payloads carry plain JSON only (layer, id, name, and [lng,lat] for pins). Safe no-op outside a frame.
// For a host's chrome (Instafy Studio) the useful v1 events are: select {layer,
// id, ref, name}, clear, lens {id}, ask {layer, id, ref, name} ("Ask in chat" on a card), done {id, name, ref,
// summary, count, error?} (a job ended; error {code, message} when it failed),
// hotkey {key: "Mod+\\" | "F6", shift} (keys typed in the frame never reach the host), layout-ack {insets, title,
// locate, supports} (host.js) and page {path, title, canGoBack, canGoForward} (nav.js: the map's own history; the host
// answers ‹ › with the command navigate {dir: "back" | "forward"}). Follow mode (follow.js) adds view {seq, payload}, tap and
// interact through post(), only to the host that asked for them. They are context for the host, never commands; the viewer's position is never sent.

let title = '';
let port = null; // a MessagePort handed in by the host (Instafy Studio pane), when there is one
let portEvents = true; // UI events on the port too (a v2 host); a v1 "instafy-bind" port carries bind messages only
export function setTitle(t) { title = String(t || ''); }
export function setPort(p, o = {}) { port = p || null; portEvents = o.events !== false; }
export const embedded = () => { try { return window.parent && window.parent !== window; } catch { return true; } };

function plain(payload) {
  try { return payload == null ? null : JSON.parse(JSON.stringify(payload)); } catch { return null; }
}

export function emit(type, payload) {
  const msg = { source: 'instafy-map', v: 1, type: String(type), payload: plain(payload), title: title || document.title };
  try {
    if (embedded()) window.parent.postMessage(msg, '*');
  } catch { /* cross-origin or detached: ignore */ }
  try { if (portEvents) port?.postMessage(msg); } catch { /* closed port */ }
  try {
    window.dispatchEvent(new CustomEvent('uw:event', { detail: msg }));
  } catch { /* very old browsers */ }
  return msg;
}

/** A follow-mode message (follow.js: view, tap, interact), already shaped { source: 'instafy-map', v: 1, type, … }: to the
 *  parent frame at targetOrigin (the host that asked us to present) and the host's port. No window event (10 a second). */
export function post(msg, targetOrigin = '*') {
  const m = plain(msg);
  try { if (embedded()) window.parent.postMessage(m, targetOrigin || '*'); } catch { /* detached */ }
  try { if (portEvents) port?.postMessage(m); } catch { /* closed port */ }
  return m;
}

/** Send a v2 intent message to every page-side transport. Returns which ones were attempted.
 *  o.parent / o.port false: skip that transport (a v1 host got its own "instafy-bind" message there). */
export function postIntent(msg, targetOrigin = '*', extraParentMsgs = [], o = {}) {
  const sent = [];
  const m = plain(msg);
  try {
    if (embedded() && o.parent !== false) {
      window.parent.postMessage(m, targetOrigin || '*'); sent.push('parent');
      for (const x of extraParentMsgs) window.parent.postMessage(plain(x), targetOrigin || '*');
    }
  } catch { /* detached */ }
  try { if (port && o.port !== false) { port.postMessage(m); sent.push('port'); } } catch { /* closed */ }
  try {
    window.dispatchEvent(new CustomEvent('uw:intent', { detail: m }));
    window.dispatchEvent(new CustomEvent('uw:event', { detail: { type: 'intent', payload: m } }));
    sent.push('window');
  } catch { /* */ }
  return sent;
}

export default { emit, setTitle, postIntent, setPort, embedded, post };
