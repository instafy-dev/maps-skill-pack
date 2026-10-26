// "Show my location" inside a host that locates for the site (Instafy docs/Previews.md "Location"): when the host's layout says
// caps.location === "host", the locate button asks the parent frame ({source:"instafy-map", v:1, type:
// "location-request"}) and never calls navigator.geolocation; the host answers with location / location-error /
// location-stop, accepted only from the parent frame at the host's origin (or the host's own MessagePort). Standalone
// it is navigator.geolocation as before. Offline: no services, no browser.
// Run: node --test map-pack/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(HERE, '..', 'skills', 'interactive-map', 'starter', 'engine');
const mod = async (f) => import(pathToFileURL(path.join(ENGINE, f)).href);
const H = await mod('host.js');
const LOC = await mod('locate.js');
const { Locator } = LOC;

const STUDIO = 'https://studio.example';
const LAYOUT = { source: 'instafy-host', v: 1, type: 'layout', insets: { top: 36, bottom: 68, left: 0, right: 0 }, chrome: 'host', title: 'hidden', caps: { geolocation: true, location: 'host' }, theme: 'light' };
const COORDS = { latitude: 25.0418, longitude: 121.5438, accuracy: 18 };

// the frame's window: a parent that records what the page posts, message listeners, and a geolocation that must not
// be touched on the host path (every call is recorded)
function fakeWin({ embedded = true, secure = true, geo = true } = {}) {
  const posted = []; const listeners = []; const geoCalls = [];
  const parent = { postMessage: (m, o) => posted.push([JSON.parse(JSON.stringify(m)), o]) };
  const geolocation = {
    getCurrentPosition: (ok, bad, opts) => { geoCalls.push(['get', opts]); geolocation.last = { ok, bad }; },
    watchPosition: (ok, bad, opts) => { geoCalls.push(['watch', opts]); geolocation.last = { ok, bad }; return 42; },
    clearWatch: (id) => geoCalls.push(['clear', id]),
  };
  const root = { style: { setProperty() {} }, dataset: {} };
  const win = {
    document: { documentElement: root },
    location: { search: '', pathname: '/trip/' },
    innerWidth: 390,
    isSecureContext: secure,
    navigator: geo ? { geolocation } : {},
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); },
    post: (data, o = {}) => { for (const fn of listeners) fn({ data, source: o.source ?? parent, origin: o.origin ?? STUDIO }); },
  };
  win.parent = embedded ? parent : win;
  return { win, parent, posted, geoCalls, geolocation, root };
}

/** a HostLink + Locator pair wired like engine.js does, with every callback recorded */
function hosted(o = {}) {
  const f = fakeWin(o);
  const fixes = []; const errors = []; const stops = [];
  const link = new H.HostLink({ win: f.win, onLocation: (d) => loc.receive(d) }).start();
  const loc = new Locator({ win: f.win, link, onFix: (p, i) => fixes.push([p, i]), onError: (k, i) => errors.push([k, i]), onStop: (i) => stops.push(i), now: o.now });
  if (o.layout !== false) f.win.post(o.layout || LAYOUT);
  return { ...f, link, loc, fixes, errors, stops, requests: () => f.posted.filter(([m]) => m.type !== 'layout-ack') };
}
const answer = (id, extra = {}) => ({ source: 'instafy-host', v: 1, type: 'location', payload: { id, coords: COORDS, timestamp: 1791900000000, ...extra } });
const error = (id, code) => ({ source: 'instafy-host', v: 1, type: 'location-error', payload: { id, code } });
const stop = (id) => ({ source: 'instafy-host', v: 1, type: 'location-stop', payload: { id } });

