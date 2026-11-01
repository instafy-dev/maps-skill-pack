// Days in one place (the 27 Oct 2026 live test: "Plan 3 days in Lisbon"): `uw plan` takes one stop (a stay with day
// loops, no "Lisbon → Lisbon" travel day), groups a stop's places by area (Jardim da Estrela never lands on the Alfama
// day), gives 3 nights 3 dated days (no fourth, empty departure date), and `uw validate` warns when a hand-edited day
// has a place far from its other places or nearer another day's. Offline: no lookups; the places are the fixtures'.
// Run: node --test tests/one-base-trip.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LISBON } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const lib = (f) => import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', f)).href);
const { buildPlan, dayPlaceWarnings, groupByArea } = await lib('cmd-plan.mjs');
const { haversine } = await lib('util.mjs');
const { dayCaption } = await import(pathToFileURL(path.join(SKILL, 'starter', 'engine', 'ui.js')).href);
const { pageDescription } = await import(pathToFileURL(path.join(SKILL, 'starter', 'engine', 'util.js')).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-onebase-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const run = (args) => new Promise((resolve) => {
  const env = { ...process.env, UW_NO_CACHE: '1' };
  delete env.INSTAFY_CACHE_DIR;
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => { let json = null; try { json = JSON.parse(out); } catch {} resolve({ code, out, err, json }); });
});

const point = (id, coord, props = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: coord }, properties: { id, ...props } });
const src = (p) => ({ source_url: `https://en.wikivoyage.org/wiki/Lisbon#${p.id}`, source: 'Wikivoyage' });
const sightFeats = (list = LISBON.places) => list.map((p) => Object.assign(point(p.id, p.coord, { name: p.name, stop: 'lisbon', ...src(p) }), { _layer: 'sights' }));
const lisbonStop = { id: 'lisbon', layer: 'stops', coord: LISBON.centre, props: { id: 'lisbon', name: 'Lisbon', kind: 'city' } };
const baseStay = Object.assign(point(LISBON.base.id, LISBON.base.coord, { name: LISBON.base.name, stop: 'lisbon', rank: 1, walk_min: 3, walk_to: 'Baixa' }), { _layer: 'stays' });
const area = Object.fromEntries(LISBON.places.map((p) => [p.id, p.area]));
const areasOf = (d) => [...new Set(d.items.filter((it) => it.ref?.layer === 'sights').map((it) => area[it.ref.id]))];

async function makeSite(name) {
  const r = await run(['new', name, '--title', 'Lisbon in 3 days', '--center', LISBON.centre.join(','), '--zoom', '13']);
  assert.equal(r.code, 0, r.err);
  const dir = path.join(tmp, name);
  const write = (layer, feats) => fs.writeFileSync(path.join(dir, 'data', `${layer}.geojson`), JSON.stringify({ type: 'FeatureCollection', features: feats }));
  write('stops', [point('lisbon', LISBON.centre, { name: 'Lisbon', kind: 'city', nights: 3 })]);
  write('stays', [point(LISBON.base.id, LISBON.base.coord, { name: LISBON.base.name, stop: 'lisbon', rank: 1, walk_min: 3, walk_to: 'Baixa' })]);
  write('sights', LISBON.places.map((p) => point(p.id, p.coord, { name: p.name, stop: 'lisbon', ...src(p) })));
  const cfgPath = path.join(dir, 'map.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.layers = [
    { id: 'stops', type: 'points', title: 'Stops', data: 'data/stops.geojson', tier: 'support' },
    { id: 'stays', type: 'points', title: 'Stays', data: 'data/stays.geojson', tier: 'option' },
    { id: 'sights', type: 'points', title: 'Sights', data: 'data/sights.geojson', tier: 'support' },
  ];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return { dir, cfgPath };
}

// "3 days in Lisbon" was 3 nights plus a fourth date with nothing on it (Leave Lisbon.): days in one place have no
// departure date; the stay line still runs to the day the traveller leaves, the date a booking needs.
test('plan (CLI): one stop is a stay of 3 nights: three dated days, no travel day to itself and no departure date', async () => {
  const { cfgPath } = await makeSite('lx');
  const r = await run(['plan', 'lx', '--stops', 'stops', '--ids', 'lisbon', '--nights', '3', '--start', '2026-10-30', '--stays', 'stays', '--sights', 'sights', '--json']);
  assert.equal(r.code, 0, r.err + r.out);
  const plan = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).plan;
  assert.deepEqual(plan.days.map((d) => d.title), ['Fri 30 Oct · Lisbon', 'Sat 31 Oct · Lisbon', 'Sun 1 Nov · Lisbon']);
  assert.ok(plan.days.every((d) => !d.title.includes('→') && !/^Travel day/.test(d.text)), 'never a travel day');
  assert.ok(plan.days.every((d) => !d.depart && !/^Leave /.test(d.text)), 'no departure day');
  assert.match(r.json.route, /^Lisbon 3 \(3 nights, Fri 30 Oct – Mon 2 Nov\)$/);
  // every day is a loop from the same base, with its places
  assert.equal(r.json.not_on_plan, undefined);
  for (const d of plan.days) {
    assert.deepEqual(d.focus, { layer: 'stays', id: LISBON.base.id });
    assert.ok(d.items.some((it) => it.ref?.layer === 'sights'), `${d.title} has places`);
  }
  assert.match(plan.days[0].items[0].text, /^Base: Hotel in Baixa · 3 min walk to Baixa$/, 'a stay near a district walks to it, not to "the station"');
  assert.equal((await run(['fit', 'lx'])).code, 0);
  const v = await run(['validate', 'lx']);
  assert.equal(v.code, 0, v.out + v.err);
  assert.doesNotMatch(v.out + v.err, /day places|still empty/);
});

