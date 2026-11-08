// Hosted in Instafy Studio: the map reads `?uw_host=studio` at boot and the
// host's {source:"instafy-host", type:"layout"} message, folds the insets into --sat/--sab/--sal/--sar, hides its own
// title when the host's bar shows it, keeps "Show my location" unless the host says it can't share the position,
// answers layout-ack, forwards ⌘\ and F6, emits its v1 events, and soft-reloads on "reload" (the host's ↻, or the
// reload Instafy sends a saved or undone site, which `uw host` pushes over __uw/events). Without a host nothing changes.
// Offline: no services, no browser.
// Run: node --test map-pack/tests/*.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bindCommand } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const ENGINE = path.join(SKILL, 'starter', 'engine');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const mod = async (f) => import(pathToFileURL(path.join(ENGINE, f)).href);
const H = await mod('host.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-hostframe-'));
const children = [];
// wait for the servers to exit before removing their folder: a server still writing into it made rmdir fail (ENOTEMPTY)
after(async () => {
  await Promise.all(children.map((c) => c.exitCode !== null || c.signalCode !== null ? null : new Promise((resolve) => {
    const timer = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} resolve(); }, 3000);
    c.once('exit', () => { clearTimeout(timer); resolve(); });
    try { c.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
  })));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// a tiny stand-in for the frame's window: <html> style + dataset, sessionStorage, message listeners
function fakeWin({ search = '', width = 390, embedded = true, store = new Map() } = {}) {
  const props = new Map();
  const root = { style: { setProperty: (k, v) => props.set(k, v), getPropertyValue: (k) => props.get(k) || '' }, dataset: {} };
  const listeners = [];
  const parent = { name: 'studio-parent' };
  const win = {
    document: { documentElement: root },
    location: { search, pathname: '/trip/' },
    innerWidth: width,
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); },
    post: (data, o = {}) => { for (const fn of listeners) fn({ data, source: o.source ?? parent, origin: o.origin ?? 'https://studio.example' }); },
  };
  win.parent = embedded ? parent : win;
  return { win, root, props, parent, store };
}
const LAYOUT = { source: 'instafy-host', v: 1, type: 'layout', insets: { top: 36, bottom: 68, left: 0, right: 0 }, chrome: 'host', title: 'hidden', caps: { geolocation: true }, theme: 'dark' };

test('?instafy_host=<name> (the host-neutral name Studio sends) is read at boot', () => {
  assert.equal(H.hostFromUrl('?instafy_host=studio'), 'studio');
  assert.equal(H.hostFromUrl('?a=1&instafy_host=studio'), 'studio');
  assert.equal(H.hostFromUrl('?instafy_host=<script>'), null);
});

test('?uw_host=<name> is read at boot; anything else is not a host', () => {
  assert.equal(H.hostFromUrl('?uw_host=studio'), 'studio');
  assert.equal(H.hostFromUrl('?a=1&uw_host=studio'), 'studio');
  assert.equal(H.hostFromUrl(''), null);
  assert.equal(H.hostFromUrl('?uw_host=<script>'), null);
  assert.equal(H.hostFromUrl('?uw_host='), null);
});

test('layout messages are shape-checked: insets clamped to 0…480 px, unknown values dropped, other sources ignored', () => {
  const L = H.parseLayout({ ...LAYOUT, insets: { top: -5, bottom: 9999, left: '12.4', right: 'x' }, title: 'maybe', caps: { geolocation: 'yes' }, theme: 'purple' });
  assert.deepEqual(L.insets, { top: 0, bottom: H.MAX_INSET, left: 12, right: 0 });
  assert.equal(L.title, null);
  assert.equal(L.caps.geolocation, null);
  assert.equal(L.theme, null);
  assert.equal(H.parseLayout({ ...LAYOUT, source: 'instafy-map' }), null);
  assert.equal(H.parseLayout({ ...LAYOUT, type: 'command' }), null);
  assert.equal(H.parseLayout({ ...LAYOUT, v: 2 }), null);
  assert.equal(H.parseLayout('layout'), null);
  assert.deepEqual(H.parseLayout({ source: 'instafy-host', type: 'layout' }).insets, { top: 0, bottom: 0, left: 0, right: 0 });
});