test('layout: caps.location "host" is read (anything else is not), keeps the button even with caps.geolocation false, and is acked', () => {
  assert.equal(H.parseLayout(LAYOUT).caps.location, 'host');
  assert.equal(H.parseLayout({ ...LAYOUT, caps: { geolocation: true, location: 'browser' } }).caps.location, null);
  assert.equal(H.parseLayout({ ...LAYOUT, caps: { geolocation: true } }).caps.location, null);
  const root = { style: { setProperty() {} }, dataset: {} };
  let d = H.applyLayout(H.parseLayout({ ...LAYOUT, caps: { geolocation: false, location: 'host' } }), root);
  assert.equal(root.dataset.uwGeo, undefined); assert.equal(d.locate, 'shown');
  d = H.applyLayout(H.parseLayout({ ...LAYOUT, caps: { geolocation: false } }), root);
  assert.equal(root.dataset.uwGeo, 'off'); assert.equal(d.locate, 'hidden');
  assert.equal(LOC.hostLocates(H.parseLayout(LAYOUT)), true);
  assert.equal(LOC.hostLocates(H.parseLayout({ ...LAYOUT, caps: { geolocation: true } })), false);
  const acks = [];
  const f = fakeWin();
  new H.HostLink({ win: f.win, emit: (t, p) => acks.push(p) }).start();
  f.win.post(LAYOUT);
  assert.ok(acks[0].supports.includes('caps.location'));
});

test('host path: the button asks the parent at the host\'s origin and never touches navigator.geolocation; the answer moves the dot', () => {
  const h = hosted();
  assert.equal(h.loc.mode, 'host');
  const id = h.loc.locate({ watch: false, highAccuracy: true });
  assert.match(id, /^loc_[a-z0-9]{6,12}$/);
  assert.deepEqual(h.geoCalls, [], 'the frame does not call the browser itself');
  const req = h.requests();
  assert.equal(req.length, 1);
  assert.deepEqual(req[0][0], { source: 'instafy-map', v: 1, type: 'location-request', payload: { id, watch: false, highAccuracy: true } });
  assert.equal(req[0][1], STUDIO, 'posted to the host origin, never "*"');
  h.win.post(answer(id));
  assert.equal(h.fixes.length, 1);
  const [pos, info] = h.fixes[0];
  assert.deepEqual(pos.coords, COORDS);
  assert.equal(pos.timestamp, 1791900000000);
  assert.deepEqual(info, { id, watch: false, first: true, via: 'host' });
  // a one-shot is done after its answer: a repeat is dropped
  h.win.post(answer(id));
  assert.equal(h.fixes.length, 1);
  assert.equal(h.loc.active.size, 0);
  // the position goes to the page's callbacks only: nothing the page posts carries it
  assert.doesNotMatch(JSON.stringify(h.posted), /latitude|121\.54/);
});

test('host path: answers are taken only from the parent frame, at the host\'s origin, for a request we made, and well formed', () => {
  const h = hosted();
  const id = h.loc.locate();
  h.win.post(answer(id), { source: { other: 'frame' } });
  h.win.post(answer(id), { origin: 'https://evil.example' });
  h.win.post(answer('loc_notours'));
  h.win.post({ ...answer(id), source: 'instafy-map' });
  h.win.post({ ...answer(id), v: 2 });
  h.win.post(answer(id, { coords: { latitude: 200, longitude: 10 } }));
  h.win.post(answer(id, { coords: { latitude: '25', longitude: 121 } }));
  h.win.post(error(id, 'denied'), { origin: 'https://evil.example' });
  assert.equal(h.fixes.length, 0); assert.equal(h.errors.length, 0);
  assert.equal(h.loc.active.size, 1, 'the request still waits for the real answer');
  h.win.post(answer(id));
  assert.equal(h.fixes.length, 1);
  // bind.parentOrigins narrows it further
  const b = hosted({ layout: false });
  b.link.setOrigins(['https://app.instafy.dev']);
  b.win.post(LAYOUT, { origin: 'https://app.instafy.dev' });
  const id2 = b.loc.locate();
  assert.equal(b.requests()[0][1], 'https://app.instafy.dev');
  b.win.post(answer(id2), { origin: STUDIO });
  assert.equal(b.fixes.length, 0);
  b.win.post(answer(id2), { origin: 'https://app.instafy.dev' });
  assert.equal(b.fixes.length, 1);
});

