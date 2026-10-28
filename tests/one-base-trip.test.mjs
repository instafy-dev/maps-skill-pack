// Days in one place (the 27 Oct 2026 live test: "Plan 3 days in Lisbon"): `uw plan` takes one stop (a stay with day
// loops, no "Lisbon → Lisbon" travel day), groups a stop's places by area (Jardim da Estrela never lands on the Alfama
// day), marks the departure day instead of leaving it looking empty, and `uw validate` warns when a hand-edited day
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

test('plan (CLI): one stop is a stay of 3 nights: dated days, no travel day to itself, the departure marked', async () => {
  const { cfgPath } = await makeSite('lx');
  const r = await run(['plan', 'lx', '--stops', 'stops', '--ids', 'lisbon', '--nights', '3', '--start', '2026-10-30', '--stays', 'stays', '--sights', 'sights', '--json']);
  assert.equal(r.code, 0, r.err + r.out);
  const plan = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).plan;
  assert.deepEqual(plan.days.map((d) => d.title), ['Fri 30 Oct · Lisbon', 'Sat 31 Oct · Lisbon', 'Sun 1 Nov · Lisbon', 'Mon 2 Nov · Lisbon: depart']);
  assert.ok(plan.days.every((d) => !d.title.includes('→') && !/^Travel day/.test(d.text)), 'never a travel day');
  assert.match(r.json.route, /^Lisbon 3 \(3 nights, Fri 30 Oct – Mon 2 Nov\)$/);
  // every day before the departure is a loop from the same base, with its places
  for (const d of plan.days.slice(0, 3)) {
    assert.deepEqual(d.focus, { layer: 'stays', id: LISBON.base.id });
    assert.ok(d.items.some((it) => it.ref?.layer === 'sights'), `${d.title} has places`);
  }
  assert.match(plan.days[0].items[0].text, /^Base: Hotel in Baixa · 3 min walk to Baixa$/, 'a stay near a district walks to it, not to "the station"');
  // the departure: marked, nothing invented on it
  const last = plan.days[3];
  assert.equal(last.depart, true);
  assert.deepEqual(last.items, []);
  assert.equal(last.text, 'Leave Lisbon.');
  assert.equal((await run(['fit', 'lx'])).code, 0);
  const v = await run(['validate', 'lx']);
  assert.equal(v.code, 0, v.out + v.err);
  assert.doesNotMatch(v.out + v.err, /day places|still empty/);
});

test('plan: a stop named twice in a row is one stay, never "Lisbon → Lisbon … Travel day"', async () => {
  await makeSite('lx2');
  const r = await run(['plan', 'lx2', '--stops', 'stops', '--ids', 'lisbon,lisbon', '--nights', '2,1', '--start', '2026-10-30', '--stays', 'stays', '--sights', 'sights', '--json']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.json.days, 4);
  assert.ok(r.json.plan.days.every((d) => !d.title.includes('→')), r.json.plan.days.map((d) => d.title).join(' | '));
  assert.match(r.json.route, /^Lisbon 3 \(3 nights/);
  const plan = buildPlan({ stops: [lisbonStop, lisbonStop], nights: [2, 1], start: '2026-10-30', stays: [baseStay] });
  assert.deepEqual(plan.days.map((d) => d.title), ['Fri 30 Oct · Lisbon', 'Sat 31 Oct · Lisbon', 'Sun 1 Nov · Lisbon', 'Mon 2 Nov · Lisbon: depart']);
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
