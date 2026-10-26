// `uw host` is the save owner of what it writes for clicks (scripts/lib/save-owner.mjs, the same module as
// instafy-bind's). In an Instafy space's checkout (`.instafy/.git` above the site) it commits data/version.json and
// the records it applied, so the space's next save publishes them and a stop never keeps them as "unsaved work".
// Outside a space it commits nothing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UW = path.join(HERE, '..', 'skills', 'interactive-map', 'scripts', 'uw.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'uw-save-owner-')));
const children = [];
after(async () => {
  for (const c of children) try { c.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const baseEnv = () => ({ ...process.env, UW_CACHE: path.join(tmp, 'cache'), UW_TURN_BUDGET: '0', HOME: path.join(tmp, 'home') });
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 100)); } };
const req = (port, { method = 'GET', p = '/', headers = {}, body } = {}) => new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
    let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  r.on('error', (e) => resolve({ status: 0, error: e.message }));
  if (body) r.write(body);
  r.end();
});
const git = (space, args) => {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  const r = spawnSync('git', ['--git-dir', path.join(space, '.instafy', '.git'), '--work-tree', space, ...args], { cwd: space, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

async function hostedClick(space, siteName) {
  assert.equal(spawnSync(process.execPath, [UW, 'new', siteName, '--title', 'Probe', '--center', '121.52,25.05', '--zoom', '13', '--json'], { cwd: space, env: baseEnv(), encoding: 'utf8' }).status, 0);
  const site = path.join(space, siteName);
  fs.mkdirSync(path.join(site, 'handlers'), { recursive: true });
  fs.writeFileSync(path.join(site, 'handlers', 'noop.mjs'), `import fs from 'node:fs';\nfs.readFileSync(0, 'utf8');\nprocess.stdout.write(JSON.stringify({ type: 'done', summary: 'ok' }) + '\\n');\n`);
  fs.writeFileSync(path.join(site, 'bound.json'), JSON.stringify({ version: 1, intents: { noop: {
    label: 'Noop', params: { type: 'object', additionalProperties: false, properties: {} }, ui: ['card-more'],
    target: { records: 'data/records/noop.json' }, timeout_s: 20, handler: 'handlers/noop.mjs' } }, results: { files: ['data/records/noop.json'] } }, null, 2));
  return site;
}

async function runHost(space, siteName, click, extra = []) {
  const port = await freePort();
  const host = spawn(process.execPath, [UW, 'host', siteName, '--port', String(port), '--no-warm', ...extra], { cwd: space, env: baseEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(host);
  let err = ''; host.stderr.on('data', (d) => { err += d; });
  const own = `127.0.0.1:${port}`;
  assert.ok(await waitFor(async () => (await req(port, { p: '/__uw/health', headers: { Host: own } })).status === 200), 'uw host answers: ' + err);
  if (click) {
    const body = JSON.stringify({ source: 'instafy-map', v: 2, type: 'intent', id: 'int_save_0001', name: 'noop', params: {} });
    const x = await req(port, { method: 'POST', p: '/__uw/intent', body, headers: { Host: own, Origin: `http://${own}`, 'Content-Type': 'application/json' } });
    assert.equal(x.status, 202, x.body);
  }
  return { host, err: () => err };
}

test('uw host commits what it wrote for a click in a space checkout; the site files it did not write stay changed', async () => {
  const space = path.join(tmp, 'space');
  fs.mkdirSync(space, { recursive: true });
  spawnSync('git', ['init', '-q', '--bare', path.join(space, '.instafy', '.git')]);
  git(space, ['config', 'core.bare', 'false']);
  git(space, ['config', 'user.name', 'Instafy Studio']);
  git(space, ['config', 'user.email', 'studio@instafy.dev']);
  fs.writeFileSync(path.join(space, '.gitignore'), '.instafy/\n.uwcache/\n');
  const site = await hostedClick(space, 'probe');
  git(space, ['add', '-A']);
  git(space, ['commit', '-q', '-m', 'instafy: init']);
  // a person's unsaved edit to the page: never the host's to save
  fs.appendFileSync(path.join(site, 'index.html'), '\n<!-- draft -->\n');

  const { host, err } = await runHost(space, 'probe', true);
  const saved = await waitFor(() => git(space, ['log', '--format=%s']).split('\n').includes('Save what the probe map recorded'), 15000);
  assert.ok(saved, 'the host committed its writes: ' + err());
  await waitFor(() => !git(space, ['status', '--porcelain']).includes('data/version.json'), 30000);
  host.kill('SIGTERM');
  await new Promise((r) => host.once('close', r));
  const left = git(space, ['status', '--porcelain']).split('\n').filter(Boolean);
  assert.deepEqual(left, [' M probe/index.html'], 'only the person\'s own edit is left as a change');
  const files = git(space, ['log', '--name-only', '--format=', '--grep', 'Save what the probe map recorded']).split('\n').filter(Boolean);
  assert.ok(files.includes('probe/data/version.json'));
  assert.ok(!files.includes('probe/index.html'));
});

test('outside a space uw host commits nothing (a person\'s own repository stays theirs)', async () => {
  const own = path.join(tmp, 'own');
  fs.mkdirSync(own, { recursive: true });
  spawnSync('git', ['init', '-q', own]);
  spawnSync('git', ['-C', own, 'config', 'user.email', 'me@example.com']);
  spawnSync('git', ['-C', own, 'config', 'user.name', 'Me']);
  await hostedClick(own, 'probe');
  spawnSync('git', ['-C', own, 'add', '-A']);
  spawnSync('git', ['-C', own, 'commit', '-q', '-m', 'mine']);
  const { host } = await runHost(own, 'probe', true);
  await new Promise((r) => setTimeout(r, 2500));
  host.kill('SIGTERM');
  await new Promise((r) => host.once('close', r));
  assert.equal(spawnSync('git', ['-C', own, 'log', '--format=%s'], { encoding: 'utf8' }).stdout.trim(), 'mine');
});

test('uw host --no-save leaves what it wrote as changed files, as instafy bind serve --no-save does', async () => {
  const space = path.join(tmp, 'nosave');
  fs.mkdirSync(space, { recursive: true });
  spawnSync('git', ['init', '-q', '--bare', path.join(space, '.instafy', '.git')]);
  git(space, ['config', 'core.bare', 'false']);
  git(space, ['config', 'user.name', 'Instafy Studio']);
  git(space, ['config', 'user.email', 'studio@instafy.dev']);
  fs.writeFileSync(path.join(space, '.gitignore'), '.instafy/\n.uwcache/\n');
  await hostedClick(space, 'probe');
  git(space, ['add', '-A']);
  git(space, ['commit', '-q', '-m', 'instafy: init']);
  const { host, err } = await runHost(space, 'probe', true, ['--no-save']);
  const changed = await waitFor(() => git(space, ['status', '--porcelain']).includes('probe/data/version.json'), 15000);
  assert.ok(changed, 'the click wrote data/version.json: ' + err());
  await new Promise((r) => setTimeout(r, 3000));
  host.kill('SIGTERM');
  await new Promise((r) => host.once('close', r));
  assert.deepEqual(git(space, ['log', '--format=%s']).split('\n').filter(Boolean), ['instafy: init']);
  assert.ok(git(space, ['status', '--porcelain']).includes('probe/data/version.json'));
});
