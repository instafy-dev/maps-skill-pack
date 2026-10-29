// v1 review fixes (findings F8/F12, F9/F15, F14, F16, F18, F19, F23):
//   - the phone sheet's peek keeps Places / Layers / Compare above a host's bottom inset, and moves up for a taller one
//   - processes uw starts on its own (a --detach server, handlers, warm-ups) get an allowlisted environment: no job
//     credentials (CONTROLLER_ACCESS_TOKEN, OPENAI_API_KEY, CODEX_API_KEY)
//   - static files carry no wildcard CORS header; __uw/* answers only known hosts (no DNS rebinding)
//   - bind.js checks the parent frame and bind.parentOrigins before it adopts a MessagePort
//   - the select event carries the name the map shows
//   - "locale": "sv" makes the map's own words and `uw question`'s phrases Swedish
//   - a host bar that shows the title keeps the question visible and collapses an empty header
// Offline: no services, no browser. Run: node --test map-pack/tests/*.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const ENGINE = path.join(SKILL, 'starter', 'engine');
const LIB = path.join(SKILL, 'scripts', 'lib');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const eng = (f) => import(pathToFileURL(path.join(ENGINE, f)).href);
const lib = (f) => import(pathToFileURL(path.join(LIB, f)).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-hardening-'));
const children = [];
after(async () => {
  for (const c of children) try { c.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
// what an agent job's shell carries (dummy values): none of it may reach a handler or a detached server
const JOB_SECRETS = { CONTROLLER_ACCESS_TOKEN: 'dummy-controller', CONTROLLER_ACCESS_SCOPES: 'dummy-scopes', OPENAI_API_KEY: 'dummy-openai', CODEX_API_KEY: 'dummy-codex', NODE_OPTIONS: '--no-warnings' };
const SECRET_NAMES = ['CONTROLLER_ACCESS_TOKEN', 'CONTROLLER_ACCESS_SCOPES', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'NODE_OPTIONS'];
const baseEnv = () => ({ ...process.env, UW_CACHE: path.join(tmp, 'cache'), UW_TURN_BUDGET: '0' });
const run = (args, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env: { ...baseEnv(), ...env } });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => { let json = null; try { json = JSON.parse(out); } catch {} resolve({ code, out, err, json }); });
});
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 100)); } };
/** one HTTP request with any Host / Origin headers (fetch would not let us set Host) */
const req = (port, { method = 'GET', p = '/', headers = {}, body } = {}) => new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
    let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, headers: res.headers, body: b, json }); });
  });
  r.on('error', (e) => resolve({ status: 0, error: e.message }));
  if (body) r.write(body);
  r.end();
});
/** the names in another process's environment (Linux /proc, macOS ps -E), or null when this OS can't tell */
function envNamesOf(pid) {
  try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').map((kv) => kv.split('=')[0]).filter(Boolean); } catch {}
  try { return [...execFileSync('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1]); } catch { return null; }
}

// ---------------------------------------------------------------- F8 / F12: phone sheet peek vs the host inset
test('phone peek: the tab bar ends above the host inset (98 px composer, 150 px reply peek), and a taller inset moves the sheet up', async () => {
  const { sheetSnaps } = await eng('ui.js');
  const H = 844, content = 315; // a Taipei question map: grab with the ask + verdict (212) + lens row (58) + tabs (45)
  const at98 = sheetSnaps({ H, safeTop: 56, safeBot: 98, content });
  const at150 = sheetSnaps({ H, safeTop: 56, safeBot: 150, content });
  // the tab bar is the last row of the peek: it ends at peek + content (no cut needed here)
  assert.equal(at98.cut, 0); assert.equal(at150.cut, 0);
  assert.ok(at98.peek + content <= H - 98, `tabs end at ${at98.peek + content}, under the composer at ${H - 98}`);
  assert.ok(at150.peek + content <= H - 150, `tabs end at ${at150.peek + content}, under the reply peek at ${H - 150}`);
  assert.ok(at150.peek < at98.peek, 'a taller inset lifts the sheet');
  // the old clamp (sheet top never above H/2 + 40 = 462) put them under: this is what the finding saw
  assert.ok(Math.max(Math.round(H * 0.5) + 40, H - content - 98) + content > H - 98);
  // the snaps stay ordered: full above half above peek
  for (const s of [at98, at150]) assert.ok(s.full < s.half && s.half < s.peek, JSON.stringify(s));
});

test('phone peek without a host is where it always was; a peek too tall for the frame cuts the ask, never the tabs', async () => {
  const { sheetSnaps, LIST_MIN } = await eng('ui.js');
  for (const [H, safeTop, safeBot, content] of [[844, 0, 0, 315], [844, 47, 34, 315], [844, 47, 34, 120], [667, 20, 0, 240], [932, 59, 34, 380], [740, 0, 0, 59]]) {
    const s = sheetSnaps({ H, safeTop, safeBot, content });
    assert.equal(s.peek, Math.max(Math.round(H * 0.5) + 40, H - content - safeBot), `standalone ${H}/${safeBot}/${content}`);
    // half open is the middle, or LIST_MIN above the peek when the middle shows less of the list than that
    const mid = Math.round(H * 0.5);
    assert.equal(s.half, s.peek - mid >= LIST_MIN ? mid : s.peek - LIST_MIN);
    assert.equal(s.full, safeTop + 10);
    assert.equal(s.cut, 0);
  }
  // a short frame with a tall ask and the reply peek: the map keeps ≥ 30% of the visible area, the ask is cut
  const s = sheetSnaps({ H: 640, safeTop: 56, safeBot: 150, content: 420 });
  assert.ok(s.cut > 0);
  assert.ok(s.peek >= 56 + 96);
  assert.ok(s.peek + 420 - s.cut <= 640 - 150, 'the tab bar still ends above the inset');
  // ui.js uses it and cuts the ask's box at peek only
  const ui = fs.readFileSync(path.join(ENGINE, 'ui.js'), 'utf8');
  assert.match(ui, /sheetSnaps\(\{ H, safeTop, safeBot, content \}\)/);
  assert.match(ui, /name === 'peek' && this\.peekCut > 0/);
  // a hint shown above the sheet moves with it when a host's inset lifts the peek
  assert.match(ui, /if \(this\.toasts\.style\.bottom\) this\.toasts\.style\.bottom = `\$\{Math\.round\(this\.H - y \+ 10\)\}px`;/);
});

// The 29 Oct 2026 drive, on a 375×812 phone: Studio's frame is 572 px between its bar and its composer, and the half
// open sheet showed the search box, the "Sights" heading and half of the first sight.
test('phone half open shows the list: LIST_MIN above the peek, as far as the frame has room', async () => {
  const { sheetSnaps, LIST_MIN } = await eng('ui.js');
  assert.ok(LIST_MIN >= 200);
  for (const content of [103, 121, 160]) {
    const s = sheetSnaps({ H: 572, safeTop: 0, safeBot: 0, content });
    assert.ok(s.peek - s.half >= LIST_MIN, `content ${content}: ${JSON.stringify(s)}`);
    assert.ok(s.full < s.half && s.half < s.peek);
  }
  // a frame too short for that keeps the snaps in order
  for (const [H, content] of [[300, 160], [220, 120]]) {
    const s = sheetSnaps({ H, safeTop: 0, safeBot: 0, content });
    assert.ok(s.full < s.half && s.half < s.peek, `${H}: ${JSON.stringify(s)}`);
  }
});

// ---------------------------------------------------------------- F9 / F15: no job credentials in spawned processes
test('safeEnv: an allowlist (PATH, HOME, locale, TZ, TMPDIR, SSL_CERT_*, NODE_*, UW_*), never credentials or NODE_OPTIONS', async () => {
  const { safeEnv } = await lib('safe-env.mjs');
  const env = safeEnv({ UW_SITE: '/s' }, {
    PATH: '/bin', HOME: '/h', LANG: 'sv_SE.UTF-8', LC_ALL: 'C', TZ: 'Asia/Taipei', TMPDIR: '/t', SSL_CERT_FILE: '/c.pem', NODE_EXTRA_CA_CERTS: '/ca.pem',
    UW_CACHE: '/u', UW_PLAYWRIGHT: '/pw', ...JOB_SECRETS, NODE_AUTH_TOKEN: 'npm', UW_SECRET_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'x', GITHUB_TOKEN: 'x', RANDOM: 'x',
    // the pack's lookup settings and the runtime's stable cache folder pass (a detached host keeps the turn's state);
    // a credential-looking name never does, whatever its prefix
    INSTAFY_CACHE_DIR: '/c', INSTAFY_LOOKUP_PROVIDERS: '{}', INSTAFY_LOOKUP_API_KEY: 'x', INSTAFY_PROJECT_ID: 'p',
  });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'INSTAFY_CACHE_DIR', 'INSTAFY_LOOKUP_PROVIDERS', 'LANG', 'LC_ALL', 'NODE_EXTRA_CA_CERTS', 'PATH', 'SSL_CERT_FILE', 'TMPDIR', 'TZ', 'UW_CACHE', 'UW_PLAYWRIGHT', 'UW_SITE']);
  assert.equal(env.UW_SITE, '/s');
});

test('uw host: a handler a viewer triggers sees no CONTROLLER_ACCESS_TOKEN / OPENAI_API_KEY / CODEX_API_KEY; __uw/* refuses a rebinding Host', async () => {
  let r = await run(['new', 'probe', '--title', 'Probe', '--center', '121.52,25.05', '--zoom', '13', '--json']);
  assert.equal(r.code, 0, r.err);
  const site = path.join(tmp, 'probe');
  fs.mkdirSync(path.join(site, 'handlers'), { recursive: true });
  const dump = path.join(tmp, 'handler-env.json');
  fs.writeFileSync(path.join(site, 'handlers', 'env_probe.mjs'), `import fs from 'node:fs';
fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(dump)}, JSON.stringify(Object.keys(process.env)));
process.stdout.write(JSON.stringify({ type: 'done', summary: 'ok' }) + '\\n');
`);
  fs.writeFileSync(path.join(site, 'bound.json'), JSON.stringify({ version: 1, intents: { env_probe: {
    label: 'Probe', params: { type: 'object', additionalProperties: false, properties: {} }, ui: ['card-more'],
    target: { records: 'data/records/env_probe.json' }, timeout_s: 20, handler: 'handlers/env_probe.mjs' } }, results: { files: ['data/records/env_probe.json'] } }, null, 2));
  const port = await freePort();
  const host = spawn(process.execPath, [UW, 'host', 'probe', '--port', String(port), '--no-warm'], { cwd: tmp, env: { ...baseEnv(), ...JOB_SECRETS, HOME: path.join(tmp, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(host);
  let hostErr = ''; host.stderr.on('data', (d) => { hostErr += d; });
  const own = `127.0.0.1:${port}`;
  assert.ok(await waitFor(async () => (await req(port, { p: '/__uw/health', headers: { Host: own } })).status === 200), 'uw host answers: ' + hostErr);
  const intent = (id) => JSON.stringify({ source: 'instafy-map', v: 2, type: 'intent', id, name: 'env_probe', params: {} });

  // the real page: queued, the handler runs, its environment is the allowlist
  let x = await req(port, { method: 'POST', p: '/__uw/intent', body: intent('int_ok_0001'), headers: { Host: own, Origin: `http://${own}`, 'Content-Type': 'application/json' } });
  assert.equal(x.status, 202, x.body);
  const names = await waitFor(() => { try { return JSON.parse(fs.readFileSync(dump, 'utf8')); } catch { return null; } });
  assert.ok(names, 'the handler ran: ' + hostErr);
  for (const k of SECRET_NAMES) assert.ok(!names.includes(k), `${k} reached the handler`);
  for (const k of ['PATH', 'HOME', 'UW_SITE', 'UW_CACHE', 'UW_INTENT_ID', 'UW_JOB']) assert.ok(names.includes(k), `${k} is passed`);
  fs.rmSync(dump);

  // F19: DNS rebinding: Host and Origin are the attacker's name and agree with each other; still refused
  for (const ep of ['/__uw/health', '/__uw/events', '/__uw/jobs']) {
    const x = await req(port, { p: ep, headers: { Host: `evil.test:${port}` } });
    assert.equal(x.status, 403, `${ep} for a rebinding Host`);
  }
  x = await req(port, { method: 'POST', p: '/__uw/intent', body: intent('int_rebind_0001'), headers: { Host: `evil.test:${port}`, Origin: `http://evil.test:${port}`, 'Content-Type': 'application/json' } });
  assert.equal(x.status, 403); assert.match(x.json.reason, /not this computer/);
  // a page of this server, but a cross-origin caller: refused as before
  x = await req(port, { method: 'POST', p: '/__uw/intent', body: intent('int_cross_0001'), headers: { Host: own, Origin: 'https://evil.example', 'Content-Type': 'application/json' } });
  assert.equal(x.status, 403); assert.match(x.json.reason, /cross-origin/);
  assert.ok(!fs.existsSync(dump), 'no handler ran for a refused request');

  // static files: no wildcard CORS (any web page the user opens could read the site's data otherwise)
  x = await req(port, { p: '/map.config.json', headers: { Host: own } });
  assert.equal(x.status, 200);
  assert.equal(x.headers['access-control-allow-origin'], undefined);
  // a rebinding page is same-origin with the server, so the files themselves are refused for its Host too
  for (const p of ['/', '/map.config.json', '/bound.json', '/handlers/env_probe.mjs', '/data/', '/data/records/env_probe.json']) {
    x = await req(port, { p, headers: { Host: `evil.test:${port}`, Origin: `http://evil.test:${port}` } });
    assert.equal(x.status, 421, `${p} for a rebinding Host`);
    assert.doesNotMatch(x.body, /env_probe|intents/);
  }
});

test('uw serve: the site\'s files answer this computer and --public-url hosts, never a rebinding Host', async () => {
  const site = path.join(tmp, 'probe');
  if (!fs.existsSync(site)) assert.equal((await run(['new', 'probe', '--title', 'Probe', '--center', '121.52,25.05', '--zoom', '13'])).code, 0);
  const port = await freePort();
  const srv = spawn(process.execPath, [UW, 'serve', 'probe', '--port', String(port), '--quiet', '--public-url', 'https://map.example.org'], { cwd: tmp, env: { ...baseEnv(), HOME: path.join(tmp, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(srv);
  assert.ok(await waitFor(async () => (await req(port, { p: '/map.config.json', headers: { Host: `127.0.0.1:${port}` } })).status === 200), 'uw serve answers');
  for (const h of [`localhost:${port}`, 'map.example.org']) assert.equal((await req(port, { p: '/map.config.json', headers: { Host: h } })).status, 200, h);
  for (const p of ['/', '/map.config.json']) assert.equal((await req(port, { p, headers: { Host: `evil.test:${port}` } })).status, 421, p);
  srv.kill('SIGTERM');
});

test('uw serve --detach: the background server keeps no job credentials in its environment', async (t) => {
  const site = path.join(tmp, 'probe');
  if (!fs.existsSync(site)) assert.equal((await run(['new', 'probe', '--title', 'Probe', '--center', '121.52,25.05', '--zoom', '13'])).code, 0);
  const port = await freePort();
  const r = await run(['serve', 'probe', '--detach', '--port', String(port), '--json'], { ...JOB_SECRETS, UW_PROBE_PASSED: '1' });
  assert.equal(r.code, 0, r.err + r.out);
  const pid = r.json.pid;
  after(() => run(['serve', 'probe', '--stop']));
  const names = envNamesOf(pid);
  if (!names || !names.includes('PATH')) return t.skip('this OS does not show another process\'s environment');
  assert.ok(names.includes('UW_PROBE_PASSED'), 'UW_* reaches the server (the reading works)');
  for (const k of SECRET_NAMES) assert.ok(!names.includes(k), `${k} is in the detached server's environment`);
  const s = await run(['serve', 'probe', '--stop', '--json']);
  assert.equal(s.json.stopped, true);
});

// ---------------------------------------------------------------- F19: which Host may use __uw/*
test('hostRefusal: localhost, IP addresses, --public-url and Instafy tunnels/previews of this port; any other name is refused', async () => {
  const { hostRefusal, publicHostnames } = await lib('host-check.mjs');
  const home = path.join(tmp, 'fakehome');
  fs.mkdirSync(path.join(home, '.instafy'), { recursive: true });
  const o = { port: 4173, home, publicHosts: publicHostnames(['https://map.example.org'], {}) };
  for (const h of ['localhost:4173', '127.0.0.1:4173', '[::1]:4173', 'app.localhost:4173', '192.168.1.20:4173', 'map.example.org']) assert.equal(hostRefusal(h, o), null, h);
  for (const h of ['evil.test:4173', 'localhost.evil.test', '', undefined]) assert.notEqual(hostRefusal(h, o), null, String(h));
  assert.equal(hostRefusal('team.example', { ...o, publicHosts: publicHostnames([], { UW_PUBLIC_URL: 'team.example, other.example' }) }), null);
  // tunnels and private previews this port serves (recorded by the instafy CLI)
  const hex = '0123456789abcdef0123456789abcdef';
  const tunnel = 'feedfacefeedfacefeedfacefeedface.tunnel.test';
  const preview = `p-${'a'.repeat(26)}--${hex}.preview.test`;
  assert.notEqual(hostRefusal(tunnel, o), null); assert.notEqual(hostRefusal(preview, o), null);
  fs.writeFileSync(path.join(home, '.instafy', 'cli-tunnel-state.json'), JSON.stringify({ version: 1, tunnels: [{ hostname: tunnel, url: `https://${tunnel}`, localPort: 4173 }, { hostname: 'other.tunnel.test', localPort: 9999 }] }));
  // a preview entry without the domain it is viewed under (an older CLI) is never accepted: the id alone is not secret
  fs.writeFileSync(path.join(home, '.instafy', 'cli-preview-state.json'), JSON.stringify({ version: 1, previews: [{ previewId: '01234567-89ab-cdef-0123-456789abcdef', localPort: 4173 }] }));
  assert.notEqual(hostRefusal(preview, o), null, 'a preview recorded without its host suffix');
  fs.writeFileSync(path.join(home, '.instafy', 'cli-preview-state.json'), JSON.stringify({ version: 1, previews: [
    { previewId: '01234567-89ab-cdef-0123-456789abcdef', localPort: 4173, hostSuffix: 'preview.test' },
    { previewId: 'fedcba98-7654-3210-fedc-ba9876543210', localPort: 4173, hostSuffix: 'preview.example:8443' }] }));
  assert.equal(hostRefusal(tunnel, o), null);
  assert.equal(hostRefusal(preview, o), null);
  assert.equal(hostRefusal(`p-${'b'.repeat(26)}--fedcba9876543210fedcba9876543210.preview.example:8443`, o), null, 'the recorded port too');
  // DNS rebinding with a known preview id: the attacker's own domain (or port) under a capability-shaped first label
  for (const h of [`p-${'a'.repeat(26)}--${hex}.attacker.example:4173`, `p-${'a'.repeat(26)}--${hex}.preview.test.attacker.example`,
    `p-${'a'.repeat(26)}--${hex}.xpreview.test`, `p-${'a'.repeat(26)}--fedcba9876543210fedcba9876543210.preview.example:4173`,
    `p-${'a'.repeat(26)}--${hex}.preview.example:8443`, `p-short--${hex}.preview.test`]) {
    assert.notEqual(hostRefusal(h, o), null, h);
  }
  assert.notEqual(hostRefusal('other.tunnel.test', o), null, 'a tunnel of another port');
  assert.notEqual(hostRefusal(`p-${'a'.repeat(26)}--${'f'.repeat(32)}.preview.test`, o), null, 'a preview id this machine never opened');
  assert.notEqual(hostRefusal(preview, { ...o, port: 5000 }), null, 'the preview of another port');
});

// ---------------------------------------------------------------- F18: bind.js port adoption
test('bind.js: a MessagePort from a parent origin outside bind.parentOrigins (or from another window) is never adopted', async () => {
  const parent = { name: 'parent' };
  globalThis.window = { parent, addEventListener() {}, dispatchEvent() {} };
  try {
    const { Bind } = await eng('bind.js');
    const port = () => ({ started: false, onmessage: null, start() { this.started = true; }, postMessage() {} });
    const b = new Bind({ command() {} });
    b.changed = () => {}; b.sendV1 = () => {};
    b.parentOrigins = ['https://studio.example'];
    const warn = console.warn; console.warn = () => {};
    try {
      const evil = port();
      b.onWindowMessage({ data: { source: 'instafy-bind', type: 'hello' }, ports: [evil], source: parent, origin: 'https://evil.example' });
      assert.equal(b.port, undefined); assert.equal(evil.onmessage, null); assert.equal(b.listen.port, false);
      const other = port();
      b.onWindowMessage({ data: { source: 'instafy-host', type: 'hello' }, ports: [other], source: { name: 'some other frame' }, origin: 'https://studio.example' });
      assert.equal(b.port, undefined); assert.equal(other.onmessage, null);
    } finally { console.warn = warn; }
    // the allowed parent's port is adopted
    const ok = port();
    b.onWindowMessage({ data: { source: 'instafy-host', type: 'hello' }, ports: [ok], source: parent, origin: 'https://studio.example' });
    assert.equal(b.port, ok); assert.equal(typeof ok.onmessage, 'function'); assert.equal(b.listen.port, true);
  } finally { delete globalThis.window; }
});

// ---------------------------------------------------------------- F14: the select event's name
test('select event: the name the map shows (name_en unless labels are local), not the raw register name', async () => {
  const { selectPayload, featureName } = await eng('util.js');
  const L = { id: 'hotels', title: 'Hotels' };
  const f = { type: 'Feature', properties: { id: 'via-hotel-loft', name: '丰居旅店', name_en: 'Via Loft' } };
  assert.deepEqual({ ...selectPayload(L, f, 'en', 'via-hotel-loft'), feature: undefined }, { layer: 'hotels', id: 'via-hotel-loft', ref: 'hotels:via-hotel-loft', name: 'Via Loft', feature: undefined });
  assert.equal(selectPayload(L, f, 'local').name, '丰居旅店');
  assert.equal(selectPayload(L, { properties: { id: 'x' } }).name, 'Hotels');
  assert.equal(featureName({ name: 'Lore' }), 'Lore');
  const src = fs.readFileSync(path.join(ENGINE, 'engine.js'), 'utf8');
  assert.match(src, /E\.emit\('select', selectPayload\(L, f, /);
  assert.doesNotMatch(src, /E\.emit\('select', \{[^}]*name: f\.properties\.name\b/);
});

// ---------------------------------------------------------------- F16: Swedish
test('locale sv: tabs, the verdict and `uw question` phrases are Swedish; English stays the default', async () => {
  const { word } = await eng('util.js');
  assert.deepEqual(['places', 'layers', 'compare', 'verdict'].map((k) => word('sv', k)), ['Platser', 'Lager', 'Jämför', 'Omdöme']);
  assert.deepEqual(['places', 'layers', 'compare', 'verdict'].map((k) => word('en', k)), ['Places', 'Map key', 'Compare', 'Verdict']);
  assert.equal(word('de', 'compare'), 'Compare');
  const { Question } = await eng('question.js');
  const feats = [{ type: 'Feature', geometry: { type: 'Point', coordinates: [121.5, 25.05] }, properties: { id: 'a', name: 'Alpha', walk_min_mrt: 3 } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [121.51, 25.05] }, properties: { id: 'b', name: 'Beta', walk_min_mrt: 14 } }];
  const mk = (locale) => { const Q = new Question({ kind: 'choose-one', options: { layer: 'hotels', ids: ['a', 'b'] }, criteria: [{ key: 'walk_min_mrt', weight: 2 }] },
    { locale, metrics: { walk_min_mrt: { unit: 'min', better: 'lower', good: 3, bad: 15 } }, features: () => feats, percentile: () => null }); Q.resolve(); return Q; };
  assert.equal(mk('sv').personaLine().text, 'Bäst enligt dina vikter: A');
  assert.equal(mk(undefined).personaLine().text, 'Best by your weights: A');
  assert.equal(mk('sv').fmt('cafes_800m', 25), 'gott om (20+)');
  // the engine's tab labels and the compare row read the locale
  const src = fs.readFileSync(path.join(ENGINE, 'engine.js'), 'utf8');
  for (const k of ['places', 'layers', 'compare']) assert.match(src, new RegExp(`label: word\\(lc, '${k}'\\)`));
  // the verdict is said once, in the peek: Compare has no second verdict row
  assert.doesNotMatch(src, /cls: 'is-verdict'/);
  assert.match(src, /new Question\(qcfg, \{ locale: config\.locale/);
  // uw question's generated phrases
  const { makeCriterion } = await lib('cmd-question.mjs');
  const m = { walk_min_mrt: { unit: 'min' } };
  assert.equal(makeCriterion('walk_min_mrt', 2, m, 'sv').phrase.value, '{value} promenad till närmaste MRT');
  assert.equal(makeCriterion('walk_min_mrt', 2, m, 'sv').label, 'Promenad till närmaste MRT');
  assert.equal(makeCriterion('walk_min_mrt', 2, m).phrase.value, '{value} walk to the MRT');
  assert.equal(makeCriterion('cafes_800m', 1, {}, 'sv').phrase.value, '{n} kaféer i närheten');
  assert.equal(makeCriterion('cafes_800m', 1, {}, 'sv').label, 'Kaféer inom 800 m');
  assert.equal(makeCriterion('calm_night', 3, {}, 'sv').phrase.lead, 'tystast vid dörren på natten');
  // uw new --lang sets it; anything else is a usage error
  let r = await run(['new', 'sv-site', '--title', 'Vilket hotell?', '--center', '121.52,25.05', '--zoom', '13', '--lang', 'sv', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'sv-site', 'map.config.json'), 'utf8')).locale, 'sv');
  r = await run(['new', 'de-site', '--lang', 'de']);
  assert.notEqual(r.code, 0);
  r = await run(['validate', 'sv-site', '--json']);
  assert.ok(!JSON.stringify(r.json || r.out).includes('unknown key "locale"'), 'validate knows "locale"');
});

// ---------------------------------------------------------------- F23: the host shows the title
test('host shows the title: the question stays as a subtitle, an empty header collapses', () => {
  const css = fs.readFileSync(path.join(ENGINE, 'engine.css'), 'utf8');
  // the site title goes (the host bar shows it), the ask stays
  assert.match(css, /html\[data-uw-host-title="shown"\] \.uw-root \.uw-head \.uw-title:not\(\.is-ask\) \{ display: none !important; \}/);
  assert.match(css, /html\[data-uw-host-title="shown"\] \.uw-root \.uw-head \.uw-title\.is-ask \{[^}]*font-size: 14px/);
  assert.doesNotMatch(css, /html\[data-uw-host-title="shown"\] \.uw-root \.uw-head \.uw-title \{ display: none/);
  // a header with nothing left in it (no ask, no subtitle, no air pill) takes no room
  assert.match(css, /html\[data-uw-host-title="shown"\] \.uw-root \.uw-head:not\(:has\(\.uw-title\.is-ask, \.uw-sub:not\(\[hidden\]\):not\(:empty\), \.uw-air:not\(\[hidden\]\):not\(\.is-moved\)\)\) \{ display: none; \}/);
  // the ask is marked when it is not the site title
  const ui = fs.readFileSync(path.join(ENGINE, 'ui.js'), 'utf8');
  assert.match(ui, /this\.titleEl\.classList\.toggle\('is-ask', !!ask && String\(ask\)\.trim\(\) !== String\(this\.siteTitle \|\| ''\)\.trim\(\)\)/);
});
