// A trip's map failed its own check though its reply was true, and a two-city map was wrong in four places. A plan
// refused for one day with one place was run again with --force, as its own words, the check's fix line and the guide
// said, and refused all the same: the turn replied naming the day, and the check still failed. That plan had put three
// places on the arrival afternoon and one on the last day. "4 days in <A> and <B>, two in each" gave the second city
// one day of the four; its stops layer held that city twice (its station and the city itself); a place was listed
// "Not found yet" beside its own pin (a lookup under the pin's id that hung was answered after the place had been
// pinned under that id by another name); and a sight was pinned on the information board that carries its name. Now:
//  - a pin clears the "not found" entry of its own id, whichever of the two came first, and the check passes;
//  - a stops layer holds one stop per city: the city pinned beside its station is refused, naming that stop, and a
//    station found for a city pinned as itself takes that pin's place, under its id;
//  - uw plan replaces the days it wrote by itself, keeping a day's note and own words: no hint, refusal, check or guide
//    names --force (still taken: it replaces those words too);
//  - no day takes a third place while another has one, unless the day-places check would send the place back;
//  - a day with one place is refused once, and again while the turn has not looked for more; run again after it has,
//    the plan keeps the day and names it, and the check warns of it too, naming it; a day with none is never kept;
//  - the plan prints each stop's days to see against the nights the map expects: the day a stop is reached is one of
//    its days after a short ride (it takes places once the stop has two for each of its days), and after a long one
//    the plan says why the stop has fewer, for the reply;
//  - a sight's lookup refuses a board or a sign that only carries its name, saying what it found, also when what
//    else is listed is a stop of that name or has the name only among other words; the place stays listed once as
//    not found;
//  - the trip guides say what a turn decides: "N days, D in each", cite then pin then plan, a place named by its
//    kind, a board is no sight, each short day named in plain words with the assumed dates kept.
// Offline: the place search is a local mock in this file; every cache is off (no page is read).
// Run: node --test tests/plan-and-check-agree.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NO_WIKIPEDIA } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const lib = (name) => import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', name)).href);
const { haversine } = await lib('util.mjs');
const { groupByArea, buildPlan } = await lib('cmd-plan.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-plan-check-'));

