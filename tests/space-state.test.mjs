// In an Instafy space the runtime gives each turn a folder of the space's own, outside its files, that outlasts the
// turn (INSTAFY_CACHE_DIR). uw keeps a site's working state there (the background server's record and log, the write
// lock, the turn clock, the shared cache) and the jobs a folder starts, so no .uwcache/ lands in the space's files.
// And a map's preview can be started again by the space: `uw host --detach` prints the command for
// `instafy preview open --serve-cmd`, and a server the space started with it (without INSTAFY_CACHE_DIR) is found and
// reused by the next `uw host --detach`, `uw reload` and `--stop`. Offline: nothing here asks a service.
// Run: node --test tests/space-state.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'skills', 'interactive-map', 'scripts');
const UW = path.join(SCRIPTS, 'uw.mjs');
const lib = (f) => import(pathToFileURL(path.join(SCRIPTS, 'lib', f)).href);
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'uw-space-')));
const work = path.join(tmp, 'workspace');
const spaceCache = path.join(tmp, 'space-cache');
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(spaceCache, { recursive: true, mode: 0o700 });
const started = []; // processes this test started itself
after(() => {
  for (const p of started) { try { if (p.exitCode === null) p.kill('SIGTERM'); } catch {} }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const baseEnv = () => { const e = { ...process.env, UW_NO_CACHE: '1', UW_CACHE: '' }; delete e.UW_CACHE; delete e.INSTAFY_CACHE_DIR; return e; };
const inSpace = () => ({ ...baseEnv(), INSTAFY_CACHE_DIR: spaceCache });
const uw = (args, env = inSpace()) => new Promise((resolve) => {
  const p = spawn(process.execPath, [UW, ...args], { cwd: work, env });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => { let json = null; try { json = JSON.parse(out); } catch {} resolve({ code, out, err, json }); });
});
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const answers = async (port) => { try { return (await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' })).status < 500; } catch { return false; } };
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
/** one simple command as argv, the way `instafy preview open --serve-cmd` reads it (words, '…' and "…" quoting) */
function argvOf(cmd) {
  const out = []; let cur = '', q = null, any = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') { if (c === '"') q = null; else if (c === '\\') cur += cmd[++i]; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; any = true; continue; }
    if (/\s/.test(c)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    assert.ok(!/[|&;<>()$`*?\[\]{}~]/.test(c), `shell syntax in ${cmd}`);
    cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map(String) : []);

test('in a space, a site keeps no .uwcache/ of its own: the state, the jobs and the lock live in the space\'s folder', async () => {
  assert.equal((await uw(['new', 'lx', '--title', 'Lisbon', '--center', '-9.14,38.71', '--zoom', '13'])).code, 0);
  // a write under the site lock and a network command's turn clock (a user-given point: no lookup)
  const a = await uw(['add-point', 'lx', '--layer', 'sights', '--at', '-9.1335,38.7139', '--name', 'Castelo de São Jorge', '--id', 'castelo']);
  assert.equal(a.code, 0, a.err);
  // a background job started from the workspace
  const j = await uw(['fit', 'lx', '--detach', '--json']);
  assert.equal(j.code, 0, j.err);
  const w = await uw(['wait', '--max', '20']);
  assert.equal(w.code, 0, w.out + w.err);
  const port = await freePort();
  const h = await uw(['host', 'lx', '--detach', '--port', String(port), '--json']);
  assert.equal(h.code, 0, h.err);
  try {
    assert.ok(!fs.existsSync(path.join(work, 'lx', '.uwcache')), 'nothing in the site folder');
    assert.ok(!fs.existsSync(path.join(work, '.uwcache')), 'no jobs folder in the workspace');
    const state = walk(path.join(spaceCache, 'interactive-map', 'state'));
    assert.ok(state.some((f) => /^lx-[0-9a-f]{16}\/serve\.json$/.test(f)), state.join(', '));
    assert.ok(state.some((f) => /^lx-[0-9a-f]{16}\/turn\.json$/.test(f)), state.join(', '));
    assert.ok(state.some((f) => /^workspace-[0-9a-f]{16}\/jobs\/fit-.+\.json$/.test(f)), state.join(', '));
    // the site still ignores .uwcache/ for a process that has no space folder
    assert.match(fs.readFileSync(path.join(work, 'lx', '.gitignore'), 'utf8'), /^\.uwcache\/$/m);
  } finally {
    assert.equal((await uw(['host', 'lx', '--stop'])).code, 0);
  }
  assert.ok(!(await answers(port)));
  // outside a space: the folder's own .uwcache/, as before
  const local = await uw(['add-point', 'lx', '--layer', 'sights', '--at', '-9.1334,38.7099', '--name', 'Sé de Lisboa', '--id', 'se'], baseEnv());
  assert.equal(local.code, 0, local.err);
  assert.ok(fs.existsSync(path.join(work, 'lx', '.uwcache', 'turn.json')));
});

test('the preview card can start the map again: --serve-cmd from host --detach, and the restarted server is this site\'s', async () => {
  const port = await freePort();
  const h = await uw(['host', 'lx', '--detach', '--port', String(port), '--json']);
  assert.equal(h.code, 0, h.err);
  assert.match(h.json.preview_cmd, new RegExp(`^instafy preview open --port ${port} --title "Lisbon" --serve-cmd ".+" --json$`));
  assert.ok(h.json.preview_cmd.includes(`--serve-cmd "${h.json.serve_cmd}"`));
  assert.match(h.out + h.err, /--serve-cmd/);
  const argv = argvOf(h.json.serve_cmd);
  assert.deepEqual(argv.slice(-6), ['host', path.join(work, 'lx'), '--port', String(port), '--host', '127.0.0.1']);
  // a request that names another host (a tunnel's, a LAN name) is not told which folder or process this is
  const hdr = async (host) => new Promise((resolve) => { const r = http.request({ host: '127.0.0.1', port, path: '/', method: 'HEAD', headers: { host } }, (res) => { res.resume(); resolve(res.headers); }); r.end(); });
  assert.ok((await hdr(`127.0.0.1:${port}`))['x-uw-folder']);
  assert.equal((await hdr('p-abc--x.preview.example'))['x-uw-folder'], undefined);
  // the server stops (the space slept, or someone stopped it)
  assert.equal((await uw(['host', 'lx', '--stop'])).code, 0);
  assert.ok(await until(async () => !(await answers(port))));
  // the space starts it again from the recorded command, with only a plain environment (from wherever the card
  // was opened: here the site folder itself)
  const plain = { PATH: process.env.PATH, HOME: tmp, WORKSPACE_DIR: work };
  const p = spawn(argv[0], argv.slice(1), { cwd: path.join(work, 'lx'), env: plain, stdio: 'ignore' });
  started.push(p);
  assert.ok(await until(() => answers(port)), 'the recorded command serves the site again');
  // the next turn (with the space folder) finds that server: it keeps its own record (in the site's .uwcache/, the
  // only state folder it knows), so reload reaches its viewers
  const rl = await uw(['reload', 'lx', '--json']);
  assert.equal(rl.json?.host?.port, port, rl.out + rl.err);
  assert.equal(rl.json.host.live, true);
  // and with no record at all (an older pack's server, a record lost) it is still this site's server, not a busy port
  fs.rmSync(path.join(work, 'lx', '.uwcache', 'serve.json'));
  const again = await uw(['host', 'lx', '--detach', '--port', String(port), '--json']);
  assert.equal(again.code, 0, again.err);
  assert.equal(again.json.reused, true);
  assert.equal(again.json.pid, p.pid);
  assert.equal((await uw(['host', 'lx', '--stop'])).code, 0);
  assert.ok(await until(() => p.exitCode !== null), 'stopped');
  // a server of another folder on the port is still a busy port
  fs.mkdirSync(path.join(work, 'other'), { recursive: true });
  fs.writeFileSync(path.join(work, 'other', 'index.html'), '<!doctype html><title>x</title>');
  const o = spawn(process.execPath, [UW, 'serve', 'other', '--port', String(port), '--quiet'], { cwd: work, env: plain, stdio: 'ignore' });
  started.push(o);
  assert.ok(await until(() => answers(port)));
  const busy = await uw(['host', 'lx', '--detach', '--port', String(port)]);
  assert.notEqual(busy.code, 0);
  assert.match(busy.err, /port \d+ is in use by another server/);
  o.kill('SIGTERM');
});

test('serveCommand: uw when the shell finds this pack\'s uw, else node and the pack\'s uw.mjs; quoted, never shell syntax', async () => {
  const { serveCommand } = await lib('cmd-serve.mjs');
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const site = path.join(work, 'my maps', 'lx');
  const without = serveCommand('host', site, { port: 4173, host: '0.0.0.0' }, { env: { PATH: '/usr/bin:/bin' } });
  assert.equal(argvOf(without)[1], path.join(SCRIPTS, 'uw.mjs'));
  assert.deepEqual(argvOf(without).slice(2), ['host', site, '--port', '4173', '--host', '0.0.0.0']);
  // the runtime's shim for this pack
  fs.writeFileSync(path.join(bin, 'uw'), `#!/bin/sh\n# instafy:managed-pack-bin interactive-map 0.1.4\nexec node '${path.join(SCRIPTS, 'uw.mjs')}' "$@"\n`, { mode: 0o755 });
  const withShim = serveCommand('host', site, { port: 4173, host: '0.0.0.0', extra: ['--no-save'] }, { env: { PATH: `${bin}:/usr/bin:/bin` } });
  assert.equal(withShim, `uw host '${site}' --port 4173 --host 0.0.0.0 --no-save`);
  // another program called uw is not this pack
  fs.writeFileSync(path.join(bin, 'uw'), '#!/bin/sh\necho something else\n', { mode: 0o755 });
  assert.notEqual(argvOf(serveCommand('host', site, { port: 4173, host: '0.0.0.0' }, { env: { PATH: `${bin}:/usr/bin` } }))[0], 'uw');
});

test('datasets an adapter downloads are kept in the space\'s folder too (the cache every site shares)', async () => {
  const { uwCacheRoot } = await lib('cmd-adapter.mjs');
  const keep = { UW_CACHE: process.env.UW_CACHE, INSTAFY_CACHE_DIR: process.env.INSTAFY_CACHE_DIR };
  try {
    delete process.env.UW_CACHE;
    process.env.INSTAFY_CACHE_DIR = spaceCache;
    assert.equal(uwCacheRoot(), path.join(spaceCache, 'interactive-map'));
    process.env.UW_CACHE = path.join(tmp, 'mine');
    assert.equal(uwCacheRoot(), path.join(tmp, 'mine'), 'an explicit UW_CACHE wins');
  } finally {
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