test('host path: every location-error code becomes its own friendly toast and ends the request', () => {
  const want = {
    denied: /^Location is blocked for Instafy\. Studio shows how to turn it on/,
    unavailable: /Couldn’t find your location right now/,
    timeout: /took too long/,
    stopped: /^Location is off for this site · turn it on in Studio’s menu for this preview$/,
    hidden: /pauses while this map is hidden/,
  };
  assert.deepEqual(Object.keys(want).sort(), [...LOC.HOST_LOCATION_CODES].sort());
  for (const [code, re] of Object.entries(want)) {
    const h = hosted();
    const id = h.loc.locate();
    h.win.post(error(id, code));
    assert.equal(h.errors.length, 1, code);
    const [kind, info] = h.errors[0];
    assert.equal(kind, code);
    assert.match(info.message, re, code);
    assert.equal(H.locateMessage(code), info.message);
    assert.ok(info.message.length < 140, code);
    assert.doesNotMatch(info.message, /error|code|undefined/i, code);
    assert.equal(h.loc.active.size, 0, `${code} ends the request`);
    h.win.post(answer(id));
    assert.equal(h.fixes.length, 0, `${code}: a late answer is dropped`);
  }
  // an unknown code is "unavailable", not a raw string in a toast
  const h = hosted();
  const id = h.loc.locate();
  h.win.post(error(id, 'EKERNEL'));
  assert.equal(h.errors[0][0], 'unavailable');
  // a stop sticks: the next tap asks again and gets the same answer (the site cannot undo it; the ▾ menu can)
  const s = hosted();
  s.win.post(error(s.loc.locate(), 'stopped'));
  const again = s.loc.locate();
  assert.equal(s.requests().filter(([m]) => m.type === 'location-request').length, 2);
  s.win.post(error(again, 'stopped'));
  assert.deepEqual(s.errors.map(([k]) => k), ['stopped', 'stopped']);
});

test('host path: a watch streams fixes until location-stop from the host; our own stop tells the host', () => {
  const h = hosted();
  const id = h.loc.locate({ watch: true, highAccuracy: false });
  assert.deepEqual(h.requests()[0][0].payload, { id, watch: true, highAccuracy: false });
  h.win.post(answer(id));
  h.win.post(answer(id, { coords: { latitude: 25.0421, longitude: 121.5440, accuracy: 9, heading: 90, speed: 1.2, altitude: 'x' } }));
  assert.equal(h.fixes.length, 2);
  assert.equal(h.fixes[0][1].first, true); assert.equal(h.fixes[1][1].first, false);
  assert.deepEqual(h.fixes[1][0].coords, { latitude: 25.0421, longitude: 121.544, accuracy: 9, heading: 90, speed: 1.2 });
  assert.equal(h.loc.watching, true);
  h.win.post(stop(id));
  assert.deepEqual(h.stops, [{ id, watch: true, by: 'host' }]);
  assert.equal(h.loc.watching, false);
  h.win.post(answer(id));
  assert.equal(h.fixes.length, 2, 'no fixes after the host ended the watch');
  assert.equal(h.requests().filter(([m]) => m.type === 'location-stop').length, 0, 'the host ended it: nothing to tell it');
  // the page ends a watch: location-stop {id} to the host, at its origin; later fixes are dropped
  const id2 = h.loc.locate({ watch: true });
  assert.equal(h.loc.stop(id2), true);
  const last = h.requests().at(-1);
  assert.deepEqual(last[0], { source: 'instafy-map', v: 1, type: 'location-stop', payload: { id: id2 } });
  assert.equal(last[1], STUDIO);
  h.win.post(answer(id2));
  assert.equal(h.fixes.length, 2);
  assert.equal(h.loc.stop(id2), false, 'already stopped');
  // pagehide: everything still running is stopped
  const a = h.loc.locate({ watch: true }), b = h.loc.locate({ watch: true });
  h.loc.stopAll();
  assert.deepEqual(h.requests().slice(-2).map(([m]) => m.payload.id).sort(), [a, b].sort());
  assert.equal(h.loc.active.size, 0);
});