// ---------------------------------------------------------------------------
// Three cities and what the place search answers there (OpenStreetMap names, kinds and positions, in its answer shape)
const VERONA = [10.9916, 45.4384], VERONA_STATION = [10.9826, 45.429];
const PADUA = [11.8768, 45.4064], PADUA_STATION = [11.8806, 45.4177];
const NAPLES = [14.2681, 40.8518];
const off = (c, dx, dy) => [Math.round((c[0] + dx / 78000) * 1e6) / 1e6, Math.round((c[1] + dy / 111000) * 1e6) / 1e6];
const hit = (c, osm, name, more = {}) => {
  const [osm_type, osm_id, osm_key, osm_value] = osm;
  return { type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { osm_type, osm_id, osm_key, osm_value, name, city: 'Verona', county: 'Verona', state: 'Veneto', country: 'Italia', countrycode: 'IT', ...more } };
};
const inPadua = { city: 'Padova', county: 'Padova' };
/** What the search answers: `q` the query, `en` an English-names search, `tags` its kind filter. */
function answer(q, en, tags) {
  const places = tags.includes('place:city'), stations = tags.includes('railway:station');
  const country = en ? { country: 'Italy' } : {};
  const verona = hit(VERONA, ['R', 9001, 'place', 'city'], 'Verona', country);
  const padua = hit(PADUA, ['R', 9002, 'place', 'city'], en ? 'Padua' : 'Padova', { ...inPadua, ...country });
  if (places) return q === 'Verona, Italy' ? [verona] : q === 'Padua, Italy' ? [padua] : [];
  // the station of a city known by another name in English is found by its local name only
  if (stations) return q === 'Verona' ? [hit(VERONA_STATION, ['N', 9101, 'railway', 'station'], 'Verona', country)] : q === 'Padova' ? [hit(PADUA_STATION, ['N', 9102, 'railway', 'station'], 'Padova', { ...inPadua, ...country })] : [];
  if (tags.length) return [];
  return {
    Verona: [verona],
    Padua: [padua],
    // a cathedral the search knows by its local name only
    'Duomo di Verona, Verona': [hit(off(VERONA, 250, 300), ['W', 9201, 'amenity', 'place_of_worship'], 'Duomo di Verona')],
    // a sight whose name the search finds on a bus stop, on an information board, and on an office that has it among
    // other words (the shape of a real answer: the board was pinned as the sight)
    'Parliament House, Verona': [
      hit(off(VERONA, -150, 150), ['N', 9300, 'highway', 'bus_stop'], 'Parliament House'),
      hit(off(VERONA, -200, 150), ['N', 9301, 'information', 'board'], 'The Parliament House'),
      hit(off(VERONA, -260, 90), ['N', 9302, 'office', 'yes'], 'Parliament House Youth Forum'),
    ],
    // a gate found on its board only, and a trail found on its guidepost
    'Roman Gate, Verona': [hit(off(VERONA, 400, -100), ['N', 9311, 'information', 'board'], 'Roman Gate')],
    'Roman Gate information board, Verona': [hit(off(VERONA, 400, -100), ['N', 9311, 'information', 'board'], 'Roman Gate')],
    'Hill Trail, Verona': [hit(off(VERONA, 900, 700), ['N', 9312, 'information', 'guidepost'], 'Hill Trail')],
  }[q] || [];
}
// a query the search holds until the test lets it answer (a lookup that hangs): it then finds nothing
const HELD = 'Verona Cathedral, Verona';
let mock, heldSeen, letGo, askedHeld;
before(async () => {
  heldSeen = new Promise((r) => { askedHeld = r; });
  const held = new Promise((r) => { letGo = r; });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/api/' || u.pathname === '/api') {
      const q = u.searchParams.get('q') || '';
      const send = () => res.end(JSON.stringify({ type: 'FeatureCollection', features: answer(q, u.searchParams.get('lang') === 'en', u.searchParams.getAll('osm_tag')) }));
      if (q === HELD) { askedHeld(); held.then(send); } else send();
      return;
    }
    if (u.pathname === '/reverse') { res.end(JSON.stringify({ type: 'FeatureCollection', features: [] })); return; }
    if (u.pathname.includes('interpreter')) { req.on('data', () => {}); req.on('end', () => res.end(JSON.stringify({ elements: [] }))); return; }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  mock = { server, url: `http://127.0.0.1:${server.address().port}` };
});
after(() => {
  letGo?.();
  mock?.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// everything the commands say in these tests, for the last one: none of it names --force
const said = [];
// a turn's clock: by default the pack's own (a fresh turn: eight minutes for tool work); `clock` sets the host's
const uw = (args, { input = null, clock = null, env: more = {} } = {}) => new Promise((resolve) => {
  const env = { ...process.env, ...NO_WIKIPEDIA, UW_CACHE: path.join(tmp, 'cache'), UW_PHOTON: mock.url, UW_OVERPASS: `${mock.url}/api/interpreter`, UW_OSRM: mock.url,
    UW_VALHALLA: mock.url, UW_NO_CACHE: '1', INSTAFY_LOOKUP_STATE: path.join(tmp, 'lookups.json'), UW_RETRY_PAUSE_MS: '0' };
  for (const k of ['UW_TURN_BUDGET', 'UW_TURN_GAP', 'UW_HANDOFF_STEP', 'UW_PLAN_DRAFT', 'INSTAFY_CACHE_DIR', 'INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE', 'INSTAFY_TURN_CONTINUE_FILE', 'INSTAFY_STEP_TIMINGS_FILE', 'INSTAFY_JOB_DEADLINE', 'UW_RUN_ID']) delete env[k];
  if (clock) Object.assign(env, { INSTAFY_TURN_STARTED_AT: clock.started, INSTAFY_TURN_DEADLINE: clock.deadline });
  Object.assign(env, more);
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.stdin.end(input ?? '');
  const t = setTimeout(() => p.kill(), 90000);
  p.on('close', (code) => { clearTimeout(t); said.push(`${args.slice(0, 2).join(' ')}: ${out}\n${err}`); let json = null; if (args.includes('--json')) { try { json = JSON.parse(out); } catch {} } resolve({ code, out, err, json }); });
});
/** A host turn of ten minutes with `usedS` seconds used (the pack keeps two minutes of it for the reply). */
const hostClock = (usedS) => ({ started: new Date(Date.now() - usedS * 1000).toISOString(), deadline: new Date(Date.now() + (600 - usedS) * 1000).toISOString() });
const cfgOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'map.config.json'), 'utf8'));
const layerOf = (site, id) => { try { return JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', `${id}.geojson`), 'utf8')).features; } catch { return []; } };
const flat = (rel) => fs.readFileSync(path.join(SKILL, rel), 'utf8').replace(/\s+/g, ' ');
const sightsOn = (site) => cfgOf(site).plan.days.map((d) => d.items.filter((it) => it.ref?.layer === 'sights').length);
const ok = (r) => { assert.equal(r.code, 0, r.out + r.err); return r; };

const newMap = async (site, more = []) => ok(await uw(['new', site, '--title', 'Verona', '--ask', 'What to see', '--center', VERONA.join(','), '--zoom', '13', ...more]));
/** A place to see with its own page, at a point. */
const pin = (site, { id, name, at, stop }) => uw(['add-point', site, '--layer', 'sights', '--at', at.join(','), '--name', name, '--id', id, '--props-file', '-'],
  { input: JSON.stringify({ stop, source_url: `https://www.${id}.example/visit`, source: `${id}.example`, why: `see ${name}` }) });
const lookUp = (site, layer, query, id, more = []) => uw(['add-point', site, '--layer', layer, '--query', query, '--country', 'IT', '--near', VERONA.join(','), '--id', id, ...more, '--json']);
/** Days in one place: the city as the stop, three nights. */
const newBase = async (site) => {
  await newMap(site, ['--expect', 'Verona:3']);
  ok(await uw(['add-point', site, '--layer', 'stops', '--at', VERONA.join(','), '--name', 'Verona', '--kind', 'city', '--id', 'verona', '--props', '{"nights":3}']));
};
const planBase = (site, more = [], opts = {}) => uw(['plan', site, '--stops', 'stops', '--ids', 'verona', '--nights', '3', '--start', '2026-12-04', '--sights', 'sights', ...more], opts);
// places a short walk apart: two tight groups of three, 800 m from each other, and one place 900 m from both
const WALK = [
  ...[0, 60, 120].map((m, i) => ({ id: `a${i}`, name: `Arena ${i}`, at: off(VERONA, m, 0), stop: 'verona' })),
  ...[0, 60, 120].map((m, i) => ({ id: `b${i}`, name: `Bridge ${i}`, at: off(VERONA, m, 800), stop: 'verona' })),
  { id: 'c0', name: 'Castle', at: off(VERONA, 800, 400), stop: 'verona' },
];

// ---------------------------------------------------------------------------
test('a pin clears the "not found" entry of its own id: a lookup that hung under that id lists nothing once the place is pinned there, and the check passes', async () => {
  const site = 'own-id';
  await newMap(site);
  // the lookup hangs; the same place is pinned meanwhile under its id, by the name the search knows; then the first
  // lookup is answered, with nothing
  const slow = lookUp(site, 'sights', HELD, 'cathedral');
  await heldSeen;
  const pinned = ok(await lookUp(site, 'sights', 'Duomo di Verona, Verona', 'cathedral'));
  assert.equal(pinned.json.chosen.name, 'Duomo di Verona');
  letGo();
  const late = await slow;
  assert.equal(late.code, 2, late.out + late.err);
  assert.equal(late.json.pinned_as, 'sights:cathedral');
  assert.match(late.err, /^Not listed as "not found yet": sights:cathedral \("Duomo di Verona"\) is on the map under this id\. Another place than "Verona Cathedral"\? Look it up under an id of its own\.$/m);
  assert.equal(cfgOf(site).missing, undefined, 'no entry beside its own pin');
  assert.deepEqual(layerOf(site, 'sights').map((f) => [f.properties.id, f.properties.name]), [['cathedral', 'Duomo di Verona']]);
  const v = await uw(['validate', site, '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out, null, 1));
  assert.ok(!v.json.errors.some((e) => e.path === '$.missing'));
  // the other order: not found first (listed), then pinned under that id by another name: the entry goes
  const first = await lookUp(site, 'sights', 'Verona Baptistery, Verona', 'baptistery');
  assert.equal(first.code, 2, first.out + first.err);
  assert.deepEqual(cfgOf(site).missing.map((m) => [m.name, m.id]), [['Verona Baptistery', 'baptistery']]);
  ok(await uw(['add-point', site, '--layer', 'sights', '--at', off(VERONA, 260, 310).join(','), '--name', 'San Giovanni in Fonte', '--id', 'baptistery']));
  assert.equal(cfgOf(site).missing, undefined);
  assert.equal((await uw(['validate', site, '--json'])).code, 0);
});

test('a sight\'s lookup refuses a board or a sign that only carries its name, saying what it found; the place stays listed once as not found', async () => {
  const site = 'boards';
  await newMap(site);
  // the board carries the name, and the office has it only among other words: neither is the place
  const house = await lookUp(site, 'sights', 'Parliament House, Verona', 'parliament', ['--strict-name']);
  assert.equal(house.code, 2, house.out + house.err);
  assert.equal(house.json.refused, 'named_after');
  assert.deepEqual(house.json.found, { name: 'The Parliament House', type: 'information=board', kind: 'sign' });
  assert.match(house.err, /^REFUSED: found an information board named "The Parliament House" \[information=board\], not the sight "Parliament House" \(a board or a sign that carries a place's name is not that place\):$/m);
  assert.match(house.err, /In OpenStreetMap under another name \(one uw geocode finds by that name, never the board or sign above\)\?/);
  assert.deepEqual(layerOf(site, 'sights'), [], 'no board, and no office named after it, pinned as the sight');
  assert.deepEqual(cfgOf(site).missing.map((m) => [m.name, m.id]), [['Parliament House', 'parliament']]);
  // looked up again in other words: still one entry
  assert.equal((await lookUp(site, 'sights', 'Parliament House Verona', 'parliament-house', ['--strict-name'])).code, 2);
  assert.equal(cfgOf(site).missing.length, 1);
  assert.equal((await uw(['validate', site, '--json'])).code, 0, 'nothing wrong was pinned: the map is valid as it is');
  // a board with nothing else listed, and a guidepost, are refused the same way
  const gate = await lookUp(site, 'sights', 'Roman Gate, Verona', 'gate', ['--strict-name']);
  assert.equal(gate.code, 2, gate.out + gate.err);
  assert.match(gate.err, /^REFUSED: found an information board named "Roman Gate" \[information=board\], not the sight "Roman Gate" /m);
  const trail = await lookUp(site, 'daytrips', 'Hill Trail, Verona', 'trail');
  assert.equal(trail.code, 2, trail.out + trail.err);
  assert.match(trail.err, /^REFUSED: found a guidepost named "Hill Trail" \[information=guidepost\], not the sight "Hill Trail" /m);
  assert.deepEqual(layerOf(site, 'sights'), []);
  // the turn's own pick takes it, a lookup that asks for the board takes it, and so does a layer that is not a sight's
  const picked = ok(await lookUp(site, 'daytrips', 'Hill Trail, Verona', 'trail', ['--pick', '1']));
  assert.equal(picked.json.chosen.type, 'information=guidepost');
  assert.ok(!cfgOf(site).missing.some((m) => m.id === 'trail'), 'its entry is gone');
  const asked = ok(await lookUp(site, 'sights', 'Roman Gate information board, Verona', 'gate-board'));
  assert.equal(asked.json.chosen.type, 'information=board');
  const other = ok(await lookUp(site, 'boards', 'Hill Trail, Verona', 'trail-post'));
  assert.equal(other.json.chosen.type, 'information=guidepost');
});

test('one stop per city: the city pinned beside its station is refused, naming that stop; a station found for a city pinned as itself takes that pin\'s place under its id', async () => {
  const site = 'two-cities';
  await newMap(site, ['--expect', 'Verona:2,Padua:2']);
  const station = ok(await uw(['station', site, '--city', 'Verona', '--country', 'Italy', '--nights', '2', '--json']));
  assert.equal(station.json.feature.id, 'verona');
  // the city itself, pinned by hand under another id while its station is there
  const city = await uw(['add-point', site, '--layer', 'stations', '--query', 'Verona', '--country', 'Italy', '--kind', 'city', '--allow-far', '--id', 'verona-city',
    '--props', '{"nights":2,"station_of":"Verona","no_station":true}', '--json']);
  assert.equal(city.code, 2, city.out + city.err);
  assert.equal(city.json.refused, 'already_a_stop');
  assert.deepEqual(city.json.stop, { id: 'verona', name: 'Verona' });
  assert.match(city.err, /^REFUSED: "Verona" is this trip's stop already: stations:verona \("Verona", its station\)\. One stop per city: nothing was added\.$/m);
  assert.match(city.err, /^Use that stop: its id in uw plan --ids and uw stay --near stations:verona /m);
  assert.deepEqual(layerOf(site, 'stations').map((f) => f.properties.id), ['verona']);
  assert.equal(cfgOf(site).missing, undefined, 'a stop that is on the map is not "not found"');
  // the other city: pinned as itself first (its station is found under its local name only), then the station
  ok(await uw(['add-point', site, '--layer', 'stations', '--query', 'Padua', '--country', 'Italy', '--kind', 'city', '--allow-far', '--id', 'padova',
    '--props', '{"nights":2,"station_of":"Padova","no_station":true}']));
  const late = ok(await uw(['station', site, '--city', 'Padua', '--country', 'Italy']));
  assert.match(late.out, /^Added stations:padova — 🚉 Padova /m, 'the stop keeps its id');
  assert.match(late.out + late.err, /stations:padova was Padua pinned as the city itself: its station takes that pin's place, under its id \(one stop per city\)\./);
  const stops = layerOf(site, 'stations');
  assert.deepEqual(stops.map((f) => [f.properties.id, f.properties.kind, f.properties.nights]), [['verona', 'train_station', 2], ['padova', 'train_station', 2]]);
  assert.equal(stops[1].properties.no_station, undefined);
  // it takes that pin's place in the layer too: the stops' order is the trip's
  const order = 'city-first';
  await newMap(order, ['--expect', 'Padua:2,Verona:2']);
  ok(await uw(['add-point', order, '--layer', 'stations', '--query', 'Padua', '--country', 'Italy', '--kind', 'city', '--allow-far', '--id', 'padova',
    '--props', '{"nights":2,"station_of":"Padova","no_station":true}']));
  ok(await uw(['station', order, '--city', 'Verona', '--country', 'Italy', '--nights', '2']));
  ok(await uw(['station', order, '--city', 'Padua', '--country', 'Italy']));
  assert.deepEqual(layerOf(order, 'stations').map((f) => [f.properties.id, f.properties.kind]), [['padova', 'train_station'], ['verona', 'train_station']]);
});

// four places with their own page in each city, a short walk apart
const CITY_SIGHTS = (c, stop, tag) => [[0, 0], [150, 80], [300, -60], [420, 140]].map(([dx, dy], i) => ({ id: `${tag}${i}`, name: `${tag.toUpperCase()} place ${i}`, at: off(c, dx, dy), stop }));
const planTrip = (site, ids, more = []) => uw(['plan', site, '--stops', 'stations', '--ids', ids, '--nights', '2,2', '--start', '2026-12-04', '--sights', 'sights', ...more]);

test('a two-city trip has two days to see in each after a short ride, and the plan says so against the nights the map expects', async () => {
  const site = 'two-cities';
  for (const s of [...CITY_SIGHTS(VERONA, 'verona', 'v'), ...CITY_SIGHTS(PADUA, 'padova', 'p').slice(0, 2)]) ok(await pin(site, s));
  // two places in the second city: its full day has both, and the day it is reached says what it would take
  const two = ok(await planTrip(site, 'verona,padova', ['--json']));
  assert.deepEqual(cfgOf(site).plan.days.map((d) => d.title), ['Fri 4 Dec · Verona', 'Sat 5 Dec · Verona', 'Sun 6 Dec · Verona → Padua', 'Mon 7 Dec · Padua', 'Tue 8 Dec · Padua: depart']);
  assert.deepEqual(sightsOn(site), [2, 2, 0, 2, 0]);
  assert.deepEqual(two.json.stop_days.map((s) => [s.stop, s.days, s.expected]), [['verona', 2, 2], ['padova', 2, 2]]);
  const text = ok(await planTrip(site, 'verona,padova'));
  assert.match(text.out, /^Days to see at each stop, against the nights the map expects: Verona 2 of 2 \(Fri 4 Dec, Sat 5 Dec\) · Padua 2 of 2 \(Sun 6 Dec, Mon 7 Dec\)\.$/m);
  assert.match(text.out, /^Sun 6 Dec, the day Padua is reached \(a ride of about 1 h\), has no place to see yet: it takes places once Padua has 4 with a page of their own, two for each of its 2 days\.$/m);
  // four: two days in each, the day it is reached after the ride too
  for (const s of CITY_SIGHTS(PADUA, 'padova', 'p').slice(2)) ok(await pin(site, s));
  const four = ok(await planTrip(site, 'verona,padova', ['--json']));
  assert.deepEqual(sightsOn(site), [2, 2, 2, 2, 0]);
  assert.deepEqual(four.json.stop_days[1], { stop: 'padova', name: 'Padua', days: 2, expected: 2, on: ['Sun 6 Dec · Verona → Padua', 'Mon 7 Dec · Padua'], after_ride: ['Sun 6 Dec · Verona → Padua'] });
  const ride = cfgOf(site).plan.days[2];
  assert.match(ride.items[0].text, /^🚆 Verona → Padua · about 1 h by train \(estimate from \d+ km; check the timetable\)$/);
  assert.match(ride.text, /^Travel day; night 1 of 2 in Padua\. Then: P place \d/);
  assert.match(four.json.days_for_the_reply, /Sun 6 Dec · Verona → Padua: P place \d, P place \d \| Mon 7 Dec · Padua: P place \d, P place \d$/);
  assert.equal(four.json.plan.stop_days, undefined, 'said by the command, not written to the map');
  assert.equal(cfgOf(site).plan.stop_days, undefined);
});

test('after a long ride the day a stop is reached is the ride\'s: the plan says the stop has fewer days than expected and what the reply says', async () => {
  const site = 'far-city';
  await newMap(site, ['--expect', 'Verona:2,Naples:2']);
  ok(await uw(['station', site, '--city', 'Verona', '--country', 'Italy', '--nights', '2']));
  ok(await uw(['add-point', site, '--layer', 'stations', '--at', NAPLES.join(','), '--name', 'Naples', '--kind', 'city', '--id', 'naples', '--props', '{"nights":2}']));
  for (const s of [...CITY_SIGHTS(VERONA, 'verona', 'v'), ...CITY_SIGHTS(NAPLES, 'naples', 'n').slice(0, 3)]) ok(await pin(site, s));
  const r = ok(await planTrip(site, 'verona,naples', ['--json']));
  // every place is on the stop's one full day: none on the day of the ride
  assert.deepEqual(sightsOn(site), [2, 2, 0, 3, 0]);
  const naples = r.json.stop_days[1];
  assert.deepEqual([naples.stop, naples.days, naples.expected, naples.on], ['naples', 1, 2, ['Mon 7 Dec · Naples']]);
  assert.equal(naples.ride_days[0].title, 'Sun 6 Dec · Verona → Naples');
  assert.ok(naples.ride_days[0].min > 300, JSON.stringify(naples.ride_days));
  const text = ok(await planTrip(site, 'verona,naples'));
  assert.match(text.out, /^Days to see at each stop, against the nights the map expects: Verona 2 of 2 \(Fri 4 Dec, Sat 5 Dec\) · Naples 1 of 2 \(Mon 7 Dec\)\.$/m);
  assert.match(text.out, /^Naples has 1 of 2: Sun 6 Dec goes to a ride of about [\d.]+ h \(the day a stop is reached is one of its days only after a ride of up to 2 h\)\. Say that split in the reply \("Naples: 1 day to see, Sun 6 Dec is the ride there"\), or give it a night more when the trip's length allows\.$/m);
});

test('no day takes a third place while another has one, unless the place belongs with its own day\'s', async () => {
  const feat = (s, sourced = true) => Object.assign({ type: 'Feature', geometry: { type: 'Point', coordinates: s.at }, properties: { id: s.id, name: s.name, ...(sourced ? { source_url: `https://www.${s.id}.example/` } : {}) } }, { _layer: 'sights' });
  const sizes = (groups) => groups.map((g) => g.length).sort();
  const idsOf = (groups) => groups.map((g) => g.map((f) => f.properties.id));
  // three places a few steps apart; 3 km north of them two more and, 2 km east of those, a sixth; a seventh 2.3 km on.
  // By area they are 3 + 3 + 1: the day of the two takes the sixth, a ride from them, and the seventh is alone
  const at = (id, dx, dy) => ({ id, name: id, at: off(VERONA, dx, dy) });
  const X = [at('x1', 0, 0), at('x2', 100, 0), at('x3', 200, 0)], Y = [at('y1', 0, 3000), at('y2', 100, 3000)], L = at('loose', 2000, 3000), S = at('single', 4200, 3600);
  // no day takes a third place while another has one: the day with one takes the nearest place of a day with three
  // that belongs with it as well (the sixth, not one of the three a few steps apart: the check would send it back)
  const seven = groupByArea([...X, ...Y, L, S].map((p) => feat(p)), 3);
  assert.deepEqual(sizes(seven), [2, 2, 3]);
  assert.deepEqual(idsOf(seven).find((g) => g.includes('single')), ['loose', 'single']);
  assert.deepEqual(idsOf(seven).find((g) => g.includes('x1')), ['x1', 'x2', 'x3'], 'three places a few steps apart stay one day');
  // six (2 + 3 + 1): two each; five (1 + 3 + 1): never a third beside a day with one
  assert.deepEqual(sizes(groupByArea([...X.slice(0, 2), ...Y, L, S].map((p) => feat(p)), 3)), [2, 2, 2]);
  assert.deepEqual(sizes(groupByArea([X[0], ...Y, L, S].map((p) => feat(p)), 3)), [1, 2, 2]);
  // the places that count on a day (with their own page) are evened out first, as the check counts them: a day never
  // has three of them beside a day with one, whatever else is pinned there
  const mixed = groupByArea([...Y.map((p) => feat(p)), feat(L), feat(S), feat(at('unsourced', 4250, 3600), false)], 2);
  assert.deepEqual(mixed.map((g) => g.filter((f) => f.properties.source_url).length).sort(), [2, 2]);
  // a place a ride away keeps its day to itself: the day-places check would send a place moved there back
  const far = [...X.map((p) => feat(p)), feat(at('far', 6000, 0))];
  assert.deepEqual(sizes(groupByArea(far, 2)), [1, 3]);
  // the plan: three days in one place, seven places: 3, 2 and 2 in some order, and no day with one
  const stop = { id: 'verona', layer: 'stops', coord: VERONA, props: { id: 'verona', name: 'Verona', kind: 'city' } };
  const plan = buildPlan({ stops: [stop], nights: [3], start: '2026-12-04', sights: [...X, ...Y, L, S].map((p) => feat(p)) });
  assert.deepEqual(plan.days.map((d) => d.items.length).sort(), [2, 2, 3]);
});

test('a day with one place is refused while the turn has not looked for more; run again once it has, the plan keeps the day and names it, and the check warns of it too', async () => {
  const site = 'kept';
  await newBase(site);
  for (const s of WALK.filter((x) => !['b1', 'b2'].includes(x.id))) ok(await pin(site, s));
  // five places for three days: two, two and one
  const first = await planBase(site, ['--json']);
  assert.equal(first.code, 2, first.out + first.err);
  assert.deepEqual(first.json.short_days.map((d) => d.places), [1]);
  const day = first.json.short_days[0].title;
  assert.match(first.json.next, /Then run this command again\.\nLooked for more after this refusal and none could be added \(no other place found there, or none with a page of its own\)\? Run this command again as it is: a day with one place to see is then kept, as a warning the reply names\.$/);
  assert.equal(cfgOf(site).plan.draft.start, '2026-12-04', 'the days are on the map as they are, a draft');
  // the check fails the day, and its fix plans again
  const failing = await uw(['validate', site, '--signal', '--json']);
  assert.equal(failing.code, 1, failing.out);
  const e = failing.json.errors.find((x) => x.path === '$.plan.days');
  assert.equal(e.message, `1 of 3 full days have one place to see (a full day takes 2-3 sourced places): ${day}`);
  assert.match(e.fix, /, then uw plan kept … --sights sights again; a place the lookup cannot pin goes on its day as /);
  // run again with nothing looked for: refused as before (three places for three days never pass by asking twice)
  const again = await planBase(site, ['--json']);
  assert.equal(again.code, 2, again.out + again.err);
  assert.equal(again.json.refused, 'days_short_of_places');
  // the turn looks for another place and finds none; the same command again keeps the day
  const none = await lookUp(site, 'sights', 'Lost Tower, Verona', 'tower', ['--strict-name']);
  assert.equal(none.code, 2, none.out + none.err);
  const kept = ok(await planBase(site, ['--json']));
  assert.deepEqual(kept.json.kept_short, [{ title: day, places: 1 }]);
  const plan = cfgOf(site).plan;
  assert.deepEqual(plan.kept, [day]);
  assert.equal(plan.draft, undefined, 'the days are the plan now');
  assert.deepEqual(sightsOn(site).sort(), [1, 2, 2]);
  const text = ok(await planBase(site));
  assert.ok(text.out.split('\n').includes(`Kept as it is (planned again with none to add): ${day} has one place to see. Name that day in the reply ("<day> has one place to see") and offer to add a place there; uw validate warns of it too.`), text.out);
  assert.match(text.out, /^Stay for the reply, with its dates: Verona 3 \(3 nights, Fri 4 Dec – Mon 7 Dec\)\. The dates and nights are assumptions unless the person gave them: say those in the reply's "Assumed:" line/m);
  // the check says the same: a warning that names the day, and no error for it
  const v = await uw(['validate', site, '--signal', '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out, null, 1));
  const w = v.json.warnings.filter((x) => x.path === '$.plan.days');
  assert.deepEqual(w.map((x) => [x.message, x.fix]), [[`1 of 3 full days has one place to see: ${day}`,
    'uw plan kept these days as they are (planned again with none to add); the reply names each ("<day> has one place to see") and offers to add a place there']]);
  // a place added later fills the day: nothing is kept, and nothing warned of
  ok(await pin(site, WALK.find((x) => x.id === 'b1')));
  ok(await planBase(site));
  assert.equal(cfgOf(site).plan.kept, undefined);
  assert.deepEqual(sightsOn(site), [2, 2, 2]);
  const fine = await uw(['validate', site, '--signal', '--json']);
  assert.equal(fine.code, 0, JSON.stringify(fine.json?.errors ?? fine.out, null, 1));
  assert.deepEqual(fine.json.warnings.filter((x) => x.path === '$.plan.days'), []);
});

test('a full day with nothing to see is never kept while the turn has time, whatever was looked for', async () => {
  const site = 'bare';
  await newBase(site);
  for (const s of WALK.slice(0, 2)) ok(await pin(site, s));
  const first = await planBase(site, ['--json']);
  assert.equal(first.code, 2, first.out + first.err);
  assert.deepEqual(first.json.short_days.map((d) => d.places), [0, 1, 1]);
  assert.match(first.json.next, /\nA full day with nothing to see is refused again while the turn has time: each takes a place first\. With too little time left the days are written as they are, and the reply names each\.$/);
  assert.equal((await lookUp(site, 'sights', 'Lost Tower, Verona', 'tower', ['--strict-name'])).code, 2);
  const again = await planBase(site, ['--json']);
  assert.equal(again.code, 2, again.out + again.err);
  assert.equal(cfgOf(site).plan.kept, undefined);
  // with too little time left the days are written as they are, and the check still fails the day with nothing
  ok(await planBase(site, [], { clock: hostClock(450) }));
  const v = await uw(['validate', site, '--signal', '--json'], { clock: hostClock(450) });
  assert.equal(v.code, 1, v.out);
  assert.match(v.json.errors.find((x) => x.path === '$.plan.days').message, /^1 of 3 full days have nothing to see \(no sourced place\): /);
});

test('uw plan replaces the days it wrote by itself, keeping a day\'s note and its own words; --force, still taken, replaces those words', async () => {
  const site = 'redo';
  await newBase(site);
  for (const s of WALK.filter((x) => x.id !== 'b2')) ok(await pin(site, s));
  ok(await planBase(site));
  const cfg = cfgOf(site);
  assert.equal(cfg.plan.draft, undefined);
  assert.equal(cfg.plan.texts.length, 3, 'what it wrote for each day, to tell a day\'s own words from it');
  // the turn gives day 2 its own words and a note, then pins another place and plans again: no flag, nothing refused
  cfg.plan.days[1].text = 'Around the river: the old bridges.';
  fs.writeFileSync(path.join(tmp, site, 'map.config.json'), JSON.stringify(cfg, null, 2));
  ok(await uw(['set', site, 'plan:day2', '--note', 'book the tickets ahead']));
  ok(await pin(site, WALK.find((x) => x.id === 'b2')));
  const again = ok(await planBase(site, ['--json']));
  assert.deepEqual(again.json.kept_texts, [2]);
  assert.equal(cfgOf(site).plan.days[1].text, 'Around the river: the old bridges.');
  assert.equal(cfgOf(site).plan.days[1].note, 'book the tickets ahead');
  assert.deepEqual(sightsOn(site).sort(), [2, 2, 3]);
  const text = ok(await planBase(site));
  assert.match(text.out, /^Day texts kept on their days \(words written over the plan's\): day 2; check each still fits its places\.$/m);
  assert.match(text.out, /^Day notes kept on their days: day 2 /m);
  // --force is still taken: it replaces a day's own words too, as it always did (its note stays)
  ok(await planBase(site, ['--force']));
  assert.notEqual(cfgOf(site).plan.days[1].text, 'Around the river: the old bridges.');
  assert.equal(cfgOf(site).plan.days[1].note, 'book the tickets ahead');
  // days planned without places to see keep a day's own words the same way
  const route = 'redo-route';
  await newBase(route);
  const planRoute = (more = []) => uw(['plan', route, '--stops', 'stops', '--ids', 'verona', '--nights', '3', '--start', '2026-12-04', ...more]);
  ok(await planRoute());
  const rc = cfgOf(route);
  assert.equal(rc.plan.texts.length, 3);
  rc.plan.days[2].text = 'A slow last morning by the river.';
  fs.writeFileSync(path.join(tmp, route, 'map.config.json'), JSON.stringify(rc, null, 2));
  const replanned = ok(await planRoute(['--json']));
  assert.deepEqual(replanned.json.kept_texts, [3]);
  assert.equal(cfgOf(route).plan.days[2].text, 'A slow last morning by the river.');
  // a trip's route question is replaced by the same command too
  ok(await uw(['question', 'two-cities', '--kind', 'plan-route', '--options', 'stations']));
  ok(await uw(['question', 'two-cities', '--kind', 'plan-route', '--options', 'stations']));
  const other = await uw(['question', 'two-cities', '--kind', 'explore']);
  assert.equal(other.code, 1, 'a question of another kind is not replaced unasked');
});

test('no hint, refusal, check or guide names --force for the plan', async () => {
  // what every command above printed: refusals, plans, kept days, the check's fix lines
  assert.ok(said.length > 40, `${said.length} commands`);
  for (const s of said.filter((x) => !/^question two-cities: \nERROR/.test(x) && !/already has a "question" of another kind/.test(x))) assert.doesNotMatch(s, /--force/, s.slice(0, 300));
  // the plan's own help, the check's and the stay's hints, and the guides a trip's turn reads
  const help = ok(await uw(['plan', '--help']));
  assert.doesNotMatch(help.out, /--force/);
  assert.match(help.out, /Run again, it replaces the days it wrote, by itself:/);
  for (const md of ['SKILL.md', 'reference/itinerary.md', 'reference/several-stops.md', 'reference/config.md']) assert.doesNotMatch(flat(md), /--force(?!-large)/, md);
  const src = (name) => fs.readFileSync(path.join(SKILL, 'scripts', 'lib', name), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const f of ['cmd-plan.mjs', 'cmd-validate.mjs', 'cmd-stay.mjs', 'cmd-set.mjs']) assert.doesNotMatch(src(f), /--force(?!-large)/, f);
  // (uw handoff plans the days itself, with the flag; its report names none)
  assert.doesNotMatch(src('cmd-handoff.mjs'), /uw plan[^'`\n]*--force/);
  // the check's fix lines on a map whose days need planning again: a place pinned after the days were planned
  ok(await pin('redo', { id: 'late', name: 'Late Garden', at: off(VERONA, 200, 500), stop: 'verona' }));
  const v = await uw(['validate', 'redo', '--signal', '--json']);
  assert.equal(v.code, 1, v.out);
  const late = v.json.errors.find((e) => /on the map but in no day of the plan: Late Garden/.test(e.message));
  assert.match(late.fix, /^uw plan redo … --sights sights again: the days take every place pinned/);
  for (const e of [...v.json.errors, ...v.json.warnings]) assert.doesNotMatch(String(e.fix), /--force/, e.fix);
});

test('the trip guides say what a turn decides: the split of days, cite then pin then plan, a place named by its kind, a board is no sight, each short day named with the dates kept', () => {
  const itinerary = flat('reference/itinerary.md'), stops = flat('reference/several-stops.md');
  assert.match(stops, /"N days, D in each" are D days with things to see in each city: D nights a stop \(`--expect "A:D,B:D"`\), and `uw plan` prints "Days to see at each stop"\. The day a stop is reached is one of its days after a ride of up to about 2 h \(it takes places once the stop has two with their own page for each of its days\); after a longer ride that day is the ride's, and the reply says the split as printed, never "D days in each"\./);
  assert.match(stops, /No `--sights` yet: the places to see come in Phase B, each cited \(`uw cite`\) before it is pinned, then `uw plan … --sights`; planned with `--sights` before any is pinned, every day is short and the plan is refused\./);
  assert.match(stops, /One stop per city: its station, or \(none found, step 6\) the city itself, never both\. Read each command's answer before pinning a city by hand: `uw add-point` refuses a city whose station is there, naming that stop's id\./);
  assert.match(stops, /then `uw plan … --ids <every stop> --nights …` again \(it replaces the days it wrote\)\./);
  const step1 = itinerary.slice(itinerary.indexOf('1. **Sights with sources'), itinerary.indexOf('2. **Train times**'));
  assert.match(step1, /Refused for a day with one place: run the same command again once you looked for more and none could be added; it keeps that day, a warning there and in `uw validate`, which the reply names\./);
  assert.match(step1, /Cite, then pin, then plan: a place pinned with no page counts on no day, and `uw plan --sights` before the places are pinned is refused\./);
  assert.match(step1, /A place named by its kind \("the cathedral", "the central market"\) is the city's place of that kind: look it up as that \("<City> Cathedral", the name its page gives it; never another church or hall you know better\), unmarked, and the reply says which place was taken\./);
  assert.match(step1, /A sight is never a board or a sign that only carries its name: `uw add-point` refuses one \(look the place up by its official name\)\./);
  const reply = itinerary.slice(itinerary.indexOf('## Reply'));
  assert.match(reply, /Several stops: each stop's days to see, as `uw plan` prints them \("Days to see at each stop"\): "N days, D in each" are D days with things to see in each city, so say the split, and why a stop has fewer \("<Stop>: one day to see, <day> is the ride there"\)\./);
  assert.match(reply, /the dates too when the person gave none\. A reply that names a short day keeps it\./);
  assert.match(reply, /Each short day is named in plain words, by its date and what it has \("Sun 22 Nov has one place to see: <place>"\), one `uw plan` kept too; never "the sights need pages of their own"\. A place the message named by its kind: say which place was taken \("the cathedral: <its name>"\)\./);
});