// The 28 Oct drive ("3 days in Lisbon … what to see each day"): `uw plan … --sights sights,food,daytrips` ran before any
// place was pinned, `uw validate` only warned, and the reply shipped two full days with nothing to see.
test('validate: a plan made with --sights fails while a full day has nothing to see, and passes once each has a place', async () => {
  const { dir, cfgPath } = await makeSite('lx-bare');
  fs.writeFileSync(path.join(dir, 'data', 'sights.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [] }));
  const plan = await run(['plan', 'lx-bare', '--stops', 'stops', '--ids', 'lisbon', '--nights', '3', '--start', '2026-10-29', '--stays', 'stays', '--sights', 'sights,food,daytrips']);
  assert.equal(plan.code, 0, plan.err + plan.out);
  assert.match(plan.out, /--sights sights,food,daytrips: no place in them yet, so every full day is empty and uw validate fails/);
  assert.doesNotMatch(plan.out, /No --sights/, 'the plan was given --sights');
  // the card is out since `uw new`: the next step refreshes it, never posts another
  assert.match(plan.out, /^Next: uw validate, then SKILL\.md step 9 \(refreshes the card\)\./m);
  assert.doesNotMatch(plan.out, /the preview card/);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).plan.sights, ['sights', 'food', 'daytrips']);
  assert.equal((await run(['fit', 'lx-bare'])).code, 0);
  const bare = await run(['validate', 'lx-bare']);
  assert.notEqual(bare.code, 0, 'a day with nothing to see is an error, not a warning');
  // "3 days in Lisbon" is three days to fill: the arrival day is one of them
  assert.match(bare.out + bare.err, /3 of 3 full days have nothing to see \(no sourced place\): Thu 29 Oct · Lisbon, Fri 30 Oct · Lisbon, Sat 31 Oct · Lisbon/);
  // the same days without --sights (an ask about where to stay, not what to see): only the warning, as before
  await run(['plan', 'lx-bare', '--stops', 'stops', '--ids', 'lisbon', '--nights', '3', '--start', '2026-10-29', '--stays', 'stays', '--force']);
  const stayOnly = await run(['validate', 'lx-bare']);
  assert.equal(stayOnly.code, 0, stayOnly.out + stayOnly.err);
  assert.match(stayOnly.out + stayOnly.err, /3 of 3 full days are still empty/);
  // the places pinned, the plan rebuilt with --sights: every full day has something to see
  fs.writeFileSync(path.join(dir, 'data', 'sights.geojson'), JSON.stringify({ type: 'FeatureCollection', features: LISBON.places.map((p) => point(p.id, p.coord, { name: p.name, stop: 'lisbon', ...src(p) })) }));
  await run(['plan', 'lx-bare', '--stops', 'stops', '--ids', 'lisbon', '--nights', '3', '--start', '2026-10-29', '--stays', 'stays', '--sights', 'sights,food,daytrips', '--force']);
  assert.equal((await run(['fit', 'lx-bare'])).code, 0);
  const full = await run(['validate', 'lx-bare']);
  assert.equal(full.code, 0, full.out + full.err);
  assert.doesNotMatch(full.out + full.err, /nothing to see|still empty/);
});

test('plan (CLI): places that fit no day are named, never dropped quietly', async () => {
  await makeSite('lx4');
  const r = await run(['plan', 'lx4', '--stops', 'stops', '--ids', 'lisbon', '--nights', '1', '--start', '2026-10-30', '--stays', 'stays', '--sights', 'sights', '--per-day', '2', '--json']);
  assert.equal(r.code, 0, r.err);
  const placed = r.json.plan.days.flatMap((d) => d.items.filter((it) => it.ref?.layer === 'sights')).length;
  assert.equal(placed, 2);
  assert.equal(r.json.not_on_plan.length, LISBON.places.length - 2);
  const text = await run(['plan', 'lx4', '--stops', 'stops', '--ids', 'lisbon', '--nights', '1', '--start', '2026-10-30', '--stays', 'stays', '--sights', 'sights', '--per-day', '2', '--force']);
  assert.match(text.out, /Not on any day \(each day already has --per-day 2 of their kind\): (?:[^,]+, ){5}[^,]+ and 0 more|Not on any day \(each day already has --per-day 2 of their kind\): (?:[^,]+, ){5}[^,]+\. Add nights/);
});

