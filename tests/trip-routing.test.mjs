// "3 days in <city>, what to see each day" is a trip with a plan, not pins with "Day 1: …" in their notes (28 Oct 2026
// drive: the agent took SKILL.md's steps 4-8, put one neighbourhood in a "Hotels" layer and wrote the days into the
// place notes; the map had no Plan tab and validate passed). The skill sends a trip to reference/itinerary.md before
// anything else, `uw new` with nights points there, and `uw validate` fails while a trip with nights has no plan.
// Run: node --test tests/trip-routing.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LISBON } from './fixtures.mjs';

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-trip-route-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const env = { ...process.env, UW_NO_CACHE: '1' };
delete env.INSTAFY_CACHE_DIR;
const uw = (args) => {
  const r = spawnSync(process.execPath, [UW, ...args], { cwd: tmp, env, encoding: 'utf8' });
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, out: r.stdout, err: r.stderr, json };
};
const point = (id, coord, props = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: coord }, properties: { id, ...props } });

test('uw new: nights in --expect point to the itinerary; without them the next step says where a trip goes', () => {
  const trip = uw(['new', 'lx', '--title', 'Lisbon in 3 days', '--center', LISBON.centre.join(','), '--zoom', '13', '--expect', 'Lisbon:3']);
  assert.equal(trip.code, 0, trip.err);
  assert.match(trip.out, /Then: a trip \(Lisbon \(3 nights\)\): follow reference\/itinerary\.md \("One base" for days in one place\), not SKILL\.md steps 4-8/);
  assert.doesNotMatch(trip.out, /uw add-point .* once per option/);
  const map = uw(['new', 'cafes', '--title', 'Cafés', '--center', LISBON.centre.join(','), '--zoom', '13']);
  assert.match(map.out, /once per option\. A trip \(days or nights somewhere\): reference\/itinerary\.md instead\./);
});

test('uw validate: a trip with nights and no plan fails, days in place notes do not count, and a plan passes', () => {
  const dir = path.join(tmp, 'lx');
  const write = (layer, feats) => fs.writeFileSync(path.join(dir, 'data', `${layer}.geojson`), JSON.stringify({ type: 'FeatureCollection', features: feats }));
  const cfgPath = path.join(dir, 'map.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  // the drive's map: the city on the map, the days only inside the pins' notes
  write('stops', [point('lisbon', LISBON.centre, { name: 'Lisbon', kind: 'city', nights: 3 })]);
  write('sights', LISBON.places.slice(0, 3).map((p, i) => point(p.id, p.coord, { name: p.name, note: `Day ${i + 1}: ${p.name}.` })));
  cfg.layers = [
    { id: 'stops', type: 'points', title: 'Stops', data: 'data/stops.geojson' },
    { id: 'sights', type: 'points', title: 'Sights', data: 'data/sights.geojson' },
  ];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const v = uw(['validate', 'lx', '--json']);
  assert.equal(v.code, 1, v.out);
  const err = v.json.errors.find((e) => e.path === '$.plan');
  assert.ok(err, JSON.stringify(v.json.errors));
  assert.match(err.message, /a trip \(Lisbon \(3 nights\)\) with no plan: its days go in the plan, which the map shows as its own tab, not in place notes/);
  assert.match(err.fix, /reference\/itinerary\.md \("One base" for days in one place\)/);
  assert.match(err.fix, /uw plan lx --stops/);

  // no stay found: the area to stay in is pinned as one (itinerary "One base" step 2), and the days start there
  write('stays', [point('baixa', LISBON.base.coord, { name: 'Baixa', kind: 'area', stop: 'lisbon', note: 'Area to stay in: central and flat.' })]);
  cfg.layers.push({ id: 'stays', type: 'points', title: 'Stays', data: 'data/stays.geojson' });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  // the plan made: the error goes
  const plan = uw(['plan', 'lx', '--stops', 'stops', '--ids', 'lisbon', '--nights', '3', '--start', '2026-10-30', '--stays', 'stays', '--sights', 'sights', '--json']);
  assert.equal(plan.code, 0, plan.out + plan.err);
  const days = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).plan.days;
  assert.ok(days.filter((d) => !d.depart).every((d) => d.focus?.layer === 'stays' && d.focus?.id === 'baixa'), JSON.stringify(days.map((d) => d.focus)));
  const after = uw(['validate', 'lx', '--json']);
  assert.equal(after.json.errors.filter((e) => e.path === '$.plan').length, 0, JSON.stringify(after.json.errors));
  // a map with places and no nights asked for needs no plan
  const cafes = uw(['validate', 'cafes', '--json']);
  assert.equal(cafes.json.errors.filter((e) => e.path === '$.plan').length, 0);
});

test('SKILL.md sends a trip, days or nights, to the itinerary before Phase A; the itinerary labels an area to stay as one', () => {
  const md = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  const flat = md.replace(/\s+/g, ' ');
  const route = flat.indexOf('**Trip** (days or nights somewhere: "3 days in Lisbon", "what to see each day"): `reference/itinerary.md`, not steps 4-8 ("One base" for one place)');
  assert.ok(route > 0, 'a trip is days, not only nights');
  assert.ok(route < flat.indexOf('**Phase A: a useful map'), 'before Phase A');
  assert.match(flat, /a Plan tab, days by area, real stays; never days in place notes\./);
  assert.equal((md.match(/itinerary\.md/g) || []).length, 2, 'one route to the itinerary in the procedure, not a second one buried in step 1');
  const trip = fs.readFileSync(path.join(SKILL, 'reference', 'itinerary.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(trip, /Never the area itself as a hotel\. No stay found \(exit 2 after widening, or exit 4\): pin the area as the recommendation, labelled as one/);
  assert.match(trip, /--kind area --id <area slug> --props-file - <<'JSON'`, then `\{"stop":"<slug>","note":"Area to stay in: <why, from the page>"\}` and `JSON` on their own lines/);
});

test('replies name no lookup service, command or exit code, and sources by who publishes the data', () => {
  const md = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(md, /No paths, "validates", commands, services or exit codes \(Overpass, Photon, OSRM, "exit 4"\): say it plainly \("the place search was busy"\); sources by publisher \(OpenStreetMap, Wikipedia\) in one line/);
  assert.doesNotMatch(md, /Overpass busy/, 'no service name for Octo to repeat');
  const trip = fs.readFileSync(path.join(SKILL, 'reference', 'itinerary.md'), 'utf8').replace(/\s+/g, ' ');
  assert.doesNotMatch(trip, /OSRM walking routes/);
  assert.match(trip, /lookup services \(Overpass, Photon, OSRM\) or exit codes/);
});
