// `uw snapshot` without a local Playwright: in Instafy it drives the runtime's own Playwright and Chromium, from the
// variables the runtime image sets for its tools (INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH or
// INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT, and PLAYWRIGHT_BROWSERS_PATH), the same ones `instafy preview check`
// reads. Offline: a fake Playwright package and fake browser files stand in, so no browser is needed.
// Run: node --test map-pack/tests/*.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE = pathToFileURL(path.join(HERE, '..', 'skills', 'interactive-map', 'scripts', 'lib', 'cmd-serve.mjs')).href;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'uw-engine-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// a Playwright whose own browser is missing (as with a version mismatch): only an explicit executablePath launches
const modules = path.join(tmp, 'engine', 'node_modules');
const fakePw = path.join(modules, 'playwright');
fs.mkdirSync(fakePw, { recursive: true });
fs.writeFileSync(path.join(fakePw, 'package.json'), JSON.stringify({ name: 'playwright', main: 'index.js' }));
fs.writeFileSync(path.join(fakePw, 'index.js'), `exports.chromium = {
  executablePath: () => '/nope/chrome',
  launch: async (o) => {
    if (o.channel) throw new Error('channel ' + o.channel + ' is not installed');
    if (!o.executablePath) throw new Error("browserType.launch: Executable doesn't exist at /nope/chrome");
    if (o.executablePath.includes('1229')) throw new Error('crashed');
    return { launchedWith: o.executablePath, args: o.args, close: async () => {} };
  },
};`);
// two headless-shell builds: the newer one crashes, the older one launches
const browsers = path.join(tmp, 'browsers');
const shell = (build) => {
  const file = path.join(browsers, `chromium_headless_shell-${build}`, 'chrome-linux', 'headless_shell');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
};
shell('1229');
const working = shell('1228');

// a fresh process in a folder with no node_modules above it, so only the runtime's engine can supply Playwright
function run(env) {
  const cwd = path.join(tmp, 'ws');
  fs.mkdirSync(cwd, { recursive: true });
  const script = `const m = await import(${JSON.stringify(SERVE)});
try { const pw = await m.loadPlaywright(); const b = await m.launchChromium(pw); console.log(JSON.stringify({ ok: true, b })); }
catch (e) { console.log(JSON.stringify({ ok: false, notFound: !!e.notFound, message: e.message })); }`;
  const clean = { ...process.env };
  for (const key of ['UW_PLAYWRIGHT', 'UW_BROWSER_CHANNEL', 'NODE_PATH', 'INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH',
    'INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT', 'PLAYWRIGHT_BROWSERS_PATH']) delete clean[key];
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd, env: { ...clean, ...env }, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const localPlaywright = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(SERVE)}).then(async (m) => { try { await import('playwright'); console.log('yes'); } catch { console.log('no'); } })`], { encoding: 'utf8', cwd: tmp }).stdout.trim() === 'yes';
const skip = localPlaywright && 'a Playwright resolves next to the pack';

test("no local Playwright: the runtime's declared Playwright supplies it and its Chromium launches (skipping one that fails)", { skip }, () => {
  for (const env of [
    { INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH: fakePw, PLAYWRIGHT_BROWSERS_PATH: browsers },
    { INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT: modules, PLAYWRIGHT_BROWSERS_PATH: browsers },
  ]) {
    const out = run(env);
    assert.equal(out.ok, true, out.message);
    assert.equal(out.b.launchedWith, working);
    assert.ok(out.b.args.includes('--disable-dev-shm-usage'), 'the container flag rides along');
    assert.ok(out.b.args.includes('--use-angle=swiftshader'), "and the pack's software-GL flags stay");
  }
});

test('outside a runtime, or with a declared path that holds no Playwright: "not found" (snapshot exits 3, SKIPPED)', { skip }, () => {
  const none = run({});
  assert.equal(none.ok, false); assert.equal(none.notFound, true);
  assert.match(none.message, /not in an Instafy runtime/);
  const wrong = run({ INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH: 'relative/playwright' });
  assert.equal(wrong.notFound, true);
  assert.match(wrong.message, /not an absolute path to a playwright package/);
  const empty = run({ INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT: path.join(tmp, 'ws') });
  assert.equal(empty.notFound, true);
  assert.match(empty.message, /no playwright in \$INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT/);
});

test("UW_PLAYWRIGHT still wins over the runtime's Playwright", { skip }, () => {
  const other = path.join(tmp, 'other', 'playwright');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'playwright', main: 'index.js' }));
  fs.writeFileSync(path.join(other, 'index.js'), `exports.chromium = { launch: async (o) => ({ launchedWith: 'mine', close: async () => {} }) };`);
  const out = run({ UW_PLAYWRIGHT: other, INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH: fakePw, PLAYWRIGHT_BROWSERS_PATH: browsers });
  assert.equal(out.b.launchedWith, 'mine');
});

test('SKILL.md: one `instafy preview open --start` serves the map and shows its card, then `instafy preview check`; the file stays ≤ 9.5 KB', () => {
  const md = fs.readFileSync(path.join(HERE, '..', 'skills', 'interactive-map', 'SKILL.md'), 'utf8');
  const flat = md.replace(/\s+/g, ' ');
  const open = flat.indexOf('instafy preview open --title "<title>" --serve-cmd "uw host . --port {port}" --start --json');
  const check = flat.indexOf('instafy preview check --port <port>');
  assert.ok(open > 0 && check > open, 'the check follows the card');
  assert.match(flat.slice(check, check + 200), /fix every error it lists; open the PNG/);
  // The CLI picks the port, so none is named; and no sentence points at a card the turn may not have posted.
  assert.doesNotMatch(md, /--port 4173|free port|Open it from the card/);
  // the managed copy adds a ~350-byte note (scripts/sync-map-pack.mjs); keep both inside the prompt budget
  assert.ok(Buffer.byteLength(md) <= 9.5 * 1024 - 400, `${Buffer.byteLength(md)} bytes`);
});