test('plan (CLI): places with no "stop" that fit no day are named too (they go to the nearest stop)', async () => {
  const { dir } = await makeSite('lx5');
  // the same places without "stop": the plan puts them at the nearest stop, as it always did
  fs.writeFileSync(path.join(dir, 'data', 'sights.geojson'), JSON.stringify({ type: 'FeatureCollection', features: LISBON.places.map((p) => point(p.id, p.coord, { name: p.name, ...src(p) })) }));
  const r = await run(['plan', 'lx5', '--stops', 'stops', '--ids', 'lisbon', '--nights', '1', '--start', '2026-10-30', '--stays', 'stays', '--sights', 'sights', '--per-day', '2', '--json']);
  assert.equal(r.code, 0, r.err);
  const placed = r.json.plan.days.flatMap((d) => d.items.filter((it) => it.ref?.layer === 'sights')).length;
  assert.equal(placed, 2);
  assert.equal(r.json.not_on_plan?.length, LISBON.places.length - 2, JSON.stringify(r.json.not_on_plan));
});

test('buildPlan: a trip that goes the same way twice takes each leg at its place in the order', () => {
  // Lisbon → Porto → Lisbon → Porto: legs 1 and 3 join the same two stops, with different trains
  const porto = { id: 'porto', layer: 'stops', coord: [-8.6110, 41.1456], props: { id: 'porto', name: 'Porto' } };
  const leg = (order, from, to, duration) => Object.assign(point(`leg-${order}`, LISBON.centre, { order, from, to, duration, duration_source: 'CP timetable' }), { _layer: 'trip' });
  const legs = [leg(1, 'lisbon', 'porto', '2h50'), leg(2, 'porto', 'lisbon', '2h55'), leg(3, 'lisbon', 'porto', '3h15')];
  const trip = buildPlan({ stops: [lisbonStop, porto, lisbonStop, porto], nights: [1, 1, 1, 1], start: '2026-10-30', legs });
  const travel = trip.days.filter((d) => d.title.includes('→'));
  assert.deepEqual(travel.map((d) => d.items[0].ref.id), ['leg-1', 'leg-2', 'leg-3']);
  assert.match(travel[2].items[0].text, /3h15/);
  // a stop named twice in a row before the legs (legs made for Lisbon, Lisbon, Porto, Lisbon, Porto): still each its own
  const legs5 = [leg(1, 'lisbon', 'lisbon'), leg(2, 'lisbon', 'porto', '2h50'), leg(3, 'porto', 'lisbon', '2h55'), leg(4, 'lisbon', 'porto', '3h15')];
  const trip5 = buildPlan({ stops: [lisbonStop, lisbonStop, porto, lisbonStop, porto], nights: [1, 0, 1, 1, 1], start: '2026-10-30', legs: legs5 });
  assert.deepEqual(trip5.days.filter((d) => d.title.includes('→')).map((d) => d.items[0].ref.id), ['leg-2', 'leg-3', 'leg-4']);
});

test('plan (CLI): the legs of a list that names a stop twice in a row keep their places in the order', async () => {
  const { dir } = await makeSite('lx6');
  const portoCoord = [-8.6110, 41.1456];
  fs.writeFileSync(path.join(dir, 'data', 'stops.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [
    point('lisbon', LISBON.centre, { name: 'Lisbon', kind: 'city' }), point('porto', portoCoord, { name: 'Porto', kind: 'city' })] }));
  const leg = (order, from, to, duration) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: from === 'lisbon' ? [LISBON.centre, portoCoord] : [portoCoord, LISBON.centre] },
    properties: { id: `leg-${order}`, order, from, to, ...(duration ? { duration, duration_source: 'CP timetable' } : {}) } });
  // made by uw legs for Lisbon, Lisbon, Porto, Lisbon, Porto (leg 1 joins Lisbon to itself)
  fs.writeFileSync(path.join(dir, 'data', 'trip.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [
    leg(1, 'lisbon', 'lisbon'), leg(2, 'lisbon', 'porto', '2h50'), leg(3, 'porto', 'lisbon', '2h55'), leg(4, 'lisbon', 'porto', '3h15')] }));
  const r = await run(['plan', 'lx6', '--stops', 'stops', '--ids', 'lisbon,lisbon,porto,lisbon,porto', '--nights', '1,0,1,1,1', '--start', '2026-10-30', '--legs', 'trip', '--json']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(r.json.plan.days.filter((d) => d.title.includes('→')).map((d) => d.items[0].ref.id), ['leg-2', 'leg-3', 'leg-4']);
});

