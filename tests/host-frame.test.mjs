// Hosted in Instafy Studio: the map reads `?uw_host=studio` at boot and the
// host's {source:"instafy-host", type:"layout"} message, folds the insets into --sat/--sab/--sal/--sar, hides its own
// title when the host's bar shows it, keeps "Show my location" unless the host says it can't share the position,
// answers layout-ack, forwards ⌘\ and F6, emits its v1 events, and soft-reloads on "reload" (the host's ↻, or
// `uw reload <site>` pushed over __uw/events). Without a host nothing changes. Offline: no services, no browser.
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
  for (const s of ['insets', 'title', 'caps.geolocation', 'reload', 'hotkey', 'select', 'lens', 'ask', 'done']) assert.ok(ack.supports.includes(s), s);
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
  // polling viewers: data/version.json "reload" changed since this page loaded → reload; unchanged → nothing
  calls.length = 0;
  bind.version = { v: 3, reload: 'r1', files: {}, jobs: {} };
  bind.fetchJSON = async () => ({ json: { v: 3, reload: 'r2', reload_note: 'New cafés', files: {}, jobs: {} } });
  await bind.pollNow();
  assert.deepEqual(calls, [['reload', { note: 'New cafés' }]]);
  await bind.pollNow();
  assert.equal(calls.length, 1);
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

// ---- `uw reload <site>` against a running `uw host` (offline) ----
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const run = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env: { ...process.env, UW_CACHE: path.join(tmp, 'cache'), UW_TURN_BUDGET: '0' } });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => { let json = null; try { json = JSON.parse(out); } catch {} resolve({ code, out, err, json }); });
});
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 100)); } };

test('`uw reload <site>`: stamps data/version.json and a running `uw host` pushes "reload" to every open viewer', async () => {
  let r = await run(['new', 'trip', '--title', 'Trip', '--center', '121.52,25.05', '--zoom', '13', '--json']);
  assert.equal(r.code, 0, r.err);
  const site = path.join(tmp, 'trip');
  // no host running: the stamp still lands (polling viewers), and the reply says how to make it instant
  r = await run(['reload', 'trip', '--note', 'Railways are green', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.host, null);
  const v1 = JSON.parse(fs.readFileSync(path.join(site, 'data', 'version.json'), 'utf8'));
  assert.equal(v1.reload, r.json.reload); assert.equal(v1.reload_note, 'Railways are green');
  r = await run(['reload', 'trip']);
  assert.match(r.out, /No running `uw host`/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(site, 'data', 'version.json'), 'utf8')).reload_note, undefined, 'no note: the old one is dropped');

  const port = await freePort();
  const host = spawn(process.execPath, [UW, 'host', 'trip', '--port', String(port), '--no-warm'], { cwd: tmp, env: { ...process.env, UW_CACHE: path.join(tmp, 'cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(host);
  let hostErr = ''; host.stderr.on('data', (d) => { hostErr += d; });
  const up = await waitFor(() => new Promise((res) => http.get(`http://127.0.0.1:${port}/__uw/health`, (x) => { x.resume(); res(x.statusCode === 200); }).on('error', () => res(false))));
  assert.ok(up, 'uw host answers: ' + hostErr);
  // a viewer: SSE on __uw/events
  const got = [];
  const req = http.get(`http://127.0.0.1:${port}/__uw/events`, (res) => {
    let buf = '';
    res.on('data', (d) => {
      buf += d;
      let i; while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1]; if (ev && data) got.push({ ev, data: JSON.parse(data) }); }
    });
  });
  after(() => req.destroy());
  await waitFor(() => new Promise((res) => http.get(`http://127.0.0.1:${port}/__uw/health`, (x) => { let b = ''; x.on('data', (d) => { b += d; }); x.on('end', () => res(JSON.parse(b).viewers === 1)); }).on('error', () => res(false))));
  // the CLI finds a --detach host through .uwcache/serve.json; this foreground one is registered the same way
  fs.mkdirSync(path.join(site, '.uwcache'), { recursive: true });
  fs.writeFileSync(path.join(site, '.uwcache', 'serve.json'), JSON.stringify({ pid: host.pid, cmd: 'host', port, host: '127.0.0.1', dir: site }));
  r = await run(['reload', 'trip', '--note', 'Cafés added', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.host, { port, prefix: '/', live: true });
  assert.equal(r.json.viewers, 1);
  const ev = await waitFor(() => got.find((g) => g.ev === 'command'));
  assert.ok(ev, 'the viewer got a command event: ' + JSON.stringify(got));
  assert.equal(ev.data.source, 'instafy-host');
  assert.deepEqual(ev.data.command, { name: 'reload', args: { note: 'Cafés added' } });
  assert.equal(ev.data.reload, r.json.reload);
  // the engine's SSE path turns it into the reload command
  const { Bind } = await mod('bind.js');
  const calls = [];
  new Bind({ command: (n, a) => calls.push([n, a]) }).handle({ ...ev.data, source: ev.data.source || 'instafy-host', type: ev.ev }, 'sse');
  assert.deepEqual(calls, [['reload', { note: 'Cafés added' }]]);
  // an unrelated version bump (a job's records) is not a reload
  const n = got.length;
  const ver = JSON.parse(fs.readFileSync(path.join(site, 'data', 'version.json'), 'utf8'));
  fs.writeFileSync(path.join(site, 'data', 'version.json'), JSON.stringify({ ...ver, v: ver.v + 1 }));
  await new Promise((res) => setTimeout(res, 1200));
  assert.equal(got.filter((g) => g.ev === 'command').length, 1);
  assert.ok(got.length >= n);
  // `uw help reload` documents it
  r = await run(['help', 'reload']);
  assert.match(r.out, /reload <site> \[--note/);
});
