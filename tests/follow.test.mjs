// Follow mode, site side (Instafy docs/Follow-Mode.md): the map sends its view only while the host says "present" (≤ 10 a second,
// the latest wins, with a trailing send, ≤ 2 KB), applies a presenter's view without echoing it, reports the person's
// own gestures as "interact", sends taps (never on the "me" dot) and draws a presenter's ripple; the camera is a box of
// what is visible, so a phone and a desktop frame show the same area. Offline: no services, no browser.
// Run: node --test map-pack/tests/follow.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(HERE, '..', 'skills', 'interactive-map', 'starter', 'engine');
const mod = async (f) => import(pathToFileURL(path.join(ENGINE, f)).href);
const F = await mod('follow.js');
const H = await mod('host.js');

/** a FollowLink on a fake clock; snapshot() returns state.view */
function link(o = {}) {
  let now = 1000;
  const timers = [];
  const sent = [], applied = [], taps = [], asked = [];
  const state = { view: { k: 'map', s: 't=14', cam: null, tab: 'places', card: false, lay: 'sheet', snap: 'peek' } };
  const L = new F.FollowLink({
    snapshot: (opt) => { asked.push(opt); return state.view ? JSON.parse(JSON.stringify(state.view)) : null; },
    apply: (v, m) => applied.push([v, m]),
    tap: (t, from) => taps.push([t, from]),
    send: (msg, origin) => sent.push({ msg, origin }),
    now: () => now,
    setTimeout: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    ...o,
  });
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift(); now = t.at; t.fn();
    }
    now = end;
  };
  return { L, sent, applied, taps, asked, state, advance, views: () => sent.filter((s) => s.msg.type === 'view'), get now() { return now; } };
}
const PRESENT = { source: 'instafy-host', v: 1, type: 'present', on: true, share: { location: false } };
const VIEW = { k: 'map', s: 't=21&s=hotels:lore&l=night&off=mrt&d=2', cam: { b: [121.51, 25.03, 121.56, 25.07], br: 12, pi: 30 }, tab: 'compare', card: true, lay: 'sheet', snap: 'half' };

test('the hash parser is shared: parseState reads every key writeHash writes', () => {
  const s = F.parseState('#t=21&v=0.3&s=hotels:lore&p=121.5,25.04&off=mrt,feel&on=nightmarkets&l=night&w=quiet:3,near:1&d=4&@=121.53000,25.05000,14.20,12,30');
  assert.deepEqual(s, { t: 21, v: 0.3, s: 'hotels:lore', off: ['mrt', 'feel'], on: ['nightmarkets'], d: 4, at: [121.53, 25.05, 14.2, 12, 30], p: [121.5, 25.04], l: 'night', w: { quiet: 3, near: 1 } });
  assert.deepEqual(F.parseState(''), { t: null, v: null, s: null, off: [], on: [], d: null, at: null, p: null, l: undefined, w: null });
  assert.equal(F.parseState('s=%E0%A4%A').s, null, 'a broken escape is skipped, not thrown');
  const src = fs.readFileSync(path.join(ENGINE, 'engine.js'), 'utf8');
  assert.match(src, /function readHash\(\) \{ return parseState\(location\.hash\); \}/);
});

test('camera box: what is visible, not pixels; a desktop view fits on a phone and comes back the same', () => {
  const center = [121.5654, 25.033], zoom = 14.3;
  const desk = F.boxOf({ center, zoom, width: 900, height: 640 });
  assert.ok(desk[0] < center[0] && desk[2] > center[0] && desk[1] < center[1] && desk[3] > center[1]);
  // same size → same camera
  const same = F.cameraFor(desk, { width: 900, height: 640 });
  assert.ok(Math.abs(same.zoom - zoom) < 1e-3, `${same.zoom}`);
  assert.ok(Math.abs(same.center[0] - center[0]) < 1e-4 && Math.abs(same.center[1] - center[1]) < 1e-4);
  // a phone (narrow) zooms out until all of it fits: its own box contains the desktop's
  const ph = F.cameraFor(desk, { width: 360, height: 420 });
  assert.ok(ph.zoom < zoom);
  const phone = F.boxOf({ center: ph.center, zoom: ph.zoom, width: 360, height: 420 });
  assert.ok(phone[0] <= desk[0] + 1e-5 && phone[2] >= desk[2] - 1e-5 && phone[1] <= desk[1] + 1e-5 && phone[3] >= desk[3] - 1e-5, `${phone} ⊇ ${desk}`);
  // and fits snugly on one axis (the width here)
  assert.ok(Math.abs((phone[2] - phone[0]) - (desk[2] - desk[0])) < 1e-4);
  assert.ok(F.cameraFor([0, 0, 1e-9, 1e-9], { width: 300, height: 300 }).zoom <= 22);
});