test('plan: a stop named twice in a row is one stay, never "Lisbon → Lisbon … Travel day"', async () => {
  await makeSite('lx2');
  const r = await run(['plan', 'lx2', '--stops', 'stops', '--ids', 'lisbon,lisbon', '--nights', '2,1', '--start', '2026-10-30', '--stays', 'stays', '--sights', 'sights', '--json']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.json.days, 3);
  assert.ok(r.json.plan.days.every((d) => !d.title.includes('→')), r.json.plan.days.map((d) => d.title).join(' | '));
  assert.match(r.json.route, /^Lisbon 3 \(3 nights/);
  const plan = buildPlan({ stops: [lisbonStop, lisbonStop], nights: [2, 1], start: '2026-10-30', stays: [baseStay] });
  assert.deepEqual(plan.days.map((d) => d.title), ['Fri 30 Oct · Lisbon', 'Sat 31 Oct · Lisbon', 'Sun 1 Nov · Lisbon']);
  // legs made for that list (leg 1 Lisbon → Lisbon, leg 2 Lisbon → Porto): the travel day takes the real leg
  const porto = { id: 'porto', layer: 'stops', coord: [-8.6110, 41.1456], props: { id: 'porto', name: 'Porto' } };
  const leg = (id, order, to, extra = {}) => Object.assign(point(id, LISBON.centre, { order, from: 'lisbon', to, ...extra }), { _layer: 'trip' });
  const legs = [leg('leg-1', 1, 'lisbon'), leg('leg-2', 2, 'porto', { duration: '2h50', duration_source: 'CP timetable' })];
  const trip = buildPlan({ stops: [lisbonStop, lisbonStop, porto], nights: [2, 0, 1], start: '2026-10-30', legs });
  const travel = trip.days.find((d) => d.title.includes('→'));
  assert.equal(travel.title, 'Sun 1 Nov · Lisbon → Porto');
  assert.deepEqual(travel.items[0].ref, { layer: 'trip', id: 'leg-2' });
  assert.match(travel.items[0].text, /2h50 \(CP timetable\)/);
});

test('plan: one stop with 0 nights is a single day there, with its places and no departure day', () => {
  const plan = buildPlan({ stops: [lisbonStop], nights: [0], start: '2026-10-31', stays: [baseStay], sights: sightFeats(LISBON.places.filter((p) => p.area === 'alfama')) });
  assert.equal(plan.days.length, 1);
  assert.equal(plan.days[0].title, 'Sat 31 Oct · Lisbon');
  assert.equal(plan.days[0].items.length, 3);
  assert.match(plan.days[0].text, /Castelo de São Jorge|Sé de Lisboa|Miradouro de Santa Luzia/);
  assert.ok(!plan.days.some((d) => d.depart));
});

test('buildPlan: a stop\'s places are grouped by area, one area a day, each day a walk from the base', () => {
  // Lisbon first (3 nights), then Porto: Lisbon has two full days and its arrival day for three areas
  const porto = { id: 'porto', layer: 'stops', coord: [-8.6110, 41.1456], props: { id: 'porto', name: 'Porto', station_of: 'Porto' } };
  const plan = buildPlan({ stops: [lisbonStop, porto], nights: [3, 1], start: '2026-10-30', stays: [baseStay], sights: sightFeats() });
  const lisbonDays = plan.days.slice(0, 3);
  for (const d of lisbonDays) assert.equal(areasOf(d).length, 1, `${d.title}: ${d.items.map((it) => it.text).join(', ')}`);
  assert.deepEqual(lisbonDays.map((d) => areasOf(d)[0]).sort(), ['alfama', 'belem', 'estrela']);
  const dayOf = (id) => plan.days.findIndex((d) => d.items.some((it) => it.ref?.id === id));
  assert.equal(dayOf('jardim-estrela'), dayOf('basilica-estrela'), 'Jardim da Estrela is with the Basílica da Estrela');
  assert.notEqual(dayOf('jardim-estrela'), dayOf('castelo'), 'never on the Alfama day');
  // the area nearest the base first; a day's places in walking order (always the nearest next one)
  assert.deepEqual(areasOf(plan.days[0]), ['alfama']);
  const coord = Object.fromEntries(LISBON.places.map((p) => [p.id, p.coord]));
  for (const d of lisbonDays) {
    const ids = d.items.filter((it) => it.ref?.layer === 'sights').map((it) => it.ref.id);
    let at = LISBON.base.coord;
    const left = [...ids];
    for (const id of ids) {
      const nearest = left.reduce((a, b) => (haversine(at, coord[a]) <= haversine(at, coord[b]) ? a : b));
      assert.equal(id, nearest, `${d.title}: ${ids.join(' → ')}`);
      left.splice(left.indexOf(id), 1);
      at = coord[id];
    }
  }
});

test('groupByArea: places in one walkable area are shared evenly over the days, not piled on one', () => {
  // four places along one street of Alfama, 0, 100, 200 and 600 m from the first: two days get two each
  const east = (m) => [Math.round((-9.1335 + m / 87000) * 1e6) / 1e6, 38.7139];
  const feats = [0, 100, 200, 600].map((m, i) => Object.assign(point(`p${i}`, east(m), { name: `P${i}` }), { _layer: 'sights' }));
  assert.deepEqual(groupByArea(feats, 2).map((g) => g.map((f) => f.properties.id)), [['p0', 'p1'], ['p2', 'p3']]);
  // two areas a ride apart stay apart, even when one has more places
  const far = [...feats.slice(0, 3), Object.assign(point('belem', LISBON.places[3].coord, { name: 'Belém' }), { _layer: 'sights' })];
  assert.deepEqual(groupByArea(far, 2).map((g) => g.map((f) => f.properties.id)), [['p0', 'p1', 'p2'], ['belem']]);
});

test('validate: a hand-edited day with a place from another area says which day it belongs to', async () => {
  const { cfgPath } = await makeSite('lx3');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const it = (id) => ({ text: LISBON.places.find((p) => p.id === id).name, ref: { layer: 'sights', id }, url: `https://en.wikivoyage.org/wiki/Lisbon#${id}`, source: 'Wikivoyage' });
  // the live test's plan: Jardim da Estrela listed under the Alfama day
  cfg.plan = { title: 'Lisbon in 3 days', days: [
    { title: 'Fri 30 Oct · Baixa and Estrela', focus: { layer: 'stays', id: LISBON.base.id }, text: 'Basílica da Estrela', items: [it('basilica-estrela')] },
    { title: 'Sat 31 Oct · Belém', focus: { layer: 'stays', id: LISBON.base.id }, text: 'Jerónimos and the tower', items: [it('jeronimos'), it('torre'), it('padrao')] },
    { title: 'Sun 1 Nov · Alfama', focus: { layer: 'stays', id: LISBON.base.id }, text: 'Castle, cathedral, a garden', items: [it('castelo'), it('se'), it('jardim-estrela')] },
  ] };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const v = await run(['validate', 'lx3']);
  const text = v.out + v.err;
  assert.match(text, /"Jardim da Estrela" \(Sun 1 Nov · Alfama\) is [\d.]+ km from that day's other places but [\d.]+ km from "Basílica da Estrela" on Fri 30 Oct · Baixa and Estrela: move it to that day/);
  assert.match(text, /plan\.days\[2\]\.items\[2\]/);
  assert.doesNotMatch(text, /"(Castelo de São Jorge|Sé de Lisboa|Torre de Belém)"/, 'the places that belong stay unflagged');
});

test('dayPlaceWarnings: far apart, closer elsewhere, and a day trip is left alone', () => {
  const feats = new Map([...LISBON.places, LISBON.daytrip].map((p) => [`sights:${p.id}`, point(p.id, p.coord, { name: p.name })]));
  feats.set(`stays:${LISBON.base.id}`, point(LISBON.base.id, LISBON.base.coord));
  const resolve = (r) => feats.get(`${r.layer}:${r.id}`) || null;
  const day = (title, ids) => ({ title, focus: { layer: 'stays', id: LISBON.base.id }, items: ids.map((id) => ({ text: id, ref: { layer: 'sights', id } })) });
  // the castle and the tower on one day, the cathedral alone on the next
  const w = dayPlaceWarnings({ days: [day('Day 1', ['castelo', 'torre']), day('Day 2', ['se'])] }, resolve);
  assert.deepEqual(w.map((x) => [x.name, x.kind]).sort(), [['castelo', 'closer'], ['torre', 'far']]);
  // a day trip out of town is its own day's business; neighbours on one day are fine
  assert.deepEqual(dayPlaceWarnings({ days: [day('Day 1', ['sintra', 'castelo']), day('Day 2', ['se', 'santa-luzia'])] }, resolve), []);
  assert.deepEqual(dayPlaceWarnings({ days: [day('Day 1', ['castelo', 'se', 'santa-luzia']), day('Day 2', ['jeronimos', 'torre', 'padrao'])] }, resolve), []);
});

test('the map: the departure day reads "Departure", and a trip\'s days do not count it', () => {
  assert.equal(dayCaption({ title: 'Mon 2 Nov · Lisbon: depart', depart: true, text: 'Leave Lisbon.', items: [] }), 'Departure');
  assert.equal(dayCaption({ title: 'Sun 1 Nov · Lisbon', items: [{ text: 'a' }, { text: 'b' }] }), '2 stops');
  const days = ['a', 'b', 'c'].map((t) => ({ title: t, items: [] }));
  assert.equal(pageDescription({ plan: { days: [...days, { title: 'Mon 2 Nov · Lisbon: depart', depart: true, items: [] }] } }, 8), 'Trip · 3 days · 8 places');
});

// The 1 Nov 2026 Seville map's first day read "3 stops": its base and two sights. The base is where the day starts and
// ends, where the traveller sleeps, not a stop of the day.
test('the map: a day\'s stops leave out its base, the stay the day starts and ends at', () => {
  const plan = buildPlan({ stops: [lisbonStop], nights: [3], start: '2026-10-30', stays: [baseStay], sights: sightFeats() });
  const [arrival] = plan.days;
  assert.match(arrival.items[0].text, /^Base: /);
  const sights = arrival.items.filter((it) => it.ref?.layer === 'sights').length;
  assert.ok(sights >= 1, JSON.stringify(arrival.items));
  assert.equal(dayCaption(arrival), `${sights} ${sights === 1 ? 'stop' : 'stops'}`);
  const base = { text: 'Base: Hotel Palacio Alcázar · 1 min walk to Santa Cruz', ref: { layer: 'stays', id: 'h' }, url: 'https://www.openstreetmap.org/copyright', source: 'OpenStreetMap' };
  const day = { title: 'Mon 2 Nov · Seville', items: [base, { text: 'Cathedral of Seville', ref: { layer: 'sights', id: 'c' } }, { text: 'Alcázar of Seville', ref: { layer: 'sights', id: 'a' } }] };
  assert.equal(dayCaption(day), '2 stops');
  assert.equal(dayCaption({ ...day, items: [base, { text: 'Alcázar of Seville', check: 'timed tickets' }] }), '1 stop · 1 not checked');
  // a day with nothing but its base has no stops to count
  assert.equal(dayCaption({ title: 'Arrive', items: [base] }), '');
});

// "3 days in Lisbon" with three sights (the castle in Alfama, the tower and the monastery in Belém): the arrival day
// had none and the next two had 1 and 2. Every day of the stay gets a place before any gets a second.
test('plan: three places for three days, one each: the arrival day is one of the days to fill', () => {
  const three = sightFeats(LISBON.places.filter((p) => ['castelo', 'torre', 'jeronimos'].includes(p.id)));
  const plan = buildPlan({ stops: [lisbonStop], nights: [3], start: '2026-10-30', stays: [baseStay], sights: three });
  const before = plan.days.filter((d) => !d.depart);
  assert.equal(before.length, 3);
  assert.deepEqual(before.map((d) => d.items.filter((it) => it.ref?.layer === 'sights').length), [1, 1, 1], before.map((d) => `${d.title}: ${d.text}`).join(' | '));
  assert.match(plan.days[0].text, /^Arrive in Lisbon; night 1 of 3\. Then: Castelo de São Jorge/, 'the area nearest the base on the arrival day');
  // two places for three days: the full days first (the arrival day is a half day), and validate asks for one more
  const two = buildPlan({ stops: [lisbonStop], nights: [3], start: '2026-10-30', stays: [baseStay], sights: three.slice(0, 2) });
  assert.deepEqual(two.days.filter((d) => !d.depart).map((d) => d.items.filter((it) => it.ref?.layer === 'sights').length), [0, 1, 1]);
});

test('validate: a plan made with --sights fails while the arrival day has nothing to see', async () => {
  const { dir } = await makeSite('lx-arrive');
  const pick = (ids) => JSON.stringify({ type: 'FeatureCollection', features: LISBON.places.filter((p) => ids.includes(p.id)).map((p) => point(p.id, p.coord, { name: p.name, stop: 'lisbon', ...src(p) })) });
  fs.writeFileSync(path.join(dir, 'data', 'sights.geojson'), pick(['castelo', 'torre']));
  const plan = ['plan', 'lx-arrive', '--stops', 'stops', '--ids', 'lisbon', '--nights', '3', '--start', '2026-10-30', '--stays', 'stays', '--sights', 'sights', '--force'];
  assert.equal((await run(plan)).code, 0);
  assert.equal((await run(['fit', 'lx-arrive'])).code, 0);
  const v = await run(['validate', 'lx-arrive']);
  assert.notEqual(v.code, 0, v.out + v.err);
  assert.match(v.out + v.err, /1 of 3 full days have nothing to see \(no sourced place\): Fri 30 Oct · Lisbon/);
  // a third place: every day has one
  fs.writeFileSync(path.join(dir, 'data', 'sights.geojson'), pick(['castelo', 'torre', 'se']));
  assert.equal((await run(plan)).code, 0);
  const ok = await run(['validate', 'lx-arrive']);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.doesNotMatch(ok.out + ok.err, /nothing to see/);
});

// Three sights all cited one city guide page ("Source: Wikivoyage" on each, the same Lisbon page): each place's
// source is its own page, and validate says when places share one.
test('validate: places that cite one page are named; each with its own page passes', async () => {
  const { dir } = await makeSite('lx-src');
  const three = LISBON.places.filter((p) => ['castelo', 'torre', 'jeronimos'].includes(p.id));
  const write = (srcOf) => fs.writeFileSync(path.join(dir, 'data', 'sights.geojson'), JSON.stringify({ type: 'FeatureCollection',
    features: three.map((p) => point(p.id, p.coord, { name: p.name, stop: 'lisbon', source: 'Wikivoyage', source_url: srcOf(p) })) }));
  const plan = ['plan', 'lx-src', '--stops', 'stops', '--ids', 'lisbon', '--nights', '3', '--start', '2026-10-30', '--stays', 'stays', '--sights', 'sights', '--force'];
  write(() => 'https://en.wikivoyage.org/wiki/Lisbon');
  assert.equal((await run(plan)).code, 0);
  assert.equal((await run(['fit', 'lx-src'])).code, 0);
  const shared = await run(['validate', 'lx-src']);
  assert.equal(shared.code, 0, 'a warning, not an error');
  assert.match(shared.out + shared.err, /3 places cite one page \(https:\/\/en\.wikivoyage\.org\/wiki\/Lisbon\): Castelo de São Jorge, Mosteiro dos Jerónimos, Torre de Belém\. A page about a whole city or a list of places says which are worth it; it is not their source/);
  assert.match(shared.out + shared.err, /uw cite <that page> --grep "<its name>"/);
  // anchors on one page are still one page
  write((p) => `https://en.wikivoyage.org/wiki/Lisbon#${p.id}`);
  assert.match((await run(['validate', 'lx-src'])).out, /3 places cite one page \(https:\/\/en\.wikivoyage\.org\/wiki\/Lisbon\)/);
  write((p) => `https://en.wikipedia.org/wiki/${encodeURIComponent(p.name.replace(/ /g, '_'))}`);
  assert.equal((await run(plan)).code, 0);
  const own = await run(['validate', 'lx-src']);
  assert.equal(own.code, 0, own.out + own.err);
  assert.doesNotMatch(own.out + own.err, /cite one page/);
});

// A trip that starts by passing through a stop with no night there (an airport, a high-speed station: "0 nights =
// pass through") gave that stop a day of its own, "Arrive in …; night 1 of 0.", a night short of the stay, and
// `uw validate` asked for places on that day, which no place can fill: a stop with no night gets no places.
const airport = { id: 'airport', layer: 'stops', coord: [-9.1359, 38.7756], props: { id: 'airport', name: 'Lisbon Airport', kind: 'airport' } };
test('plan: a first stop with no night shares the day it is left, so the stay has every night it was given', () => {
  const plan = buildPlan({ stops: [airport, lisbonStop], nights: [0, 3], start: '2026-10-30', stays: [baseStay], sights: sightFeats() });
  assert.deepEqual(plan.days.map((d) => `${d.title} | ${d.text.replace(/ Then: .*| · .*/, '')}`).slice(0, 2),
    ['Fri 30 Oct · Lisbon Airport → Lisbon | Travel day; night 1 of 3 in Lisbon.', plan.days[1].title + ' | ' + plan.days[1].text.replace(/ · .*/, '')]);
  assert.equal(plan.days[1].title, 'Sat 31 Oct · Lisbon');
  assert.deepEqual(plan.days.map((d) => d.title).slice(-1), ['Mon 2 Nov · Lisbon: depart'], 'three nights from the arrival date');
  assert.ok(!plan.days.some((d) => /night \d+ of 0/.test(d.text)), plan.days.map((d) => d.text).join(' | '));
});

test('validate: a trip that starts at a stop with no night passes once each day with a night has places', async () => {
  const { dir } = await makeSite('lx-air');
  fs.writeFileSync(path.join(dir, 'data', 'stops.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [
    point('airport', airport.coord, { name: 'Lisbon Airport', kind: 'airport' }), point('lisbon', LISBON.centre, { name: 'Lisbon', kind: 'city' })] }));
  const plan = await run(['plan', 'lx-air', '--stops', 'stops', '--ids', 'airport,lisbon', '--nights', '0,3', '--start', '2026-10-30', '--stays', 'stays', '--sights', 'sights']);
  assert.equal(plan.code, 0, plan.out + plan.err);
  assert.equal((await run(['fit', 'lx-air'])).code, 0);
  const v = await run(['validate', 'lx-air']);
  assert.equal(v.code, 0, v.out + v.err);
  assert.doesNotMatch(v.out + v.err, /nothing to see|night 1 of 0/);
});