test('host path: a second tap while the first ask waits reuses it; a host that never answered gets asked again', () => {
  let t = 1000;
  const h = hosted({ now: () => t });
  const id = h.loc.locate();
  t += 5000;
  assert.equal(h.loc.locate(), id, 'the browser prompt may still be open: no second request');
  assert.equal(h.requests().length, 1);
  t += LOC.REASK_MS;
  const id2 = h.loc.locate();
  assert.notEqual(id2, id);
  assert.deepEqual(h.requests().map(([m]) => [m.type, m.payload.id]), [['location-request', id], ['location-stop', id], ['location-request', id2]]);
  h.win.post(answer(id));
  assert.equal(h.fixes.length, 0, 'the abandoned ask is not answered any more');
});

test('host path: answers on the host\'s MessagePort or uw.ingest reach the locator; from the parent frame only host.js routes them', async () => {
  const { Bind } = await mod('bind.js');
  const got = [];
  const bind = new Bind({ hostLocation: (d) => got.push(d), command: () => {} });
  for (const via of ['port', 'api', 'parent', 'sse']) for (const m of [answer('loc_a'), error('loc_a', 'denied'), stop('loc_a')]) bind.handle(m, via);
  assert.equal(got.length, 6);
  // and the engine wires E.hostLocation to the same locator as host.js's onLocation
  const src = fs.readFileSync(path.join(ENGINE, 'engine.js'), 'utf8');
  assert.match(src, /onLocation: \(d\) => locator\.receive\(d\)/);
  assert.match(src, /E\.hostLocation = \(d\) => locator\.receive\(d\)/);
  assert.match(src, /new Locator\(\{\s*win: window, link: hostLink,/);
  assert.match(src, /addEventListener\('pagehide', \(\) => locator\.stopAll\(\)\)/);
});

test('standalone: no host, so navigator.geolocation as before (the browser\'s prompt, same options), friendly toasts on failure', () => {
  const f = fakeWin({ embedded: false });
  const fixes = []; const errors = [];
  const link = new H.HostLink({ win: f.win }).start();
  const loc = new Locator({ win: f.win, link, onFix: (p, i) => fixes.push([p, i]), onError: (k, i) => errors.push([k, i]) });
  assert.equal(loc.mode, 'browser');
  const id = loc.locate({ watch: false, highAccuracy: true });
  assert.ok(id);
  assert.deepEqual(f.geoCalls, [['get', { enableHighAccuracy: true, timeout: 9000, maximumAge: 60000 }]]);
  assert.equal(f.posted.length, 0, 'nothing goes to a parent');
  // a real GeolocationCoordinates keeps its fields on the prototype (a spread of it is {}): they must still arrive
  class GeolocationCoordinates { get latitude() { return COORDS.latitude; } get longitude() { return COORDS.longitude; } get accuracy() { return COORDS.accuracy; } get altitude() { return null; } get heading() { return null; } get speed() { return null; } }
  f.geolocation.last.ok({ coords: new GeolocationCoordinates(), timestamp: 5 });
  assert.deepEqual(fixes[0][0], { coords: COORDS, timestamp: 5 });
  assert.equal(fixes[0][1].via, 'browser'); assert.equal(fixes[0][1].first, true);
  loc.locate();
  f.geolocation.last.bad({ code: 1 });
  assert.equal(errors[0][0], 1);
  assert.match(errors[0][1].message, /Allow location for this site/);
  // an unusable page: the toast, and the browser is not asked
  for (const [o, kind] of [[{ embedded: false, secure: false }, 'insecure'], [{ embedded: false, geo: false }, 'unsupported']]) {
    const g = fakeWin(o); const errs = [];
    const l = new Locator({ win: g.win, link: new H.HostLink({ win: g.win }).start(), onError: (k) => errs.push(k) });
    assert.equal(l.locate(), null);
    assert.deepEqual(errs, [kind]);
    assert.deepEqual(g.geoCalls, []);
  }
  // a watch uses watchPosition and stop clears it
  const w = loc.locate({ watch: true });
  assert.equal(f.geoCalls.at(-1)[0], 'watch');
  f.geolocation.last.ok({ coords: COORDS, timestamp: 6 });
  f.geolocation.last.ok({ coords: COORDS, timestamp: 7 });
  assert.deepEqual(fixes.slice(-2).map(([, i]) => i.first), [true, false]);
  // a passing "unavailable" or "timeout" does not end a watch that has found the person; a refusal does
  f.geolocation.last.bad({ code: 2 });
  f.geolocation.last.bad({ code: 3 });
  assert.equal(loc.watching, true);
  assert.equal(errors.length, 1);
  f.geolocation.last.ok({ coords: COORDS, timestamp: 8 });
  assert.equal(fixes.length, 4);
  assert.equal(loc.stop(w), true);
  assert.deepEqual(f.geoCalls.at(-1), ['clear', 42]);
  const w2 = loc.locate({ watch: true });
  f.geolocation.last.bad({ code: 2 });
  assert.equal(loc.watching, false, 'before any fix, "unavailable" is the answer');
  assert.equal(errors.at(-1)[0], 2);
  assert.equal(loc.stop(w2), false);
  // host messages do nothing for a browser request
  assert.equal(loc.receive(answer(w)), false);
});

test('standalone too when a host layout says "host" but the page is not in a frame (a stashed layout in its own tab)', () => {
  const f = fakeWin({ embedded: false });
  const link = new H.HostLink({ win: f.win }).start();
  link.apply(H.parseLayout(LAYOUT), { ack: false, stash: false });
  const loc = new Locator({ win: f.win, link });
  assert.equal(loc.mode, 'browser');
  loc.locate();
  assert.equal(f.geoCalls.length, 1);
  // and a host without caps.location keeps the frame on the browser path (older Studio, any other host)
  const g = hosted({ layout: { ...LAYOUT, caps: { geolocation: true } } });
  assert.equal(g.loc.mode, 'browser');
  g.loc.locate();
  assert.equal(g.geoCalls.length, 1);
  assert.equal(g.requests().length, 0);
});

test('engine: the button goes through the locator; the "me" dot and fly-to are the same for both paths; no position on the bridge', () => {
  const src = fs.readFileSync(path.join(ENGINE, 'engine.js'), 'utf8');
  assert.doesNotMatch(src, /navigator\.geolocation/, 'only locate.js talks to the browser');
  assert.match(src, /id: 'uw-locate'[\s\S]{0,200}locator\.locate\(\{ watch: false, highAccuracy: true \}\)\) ui\.toast\('Finding you…'/);
  const me = src.slice(src.indexOf('function showMe('), src.indexOf('function buildFabs('));
  assert.match(me, /new maplibregl\.Marker\(\{ element: h\('div\.uw-me'/);
  assert.match(me, /if \(info\.first === false\) return;\s*zeroPadding\(\);[\s\S]{0,200}E\.map\.flyTo\(\{ center: ll, zoom: Math\.max\(E\.map\.getZoom\(\), 15\)/);
  assert.doesNotMatch(me, /emit/);
  assert.match(src, /onFix: \(pos, info\) => showMe\(pos, info\)/);
  assert.match(src, /onError: \(kind\) => E\.ui\?\.toast\(locateMessage\(kind\), 5000\)/);
  const lsrc = fs.readFileSync(path.join(ENGINE, 'locate.js'), 'utf8');
  assert.doesNotMatch(lsrc, /import[^;]*bridge/, 'locate.js never uses the bridge');
  // uw.locate / uw.stopLocating for custom.js
  assert.match(src, /locate: \(o = \{\}\) => locator\.locate\(/);
  assert.match(src, /stopLocating: \(id\) => locator\.stop\(id\)/);
});
