// Follow-up turns on a trip (human-trip run, 2026-10-16): a youth hostel the register files as a hotel was shown as
// "Hotel"; the validator's "unsourced day text" nudge made the agent copy each day text into a prose item, which went
// stale on the next rewrite; the departure day's own plan text was flagged, so the agent deleted it; and when the
// rail track did not load, nothing said how to put the arcs back on it. Offline: no network is used.
// Run: node --test map-pack/tests/follow-ups.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const lib = (f) => import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', f)).href);
const { stayKind, rankStays } = await lib('cmd-stay.mjs');
const { isPlanSkeletonText } = await lib('cmd-plan.mjs');
const { railRetryCommands } = await lib('cmd-handoff.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-followups-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const uw = (args) => new Promise((resolve) => {
  const env = { ...process.env, UW_CACHE: path.join(tmp, 'cache'), UW_NO_CACHE: '1', UW_TURN_BUDGET: '0' };
  delete env.INSTAFY_TURN_STARTED_AT; delete env.INSTAFY_TURN_DEADLINE;
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => { let json = null; try { json = JSON.parse(out); } catch {} resolve({ code, out, err, json }); });
});

test('a hostel by its name is labelled a hostel even when the register files it as a hotel', () => {
  const hostel = { name: '洄瀾窩青年旅舍', registered: true, cls: 'hotel', group: 'hotel', walk_min: 2, walk_m: 150, walk_basis: 'routed', coord: [121.6, 23.99] };
  assert.equal(stayKind(hostel), 'hostel');
  assert.equal(stayKind({ name: 'Backpackers Lisbon', osm_kind: 'hotel', group: 'hotel' }), 'hostel');
  assert.equal(stayKind({ name: 'Chantai Hotel', registered: true, cls: 'hotel', group: 'hotel' }), 'hotel');
  assert.equal(stayKind({ name: 'Casa', group: 'bnb' }), 'guest_house');
  assert.match(rankStays([hostel])[0].why, /a hostel by its name/);
});

test('the day texts uw plan writes are its own, not unsourced claims', () => {
  for (const t of ['Leave Taipei.', 'Travel day; night 1 of 3 in Hualien.', 'Travel day via Tainan HSR.', 'Travel day; leave from Kaohsiung.', 'Leave St. Gallen.'])
    assert.ok(isPlanSkeletonText(t), t);
  for (const t of ['Taroko Gorge on the Shakadang trail.', 'Leave early for the night market', ''])
    assert.ok(!isPlanSkeletonText(t), t);
});

test('validate leaves plan texts alone and flags an item that copies a day text', async () => {
  assert.equal((await uw(['new', 'fu', '--title', 'Follow-ups', '--center', '10,50', '--zoom', '12'])).code, 0);
  const cfgPath = path.join(tmp, 'fu', 'map.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.plan = { days: [
    { title: 'Day 1 · A', text: 'Easy culture stop at the pine garden and its tea house.', items: [
      { text: 'A flexible coast day: the pebble beach and the cliff path.', url: 'https://example.org/coast' }] },
    { title: 'Day 2 · A', text: 'A flexible coast day: the pebble beach and the cliff path.', items: [
      { text: 'A flexible coast day: the pebble beach and the cliff path.', url: 'https://example.org/coast' }] },
    { title: 'Day 3 · A: depart', text: 'Leave A.', items: [] },
    { title: 'Day 4 · B', text: 'The old town and its covered market.', items: [] },
  ] };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const r = await uw(['validate', 'fu', '--json']);
  const text = JSON.stringify(r.json);
  assert.match(text, /plan\.days\[0\]\.items\[0\]\.text[^}]*item repeats the text of another day/);
  assert.match(text, /plan\.days\[1\]\.items\[0\]\.text[^}]*item repeats its day's text/);
  assert.doesNotMatch(text, /plan\.days\[2\]\.text/, 'the departure day\'s own text is not flagged');
  assert.match(text, /plan\.days\[3\]\.text[^}]*day text with no sourced item that day[^}]*pin the place/, 'the fix pins a place, not a copied item');
});

test('a failed rail track load prints the exact commands that redraw the legs on it', () => {
  const legArgs = ['legs', 'sites/taiwan', '--layer', 'trip', '--stops', 'stations:a,stations:b', '--modes', 'train',
    '--durations', '2h10', '--source', 'research', '--source-url', 'https://example.org/t?x=1&y=2'];
  const [lines, legs] = railRetryCommands('sites/taiwan', legArgs);
  assert.equal(lines, 'uw lines sites/taiwan --layer rail --kinds rail,hsr --simplify 80 --timeout 120');
  assert.match(legs, /^uw legs sites\/taiwan --layer trip --stops stations:a,stations:b .* --follow rail$/);
  assert.match(legs, /--source-url "https:\/\/example\.org\/t\?x=1&y=2"/, 'quoted for the shell');
  assert.equal(railRetryCommands('s', [...legArgs, '--follow', 'rail'])[1].match(/--follow/g).length, 1);
});