// A plan written before the arrival day counted (castle, tower and monastery on the two full days, nothing on the
// arrival day) fails validate now: the places already pinned are enough, so re-planning alone fills every day.
test('validate: a day with nothing to see says re-planning spreads the places already pinned, and it does', async () => {
  const { dir, cfgPath } = await makeSite('lx-old');
  fs.writeFileSync(path.join(dir, 'data', 'sights.geojson'), JSON.stringify({ type: 'FeatureCollection',
    features: LISBON.places.filter((p) => ['castelo', 'torre', 'jeronimos'].includes(p.id)).map((p) => point(p.id, p.coord, { name: p.name, stop: 'lisbon', ...src(p) })) }));
  const plan = ['plan', 'lx-old', '--stops', 'stops', '--ids', 'lisbon', '--nights', '3', '--start', '2026-10-30', '--stays', 'stays', '--sights', 'sights', '--force'];
  assert.equal((await run(plan)).code, 0);
  // as the older plan had it: the arrival day bare, its place moved onto a full day
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const [arrive, d2] = cfg.plan.days;
  d2.items.push(...arrive.items.filter((it) => it.ref?.layer === 'sights'));
  arrive.items = arrive.items.filter((it) => it.ref?.layer !== 'sights');
  arrive.text = 'Arrive in Lisbon; night 1 of 3.';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  assert.equal((await run(['fit', 'lx-old'])).code, 0);
  const v = await run(['validate', 'lx-old']);
  assert.notEqual(v.code, 0, v.out + v.err);
  assert.match(v.out + v.err, /1 of 3 full days have nothing to see \(no sourced place\): Fri 30 Oct · Lisbon/);
  assert.match(v.out + v.err, /uw plan lx-old … --sights sights --force spreads the places already pinned over every day, the arrival day too: run it first/);
  assert.equal((await run(plan)).code, 0);
  const again = await run(['validate', 'lx-old']);
  assert.equal(again.code, 0, again.out + again.err);
});