test('view payload: serialize → JSON → decode keeps the same hash state; ≤ 2 KB by dropping toggles first; junk is refused', () => {
  const s = 't=21&v=0.3&s=hotels:lore&off=mrt&on=nightmarkets&l=night&w=quiet:3&d=2';
  const p = F.encodeView({ s, cam: { b: [121.511111111, 25.03, 121.56, 25.07], br: 12.4, pi: 30.2 }, tab: 'compare', card: true, lay: 'sheet', snap: 'half' });
  assert.deepEqual(p.cam, { b: [121.51111, 25.03, 121.56, 25.07], br: 12, pi: 30 });
  const back = F.decodeView(JSON.parse(JSON.stringify(p)));
  const { at: _a, ...want } = F.parseState(s);
  const { at: _b, ...got } = F.parseState(back.s);
  assert.deepEqual(got, want);
  assert.equal(back.tab, 'compare'); assert.equal(back.card, true); assert.equal(back.snap, 'half'); assert.equal(back.lay, 'sheet');
  assert.ok(F.viewBytes(p) < 400, `about 300 bytes: ${F.viewBytes(p)}`);
  // a huge layer list: the toggles go, the selection and lens stay
  const big = F.encodeView({ s: `s=hotels:lore&l=night&off=${Array.from({ length: 400 }, (_, i) => 'layer' + i).join(',')}`, cam: p.cam });
  assert.ok(F.viewBytes(big) <= F.MAX_VIEW_BYTES);
  assert.equal(big.trimmed, true);
  assert.equal(F.parseState(big.s).s, 'hotels:lore'); assert.equal(F.parseState(big.s).l, 'night'); assert.deepEqual(F.parseState(big.s).off, []);
  for (const bad of [null, 'x', { k: 'other' }, { k: 'map', s: 'x'.repeat(3000) }]) assert.equal(F.decodeView(bad), null);
  assert.equal(F.decodeView({ k: 'map', s: '', cam: { b: [10, 50, 5, 40] } }).cam, null, 'an inside-out box is dropped');
  assert.equal(F.decodeView({ k: 'map', s: '', tab: '<img>' }).tab, null);
  assert.deepEqual(F.decodeTap({ x: 0.5, y: 0.25, at: [121.5, 25.04] }), { x: 0.5, y: 0.25, at: [121.5, 25.04] });
  assert.equal(F.decodeTap({ x: 2, y: 0.5 }), null);
  assert.deepEqual(F.decodeTap({ at: [121.5, 25.04] }), { x: null, y: null, at: [121.5, 25.04] });
  assert.equal(F.fromName({ name: ' Kim\n Lee ' }), 'Kim Lee');
});

test('no views until the host says present; then one right away, ≤ 10 a second, the latest wins, a trailing send; stop ends it', () => {
  const t = link();
  t.L.start();
  t.L.changed(); t.advance(1000);
  assert.equal(t.views().length, 0, 'not presenting: nothing goes out');
  assert.equal(t.L.handle(PRESENT, 'https://studio.example'), true);
  assert.equal(t.views().length, 1, 'the first view goes out at once');
  assert.deepEqual(t.views()[0].msg, { source: 'instafy-map', v: 1, type: 'view', seq: 1, payload: t.state.view });
  assert.equal(t.views()[0].origin, 'https://studio.example', 'only to the host that asked');
  assert.deepEqual(t.asked.at(-1), { location: false });
  // a 1-second burst of 60 changes (a pan): ≤ 10 views, and the last one is the final state
  for (let i = 0; i < 60; i++) { t.state.view = { ...t.state.view, s: 't=14&i=' + i }; t.L.changed(); t.advance(1000 / 60); }
  t.advance(200);
  const burst = t.views().slice(1);
  assert.ok(burst.length <= 11 && burst.length >= 8, `${burst.length} views for 60 changes`);
  assert.equal(burst.at(-1).msg.payload.s, 't=14&i=59', 'the trailing send carries the latest');
  assert.deepEqual(burst.map((x) => x.msg.seq), burst.map((_, i) => i + 2));
  // nothing new: nothing sent
  const n = t.views().length;
  t.L.changed(); t.advance(500);
  assert.equal(t.views().length, n);
  // oversize payloads never leave
  t.state.view = { k: 'map', s: 'x'.repeat(3000) }; t.L.changed(); t.advance(500);
  assert.equal(t.views().length, n);
  t.L.handle({ ...PRESENT, on: false });
  t.state.view = { k: 'map', s: 't=1' }; t.L.changed(); t.advance(500);
  assert.equal(t.views().length, n, 'stopped');
  // "Share my location too" reaches the snapshot
  t.L.handle({ ...PRESENT, share: { location: true } });
  assert.deepEqual(t.asked.at(-1), { location: true });
});

