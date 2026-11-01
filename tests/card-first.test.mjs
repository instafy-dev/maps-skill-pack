// The card comes first: a map turn posts its preview card right after `uw new` writes the site, before any lookup, so
// a slow lookup can cost the map content but never its card (a "3 days in Lisbon" turn ended while `uw stay` still ran,
// before the step that posted the card, and told the person to open a map no card showed). The last step only
// refreshes what the card shows. Offline: nothing here reaches the network.
// Run: node --test tests/card-first.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const { cardCommand } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'cmd-site.mjs')).href);
const { unplacedSightsAdvice } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'cmd-handoff.mjs')).href);
const flat = (f) => fs.readFileSync(path.join(SKILL, f), 'utf8').replace(/\s+/g, ' ');
const OPEN = 'instafy preview open --title "<title>" --serve-cmd "uw host <site> --port {port}" --start --json';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-card-'));
const servers = [];
after(() => {
  for (const p of servers) if (p.exitCode === null) p.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('SKILL.md: the card right after `uw new`, before any lookup; step 9 only refreshes it', () => {
  const md = flat('SKILL.md');
  const step3 = md.indexOf('3. `uw new <site>');
  const open = md.indexOf(OPEN);
  const step4 = md.indexOf('4. `uw add-point <site>');
  assert.ok(step3 > 0 && open > step3 && open < step4, `the card command is in step 3 (${step3} < ${open} < ${step4})`);
  assert.equal(md.indexOf(OPEN, open + 1), -1, 'one card command');
  // every lookup comes after it (step 2's geocode gives the centre `uw new` needs)
  for (const cmd of ['uw add-point <site>', 'uw places <site>', 'uw enrich <site>', 'uw question <site>']) {
    assert.ok(md.indexOf(cmd) > open, `${cmd} after the card`);
  }
  assert.match(md.slice(step3, step4), /before any lookup \(a slow one costs content, never the card\)/);
  // step 9: open viewers update, then the check refreshes the card's picture. The check pictures only its desktop
  // size, so a phone-only check (--phone) leaves the card on the empty map step 3 posted
  const step9 = md.indexOf('9. `uw reload <site>` (open viewers update), then `instafy preview check --port <port>` (the JSON');
  assert.ok(step9 > step4, 'step 9 reloads the viewers and checks the page');
  assert.match(md.slice(step9, step9 + 260), /refreshes the card's picture\): fix every error it lists; open the PNGs it names/);
  assert.doesNotMatch(md, /instafy preview check[^.]*--phone/);
  assert.doesNotMatch(md, /Open it from the card|open it from the card/);
});

test('itinerary.md: a trip posts its card right after `uw new` too, before the stations, stays and the team job', () => {
  const md = flat('reference/itinerary.md');
  const created = md.indexOf('`uw new <site> --title "<Country> by train"');
  const card = md.indexOf('Then its card at once (SKILL.md step 3), before any lookup');
  assert.ok(created > 0 && card > created && card < md.indexOf('**2. One station per stop**'), 'the card is step 1');
  assert.ok(md.indexOf('the card (step 3), step 9 and the turn clock stay') > 0);
  // step 6 and the team job refresh it, they never post it
  assert.match(md, /Then SKILL\.md step 9 \(open viewers update, the card's picture is refreshed\), before Phase B/);
  assert.doesNotMatch(md, /Then preview \(SKILL\.md step 9\)|Open the preview while it runs/);
  // a later change to a trip refreshes the card too
  assert.match(md, /## Later changes to a trip [^#]*?then `uw validate`, SKILL\.md step 9, the reply\./);
});

// A trip turn replied after three minutes with one sight in three days and "I'm sending the browser to gather two more
// sights", and no browser step followed. Phase B's sights are this turn's own: read with `uw cite`, never handed on.
test('itinerary.md Phase B: sights come from `uw cite` in this turn, never from a browser card', () => {
  const md = flat('reference/itinerary.md');
  const phaseB = md.slice(md.indexOf('## Phase B'), md.indexOf('1. **Sights with sources'));
  assert.match(phaseB, /add sights rather than reply\. Sights come from `uw cite` in this turn, never from a browser card\./);
});

// A "3 days in Seville" turn put three sight lookups and `uw plan` in one command, twice. A slow lookup outlasted the
// command, so the sights after it and the plan never ran: one sight, no Plan tab, and a reply with minutes left. Its
// command tool answered a lookup still running with a session and no exit code, which is an answer but not the end:
// the plan waits for each lookup's exit code, and a lookup still running is waited on, never started again.
test('itinerary.md Phase B: one `uw add-point` per command, then the plan once each has finished, with the sights that landed', () => {
  const md = flat('reference/itinerary.md');
  const step1 = md.slice(md.indexOf('1. **Sights with sources'), md.indexOf('2. **Train times**'));
  assert.match(step1, /Then each sight in a command of its own, one `uw add-point` per command \(chained, one slow lookup held back the sights after it and the plan\):/);
  assert.match(step1, /Once each has finished \(an exit code, not still running: wait on one that is, never start it again; `uw plan` and `uw validate` name any still running\), `uw plan … --sights sights,food,daytrips --force` with the sights that landed \(the layers that exist; one not found stays out, in the reply's unverified line\)/);
  assert.doesNotMatch(step1, /has answered/);
  // the example is one lookup: no second one and no plan in its block
  const open = step1.indexOf('```'), block = step1.slice(open, step1.indexOf('```', open + 3));
  assert.equal((block.match(/uw add-point/g) || []).length, 1, block);
  assert.doesNotMatch(block, /uw plan|&&|;\s*uw /);
  // a team's unplaced sights are run the same way, in the guide and in the report the model acts on
  assert.match(md, /come with their exact commands: run them, one per command \(then, once each has finished, `uw plan … --force`\), before the reply/);
  const advice = unplacedSightsAdvice(2);
  assert.match(advice, /^2 sourced sight\(s\) are not on the map because the place lookup was unavailable\. Wait a minute, then run each in a command of its own, and once each has finished \(an exit code, not still running\) uw plan … --force, before replying when the turn clock allows/);
  assert.doesNotMatch(advice, /run these/);
});

test('uw new names the card command as the next step, with the site\'s path, before the trip or option steps', () => {
  const r = spawnSync(process.execPath, [UW, 'new', 'lx', '--title', 'Lisbon in 3 days', '--center', '-9.1393,38.7107', '--zoom', '13', '--expect', 'Lisbon:3'],
    { cwd: tmp, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  const card = lines.findIndex((l) => l === 'Next, at once: its card: instafy preview open --title "Lisbon in 3 days" --serve-cmd "uw host lx --port {port}" --start --json');
  const trip = lines.findIndex((l) => l.startsWith('Then: a trip (Lisbon (3 nights))'));
  assert.ok(card > 0 && trip > card, r.stdout);
  const plain = spawnSync(process.execPath, [UW, 'new', 'cafes', '--title', 'Cafés', '--center', '-9.1393,38.7107'], { cwd: tmp, encoding: 'utf8' });
  assert.match(plain.stdout, /Next, at once: its card: instafy preview open --title "Cafés" --serve-cmd "uw host cafes --port \{port\}" .*\nThen \(SKILL\.md procedure step 4\): uw add-point cafes/);
});

test('cardCommand: the title and the site\'s path stay one word each for the shell', () => {
  assert.equal(cardCommand("Lisbon's best", 'sites/lisbon'), `instafy preview open --title "Lisbon's best" --serve-cmd "uw host sites/lisbon --port {port}" --start --json`);
  assert.equal(cardCommand('Under $600 "deals"', 'sites/deals'), `instafy preview open --title 'Under $600 "deals"' --serve-cmd "uw host sites/deals --port {port}" --start --json`);
  assert.equal(cardCommand("It's $5"), `instafy preview open --title 'It'\\''s $5' --serve-cmd "uw host . --port {port}" --start --json`);
  // a path with a space is one word of the serve command, quoted the way instafy preview open splits it
  assert.equal(cardCommand('Cafés', 'sites/my cafés'), `instafy preview open --title "Cafés" --serve-cmd "uw host 'sites/my cafés' --port {port}" --start --json`);
});

// A "3 days in Seville" turn ran `uw new sites/seville-3-days … && instafy preview open … --serve-cmd "uw host . --port
// {port}"` as one command from the space's folder, as step 3 said ("from the site's folder"): `.` was the whole space,
// and its card opened a list of the space's files (sites/, AGENTS.md, CLAUDE.md …). The check passed it, since the
// server answered that list as a page. The card's command now names the site's path, so it serves the map from the
// folder `uw new` ran in, and a folder with no index.html answers 404 (which `instafy preview check` reports as a
// problem), never a list of its files.
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
/** `--serve-cmd` as argv, split the way `instafy preview open` splits it (words; '…' kept whole) */
const words = (cmd) => [...cmd.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]);
/** run a serve command (with `uw` this pack's) from `cwd` on a free port; resolves once it answers */
async function serve(cmd, cwd) {
  const port = await freePort();
  const [prog, ...args] = words(cmd.replace('{port}', String(port)));
  assert.equal(prog, 'uw');
  const env = { ...process.env, UW_NO_CACHE: '1' };
  for (const k of ['INSTAFY_CACHE_DIR', 'INSTAFY_WORKSPACE_DIR', 'WORKSPACE_DIR']) delete env[k];
  const p = spawn(process.execPath, [UW, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(p);
  let log = ''; p.stdout.on('data', (d) => { log += d; }); p.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' }); return { port, stop: () => p.kill('SIGTERM') }; } catch { /* not up yet */ }
    if (p.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${cmd} did not answer: ${log}`);
}
const get = async (port, p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { redirect: 'manual' }); return { status: r.status, type: r.headers.get('content-type') || '', body: await r.text() }; };

test('the card\'s command, run from the space\'s folder, serves the map; the space\'s folder itself answers 404, never a list of its files', async () => {
  const space = fs.mkdtempSync(path.join(tmp, 'space-'));
  for (const f of ['AGENTS.md', 'AGENTS.py', 'CLAUDE.md', 'INSTAFY.md']) fs.writeFileSync(path.join(space, f), `${f}\n`);
  fs.mkdirSync(path.join(space, 'sites', 'other-page'), { recursive: true });
  fs.writeFileSync(path.join(space, 'sites', 'other-page', 'notes.txt'), 'another chat\'s page\n');
  const made = spawnSync(process.execPath, [UW, 'new', 'sites/seville', '--title', 'Three days in Seville', '--center', '-5.99534,37.38863', '--zoom', '13', '--expect', 'Seville:3'],
    { cwd: space, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const next = made.stdout.split('\n').find((l) => l.startsWith('Next, at once: its card: '));
  const cmd = /--serve-cmd "([^"]+)" --start --json$/.exec(next || '')?.[1];
  assert.equal(cmd, 'uw host sites/seville --port {port}', made.stdout);

  // the card's own command, from the folder the turn ran `uw new` in: the map, and nothing outside its folder
  const map = await serve(cmd, space);
  const page = await get(map.port, '/');
  assert.equal(page.status, 200);
  assert.match(page.type, /^text\/html/);
  assert.equal(page.body, fs.readFileSync(path.join(space, 'sites', 'seville', 'index.html'), 'utf8'));
  assert.equal(JSON.parse((await get(map.port, '/map.config.json')).body).title, 'Three days in Seville');
  for (const p of ['/AGENTS.md', '/sites/other-page/notes.txt', '/..%2FAGENTS.md']) assert.ok([403, 404].includes((await get(map.port, p)).status), p);
  map.stop();

  // the old command from the same folder serves the whole space: its folder answers 404, its subfolders too (no
  // redirect that names them), and the map is only where it lives
  const whole = await serve('uw host . --port {port}', space);
  for (const p of ['/', '/sites', '/sites/', '/sites/other-page/']) {
    const r = await get(whole.port, p);
    assert.equal(r.status, 404, `${p}: ${r.status} ${r.body.slice(0, 200)}`);
    // no list: no other file or folder of the space is named (the 404 names only the path asked for)
    assert.doesNotMatch(r.body, /AGENTS|CLAUDE|INSTAFY|seville|notes\.txt|</, p);
  }
  assert.equal((await get(whole.port, '/sites/seville/')).status, 200);
  whole.stop();

  // `uw serve` is the same server: a folder is its index.html or a 404
  const plain = await serve('uw serve . --port {port}', space);
  assert.equal((await get(plain.port, '/')).status, 404);
  assert.equal((await get(plain.port, '/sites/seville/')).status, 200);
  plain.stop();
});