// A map made on the city's centre (`uw new`) kept that frame: nothing framed the trip's places after it, so a phone
// opened on the centre with the base and the day's sight at its edge. `uw plan` frames the trip: its stop, its stays
// (the base) and every day place.
test('plan (CLI): the first view frames the stop, the stays and every place on a day', async () => {
  const { dir, cfgPath } = await makeSite('lxview');
  const cfg0 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  // the frame `uw new` gave a centre west of the places, at street zoom: none of them in it
  const [x, y] = [LISBON.centre[0] - 0.04, LISBON.centre[1]];
  cfg0.view = { center: [x, y], zoom: 15, bounds: [[x - 0.005, y - 0.004], [x + 0.005, y + 0.004]] };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg0, null, 2));
  const r = await run(['plan', 'lxview', '--stops', 'stops', '--ids', 'lisbon', '--nights', '3', '--start', '2026-10-30', '--stays', 'stays', '--sights', 'sights', '--json']);
  assert.equal(r.code, 0, r.err + r.out);
  const { view, plan } = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.ok(plan.days.length, 'the plan is written too');
  assert.deepEqual(r.json.view, view, 'the result says the view it set');
  const [[w, s], [e, n]] = view.bounds;
  const inside = ([lng, lat]) => lng >= w && lng <= e && lat >= s && lat <= n;
  for (const layer of ['stops', 'stays', 'sights']) {
    for (const f of JSON.parse(fs.readFileSync(path.join(dir, 'data', `${layer}.geojson`), 'utf8')).features) {
      assert.ok(inside(f.geometry.coordinates), `${layer}:${f.properties.id} ${f.geometry.coordinates} in the first view ${JSON.stringify(view.bounds)}`);
    }
  }
  const old = ([lng, lat]) => lng >= x - 0.005 && lng <= x + 0.005 && lat >= y - 0.004 && lat <= y + 0.004;
  assert.ok(!old(LISBON.base.coord) && !LISBON.places.some((p) => old(p.coord)), 'the old frame had none of them');
});