test('a presenter\'s view: applied (queued until the map is ready, then without animation); never echoed; a presenter ignores it', () => {
  const t = link();
  const msg = { source: 'instafy-host', v: 1, type: 'apply-view', seq: 7, payload: VIEW, from: { id: 'u1', name: 'Kim' }, smooth: true };
  t.L.handle(msg);
  assert.equal(t.applied.length, 0, 'not ready yet');
  t.L.start();
  assert.equal(t.applied.length, 1);
  assert.equal(t.applied[0][1].smooth, false, 'a late view jumps');
  assert.deepEqual(t.applied[0][1].from, { id: 'u1', name: 'Kim' });
  t.L.handle(msg);
  assert.equal(t.applied[1][1].smooth, true);
  assert.equal(t.L.following, true);
  assert.equal(t.sent.length, 0, 'applying sends nothing back');
  t.L.handle({ ...msg, payload: { k: 'nope' } });
  assert.equal(t.applied.length, 2, 'a malformed view is dropped');
  // presenting: apply-view and apply-tap are ignored (no loop)
  t.L.handle(PRESENT);
  const n = t.sent.length;
  t.L.handle(msg); t.L.handle({ source: 'instafy-host', v: 1, type: 'apply-tap', payload: { x: 0.5, y: 0.5 }, from: { name: 'Kim' } });
  assert.equal(t.applied.length, 2); assert.equal(t.taps.length, 0);
  assert.equal(t.sent.length, n);
  assert.equal(t.L.handle({ source: 'instafy-host', v: 2, type: 'present', on: true }), false, 'another version is not ours');
});

test('interact: only the person\'s own gesture, only while following, at most every 300 ms; smooth views wait 400 ms after a touch', () => {
  const t = link();
  t.L.start();
  assert.equal(t.L.touched(), false, 'not following: nothing to stop');
  t.advance(450);
  t.L.handle({ source: 'instafy-host', v: 1, type: 'apply-view', seq: 1, payload: VIEW, smooth: true });
  assert.equal(t.L.touched(), true);
  assert.deepEqual(t.sent.at(-1).msg, { source: 'instafy-map', v: 1, type: 'interact' });
  assert.equal(t.L.touched(), false, 'throttled');
  t.advance(350);
  assert.equal(t.L.touched(false), false, 'a move during a drag is not a new gesture');
  // a smooth view still in flight after the touch does not yank the map; a jump (Follow again) does
  t.L.handle({ source: 'instafy-host', v: 1, type: 'apply-view', seq: 2, payload: VIEW, smooth: true });
  assert.equal(t.applied.length, 1);
  t.L.handle({ source: 'instafy-host', v: 1, type: 'apply-view', seq: 3, payload: VIEW, smooth: false });
  assert.equal(t.applied.length, 2);
  t.advance(450);
  t.L.handle({ source: 'instafy-host', v: 1, type: 'apply-view', seq: 4, payload: VIEW, smooth: true });
  assert.equal(t.applied.length, 3);
  assert.equal(t.L.touched(), true, 'a later gesture reports again');
  // only trusted pointer / wheel / touch / keys count; the host's shortcuts and bare modifiers do not
  assert.equal(F.isOwnGesture({ type: 'pointerdown', isTrusted: true }), true);
  assert.equal(F.isOwnGesture({ type: 'wheel' }), true);
  assert.equal(F.isOwnGesture({ type: 'keydown', key: 'ArrowLeft' }), true);
  assert.equal(F.isOwnGesture({ type: 'keydown', key: '\\', metaKey: true }), false);
  assert.equal(F.isOwnGesture({ type: 'keydown', key: 'F6' }), false);
  assert.equal(F.isOwnGesture({ type: 'keydown', key: 'Shift' }), false);
  assert.equal(F.isOwnGesture({ type: 'pointerdown', isTrusted: false }), false, 'a synthetic event is not the person');
  assert.equal(F.isOwnGesture({ type: 'scroll' }), false);
});

test('taps: only while presenting, ≤ 5 a second, rounded; a follower draws the presenter\'s ripple with their name', () => {
  const t = link();
  t.L.start();
  assert.equal(t.L.tapped(0.5, 0.5, [121.5, 25.04]), false);
  t.L.handle(PRESENT);
  assert.equal(t.L.tapped(0.123456, 1.4, [121.5123456, 25.0412345]), true);
  const tap = t.sent.at(-1).msg;
  assert.equal(tap.type, 'tap'); assert.equal(tap.source, 'instafy-map'); assert.ok(tap.seq > 0);
  assert.deepEqual(tap.payload, { x: 0.123, y: 1, at: [121.51235, 25.04123] });
  assert.equal(t.L.tapped(0.5, 0.5), false, 'the next one within 200 ms is dropped');
  t.advance(210);
  assert.equal(t.L.tapped(0.5, 0.5), true);
  assert.equal(t.sent.at(-1).msg.payload.at, undefined);
  const f = link(); f.L.start();
  f.L.handle({ source: 'instafy-host', v: 1, type: 'apply-tap', payload: { x: 0.2, y: 0.3, at: [121.5, 25.04] }, from: { id: 'u1', name: 'Kim' } });
  f.L.handle({ source: 'instafy-host', v: 1, type: 'apply-tap', payload: { x: 9 }, from: { name: 'Kim' } });
  assert.deepEqual(f.taps, [[{ x: 0.2, y: 0.3, at: [121.5, 25.04] }, { name: 'Kim' }]]);
});