test('insets become --uw-host-* on <html>; engine.css folds them into --sat/--sab/--sal/--sar as a floor over the safe area', () => {
  const { root, props } = fakeWin();
  const done = H.applyLayout(H.parseLayout(LAYOUT), root, 'studio');
  assert.equal(props.get('--uw-host-t'), '36px');
  assert.equal(props.get('--uw-host-b'), '68px');
  assert.equal(props.get('--uw-host-l'), '0px');
  assert.equal(root.dataset.uwHost, 'studio');
  assert.equal(root.dataset.uwChrome, 'host');
  assert.deepEqual(done, { insets: { top: 36, bottom: 68, left: 0, right: 0 }, title: 'shown', locate: 'shown' });
  const css = fs.readFileSync(path.join(ENGINE, 'engine.css'), 'utf8');
  for (const [v, side, k] of [['sat', 'top', 't'], ['sab', 'bottom', 'b'], ['sal', 'left', 'l'], ['sar', 'right', 'r']]) {
    assert.match(css, new RegExp(`--${v}: max\\(env\\(safe-area-inset-${side}, 0px\\), var\\(--uw-host-${k}, 0px\\)\\);`), `--${v} folds --uw-host-${k}`);
  }
  // the phone sheet's peek and the fabs are placed from --sab / --sat, so they clear the host bar and pill
  assert.match(css, /\.uw-fabs \{[^}]*top: calc\(12px \+ var\(--sat\)\)/);
  const ui = fs.readFileSync(path.join(ENGINE, 'ui.js'), 'utf8');
  assert.match(ui, /paddingBottom = 'var\(--sab/);
  assert.match(ui, /sheetSnaps\(\{ H, safeTop, safeBot, content \}\)/);
});

test('title: hidden only when the host bar shows it; "Show my location" hidden only when caps.geolocation is false', () => {
  const css = fs.readFileSync(path.join(ENGINE, 'engine.css'), 'utf8');
  assert.match(css, /html\[data-uw-host-title="shown"\][^{]*\.uw-title:not\(\.is-ask\) \{ display: none/);
  assert.match(css, /html\[data-uw-geo="off"\][^{]*\[data-id="uw-locate"\] \{ display: none/);
  // nothing else hides the locate button (hosted alone keeps it: the frame allows geolocation)
  assert.equal((css.match(/uw-locate/g) || []).length, 1);
  const { root } = fakeWin();
  let d = H.applyLayout(H.parseLayout({ ...LAYOUT, title: 'shown', caps: { geolocation: true } }), root);
  assert.equal(root.dataset.uwHostTitle, 'shown'); assert.equal(root.dataset.uwGeo, undefined);
  assert.equal(d.title, 'hidden'); assert.equal(d.locate, 'shown');
  d = H.applyLayout(H.parseLayout({ ...LAYOUT, title: 'hidden', caps: {} }), root);
  assert.equal(root.dataset.uwHostTitle, undefined); assert.equal(root.dataset.uwGeo, undefined); assert.equal(d.locate, 'shown');
  d = H.applyLayout(H.parseLayout({ ...LAYOUT, caps: { geolocation: false } }), root);
  assert.equal(root.dataset.uwGeo, 'off'); assert.equal(d.locate, 'hidden');
});

test('HostLink: only the parent frame, one origin, an allowlist when the site has one; every layout is acked', () => {
  const { win, root, parent } = fakeWin({ search: '?uw_host=studio' });
  const sent = []; const seen = [];
  const link = new H.HostLink({ win, emit: (t, p) => sent.push([t, p]), onLayout: (L) => seen.push(L) }).start();
  assert.equal(link.name, 'studio'); assert.equal(link.hosted, true); assert.equal(root.dataset.uwHost, 'studio');
  assert.equal(root.dataset.uwHostTitle, undefined, 'a phone-width frame keeps its title until the host says otherwise');
  win.post(LAYOUT, { source: { other: true } });
  assert.equal(sent.length, 0, 'not from the parent frame');
  win.post(LAYOUT);
  assert.equal(sent.length, 1);
  const [type, ack] = sent[0];
  assert.equal(type, 'layout-ack');
  assert.equal(ack.v, 1);
  assert.deepEqual(ack.insets, LAYOUT.insets);
  for (const s of ['insets', 'title', 'caps.geolocation', 'reload', 'hotkey', 'select', 'lens', 'ask', 'done', 'ready']) assert.ok(ack.supports.includes(s), s);
  assert.equal(seen.length, 1); assert.deepEqual(link.insets, LAYOUT.insets);
  win.post({ ...LAYOUT, insets: { bottom: 300 } }, { origin: 'https://evil.example' });
  assert.equal(sent.length, 1, 'the first host to speak keeps the frame');
  win.post({ ...LAYOUT, insets: { top: 0, bottom: 320 } }, { origin: 'https://studio.example', source: parent });
  assert.equal(link.insets.bottom, 320, 'the half-height chat sheet raises the bottom inset');
  // bind.parentOrigins
  const b = fakeWin(); const sentB = [];
  const linkB = new H.HostLink({ win: b.win, emit: (t) => sentB.push(t) }).start();
  linkB.setOrigins(['https://app.instafy.dev']);
  b.win.post(LAYOUT, { origin: 'https://studio.example' });
  assert.equal(sentB.length, 0);
  b.win.post(LAYOUT, { origin: 'https://app.instafy.dev' });
  assert.deepEqual(sentB, ['layout-ack']);
  assert.equal(b.root.dataset.uwHost, 'host', 'a host that never set the query is still a host once it sends a layout');
  // a frame that is not embedded ignores layout messages
  const c = fakeWin({ embedded: false }); const sentC = [];
  new H.HostLink({ win: c.win, emit: (t) => sentC.push(t) }).start();
  c.win.post(LAYOUT, { source: c.win });
  assert.equal(sentC.length, 0);
});

test('HostLink: a wide Studio frame hides the title before the first message; a soft reload restores the last layout without a flash', () => {
  const wide = fakeWin({ search: '?uw_host=studio', width: 956 });
  new H.HostLink({ win: wide.win }).start();
  assert.equal(wide.root.dataset.uwHostTitle, 'shown');
  const store = new Map();
  const a = fakeWin({ search: '?uw_host=studio', store });
  new H.HostLink({ win: a.win }).start();
  a.win.post({ ...LAYOUT, insets: { top: 36, bottom: 120 }, caps: { geolocation: false } });
  const b = fakeWin({ search: '?uw_host=studio', store });
  const sent = [];
  const link = new H.HostLink({ win: b.win, emit: (t) => sent.push(t) }).start();
  assert.equal(b.props.get('--uw-host-b'), '120px');
  assert.equal(b.root.dataset.uwGeo, 'off');
  assert.equal(link.layout.insets.bottom, 120);
  assert.equal(sent.length, 0, 'the stashed layout is not acked: the host will re-send and get its ack then');
  // standalone: no query, no message, nothing is set
  const s = fakeWin({ embedded: false });
  const ls = new H.HostLink({ win: s.win }).start();
  assert.equal(ls.hosted, false);
  assert.deepEqual(s.root.dataset, {});
  assert.equal(s.props.size, 0);
});

test('HostLink.accept: a layout on the host\'s MessagePort (bind.js hands it over) applies like the parent-frame one', async () => {
  const { win, props } = fakeWin();
  const sent = [];
  const link = new H.HostLink({ win, emit: (t) => sent.push(t) }).start();
  assert.equal(link.accept({ ...LAYOUT, insets: { bottom: 50 } }), true);
  assert.equal(props.get('--uw-host-b'), '50px');
  assert.equal(link.accept({ source: 'instafy-host', type: 'progress' }), false);
  assert.deepEqual(sent, ['layout-ack']);
  // bind.js: "layout" on the port or uw.ingest → E.hostLayout; from the parent frame it is host.js's job alone
  const { Bind } = await mod('bind.js');
  const got = [];
  const bind = new Bind({ hostLayout: (d) => got.push(d), command: () => {} });
  bind.handle({ source: 'instafy-host', ...LAYOUT }, 'port');
  bind.handle({ source: 'instafy-host', ...LAYOUT }, 'api');
  bind.handle({ source: 'instafy-host', ...LAYOUT }, 'parent');
  bind.handle({ source: 'instafy-host', ...LAYOUT }, 'sse');
  assert.equal(got.length, 2);
});

test('hotkeys: ⌘\\ / Ctrl+\\ and F6 are forwarded; plain keys, Alt combos and auto-repeat are not', () => {
  assert.deepEqual(H.hotkeyOf({ key: '\\', metaKey: true }), { key: 'Mod+\\', shift: false });
  assert.deepEqual(H.hotkeyOf({ key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true }), { key: 'Mod+\\', shift: true });
  assert.deepEqual(H.hotkeyOf({ key: 'F6' }), { key: 'F6', shift: false });
  assert.deepEqual(H.hotkeyOf({ key: 'F6', shiftKey: true }), { key: 'F6', shift: true });
  assert.equal(H.hotkeyOf({ key: '\\' }), null);
  assert.equal(H.hotkeyOf({ key: '\\', metaKey: true, altKey: true }), null);
  assert.equal(H.hotkeyOf({ key: 'F6', repeat: true }), null);
  assert.equal(H.hotkeyOf({ key: 'Escape' }), null, 'Esc stays the map\'s (clears its selection)');
  const src = fs.readFileSync(path.join(ENGINE, 'engine.js'), 'utf8');
  assert.match(src, /const k = hotkeyOf\(e\); if \(!k\) return;\s*e\.preventDefault\(\);\s*E\.emit\('hotkey', k\);/);
});

test('bridge: v1 events reach the parent frame as {source:"instafy-map", v:1}, plain JSON only', async () => {
  const posted = []; const events = [];
  const parent = { postMessage: (m, o) => posted.push([m, o]) };
  globalThis.window = { parent, dispatchEvent: (e) => events.push(e) };
  globalThis.document = { title: 'Taipei stay' };
  try {
    const B = await mod('bridge.js');
    for (const [t, p] of [['hotkey', { key: 'Mod+\\', shift: false }], ['select', { layer: 'hotels', id: 'via', ref: 'hotels:via', name: 'Via Loft' }],
      ['lens', { id: 'sleep' }], ['ask', { layer: 'hotels', id: 'via', ref: 'hotels:via', name: 'Via Loft' }],
      ['done', { id: 'int_1', name: 'check_registry', ref: 'hotels:via', summary: '1 found', count: 1 }], ['layout-ack', { v: 1, insets: { top: 0, bottom: 68, left: 0, right: 0 } }]]) {
      B.emit(t, { ...p, fn: undefined });
    }
    assert.equal(posted.length, 6);
    for (const [m, o] of posted) { assert.equal(m.source, 'instafy-map'); assert.equal(m.v, 1); assert.equal(o, '*'); assert.equal(m.title, 'Taipei stay'); }
    assert.deepEqual(posted.map(([m]) => m.type), ['hotkey', 'select', 'lens', 'ask', 'done', 'layout-ack']);
    assert.equal(events.length, 6);
  } finally { delete globalThis.window; delete globalThis.document; }
  // the engine emits them: select / lens / ask (card action, hosted only) / done (bind.js) / clear
  const src = fs.readFileSync(path.join(ENGINE, 'engine.js'), 'utf8') + fs.readFileSync(path.join(ENGINE, 'bind.js'), 'utf8');
  for (const re of [/E\.emit\('select', selectPayload\(L, f, /, /E\.emit\('lens', \{ id/, /E\.emit\('ask', \{ layer/, /this\.E\.emit\('done', \{ id, name: job\.name, ref/, /E\.emit\('clear'/]) assert.match(src, re);
});

test('"Show my location": the browser\'s own prompt; a refusal or an unusable frame becomes a friendly toast', () => {
  const geo = { getCurrentPosition() {} };
  assert.equal(H.geoAvailability({ navigator: {}, document: {} }), 'unsupported');
  assert.equal(H.geoAvailability({ navigator: { geolocation: geo }, isSecureContext: false, document: {} }), 'insecure');
  assert.equal(H.geoAvailability({ navigator: { geolocation: geo }, isSecureContext: true, document: { permissionsPolicy: { allowsFeature: (f) => f !== 'geolocation' } } }), 'frame');
  assert.equal(H.geoAvailability({ navigator: { geolocation: geo }, isSecureContext: true, document: { permissionsPolicy: { allowsFeature: () => true } } }), 'ok');
  assert.equal(H.geoAvailability({ navigator: { geolocation: geo }, isSecureContext: true, document: {} }), 'ok');
  for (const k of [1, 2, 3, 'insecure', 'frame', 'unsupported', undefined]) {
    const m = H.locateMessage(k);
    assert.ok(m.length > 10 && m.length < 140, String(k));
    assert.doesNotMatch(m, /error|code|undefined|GeolocationPositionError/i);
  }
  assert.match(H.locateMessage(1), /Allow location/);
  // standalone, no dialog before the browser's: the locator calls getCurrentPosition directly, and a failure is a
  // toast (engine.js toasts locateMessage(kind)); the host path is tests/location.test.mjs
  const src = fs.readFileSync(path.join(ENGINE, 'locate.js'), 'utf8');
  assert.match(src, /const can = geoAvailability\(this\.win\);\s*if \(can !== 'ok'\) \{ this\.fail\(null, can, cb\); return null; \}/);
  assert.match(src, /else geo\.getCurrentPosition\(ok, bad, opts\);/);
  assert.match(fs.readFileSync(path.join(ENGINE, 'engine.js'), 'utf8'), /onError: \(kind\) => E\.ui\?\.toast\(locateMessage\(kind\), 5000\)/);
});

test('"reload" is a bind command: a soft reload that keeps the hash, sheet and tab, with a short note', async () => {
  const { Bind } = await mod('bind.js');
  const calls = [];
  const bind = new Bind({ command: (n, a) => calls.push([n, a]) });
  bind.handle({ source: 'instafy-host', type: 'command', command: { name: 'reload', args: { note: 'Railways are green now' } } }, 'parent');
  bind.handle({ source: 'instafy-host', type: 'command', command: { name: 'eval', args: {} } }, 'parent');
  assert.deepEqual(calls, [['reload', { note: 'Railways are green now' }]]);
  // a viewer that polls data/version.json reloads on no stamp there: the reload comes from the host. A map made before
  // keeps an old stamp in the file, and an Undo puts back an earlier one; neither is a reload, and a file with none loads
  calls.length = 0;
  bind.version = { v: 3, reload: 'r1', files: {}, jobs: {} };
  bind.fetchJSON = async () => ({ json: { v: 3, reload: 'r2', reload_note: 'New cafés', files: {}, jobs: {} } });
  await bind.pollNow();
  bind.fetchJSON = async () => ({ json: { v: 4, files: {}, jobs: {} } });
  await bind.pollNow();
  assert.deepEqual(calls, []);
  assert.equal(bind.version.v, 4);
  // what the hash does not hold survives the reload, read once and only while fresh
  const store = new Map();
  const win = { location: { pathname: '/trip/' }, sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) } };
  H.stashReload(win, { snap: 'half', tab: 'compare', note: H.reloadNote({ note: '  Railways\n green ' }) });
  const s = H.takeReload(win);
  assert.equal(s.snap, 'half'); assert.equal(s.tab, 'compare'); assert.equal(s.note, 'Railways green');
  assert.equal(H.takeReload(win), null);
  H.stashReload(win, { snap: 'peek' });
  store.set([...store.keys()][0], JSON.stringify({ snap: 'peek', at: Date.now() - 60000 }));
  assert.equal(H.takeReload(win), null, 'a stale stash is ignored');
  assert.equal(H.reloadNote({ note: 'x'.repeat(200) }).length, 80);
  assert.equal(H.reloadNote({}), null);
  const src = fs.readFileSync(path.join(ENGINE, 'engine.js'), 'utf8');
  assert.match(src, /writeHash\.flush\(\)[\s\S]{0,200}stashReload\(window[\s\S]{0,120}location\.reload\(\)/);
  assert.match(src, /restoreAfterReload\(\);/);
});

// ---- the reload Instafy sends a saved or undone site, against a running `uw host` (offline) ----
// A note added to a trip's day reached neither open map, and neither did its Undo: the turn changed map.config.json by
// hand and ran no `uw reload`, and `uw host` reloaded its viewers only when that command's stamp in data/version.json
// changed. Instafy sends every open site it saved or undid `instafy bind command <site> reload '{}'`, and no binder took
// it for the map. `uw host` now takes it as `instafy bind serve` does; bindCommand (fixtures.mjs) is that client.
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const run = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env: { ...process.env, UW_CACHE: path.join(tmp, 'cache'), UW_TURN_BUDGET: '0' } });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => { let json = null; try { json = JSON.parse(out); } catch {} resolve({ code, out, err, json }); });
});
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 100)); } };
const get = (port, p, headers = {}) => new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
  r.on('error', () => resolve({ status: 0, body: '' })); r.end();
});
const post = (port, p, body, headers = {}) => new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
    let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json }); });
  });
  r.on('error', () => resolve({ status: 0, json: null })); r.end(typeof body === 'string' ? body : JSON.stringify(body));
});
/** An open viewer: the engine's SSE on <prefix>__uw/events, every event it gets */
function viewer(port, prefix = '/') {
  const got = [];
  const req = http.get(`http://127.0.0.1:${port}${prefix}__uw/events`, (res) => {
    let buf = '';
    res.on('data', (d) => {
      buf += d;
      let i; while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1]; if (ev && data) got.push({ ev, data: JSON.parse(data) }); }
    });
  });
  req.on('error', () => {});
  after(() => req.destroy());
  return { got, commands: () => got.filter((g) => g.ev === 'command').map((g) => g.data.command) };
}
const viewersAt = async (port, prefix = '/') => JSON.parse((await get(port, `${prefix}__uw/health`)).body || '{}').viewers;
function startHost(dir, port, cwd = tmp) {
  const host = spawn(process.execPath, [UW, 'host', dir, '--port', String(port), '--no-warm'], { cwd, env: { ...process.env, UW_CACHE: path.join(tmp, 'cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(host);
  let log = ''; host.stdout.on('data', (d) => { log += d; }); host.stderr.on('data', (d) => { log += d; });
  return { host, log: () => log, exited: new Promise((r) => host.once('exit', r)) };
}

test('the reload Instafy sends a saved or undone site reaches every open viewer of a `uw host` map, found and checked as instafy bind serve is', async () => {
  let r = await run(['new', 'trip', '--title', 'Trip', '--center', '121.52,25.05', '--zoom', '13', '--json']);
  assert.equal(r.code, 0, r.err);
  const site = path.join(tmp, 'trip');
  // nothing serves it yet: the client finds no server (the runtime says no binder took the reload)
  assert.match((await bindCommand(site, 'reload')).error, /no running binder/);

  const port = await freePort();
  const h = startHost('trip', port);
  assert.ok(await waitFor(async () => (await get(port, '/__uw/health')).status === 200), 'uw host answers: ' + h.log());
  // where the client finds it, beside the map's files: the server record and the admin token, in a folder only this
  // user can open, ignored by git, and never served
  const bind = path.join(site, '.bind');
  const state = JSON.parse(fs.readFileSync(path.join(bind, 'server.json'), 'utf8'));
  assert.equal(state.pid, h.host.pid);
  assert.equal(state.url, `http://127.0.0.1:${port}`);
  assert.deepEqual(state.sites, [{ name: 'trip', prefix: '', dir: fs.realpathSync(site) }]);
  assert.match(fs.readFileSync(path.join(bind, 'admin-token'), 'utf8'), /^[A-Za-z0-9_-]{32}\n$/);
  assert.equal(fs.statSync(bind).mode & 0o777, 0o700);
  for (const f of ['admin-token', 'server.json']) assert.equal(fs.statSync(path.join(bind, f)).mode & 0o777, 0o600, f);
  assert.equal(fs.readFileSync(path.join(bind, '.gitignore'), 'utf8').trim().split('\n').pop(), '*');
  for (const p of ['/.bind/admin-token', '/.bind/server.json', '/.bind/', '/%2Ebind/admin-token']) assert.equal((await get(port, p)).status, 404, p);

  // two open viewers: the reload reaches both, and the answer counts them
  const a = viewer(port), b = viewer(port);
  assert.ok(await waitFor(async () => (await viewersAt(port)) === 2), 'two viewers');
  r = await bindCommand(site, 'reload');
  assert.equal(r.status, 202, r.text);
  assert.deepEqual([r.json.ok, r.json.viewers], [true, 2]);
  for (const v of [a, b]) assert.ok(await waitFor(() => v.commands().length === 1), JSON.stringify(v.got));
  for (const v of [a, b]) assert.deepEqual(v.commands(), [{ name: 'reload', args: {} }]);
  const ev = a.got.find((g) => g.ev === 'command');
  assert.equal(ev.data.source, 'instafy-host');
  // the engine's SSE path makes it the soft reload (the hash, sheet and tab kept)
  const { Bind } = await mod('bind.js');
  const calls = [];
  new Bind({ command: (n, x) => calls.push([n, x]) }).handle({ ...ev.data, type: ev.ev }, 'sse');
  assert.deepEqual(calls, [['reload', {}]]);

  // refused, as the binder refuses them, and no viewer gets anything: without the token or with another; a name that
  // is not this computer's own (a tunnel's client connects from here but keeps its public name); through a proxy; from
  // another page; a command the binder does not know; args that are not an object
  const token = fs.readFileSync(path.join(bind, 'admin-token'), 'utf8').trim();
  const auth = { authorization: `Bearer ${token}` };
  const reload = { name: 'reload', args: {} };
  assert.equal((await post(port, '/__bind/command', reload)).status, 401);
  assert.equal((await bindCommand(site, 'reload', {}, { token: 'x'.repeat(32) })).status, 401);
  assert.equal((await post(port, '/__bind/command', reload, { ...auth, host: `p-abc--x.preview.example:${port}` })).status, 403);
  assert.equal((await post(port, '/__bind/command', reload, { ...auth, host: `192.168.1.20:${port}` })).status, 403);
  assert.equal((await post(port, '/__bind/command', reload, { ...auth, 'x-forwarded-for': '203.0.113.9' })).status, 403);
  assert.equal((await post(port, '/__bind/command', reload, { ...auth, origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(port, '/__bind/command', { name: 'eval', args: {} }, auth)).status, 400);
  assert.equal((await post(port, '/__bind/command', { name: 'reload', args: [] }, auth)).status, 400);
  assert.equal((await post(port, '/__bind/command', 'not json', auth)).status, 400);
  assert.equal((await get(port, '/__bind/command', auth)).status, 405);
  // a note rides along, for the toast after the reload
  assert.equal((await bindCommand(site, 'reload', { note: 'Day 1 note added' })).status, 202);
  assert.ok(await waitFor(() => a.commands().length === 2));
  assert.deepEqual(a.commands()[1], { name: 'reload', args: { note: 'Day 1 note added' } });
  assert.equal(b.commands().length, 2);

  // data/version.json is no reload any more: a map made before keeps an old stamp there, and an Undo puts back an
  // earlier one; neither reaches a viewer (the reload comes from the space)
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  fs.writeFileSync(path.join(site, 'data', 'version.json'), JSON.stringify({ v: 2, files: {}, jobs: {}, reload: '2026-11-07T20:57:30.000Z~ab12' }));
  await new Promise((res) => setTimeout(res, 1200));
  assert.equal(a.commands().length, 2);
  // the skill's own reload step is gone, and so is its command
  r = await run(['reload', 'trip']);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command "reload"/);
  r = await run(['help', 'host']);
  assert.match(r.out.replace(/\s+/g, ' '), /Open views follow the site's changes: Instafy sends an open site whose files changed \(an Undo, a saved change\) `instafy bind command <site> reload '\{\}'`/);

  // the host stops: its record goes with it (the token stays, for the next one), and the reload finds no server
  h.host.kill('SIGTERM');
  await h.exited;
  assert.equal(fs.existsSync(path.join(bind, 'server.json')), false);
  assert.ok(fs.existsSync(path.join(bind, 'admin-token')));
  assert.match((await bindCommand(site, 'reload')).error, /no running binder/);
  // started again (the space wakes and replays the card's command), it keeps the same token
  const port2 = await freePort();
  const h2 = startHost('trip', port2);
  assert.ok(await waitFor(async () => (await get(port2, '/__uw/health')).status === 200), h2.log());
  assert.equal(fs.readFileSync(path.join(bind, 'admin-token'), 'utf8').trim(), token);
  assert.equal((await bindCommand(site, 'reload')).json?.viewers, 0);
  h2.host.kill('SIGTERM');
  await h2.exited;
});

test('a folder of maps: each map takes its own reload, a map with no bound.json too, and only its viewers get it', async () => {
  const gallery = path.join(tmp, 'gallery');
  fs.mkdirSync(gallery);
  for (const name of ['porto', 'lisbon']) {
    const r = await run(['new', path.join('gallery', name), '--title', name, '--center', '-8.61,41.15', '--zoom', '13']);
    assert.equal(r.code, 0, r.err);
  }
  const port = await freePort();
  const h = startHost('gallery', port);
  assert.ok(await waitFor(async () => (await get(port, '/porto/__uw/health')).status === 200), h.log());
  // each map keeps the record in its own folder, never the folder of maps (a space's top folder served so would answer
  // for every page below it)
  for (const name of ['porto', 'lisbon']) {
    const state = JSON.parse(fs.readFileSync(path.join(gallery, name, '.bind', 'server.json'), 'utf8'));
    assert.deepEqual(state.sites.map((s) => [s.name, s.prefix]), [[name, `/${name}`]]);
    assert.equal(state.url, `http://127.0.0.1:${port}`);
  }
  assert.equal(fs.existsSync(path.join(gallery, '.bind')), false);
  // a map in it is marked as one with a live channel, so its engine listens for the reload
  const head = await new Promise((resolve) => { http.get(`http://127.0.0.1:${port}/porto/`, (res) => { res.resume(); resolve(res.headers); }); });
  assert.equal(head['x-uw-host'], '2');
  const p = viewer(port, '/porto/'), l = viewer(port, '/lisbon/');
  assert.ok(await waitFor(async () => (await viewersAt(port, '/porto/')) === 1 && (await viewersAt(port, '/lisbon/')) === 1));
  const r = await bindCommand(path.join(gallery, 'porto'), 'reload');
  assert.deepEqual([r.status, r.json?.viewers], [202, 1]);
  assert.ok(await waitFor(() => p.commands().length === 1));
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(l.commands().length, 0, 'the other map is not reloaded');
  h.host.kill('SIGTERM');
  await h.exited;
  for (const name of ['porto', 'lisbon']) assert.equal(fs.existsSync(path.join(gallery, name, '.bind', 'server.json')), false, name);
});

// A space's sites/ holds every chat's pages, and a page made with `instafy bind` has its own binder, whose record in the
// page's .bind/ is where the space's reload of that page goes. `uw host` serving such a folder keeps the binder's record
// only in its maps' folders: a page that is not a map listens on its own binder (it never takes `uw host`'s channel), so
// its record, and its folder, stay as they are while `uw host` runs and after it stops.
test('a folder of sites: a page that is not a map keeps its own binder\'s record, and nothing of uw host is written in it', async () => {
  const sitesDir = path.join(tmp, 'sites-of-a-space');
  fs.mkdirSync(sitesDir);
  assert.equal((await run(['new', path.join('sites-of-a-space', 'trip'), '--title', 'Trip', '--center', '-8.61,41.15', '--zoom', '13'])).code, 0);
  const page = path.join(sitesDir, 'compare');
  fs.mkdirSync(path.join(page, '.bind'), { recursive: true });
  fs.writeFileSync(path.join(page, 'index.html'), '<!doctype html><title>Compare</title>');
  fs.writeFileSync(path.join(page, 'bound.json'), JSON.stringify({ intents: {} }));
  // its binder runs (this test's own process stands in for it)
  const record = JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:9', started_at: '2026-11-08T00:00:00.000Z', sites: [{ name: 'compare', prefix: '', dir: page }] }, null, 2) + '\n';
  fs.writeFileSync(path.join(page, '.bind', 'server.json'), record);
  fs.writeFileSync(path.join(page, '.bind', 'admin-token'), 'binder-own-admin-token-0123456789\n');
  const before = fs.readdirSync(path.join(page, '.bind')).sort();
  const port = await freePort();
  const h = startHost('sites-of-a-space', port);
  assert.ok(await waitFor(async () => (await get(port, '/trip/__uw/health')).status === 200), h.log());
  // the map takes the space's reload; the page's reload still goes to its own binder
  assert.equal(JSON.parse(fs.readFileSync(path.join(sitesDir, 'trip', '.bind', 'server.json'), 'utf8')).pid, h.host.pid);
  assert.equal(fs.readFileSync(path.join(page, '.bind', 'server.json'), 'utf8'), record);
  assert.deepEqual(fs.readdirSync(path.join(page, '.bind')).sort(), before);
  assert.equal((await post(port, '/compare/__bind/command', { name: 'reload', args: {} }, { authorization: 'Bearer binder-own-admin-token-0123456789' })).status, 401);
  h.host.kill('SIGTERM');
  await h.exited;
  assert.equal(fs.readFileSync(path.join(page, '.bind', 'server.json'), 'utf8'), record);
  assert.equal(fs.existsSync(path.join(sitesDir, 'trip', '.bind', 'server.json')), false);
});