test('fit: a trip\'s stations and places to stay are part of what it frames', async () => {
  const { dir, cfgPath } = await makeSite('lxfit');
  // as `uw stay` and `uw station` write them
  const tag = (layer, cmd) => {
    const p = path.join(dir, 'data', `${layer}.geojson`), fc = JSON.parse(fs.readFileSync(p, 'utf8'));
    fs.writeFileSync(p, JSON.stringify({ ...fc, uw: { cmd } }));
  };
  tag('stays', 'stay'); tag('stops', 'station'); tag('sights', 'add-point');
  const r = await run(['fit', 'lxfit', '--json']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual([...r.json.layers].sort(), ['sights', 'stays', 'stops']);
  assert.ok(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).view.bounds, 'framed');
});

// Framing the trip never narrows what `uw fit` framed: a hand-picked place the plan was not given (a day trip, a
// marked airport) stayed in the first view before, and `uw validate` calls a hand-picked place far outside the view
// a wrong match.
test('plan (CLI): the trip\'s frame keeps every hand-picked layer `uw fit` frames, so validate stays clean', async () => {
  const { dir, cfgPath } = await makeSite('lxkeep');
  const tag = (layer, cmd) => {
    const p = path.join(dir, 'data', `${layer}.geojson`), fc = JSON.parse(fs.readFileSync(p, 'utf8'));
    fs.writeFileSync(p, JSON.stringify({ ...fc, uw: { cmd } }));
  };
  tag('stays', 'stay'); tag('stops', 'station'); tag('sights', 'add-point');
  const d = LISBON.daytrip;
  fs.writeFileSync(path.join(dir, 'data', 'daytrips.geojson'), JSON.stringify({ type: 'FeatureCollection', uw: { cmd: 'add-point' },
    features: [point(d.id, d.coord, { name: d.name, stop: 'lisbon', ...src(d) })] }));
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.layers.push({ id: 'daytrips', type: 'points', title: 'Day trips', data: 'data/daytrips.geojson', tier: 'support' });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const fit = await run(['fit', 'lxkeep', '--json']);
  assert.equal(fit.code, 0, fit.err + fit.out);
  assert.ok(fit.json.layers.includes('daytrips'), 'uw fit frames the day trip');
  const r = await run(['plan', 'lxkeep', '--stops', 'stops', '--ids', 'lisbon', '--nights', '3', '--start', '2026-10-30', '--stays', 'stays', '--sights', 'sights', '--json']);
  assert.equal(r.code, 0, r.err + r.out);
  const [[w, s], [e, n]] = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).view.bounds;
  assert.ok(d.coord[0] >= w && d.coord[0] <= e && d.coord[1] >= s && d.coord[1] <= n, `the day trip stays in the first view: ${JSON.stringify([[w, s], [e, n]])}`);
  for (const p of [LISBON.base, ...LISBON.places]) assert.ok(p.coord[0] >= w && p.coord[0] <= e && p.coord[1] >= s && p.coord[1] <= n, `${p.id} in the first view`);
  const v = await run(['validate', 'lxkeep']);
  assert.doesNotMatch(v.out + v.err, /daytrips[^\n]*far outside view\.bounds|far outside view\.bounds[^\n]*sintra/, v.out + v.err);
});