// a frame's window for HostLink (as host-frame.test.mjs)
function fakeWin() {
  const listeners = [];
  const parent = { name: 'studio-parent' };
  const root = { style: { setProperty() {} }, dataset: {} };
  const win = {
    document: { documentElement: root }, location: { search: '?instafy_host=studio', pathname: '/' }, innerWidth: 390,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); },
    post: (data, o = {}) => { for (const fn of listeners) fn({ data, source: o.source ?? parent, origin: o.origin ?? 'https://studio.example' }); },
  };
  win.parent = parent;
  return { win, parent };
}

test('host.js: present / apply-view / apply-tap get the layout\'s frame and origin checks; the ack says "view" and "tap"', async () => {
  const { win } = fakeWin();
  const got = [], acks = [];
  const L = new H.HostLink({ win, emit: (t, p) => acks.push([t, p]), onFollow: (d, origin) => got.push([d.type, origin]) }).start();
  win.post({ source: 'instafy-host', v: 1, type: 'layout', insets: {}, caps: { geolocation: true } });
  assert.ok(acks[0][1].supports.includes('view') && acks[0][1].supports.includes('tap'));
  win.post(PRESENT);
  win.post(PRESENT, { source: { other: true } });
  win.post(PRESENT, { origin: 'https://evil.example' });
  win.post({ source: 'instafy-map', v: 1, type: 'present', on: true });
  win.post({ source: 'instafy-host', v: 1, type: 'apply-view', payload: VIEW });
  win.post({ source: 'instafy-host', v: 1, type: 'apply-tap', payload: { x: 0.1, y: 0.1 } });
  assert.deepEqual(got, [['present', 'https://studio.example'], ['apply-view', 'https://studio.example'], ['apply-tap', 'https://studio.example']]);
  assert.equal(L.layout != null, true);
  // the same messages on the host's MessagePort or uw.ingest reach the engine through bind.js; from the parent frame
  // they are host.js's alone
  const { Bind } = await mod('bind.js');
  const seen = [];
  const bind = new Bind({ hostFollow: (d) => seen.push(d.type), command: () => {} });
  bind.handle(PRESENT, 'port');
  bind.handle({ source: 'instafy-host', v: 1, type: 'apply-view', payload: VIEW }, 'api');
  bind.handle(PRESENT, 'parent');
  bind.handle(PRESENT, 'sse');
  assert.deepEqual(seen, ['present', 'apply-view']);
});

test('engine wiring: views only via the follow link, to the host\'s origin; Locate sets cam:null until a move; no tap on the "me" dot', () => {
  const src = fs.readFileSync(path.join(ENGINE, 'engine.js'), 'utf8');
  assert.match(src, /send: \(msg, origin\) => bridgePost\(msg, origin \|\| hostLink\.origin \|\| '\*'\)/);
  assert.match(src, /onFollow: \(d, origin\) => follow\.handle\(d, origin\)/);
  assert.match(src, /if \(!\(E\.camOnMe && !o\.location\)\)/);
  const me = src.slice(src.indexOf('function showMe('), src.indexOf('function buildFabs('));
  assert.match(me, /E\.camOnMe = true;\s*E\.map\.flyTo\([^;]*\{ uwMe: true \}\)/);
  assert.match(src, /map\.on\('movestart', \(e\) => \{ if \(!e\.uwMe\) E\.camOnMe = false; \}\)/);
  assert.match(src, /if \(!follow\.share\.location && meMarker\) \{[\s\S]{0,120}closest\?\.\('\.uw-me'\)\) return;[\s\S]{0,160}< 28\) return;/);
  assert.match(src, /follow\.start\(\); \};/, 'the first view and an early apply wait for ready');
  // the hash and the view come from one place
  assert.match(src, /const writeHash = Object\.assign\(\(\) => \{ writeHashSoon\(\); follow\.changed\(\); \}/);
  const css = fs.readFileSync(path.join(ENGINE, 'engine.css'), 'utf8');
  assert.match(css, /\.uw-ripple i \{/);
});
